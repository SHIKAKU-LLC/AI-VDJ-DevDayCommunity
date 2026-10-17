import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortableQC,sha256,digest,validateCueSet,QC_VERSION} from '../integration/qc/portable-qc.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
const bind=channel=>({roomId:'room-1',submissionId:'submission-1',generationId:'generation-1',commonIntentSha256:'a'.repeat(64),controlVersion:2,channel});
const model=channel=>channel==='music'?'fal-ai/stable-audio-3/medium/audio-outpainting':'minimax/h3-max/image-to-video';
// Explicit synthetic authority: tests cannot register these as real generation.
export const syntheticOrigin=async(proof,r)=>proof?.synthetic===true?{...r,kind:'synthetic',verified:true,requestId:'synthetic-request',operationId:'synthetic-operation',resultSha256:'c'.repeat(64),modelId:model(r.binding.channel)}:null;
export const syntheticReview=async(review,r)=>review?.synthetic===true?{...r,accepted:true,ownerArtisticApproval:true,reviewId:'synthetic-review'}:null;
const profile=sha=>({method:'pcm-endpoint-profile-v1',assetSha256:sha,sampleRate:44100,channels:2,frameCount:24*44100,rmsDbfs:-20,
 head:{rmsDbfs:-20,bandFractions:[.2,.6,.2]},tail:{rmsDbfs:-20,bandFractions:[.2,.6,.2]},clippedFraction:0,nonfiniteSamples:0,
 activity:{maxQuietRunSeconds:0,effectiveSilence:false},loudness:{truePeakDbtp:-10,integratedLufs:-18,loudnessRangeLu:1},
 bpm:{value:null,confidence:'unknown'},key:{value:null,confidence:'unknown'}});
const specs={type:'native-continuation',entryFrame:0,exitFrame:24*44100,overlapFrames:0,sampleRate:44100,relativeIncomingGainDb:0,eqCurves:null};
async function syntheticAudio(r){const sha=await sha256(r.bytes),parent=await sha256(r.sourceBytes),ctx=await sha256(r.contextBytes);
 return {method:QC_VERSION,inputDigest:r.inputDigest,rawSha256:sha,parentSha256:parent,contextSha256:ctx,cueBytes:r.bytes,cueSha256:sha,
  profile:profile(sha),parentFrameCount:24*44100,contextFrameCount:16*44100,contextMatchesCurrentTail:true,contextPrefixMatches:true,
  transition:{...specs,method:'rendered-transition-qc-v1',passed:true,renderQC:{passed:true},currentSha256:parent,incomingSha256:sha,parentSha256:parent,contextSha256:ctx,currentPlaybackRevision:r.playbackRevision,nativeContinuationVerified:true,contextAnchorFrame:24*44100,currentFrameCount:24*44100,incomingFrameCount:24*44100,renderedFrameCount:48*44100,renderedSha256:'f'.repeat(64),renderSpecSha256:await digest(specs),timeStretch:false,pitchShift:false,renderMetrics:{truePeakDbtp:-10,clippedFraction:0,nonfiniteSamples:0,bassDoubleOwnershipFrames:0,maxQuietRunSeconds:0,minimumWindowDbfs:-20,maxLevelStepDb:0,seamJump:.01,overlapLowBandLiftDb:0,integratedLufs:-18,loudnessRangeLu:1}}};}
