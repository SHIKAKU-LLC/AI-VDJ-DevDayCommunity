import {createHash} from 'node:crypto';
import {cueDigest,cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {operationBinding} from '../generation/cue-contract.mjs';
import {GENERATION_CONTRACT} from '../generation/dispatch.mjs';
import {deriveVerifiedWave} from '../../integration/runtime/verified-wave-derivation.mjs';
import {INGESTION_RECEIPT_VERSION} from './private-ingestion.mjs';
import {adapterFail as fail,adapterGuard} from './operator-adapter-error.mjs';
import {approvedBootstrapProfile,verifiedBootstrapContext,isBootstrapPreparationSource} from '../generation/bootstrap-source-contract.mjs';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const hash=b=>createHash('sha256').update(b).digest('hex');
const fields=s=>Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,s[k]]));
const same=(a,b)=>cueDigest(fields(a))===cueDigest(fields(b));
async function physical(store,assetId,sha256){const r=await store.read(assetId),p=await store.verifySaved({binding:r.binding,asset:{assetId,sha256}});
 if(!(r.bytes instanceof Uint8Array)||r.assetId!==assetId||r.sha256!==sha256||hash(r.bytes)!==sha256||r.byteLength!==r.bytes.length||p.privateSaved!==true||p.checksumVerified!==true||cueDigest(p.binding)!==cueDigest(r.binding))fail('OPERATOR_PHYSICAL_SOURCE_CHANGED');return r;}
