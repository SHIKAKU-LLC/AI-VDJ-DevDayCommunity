import test from 'node:test';
import assert from 'node:assert/strict';
import {generationIdentity} from '../cloud/generation/dispatch.mjs';
import {buildVerifiedCue} from '../cloud/generation/cue-contract.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {evaluateTransition,transitionDigest} from '../snapshot/app/runtime/dj-transition-selector.mjs';
import {createSyntheticCloudWorkerFixture} from './cloud-worker-fixture.mjs';
import {createPrivateMediaIngestion} from '../cloud/worker/private-ingestion.mjs';
import {createPrivateStore} from '../cloud/worker/private-store.mjs';
import {syntheticStorageTransport} from './cloud-worker-store-fixture.mjs';

const rate=44100;
test('private synthetic assets traverse native cloud QC, full timeline, exact render, and fail closed on ledger/source mutation',
  {skip:!process.env.VDJ_QC_PYTHON},async t=>{
  let fixture,worker,current,op,ledgerReads=0;
  const roomId='synthetic-room',operationId='synthetic-cloud-operation';
  try {
    fixture=await createSyntheticCloudWorkerFixture({roomId,
      runtime:{python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'},
      readOperation:async()=>{ledgerReads++;return op;}});
    worker=fixture.worker;current=fixture.source;const store=fixture.store;
    const identity=generationIdentity(operationId);
    op=await fixture.projectOperation({roomId,operationId,submissionId:'synthetic-submission',stopped:false,dispatchAllowed:true,
      permit:{source:structuredClone(current),sourceSha256:cueDigest(cueSourceIdentity(current)),visualPolicy:TECHNICAL_VISUAL_POLICY},
      plan:{status:'COMPILED',commonIntentSha256:'a'.repeat(64),common:{cueId:identity.cueId,control:{version:2}}},
      stages:{music:{state:'COMPLETE',requestId:'fixture-audio-request',result:{resultSha256:'b'.repeat(64)}},
        video:{state:'COMPLETE',requestId:'fixture-video-request',result:{resultSha256:'c'.repeat(64)}}}});
    await t.test('caller verdict cannot substitute for authoritative bytes, receipt and native QC',async()=>{
      const evidence=await worker.inspectGeneration({roomId,operation:{operationId,stages:{},qc:{passed:true}}});
      assert.equal(evidence.music.durationSeconds,24);assert.equal(evidence.music.contextVerified,true);
      assert.equal(evidence.video.timeline.durationSeconds,24);assert.equal(evidence.video.clips[0].durationSeconds,5);
      assert.equal(evidence.video.review.kind,'technical-qc');assert.equal(evidence.video.review.ownerArtisticApproval,false);
      const cue=buildVerifiedCue({roomId,operation:op,evidence}),source=await worker.readCurrent(roomId);
      const receipt=await worker.inspectJoin({current:source,candidate:cue});
      const plan=evaluateTransition({current:source,candidate:cue,pairQC:receipt,mode:'provider'});
      assert.equal(plan.status,'ELIGIBLE');
      const descriptor=await worker.describeRender({roomId,cue,plan,expectedRevision:1});
      assert.equal(descriptor.mimeType,'audio/wav');assert.equal(descriptor.sha256,receipt.renderedSha256);
      assert.equal(descriptor.durationFrames,48*rate);assert.equal(descriptor.startFrame,24*rate);
      assert.equal(descriptor.renderedPcmSha256.length,64);assert.equal('pcm' in descriptor,false);
      const [first,second]=await Promise.all([worker.processJob({roomId,operationId}),worker.processJob({roomId,operationId})]);
      assert.equal(first.status,'QC_READY');assert.deepEqual(first,second);assert(ledgerReads>=8);
    });
    await t.test('published cue and runtime metadata do not mutate the immutable generation fingerprint',async()=>{
      op.cue={cueId:identity.cueId,status:'READY'};op.roomRuntime={revision:1};
      assert.equal((await worker.processJob({roomId,operationId})).status,'QC_READY');
    });
    await t.test('changed ledger prevents cached evidence from being returned',async()=>{
      op.stages.music.requestId='changed-audio-request';
      assert.deepEqual((await worker.processJob({roomId,operationId})).reasons,['AUTHORITATIVE_OPERATION_CHANGED']);
      op.stages.music.requestId='fixture-audio-request';
    });
    await t.test('cached measurements cannot authorize mutated raw or saved manifest bytes',async()=>{
      const evidence=await worker.inspectGeneration({roomId,operationId});
      for(const assetId of [op.stages.music.result.assetId,evidence.video.asset.assetId]) {
        const record=store.records.get(assetId);record.bytes[0]^=1;
        assert.deepEqual((await worker.processJob({roomId,operationId})).reasons,['PRIVATE_ASSET_CHECKSUM_MISMATCH']);
        record.bytes[0]^=1;
      }
    });
    await t.test('changed playback source invalidates generation and join',async()=>{
      current.playback.revision++;
      assert.deepEqual((await worker.processJob({roomId,operationId})).reasons,['PROTOTYPE_SOURCE_CHANGED']);
      assert.equal(await worker.inspectJoin({current:await worker.readCurrent(roomId),candidate:{cueId:identity.cueId}}),null);
      current.playback.revision--;
    });
    await t.test('corrupt stored render cannot be described even if record claims checksum verified',async()=>{
      const evidence=await worker.inspectGeneration({roomId,operationId}),cue=buildVerifiedCue({roomId,operation:op,evidence});
      const source=await worker.readCurrent(roomId),receipt=await worker.inspectJoin({current:source,candidate:cue});
      const plan=evaluateTransition({current:source,candidate:cue,pairQC:receipt,mode:'provider'}),render=await worker.readRender({cue});
      store.records.get(render.assetId).bytes[44]^=1;
      await assert.rejects(worker.describeRender({roomId,cue,plan,expectedRevision:1}),/CHECKSUM_MISMATCH/);
      assert.equal(await worker.inspectJoin({current:source,candidate:cue}),null);
      assert.deepEqual((await worker.processJob({roomId,operationId})).reasons,['PRIVATE_ASSET_CHECKSUM_MISMATCH']);
    });
  } finally {await fixture?.cleanup();}
});
test('synthetic 1366x768/24fps replay goes through durable private source/ingestion before native AV QC and exact render',
  {skip:!process.env.VDJ_QC_PYTHON},async t=>{
  const roomId='ingestion-native-room',operationId='ingestion-native-operation',objects=syntheticStorageTransport();let fixture,ingestion,op,privateStore;
  try {
    const setupStarted=performance.now();
    privateStore=createPrivateStore({enabled:true,roomId,transport:objects.transport});
    fixture=await createSyntheticCloudWorkerFixture({roomId,
      assetStore:privateStore.assetStore,
      videoFixture:{width:1366,height:768,fps:24},
      runtime:{python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'},
      readOperation:input=>ingestion.readOperation(input)});
    const setupMs=Math.round(performance.now()-setupStarted),source=fixture.source,identity=generationIdentity(operationId);
    op={roomId,operationId,submissionId:'ingestion-synthetic-submission',stopped:false,dispatchAllowed:true,
      permit:{source,sourceSha256:cueDigest(cueSourceIdentity(source)),visualPolicy:TECHNICAL_VISUAL_POLICY},
      plan:{status:'COMPILED',commonIntentSha256:'a'.repeat(64),common:{cueId:identity.cueId,control:{version:2}}},
      stages:{music:{state:'COMPLETE',requestId:'ingestion-audio-request',result:{url:'https://v3.fal.media/synthetic.wav',
        contentType:'audio/wav',providerObserved:true,resultSha256:'b'.repeat(64)}},
        video:{state:'COMPLETE',requestId:'ingestion-video-request',result:{url:'https://v3.fal.media/synthetic.mp4',
          contentType:'video/mp4',providerObserved:true,resultSha256:'c'.repeat(64)}}}};
    await privateStore.sourceStore.save({source,sourceEvidence:await fixture.readSourceEvidence()});
    const options={enabled:true,readOperation:async()=>op,assetStore:privateStore.assetStore,
      receiptStore:privateStore.receiptStore,readSourceEvidence:privateStore.readSourceEvidence,fetchImpl:fixture.fetchProviderFixture};
    const ingestionStarted=performance.now();
    ingestion=createPrivateMediaIngestion(options);await ingestion.prepareMedia({roomId,operationId});
    await ingestion.close(); // Durable asset/receipt adapters survive a worker restart.
    ingestion=createPrivateMediaIngestion({...options,fetchImpl:()=>{throw Error('UNEXPECTED_DOWNLOAD_AFTER_RESTART');}});
    const projected=await ingestion.readOperation({roomId,operationId});
    assert.equal('url' in projected.stages.music.result,false);assert.equal([...objects.objects.keys()].filter(path=>path.includes('/receipts/')).length,2);
    const ingestionMs=Math.round(performance.now()-ingestionStarted),qcStarted=performance.now();
    const result=await fixture.worker.processJob({roomId,operationId});assert.equal(result.status,'QC_READY',JSON.stringify(result.reasons));
    const qcMs=Math.round(performance.now()-qcStarted),measurement=result.evidence.video.compositionQC.clips[0].measurement;
    assert.equal(measurement.width,1366);assert.equal(measurement.height,768);assert.equal(measurement.decodedFrames,120);
    assert.equal(measurement.fullyDecoded,true);assert.equal(measurement.durationSeconds,5);
    const cue=buildVerifiedCue({roomId,operation:op,evidence:result.evidence});
    assert.equal(cue.music.durationSeconds,24);assert.equal(cue.video.timeline.durationSeconds,24);
    assert.equal(cue.video.clips[0].durationSeconds,5);assert.equal(op.stages.music.result.url,'https://v3.fal.media/synthetic.wav');
    const current=await fixture.worker.readCurrent(roomId),receipt=await fixture.worker.inspectJoin({current,candidate:cue});
    const plan=evaluateTransition({current,candidate:cue,pairQC:receipt,mode:'provider'});assert.equal(plan.status,'ELIGIBLE');
    const render=await fixture.worker.describeRender({roomId,cue,plan,expectedRevision:1});
    assert.equal(render.durationFrames,48*rate);assert.equal(render.startFrame,24*rate);
    t.diagnostic(JSON.stringify({kind:'local-Mac-synthetic-only',width:1366,height:768,fps:24,decodedFrames:120,
      setupMs,privateIngestionMs:ingestionMs,nativeAvQcMs:qcMs,renderFrames:render.durationFrames,
      constrainedLinuxContainerVerified:false}));
  } finally {await ingestion?.close();await fixture?.cleanup();privateStore?.close();}
});

test('two generated siblings use a fresh CURRENT pair render and reconstruct the ACKed72s queue',
 {skip:!process.env.VDJ_QC_PYTHON},async()=>{
 const {createProductionPlayerMaterial}=await import('../cloud/worker/player-material.mjs');
 const {contextWave,decodeCompleteWave}=await import('../integration/runtime/bootstrap.mjs');
 const {fixtureSha}=await import('./cloud-worker-fixture.mjs');
 const roomId='synthetic-pair-room',operations=new Map();let current,seed,fixture,material,currentReads=0;
 try{
  fixture=await createSyntheticCloudWorkerFixture({roomId,persistRenderRecords:true,
   runtime:{python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'},
   readOperation:async i=>operations.get(i.operationId),readCurrent:async()=>{currentReads++;return current;},readGenerationSource:async()=>structuredClone(seed)});
  seed=structuredClone(fixture.source);current=structuredClone(seed);const {worker,store}=fixture,cues=[];
  for(const n of [1,2]){
   const operationId='synthetic-pair-operation-'+n,identity=generationIdentity(operationId);
   const op=await fixture.projectOperation({roomId,operationId,submissionId:'synthetic-submission-'+n,stopped:false,dispatchAllowed:true,
    permit:{source:structuredClone(seed),sourceSha256:cueDigest(cueSourceIdentity(seed)),visualPolicy:TECHNICAL_VISUAL_POLICY},
    plan:{status:'COMPILED',commonIntentSha256:String(n).repeat(64),common:{cueId:identity.cueId,control:{version:2}}},
    stages:{music:{state:'COMPLETE',requestId:'synthetic-audio-'+n,result:{resultSha256:'b'.repeat(64)}},
     video:{state:'COMPLETE',requestId:'synthetic-video-'+n,result:{resultSha256:'c'.repeat(64)}}}});
   operations.set(operationId,op);cues.push(buildVerifiedCue({roomId,operation:op,evidence:await worker.inspectGeneration({roomId,operationId})}));
  }
  const original=await worker.readRender({roomId,cue:cues[0]}),preCurrentReads=currentReads;
  const prepared=await worker.preparePlaybackCandidate({roomId,candidate:cues[0]});
  assert.equal(currentReads,preCurrentReads,'immutable preparation does not manufacture a live source observation');
  const firstCurrent=await worker.readCurrent(roomId),firstReceipt=await worker.inspectJoin({roomId,current:firstCurrent,candidate:cues[0]});
  assert.equal(firstReceipt.type,'measured-nonoverlap-cut');assert.equal(firstReceipt.exitFrame,24*rate);
  assert.equal(firstReceipt.nativeContinuationVerified,false,'endpoint cut carries only its independent native measurement');
  const late={...firstCurrent,playedUntilFrame:23*rate};
  const endpointPlan=evaluateTransition({current:late,candidate:cues[0],pairQC:firstReceipt,mode:'provider'});
  assert.equal(endpointPlan.status,'ELIGIBLE','measured endpoint is still in the future at 23 seconds');
  const expired=evaluateTransition({current:{...late,playedUntilFrame:24*rate},candidate:cues[0],pairQC:firstReceipt,mode:'provider'});
  assert.notEqual(expired.status,'ELIGIBLE','preparation does not bypass the consumed frontier');
  const endpoint=await worker.readRender({roomId,cue:cues[0],plan:endpointPlan});
  assert(prepared.assets.some(a=>a.assetId===endpoint.assetId));assert.notEqual(endpoint.assetId,original.assetId);
  current.playback.revision++;
  assert.notEqual(evaluateTransition({current:await worker.readCurrent(roomId),candidate:cues[0],pairQC:firstReceipt,mode:'provider'}).status,
    'ELIGIBLE','precomputed receipt cannot authorize a changed live revision');
  current.playback.revision--;
  const firstPlan=evaluateTransition({current:firstCurrent,candidate:cues[0],pairQC:firstReceipt,mode:'provider',now:1000});assert.equal(firstPlan.status,'ELIGIBLE');
  const audio=await store.read(cues[0].music.asset.assetId),context=contextWave(decodeCompleteWave(audio.bytes));
  await store.save({id:'synthetic-current-context',bytes:context,binding:{kind:'synthetic-current'},contentType:'audio/wav'});
  current={...structuredClone(seed),audioAssetId:audio.assetId,contextAssetId:'synthetic-current-context',
   music:{...seed.music,clipId:audio.assetId,sha256:audio.sha256,contextSha256:fixtureSha(context),profile:cues[0].music.profile},
   playback:{phase:'PLAYING',revision:1,playedUntilFrame:0,actual:true}};
  const preparedParent={...structuredClone(current),playback:{phase:'IDLE',revision:0,playedUntilFrame:0,actual:false}};
  // Production 2026-10-17: an unprepared A -> B join was rendered inside the
  // B reservation (~29s). A reservation never renders; it waits for preparation.
  const pairRenders=()=>[...store.records.keys()].filter(k=>k.startsWith('pair-render-')).length,rendersBeforeMiss=pairRenders();
  assert.equal(await worker.inspectJoin({roomId,current:await worker.readCurrent(roomId),candidate:cues[1]},{measure:false}),null);
  assert.equal(pairRenders(),rendersBeforeMiss,'a reservation inspection renders no join');
  const beforePair=currentReads,pairAsset=await worker.preparePlaybackPair({roomId,candidate:cues[1],source:preparedParent,playbackRevision:1});
  assert.equal(currentReads,beforePair,'next pair preparation reads no live observation');assert(pairAsset?.assetId.startsWith('pair-render-'));
  await assert.rejects(worker.preparePlaybackPair({roomId,candidate:cues[1],source:current,playbackRevision:1}),/PAIR_PREPARATION_REQUIRED/);
  const secondCurrent=await worker.readCurrent(roomId),beforeInspect=currentReads;
  const secondReceipt=await worker.inspectJoin({roomId,current:secondCurrent,candidate:cues[1]});
  assert.equal(currentReads,beforeInspect,'prepared immutable pair adds no nested mutable reads; coordinator owns fresh commit authority');
  assert(secondReceipt);assert.equal(secondReceipt.type,'measured-nonoverlap-cut');assert.equal(secondReceipt.nativeContinuationVerified,false);
  // A reservation re-inspecting an already verified join re-reads only its small
  // record, never the immutable media bytes again (production: ~23s per join).
  {const original=store.read;let mediaReads=0;store.read=async id=>{if(!String(id).startsWith('render-record-'))mediaReads++;return original.call(store,id);};
   try{assert.deepEqual(await worker.inspectJoin({roomId,current:secondCurrent,candidate:cues[1]}),secondReceipt);}finally{store.read=original;}
   assert.equal(mediaReads,0,'verified join media are not downloaded again at reservation');}
  const secondPlan=evaluateTransition({current:secondCurrent,candidate:cues[1],pairQC:secondReceipt,mode:'provider',now:1000});
  assert.equal(secondPlan.status,'ELIGIBLE',JSON.stringify(secondPlan.reasons));assert.equal(secondPlan.transition.measuredCutVerified,true);
  // The join PCM does not depend on the playback revision: a pair prepared at
  // the base revision serves another revision of the same CURRENT bytes
  // without a second native render; only the receipt's revision is rebound.
  current.playback.revision=2;const rendersBeforeRebind=pairRenders();
  const rebound=await worker.inspectJoin({roomId,current:await worker.readCurrent(roomId),candidate:cues[1]},{measure:false});
  assert(rebound);assert.equal(pairRenders(),rendersBeforeRebind,'no second pair render');
  assert.equal(rebound.currentPlaybackRevision,2);assert.equal(rebound.renderedSha256,secondReceipt.renderedSha256);
  assert.equal(evaluateTransition({current:await worker.readCurrent(roomId),candidate:cues[1],pairQC:rebound,mode:'provider',now:1000}).status,'ELIGIBLE');
  current.playback.revision=1;
  const beforeDescribe=currentReads;
  const rendered=await worker.describeRender({roomId,cue:cues[1],plan:secondPlan,expectedRevision:2});assert.equal(rendered.durationFrames,48*rate);
  assert.equal(currentReads-beforeDescribe,1,'render verification and artifact alias use the same fresh current source');
  current.playback.playedUntilFrame=24*rate;
  await assert.rejects(worker.describeRender({roomId,cue:cues[1],plan:secondPlan,expectedRevision:2}),/CURRENT_ELIGIBLE_RENDER_PLAN_REQUIRED/);
  const beforeReserved=currentReads;
  const reserved=await worker.describeReservedRender({roomId,cue:cues[1],plan:secondPlan,expectedRevision:2});
  assert.equal(reserved.sha256,pairAsset.sha256,'actual reserved render is the preloaded pair bytes');
  assert.equal(reserved.sha256,rendered.sha256);assert.equal(currentReads,beforeReserved,
    'immutable reserved bytes do not read or create a live playback frontier');
  const savedBytes=store.records.get(reserved.assetId).bytes;
  store.records.get(reserved.assetId).bytes=Buffer.from(savedBytes);store.records.get(reserved.assetId).bytes[48]^=1;
  await assert.rejects(worker.describeReservedRender({roomId,cue:cues[1],plan:secondPlan,expectedRevision:2}),/CHECKSUM_MISMATCH/);
  assert.equal(await worker.inspectJoin({roomId,current:secondCurrent,candidate:cues[1]}),null,'cached measurement cannot authorize corrupt pair bytes');
  store.records.get(reserved.assetId).bytes=savedBytes;
  current.playback.playedUntilFrame=0;
  const scope={roomId,['sessionId']:'example-pair-epoch',controlRevision:0},state={roomId,stopped:false,pending:false,
   currentCredit:{cueId:cues[1].cueId,playbackRevision:2},cues:[{...cues[0],status:'PLAYED',playbackRevision:1},{...cues[1],status:'PLAYING',playbackRevision:2}]};
  const runtime={pending:null,acks:[firstPlan,secondPlan].map((plan,i)=>({reservation:{cue:cues[i],plan,expectedRevision:i+1}}))};
  material=createProductionPlayerMaterial({enabled:true,roomId,now:()=>1000,
   bootstrapAuthority:{readStartAuthority:async()=>({source:seed})},assetStore:store,
   repositoryPorts:{readScope:async()=>({...scope,expiresAtMs:60000}),readPlaybackState:async()=>structuredClone(state),readRoomRuntime:async()=>structuredClone(runtime)}});
  const verified=await material.readVerifiedMaterial({scope,mode:'current'});
  assert.equal(verified.binding.assetId,cues[1].music.asset.assetId);assert.equal(verified.binding.playbackRevision,2);
  assert.equal(verified.queuedFrames,72*rate);assert.equal(verified.originFrame,48*rate);
  const earlier=structuredClone(runtime.acks[0]);earlier.reservation.reservationId='synthetic-earlier-graph';
  earlier.reservation.plan.transition.renderedSha256='a'.repeat(64);
  {const {planSha256,...body}=earlier.reservation.plan;earlier.reservation.plan.planSha256=transitionDigest(body);}
  runtime.acks.unshift(earlier);
  const replayed=await material.readVerifiedMaterial({scope,mode:'current'});
  assert.deepEqual(replayed.pcm,verified.pcm);assert.equal(runtime.acks.length,3,'prior graph remains in durable history');
  const active=runtime.acks.at(-1).reservation;
  active.plan.transition.renderedSha256='a'.repeat(64);
  await assert.rejects(material.readVerifiedMaterial({scope,mode:'current'}),/SERVER_ACK_REQUIRED/);
  {const {planSha256,...body}=active.plan;active.plan.planSha256=transitionDigest(body);}
  await assert.rejects(material.readVerifiedMaterial({scope,mode:'current'}),/NATIVE_PROOF_REQUIRED/);
  active.plan=structuredClone(secondPlan);
  const repeated=structuredClone(runtime.acks[1]);repeated.reservation.reservationId='synthetic-unmatched-replay';
  runtime.acks.push(repeated);
  await assert.rejects(material.readVerifiedMaterial({scope,mode:'current'}),/SERVER_ACK_REQUIRED/);
 }finally{material?.close();await fixture?.cleanup();}
});