const syntheticVideo=async r=>({method:QC_VERSION,inputDigest:r.inputDigest,rawSha256:await sha256(r.bytes),fullyDecoded:true,decodedFrames:120,width:1280,height:720,durationSeconds:5});
export async function audioInput(bytes=new Uint8Array([1,2,3]),sourceBytes=new Uint8Array([4,5]),contextBytes=new Uint8Array([6,7])) {
 const source={bytes:sourceBytes,contextBytes,clipId:'parent-1',sha256:await sha256(sourceBytes),contextSha256:await sha256(contextBytes),playbackRevision:3};
 return {binding:bind('music'),expectedBinding:bind('music'),assetId:'music-1',bytes,sha256:await sha256(bytes),source,
  expectedSource:{clipId:source.clipId,sha256:source.sha256,contextSha256:source.contextSha256,playbackRevision:3},provenance:{synthetic:true},layout:'tail-only'};
}
export async function videoInput(bytes=new Uint8Array([8,9])) {
 const clipSha=await sha256(bytes),segments=Array.from({length:5},(_,i)=>({clipId:'clip-1',startSeconds:i*5,endSeconds:Math.min((i+1)*5,24),inSeconds:0,outSeconds:i===4?4:5,overlapSeconds:0,transition:'cut'}));
 return {binding:bind('video'),expectedBinding:bind('video'),assetId:'visual-1',referenceSha256:'b'.repeat(64),
  manifest:{version:'accepted-video-timeline-v1',durationSeconds:24,width:1280,height:720,fit:'contain',muted:true,clips:[{clipId:'clip-1',sha256:clipSha,durationSeconds:5}],segments},
  clips:[{clipId:'clip-1',bytes,provenance:{synthetic:true}}],review:{synthetic:true}};
}
const factory=overrides=>createPortableQC({inspectAudio:syntheticAudio,inspectVideo:syntheticVideo,verifyProvenance:syntheticOrigin,verifyReview:syntheticReview,verifyCurrentSource:async()=>true,...overrides});
test('matching synthetic data can pass technical QC but cannot become real generated cue',async()=>{
 const q=factory(),a=(await q.audio(await audioInput())).media,v=await q.video(await videoInput());
 assert.equal(a.qc.passed,true);assert.equal(v.qc.passed,true);assert.equal(a.status,'SYNTHETIC_QC_READY');assert.equal(v.status,'SYNTHETIC_QC_READY');
 assert.equal(a.actualGenerationThisRun,false);assert.equal(v.actualGenerationThisRun,false);assert.equal(a.profile.key.confidence,'unknown');
 assert.equal(validateCueSet(a,v,bind('music')).status,'HOLD');
});
test('wrong bytes, binding and current parent hold before registration',async()=>{
 for(const mutate of [r=>r.sha256='0'.repeat(64),r=>r.binding.generationId='other',r=>r.binding.commonIntentSha256='c'.repeat(64),r=>r.expectedSource.clipId='other',r=>r.source.contextSha256='0'.repeat(64),r=>r.expectedSource.playbackRevision++]){
  const r=await audioInput();mutate(r);assert.equal((await factory().audio(r)).media.status,'HOLD');
 }
 const missing=await factory().audio({});assert.equal(missing.media.status,'HOLD');
});
test('missing or mismatched provenance and unverified model stay HOLD',async()=>{
 const a=await audioInput();a.provenance={};assert.equal((await factory().audio(a)).media.status,'HOLD');
 for(const mutate of [p=>p.rawSha256='0'.repeat(64),p=>p.binding.generationId='other',p=>p.sourceSha256='0'.repeat(64),p=>p.modelId='arbitrary',p=>p.byteLength++]){
  const q=factory({verifyProvenance:async(p,r)=>{const v=await syntheticOrigin(p,r);mutate(v);return v;}});assert.equal((await q.audio(await audioInput())).media.status,'HOLD');
 }
});
test('stale measurement, context mismatch, bad native geometry and each physical gate hold',async()=>{
 for(const mutate of [m=>m.inputDigest='0'.repeat(64),m=>m.contextMatchesCurrentTail=false,m=>m.contextPrefixMatches=false,m=>m.transition.exitFrame--,m=>m.transition.parentSha256='0'.repeat(64),m=>m.profile.activity.effectiveSilence=true,m=>m.profile.clippedFraction=.01,m=>m.profile.nonfiniteSamples=1,m=>m.transition.renderMetrics.truePeakDbtp=0,m=>m.transition.renderMetrics.maxQuietRunSeconds=.2,m=>m.transition.renderMetrics.maxLevelStepDb=7,m=>m.transition.renderMetrics.seamJump=.2,m=>m.transition.renderMetrics.bassDoubleOwnershipFrames=1]){
  const q=factory({inspectAudio:async r=>{const m=await syntheticAudio(r);mutate(m);return m;}});assert.equal((await q.audio(await audioInput())).media.status,'HOLD');
 }
});
test('source is checked again after measurement, not only before it',async()=>{
 let n=0;const q=factory({verifyCurrentSource:async()=>++n===1});assert.equal((await q.audio(await audioInput())).media.status,'HOLD');assert.equal(n,2);
});
test('24-second loop manifest preserves five-second clip identity and requires exact review',async()=>{
 const r=await videoInput(),out=await factory().video(r);assert.equal(out.durationSeconds,24);assert.equal(out.compositionQC.clips[0].measurement.durationSeconds,5);assert.deepEqual(out.compositionQC.timeline,r.manifest);assert.equal(out.asset.kind,'approved-timeline-manifest');assert.equal(out.compositionQC.continuousNewGeneration,false);
 for(const mutate of [x=>x.review=null,x=>x.manifest.durationSeconds=5,x=>x.manifest.segments.pop(),x=>x.manifest.segments[1].startSeconds+=.2,x=>x.manifest.segments[0].outSeconds=6,x=>x.manifest.clips[0].sha256='0'.repeat(64),x=>x.binding.generationId='other',x=>x.manifest.fit='cover',x=>x.manifest.arbitrary='unapproved-metadata',x=>x.manifest.clips.push({...x.manifest.clips[0],clipId:'unused'})]){
  const x=await videoInput();mutate(x);assert.equal((await factory().video(x)).status,'HOLD');
 }
});
test('multi-clip and explicit overlapping handoffs are retained, never synthesized',async()=>{
 const r=await videoInput();r.manifest.clips.push({...r.manifest.clips[0],clipId:'clip-2'});r.clips.push({...r.clips[0],clipId:'clip-2'});r.manifest.segments[1].clipId='clip-2';
 r.manifest.segments=[{clipId:'clip-1',startSeconds:0,endSeconds:5,inSeconds:0,outSeconds:5,overlapSeconds:0,transition:'cut'},
 ...Array.from({length:4},(_,i)=>({clipId:i%2?'clip-2':'clip-1',startSeconds:4.8+i*4.8,endSeconds:9.8+i*4.8,inSeconds:0,outSeconds:5,overlapSeconds:.2,transition:'crossfade'}))];
 r.manifest.segments.at(-1).endSeconds=24;r.manifest.segments.at(-1).outSeconds=24-r.manifest.segments.at(-1).startSeconds;
 const v=await factory().video(r);assert.equal(v.qc.passed,true);assert.deepEqual(v.compositionQC.timeline,r.manifest);
});
test('stale or partial video decode and stale review cannot pass',async()=>{
 for(const mutate of [m=>m.inputDigest='0'.repeat(64),m=>m.rawSha256='0'.repeat(64),m=>m.fullyDecoded=false,m=>m.decodedFrames=0,m=>m.durationSeconds=2]){
  const q=factory({inspectVideo:async r=>{const m=await syntheticVideo(r);mutate(m);return m;}});assert.equal((await q.video(await videoInput())).status,'HOLD');
 }
 const q=factory({verifyReview:async(r,b)=>({...await syntheticReview(r,b),manifestSha256:'0'.repeat(64)})});assert.equal((await q.video(await videoInput())).status,'HOLD');
});
test('malformed manifests hold; same-set binding cannot be bypassed with individually good media',async()=>{
 for(const x of [null,{}, {clips:{},segments:{}}]){const r=await videoInput();r.manifest=x;assert.equal((await factory().video(r)).status,'HOLD');}
 const a=(await factory().audio(await audioInput())).media,v=await factory().video(await videoInput());v.binding.generationId='other';assert(validateCueSet(a,v,bind('music')).reasons.includes('SAME_SET_REQUIRED'));
});

