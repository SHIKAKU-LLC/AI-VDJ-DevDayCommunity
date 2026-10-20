import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createProductionVisualPlan} from '../cloud/worker/visual-plan.mjs';
import {createPortableCloudWorker} from '../cloud/worker/portable-worker.mjs';
import {createPortableNativeRuntime} from '../cloud/worker/native-runtime.mjs';
import {createSyntheticCloudWorkerFixture,fixtureSha} from './cloud-worker-fixture.mjs';
import {createPrivateMediaIngestion} from '../cloud/worker/private-ingestion.mjs';
import {createPrivateStore} from '../cloud/worker/private-store.mjs';
import {syntheticStorageTransport} from './cloud-worker-store-fixture.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
import {generationIdentity} from '../cloud/generation/dispatch.mjs';
import {operationBinding,buildVerifiedCue} from '../cloud/generation/cue-contract.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
const run=promisify(execFile);
for(const savedOrigin of ['provider','owner-supplied-bootstrap-video'])test(`real private ingestion plus native full decode supplies accepted 5+19 second plan with ${savedOrigin} and QC cue`,
 {skip:!process.env.VDJ_QC_PYTHON},async()=>{
 const runtime={python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'};
 const roomId='native-visual-room',operationId='native-visual-operation',objects=syntheticStorageTransport();
 const scope={roomId,['sessionId']:'native-visual-session',controlRevision:0,expiresAtMs:2000000,ownerEnabled:true};
 let fixture,privateStore,ingestion,nativeRuntime,plan,worker,directory,op;
 try{
  privateStore=createPrivateStore({enabled:true,roomId,transport:objects.transport});
  fixture=await createSyntheticCloudWorkerFixture({roomId,assetStore:privateStore.assetStore,runtime,
   readOperation:i=>ingestion.readOperation(i)});
  const source=fixture.source,identity=generationIdentity(operationId);
  op={roomId,operationId,submissionId:'native-submission',stopped:false,dispatchAllowed:true,
   permit:{permitId:'native-visual-permit',source,sourceSha256:cueDigest(cueSourceIdentity(source)),visualPolicy:TECHNICAL_VISUAL_POLICY},
   plan:{status:'COMPILED',commonIntentSha256:'a'.repeat(64),common:{cueId:identity.cueId,control:{version:2}}},
   stages:{music:{state:'COMPLETE',requestId:'audio-request',result:{url:'https://v3.fal.media/synthetic.wav',contentType:'audio/wav',
    providerObserved:true,resultSha256:'b'.repeat(64)}},video:{state:'COMPLETE',requestId:'video-request',
    result:{url:'https://v3.fal.media/synthetic.mp4',contentType:'video/mp4',providerObserved:true,resultSha256:'c'.repeat(64)}}}};
  await privateStore.sourceStore.save({source,sourceEvidence:await fixture.readSourceEvidence()});
  ingestion=createPrivateMediaIngestion({enabled:true,readOperation:async()=>op,assetStore:privateStore.assetStore,
   receiptStore:privateStore.receiptStore,readSourceEvidence:privateStore.readSourceEvidence,fetchImpl:fixture.fetchProviderFixture});
  await ingestion.prepareMedia({roomId,operationId});
  nativeRuntime=await createPortableNativeRuntime(runtime);
  plan=createProductionVisualPlan({enabled:true,readOperation:i=>ingestion.readOperation(i),assetStore:privateStore.assetStore,
   inspectVideo:nativeRuntime.native.inspectVideo,readScope:async()=>scope,now:()=>1000000});
  worker=createPortableCloudWorker({enabled:true,readOperation:i=>ingestion.readOperation(i),readCurrent:async()=>source,
   assetStore:privateStore.assetStore,native:nativeRuntime.native,readVisualPlan:plan.readVisualPlan,readSavedRecord:plan.readSavedRecord});
  const insufficient=await worker.processJob({roomId,operationId});assert.equal(insufficient.status,'HOLD');
  assert.deepEqual(insufficient.reasons,['VISUAL_CONTINUOUS_MATERIAL_INSUFFICIENT']);
  directory=await mkdtemp(path.join(tmpdir(),'vdj-production-visual-'));const priorPath=path.join(directory,'prior.mp4');
  await run(runtime.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=4','-t','19',
   '-c:v','libx264','-pix_fmt','yuv420p','-an',priorPath]);const prior=await readFile(priorPath);
  const priorBinding=savedOrigin==='provider'?{...operationBinding(roomId,op,'video'),generationId:'prior-approved-generation'}:
   {kind:savedOrigin,roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision,
    expiresAtMs:scope.expiresAtMs,referenceSha256:source.video.referenceSha256};
  let provenance={kind:'provider',requestId:'prior-request',resultSha256:'d'.repeat(64),sourceSha256:source.video.referenceSha256};
  if(savedOrigin!=='provider'){
   const sha256=fixtureSha(prior),referenceSha256=source.video.referenceSha256,admissionId='native-owner-admission';
   const measurement=await nativeRuntime.native.inspectVideo({bytes:prior,inputDigest:cueDigest({kind:'operator-upload-video-v1',sha256,referenceSha256})});
   const evidence=Buffer.from(JSON.stringify({version:'owner-bootstrap-video-admission-v1',assetId:'prior-approved-video',sha256,
    byteLength:prior.length,referenceSha256,admissionId,ownerSelected:true,actualGenerationThisRun:false,binding:priorBinding,measurement}));
   await privateStore.assetStore.save({id:'admission-'+admissionId,bytes:evidence,contentType:'application/json',binding:priorBinding,
    provenance:{kind:'owner-bootstrap-video-admission'}});
   provenance={kind:savedOrigin,actualGenerationThisRun:false,sourceSha256:referenceSha256,rawSha256:sha256,
    admissionId,admissionEvidenceSha256:fixtureSha(evidence)};
  }
  await privateStore.assetStore.save({id:'prior-approved-video',bytes:prior,contentType:'video/mp4',binding:priorBinding,
   provenance});
  await plan.saveAcceptedEdit({roomId,operationId,clips:[{assetId:'prior-approved-video',sha256:fixtureSha(prior),inSeconds:0,outSeconds:19}]});
  const result=await worker.processJob({roomId,operationId});assert.equal(result.status,'QC_READY',JSON.stringify(result.reasons));
  assert.deepEqual(result.evidence.video.timeline.segments.map(s=>[s.startSeconds,s.endSeconds,s.sourceInSeconds,s.sourceOutSeconds]),
   [[0,5,0,5],[5,24,0,19]]);
  assert.deepEqual(result.evidence.video.clips.map(c=>c.provenanceKind),['provider',savedOrigin==='provider'?'saved':savedOrigin]);
  if(savedOrigin!=='provider'){
   const ownerClip=result.evidence.video.compositionQC.clips[1];
   assert.equal(ownerClip.ownerAdmission.actualGenerationThisRun,false);assert.equal(ownerClip.originalGenerationId,null);
   assert.equal(ownerClip.providerReceipt,null);assert.equal(ownerClip.ownerAdmission.admissionId,'native-owner-admission');
  }
  const cue=buildVerifiedCue({roomId,operation:op,evidence:result.evidence});assert.equal(cue.status,'READY');
  if(savedOrigin!=='provider'){
   assert.equal(result.evidence.video.clips[1].ownerAdmission.actualGenerationThisRun,false);
   assert.equal(cue.video.clips[1].provenanceKind,savedOrigin);
   assert.equal(cue.video.clips[1].ownerAdmission.admissionId,'native-owner-admission');
   const forged=structuredClone(result.evidence);forged.video.clips[1].providerRequestId='fabricated-provider';
   assert.throws(()=>buildVerifiedCue({roomId,operation:op,evidence:forged}),/OWNER_VISUAL_ADMISSION/);
  }
  assert.equal(cue.video.timeline.durationSeconds,24);assert.equal(result.evidence.video.compositionQC.continuousNewGeneration,false);
  assert.equal([...objects.objects.keys()].filter(k=>k.includes('/receipts/')).length,2,'real ingestion receipts persisted');
 }finally{await worker?.close();plan?.close();await nativeRuntime?.close();await ingestion?.close();await fixture?.cleanup();
  privateStore?.close();if(directory)await rm(directory,{recursive:true,force:true});}
});
