import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareBootstrap,saveBootstrap,createBootstrapInspector} from '../integration/runtime/bootstrap.mjs';
import {createLocalArtifactStore} from '../integration/runtime/local-artifacts.mjs';
import {createPrototypePipeline} from '../integration/runtime/prototype-pipeline.mjs';
import {createNativeInspectors} from '../integration/qc/native-inspectors.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
import {buildVerifiedCue} from '../cloud/generation/cue-contract.mjs';
import {generationIdentity} from '../cloud/generation/dispatch.mjs';
import {evaluateTransition} from '../snapshot/app/runtime/dj-transition-selector.mjs';
import {createRenderResolver} from '../integration/runtime/render-resolver.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
const run=promisify(execFile),rate=44100;
function wave(seconds){const n=seconds*rate,b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
 b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*4,28);
 b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);
 for(let i=0;i<n;i++){const x=Math.round(.1*Math.sin(2*Math.PI*220*i/rate)*32768);b.writeInt16LE(x,44+i*4);b.writeInt16LE(x,46+i*4);}return b;}
test('synthetic bytes traverse real native QC, private save, cue and exact render resolver without a provider call',
 {skip:!process.env.VDJ_QC_PYTHON||!process.env.VDJ_QC_DSP},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vdj-native-pipeline-')),store=await createLocalArtifactStore();let pipeline;
 try{
  const videoFile=path.join(dir,'generated-fixture.mp4');
  await run(process.env.VDJ_QC_FFMPEG??'ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=4','-t','5','-c:v','libx264','-pix_fmt','yuv420p','-an',videoFile]);
  const seed=wave(24),audio=wave(40),video=await readFile(videoFile);
  const bootstrap=await prepareBootstrap({audioBytes:seed,referenceBytes:Buffer.from([137,80,78,71,13,10,26,10]),
    inspect:createBootstrapInspector({python:process.env.VDJ_QC_PYTHON,dspModule:process.env.VDJ_QC_DSP})});
  const source=await saveBootstrap({prepared:bootstrap,store});
  const opId='native-fixture-operation',identity=generationIdentity(opId);
  const op={operationId:opId,submissionId:'synthetic-submission',stopped:false,permit:{source,sourceSha256:cueDigest(cueSourceIdentity(source)),visualPolicy:TECHNICAL_VISUAL_POLICY},
   plan:{status:'COMPILED',commonIntentSha256:'a'.repeat(64),common:{cueId:identity.cueId,control:{version:2}}},
   stages:{music:{state:'COMPLETE',requestId:'synthetic-audio-request',result:{url:'https://v3.fal.media/synthetic.wav',resultSha256:'b'.repeat(64)}},
    video:{state:'COMPLETE',requestId:'synthetic-video-request',result:{url:'https://v3.fal.media/synthetic.mp4',resultSha256:'c'.repeat(64)}}}};
  let syntheticDownloads=0;
  pipeline=createPrototypePipeline({readOperation:async()=>op,readCurrent:async()=>source,store,
   native:createNativeInspectors({python:process.env.VDJ_QC_PYTHON,dspModule:process.env.VDJ_QC_DSP}),
   fetchImpl:async url=>{syntheticDownloads++;return new Response(url.endsWith('.wav')?audio:video);},
   readVisualPlan:async({newClip})=>({clips:[newClip],manifest:{version:'accepted-video-timeline-v1',durationSeconds:24,
    width:1280,height:720,fit:'contain',muted:true,clips:[{clipId:newClip.clipId,sha256:newClip.sha256,durationSeconds:5}],
    segments:[0,5,10,15,20].map(start=>({clipId:newClip.clipId,startSeconds:start,endSeconds:Math.min(start+5,24),
      inSeconds:0,outSeconds:Math.min(5,24-start),overlapSeconds:0,transition:'cut'}))}})});
  const evidence=await pipeline.inspectGeneration({roomId:'synthetic-room',operation:op});
  assert.equal(syntheticDownloads,2);assert.equal(evidence.video.review.ownerArtisticApproval,false);
  assert.equal(evidence.video.review.kind,'technical-qc');
  const cue=buildVerifiedCue({roomId:'synthetic-room',operation:op,evidence});
  const savedAudio=await store.read(cue.music.asset.assetId);
  assert.equal(savedAudio.provenance.operationId,op.operationId);
  assert.equal(savedAudio.provenance.requestId,op.stages.music.requestId);
  assert.equal(savedAudio.provenance.resultSha256,op.stages.music.result.resultSha256);
  assert.deepEqual(savedAudio.binding,cue.music.binding);
  const current=await pipeline.currentForSelector('synthetic-room');
  const pairQC=await pipeline.inspectJoin({current,candidate:cue});
  const plan=evaluateTransition({current,candidate:cue,pairQC,mode:'provider'});assert.equal(plan.status,'ELIGIBLE');
  const resolver=createRenderResolver({readCurrent:async()=>current,readRender:pipeline.readRender,
    readArtifact:id=>store.read(id)});
  const rendered=await resolver({roomId:'synthetic-room',cue,plan,expectedRevision:1});
  assert.equal(rendered.durationFrames,48*rate);assert.equal(rendered.startFrame,24*rate);
  assert.equal(cue.video.timeline.durationSeconds,24);assert.equal(cue.video.clips[0].durationSeconds,5);
  source.playback.revision++;
  await assert.rejects(pipeline.inspectGeneration({roomId:'synthetic-room',operation:op}),/SOURCE_CHANGED/);
 }finally{pipeline?.close();await store.close();await rm(dir,{recursive:true,force:true});}
});