test('existing saved clips retain their origin and cannot become this-run generation',async()=>{
 const r=await videoInput();const saved=async(_p,req)=>({...req,kind:'saved',verified:true,originalGenerationId:'earlier-generation',originalBindingSha256:'d'.repeat(64)});
 const v=await factory({verifyProvenance:saved}).video(r);assert.equal(v.qc.passed,true);assert.equal(v.status,'SAVED_QC_READY');assert.equal(v.actualGenerationThisRun,false);assert.equal(v.compositionQC.clips[0].originalGenerationId,'earlier-generation');
});

test('owner video admission remains a saved origin with no invented provider or generation identity',async()=>{
 const admitted=async(_p,req)=>({...req,kind:'owner-supplied-bootstrap-video',verified:true,admissionId:'owner-admission',
  admissionEvidenceSha256:'d'.repeat(64),originalBindingSha256:'e'.repeat(64),actualGenerationThisRun:false});
 const q=factory({verifyProvenance:admitted}),v=await q.video(await videoInput());
 assert.equal(v.status,'SAVED_QC_READY');assert.equal(v.actualGenerationThisRun,false);assert.equal(v.providerReceipt,null);
 const c=v.compositionQC.clips[0];assert.equal(c.provenanceKind,'owner-supplied-bootstrap-video');
 assert.equal(c.originalGenerationId,null);assert.equal(c.ownerAdmission.actualGenerationThisRun,false);
 assert.equal((await q.audio(await audioInput())).media.status,'HOLD');
 for(const mutate of [p=>p.admissionEvidenceSha256='bad',p=>p.actualGenerationThisRun=true,
  p=>p.originalGenerationId='invented-generation',p=>p.requestId='invented-request']){
  const bad=factory({verifyProvenance:async(p,r)=>{const proof=await admitted(p,r);mutate(proof);return proof;}});
  assert.equal((await bad.video(await videoInput())).status,'HOLD');
 }
});

