import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateMediaIngestion,createImmutableIngestionReceiptStore} from '../cloud/worker/private-ingestion.mjs';
import {contextWave,decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {generationIdentity} from '../cloud/generation/dispatch.mjs';
import {operationBinding} from '../cloud/generation/cue-contract.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
import {createSyntheticPrivateStore,fixtureSha,syntheticWave} from './cloud-worker-fixture.mjs';
import {createPortableCloudWorker} from '../cloud/worker/portable-worker.mjs';

const roomId='fixture-room',operationId='fixture-ingestion-operation',key={roomId,operationId};
const parentBytes=syntheticWave(24),contextBytes=contextWave(decodeCompleteWave(parentBytes));
const referenceBytes=Buffer.from([137,80,78,71,13,10,26,10]);
async function fixture(extra={}) {
  const store=createSyntheticPrivateStore(),receiptRecords=new Map(),operations=new Map();let calls=0;
  const bootstrap={kind:'owner-supplied-bootstrap'};
  for(const [id,bytes] of [['parent',parentBytes],['context',contextBytes],['reference',referenceBytes]])
    await store.save({id,bytes,binding:bootstrap,provenance:bootstrap});
  const source={audioAssetId:'parent',contextAssetId:'context',referenceAssetId:'reference',
    music:{clipId:'seed-fixture',sha256:fixtureSha(parentBytes),contextSha256:fixtureSha(contextBytes),contextSeconds:16,
      contextVerified:true,ready:true,control:{version:1,energy:.4,tension:.3,density:.3,brightness:.45},
      profile:{method:'pcm-endpoint-profile-v1',assetSha256:fixtureSha(parentBytes),sampleRate:44100,channels:2,frameCount:24*44100}},
    video:{motifId:'fixture-reference',referenceSha256:fixtureSha(referenceBytes),motifSnapshotSha256:'d'.repeat(64)},
    quality:{fixedBpm:145},playback:{phase:'IDLE',revision:0,playedUntilFrame:0,actual:false}};
  const op={roomId,operationId,submissionId:'fixture-submission',dispatchAllowed:true,stopped:false,
    permit:{source,sourceSha256:cueDigest(cueSourceIdentity(source)),visualPolicy:TECHNICAL_VISUAL_POLICY,
      assets:{context:{providerOriginVerified:true}}},
    plan:{status:'COMPILED',commonIntentSha256:'a'.repeat(64),common:{cueId:generationIdentity(operationId).cueId,control:{version:2}}},
    stages:{music:{state:'COMPLETE',requestId:'fixture-music-request',result:{url:'https://v3.fal.media/synthetic.wav?fixture=private',
      contentType:'audio/wav',providerObserved:true,resultSha256:'b'.repeat(64)}},
      video:{state:'COMPLETE',requestId:'fixture-video-request',result:{url:'https://v3.fal.media/synthetic.mp4',
        contentType:'video/mp4',providerObserved:true,resultSha256:'c'.repeat(64)}}}};
  operations.set(operationId,op);
  const proof={kind:'verified-source-context-v1',roomId,originKind:'owner-supplied-bootstrap',parentAssetId:'parent',
    parentSha256:source.music.sha256,contextAssetId:'context',contextSha256:source.music.contextSha256,
    referenceAssetId:'reference',referenceSha256:source.video.referenceSha256,contextSeconds:16,serverAudioQC:true};
  const receiptStore=createImmutableIngestionReceiptStore({readRecord:async({id})=>structuredClone(receiptRecords.get(id)),
    putIfAbsent:async({id,record})=>{if(!receiptRecords.has(id))receiptRecords.set(id,structuredClone(record));}});
  const options={enabled:true,readOperation:async({operationId})=>operations.get(operationId),assetStore:store,receiptStore,
    readSourceEvidence:async()=>proof,fetchImpl:async(url,init)=>{
      calls++;assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.method,'GET');
      assert.equal('headers' in init,false);assert(init.signal instanceof AbortSignal);
      return new Response(Buffer.from(url.includes('.wav')?'synthetic-audio':'synthetic-video'),
        {headers:{'Content-Type':url.includes('.wav')?'audio/wav':'video/mp4'}});
    },...extra};
  return {store,op,source,proof,operations,receiptStore,receiptRecords,options,
    get calls(){return calls;},ingestion:createPrivateMediaIngestion(options)};
}
const holds=(promise,reason)=>assert.rejects(promise,error=>error.code==='PRIVATE_INGESTION_HOLD'&&error.holdReason===reason);

