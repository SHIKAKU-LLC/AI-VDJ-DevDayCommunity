import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTransition, selectBestTransition, supplyPlan, renderSpec, transitionDigest, validatePlanAtCommit} from './dj-transition-selector.mjs';
const sha = s => s.repeat(64);
const measured = value => ({value, confidence:'measured', confidenceScore:.95});
function fixture() {
  const profile = h => ({method:'pcm-endpoint-profile-v1', assetSha256:h, sampleRate:44100, channels:2, frameCount:1058400,
    rmsDbfs:-18, head:{rmsDbfs:-18, bandFractions:[.4,.4,.2]}, tail:{rmsDbfs:-18, bandFractions:[.4,.4,.2]},
    bpm:measured(140), key:measured('8A')});
  const current = {clipId:'A', sha256:sha('a'), contextSha256:sha('c'), profile:profile(sha('a')), playbackRevision:2, playedUntilFrame:1000};
  const candidate = {roomId:'r', cueId:'B', generationId:'g', controlVersion:3, readyAtMs:0, contribution:{participantId:'p'},
    atomicReady:true, status:'READY', music:{durationSeconds:24,qc:{passed:true}, asset:{sha256:sha('b')}, profile:profile(sha('b')),
      parentClipId:'A', contextSha256:sha('c'), contextVerified:true, continuationVerified:true}, video:{qc:{passed:true}}};
  const pairQC = {method:'rendered-transition-qc-v1', timeStretch:false, pitchShift:false, passed:true, currentSha256:sha('a'), incomingSha256:sha('b'), currentPlaybackRevision:2,
    currentFrameCount:1058400, incomingFrameCount:1058400, sampleRate:44100, type:'bass-swap', entryFrame:44100, exitFrame:1014300,
    overlapFrames:88200, relativeIncomingGainDb:0, eqCurves:[{position:0,outgoingLow:1,incomingLow:0},
      {position:.49,outgoingLow:1,incomingLow:0},{position:.5,outgoingLow:0,incomingLow:0},
      {position:.51,outgoingLow:0,incomingLow:1},{position:1,outgoingLow:0,incomingLow:1}],
    beatGridVerified:true, downbeatVerified:true, phraseVerified:true, beatConfidence:.95, downbeatConfidence:.95, phraseConfidence:.95,
    beatPhaseError:.01, bassCollisionManaged:true, loudnessVerified:true, renderedSha256:sha('d'), renderedFrameCount:2072700,
    renderQC:{passed:true}, renderMetrics:{truePeakDbtp:-1, clippedFraction:0, nonfiniteSamples:0, maxQuietRunSeconds:0,
      minimumWindowDbfs:-24, maxLevelStepDb:1, seamJump:.01, bassDoubleOwnershipFrames:0, overlapLowBandLiftDb:0, integratedLufs:-16,loudnessRangeLu:2}};
  pairQC.renderedFrameCount = pairQC.exitFrame - pairQC.entryFrame + candidate.music.profile.frameCount;
  pairQC.renderSpecSha256 = transitionDigest(renderSpec(pairQC));
  return {current,candidate,pairQC,mode:'provider',now:1000};
}
const evaluate = mutate => {const f=fixture(); mutate?.(f); return evaluateTransition(f);};
function native(f) {Object.assign(f.pairQC, {type:'native-continuation', entryFrame:0, exitFrame:f.current.profile.frameCount,
  overlapFrames:0, eqCurves:null, nativeContinuationVerified:true, parentSha256:f.current.sha256,
  contextSha256:f.current.contextSha256, contextAnchorFrame:f.current.profile.frameCount, renderedFrameCount:2116800,
  beatGridVerified:false, downbeatVerified:false, phraseVerified:false, beatPhaseError:null});
  f.pairQC.renderSpecSha256=transitionDigest(renderSpec(f.pairQC));}
const held = (p, reason) => {assert.equal(p.status,'HOLD'); assert.equal(p.liveReady,false); assert.ok(p.reasons.includes(reason), p.reasons.join(','));};

