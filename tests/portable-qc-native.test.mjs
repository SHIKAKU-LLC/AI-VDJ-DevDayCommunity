import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createNativeInspectors} from '../integration/qc/native-inspectors.mjs';
import {createPortableQC,sha256,validateCueSet} from '../integration/qc/portable-qc.mjs';
import {createRenderResolver} from '../integration/runtime/render-resolver.mjs';
import {evaluateTransition} from '../snapshot/app/runtime/dj-transition-selector.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
const run=promisify(execFile),rate=44100;
function wave(seconds,{format=1,signal=i=>.1*Math.sin(2*Math.PI*220*i/rate),offset=0}={}) {
 const bytesPerSample=format===1?2:4,frames=seconds*rate,b=Buffer.alloc(44+frames*2*bytesPerSample);
 b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(format,20);b.writeUInt16LE(2,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2*bytesPerSample,28);b.writeUInt16LE(2*bytesPerSample,32);b.writeUInt16LE(bytesPerSample*8,34);b.write('data',36);b.writeUInt32LE(frames*2*bytesPerSample,40);
 for(let i=0;i<frames;i++)for(let c=0;c<2;c++){const x=signal(i+offset);if(format===1)b.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(x*32768))),44+(i*2+c)*2);else b.writeFloatLE(x,44+(i*2+c)*4);}return b;
}
const binding=channel=>({roomId:'synthetic-room',submissionId:'synthetic-submission',generationId:'synthetic-generation',controlVersion:2,commonIntentSha256:'a'.repeat(64),channel});
const origin=async(_,r)=>({...r,kind:'synthetic',verified:true,requestId:'synthetic-request',operationId:'synthetic-operation',resultSha256:'c'.repeat(64),modelId:r.binding.channel==='music'?'fal-ai/stable-audio-3/medium/audio-outpainting':'minimax/h3-max/image-to-video'});
const review=async(_,r)=>({...r,accepted:true,ownerArtisticApproval:true,reviewId:'synthetic-review'});
async function audioInput(bytes=wave(24),parent=wave(24),context=wave(16,{offset:8*rate})) {
 const source={bytes:parent,contextBytes:context,clipId:'synthetic-parent',sha256:await sha256(parent),contextSha256:await sha256(context),playbackRevision:1};
 return {binding:binding('music'),expectedBinding:binding('music'),assetId:'synthetic-audio',bytes,sha256:await sha256(bytes),source,
  expectedSource:{clipId:source.clipId,sha256:source.sha256,contextSha256:source.contextSha256,playbackRevision:1},layout:'tail-only'};
}
test('native worker uses full synthetic bytes; never marks a provider generation', {skip:!process.env.VDJ_QC_PYTHON||!process.env.VDJ_QC_DSP}, async t=>{
 const native=createNativeInspectors({python:process.env.VDJ_QC_PYTHON,dspModule:process.env.VDJ_QC_DSP,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'});
 const q=createPortableQC({...native,verifyProvenance:origin,verifyReview:review,verifyCurrentSource:async()=>true});
 await t.test('actual 24-second PCM/context/transition/loudness computation passes only synthetic QC',async()=>{
  const input=await audioInput(),r=await q.audio(input);assert.equal(r.media.qc.passed,true,JSON.stringify(r.media.qc));assert.equal(r.media.actualGenerationThisRun,false);assert.equal(r.media.durationSeconds,24);assert.equal(r.media.status,'SYNTHETIC_QC_READY');assert.equal(await sha256(r.cueBytes),r.media.asset.sha256);assert.equal(r.media.transitionEvidence.renderedFrameCount,48*rate);
  const current={clipId:input.source.clipId,sha256:input.source.sha256,contextSha256:input.source.contextSha256,
    profile:{...r.media.profile,assetSha256:input.source.sha256},playbackRevision:1,playedUntilFrame:0};
  const candidate={roomId:'synthetic-room',cueId:'synthetic-cue',generationId:'synthetic-generation',controlVersion:2,
    status:'READY',atomicReady:true,music:r.media,video:{qc:{passed:true}}};
  const plan=evaluateTransition({current,candidate,pairQC:r.media.transitionEvidence,mode:'provider'});
  assert.equal(plan.status,'ELIGIBLE');
  const artifacts=new Map([[current.clipId,input.source.bytes],[candidate.music.asset.assetId,r.cueBytes],['render',r.renderBytes]]);
  const resolver=createRenderResolver({readCurrent:async()=>current,readRender:async()=>({assetId:'render',receipt:r.media.transitionEvidence}),
    readArtifact:async id=>({bytes:artifacts.get(id)})});
  const prepared=await resolver({roomId:candidate.roomId,cue:candidate,plan,expectedRevision:2});
  assert.equal(prepared.startFrame,24*rate);assert.equal(prepared.durationFrames,48*rate);
 });
 await t.test('partial WAV, silence, clipping and nonfinite PCM are rejected',async()=>{
  const valid=wave(24);
  for(const bytes of [valid.subarray(0,valid.length-2),wave(24,{signal:()=>0}),wave(24,{signal:i=>i%2?1:-1}),wave(24,{format:3,signal:i=>i===12?NaN:.1*Math.sin(2*Math.PI*220*i/rate)})]){
   const r=await q.audio(await audioInput(bytes));assert.equal(r.media.status,'HOLD');assert.equal(r.cueBytes,null);
  }
 });
 await t.test('wrong current PCM context holds despite matching supplied hashes',async()=>{
  const r=await q.audio(await audioInput(wave(24),wave(24),wave(16,{signal:()=>.1})));assert.equal(r.media.status,'HOLD');assert(r.media.qc.reasons.includes('EXACT_PARENT_CONTEXT_PCM_REQUIRED'));
 });
 await t.test('40-second context+tail is explicitly split; wrong prefix holds',async()=>{
  const r=await audioInput(wave(40));r.layout='context-plus-tail';const ok=await q.audio(r);assert.equal(ok.media.qc.passed,true,JSON.stringify(ok.media.qc));assert.equal(ok.media.durationSeconds,24);assert.notEqual(ok.media.asset.sha256,r.sha256);
  const bad=await audioInput(wave(40,{signal:i=>i<16*rate?.05:.1*Math.sin(2*Math.PI*220*i/rate)}));bad.layout='context-plus-tail';assert.equal((await q.audio(bad)).media.status,'HOLD');
 });
 const dir=await mkdtemp(path.join(tmpdir(),'vdj-synthetic-video-'));
 try{
  const file=path.join(dir,'synthetic.mp4');await run(process.env.VDJ_QC_FFMPEG??'ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=4','-t','5','-c:v','libx264','-pix_fmt','yuv420p','-an',file]);
  const bytes=await readFile(file),clipSha=await sha256(bytes);
  const videoInput=()=>({binding:binding('video'),expectedBinding:binding('video'),assetId:'synthetic-visual',referenceSha256:'b'.repeat(64),clips:[{clipId:'clip-1',bytes}],
   manifest:{version:'accepted-video-timeline-v1',durationSeconds:24,width:1280,height:720,fit:'contain',muted:true,clips:[{clipId:'clip-1',sha256:clipSha,durationSeconds:5}],segments:Array.from({length:5},(_,i)=>({clipId:'clip-1',startSeconds:i*5,endSeconds:Math.min(24,(i+1)*5),inSeconds:0,outSeconds:i===4?4:5,transition:'cut',overlapSeconds:0}))}});
  await t.test('actual five-second video fully decodes and only its reviewed timeline is 24s',async()=>{const r=await q.video(videoInput());assert.equal(r.qc.passed,true,JSON.stringify(r.qc));assert.equal(r.compositionQC.clips[0].measurement.decodedFrames,20);assert(r.compositionQC.clips[0].measurement.technicalStats.meanMotion>0);assert.equal(r.durationSeconds,24);assert.equal(r.actualGenerationThisRun,false);assert.equal(validateCueSet(null,r,binding('music')).status,'HOLD');});
  await t.test('limited-range black and white clips fail measured technical QC without demanding human review',async()=>{
   const automatic=createPortableQC({...native,verifyProvenance:origin,visualPolicy:TECHNICAL_VISUAL_POLICY});
   for(const color of ['black','white']){
    const target=path.join(dir,color+'.mp4');
    await run(process.env.VDJ_QC_FFMPEG??'ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',`color=${color}:size=160x90:rate=4`,'-t','5','-c:v','libx264','-pix_fmt','yuv420p','-an',target]);
    const input=videoInput();input.clips[0].bytes=await readFile(target);input.manifest.clips[0].sha256=await sha256(input.clips[0].bytes);
    const result=await automatic.video(input);assert.equal(result.status,'HOLD');
    assert(result.qc.reasons.includes('UNIFORM_BLACK_OR_WHITE_VIDEO'));
    assert(!result.qc.reasons.includes('EXACT_OWNER_COMPOSITION_REVIEW_REQUIRED'));
   }
  });
  await t.test('partial or corrupt MP4 does not get a video measurement',async()=>{for(const corrupt of [bytes.subarray(0,bytes.length/2),Buffer.from('not mp4')]){const r=videoInput();r.clips[0].bytes=corrupt;r.manifest.clips[0].sha256=await sha256(corrupt);const result=await q.video(r);assert.equal(result.status,'HOLD');assert(result.qc.reasons.includes('VIDEO_DECODE_FAILED'));}});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('actual reconstructed conditioning and short active tail become a measured24s overlapping cue without padding',
 {skip:!process.env.VDJ_QC_PYTHON},async()=>{
 const {createPortableNativeRuntime}=await import('../cloud/worker/native-runtime.mjs');
 const runtime=await createPortableNativeRuntime({python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'});
 try{
  const raw=wave(40,{signal:i=>i>=38*rate?0:.096*Math.sin(2*Math.PI*220*i/rate)}),before=await sha256(raw),input=await audioInput(raw);input.layout='context-plus-tail';
  const providerFixture=async(p,r)=>({...await origin(p,r),kind:'provider'});
  const qc=createPortableQC({...runtime.native,verifyProvenance:providerFixture,verifyCurrentSource:async()=>true});
  const audio=await qc.audio(input);assert.equal(audio.media.qc.passed,true,JSON.stringify({qc:audio.media.qc,transition:audio.media.transitionEvidence,conditioned:audio.media.conditionedContinuation}));
  const repeated=await qc.audio(input);
  assert.equal(repeated.media.qc.passed,true,JSON.stringify(repeated.media.qc));
  assert.equal(repeated.media.asset.sha256,audio.media.asset.sha256,'retry does not change a derived WAV timestamp');
  assert.equal(repeated.media.transitionEvidence.renderedSha256,audio.media.transitionEvidence.renderedSha256);
  assert.deepEqual(repeated.cueBytes,audio.cueBytes);assert.deepEqual(repeated.renderBytes,audio.renderBytes);
  const c=audio.media.conditionedContinuation;assert.equal(c.cueFrameCount,24*rate);assert.equal(c.newTimelineFrames,22*rate);
  assert.equal(c.contextOverlapFrames,2*rate);assert.equal(c.padding,false);assert.equal(c.bitIdenticalPrefixClaimed,false);
  assert.equal(await sha256(raw),before);assert.equal(audio.media.transitionEvidence.nativeContinuationVerified,false);
  const current={clipId:input.source.clipId,sha256:input.source.sha256,contextSha256:input.source.contextSha256,
   profile:{...audio.media.profile,assetSha256:input.source.sha256},playbackRevision:1,playedUntilFrame:0};
  const candidate={roomId:'synthetic-room',cueId:'synthetic-conditioned-cue',generationId:'synthetic-generation',controlVersion:2,
   status:'READY',atomicReady:true,music:audio.media,video:{qc:{passed:true}}};
  const plan=evaluateTransition({current,candidate,pairQC:audio.media.transitionEvidence,mode:'provider'});
  assert.equal(plan.status,'ELIGIBLE',JSON.stringify(plan.reasons));assert.equal(plan.transition.conditionedContinuationVerified,true);
  assert.equal(plan.transition.nativeContinuationVerified,false);assert.equal(plan.transition.netIncomingSeconds,22);
  const pair=await runtime.native.inspectJoin({bytes:audio.cueBytes,sourceBytes:input.source.bytes,playbackRevision:2,inputDigest:'a'.repeat(64)});
  assert.equal(pair.receipt.nativeContinuationVerified,false);assert.equal(pair.receipt.beatGridVerified,false);assert.equal(pair.receipt.overlapFrames,0);
  const changed={...current,playbackRevision:2,clipId:'different-current'},cross={...candidate,music:{...audio.media,parentClipId:'old-parent'}};
  const selected=evaluateTransition({current:changed,candidate:cross,pairQC:pair.receipt,mode:'provider'});
  assert.equal(selected.status,'ELIGIBLE',JSON.stringify(selected.reasons));assert.equal(selected.transition.measuredCutVerified,true);
  assert.equal(selected.transition.beatGridVerified,false);assert.equal(selected.evidenceScope,'MEASURED_NONOVERLAP_WITH_UNVERIFIED_MUSICAL_GRID');
 }finally{await runtime.close();}
});

test('a gradual ending uses a measured contiguous24s range; an actually short continuation still holds',
 {skip:!process.env.VDJ_QC_PYTHON},async()=>{
 const {createPortableNativeRuntime}=await import('../cloud/worker/native-runtime.mjs');
 const runtime=await createPortableNativeRuntime({python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'});
 try{
  const qc=createPortableQC({...runtime.native,verifyProvenance:async(p,r)=>({...await origin(p,r),kind:'provider'}),verifyCurrentSource:async()=>true});
  const raw=wave(40,{signal:i=>.096*Math.sin(2*Math.PI*220*i/rate)*10**(-12*Math.max(0,i/rate-34.75)/20)});
  const before=await sha256(raw),input=await audioInput(raw);input.layout='context-plus-tail';
  const audio=await qc.audio(input),c=audio.media.conditionedContinuation;
  assert.equal(audio.media.qc.passed,true,JSON.stringify(audio.media.qc));
  assert.equal(c.cueFrameCount,24*rate);assert.ok(c.newTimelineFrames>=20*rate);
  assert.ok(c.contextOverlapFrames<=4*rate);assert.equal(c.rawEndFrame-c.rawStartFrame,24*rate);
  assert.equal(c.padding,false);assert.equal(c.looping,false);assert.equal(c.timeStretch,false);assert.equal(c.pitchShift,false);
  assert.equal(audio.media.transitionEvidence.renderQC.passed,true);assert.equal(await sha256(raw),before);
  const short=await audioInput(wave(40,{signal:i=>i>=35*rate?0:.096*Math.sin(2*Math.PI*220*i/rate)}));short.layout='context-plus-tail';
  const held=await qc.audio(short);assert.equal(held.media.qc.passed,false);assert.equal(held.cueBytes,null);
 }finally{await runtime.close();}
});
