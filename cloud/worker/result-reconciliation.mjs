import {createHash} from 'node:crypto';
import {cueDigest,cueSourceIdentity,validateCueSource} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {compileSemanticIntent,INTENT_PROVIDER} from '../../snapshot/app/runtime/intent-semantics.mjs';
import {GENERATION_CONTRACT,generationIdentity,matchesOperationCredential,normalizeCompletedProviderResult} from '../generation/dispatch.mjs';

const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const hash=b=>createHash('sha256').update(b).digest('hex');
const scope=({roomId,sessionId,controlRevision})=>({roomId,sessionId,controlRevision});
const same=(a,b)=>cueDigest(scope(a))===cueDigest(scope(b));
const fail=code=>{throw Error(code);};
const channels=['intent','music','video'];
// A raw reply can contain temporary media locations. Retain its digest and
// location-free payload; acquisition URLs live only until the bounded GET.
const withoutLocations=value=>Array.isArray(value)?value.map(withoutLocations):value&&typeof value==='object'?
 Object.fromEntries(Object.entries(value).map(([k,v])=>[k,withoutLocations(v)])):
 typeof value==='string'&&/https?:\/\//i.test(value)?{locationSha256:cueDigest(value)}:value;

/** Existing receipts only. A finite spending permit may be expired, but is
 * NEVER considered valid here. Fresh owner/device/room/Stop/connection checks
 * still govern GETs and private saving. This object cannot submit, claim,
 * complete an operation, publish a Cue, or alter an authorization/lease.
 */
