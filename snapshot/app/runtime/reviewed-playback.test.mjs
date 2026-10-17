import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {sharedPCMContract,verifySharedPCMBridge} from './shared-pcm-bridge.mjs';
import {evaluateTransition,selectBestTransition,renderSpec,transitionDigest} from './dj-transition-selector.mjs';
import {verifyRenderedRoomPlayback} from './rendered-room-playback.mjs';
import {createActualSavedParticipantRooms} from './actual-saved-participant-rooms.mjs';
import {createLocalParticipantRooms} from './local-participant-rooms.mjs';
import {reviewDigest,reviewedTransitionContract,verifyReviewedWindow} from './reviewed-transition.mjs';

// All PCM and QC fields below are synthetic fixtures, never real-track evidence.
const rate=44100,frames=24*rate;
const digest=pcm=>createHash('sha256').update(Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength)).digest('hex');
function profile(sha){return {method:'pcm-endpoint-profile-v1',assetSha256:sha,sampleRate:rate,channels:2,frameCount:frames,rmsDbfs:-18,head:{rmsDbfs:-18,bandFractions:[.4,.4,.2]},tail:{rmsDbfs:-18,bandFractions:[.4,.4,.2]},bpm:{value:null,confidence:'unknown'},key:{value:null,confidence:'unknown'}};}
function fixture(shared=true){
 const a=new Float32Array(frames*2),b=new Float32Array(frames*2);
 for(let i=0;i<frames;i++){a[i*2]=a[i*2+1]=.1*Math.sin(2*Math.PI*220*i/rate);b[i*2]=b[i*2+1]=.08*Math.sin(2*Math.PI*330*i/rate);}
 const begin=13*rate,length=4*rate,exit=(shared?15:23)*rate,entry=(shared?15:1)*rate,overlap=shared?0:2*rate;
 if(shared)b.set(a.subarray(begin*2,(begin+length)*2),begin*2);
 const currentAudio={pcm:a,rate,frames,sha256:digest(a)},incoming={pcm:b,rate,frames,sha256:digest(b)};
 const output=new Float32Array((exit-entry+frames)*2),edit=exit-overlap/2;
 output.set(a.subarray(0,edit*2));output.set(b.subarray((entry+overlap/2)*2),(exit+overlap/2)*2);
 const receipt={method:'rendered-transition-qc-v1',passed:true,bassCollisionManaged:true,loudnessVerified:true,type:shared?'shared-pcm-bridge':'bass-swap',sampleRate:rate,currentSha256:currentAudio.sha256,incomingSha256:incoming.sha256,currentPlaybackRevision:0,currentFrameCount:frames,incomingFrameCount:frames,exitFrame:exit,entryFrame:entry,overlapFrames:overlap,relativeIncomingGainDb:0,timeStretch:false,pitchShift:false,eqCurves:shared?null:[{position:0,outgoingLow:1,incomingLow:0},{position:.49,outgoingLow:1,incomingLow:0},{position:.5,outgoingLow:0,incomingLow:0},{position:.51,outgoingLow:0,incomingLow:1},{position:1,outgoingLow:0,incomingLow:1}],renderedSha256:digest(output),renderedFrameCount:output.length/2,renderQC:{passed:true},renderMetrics:{truePeakDbtp:-1,clippedFraction:0,nonfiniteSamples:0,maxQuietRunSeconds:0,minimumWindowDbfs:-24,maxLevelStepDb:1,seamJump:.01,bassDoubleOwnershipFrames:0,overlapLowBandLiftDb:0,integratedLufs:-16,loudnessRangeLu:2}};
 if(shared){
  let minimum=Infinity;
  for(let start=begin;start<begin+length;start+=4410){let power=0;for(let i=start;i<start+4410;i++)power+=a[i*2]**2+a[i*2+1]**2;minimum=Math.min(minimum,10*Math.log10(power/8820));}
  receipt.sharedPCM={method:'exact-shared-stereo-pcm-v1',sampleFormat:'float32-le-stereo',currentSha256:currentAudio.sha256,incomingSha256:incoming.sha256,sampleRate:rate,channels:2,currentStartFrame:begin,incomingStartFrame:begin,frameCount:length,currentPcmSha256:digest(a.subarray(begin*2,(begin+length)*2)),incomingPcmSha256:digest(b.subarray(begin*2,(begin+length)*2)),minimumWindowDbfs:minimum,exactSampleEquality:true};
 }
 receipt.renderSpecSha256=transitionDigest(renderSpec(receipt));
 const current={clipId:'synthetic-current',sha256:currentAudio.sha256,contextSha256:'a'.repeat(64),profile:profile(currentAudio.sha256),playbackRevision:0,playedUntilFrame:0};
 const candidate={roomId:'synthetic-room',cueId:'synthetic-cue',generationId:'synthetic-generation',controlVersion:1,status:'READY',atomicReady:true,music:{asset:{sha256:incoming.sha256},profile:profile(incoming.sha256),durationSeconds:24,qc:{passed:true},contextVerified:false},video:{qc:{passed:true}}};
 return {current,candidate,pairQC:receipt,mode:'saved',now:1,currentAudio,record:{incoming,receipt,audio:{pcm:output,frames:output.length/2,sha256:receipt.renderedSha256}}};
}
test('exact shared PCM is narrowly eligible offline, with nine retained seconds and no musical confidence',()=>{
 const f=fixture(),plan=evaluateTransition(f);
 assert.equal(verifySharedPCMBridge({current:f.currentAudio,incoming:f.record.incoming,receipt:f.pairQC}).valid,true);
 assert.equal(plan.status,'ELIGIBLE',JSON.stringify(plan.reasons));assert.equal(plan.liveReady,false);assert.equal(plan.evidenceScope,'EXACT_SHARED_PASSAGE_NOT_INDEPENDENT_MIX');assert.equal(plan.transition.netIncomingSeconds,9);
 assert.equal(plan.metrics.keyMeasured,false);assert.equal(plan.metrics.tempoMeasured,false);
 assert.equal(verifyRenderedRoomPlayback({...f,plan}).valid,true);
 assert.equal(verifyRenderedRoomPlayback({...f,plan,manualAudition:true}).valid,false);
});
test('shared samples, duration, gain and silence cannot borrow metadata-only approval',()=>{
 for(const mutate of [f=>f.pairQC.sharedPCM.frameCount=rate,f=>f.pairQC.relativeIncomingGainDb=-1,f=>f.pairQC.sharedPCM.incomingSha256='f'.repeat(64),f=>f.pairQC.sharedPCM.minimumWindowDbfs=-60]){
  const f=fixture();mutate(f);assert.equal(sharedPCMContract(f.pairQC),false);assert.equal(evaluateTransition(f).status,'HOLD');
 }
 const changed=fixture();changed.record.incoming.pcm[13*rate*2+1]+=.001;
 assert.equal(verifySharedPCMBridge({current:changed.currentAudio,incoming:changed.record.incoming,receipt:changed.pairQC}).reason,'SHARED_PCM_SAMPLES_CHANGED');
 const quiet=fixture();quiet.currentAudio.pcm.fill(0);quiet.record.incoming.pcm.fill(0);
 quiet.pairQC.sharedPCM.currentPcmSha256=quiet.pairQC.sharedPCM.incomingPcmSha256=digest(quiet.currentAudio.pcm.subarray(13*rate*2,17*rate*2));
 assert.equal(verifySharedPCMBridge({current:quiet.currentAudio,incoming:quiet.record.incoming,receipt:quiet.pairQC}).reason,'SHARED_PCM_ACTIVITY_REQUIRED');
});
test('shared bridge retains source conflicts, render-QC, stale revision, and frontier gates',()=>{
 for(const mutate of [f=>f.pairQC.renderMetrics.truePeakDbtp=1,f=>f.pairQC.currentPlaybackRevision=1,f=>f.current.playedUntilFrame=16*rate,f=>{f.current.profile.key={value:'C',confidence:'measured',confidenceScore:.9};f.candidate.music.profile.key={value:'F#',confidence:'measured',confidenceScore:.9};},f=>f.mode='provider']){
  const f=fixture();mutate(f);assert.equal(evaluateTransition(f).status,'HOLD');
 }
 const f=fixture(),plan=evaluateTransition(f);f.record.audio.pcm[f.record.audio.pcm.length-1]+=.001;
 assert.equal(verifyRenderedRoomPlayback({...f,plan}).reason,'INCOMING_RENDER_TAIL_CHANGED');
});
test('independent manual audition leaves HOLD and cannot pass the automatic commit guard',()=>{
 const f=fixture(false),plan=evaluateTransition(f);
 assert.equal(plan.status,'HOLD');assert.equal(plan.qualityReady,false);assert.equal(plan.liveReady,false);
 assert.equal(verifyRenderedRoomPlayback({...f,manualAudition:true}).valid,true,JSON.stringify(verifyRenderedRoomPlayback({...f,manualAudition:true})));
 assert.equal(verifyRenderedRoomPlayback({...f,plan}).valid,false);
 f.record.receipt.renderMetrics.truePeakDbtp=1;
 assert.equal(verifyRenderedRoomPlayback({...f,manualAudition:true}).valid,false);
});
function worklet(){let C;const messages=[],scope={AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)};}},sampleRate:rate,currentTime:0,Float32Array,ArrayBuffer,registerProcessor:(_,ctor)=>C=ctor};vm.runInNewContext(readFileSync(new URL('../room-worklet.mjs',import.meta.url),'utf8'),scope);return {q:new C(),messages};}
test('integrated worklet preserves every consumed frame through a nonaligned finite end',()=>{
 const {q,messages}=worklet(),pcm=new Float32Array(777*2);for(let i=0;i<pcm.length;i++)pcm[i]=Math.sin(i)*.1;
 q.message({type:'set-duration',frames:1024});q.message({type:'trace-output'});q.message({type:'chunk',startFrame:0,pcm:pcm.slice(0,1024).buffer});q.message({type:'play'});
 const process=()=>q.process([],[Array.from({length:2},()=>new Float32Array(128))]);process();q.message({type:'bound-duration',frames:511});assert(messages.some(m=>m.error==='INVALID_RENDER_DURATION_BOUND'));
 q.message({type:'bound-duration',frames:777});q.message({type:'trace-frame',frame:384});q.message({type:'chunk',startFrame:512,pcm:pcm.slice(1024).buffer});while(q.playing)process();
 assert.deepEqual(new Float32Array(messages.find(m=>m.playedRender).playedRender.pcm),pcm);assert.equal(q.consumed,777);assert.equal(q.underruns,0);assert.equal(q.queued,0);
});
test('worklet Stop discards unfinished evidence and refuses PCM beyond its finite boundary',()=>{
 const {q,messages}=worklet();q.message({type:'set-duration',frames:512});q.message({type:'trace-output'});q.message({type:'chunk',startFrame:0,pcm:new Float32Array(1024).buffer});q.message({type:'chunk',startFrame:512,pcm:new Float32Array(2).buffer});assert(messages.some(m=>m.error==='PCM_EXCEEDS_FINITE_RENDER'));
 q.message({type:'play'});q.process([],[Array.from({length:2},()=>new Float32Array(128))]);q.message({type:'stop'});assert.equal(q.capture,null);assert.equal(messages.some(m=>m.playedRender),false);
});
test('local saved runtime needs an explicitly supplied motif resolver before reading private files',async()=>{
 await assert.rejects(createActualSavedParticipantRooms({}),/LOCAL_MOTIF_RESOLVER_REQUIRED/);
});
test('nonlocal mode stays unavailable and local wrapper forwards the explicit resolver',async()=>{
 const disabled=await createLocalParticipantRooms({kind:'provider'});assert.equal(disabled.available,false);
 assert.equal(await disabled.handle(),false);assert.equal(disabled.hasHost(),false);
 await assert.rejects(createLocalParticipantRooms({root:new URL('./absent-synthetic-fixture/',import.meta.url).pathname,resolveMotifSnapshot:()=>{}}),error=>error.code==='ENOENT');
});

