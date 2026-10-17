import {createHash} from 'node:crypto';
import {DispatchError,GENERATION_CONTRACT} from '../generation/dispatch.mjs';
import {operationBinding} from '../generation/cue-contract.mjs';
import {cueDigest,cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {deriveVerifiedWave} from '../../integration/runtime/verified-wave-derivation.mjs';
import {validBinding} from '../../integration/qc/portable-qc.mjs';

export const INGESTION_RECEIPT_VERSION='private-provider-ingestion-v1';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const contentType=channel=>channel==='music'?'audio/wav':'video/mp4';
const sourceHash=(op,channel)=>channel==='music'?op.permit.source.music.contextSha256:op.permit.source.video.referenceSha256;
class PrivateIngestionReason extends Error {}
const safeReason=error=>error instanceof PrivateIngestionReason?error.message:'PRIVATE_INGESTION_FAILED';
const fail=reason=>{throw new PrivateIngestionReason(reason);};
export class IngestionHold extends DispatchError {
  constructor(reason){super('PRIVATE_INGESTION_HOLD');this.message=reason;this.holdReason=reason;}
}
// Descriptors remain private. Persist their digest, never a download URL.
const descriptorHash=(roomId,op,channel)=>cueDigest({binding:operationBinding(roomId,op,channel),
  requestId:op.stages[channel].requestId,result:op.stages[channel].result,sourceSha256:sourceHash(op,channel)});
const operationHash=(roomId,op)=>cueDigest({roomId,operationId:op.operationId,submissionId:op.submissionId,
  plan:op.plan,permit:op.permit,stages:Object.fromEntries(['music','video'].map(c=>[c,{state:op.stages[c].state,
    requestId:op.stages[c].requestId,result:op.stages[c].result}]))});
const seal=record=>({...record,receiptSha256:cueDigest(record)});
function verifiedReceipt(record,key) {
  const fields=['version','roomId','operationId','channel','assetId','sha256','byteLength','contentType','binding',
    'kind','requestId','resultSha256','sourceSha256','modelId','descriptorSha256','sourceEvidenceSha256','receiptSha256'];
  if(!record||Object.keys(record).some(k=>!fields.includes(k))||record.kind!=='provider'||
    !validBinding(record.binding,key.channel)||record.version!==INGESTION_RECEIPT_VERSION||record.roomId!==key.roomId||
    record.operationId!==key.operationId||record.channel!==key.channel||!id(record.assetId)||
    !id(record.requestId)||!sha(record.sha256)||!sha(record.resultSha256)||!sha(record.sourceSha256)||
    !sha(record.sourceEvidenceSha256)||!sha(record.descriptorSha256)||record.modelId!==GENERATION_CONTRACT[key.channel]||
    record.contentType!==contentType(key.channel)||!Number.isSafeInteger(record.byteLength)||record.byteLength<1||
    record.byteLength>32*1024*1024||!sha(record.receiptSha256))fail('IMMUTABLE_INGESTION_RECEIPT_REQUIRED');
  const {receiptSha256,...body}=record;
  if(receiptSha256!==cueDigest(body)||cueDigest(record.binding)!==cueDigest({...record.binding,roomId:key.roomId,channel:key.channel}))
    fail('IMMUTABLE_INGESTION_RECEIPT_REQUIRED');
  return structuredClone(record);
}

// Host primitives can be backed by an authenticated object store or database.
// putIfAbsent must be atomic and immutable; subsequent physical reads remain
// mandatory even when it reports an existing record. No credentials are stored.
export function createImmutableIngestionReceiptStore({readRecord,putIfAbsent}={}) {
  if(typeof readRecord!=='function'||typeof putIfAbsent!=='function')fail('PRIVATE_RECEIPT_STORAGE_REQUIRED');
  const reference=key=>{
    if(!id(key?.roomId)||!id(key?.operationId)||!['music','video'].includes(key.channel))fail('INGESTION_RECEIPT_REFERENCE_REQUIRED');
    return {roomId:key.roomId,operationId:key.operationId,channel:key.channel};
  };
  const location=key=>({id:'receipt-'+cueDigest(key),reference:key});
  async function read(key) {
    key=reference(key);const record=await readRecord(location(key));
    return record===null||record===undefined?null:verifiedReceipt(record,key);
  }
  return {read,async saveImmutable(input){
    const key=reference(input),receipt=verifiedReceipt(input,key),previous=await read(key);
    if(previous&&previous.receiptSha256!==receipt.receiptSha256)fail('IMMUTABLE_INGESTION_REFERENCE_CHANGED');
    if(!previous)await putIfAbsent({...location(key),record:structuredClone(receipt)});
    const saved=await read(key);
    if(!saved||saved.receiptSha256!==receipt.receiptSha256)fail('IMMUTABLE_INGESTION_SAVE_REQUIRED');
    return saved;
  }};
}

/** Private server adapter. Only the authoritative ledger chooses remote media. */
export function createPrivateMediaIngestion({enabled=false,readOperation:authority,assetStore,receiptStore,
  readSourceEvidence,fetchImpl,maximumBytes=32*1024*1024,timeoutMs=30000}={}) {
  if(typeof authority!=='function'||typeof readSourceEvidence!=='function'||
    !['read','save','verifySaved'].every(k=>typeof assetStore?.[k]==='function')||
    !['read','saveImmutable'].every(k=>typeof receiptStore?.[k]==='function'))fail('PRIVATE_INGESTION_DEPENDENCIES_REQUIRED');
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>32*1024*1024||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>120000)fail('BOUNDED_INGESTION_LIMITS_REQUIRED');
  let closed=false;const pending=new Map(),controllers=new Set();
  const active=()=>{if(enabled!==true)fail('PRIVATE_INGESTION_NOT_ACTIVATED');if(closed)fail('PRIVATE_INGESTION_CLOSED');};
  const job=input=>{
    if(!input||Object.keys(input).some(k=>!['roomId','operationId'].includes(k))||!id(input.roomId)||!id(input.operationId))
      fail('PRIVATE_INGESTION_IDS_ONLY');
    return {roomId:input.roomId,operationId:input.operationId};
  };
  async function authoritative(key) {
    const op=structuredClone(await authority(key));
    if(op?.operationId!==key.operationId||op.roomId!==undefined&&op.roomId!==key.roomId||op.stopped||
      op.dispatchAllowed!==true||op.plan?.status!=='COMPILED'||!id(op.submissionId))fail('AUTHORITATIVE_INGESTION_OPERATION_REQUIRED');
    if(!['music','video'].every(c=>op.stages?.[c]?.state==='COMPLETE'))fail('COMPLETE_AV_REQUIRED');
    if(!sha(op.permit?.sourceSha256)||cueDigest(cueSourceIdentity(op.permit.source))!==op.permit.sourceSha256)
      fail('INGESTION_SOURCE_BINDING_REQUIRED');
    for(const c of ['music','video']) {
      const stage=op.stages[c];
      if(!id(stage.requestId)||!sha(stage.result?.resultSha256)||stage.result.providerObserved!==true||
        stage.result.contentType!==contentType(c))fail('AUTHORITATIVE_PROVIDER_RECEIPT_REQUIRED');
    }
    return op;
  }
  async function asset(assetId,expectedSha256) {
    if(!id(assetId)||!sha(expectedSha256))fail('PRIVATE_ASSET_ID_AND_SHA_REQUIRED');
    const record=structuredClone(await assetStore.read(assetId)),bytes=record?.bytes;
    if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>32*1024*1024||record.assetId!==assetId||
      record.sha256!==expectedSha256||record.byteLength!==bytes.length||hash(bytes)!==expectedSha256)
      fail('PRIVATE_INGESTION_ASSET_CHANGED');
    const proof=await assetStore.verifySaved({binding:structuredClone(record.binding),asset:{assetId,sha256:expectedSha256}});
    if(proof?.privateSaved!==true||proof.checksumVerified!==true||proof.assetId!==assetId||proof.sha256!==expectedSha256||
      cueDigest(proof.binding??null)!==cueDigest(record.binding??null))fail('PRIVATE_INGESTION_SAVE_PROOF_REQUIRED');
    return {...structuredClone(record),bytes:Buffer.from(bytes)};
  }
  async function sourceEvidence(key,op) {
    const source=op.permit.source,e=structuredClone(await readSourceEvidence({...key,source:structuredClone(source)}));
    if(e?.kind!=='verified-source-context-v1'||e.roomId!==key.roomId||e.parentAssetId!==source.audioAssetId||
      e.parentSha256!==source.music.sha256||e.contextAssetId!==source.contextAssetId||e.contextSha256!==source.music.contextSha256||
      e.referenceAssetId!==source.referenceAssetId||e.referenceSha256!==source.video.referenceSha256||
      e.contextSeconds!==16||e.serverAudioQC!==true||!['owner-supplied-bootstrap','provider'].includes(e.originKind))
      fail('TRUSTED_SOURCE_CONTEXT_EVIDENCE_REQUIRED');
    const [parent,context,reference]=await Promise.all([asset(e.parentAssetId,e.parentSha256),
      asset(e.contextAssetId,e.contextSha256),asset(e.referenceAssetId,e.referenceSha256)]);
    if(deriveVerifiedWave(parent).contextSha256!==e.contextSha256||
      source.music.profile?.method!=='pcm-endpoint-profile-v1'||source.music.profile.assetSha256!==e.parentSha256||
      source.music.profile.sampleRate!==44100||source.music.profile.channels!==2)
      fail('EXACT_SOURCE_CONTEXT_REQUIRED');
    const evidence={kind:e.kind,roomId:e.roomId,originKind:e.originKind,parentAssetId:e.parentAssetId,parentSha256:e.parentSha256,
      contextAssetId:e.contextAssetId,contextSha256:e.contextSha256,referenceAssetId:e.referenceAssetId,
      referenceSha256:e.referenceSha256,contextSeconds:16,serverAudioQC:true,providerOriginVerified:e.originKind==='provider'};
    if(e.originKind==='owner-supplied-bootstrap') {
      if(parent.provenance?.kind!=='owner-supplied-bootstrap'||e.providerReceipt!==undefined)
        fail('HONEST_BOOTSTRAP_SOURCE_ORIGIN_REQUIRED');
    } else {
      const prior=e.providerReceipt;
      if(!id(prior?.operationId)||prior.operationId===key.operationId||!id(prior.requestId)||!sha(prior.resultSha256))
        fail('SOURCE_PROVIDER_LINEAGE_REQUIRED');
      const priorKey={roomId:key.roomId,operationId:prior.operationId,channel:'music'};
      const receipt=verifiedReceipt(await receiptStore.read(priorKey),priorKey),priorOp=await authority({roomId:key.roomId,operationId:prior.operationId});
      if(priorOp?.operationId!==prior.operationId||priorOp.roomId!==undefined&&priorOp.roomId!==key.roomId||
        priorOp.stages?.music?.state!=='COMPLETE'||priorOp.stages.music.requestId!==prior.requestId||
        priorOp.stages.music.result?.resultSha256!==prior.resultSha256||receipt.requestId!==prior.requestId||
        receipt.resultSha256!==prior.resultSha256||receipt.descriptorSha256!==descriptorHash(key.roomId,priorOp,'music')||
        parent.provenance?.kind!=='provider'||parent.provenance.requestId!==prior.requestId||
        parent.provenance.resultSha256!==prior.resultSha256||cueDigest(parent.binding)!==cueDigest(receipt.binding))
        fail('SOURCE_PROVIDER_LINEAGE_REQUIRED');
      await verifyReceiptAsset(receipt);
      evidence.providerReceipt={operationId:prior.operationId,requestId:prior.requestId,resultSha256:prior.resultSha256,
        receiptSha256:receipt.receiptSha256,rawAssetId:receipt.assetId,rawSha256:receipt.sha256};
    }
    // Reference ownership is bound independently; a provider continuation can
    // retain an owner-supplied visual reference without changing its origin.
    void context;void reference;
    return {...evidence,evidenceSha256:cueDigest(evidence)};
  }
  async function verifyReceiptAsset(receipt) {
    const record=await asset(receipt.assetId,receipt.sha256);
    if(record.byteLength!==receipt.byteLength||record.contentType!==receipt.contentType||
      cueDigest(record.binding)!==cueDigest(receipt.binding)||record.provenance?.kind!=='provider'||
      record.provenance.operationId!==receipt.operationId||record.provenance.requestId!==receipt.requestId||
      record.provenance.resultSha256!==receipt.resultSha256||record.provenance.sourceSha256!==receipt.sourceSha256||
      record.provenance.modelId!==receipt.modelId)fail('PRIVATE_INGESTION_PROVIDER_BINDING_MISMATCH');
    return record;
  }
  function target(stage) {
    let url;try{if(typeof stage.result.url!=='string'||stage.result.url.length>8192)fail('PROVIDER_MEDIA_TARGET_REQUIRED');url=new URL(stage.result.url);}
    catch{fail('PROVIDER_MEDIA_TARGET_REQUIRED');}
    if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash||
      !/(^|\.)fal\.media$/.test(url.hostname))fail('PROVIDER_MEDIA_TARGET_REQUIRED');
    return url;
  }
  async function retrieve(stage,channel) {
    if(typeof fetchImpl!=='function')fail('HOST_MEDIA_TRANSPORT_REQUIRED');
    const url=target(stage),controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);let reader;
    let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(new PrivateIngestionReason('INGESTION_DOWNLOAD_TIMEOUT'));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
    try {
      const response=await Promise.race([fetchImpl(url.href,{method:'GET',credentials:'omit',redirect:'error',signal:controller.signal}),aborted]);
      if(!response?.ok||response.redirected||response.url&&response.url!==url.href)fail('PROVIDER_MEDIA_DOWNLOAD_REFUSED');
      const declared=response.headers.get('content-length'),size=declared===null?null:Number(declared);
      if(size!==null&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(size)||size<1||size>maximumBytes))fail('PROVIDER_MEDIA_SIZE_REQUIRED');
      const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if(![contentType(channel),'application/octet-stream',...(channel==='music'?['audio/x-wav']:[])].includes(type))
        fail('PROVIDER_MEDIA_TYPE_REQUIRED');
      if(!response.body||typeof response.body.getReader!=='function')fail('PROVIDER_MEDIA_STREAM_REQUIRED');
      reader=response.body.getReader();const parts=[],streamHash=createHash('sha256');let length=0;
      while(true) {
        const part=await Promise.race([reader.read(),aborted]);if(part.done)break;
        if(!(part.value instanceof Uint8Array)||!part.value.length)fail('PROVIDER_MEDIA_STREAM_REQUIRED');
        length+=part.value.length;if(length>maximumBytes)fail('PROVIDER_MEDIA_STREAM_TOO_LARGE');
        const bytes=Buffer.from(part.value);parts.push(bytes);streamHash.update(bytes);
      }
      if(!length||size!==null&&length!==size)fail('PROVIDER_MEDIA_LENGTH_MISMATCH');
      return {bytes:Buffer.concat(parts,length),sha256:streamHash.digest('hex'),byteLength:length};
    } finally {
      clearTimeout(timer);controller.signal.removeEventListener('abort',rejectAbort);controller.abort();controllers.delete(controller);
      if(reader)reader.cancel().catch(()=>{});
    }
  }
  async function existing(key,op,channel,evidence) {
    const lookup={...key,channel},stored=await receiptStore.read(lookup);
    if(stored===null||stored===undefined)return null;
    const receipt=verifiedReceipt(stored,lookup);
    if(receipt.descriptorSha256!==descriptorHash(key.roomId,op,channel)||
      cueDigest(receipt.binding)!==cueDigest(operationBinding(key.roomId,op,channel))||
      receipt.sourceSha256!==sourceHash(op,channel)||receipt.sourceEvidenceSha256!==evidence.evidenceSha256)
      fail('IMMUTABLE_INGESTION_REFERENCE_CHANGED');
    await verifyReceiptAsset(receipt);return receipt;
  }
  async function fresh(key,fingerprint,evidenceDigest) {
    active();const op=await authoritative(key);
    if(operationHash(key.roomId,op)!==fingerprint||(await sourceEvidence(key,op)).evidenceSha256!==evidenceDigest)
      fail('INGESTION_AUTHORITY_CHANGED');
    return op;
  }
  async function prepare(input) {
    active();const key=job(input),op=await authoritative(key),fingerprint=operationHash(key.roomId,op),evidence=await sourceEvidence(key,op),receipts=[];
    for(const channel of ['music','video']) {
      let receipt=await existing(key,op,channel,evidence);
      if(!receipt) {
        const raw=await retrieve(op.stages[channel],channel);await fresh(key,fingerprint,evidence.evidenceSha256);
        const assetId='raw-'+cueDigest({roomId:key.roomId,operationId:key.operationId,channel,
          descriptorSha256:descriptorHash(key.roomId,op,channel)}),binding=operationBinding(key.roomId,op,channel);
        const provenance={kind:'provider',operationId:key.operationId,requestId:op.stages[channel].requestId,
          resultSha256:op.stages[channel].result.resultSha256,sourceSha256:sourceHash(op,channel),modelId:GENERATION_CONTRACT[channel]};
        const saved=await assetStore.save({id:assetId,bytes:raw.bytes,contentType:contentType(channel),binding,provenance});
        if(saved?.assetId!==assetId||saved.sha256!==raw.sha256||saved.byteLength!==raw.byteLength)fail('PRIVATE_INGESTION_SAVE_MISMATCH');
        receipt=seal({version:INGESTION_RECEIPT_VERSION,...key,channel,assetId,sha256:raw.sha256,byteLength:raw.byteLength,
          contentType:contentType(channel),binding,...provenance,descriptorSha256:descriptorHash(key.roomId,op,channel),
          sourceEvidenceSha256:evidence.evidenceSha256});
        await verifyReceiptAsset(receipt);await fresh(key,fingerprint,evidence.evidenceSha256);
        await receiptStore.saveImmutable(structuredClone(receipt));
        const persisted=await existing(key,op,channel,evidence);
        if(!persisted||persisted.receiptSha256!==receipt.receiptSha256)fail('IMMUTABLE_INGESTION_SAVE_REQUIRED');
      }
      receipts.push(receipt);
    }
    await fresh(key,fingerprint,evidence.evidenceSha256);
    return {status:'PRIVATE_MEDIA_READY',...key,sourceEvidence:evidence,receipts};
  }
  async function guarded(action) {try{return await action();}catch(error){
    const held=new IngestionHold(safeReason(error));Object.defineProperty(held,'cause',{value:error});throw held;
  }}
  return {
    prepareMedia(input) {
      return guarded(async()=>{
        active();const key=job(input),identity=key.roomId+'/'+key.operationId;
        if(pending.has(identity))return pending.get(identity);
        if(pending.size>=2)fail('PRIVATE_INGESTION_BUSY');
        const work=prepare(key).finally(()=>pending.delete(identity));pending.set(identity,work);return work;
      });
    },
    readOperation(input) {
      return guarded(async()=>{
        active();const key=job(input),op=await authoritative(key),evidence=await sourceEvidence(key,op),fingerprint=operationHash(key.roomId,op);
        for(const channel of ['music','video']) {
          const receipt=await existing(key,op,channel,evidence);if(!receipt)fail('SAVED_MEDIA_REQUIRED');
          op.stages[channel].result={assetId:receipt.assetId,sha256:receipt.sha256,resultSha256:receipt.resultSha256,
            contentType:receipt.contentType,providerObserved:true};
        }
        await fresh(key,fingerprint,evidence.evidenceSha256);
        return {...op,ingestionSourceEvidence:evidence};
      });
    },
    // A fresh ledger/immutable-receipt projection for QC components. This does
    // NOT assert that media bytes are valid. Native QC, provenance resolution,
    // visual admission and final saved-asset checks still read the physical
    // assets. Avoid recursively decoding/rereading all source/raw media at
    // every metadata lookup made by those same components.
    readOperationMetadata(input) {
      return guarded(async()=>{
        active();const key=job(input),op=await authoritative(key),fingerprint=operationHash(key.roomId,op);
        const receipts=await Promise.all(['music','video'].map(async channel=>{
          const lookup={...key,channel},stored=await receiptStore.read(lookup);
          if(!stored)fail('SAVED_MEDIA_REQUIRED');const receipt=verifiedReceipt(stored,lookup);
          if(receipt.descriptorSha256!==descriptorHash(key.roomId,op,channel)||
            cueDigest(receipt.binding)!==cueDigest(operationBinding(key.roomId,op,channel))||
            receipt.sourceSha256!==sourceHash(op,channel))fail('IMMUTABLE_INGESTION_REFERENCE_CHANGED');
          return receipt;
        }));
        if(receipts[0].sourceEvidenceSha256!==receipts[1].sourceEvidenceSha256)fail('IMMUTABLE_INGESTION_REFERENCE_CHANGED');
        if(operationHash(key.roomId,await authoritative(key))!==fingerprint)fail('INGESTION_AUTHORITY_CHANGED');
        active();for(const receipt of receipts)op.stages[receipt.channel].result={assetId:receipt.assetId,
          sha256:receipt.sha256,resultSha256:receipt.resultSha256,contentType:receipt.contentType,providerObserved:true};
        return op;
      });
    },
    async close(){closed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...pending.values()]);},
  };
}