export function createProviderResultReconciler({enabled=false,readFacts,withCredential,provider,assetStore,
 fetchImpl=globalThis.fetch,inspectMedia,now=Date.now}={}){
 if(typeof readFacts!=='function'||typeof withCredential!=='function'||!provider?.status||!provider?.result||
  provider.submit!==undefined||!assetStore?.read||!assetStore?.save||!assetStore?.verifySaved)fail('RESULT_RECONCILIATION_PORTS_REQUIRED');
 let closed=false;const pending=new Map(),controllers=new Set();
 const active=()=>{if(!enabled||closed)fail('RESULT_RECONCILIATION_NOT_ACTIVATED');};
 async function facts(input,expected){
  active();const f=await readFacts(input),op=f?.operation,p=f?.permitScope,s=f?.scope;
  if(!s||!p||!op||s.roomId!==input.roomId||!Number.isFinite(s.expiresAtMs)||s.expiresAtMs<=now()||s.closed||!same(s,p)||p.revoked!==false||
   p.permitId!==op?.permit?.permitId||p.permitSha256!==cueDigest(op.permit)||op.operationId!==input.operationId||
   op.stopped!==false||f.playback?.roomId!==input.roomId||f.playback.stopped!==false||!id(f.connectionId)||
   f.connectionId!==op.permit.connectionId||!sha(op.permit.sourceSha256)||
   cueDigest(cueSourceIdentity(op.permit.source))!==op.permit.sourceSha256)fail('RESULT_RECONCILIATION_AUTHORITY_HOLD');
  validateCueSource(op.permit.source);
  if(op.permit.kind!==GENERATION_CONTRACT.version||cueDigest(op.permit.counts)!==cueDigest(GENERATION_CONTRACT.counts))fail('RESULT_RECONCILIATION_BINDING_HOLD');
  if(!op.stages||Object.keys(op.stages).some(k=>!channels.includes(k))||!Object.keys(op.stages).length||
   Object.values(op.stages).some(v=>!['SUBMITTED','COMPLETE'].includes(v?.state)||!id(v.requestId)||!sha(v.signature)))
   fail('RESULT_RECONCILIATION_KNOWN_RECEIPTS_ONLY');
  const fingerprint=cueDigest({scope:scope(s),expiresAtMs:s.expiresAtMs,permitSha256:p.permitSha256,
   submissionId:op.submissionId,promptSha256:cueDigest(op.prompt),stages:Object.fromEntries(Object.entries(op.stages)
    .map(([k,v])=>[k,{requestId:v.requestId,signature:v.signature}]))});
  if(expected&&expected!==fingerprint)fail('RESULT_RECONCILIATION_AUTHORITY_CHANGED');
  return {...f,fingerprint,spendingAuthorized:false,activeWorker:p.expiresAtMs>now()&&
   op.scheduler?.terminal!==true&&Number(op.scheduler?.leaseUntilMs)>now()};
 }
 async function saved(assetId,binding){
  const r=await (assetStore.readOptional??assetStore.read).call(assetStore,assetId);if(!r)return null;
  if(r.assetId!==assetId||!(r.bytes instanceof Uint8Array)||hash(r.bytes)!==r.sha256||
   cueDigest(r.binding)!==cueDigest(binding))fail('RESULT_RECONCILIATION_SAVED_BINDING_HOLD');
  const proof=await assetStore.verifySaved({binding,asset:{assetId,sha256:r.sha256}});
  if(proof?.privateSaved!==true||proof.checksumVerified!==true||proof.assetId!==assetId||proof.sha256!==r.sha256)
   fail('RESULT_RECONCILIATION_SAVED_PROOF_HOLD');return r;
 }
 async function mediaBytes(url,channel){
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||
   !/(^|\.)fal\.media$/.test(u.hostname))fail('RESULT_RECONCILIATION_MEDIA_HOLD');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);controllers.add(controller);let reader,abort;
  const stopped=new Promise((_,reject)=>{abort=()=>reject(Error('RESULT_RECONCILIATION_MEDIA_TIMEOUT'));
   controller.signal.addEventListener('abort',abort,{once:true});});
  try{
   const r=await Promise.race([fetchImpl(u.href,{method:'GET',credentials:'omit',redirect:'error',signal:controller.signal}),stopped]);
   if(!r?.ok||r.redirected||r.url&&r.url!==u.href)fail('RESULT_RECONCILIATION_MEDIA_HOLD');
   const type=r.headers.get('content-type')?.split(';')[0];
   if(![channel==='music'?'audio/wav':'video/mp4','application/octet-stream',...(channel==='music'?['audio/x-wav']:[])].includes(type))fail('RESULT_RECONCILIATION_MEDIA_TYPE_HOLD');
   const length=r.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)<1||Number(length)>32*1024*1024))fail('RESULT_RECONCILIATION_MEDIA_SIZE_HOLD');
   reader=r.body?.getReader();if(!reader)fail('RESULT_RECONCILIATION_MEDIA_HOLD');const parts=[];let size=0;
   for(;;){const p=await Promise.race([reader.read(),stopped]);if(p.done)break;
    if(!(p.value instanceof Uint8Array)||!p.value.length)fail('RESULT_RECONCILIATION_MEDIA_SIZE_HOLD');
    size+=p.value.length;if(size>32*1024*1024)fail('RESULT_RECONCILIATION_MEDIA_SIZE_HOLD');parts.push(Buffer.from(p.value));}
   if(!size||length!==null&&size!==Number(length))fail('RESULT_RECONCILIATION_MEDIA_SIZE_HOLD');return Buffer.concat(parts,size);
  }finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);controller.abort();controllers.delete(controller);reader?.cancel().catch(()=>{});}
 }
 async function reconcile(input){
  let first=await facts(input);if(first.activeWorker)return {operationId:input.operationId,state:'ACTIVE_WORKER',spendingAuthorized:false,cueEligible:false};
  const result=[];
  for(const channel of channels){
   const stage=first.operation.stages[channel];if(!stage)continue;
   if(stage.state==='COMPLETE'){result.push({stage:channel,requestId:stage.requestId,state:'LEDGER_COMPLETE'});continue;}
   const op=first.operation,binding={kind:'provider-result-reconciliation-v1',...scope(first.scope),operationId:op.operationId,
    stage:channel,requestId:stage.requestId,signature:stage.signature,sourceSha256:op.permit.sourceSha256,permitSha256:first.permitScope.permitSha256};
   const resultId='provider-result-'+cueDigest(binding).slice(0,48);
   const read=async method=>{await facts(input,first.fingerprint);return withCredential(first,async (key,signal)=>{
    if(!matchesOperationCredential(op,key))fail('GENERATION_KEY_MISMATCH');
    const args={key,signal,model:GENERATION_CONTRACT[channel],requestId:stage.requestId,operationId:op.operationId,stage:channel};
    const r=await provider[method](args),data=r.data??r;
    if(JSON.stringify(data).includes(key))fail('RESULT_RECONCILIATION_SECRET_HOLD');return data;
   });};
   let record=await saved(resultId,binding),body,downloadURL;
   if(record){body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.bytes));}
   else{
    const status=await read('status');await facts(input,first.fingerprint);
    const raw=status?.status==='COMPLETED'?await read('result'):null;
    if(!raw){result.push({stage:channel,requestId:stage.requestId,state:'PROVIDER_PENDING'});continue;}
    await facts(input,first.fingerprint);
    const normalized=normalizeCompletedProviderResult(channel,raw,op),resultSha256=cueDigest(raw);
    downloadURL=normalized.url;
    const plan=channel==='intent'?compileSemanticIntent({text:op.prompt,source:op.permit.source,
     cueId:generationIdentity(op.operationId).cueId,controlVersion:op.permit.source.music.control.version+1,
     semantic:normalized.semantic,provenance:{endpoint:INTENT_PROVIDER.endpoint,model:INTENT_PROVIDER.model,
      providerRequestId:stage.requestId,actualProviderInference:true,resultSha256,usage:normalized.usage}}):null;
    const {url,...mediaDescriptor}=normalized,retained=withoutLocations(raw);
    body={version:'provider-result-reconciliation-v1',binding,resultSha256,raw:retained,retainedSha256:cueDigest(retained),
     normalized:channel==='intent'?normalized:mediaDescriptor,...(plan?{plan}:{}),
     spendingAuthorized:false,cueEligible:false};
    const serialized=JSON.stringify(body);if(/https?:\/\/|file:\/\/|\/Users\//i.test(serialized))fail('RESULT_RECONCILIATION_RECORD_HOLD');
    const bytes=new TextEncoder().encode(serialized);if(bytes.length>65536)fail('RESULT_RECONCILIATION_RECORD_SIZE_HOLD');
    record=await assetStore.save({id:resultId,bytes,contentType:'application/json',binding,
     provenance:{kind:'provider-result-reconciliation',operationId:op.operationId,requestId:stage.requestId,
      modelId:GENERATION_CONTRACT[channel],sourceSha256:op.permit.sourceSha256,resultSha256,actualGenerationThisRun:true}});
    await facts(input,first.fingerprint);record=await saved(resultId,binding);
   }
   if(body?.version!=='provider-result-reconciliation-v1'||cueDigest(body.binding)!==cueDigest(binding)||
    !sha(body.resultSha256)||cueDigest(body.raw)!==body.retainedSha256||
    channel==='intent'&&(body.resultSha256!==body.retainedSha256||cueDigest(normalizeCompletedProviderResult(channel,body.raw,op))!==cueDigest(body.normalized))||
    /https?:\/\//i.test(JSON.stringify(body))||
    body.spendingAuthorized!==false||body.cueEligible!==false)fail('RESULT_RECONCILIATION_RECORD_HOLD');
   const view={stage:channel,requestId:stage.requestId,state:'RESULT_SAVED',resultAsset:{assetId:resultId,sha256:record.sha256}};
   if(channel!=='intent'){
    const mediaId='reconciled-media-'+cueDigest(binding).slice(0,46);let media=await saved(mediaId,binding);
    if(!media){
     if(!downloadURL){const raw=await read('result');await facts(input,first.fingerprint);
      if(cueDigest(raw)!==body.resultSha256||cueDigest(withoutLocations(raw))!==body.retainedSha256)fail('RESULT_RECONCILIATION_PROVIDER_RESULT_CHANGED');
      downloadURL=normalizeCompletedProviderResult(channel,raw,op).url;}
     await facts(input,first.fingerprint);const bytes=await mediaBytes(downloadURL,channel);downloadURL=undefined;await facts(input,first.fingerprint);
     await assetStore.save({id:mediaId,bytes,contentType:channel==='music'?'audio/wav':'video/mp4',binding,
      provenance:{kind:'provider-result-reconciliation',operationId:op.operationId,requestId:stage.requestId,
       resultSha256:body.resultSha256,sourceSha256:op.permit.sourceSha256,modelId:GENERATION_CONTRACT[channel],actualGenerationThisRun:true}});
     await facts(input,first.fingerprint);media=await saved(mediaId,binding);}
    view.mediaAsset={assetId:media.assetId,sha256:media.sha256};view.state='MEDIA_SAVED';
    if(typeof inspectMedia==='function')try{
     await facts(input,first.fingerprint);
     const measurement=await inspectMedia({channel,bytes:media.bytes,operation:op,inputDigest:cueDigest(binding)});
     await facts(input,first.fingerprint);const qcId='reconciled-qc-'+cueDigest({binding,sha256:media.sha256}).slice(0,48);
     const bytes=new TextEncoder().encode(JSON.stringify({version:'local-reconciled-qc-v1',binding,rawSha256:media.sha256,
      measurement,spendingAuthorized:false,cueEligible:false}));if(bytes.length>65536)fail('RESULT_RECONCILIATION_RECORD_SIZE_HOLD');
     const qc=await assetStore.save({id:qcId,bytes,contentType:'application/json',binding,
      provenance:{kind:'local-reconciled-qc',operationId:op.operationId,requestId:stage.requestId,sourceSha256:op.permit.sourceSha256}});
     await facts(input,first.fingerprint);view.localQC={assetId:qc.assetId,sha256:qc.sha256};view.state='LOCAL_QC_INSPECTED';
    }catch(e){view.localQCHold=/^[A-Z][A-Z0-9_]{0,99}$/.test(e?.message??'')?e.message:'LOCAL_QC_HOLD';}
   }
   result.push(view);
  }
  await facts(input,first.fingerprint);
  return {operationId:input.operationId,state:'RECONCILED_RESULTS',results:result,spendingAuthorized:false,cueEligible:false,actualPlayback:false};
 }
 return Object.freeze({reconcile(input){active();if(!input||Object.keys(input).sort().join(',')!=='operationId,ownerCapability,roomId'||
   !id(input.roomId)||!id(input.operationId)||!sha(input.ownerCapability))fail('RESULT_RECONCILIATION_IDS_ONLY');
  const key=cueDigest(input);if(!pending.has(key)){const task=reconcile({...input}).finally(()=>pending.delete(key));pending.set(key,task);}
  return pending.get(key).then(x=>structuredClone(x));},close(){closed=true;for(const c of controllers)c.abort();}});
}
