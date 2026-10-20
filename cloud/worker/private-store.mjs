import {createHash} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest,cueSourceIdentity,validateCueSource} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {deriveVerifiedWave} from '../../integration/runtime/verified-wave-derivation.mjs';
import {createImmutableIngestionReceiptStore} from './private-ingestion.mjs';
import {createImmutableSourceStartReceiptStore} from '../jobs/source-start-receipts.mjs';

export {PRIVATE_BUCKET_TARGET} from './storage-contract.mjs';
import {PRIVATE_BUCKET_TARGET} from './storage-contract.mjs';
const MEDIA_LIMIT=32*1024*1024,JSON_LIMIT=64*1024;
const kinds=['audio/wav','video/mp4','image/png','image/jpeg','application/json'];
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
class PrivateStoreReason extends Error {}
const fail=code=>{throw new PrivateStoreReason(code);};
export class PrivateStoreHold extends DispatchError {
  constructor(reason){super('PRIVATE_STORE_HOLD');this.message=reason;this.holdReason=reason;}
}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
  ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
function jsonBytes(value) {
  let serialized;try{serialized=JSON.stringify(canonical(value));}catch{fail('PRIVATE_STORE_JSON_REQUIRED');}
  if(typeof serialized!=='string'||Buffer.byteLength(serialized)>JSON_LIMIT)fail('PRIVATE_STORE_JSON_REQUIRED');
  // Stored records contain anonymous IDs/digests, never locations or access data.
  if(/https?:\/\/|file:\/\/|\/Users\//i.test(serialized)||
    /"(?:url|signedUrl|rawremoteURL|ownerCapability|keyProof|apiKey|falKey|privateKey|credentials|authorization|token|email)"\s*:/i.test(serialized))
    fail('PRIVATE_STORE_SAFE_METADATA_REQUIRED');
  return Buffer.from(serialized);
}
const seal=value=>({...value,recordSha256:cueDigest(value)});
function unseal(value) {
  if(!value||!sha(value.recordSha256))fail('PRIVATE_STORE_RECORD_CHANGED');
  const {recordSha256,...record}=value;if(cueDigest(record)!==recordSha256)fail('PRIVATE_STORE_RECORD_CHANGED');
  jsonBytes(value);return record;
}
const sourceIdFor=(roomId,source)=>'source-'+cueDigest({roomId,identity:cueSourceIdentity(source),
  audioAssetId:source.audioAssetId,contextAssetId:source.contextAssetId,referenceAssetId:source.referenceAssetId}).slice(0,48);