export function createOperatorSourceSigner({enabled=false,privateStore,readScope,readCurrentSource,
  readPreparationSource,readBootstrapAuthority,bootstrapConfiguration,now=Date.now}={}){
 return async input=>adapterGuard(async()=>{if(!enabled)fail('OPERATOR_SIGNING_NOT_ACTIVATED');
  const before=await readScope({roomId:input.roomId});if(!same(before,input)||input.expiresAtMs>before.expiresAtMs||input.expiresAtMs>now()+3600000||input.expiresAtMs<=now()||input.expiresAtMs%1000!==0)fail('OPERATOR_SIGNING_BOUND_REQUIRED');
  const source=input.source,preparation=isBootstrapPreparationSource(source);
  const readSource=preparation?readPreparationSource:readCurrentSource;
  if(typeof readSource!=='function')fail('OPERATOR_SOURCE_CHANGED');
  const current=await readSource({roomId:input.roomId});
  if((preparation?!isBootstrapPreparationSource(current):current?.playback?.actual!==true)||cueDigest(cueSourceIdentity(current))!==cueDigest(cueSourceIdentity(source)))fail('OPERATOR_SOURCE_CHANGED');
  const e=await privateStore.readSourceEvidence({roomId:input.roomId,source});
  if(e?.kind!=='verified-source-context-v1'||e.roomId!==input.roomId||e.serverAudioQC!==true||e.contextSeconds!==16||e.parentAssetId!==source.audioAssetId||e.parentSha256!==source.music.sha256||
   e.contextAssetId!==source.contextAssetId||e.contextSha256!==source.music.contextSha256||e.referenceAssetId!==source.referenceAssetId||e.referenceSha256!==source.video.referenceSha256)fail('OPERATOR_SOURCE_EVIDENCE_REQUIRED');
  const isBootstrap=e.originKind==='owner-supplied-bootstrap';
  if(preparation&&!isBootstrap)fail('OPERATOR_SOURCE_ORIGIN_REQUIRED');
  if(e.originKind!=='provider'&&!isBootstrap||isBootstrap&&typeof readBootstrapAuthority!=='function')fail('OPERATOR_SOURCE_ORIGIN_REQUIRED');
  const parent=await physical(privateStore.assetStore,e.parentAssetId,e.parentSha256);
  const context=await physical(privateStore.assetStore,e.contextAssetId,e.contextSha256);
  const reference=await physical(privateStore.assetStore,e.referenceAssetId,e.referenceSha256);
  const derived=deriveVerifiedWave(parent);
  if(derived.contextSha256!==context.sha256)fail('OPERATOR_SOURCE_ORIGIN_REQUIRED');
  let bootstrapEvidence;
  async function bootstrapProof(){
   const approved=bootstrapConfiguration,selected=await readBootstrapAuthority(fields(before));
   if(!approved||!same(selected,before)||selected.kind!=='server-selected-source-start-v1'||selected.mode!=='bootstrap'||
    selected.serverQC!==true||!/^[a-f0-9]{64}$/.test(selected.qcEvidenceSha256??'')||
    selected.sourceSha256!==cueDigest(cueSourceIdentity(source))||selected.source?.playback?.actual!==false||selected.source.playback.revision!==0||
    selected.source.audioAssetId!==parent.assetId||selected.source.contextAssetId!==context.assetId||selected.source.referenceAssetId!==reference.assetId||
    selected.source.music.sha256!==parent.sha256||selected.source.video.referenceSha256!==reference.sha256||
    cueDigest(selected.source.music.profile)!==cueDigest(source.music.profile)||
    !id(approved.audioAssetId)||approved.audioSha256!==parent.sha256||!id(approved.referenceAssetId)||approved.referenceSha256!==reference.sha256||
    selected.qcEvidenceSha256!==cueDigest({evidence:e,profile:source.music.profile})||
    parent.provenance?.kind!=='owner-supplied-bootstrap'||context.provenance?.kind!=='owner-supplied-bootstrap'||e.providerReceipt!==undefined||
    derived.frames!==24*44100||derived.rate!==44100||!approvedBootstrapProfile(source.music.profile,parent.sha256))fail('OPERATOR_SOURCE_ORIGIN_REQUIRED');
   // Preparation can save the same approved input under a content-addressed
   // source ID. Recheck selected input bytes rather than equating those IDs.
   await physical(privateStore.assetStore,approved.audioAssetId,approved.audioSha256);
   await physical(privateStore.assetStore,approved.referenceAssetId,approved.referenceSha256);
   return selected;
  }
  if(isBootstrap){
   const selected=await bootstrapProof(),body={kind:preparation?'verified-owner-bootstrap-preparation-v1':'verified-owner-bootstrap-context-v1',...fields(before),expiresAtMs:before.expiresAtMs,
    authoritySha256:cueDigest(selected),qcEvidenceSha256:selected.qcEvidenceSha256,sourceEvidenceSha256:cueDigest(e),
    sourceSha256:cueDigest(cueSourceIdentity(source)),profileSha256:cueDigest(source.music.profile),
    parentAssetId:parent.assetId,parentSha256:parent.sha256,contextAssetId:context.assetId,contextSha256:context.sha256,
    referenceAssetId:reference.assetId,referenceSha256:reference.sha256,playbackRevision:source.playback.revision,playedUntilFrame:source.playback.playedUntilFrame};
   bootstrapEvidence={...body,evidenceSha256:cueDigest(body)};
   if(!verifiedBootstrapContext({originKind:e.originKind,serverAudioQC:true,providerOriginVerified:false,bootstrapEvidence},source,
    {now,expiresAtMs:input.expiresAtMs,scope:before}))fail('OPERATOR_SOURCE_ORIGIN_REQUIRED');
  }else if(parent.provenance?.kind!=='provider'||parent.provenance.requestId!==e.providerReceipt?.requestId||
   parent.provenance.resultSha256!==e.providerReceipt?.resultSha256)fail('OPERATOR_SOURCE_ORIGIN_REQUIRED');
  if(!['image/png','image/jpeg'].includes(reference.contentType))fail('OPERATOR_SOURCE_EVIDENCE_REQUIRED');
  if(!same(before,await readScope({roomId:input.roomId})))fail('OPERATOR_SCOPE_CHANGED');
  const expiresIn=Math.ceil((input.expiresAtMs-now())/1000);
  const signed={context:await privateStore.assetStore.sign({assetId:context.assetId,sha256:context.sha256,expiresIn}),
   reference:await privateStore.assetStore.sign({assetId:reference.assetId,sha256:reference.sha256,expiresIn})};
  if(Object.values(signed).some(a=>a.expiresAtMs<input.expiresAtMs)||!same(before,await readScope({roomId:input.roomId}))||
    cueDigest(cueSourceIdentity(await readSource({roomId:input.roomId})))!==cueDigest(cueSourceIdentity(source)))fail('OPERATOR_SOURCE_CHANGED');
  if(isBootstrap){
   if(cueDigest(await bootstrapProof())!==bootstrapEvidence.authoritySha256||
    !verifiedBootstrapContext({originKind:e.originKind,serverAudioQC:true,providerOriginVerified:false,bootstrapEvidence},
      await readSource({roomId:input.roomId}),{now,expiresAtMs:input.expiresAtMs,scope:await readScope({roomId:input.roomId})}))fail('OPERATOR_SOURCE_CHANGED');
  }
  return {...signed,context:{...signed.context,serverAudioQC:true,providerOriginVerified:!isBootstrap,
    ...(isBootstrap?{originKind:e.originKind,bootstrapEvidence}:{})}};
 },'OPERATOR_SIGNING_HOLD');
}