test('private ingestion defaults disabled and accepts only authoritative room/operation IDs',async()=>{
  const f=await fixture({enabled:false});
  await holds(f.ingestion.prepareMedia(key),'PRIVATE_INGESTION_NOT_ACTIVATED');assert.equal(f.calls,0);
  const active=createPrivateMediaIngestion({...f.options,enabled:true});
  await holds(active.prepareMedia({...key,url:'https://attacker.invalid'}),'PRIVATE_INGESTION_IDS_ONLY');
  await holds(active.readOperation({...key,qc:{passed:true}}),'PRIVATE_INGESTION_IDS_ONLY');
  assert.equal(f.calls,0);await active.close();await f.ingestion.close();
});
test('bounded media becomes immutable private IDs; seed origin and base SQL result stay honest and unchanged',async()=>{
  const f=await fixture(),before=structuredClone(f.op);
  const [a,b]=await Promise.all([f.ingestion.prepareMedia(key),f.ingestion.prepareMedia(key)]);
  assert.equal(a.status,'PRIVATE_MEDIA_READY');assert.deepEqual(a,b);assert.equal(f.calls,2);
  assert.equal(a.sourceEvidence.originKind,'owner-supplied-bootstrap');assert.equal(a.sourceEvidence.providerOriginVerified,false);
  assert.equal(f.op.permit.assets.context.providerOriginVerified,true);assert.deepEqual(f.op,before);
  const projection=await f.ingestion.readOperation(key);
  for(const channel of ['music','video']) {
    assert.equal('url' in projection.stages[channel].result,false);
    assert.equal(projection.stages[channel].requestId,f.op.stages[channel].requestId);
    assert.equal(projection.stages[channel].result.resultSha256,f.op.stages[channel].result.resultSha256);
    const record=await f.store.read(projection.stages[channel].result.assetId);
    assert.deepEqual(record.binding,operationBinding(roomId,f.op,channel));
    assert.equal(record.provenance.operationId,operationId);assert.equal(record.provenance.modelId.length>1,true);
  }
  assert.equal(JSON.stringify(a).includes('fal.media'),false);
  assert.equal(JSON.stringify([...f.receiptRecords.values()]).includes('fixture=private'),false);
  assert.equal(JSON.stringify([...f.store.records.values()].map(({bytes,...record})=>record)).includes('fal.media'),false);
  await f.ingestion.close();
});
test('restart resolves receipt references and physical saved bytes without another download',async()=>{
  const f=await fixture();await f.ingestion.prepareMedia(key);await f.ingestion.close();
  const second=createPrivateMediaIngestion({...f.options,fetchImpl:()=>{throw Error('NETWORK_MUST_NOT_RUN');}});
  assert.equal((await second.prepareMedia(key)).status,'PRIVATE_MEDIA_READY');
  const projection=await second.readOperation(key),raw=f.store.records.get(projection.stages.music.result.assetId);
  raw.bytes[0]^=1;await holds(second.readOperation(key),'PRIVATE_INGESTION_ASSET_CHANGED');
  await holds(second.prepareMedia(key),'PRIVATE_INGESTION_ASSET_CHANGED');raw.bytes[0]^=1;
  const receipt=[...f.receiptRecords.values()][0];receipt.requestId='tampered-request';
  await holds(second.readOperation(key),'IMMUTABLE_INGESTION_RECEIPT_REQUIRED');await second.close();
});
test('metadata projection avoids recursive media IO while physical QC still rejects corrupted bytes',async()=>{
 const f=await fixture();await f.ingestion.prepareMedia(key);
 const metadata=createPrivateMediaIngestion({...f.options,
  assetStore:{...f.store,read:async()=>assert.fail('metadata must not read whole media')},
  readSourceEvidence:async()=>assert.fail('metadata is not a physical source certificate'),
  fetchImpl:async()=>assert.fail('no provider download for metadata')});
 const op=await metadata.readOperationMetadata(key);
 assert.equal(op.ingestionSourceEvidence,undefined);assert.equal(op.stages.music.requestId,f.op.stages.music.requestId);
 const raw=f.store.records.get(op.stages.music.result.assetId);raw.bytes[0]^=1;
 const worker=createPortableCloudWorker({enabled:true,readOperation:metadata.readOperationMetadata,
  readCurrent:async()=>f.source,readVisualPlan:async()=>assert.fail('corruption must hold before visual QC'),assetStore:f.store,
  native:{inspectAudio:async()=>assert.fail('corruption must hold before decode'),inspectVideo:async()=>assert.fail('corruption must hold before decode')}});
 await assert.rejects(worker.inspectGeneration(key),e=>e.code==='PORTABLE_QC_HOLD'&&e.holdReason==='PRIVATE_ASSET_CHECKSUM_MISMATCH');
 await worker.close();await metadata.close();await f.ingestion.close();
});