/** Mount only inside an authorized private broker/worker host, never a browser. */
export function createPrivateStore({enabled=false,roomId,transport,timeoutMs=30000}={}) {
  if(!id(roomId)||!['describeBucket','readObject','putObjectIfAbsent'].every(k=>typeof transport?.[k]==='function'))
    fail('PRIVATE_STORE_HOST_DEPENDENCIES_REQUIRED');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>120000)fail('PRIVATE_STORE_BOUNDED_TIMEOUT_REQUIRED');
  const prefix='rooms/'+cueDigest(roomId),bucket=PRIVATE_BUCKET_TARGET;let closed=false;
  const controllers=new Set();
  const active=()=>{if(enabled!==true)fail('PRIVATE_STORE_NOT_ACTIVATED');if(closed)fail('PRIVATE_STORE_CLOSED');};
  async function guarded(action) {
    try{active();return await action();}
    catch(error){const held=new PrivateStoreHold(error instanceof PrivateStoreReason?error.message:'PRIVATE_STORE_FAILED');held.cause=error;throw held;}
  }
  async function hostCall(method,input) {
    active();const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);let abort;
    const stopped=new Promise((_,reject)=>{abort=()=>reject(new PrivateStoreReason(closed?'PRIVATE_STORE_CLOSED':'PRIVATE_STORE_TRANSPORT_TIMEOUT'));
      controller.signal.addEventListener('abort',abort,{once:true});});
    try{return await Promise.race([transport[method]({...input,signal:controller.signal}),stopped]);}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);controller.abort();controllers.delete(controller);}
  }
  async function configuration() {
    const config=await hostCall('describeBucket',{bucket});
    if(config?.id!==bucket||config.public!==false||config.fileSizeLimit!==MEDIA_LIMIT||
      !Array.isArray(config.allowedMimeTypes)||config.allowedMimeTypes.some(x=>typeof x!=='string')||
      cueDigest([...config.allowedMimeTypes].sort())!==cueDigest([...kinds].sort()))fail('PRIVATE_BUCKET_CONFIGURATION_MISMATCH');
  }
  async function boundedObject(path,maximumBytes) {
    active();const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),timeoutMs);let reader,abort;
    const stopped=new Promise((_,reject)=>{abort=()=>reject(new PrivateStoreReason(closed?'PRIVATE_STORE_CLOSED':'PRIVATE_STORE_READ_TIMEOUT'));
      controller.signal.addEventListener('abort',abort,{once:true});});
    try {
      const response=await Promise.race([transport.readObject({bucket,path,maximumBytes,signal:controller.signal}),stopped]);
      if(response===null||response===undefined)return null;
      const declared=response.contentLength;
      if(declared!==undefined&&(!Number.isSafeInteger(declared)||declared<1||declared>maximumBytes))
        fail('PRIVATE_STORE_OBJECT_SIZE_REQUIRED');
      if(!kinds.includes(response.contentType)||typeof response.body?.getReader!=='function')fail('PRIVATE_STORE_BOUNDED_STREAM_REQUIRED');
      reader=response.body.getReader();const chunks=[];let length=0;
      while(true){const part=await Promise.race([reader.read(),stopped]);if(part.done)break;
        if(!(part.value instanceof Uint8Array)||!part.value.length)fail('PRIVATE_STORE_BOUNDED_STREAM_REQUIRED');
        length+=part.value.length;if(length>maximumBytes)fail('PRIVATE_STORE_OBJECT_TOO_LARGE');chunks.push(Buffer.from(part.value));}
      if(!length||declared!==undefined&&declared!==length)fail('PRIVATE_STORE_OBJECT_LENGTH_MISMATCH');
      return {bytes:Buffer.concat(chunks,length),contentType:response.contentType};
    } finally {clearTimeout(timer);controller.signal.removeEventListener('abort',abort);controller.abort();controllers.delete(controller);
      if(reader)reader.cancel().catch(()=>{});}
  }
  async function readJSON(path) {
    const data=await boundedObject(path,JSON_LIMIT);if(!data)return null;
    if(data.contentType!=='application/json')fail('PRIVATE_STORE_JSON_REQUIRED');
    let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.bytes));}catch{fail('PRIVATE_STORE_JSON_REQUIRED');}
    return unseal(value);
  }
  async function putJSON(path,record) {
    const bytes=jsonBytes(seal(record));
    const previous=await readJSON(path);
    if(previous){if(cueDigest(previous)!==cueDigest(record))fail('PRIVATE_STORE_IMMUTABLE_CONFLICT');return previous;}
    await hostCall('putObjectIfAbsent',{bucket,path,bytes,contentType:'application/json',upsert:false});
    const saved=await readJSON(path);if(!saved||cueDigest(saved)!==cueDigest(record))fail('PRIVATE_STORE_IMMUTABLE_CONFLICT');
    return saved;
  }
  const assetPath=assetId=>{
    if(!id(assetId))fail('PRIVATE_ASSET_ID_REQUIRED');return prefix+'/assets/'+assetId;
  };
  function scope(binding) {
    if(binding?.kind==='owner-supplied-bootstrap'&&Object.keys(binding).length===1)return;
    if(binding?.roomId!==roomId)fail('PRIVATE_STORE_ROOM_BINDING_REQUIRED');
  }
  async function readAsset(assetId) {
    const base=assetPath(assetId),metadata=await readJSON(base+'.json');
    if(!metadata||metadata.version!=='private-asset-v1'||metadata.roomId!==roomId||metadata.assetId!==assetId||
      !sha(metadata.sha256)||!Number.isSafeInteger(metadata.byteLength)||metadata.byteLength<1||metadata.byteLength>MEDIA_LIMIT||
      !kinds.includes(metadata.contentType))fail('PRIVATE_ASSET_RECORD_REQUIRED');
    scope(metadata.binding);const media=await boundedObject(base+'.media',MEDIA_LIMIT);
    if(!media||media.contentType!==metadata.contentType||media.bytes.length!==metadata.byteLength||hash(media.bytes)!==metadata.sha256)
      fail('PRIVATE_ASSET_PHYSICAL_SHA_MISMATCH');
    return {...metadata,bytes:media.bytes};
  }
  const assetStore={
    sign:input=>guarded(async()=>{
      await configuration();const record=await readAsset(input?.assetId);
      if(record.sha256!==input.sha256||!Number.isSafeInteger(input.expiresIn)||input.expiresIn<1||input.expiresIn>3600)fail('PRIVATE_SIGNING_BOUND_REQUIRED');
      const signed=await hostCall('signObject',{bucket,path:assetPath(record.assetId)+'.media',expiresIn:input.expiresIn});
      return {...signed,assetId:record.assetId,sha256:record.sha256,private:true,checksumVerified:true};
    }),
    read:assetId=>guarded(async()=>{await configuration();return readAsset(assetId);}),
    readOptional:assetId=>guarded(async()=>{
      await configuration();const base=assetPath(assetId),metadata=await readJSON(base+'.json');
      if(metadata===null)return null;
      return readAsset(assetId);
    }),
    save:input=>guarded(async()=>{
      const {id:assetId,contentType}=input??{},binding=structuredClone(input?.binding),
        provenance=structuredClone(input?.provenance??{}),bytes=input?.bytes;
      if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MEDIA_LIMIT||!kinds.includes(contentType))fail('PRIVATE_STORE_MEDIA_REQUIRED');
      const copy=Buffer.from(bytes),base=assetPath(assetId);scope(binding);
      const provenanceKeys=['kind','requestId','resultSha256','modelId','generationId','contextSha256','operationId',
        'sourceSha256','rawSha256','referenceSha256','parentSha256','actualGenerationThisRun','admissionId','admissionEvidenceSha256'];
      if(!provenance||Object.keys(provenance).some(k=>!provenanceKeys.includes(k)))fail('PRIVATE_STORE_SAFE_METADATA_REQUIRED');
      const metadata={version:'private-asset-v1',roomId,assetId,sha256:hash(copy),byteLength:copy.length,contentType,binding,provenance};
      jsonBytes(metadata);await configuration();const previous=await readJSON(base+'.json');
      if(previous&&cueDigest(previous)!==cueDigest(metadata))fail('PRIVATE_STORE_IMMUTABLE_CONFLICT');
      if(previous)return readAsset(assetId);
      let physical=await boundedObject(base+'.media',MEDIA_LIMIT);
      if(!physical){await hostCall('putObjectIfAbsent',{bucket,path:base+'.media',bytes:copy,contentType,upsert:false});
        physical=await boundedObject(base+'.media',MEDIA_LIMIT);}
      if(!physical||physical.contentType!==contentType||hash(physical.bytes)!==metadata.sha256||physical.bytes.length!==metadata.byteLength)
        fail('PRIVATE_ASSET_PHYSICAL_SHA_MISMATCH');
      await putJSON(base+'.json',metadata);return readAsset(assetId);
    }),
    verifySaved:input=>guarded(async()=>{
      await configuration();const record=await readAsset(input?.asset?.assetId);
      if(record.sha256!==input.asset.sha256||cueDigest(record.binding)!==cueDigest(input.binding))fail('PRIVATE_STORE_ROOM_BINDING_REQUIRED');
      return {privateSaved:true,checksumVerified:true,assetId:record.assetId,sha256:record.sha256,binding:record.binding};
    }),
  };
  async function sourcePhysical(source,evidence) {
    validateCueSource(source);
    if(evidence?.kind!=='verified-source-context-v1'||evidence.roomId!==roomId||evidence.serverAudioQC!==true||
      evidence.contextSeconds!==16||evidence.parentAssetId!==source.audioAssetId||evidence.parentSha256!==source.music.sha256||
      evidence.contextAssetId!==source.contextAssetId||evidence.contextSha256!==source.music.contextSha256||
      evidence.referenceAssetId!==source.referenceAssetId||evidence.referenceSha256!==source.video.referenceSha256||
      !['owner-supplied-bootstrap','provider'].includes(evidence.originKind))fail('PRIVATE_SOURCE_EVIDENCE_REQUIRED');
    const [parent,context,reference]=await Promise.all([readAsset(source.audioAssetId),readAsset(source.contextAssetId),readAsset(source.referenceAssetId)]);
    if(parent.sha256!==source.music.sha256||context.sha256!==source.music.contextSha256||reference.sha256!==source.video.referenceSha256||
      deriveVerifiedWave(parent).contextSha256!==context.sha256)fail('PRIVATE_SOURCE_CONTEXT_CHANGED');
    if(evidence.originKind==='owner-supplied-bootstrap'&&(parent.provenance.kind!=='owner-supplied-bootstrap'||evidence.providerReceipt!==undefined))
      fail('PRIVATE_SOURCE_ORIGIN_REQUIRED');
    if(evidence.originKind==='provider'&&(parent.provenance.kind!=='provider'||
      parent.provenance.requestId!==evidence.providerReceipt?.requestId||parent.provenance.resultSha256!==evidence.providerReceipt?.resultSha256))
      fail('PRIVATE_SOURCE_ORIGIN_REQUIRED');
  }
  const sourceStore={
    save:({source,sourceEvidence})=>guarded(async()=>{
      await configuration();source=structuredClone(source);sourceEvidence=structuredClone(sourceEvidence);
      await sourcePhysical(source,sourceEvidence);const sourceId=sourceIdFor(roomId,source);
      await putJSON(prefix+'/sources/'+sourceId+'.json',{version:'private-source-v1',roomId,sourceId,source,sourceEvidence});
      return {sourceId,sourceSha256:cueDigest(cueSourceIdentity(source))};
    }),
    read:sourceId=>guarded(async()=>{
      await configuration();if(!id(sourceId))fail('PRIVATE_SOURCE_ID_REQUIRED');
      const record=await readJSON(prefix+'/sources/'+sourceId+'.json');
      if(!record||record.version!=='private-source-v1'||record.roomId!==roomId||record.sourceId!==sourceId||
        sourceIdFor(roomId,record.source)!==sourceId)fail('PRIVATE_SOURCE_RECORD_REQUIRED');
      await sourcePhysical(record.source,record.sourceEvidence);return record;
    }),
  };
  const receipts=createImmutableIngestionReceiptStore({
    readRecord:({id:recordId,reference})=>guarded(async()=>{
      await configuration();if(reference.roomId!==roomId||!id(recordId))fail('PRIVATE_STORE_ROOM_BINDING_REQUIRED');
      return readJSON(prefix+'/receipts/'+recordId+'.json');
    }),
    putIfAbsent:({id:recordId,reference,record})=>guarded(async()=>{
      await configuration();if(reference.roomId!==roomId||record.roomId!==roomId||!id(recordId))fail('PRIVATE_STORE_ROOM_BINDING_REQUIRED');
      return putJSON(prefix+'/receipts/'+recordId+'.json',record);
    }),
  });
  // Source-only playback receipts have their own typed validator and immutable
  // key/namespace. Ingestion receipts are never reused as source-start evidence.
  // The parent store's disabled/closed/bounded transport checks still apply.
  const sourceStartReceipts=createImmutableSourceStartReceiptStore({
    readRecord:({id:recordId,reference})=>guarded(async()=>{
      await configuration();if(reference.roomId!==roomId||!id(recordId))fail('PRIVATE_STORE_ROOM_BINDING_REQUIRED');
      return readJSON(prefix+'/source-start-receipts/'+recordId+'.json');
    }),
    putIfAbsent:({id:recordId,reference,record})=>guarded(async()=>{
      await configuration();if(reference.roomId!==roomId||record.roomId!==roomId||!id(recordId))fail('PRIVATE_STORE_ROOM_BINDING_REQUIRED');
      return putJSON(prefix+'/source-start-receipts/'+recordId+'.json',record);
    }),
  });
  return {assetStore,receiptStore:receipts,sourceStartReceiptStore:sourceStartReceipts,sourceStore,
    readSourceEvidence:input=>guarded(async()=>{
      if(input?.roomId!==roomId)fail('PRIVATE_STORE_ROOM_BINDING_REQUIRED');
      const record=await sourceStore.read(sourceIdFor(roomId,input.source)),source=input.source;
      if(cueDigest(cueSourceIdentity(record.source))!==cueDigest(cueSourceIdentity(source))||
        cueDigest(record.source.music.profile)!==cueDigest(source.music.profile))fail('PRIVATE_SOURCE_RECORD_CHANGED');
      return structuredClone(record.sourceEvidence);
    }),
    close(){closed=true;for(const controller of controllers)controller.abort();},
  };
}