test('verified rendered bass swap is eligible and actual net supply uses geometry',()=>{const p=evaluate();assert.equal(p.status,'ELIGIBLE');assert.equal(p.liveReady,true);assert.equal(p.transition.netIncomingSeconds,22);});
test('legacy fixture exact continuation remains usable without live claims',()=>{const p=evaluate(f=>{f.mode='fixture';f.pairQC=null;f.candidate.music.profile.bpm.value=null;});assert.equal(p.status,'ELIGIBLE');assert.equal(p.liveReady,false);});
test('booleans alone cannot authorize LIVE',()=>held(evaluate(f=>delete f.pairQC.renderMetrics),'ACTUAL_RENDER_QC_REQUIRED'));
test('short prepared material or a24s relabel cannot become atomic cue',()=>{held(evaluate(f=>{f.candidate.music.durationSeconds=20;f.candidate.music.profile.frameCount=882000;}),'INCOMING_CUE_DURATION_REQUIRED');held(evaluate(f=>f.candidate.music.profile.frameCount=882000),'INCOMING_CUE_DURATION_REQUIRED');});
test('unreported stretching or pitch shifts cannot authorize LIVE',()=>{held(evaluate(f=>f.pairQC.timeStretch=true),'ACTUAL_RENDER_QC_REQUIRED');held(evaluate(f=>delete f.pairQC.pitchShift),'ACTUAL_RENDER_QC_REQUIRED');});
test('wrong SHA/revision harmonic waiver cannot bypass key clash',()=>{const p=evaluate(f=>{f.pairQC.currentSha256=sha('e');f.pairQC.harmonicCompatibilityVerified=true;f.candidate.music.profile.key=measured('2A');});held(p,'HARMONIC_INCOMPATIBLE');held(p,'STALE_OR_UNBOUND_PAIR_QC');});
test('failed QC wins over matching tempo/key and exact parent',()=>held(evaluate(f=>f.pairQC.passed=false),'PAIR_QC_FAILED'));
test('stale revision is held even for a native continuation',()=>held(evaluate(f=>{native(f);f.pairQC.currentPlaybackRevision=1;}),'STALE_OR_UNBOUND_PAIR_QC'));
test('genuine native seam may retain unknown key without a long overlap',()=>{const p=evaluate(f=>{native(f);f.current.profile.key={value:null,confidence:'unknown'};f.candidate.music.profile.key={value:null,confidence:'unknown'};});assert.equal(p.liveReady,true);assert.equal(p.transition.overlapFrames,0);assert.equal(p.selectionReason,'VERIFIED_NATIVE_CONTINUATION_SEAM');});
test('uncertain octave proxy does not block a verified zero-overlap native seam',()=>{const p=evaluate(f=>{native(f);f.current.profile.bpm={value:70,confidence:'proxy',confidenceScore:.4,octaveAmbiguous:true};});assert.equal(p.liveReady,true);});
test('native declick must bind rendering and its earlier editable frontier',()=>{const f=fixture();native(f);f.pairQC.seamDeclickFrames=882;f.pairQC.renderSpecSha256=transitionDigest(renderSpec(f.pairQC));let p=evaluateTransition(f);assert.equal(p.liveReady,true);assert.equal(p.transition.editStartFrame,f.current.profile.frameCount-441);f.current.playedUntilFrame=p.transition.editStartFrame+1;held(evaluateTransition(f),'PLAYBACK_FRONTIER_NOT_EDITABLE');assert.equal(validatePlanAtCommit(p,f).valid,false);});
test('siblings after B are never B native continuation',()=>{const p=evaluate(f=>{native(f);f.current.clipId='B';f.current.sha256=sha('e');f.current.profile.assetSha256=sha('e');f.pairQC.currentSha256=sha('e');f.current.profile.key={value:null,confidence:'unknown'};});held(p,'NATIVE_PARENT_CONTEXT_ANCHOR_MISMATCH');assert.equal(p.contextRelationship,'REEVALUATED_CROSS_CONTEXT');});
test('native seam needs actual parent/context/anchor evidence',()=>{for(const k of ['parentSha256','contextSha256','contextAnchorFrame'])held(evaluate(f=>{native(f);delete f.pairQC[k];}),'NATIVE_PARENT_CONTEXT_ANCHOR_MISMATCH');});
test('different parent with measured tempo/key and actual rerender remains general eligible',()=>{const p=evaluate(f=>f.candidate.music.parentClipId='other');assert.equal(p.liveReady,true);assert.equal(p.contextRelationship,'REEVALUATED_CROSS_CONTEXT');});
test('known tempo and key conflicts cannot hide behind native lineage',()=>{held(evaluate(f=>{native(f);f.candidate.music.profile.bpm=measured(70);}), 'TEMPO_INCOMPATIBLE_NO_TIME_STRETCH');held(evaluate(f=>{native(f);f.candidate.music.profile.key=measured('2A');}), 'HARMONIC_INCOMPATIBLE');});
test('half/double ambiguity and low confidence grid cannot qualify',()=>{held(evaluate(f=>f.candidate.music.profile.bpm.octaveAmbiguous=true),'TEMPO_HALF_DOUBLE_AMBIGUITY');held(evaluate(f=>f.pairQC.beatConfidence=.3),'CONFIDENT_BEAT_DOWNBEAT_PHRASE_QC_REQUIRED');});
test('effective silence within a loud clip, incoming quiet and clipped source are fatal',()=>{held(evaluate(f=>f.candidate.music.profile.activity={maxQuietRunSeconds:1}), 'SOURCE_EFFECTIVE_SILENCE');held(evaluate(f=>f.candidate.music.profile.head.rmsDbfs=-70),'INCOMING_QUIET_SECTION_HOLD');held(evaluate(f=>f.candidate.music.profile.clippedFraction=.02),'SOURCE_CLIP_OR_NONFINITE');});
test('all render fatal gates are independent of scoring',()=>{for(const [k,v] of [['truePeakDbtp',.1],['clippedFraction',.001],['maxQuietRunSeconds',1],['minimumWindowDbfs',-90],['maxLevelStepDb',12],['seamJump',.8],['nonfiniteSamples',1],['bassDoubleOwnershipFrames',1],['integratedLufs',NaN]])held(evaluate(f=>f.pairQC.renderMetrics[k]=v),'ACTUAL_RENDER_QC_REQUIRED');});
test('EQ nodes must prevent interpolated double ownership, not just node overlap',()=>held(evaluate(f=>{f.pairQC.eqCurves=[{position:0,outgoingLow:1,incomingLow:0},{position:.5,outgoingLow:0,incomingLow:1},{position:1,outgoingLow:0,incomingLow:1}];f.pairQC.renderSpecSha256=transitionDigest(renderSpec(f.pairQC));}),'SINGLE_BASS_OWNER_AND_LOUDNESS_QC_REQUIRED'));
test('plan geometry mutation, odd/negative/overflow frames, and fabricated duration held',()=>{for(const [k,v] of [['overlapFrames',-1],['overlapFrames',5],['entryFrame',0],['exitFrame',1058401],['sampleRate',48000],['currentFrameCount',100]])held(evaluate(f=>f.pairQC[k]=v),'INVALID_SOURCE_FRAME_GEOMETRY');held(evaluate(f=>f.pairQC.renderedFrameCount=1),'ACTUAL_RENDER_QC_REQUIRED');held(evaluate(f=>f.pairQC.relativeIncomingGainDb=1),'ACTUAL_RENDER_QC_REQUIRED');});
test('late cue uses start of centered overlap as editable frontier',()=>held(evaluate(f=>f.current.playedUntilFrame=f.pairQC.exitFrame-f.pairQC.overlapFrames/2+1),'PLAYBACK_FRONTIER_NOT_EDITABLE'));
test('NaN phase and profile malformed data do not crash or qualify',()=>{held(evaluate(f=>f.pairQC.beatPhaseError=NaN),'CONFIDENT_BEAT_DOWNBEAT_PHRASE_QC_REQUIRED');held(evaluate(f=>f.candidate.music.profile.head.bandFractions=[1,1,1]),'MEASURED_AUDIO_PROFILE_REQUIRED');});
test('measured source true peak and unverified local harmony are held',()=>{held(evaluate(f=>f.candidate.music.profile.loudness={truePeakDbtp:.7}),'SOURCE_TRUE_PEAK_HOLD');held(evaluate(f=>{f.candidate.music.profile.key=measured('2A');f.pairQC.harmonicCompatibilityVerified=true;}),'HARMONIC_INCOMPATIBLE');});
test('reserved cue revalidation works only for the matching room reservation',()=>{const f=fixture(),p=evaluateTransition(f);f.candidate.status='SELECTED';assert.equal(validatePlanAtCommit(p,f).valid,false);assert.equal(validatePlanAtCommit(p,{...f,reservedCueId:p.cueId}).valid,true);f.current.contextSha256=sha('f');assert.equal(validatePlanAtCommit(p,{...f,reservedCueId:p.cueId}).valid,false);});
test('commit revalidation catches source changes, frontier motion and tampering',()=>{const f=fixture(),p=evaluateTransition(f);assert.equal(validatePlanAtCommit(p,f).valid,true);f.current.playbackRevision++;assert.equal(validatePlanAtCommit(p,f).reason,'SOURCE_OR_CUE_CHANGED');f.current.playbackRevision--;f.current.playedUntilFrame=1050000;assert.equal(validatePlanAtCommit(p,f).reason,'PLAYBACK_FRONTIER_NOT_EDITABLE');p.transition.entryFrame++;assert.equal(validatePlanAtCommit(p,f).reason,'PLAN_MUTATED');});
test('hard failures and waiting time never compensate with favorable score/fairness',()=>{const good=evaluate(),bad=evaluate(f=>f.pairQC.renderMetrics.truePeakDbtp=1);bad.smoothnessCost=-100;bad.readyAtMs=-500000;const s=selectBestTransition([bad,good],{now:1000});assert.equal(s.selected,good);assert.equal(s.starvation.length,1);});
test('fairness only breaks near equal candidates',()=>{const a=evaluate(),b=evaluate();a.smoothnessCost=.1;b.smoothnessCost=.5;b.contribution.participantId='new';assert.equal(selectBestTransition([a,b],{lastParticipantId:'p',nearEqualTolerance:10}).selected,a);b.smoothnessCost=.101;assert.equal(selectBestTransition([a,b],{lastParticipantId:'p'}).selected,b);});
test('140BPM bars,24s source net, previous/future overlap capacity are exact',()=>{assert.ok(Math.abs(supplyPlan({cueSeconds:24,overlapSeconds:16*60/140}).netSeconds-17.142857142857142)<1e-9);assert.ok(Math.abs(supplyPlan({cueSeconds:64*60/140,overlapSeconds:16*60/140}).netSeconds-20.571428571428573)<1e-9);assert.throws(()=>supplyPlan({cueSeconds:24,overlapSeconds:14,priorOverlapSeconds:10}),/INVALID/);});