test('metadata projection rejects changed receipts and observes fresh Stop and ledger changes',async()=>{
 const f=await fixture();await f.ingestion.prepareMedia(key);
 const requestId=f.op.stages.music.requestId;f.op.stages.music.requestId='different-request';
 await holds(f.ingestion.readOperationMetadata(key),'IMMUTABLE_INGESTION_REFERENCE_CHANGED');
 f.op.stages.music.requestId=requestId;f.op.stopped=true;
 await holds(f.ingestion.readOperationMetadata(key),'AUTHORITATIVE_INGESTION_OPERATION_REQUIRED');f.op.stopped=false;
 let changed=false;
 const racing=createPrivateMediaIngestion({...f.options,receiptStore:{...f.receiptStore,read:async lookup=>{
  const r=await f.receiptStore.read(lookup);if(!changed){changed=true;f.op.stages.video.requestId='changed-during-read';}return r;
 }}});
 await holds(racing.readOperationMetadata(key),'INGESTION_AUTHORITY_CHANGED');
 await racing.close();await f.ingestion.close();
});

test('provider-derived source links a prior same-room immutable receipt, not the permit delivery flag',async()=>{
  const f=await fixture({fetchImpl:async url=>new Response(url.includes('.wav')?parentBytes:Buffer.from('synthetic-video'),
    {headers:{'Content-Type':url.includes('.wav')?'audio/wav':'video/mp4'}})});
  const ready=await f.ingestion.prepareMedia(key),prior=ready.receipts[0],nextId='fixture-next-operation';
  const incoming=structuredClone(f.source);incoming.audioAssetId='incoming-parent';incoming.contextAssetId='incoming-context';
  incoming.music.clipId='incoming-parent';incoming.music.control.version=2;
  await f.store.save({id:incoming.audioAssetId,bytes:parentBytes,contentType:'audio/wav',binding:prior.binding,
    provenance:{kind:'provider',requestId:prior.requestId,resultSha256:prior.resultSha256}});
  await f.store.save({id:incoming.contextAssetId,bytes:contextBytes,contentType:'audio/wav',binding:prior.binding,
    provenance:{kind:'verified-context',parentSha256:incoming.music.sha256}});
  const next=structuredClone(f.op);next.operationId=nextId;next.plan.common.cueId=generationIdentity(nextId).cueId;
  next.plan.common.control.version=3;next.permit.source=incoming;next.permit.sourceSha256=cueDigest(cueSourceIdentity(incoming));
  f.operations.set(nextId,next);
  const proof={...f.proof,originKind:'provider',parentAssetId:incoming.audioAssetId,contextAssetId:incoming.contextAssetId,
    providerReceipt:{operationId,requestId:prior.requestId,resultSha256:prior.resultSha256}};
  const resumed=createPrivateMediaIngestion({...f.options,readSourceEvidence:async()=>proof}),nextKey={roomId,operationId:nextId};
  const prepared=await resumed.prepareMedia(nextKey);assert.equal(prepared.sourceEvidence.providerOriginVerified,true);
  assert.equal(prepared.sourceEvidence.providerReceipt.receiptSha256,prior.receiptSha256);
  // Historical operation dispatchAllowed can be false after the next source
  // becomes current; it remains legitimate immutable source-origin evidence.
  f.op.dispatchAllowed=false;assert.equal((await resumed.readOperation(nextKey)).operationId,nextId);
  proof.providerReceipt.requestId='different-origin';await holds(resumed.readOperation(nextKey),'SOURCE_PROVIDER_LINEAGE_REQUIRED');
  await resumed.close();await f.ingestion.close();
});
test('cross-room operation, stage observation, and current-context proof are independent gates',async()=>{
  for(const [mutate,reason] of [
    [f=>{f.op.roomId='other-room';},'AUTHORITATIVE_INGESTION_OPERATION_REQUIRED'],
    [f=>{f.op.dispatchAllowed=false;},'AUTHORITATIVE_INGESTION_OPERATION_REQUIRED'],
    [f=>{f.op.stages.music.result.providerObserved=false;},'AUTHORITATIVE_PROVIDER_RECEIPT_REQUIRED'],
    [f=>{f.proof.originKind='provider';},'SOURCE_PROVIDER_LINEAGE_REQUIRED'],
    [f=>{f.proof.contextSha256='f'.repeat(64);},'TRUSTED_SOURCE_CONTEXT_EVIDENCE_REQUIRED'],
    [f=>{f.proof.serverAudioQC=false;},'TRUSTED_SOURCE_CONTEXT_EVIDENCE_REQUIRED'],
  ]) {const f=await fixture();mutate(f);await holds(f.ingestion.prepareMedia(key),reason);assert.equal(f.calls,0);await f.ingestion.close();}
});
test('a physically different 16-second context holds even when supplied proof and asset checksum agree',async()=>{
  const f=await fixture(),record=f.store.records.get('context');record.bytes[44]^=1;record.sha256=fixtureSha(record.bytes);
  f.source.music.contextSha256=record.sha256;f.proof.contextSha256=record.sha256;
  f.op.permit.sourceSha256=cueDigest(cueSourceIdentity(f.source));
  await holds(f.ingestion.prepareMedia(key),'EXACT_SOURCE_CONTEXT_REQUIRED');assert.equal(f.calls,0);await f.ingestion.close();
});
test('media target validation never follows arbitrary host, credential, port, or redirected result',async()=>{
  for(const url of ['http://v3.fal.media/a','https://evil.invalid/a','https://fal.media.evil.invalid/a',
    (()=>{const u=new URL('https://v3.fal.media/a');u.username='example_user';u.password='example_password';return u.href;})(),'https://v3.fal.media:8443/a','https://v3.fal.media/a#fragment']) {
    const f=await fixture();f.op.stages.music.result.url=url;
    await holds(f.ingestion.prepareMedia(key),'PROVIDER_MEDIA_TARGET_REQUIRED');assert.equal(f.calls,0);await f.ingestion.close();
  }
  const redirected=await fixture({fetchImpl:async()=>({ok:true,redirected:true})});
  await holds(redirected.ingestion.prepareMedia(key),'PROVIDER_MEDIA_DOWNLOAD_REFUSED');await redirected.ingestion.close();
});
test('stream ceiling, declared byte length, type and timeout hold without saved receipt',async()=>{
  for(const [response,reason] of [
    [()=>new Response(Buffer.alloc(17),{headers:{'Content-Type':'audio/wav'}}),'PROVIDER_MEDIA_STREAM_TOO_LARGE'],
    [()=>new Response(Buffer.alloc(4),{headers:{'Content-Type':'audio/wav','Content-Length':'17'}}),'PROVIDER_MEDIA_SIZE_REQUIRED'],
    [()=>new Response(Buffer.alloc(4),{headers:{'Content-Type':'audio/wav','Content-Length':'8'}}),'PROVIDER_MEDIA_LENGTH_MISMATCH'],
    [()=>new Response(Buffer.alloc(4),{headers:{'Content-Type':'audio/wav','Content-Length':'no'}}),'PROVIDER_MEDIA_SIZE_REQUIRED'],
    [()=>new Response(Buffer.alloc(4),{headers:{'Content-Type':'text/html'}}),'PROVIDER_MEDIA_TYPE_REQUIRED'],
    [()=>new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'audio/wav'}}),'INGESTION_DOWNLOAD_TIMEOUT'],
  ]) {const f=await fixture({maximumBytes:16,timeoutMs:15,fetchImpl:async()=>response()});
    await holds(f.ingestion.prepareMedia(key),reason);assert.equal(f.receiptRecords.size,0);await f.ingestion.close();}
});
test('authority/result changes during retrieval cannot mint a saved-media reference',async()=>{
  let f;f=await fixture({fetchImpl:async()=>{f.op.stages.music.requestId='changed-request';
    return new Response(Buffer.from('fixture'),{headers:{'Content-Type':'audio/wav'}});}});
  await holds(f.ingestion.prepareMedia(key),'INGESTION_AUTHORITY_CHANGED');assert.equal(f.receiptRecords.size,0);
  assert.equal([...f.store.records.keys()].some(k=>k.startsWith('raw-')),false);await f.ingestion.close();
});
test('immutable reference adapter rejects replacement, write-only success and persisted URL fields',async()=>{
  const f=await fixture(),ready=await f.ingestion.prepareMedia(key),original=ready.receipts[0];
  const {receiptSha256,...body}=original,changed={...body,requestId:'different-request'};
  await assert.rejects(f.receiptStore.saveImmutable({...changed,receiptSha256:cueDigest(changed)}),/REFERENCE_CHANGED/);
  const hollow=createImmutableIngestionReceiptStore({readRecord:async()=>null,putIfAbsent:async()=>({success:true})});
  await assert.rejects(hollow.saveImmutable(original),/SAVE_REQUIRED/);
  const withURL={...body,url:'https://v3.fal.media/private'};
  await assert.rejects(f.receiptStore.saveImmutable({...withURL,receiptSha256:cueDigest(withURL)}),/RECEIPT_REQUIRED/);
  await f.ingestion.close();
});
test('transport/storage exceptions are sanitized and never surface private URLs or file paths',async()=>{
  for(const message of ['private https://v3.fal.media/token /private/path','PRIVATE_UPPERCASE_TOKEN_VALUE']) {
    const original=Object.assign(Error(message),{privateDetail:message});
    const f=await fixture({fetchImpl:async()=>{throw original;}});
    await assert.rejects(f.ingestion.prepareMedia(key),error=>{
      assert.equal(error.code,'PRIVATE_INGESTION_HOLD');assert.equal(error.holdReason,'PRIVATE_INGESTION_FAILED');
      assert.equal(error.cause,original);assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(error)),'cause'),false);return true;
    });assert.equal(f.receiptRecords.size,0);await f.ingestion.close();
  }
});
test('partial ingestion recovers one immutable stage and downloads only the missing channel',async()=>{
  const f=await fixture();let failVideo=true,requests=[];
  const replay=async(url,init)=>{requests.push(url.endsWith('.mp4')?'video':'music');
    if(failVideo&&url.endsWith('.mp4'))throw Error('synthetic interrupted download');return f.options.fetchImpl(url,init);};
  const first=createPrivateMediaIngestion({...f.options,fetchImpl:replay});
  await holds(first.prepareMedia(key),'PRIVATE_INGESTION_FAILED');assert.equal(f.receiptRecords.size,1);await first.close();
  failVideo=false;const second=createPrivateMediaIngestion({...f.options,fetchImpl:replay});
  assert.equal((await second.prepareMedia(key)).status,'PRIVATE_MEDIA_READY');
  assert.deepEqual(requests,['music','video','video']);assert.equal(f.receiptRecords.size,2);
  await second.close();await f.ingestion.close();
});
