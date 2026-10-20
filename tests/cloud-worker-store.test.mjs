import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateStore} from '../cloud/worker/private-store.mjs';
import {fixtureSha,syntheticWave} from './cloud-worker-fixture.mjs';
import {contextWave,decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {syntheticStorageTransport} from './cloud-worker-store-fixture.mjs';
import {INGESTION_RECEIPT_VERSION} from '../cloud/worker/private-ingestion.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import {cueDigest} from '../snapshot/app/runtime/intent-compiler.mjs';

const roomId='fixture-storage-room',bootstrap={kind:'owner-supplied-bootstrap'};
const holds=(promise,reason)=>assert.rejects(promise,e=>e.code==='PRIVATE_STORE_HOLD'&&e.holdReason===reason);
test('private store stays disabled and verifies configured approval target through injected host only',async()=>{
  const fixture=syntheticStorageTransport(),store=createPrivateStore({roomId,transport:fixture.transport});
  await holds(store.assetStore.read('anything'),'PRIVATE_STORE_NOT_ACTIVATED');assert.equal(fixture.calls.length,0);
  const active=createPrivateStore({enabled:true,roomId,transport:fixture.transport});fixture.config.public=true;
  await holds(active.assetStore.save({id:'fixture',bytes:Buffer.from('one'),contentType:'audio/wav',binding:bootstrap}),'PRIVATE_BUCKET_CONFIGURATION_MISMATCH');
  assert.equal(fixture.objects.size,0);fixture.config.public=false;fixture.config.allowedMimeTypes.reverse();
  assert.equal((await active.assetStore.save({id:'fixture',bytes:Buffer.from('one'),contentType:'audio/wav',binding:bootstrap})).byteLength,3);
  store.close();active.close();
});
test('immutable physical bytes and sealed metadata survive adapter restart with room binding and provenance',async()=>{
  const fixture=syntheticStorageTransport(),options={enabled:true,roomId,transport:fixture.transport};
  const first=createPrivateStore(options),bytes=Buffer.from('synthetic'),binding={roomId,channel:'music'};
  const input={id:'fixture-audio',bytes,contentType:'audio/wav',binding,provenance:{kind:'provider',requestId:'fixture-request'}};
  const saved=await first.assetStore.save(input);assert.equal(saved.sha256,fixtureSha(bytes));first.close();
  const second=createPrivateStore(options),record=await second.assetStore.read(input.id);
  assert.equal(record.sha256,saved.sha256);assert.deepEqual(record.provenance,input.provenance);
  assert.equal((await second.assetStore.verifySaved({binding,asset:{assetId:input.id,sha256:saved.sha256}})).checksumVerified,true);
  await second.assetStore.save(input);
  await holds(second.assetStore.save({...input,bytes:Buffer.from('replacement')}),'PRIVATE_STORE_IMMUTABLE_CONFLICT');
  await holds(second.assetStore.save({...input,provenance:{kind:'provider',requestId:'other-request'}}),'PRIVATE_STORE_IMMUTABLE_CONFLICT');
  const media=[...fixture.objects].find(([path])=>path.endsWith('.media'))[1];media.bytes[0]^=1;
  await holds(second.assetStore.read(input.id),'PRIVATE_ASSET_PHYSICAL_SHA_MISMATCH');second.close();
});
test('separate room namespaces, anonymous paths and metadata reject cross-room assets, paths and credentials',async()=>{
  const fixture=syntheticStorageTransport(),a=createPrivateStore({enabled:true,roomId,transport:fixture.transport});
  await a.assetStore.save({id:'owner-seed',bytes:Buffer.from('fixture'),contentType:'audio/wav',binding:bootstrap,provenance:bootstrap});
  const b=createPrivateStore({enabled:true,roomId:'other-room',transport:fixture.transport});
  await holds(b.assetStore.read('owner-seed'),'PRIVATE_ASSET_RECORD_REQUIRED');
  await holds(b.assetStore.save({id:'owner-seed',bytes:Buffer.from('fixture'),contentType:'audio/wav',binding:{roomId}}),'PRIVATE_STORE_ROOM_BINDING_REQUIRED');
  for(const id of ['../private','https://example.invalid','/tmp/path'])await holds(a.assetStore.read(id),'PRIVATE_ASSET_ID_REQUIRED');
  await holds(a.assetStore.save({id:'bad',bytes:Buffer.from('fixture'),contentType:'audio/wav',binding:bootstrap,
    provenance:{kind:'owner-supplied-bootstrap',url:'https://example.invalid/private'}}),'PRIVATE_STORE_SAFE_METADATA_REQUIRED');
  assert.equal(fixture.calls.some(c=>c.path?.includes(roomId)),false);a.close();b.close();
});
test('host transport must return a bounded stream; false headers and unbounded allocation APIs fail closed',async()=>{
  const fixture=syntheticStorageTransport(),options={enabled:true,roomId,transport:fixture.transport};
  const seed=createPrivateStore(options);await seed.assetStore.save({id:'fixture',bytes:Buffer.from('bytes'),contentType:'audio/wav',binding:bootstrap});seed.close();
  let cancelled=false;
  const tooLarge=createPrivateStore({...options,transport:{...fixture.transport,readObject:async()=>({contentType:'application/json',contentLength:5,
    body:new ReadableStream({start(c){c.enqueue(Buffer.alloc(65537));},cancel(){cancelled=true;}})})}});
  await holds(tooLarge.assetStore.read('fixture'),'PRIVATE_STORE_OBJECT_TOO_LARGE');assert.equal(cancelled,true);tooLarge.close();
  const blobOnly=createPrivateStore({...options,transport:{...fixture.transport,readObject:async()=>({bytes:Buffer.alloc(3),contentType:'application/json'})}});
  await holds(blobOnly.assetStore.read('fixture'),'PRIVATE_STORE_BOUNDED_STREAM_REQUIRED');blobOnly.close();
  const stalled=createPrivateStore({...options,timeoutMs:15,transport:{...fixture.transport,readObject:async()=>({contentType:'application/json',body:new ReadableStream({start(){}})})}});
  await holds(stalled.assetStore.read('fixture'),'PRIVATE_STORE_READ_TIMEOUT');stalled.close();
});
test('private source snapshots bind actual context bytes and retain owner origin across restart',async()=>{
  const fixture=syntheticStorageTransport(),store=createPrivateStore({enabled:true,roomId,transport:fixture.transport});
  const parent=syntheticWave(24),context=contextWave(decodeCompleteWave(parent)),reference=Buffer.from([137,80,78,71,13,10,26,10]);
  for(const [id,bytes,contentType] of [['parent',parent,'audio/wav'],['context',context,'audio/wav'],['reference',reference,'image/png']])
    await store.assetStore.save({id,bytes,contentType,binding:bootstrap,provenance:bootstrap});
  const source={audioAssetId:'parent',contextAssetId:'context',referenceAssetId:'reference',
    music:{clipId:'seed',sha256:fixtureSha(parent),contextSha256:fixtureSha(context),contextSeconds:16,contextVerified:true,ready:true,
      control:{version:1,energy:.4,tension:.3,density:.3,brightness:.45},profile:{assetSha256:fixtureSha(parent),key:{confidence:'unknown'}}},
    video:{motifId:'fixture-reference',motifSnapshotSha256:'a'.repeat(64),referenceSha256:fixtureSha(reference)},quality:{fixedBpm:145},
    playback:{phase:'IDLE',revision:0,playedUntilFrame:0,actual:false}};
  const evidence={kind:'verified-source-context-v1',roomId,originKind:'owner-supplied-bootstrap',parentAssetId:'parent',parentSha256:source.music.sha256,
    contextAssetId:'context',contextSha256:source.music.contextSha256,referenceAssetId:'reference',referenceSha256:source.video.referenceSha256,
    contextSeconds:16,serverAudioQC:true};
  const saved=await store.sourceStore.save({source,sourceEvidence:evidence});store.close();
  const resumed=createPrivateStore({enabled:true,roomId,transport:fixture.transport});
  assert.deepEqual((await resumed.sourceStore.read(saved.sourceId)).source,source);
  assert.deepEqual(await resumed.readSourceEvidence({roomId,source}),evidence);
  const contextObject=[...fixture.objects].find(([path])=>path.endsWith('/context.media'))[1];contextObject.bytes[44]^=1;
  await assert.rejects(resumed.readSourceEvidence({roomId,source}),/PRIVATE_STORE/);resumed.close();
});
test('false write success and sealed metadata tampering cannot create a private save proof',async()=>{
  const fixture=syntheticStorageTransport(),store=createPrivateStore({enabled:true,roomId,transport:{...fixture.transport,putObjectIfAbsent:async()=>({success:true})}});
  await holds(store.assetStore.save({id:'fixture',bytes:Buffer.from('fixture'),contentType:'audio/wav',binding:bootstrap}),'PRIVATE_ASSET_PHYSICAL_SHA_MISMATCH');store.close();
  const working=createPrivateStore({enabled:true,roomId,transport:fixture.transport});
  await working.assetStore.save({id:'fixture',bytes:Buffer.from('fixture'),contentType:'audio/wav',binding:bootstrap});
  const metadata=[...fixture.objects].find(([path])=>path.endsWith('.json'))[1],record=JSON.parse(metadata.bytes);
  record.provenance={kind:'provider'};metadata.bytes=Buffer.from(JSON.stringify(record));
  await holds(working.assetStore.read('fixture'),'PRIVATE_STORE_RECORD_CHANGED');working.close();
});
test('partial upload restart repairs missing metadata without replacing an immutable raw object',async()=>{
  const fixture=syntheticStorageTransport(),input={id:'fixture',bytes:Buffer.from('immutable bytes'),contentType:'audio/wav',binding:bootstrap};
  const first=createPrivateStore({enabled:true,roomId,transport:{...fixture.transport,
    putObjectIfAbsent:async request=>{if(request.path.endsWith('.json'))throw Error('fixture interrupted metadata save');return fixture.transport.putObjectIfAbsent(request);}}});
  await holds(first.assetStore.save(input),'PRIVATE_STORE_FAILED');assert.equal(fixture.objects.size,1);first.close();
  const original=[...fixture.objects.values()][0].bytes,second=createPrivateStore({enabled:true,roomId,transport:fixture.transport});
  await holds(second.assetStore.read(input.id),'PRIVATE_ASSET_RECORD_REQUIRED');
  assert.equal((await second.assetStore.save(input)).sha256,fixtureSha(input.bytes));assert.equal(fixture.objects.size,2);
  assert.equal([...fixture.objects.values()][0].bytes,original);second.close();
});
test('concurrent conflicting metadata has one immutable winner, including identical physical bytes',async()=>{
  const fixture=syntheticStorageTransport(),store=createPrivateStore({enabled:true,roomId,transport:fixture.transport});
  const base={id:'shared',bytes:Buffer.from('same fixture bytes'),contentType:'audio/wav',binding:{roomId,channel:'music'}};
  const results=await Promise.allSettled(['first','second'].map(requestId=>store.assetStore.save({...base,provenance:{kind:'provider',requestId}})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.holdReason,'PRIVATE_STORE_IMMUTABLE_CONFLICT');
  const stored=await store.assetStore.read(base.id);
  assert.equal(stored.provenance.requestId,results.find(x=>x.status==='fulfilled').value.provenance.requestId);store.close();
});
test('private receipt reference survives restart and cannot cross rooms or replace its request association',async()=>{
  const fixture=syntheticStorageTransport(),options={enabled:true,roomId,transport:fixture.transport},first=createPrivateStore(options);
  const operationId='fixture-operation',binding={roomId,submissionId:'fixture-submission',generationId:'fixture-generation',
    commonIntentSha256:'a'.repeat(64),controlVersion:2,channel:'music'};
  const body={version:INGESTION_RECEIPT_VERSION,roomId,operationId,channel:'music',assetId:'fixture-audio',kind:'provider',
    sha256:'b'.repeat(64),byteLength:7,contentType:'audio/wav',binding,requestId:'fixture-request',resultSha256:'c'.repeat(64),
    sourceSha256:'d'.repeat(64),modelId:GENERATION_CONTRACT.music,descriptorSha256:'e'.repeat(64),sourceEvidenceSha256:'f'.repeat(64)};
  const receipt={...body,receiptSha256:cueDigest(body)};await first.receiptStore.saveImmutable(receipt);first.close();
  const next=createPrivateStore(options);assert.deepEqual(await next.receiptStore.read({roomId,operationId,channel:'music'}),receipt);
  const replacement={...body,requestId:'different-request'};
  await assert.rejects(next.receiptStore.saveImmutable({...replacement,receiptSha256:cueDigest(replacement)}),/REFERENCE_CHANGED/);
  const other=createPrivateStore({...options,roomId:'other-room'});
  await holds(other.receiptStore.read({roomId,operationId,channel:'music'}),'PRIVATE_STORE_ROOM_BINDING_REQUIRED');other.close();next.close();
});
test('metadata configuration and upload calls also have a bounded host deadline',async()=>{
  const fixture=syntheticStorageTransport(),hanging=()=>new Promise(()=>{});
  for(const operation of ['describeBucket','putObjectIfAbsent']) {
    const store=createPrivateStore({enabled:true,roomId,timeoutMs:15,transport:{...fixture.transport,[operation]:hanging}});
    await holds(store.assetStore.save({id:'fixture',bytes:Buffer.from('bytes'),contentType:'audio/wav',binding:bootstrap}),'PRIVATE_STORE_TRANSPORT_TIMEOUT');store.close();
  }
});