test('registration bridge refuses synthetic evidence before any save or registration',async()=>{
 const {registrationEvidence}=await import('../integration/qc/registration-evidence.mjs');let calls=0;
 const q=factory(),music=(await q.audio(await audioInput())).media,video=await q.video(await videoInput());
 const out=await registrationEvidence({music,video,expectedBinding:bind('music'),verifySaved:async()=>{calls++;return{};}});
 assert.equal(out.status,'HOLD');assert.equal(out.evidence,null);assert.equal(calls,0);
});
test('general-generation technical policy does not require or invent artistic owner approval',async()=>{
 const q=factory({visualPolicy:TECHNICAL_VISUAL_POLICY,verifyReview:undefined,inspectVideo:async r=>({...await syntheticVideo(r),
  technicalStats:{method:'full-frame-luma-motion-v1',frames:120,nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.02,maximumLargeLumaTransitionsPerSecond:0}})});
 const input=await videoInput();input.review=null;const out=await q.video(input);
 assert.equal(out.qc.passed,true);assert.equal(out.compositionQC.approval.kind,'technical-qc');
 assert.equal(out.compositionQC.approval.ownerArtisticApproval,false);assert.equal(out.actualGenerationThisRun,false);
});

test('reconstructed provider conditioning needs honest bound range/overlap evidence; bit identity stays false',async()=>{
 const input=await audioInput();input.layout='context-plus-tail';
 const providerOrigin=async(_p,r)=>({...r,kind:'provider',verified:true,requestId:'synthetic-request',operationId:'synthetic-operation',resultSha256:'c'.repeat(64),modelId:model('music')});
 const measure=async r=>{const m=await syntheticAudio(r),n=3*44100;
  m.contextPrefixMatches=false;m.conditionedContinuation={kind:'measured-provider-conditioned-cue-v1',rawSha256:m.rawSha256,parentSha256:m.parentSha256,
   contextSha256:m.contextSha256,cueSha256:m.cueSha256,sampleRate:44100,rawFrameCount:40*44100,cueFrameCount:24*44100,
   rawStartFrame:13*44100,rawEndFrame:37*44100,contextOverlapFrames:n,newTimelineFrames:21*44100,conditioningCorrelation:.93,overlapCorrelation:.94,
   gainDb:-5,timeStretch:false,pitchShift:false,padding:false,looping:false,bitIdenticalPrefixClaimed:false,clippingWaveformReconstructed:false};
  const specification={type:'conditioned-context-overlap',entryFrame:n/2,exitFrame:24*44100-n/2,overlapFrames:n,sampleRate:44100,
   relativeIncomingGainDb:0,eqCurves:[{position:0,outgoingLow:1,incomingLow:0},{position:.5,outgoingLow:0,incomingLow:0},{position:1,outgoingLow:0,incomingLow:1}]};
  Object.assign(m.transition,specification,{nativeContinuationVerified:false,renderedFrameCount:45*44100,
   renderSpecSha256:await digest(specification),conditionedContinuationSha256:await digest(m.conditionedContinuation)});return m;};
 const out=await factory({verifyProvenance:providerOrigin,inspectAudio:measure}).audio(input);
 assert.equal(out.media.qc.passed,true,JSON.stringify(out.media.qc));assert.equal(out.media.conditionedContinuation.newTimelineFrames/44100,21);
 assert.equal(out.media.transitionEvidence.nativeContinuationVerified,false);
 for(const mutate of [m=>m.conditionedContinuation.rawSha256='0'.repeat(64),m=>m.conditionedContinuation.newTimelineFrames=24*44100,
  m=>m.conditionedContinuation.padding=true,m=>m.conditionedContinuation.conditioningCorrelation=.8,
  m=>m.conditionedContinuation.bitIdenticalPrefixClaimed=true,m=>m.contextMatchesCurrentTail=false,
  m=>m.transition.conditionedContinuationSha256='0'.repeat(64),m=>m.transition.overlapFrames=0,
  m=>m.transition.renderMetrics.truePeakDbtp=0,m=>m.transition.renderMetrics.bassDoubleOwnershipFrames=1]){
  const q=factory({verifyProvenance:providerOrigin,inspectAudio:async r=>{const m=await measure(r);mutate(m);return m;}});
  assert.equal((await q.audio(input)).media.status,'HOLD');
 }
});