function sealReview(q){
 const v=q.reviewedTransition,f=v.feedback;delete f.feedbackSha256;f.feedbackSha256=reviewDigest(f);delete v.receiptSha256;v.receiptSha256=reviewDigest(v);
}
function reviewedFixture(){
 const f=fixture(false),q=f.pairQC,start=18*rate,count=10*rate;
 const snippet=f.record.audio.pcm.slice(start*2,(start+count)*2);
 f.record.reviewSnippet={pcm:snippet,rate,frames:count,sha256:digest(snippet)};
 const approval={variantLabel:'A',currentSha256:q.currentSha256,incomingSha256:q.incomingSha256,renderedSha256:q.renderedSha256,renderSpecSha256:q.renderSpecSha256,snippetSha256:digest(snippet),snippetPcmSha256:digest(snippet),snippetStartFrame:start,snippetFrameCount:count,libraryFileId:'libfile_synthetic_test_only'};
 q.reviewedTransition={...approval,method:'exact-user-reviewed-join-v1',feedback:{method:'trusted-user-comparison-feedback-v1',status:'accepted',revoked:false,scope:'exact-presented-transition-windows',sourceMessageId:'Sentinel_synthetic_test_only',quote:'Synthetic fixture approval, never a real user assessment',preferredLabel:null,comparisonSha256:'c'.repeat(64),acceptedLabels:['A','B'],approvals:[structuredClone(approval)]},phase:{method:'cross-method-local-phase-v1',currentSha256:q.currentSha256,incomingSha256:q.incomingSha256,calibrated:false,periodSeconds:.5,longContextMaxErrorSeconds:.01,checks:['original','gain-minus6db','crop137ms','dp-full','dp-percussive'].map(method=>({method,fullWindowCovered:true,currentBeatCount:10,maximumRelativeErrorSeconds:.01}))}};
 sealReview(q);return f;
}
test('exact server-curated synthetic review permits only its saved join without promoting key or phrase',()=>{
 const f=reviewedFixture(),plan=evaluateTransition(f);
 assert.equal(reviewedTransitionContract(f.pairQC),true);assert.equal(plan.status,'ELIGIBLE',JSON.stringify(plan.reasons));
 assert.equal(plan.evidenceScope,'EXACT_USER_REVIEWED_TRANSITION');assert.equal(plan.liveReady,false);
 assert.equal(plan.metrics.keyMeasured,false);assert.equal(plan.metrics.tempoMeasured,false);assert.equal(plan.metrics.modelConfidencePromoted,false);assert.equal(plan.transition.phraseVerified,false);
 assert.equal(verifyReviewedWindow({current:f.currentAudio,incoming:f.record.incoming,record:f.record}).valid,true);
 assert.equal(verifyRenderedRoomPlayback({...f,plan}).valid,true);assert.equal(verifyRenderedRoomPlayback({...f,plan,manualAudition:true}).valid,false);
 assert.equal(evaluateTransition({...f,mode:'provider'}).status,'HOLD');
 delete f.pairQC.reviewedTransition;assert.equal(evaluateTransition(f).status,'HOLD');
});
test('revoked, broad, ranked, or unmatched feedback stays HOLD even after resealing its hash',()=>{
 for(const mutate of [v=>v.feedback.revoked=true,v=>v.feedback.status='pending',v=>v.feedback.scope='all-tracks',v=>v.feedback.preferredLabel='A',v=>v.feedback.quote='',v=>v.feedback.acceptedLabels=[],v=>v.feedback.approvals[0].incomingSha256='f'.repeat(64)]){
  const f=reviewedFixture();mutate(f.pairQC.reviewedTransition);sealReview(f.pairQC);
  assert.equal(reviewedTransitionContract(f.pairQC),false);assert.equal(evaluateTransition(f).status,'HOLD');
 }
});
test('review cannot waive independent timing coverage, source conflicts or physical QC',()=>{
 for(const mutate of [f=>f.pairQC.reviewedTransition.phase.checks[3].maximumRelativeErrorSeconds=.2,f=>f.pairQC.reviewedTransition.phase.checks[2].fullWindowCovered=false,f=>f.pairQC.reviewedTransition.phase.periodSeconds=.01,f=>f.pairQC.renderMetrics.truePeakDbtp=1,f=>f.pairQC.currentPlaybackRevision=1,f=>f.current.playedUntilFrame=24*rate,f=>{f.current.profile.key={value:'C',confidence:'measured',confidenceScore:.9};f.candidate.music.profile.key={value:'F#',confidence:'measured',confidenceScore:.9};}]){
  const f=reviewedFixture();mutate(f);sealReview(f.pairQC);assert.equal(evaluateTransition(f).status,'HOLD');
 }
});
test('heard-window bytes, source identity and final render bounds cannot reuse a reviewed receipt',()=>{
 const f=reviewedFixture(),plan=evaluateTransition(f);f.record.reviewSnippet.pcm[100]+=.001;
 assert.equal(verifyRenderedRoomPlayback({...f,plan}).reason,'REVIEWED_SNIPPET_CHANGED');
 const g=reviewedFixture();g.currentAudio.sha256='f'.repeat(64);assert.equal(verifyReviewedWindow({current:g.currentAudio,incoming:g.record.incoming,record:g.record}).valid,false);
 const h=reviewedFixture();h.record.audio.frames=20*rate;assert.equal(verifyReviewedWindow({current:h.currentAudio,incoming:h.record.incoming,record:h.record}).valid,false);
});
test('reviewed nonoverlap uses its own bound render and cost without inventing a human preference',()=>{
 const a=reviewedFixture(),b=reviewedFixture(),q=b.pairQC;
 Object.assign(q,{type:'reviewed-nonoverlap-cut',overlapFrames:0,seamDeclickFrames:352,eqCurves:null});
 const pcm=new Float32Array(q.renderedFrameCount*2);
 pcm.set(b.currentAudio.pcm.subarray(0,q.exitFrame*2));pcm.set(b.record.incoming.pcm.subarray(q.entryFrame*2),q.exitFrame*2);
 b.record.audio.pcm=pcm;b.record.audio.sha256=q.renderedSha256=digest(pcm);q.renderSpecSha256=transitionDigest(renderSpec(q));
 const v=q.reviewedTransition,window=pcm.slice(v.snippetStartFrame*2,(v.snippetStartFrame+v.snippetFrameCount)*2);
 b.record.reviewSnippet.pcm=window;b.record.reviewSnippet.sha256=digest(window);
 Object.assign(v,{variantLabel:'B',renderedSha256:q.renderedSha256,renderSpecSha256:q.renderSpecSha256,snippetSha256:digest(window),snippetPcmSha256:digest(window)});
 Object.assign(v.feedback.approvals[0],{variantLabel:'B',renderedSha256:v.renderedSha256,renderSpecSha256:v.renderSpecSha256,snippetSha256:v.snippetSha256,snippetPcmSha256:v.snippetPcmSha256});sealReview(q);
 q.renderMetrics.seamJump=.001;
 const plan=evaluateTransition(b);assert.equal(plan.status,'ELIGIBLE',JSON.stringify(plan.reasons));assert.equal(plan.transition.overlapFrames,0);
 assert.equal(verifyRenderedRoomPlayback({...b,plan}).valid,true);
 const selected=selectBestTransition([evaluateTransition(a),plan],{nearEqualTolerance:0}).selected;
 assert.equal(selected.reviewedTransition.variantLabel,'B');assert.equal(selected.reviewedTransition.feedback.preferredLabel,null);
 q.seamDeclickFrames=884;assert.equal(evaluateTransition(b).status,'HOLD');
});