// Lookup over explicit pre-approved private asset IDs. No URL/fal Assets search,
// external media fetch, hash-only provenance assertion or room-global discovery.
export function createSavedVideoResolver({enabled=false,assetStore,receiptStore,readOperation,readScope,approvedAssetIds=[]}={}){
 if(!Array.isArray(approvedAssetIds)||approvedAssetIds.length>32||approvedAssetIds.some(x=>!id(x))||new Set(approvedAssetIds).size!==approvedAssetIds.length)fail('OPERATOR_VIDEO_CATALOG_REQUIRED');
 return async input=>adapterGuard(async()=>{if(!enabled)fail('OPERATOR_PROVENANCE_NOT_ACTIVATED');const before=await readScope({roomId:input.roomId});if(!same(before,input))fail('OPERATOR_SCOPE_CHANGED');
  let selected;for(const assetId of approvedAssetIds){const r=await assetStore.read(assetId);if(r.sha256===input.sha256){if(selected)fail('OPERATOR_VIDEO_PROVENANCE_AMBIGUOUS');selected=r;}}
  if(!selected||selected.contentType!=='video/mp4'||selected.provenance?.kind!=='provider'||selected.provenance.sourceSha256!==input.referenceSha256)fail('OPERATOR_SAVED_VIDEO_PROVENANCE_REQUIRED');
  const r=await physical(assetStore,selected.assetId,input.sha256),p=r.provenance,op=await readOperation({roomId:input.roomId,operationId:p.operationId});
  const receipt=await receiptStore.read({roomId:input.roomId,operationId:p.operationId,channel:'video'}),stage=op?.stages?.video;
  const {receiptSha256,...receiptBody}=receipt??{};
  if(!receipt||receipt.version!==INGESTION_RECEIPT_VERSION||receipt.kind!=='provider'||receipt.roomId!==input.roomId||receipt.operationId!==p.operationId||receipt.channel!=='video'||cueDigest(receiptBody)!==receiptSha256||
   op.operationId!==p.operationId||stage?.state!=='COMPLETE'||stage.requestId!==p.requestId||stage.result?.providerObserved!==true||stage.result.resultSha256!==p.resultSha256||
   op.permit?.source?.video?.referenceSha256!==input.referenceSha256||p.modelId!==GENERATION_CONTRACT.video||receipt.modelId!==p.modelId||receipt.assetId!==r.assetId||receipt.sha256!==r.sha256||
   receipt.requestId!==p.requestId||receipt.resultSha256!==p.resultSha256||receipt.sourceSha256!==input.referenceSha256||
   cueDigest(r.binding)!==cueDigest(operationBinding(input.roomId,op,'video'))||cueDigest(receipt.binding)!==cueDigest(r.binding))fail('OPERATOR_SAVED_VIDEO_PROVENANCE_REQUIRED');
  if(!same(before,await readScope({roomId:input.roomId})))fail('OPERATOR_SCOPE_CHANGED');return {binding:structuredClone(r.binding),provenance:structuredClone(p)};
 },'OPERATOR_PROVENANCE_HOLD');
}