test('CURRENT/incoming measured nonoverlap needs exact pair/revision/render and never claims musical grid or native lineage',()=>{
 const build=()=>{const f=fixture();native(f);f.candidate.music.parentClipId='old-parent';
  for(const p of [f.current.profile,f.candidate.music.profile]){p.bpm={value:70,confidence:'proxy',confidenceScore:.4,octaveAmbiguous:true};p.key={value:null,confidence:'unknown'};}
  Object.assign(f.pairQC,{type:'measured-nonoverlap-cut',nativeContinuationVerified:false,seamDeclickFrames:882,
   measuredCutPolicy:'objective-nonoverlap-no-musical-grid-claim-v1'});f.pairQC.renderSpecSha256=transitionDigest(renderSpec(f.pairQC));return f;};
 const f=build(),plan=evaluateTransition(f);assert.equal(plan.status,'ELIGIBLE');assert.equal(plan.transition.measuredCutVerified,true);
 assert.equal(plan.transition.nativeContinuationVerified,false);assert.equal(plan.transition.beatGridVerified,false);
 assert.equal(plan.contextRelationship,'PAIR_SPECIFIC_NONOVERLAP_CUT');
 for(const mutate of [x=>x.pairQC.currentSha256=sha('f'),x=>x.pairQC.currentPlaybackRevision++,x=>delete x.pairQC.measuredCutPolicy,
  x=>x.pairQC.overlapFrames=88200,x=>x.pairQC.beatGridVerified=true,x=>x.pairQC.renderMetrics.seamJump=.2,
  x=>x.pairQC.renderMetrics.maxQuietRunSeconds=.2,x=>x.pairQC.renderMetrics.truePeakDbtp=0,
  x=>x.current.playedUntilFrame=x.current.profile.frameCount]){
  const x=build();mutate(x);const p=evaluateTransition(x);assert.equal(p.status,'HOLD');assert.equal(p.liveReady,false);
 }
});
test('measured 3s crossfade through a faded tail is eligible without a musical-grid claim; contract and bass owner are enforced',()=>{
 const N=3*44100,curves=[{position:0,outgoingLow:1,incomingLow:0},{position:.5-.01*44100/N,outgoingLow:1,incomingLow:0},
  {position:.5,outgoingLow:0,incomingLow:0},{position:.5+.01*44100/N,outgoingLow:0,incomingLow:1},{position:1,outgoingLow:0,incomingLow:1}];
 const build=()=>{const f=fixture();native(f);f.candidate.music.parentClipId='old-parent';
  for(const p of [f.current.profile,f.candidate.music.profile]){p.bpm={value:70,confidence:'proxy',confidenceScore:.4,octaveAmbiguous:true};p.key={value:null,confidence:'unknown'};}
  // Generated outgoing Cue fades out: its last 2s are far quieter than the incoming head.
  f.current.profile.tail.rmsDbfs=-33;f.candidate.music.profile.head.rmsDbfs=-23;
  Object.assign(f.pairQC,{type:'measured-overlap-crossfade',measuredCrossfadePolicy:'objective-overlap-crossfade-no-musical-grid-claim-v1',
   nativeContinuationVerified:false,overlapFrames:N,entryFrame:N/2,exitFrame:f.current.profile.frameCount-N/2,eqCurves:curves});
  delete f.pairQC.seamDeclickFrames;f.pairQC.renderedFrameCount=f.pairQC.exitFrame-f.pairQC.entryFrame+f.candidate.music.profile.frameCount;
  f.pairQC.renderSpecSha256=transitionDigest(renderSpec(f.pairQC));return f;};
 const f=build(),plan=evaluateTransition(f);
 assert.equal(plan.status,'ELIGIBLE',plan.reasons.join(','));assert.equal(plan.liveReady,true);
 assert.equal(plan.transition.measuredCutVerified,true,'shares the measured-pair path');assert.equal(plan.transition.beatGridVerified,false);
 assert.equal(plan.contextRelationship,'PAIR_SPECIFIC_OVERLAP_CROSSFADE');
 assert.equal(plan.transition.editStartFrame,f.current.profile.frameCount-N,'the edit begins where the overlap starts');
 for(const mutate of [x=>delete x.pairQC.measuredCrossfadePolicy,x=>{x.pairQC.entryFrame=0;},
  x=>{x.pairQC.eqCurves=[{position:0,outgoingLow:1,incomingLow:0},{position:.5,outgoingLow:0,incomingLow:1},{position:1,outgoingLow:0,incomingLow:1},{position:1,outgoingLow:0,incomingLow:1},{position:1,outgoingLow:0,incomingLow:1}];},
  x=>x.pairQC.renderMetrics.maxLevelStepDb=7,x=>x.pairQC.overlapFrames=N*2,x=>x.pairQC.beatGridVerified=true,
  x=>x.current.playedUntilFrame=x.current.profile.frameCount-N+1]){
  const x=build();mutate(x);x.pairQC.renderSpecSha256=transitionDigest(renderSpec(x.pairQC));
  const p=evaluateTransition(x);assert.equal(p.status,'HOLD');assert.equal(p.liveReady,false);
 }
});
