import {createHash} from 'node:crypto';
import {sharedPCMContract} from './shared-pcm-bridge.mjs';
import {reviewedTransitionContract} from './reviewed-transition.mjs';
import {measuredCutContract,measuredCrossfadeContract} from './measured-cut.mjs';
import {validConditionedContinuation} from '../../../integration/qc/conditioned-continuation.mjs';

const finite = Number.isFinite;
const frame = n => Number.isSafeInteger(n) && n >= 0;
const hash = h => /^[a-f0-9]{64}$/.test(h ?? '');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const transitionDigest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const DJ_STRATEGY = 'measured-render-transition-rules-v2';
const confident = v => v?.confidence === 'measured' && finite(v.confidenceScore) && v.confidenceScore >= .8 && v.confidenceScore <= 1;
const tempo = v => confident(v) && finite(v.value) && v.value >= 40 && v.value <= 300 && v.octaveAmbiguous !== true;
const key = v => confident(v) && typeof v.value === 'string' && v.value.trim().length > 0;
const profileValid = (p, sha) => p?.method === 'pcm-endpoint-profile-v1' && p.assetSha256 === sha
  && p.sampleRate === 44100 && p.channels === 2 && finite(p.rmsDbfs)
  && [p.head, p.tail].every(w => finite(w?.rmsDbfs) && Array.isArray(w.bandFractions)
    && w.bandFractions.length === 3 && w.bandFractions.every(x => finite(x) && x >= 0 && x <= 1)
    && Math.abs(w.bandFractions.reduce((a, b) => a + b, 0) - 1) <= .02);

// These are trusted DSP receipts, never participant input. A SHA is a binding,
// not a signature: inspectJoin must obtain the measurements on the server.
export function renderSpec(q) {
  return {type:q?.type, entryFrame:q?.entryFrame, exitFrame:q?.exitFrame,
    overlapFrames:q?.overlapFrames, sampleRate:q?.sampleRate,
    relativeIncomingGainDb:q?.relativeIncomingGainDb, eqCurves:q?.eqCurves ?? null,
    ...(q?.seamDeclickFrames === undefined ? {} : {seamDeclickFrames:q.seamDeclickFrames})};
}
function geometry(q, currentFrames, incomingFrames) {
  const declick=q?.seamDeclickFrames??0;
  return q?.sampleRate === 44100 && frame(q.entryFrame) && frame(q.exitFrame)
    && frame(q.overlapFrames) && q.overlapFrames % 2 === 0
    && frame(currentFrames) && currentFrames > 0 && frame(incomingFrames) && incomingFrames > 0
    && q.currentFrameCount === currentFrames && q.incomingFrameCount === incomingFrames
    && frame(declick) && declick%2===0 && declick<=882 && (!declick || ['native-continuation','reviewed-nonoverlap-cut','measured-nonoverlap-cut'].includes(q.type) && q.overlapFrames===0)
    && q.entryFrame >= q.overlapFrames / 2 && q.exitFrame >= q.overlapFrames / 2
    && q.exitFrame + q.overlapFrames / 2 <= currentFrames
    && q.entryFrame + q.overlapFrames / 2 < incomingFrames
    && declick/2<=Math.min(q.exitFrame,incomingFrames-q.entryFrame);
}
function singleBassOwner(curves) {
  if (!Array.isArray(curves) || curves.length < 3 || curves[0]?.position !== 0 || curves.at(-1)?.position !== 1) return false;
  return curves.every((p, i) => finite(p.position) && p.position >= 0 && p.position <= 1
    && [p.outgoingLow, p.incomingLow].every(x => finite(x) && x >= 0 && x <= 1)
    && p.outgoingLow * p.incomingLow === 0
    && (!i || p.position > curves[i - 1].position
      && !(curves[i - 1].outgoingLow > 0 && p.incomingLow > 0)
      && !(curves[i - 1].incomingLow > 0 && p.outgoingLow > 0)))
    && curves[0].outgoingLow === 1 && curves.at(-1).incomingLow === 1;
}
function renderValid(q, policy) {
  const m = q?.renderMetrics;
  return q?.method === 'rendered-transition-qc-v1' && hash(q.renderedSha256)
    && q.timeStretch === false && q.pitchShift === false
    && q.renderSpecSha256 === transitionDigest(renderSpec(q)) && q.renderQC?.passed === true
    && frame(q.renderedFrameCount) && q.renderedFrameCount > 0
    && m && finite(m.truePeakDbtp) && m.truePeakDbtp <= (policy.maxTruePeakDbtp ?? -.3)
    && finite(m.clippedFraction) && m.clippedFraction === 0
    && finite(m.maxQuietRunSeconds) && m.maxQuietRunSeconds >= 0 && m.maxQuietRunSeconds <= (policy.maxQuietRunSeconds ?? .15)
    && finite(m.minimumWindowDbfs) && m.minimumWindowDbfs >= (policy.minimumRenderDbfs ?? -45)
    && finite(m.maxLevelStepDb) && m.maxLevelStepDb >= 0 && m.maxLevelStepDb <= (policy.maxRenderLevelStepDb ?? 6)
    && finite(m.seamJump) && m.seamJump >= 0 && m.seamJump <= (policy.maxSeamJump ?? .15)
    && m.nonfiniteSamples === 0 && m.bassDoubleOwnershipFrames === 0
    && finite(m.overlapLowBandLiftDb) && m.overlapLowBandLiftDb <= (policy.maxLowBandLiftDb ?? 3)
    && finite(m.integratedLufs) && finite(m.loudnessRangeLu);
}

export function evaluateTransition({current, candidate, policy = {}, mode = 'fixture', pairQC = null, now = Date.now()}) {
  const reasons = [], c = candidate, m = c?.music, p = current?.profile, q = m?.profile;
  const add = why => { if (!reasons.includes(why)) reasons.push(why); };
  const exactParent = typeof current?.clipId === 'string' && hash(current?.contextSha256)
    && m?.parentClipId === current.clipId && m.contextSha256 === current.contextSha256
    && m.contextVerified === true && (m.continuationVerified === true || mode === 'saved' && m.savedContinuityVerified === true || mode === 'fixture' && m.fixtureBinding === true);
  const pairIdentity = hash(current?.sha256) && hash(m?.asset?.sha256)
    && pairQC?.currentSha256 === current.sha256 && pairQC.incomingSha256 === m.asset.sha256;
  const pairBound = pairIdentity && pairQC.currentPlaybackRevision === current?.playbackRevision && pairQC.passed === true;
  const measuredCrossfade=mode==='provider'&&pairBound&&measuredCrossfadeContract(pairQC)&&singleBassOwner(pairQC.eqCurves);
  // Both objective measured joins share the measured-pair path downstream.
  const measuredCut=mode==='provider'&&pairBound&&measuredCutContract(pairQC)||measuredCrossfade;
  const shared = mode === 'saved' && pairBound && sharedPCMContract(pairQC);
  const reviewed = mode === 'saved' && pairBound && reviewedTransitionContract(pairQC);
  if(pairQC?.reviewedTransition&&!reviewed)add('REVIEW_EVIDENCE_NOT_BOUND');
  if(pairQC?.type==='reviewed-nonoverlap-cut'&&!reviewed)add('EXACT_USER_REVIEW_REQUIRED');
  if (!['fixture', 'provider', 'saved'].includes(mode)) add('INVALID_DJ_MODE');
  if (!c?.atomicReady || c.status !== 'READY' || m?.qc?.passed !== true || c.video?.qc?.passed !== true
      || !hash(current?.sha256) || !hash(m?.asset?.sha256)) add('ATOMIC_READY_AND_ACTUAL_SHA_REQUIRED');
  if (!profileValid(p, current?.sha256) || !profileValid(q, m?.asset?.sha256)) add('MEASURED_AUDIO_PROFILE_REQUIRED');
  if (!frame(current?.playbackRevision)) add('ACTUAL_PLAYBACK_REVISION_REQUIRED');
  if (['provider','saved'].includes(mode) && (!finite(m?.durationSeconds) || !frame(q?.frameCount)
    || Math.abs(q.frameCount / 44100 - m.durationSeconds) > 1 / 44100
    || Math.abs(m.durationSeconds - (policy.cueSeconds ?? 24)) > .15)) add('INCOMING_CUE_DURATION_REQUIRED');
  if (pairQC && !pairBound) add(pairIdentity && pairQC.passed === false ? 'PAIR_QC_FAILED' : 'STALE_OR_UNBOUND_PAIR_QC');
  const bpmKnown = tempo(p?.bpm) && tempo(q?.bpm), keyKnown = key(p?.key) && key(q?.key);
  const bpmGap = bpmKnown ? Math.abs(p.bpm.value - q.bpm.value) : null;
  const localHarmony = pairBound && pairQC.harmonicCompatibilityVerified === true
    && pairQC.harmonicScope === 'rendered-overlap' && finite(pairQC.harmonicConfidence) && pairQC.harmonicConfidence >= .8 && pairQC.harmonicConfidence <= 1;
  const keyCompatible = keyKnown && (p.key.value === q.key.value || localHarmony);
  const tempoAmbiguous = p?.bpm?.octaveAmbiguous === true || q?.bpm?.octaveAmbiguous === true || pairQC?.tempoOctaveAmbiguous === true;
  if (bpmKnown && bpmGap > (policy.maxBpmGap ?? 1)) add('TEMPO_INCOMPATIBLE_NO_TIME_STRETCH');
  if (keyKnown && !keyCompatible) add('HARMONIC_INCOMPATIBLE');
  if (!exactParent) {
    if ((!bpmKnown || !keyKnown) && !shared && !reviewed && !measuredCut) add('OLD_PARENT_OR_INDEPENDENT_UNKNOWN_TEMPO_KEY');
    if (!pairBound) add('PAIR_SPECIFIC_JOIN_QC_REQUIRED');
  }
  const profileOK = profileValid(p, current?.sha256) && profileValid(q, m?.asset?.sha256);
  const levelGap = profileOK ? Math.abs(p.tail.rmsDbfs - q.head.rmsDbfs) : null;
  const spectral = profileOK ? p.tail.bandFractions.reduce((s, x, i) => s + Math.abs(x - q.head.bandFractions[i]), 0) / 2 : null;
  const bassCollision = profileOK ? Math.min(p.tail.bandFractions[0], q.head.bandFractions[0]) : null;
  const quietIncoming = finite(q?.head?.rmsDbfs) && q.head.rmsDbfs < (policy.minimumEntryDbfs ?? -36);
  if (quietIncoming || q?.activity?.effectiveSilence === true) add('INCOMING_QUIET_SECTION_HOLD');
  if (q?.activity?.maxQuietRunSeconds > (policy.maxSourceQuietRunSeconds ?? .5)) add('SOURCE_EFFECTIVE_SILENCE');
  if (p?.activity?.effectiveSilence === true) add('CURRENT_EFFECTIVE_SILENCE');
  if ([p, q].some(x => x?.clippedFraction > .001 || x?.nonfiniteSamples > 0)) add('SOURCE_CLIP_OR_NONFINITE');
  if ([p, q].some(x => finite(x?.loudness?.truePeakDbtp) && x.loudness.truePeakDbtp > (policy.maxTruePeakDbtp ?? -.3))) add('SOURCE_TRUE_PEAK_HOLD');
  const gain = pairBound && finite(pairQC.relativeIncomingGainDb) ? pairQC.relativeIncomingGainDb : 0;
  if (Math.abs(gain) > (policy.maxRelativeGainDb ?? 3)) add('GAIN_BUDGET_EXCEEDED');
  // A measured crossfade carries the outgoing fade-out: its rendered level
  // step around the overlap is measured instead (renderValid, <= 6 dB).
  if (levelGap !== null && !measuredCrossfade && (pairBound ? Math.abs(p.tail.rmsDbfs - q.head.rmsDbfs - gain) : levelGap) > (policy.maxLevelGapDb ?? 9)) add('LEVEL_GAP_HOLD');

  const validFrames = pairBound && geometry(pairQC, p?.frameCount, q?.frameCount);
  const renderVerified = pairBound && validFrames && renderValid(pairQC, policy)
    && pairQC.renderedFrameCount === pairQC.exitFrame - pairQC.entryFrame + q.frameCount;
  // Exact native tail uses the real parent's endpoint and the new tail's frame0.
  // Unknown key is acceptable only on this verified, zero-overlap continuation.
  // A distinct offline case: unchanged adjacent ranges of one SHA-bound saved
  // source. No native provider lineage or beat/key confidence is invented.
  const lineage=(v)=>v?.method==='saved-pcm-range-v1'&&hash(v.originSha256)&&hash(v.pcmSha256)
    &&frame(v.startFrame)&&frame(v.endFrame)&&frame(v.originFrameCount)&&v.endFrame>v.startFrame&&v.endFrame<=v.originFrameCount;
  const saved = mode==='saved'&&exactParent&&pairBound&&validFrames&&pairQC.type==='saved-contiguous'
    &&pairQC.sourceContinuityVerified===true&&lineage(current.sourceLineage)&&lineage(m.sourceLineage)
    &&current.sourceLineage.originSha256===m.sourceLineage.originSha256
    &&current.sourceLineage.originFrameCount===m.sourceLineage.originFrameCount
    &&current.sourceLineage.endFrame===m.sourceLineage.startFrame
    &&current.sourceLineage.endFrame-current.sourceLineage.startFrame===p.frameCount
    &&m.sourceLineage.endFrame-m.sourceLineage.startFrame===q.frameCount
    &&lineage(pairQC.sourceContinuity?.current)&&lineage(pairQC.sourceContinuity?.incoming)
    &&transitionDigest(pairQC.sourceContinuity.current)===transitionDigest(current.sourceLineage)
    &&transitionDigest(pairQC.sourceContinuity?.incoming)===transitionDigest(m.sourceLineage)
    &&pairQC.contextSha256===current.contextSha256&&pairQC.entryFrame===0&&pairQC.exitFrame===p.frameCount
    &&pairQC.overlapFrames===0&&(pairQC.seamDeclickFrames??0)===0&&pairQC.relativeIncomingGainDb===0;
  const native = exactParent && pairBound && validFrames && pairQC.type === 'native-continuation'
    && pairQC.nativeContinuationVerified === true && pairQC.parentSha256 === current.sha256
    && pairQC.contextSha256 === current.contextSha256 && pairQC.contextAnchorFrame === p.frameCount
    && pairQC.entryFrame === 0 && pairQC.exitFrame === p.frameCount && pairQC.overlapFrames === 0;
  const conditioned=mode==='provider'&&exactParent&&pairBound&&validFrames&&
    validConditionedContinuation(m.conditionedContinuation,{parentSha256:current.sha256,contextSha256:current.contextSha256,cueSha256:m.asset.sha256})&&
    pairQC.conditionedContinuationSha256===transitionDigest(m.conditionedContinuation)&&pairQC.nativeContinuationVerified===false&&
    pairQC.type===(m.conditionedContinuation.contextOverlapFrames?'conditioned-context-overlap':'conditioned-continuation')&&
    pairQC.parentSha256===current.sha256&&pairQC.contextSha256===current.contextSha256&&pairQC.contextAnchorFrame===p.frameCount&&
    pairQC.overlapFrames===m.conditionedContinuation.contextOverlapFrames&&pairQC.entryFrame===pairQC.overlapFrames/2&&
    pairQC.exitFrame===p.frameCount-pairQC.overlapFrames/2&&(pairQC.seamDeclickFrames??0)===0&&pairQC.relativeIncomingGainDb===0&&
    (!pairQC.overlapFrames||singleBassOwner(pairQC.eqCurves));
  // An uncertain rhythmic proxy does not prove a tempo mismatch at a verified
  // zero-overlap native seam. It still blocks every beat-synchronised blend.
  if (tempoAmbiguous && !native && !conditioned && !saved && !shared && !reviewed && !measuredCut) add('TEMPO_HALF_DOUBLE_AMBIGUITY');
  const gridMeasured = pairBound && validFrames && pairQC.beatGridVerified === true
    && pairQC.downbeatVerified === true && pairQC.phraseVerified === true
    && [pairQC.beatConfidence, pairQC.downbeatConfidence, pairQC.phraseConfidence].every(x => finite(x) && x >= .8 && x <= 1)
    && finite(pairQC.beatPhaseError) && pairQC.beatPhaseError >= 0 && pairQC.beatPhaseError <= .08;
  const bassManaged = pairBound && pairQC.bassCollisionManaged === true && pairQC.loudnessVerified === true
    && (native || conditioned || measuredCut || saved || shared || reviewed&&pairQC.type==='reviewed-nonoverlap-cut' || pairQC.type === 'bass-swap' && singleBassOwner(pairQC.eqCurves));
  if (pairBound && !validFrames) add('INVALID_SOURCE_FRAME_GEOMETRY');
  if (pairBound && validFrames && (!frame(current?.playedUntilFrame)
    || pairQC.exitFrame - Math.max(pairQC.overlapFrames,pairQC.seamDeclickFrames??0) / 2 < current.playedUntilFrame)) add('PLAYBACK_FRONTIER_NOT_EDITABLE');
  if (pairQC?.renderQC?.passed === false && pairIdentity) add('RENDER_QC_FAILED');
  if (['provider','saved'].includes(mode)) {
    if (!renderVerified) add('ACTUAL_RENDER_QC_REQUIRED');
    if (!native && !conditioned && !saved && !shared && !reviewed && !measuredCut && !gridMeasured) add('CONFIDENT_BEAT_DOWNBEAT_PHRASE_QC_REQUIRED');
    if (!bassManaged) add('SINGLE_BASS_OWNER_AND_LOUDNESS_QC_REQUIRED');
    if(mode==='saved'&&!native&&!saved&&!shared&&!reviewed&&(!bpmKnown||!keyKnown))add('OLD_PARENT_OR_INDEPENDENT_UNKNOWN_TEMPO_KEY');
    if (pairQC?.type==='shared-pcm-bridge'&&!shared) add('EXACT_SHARED_PCM_BRIDGE_REQUIRED');
    if (pairQC?.type==='saved-contiguous'&&!saved) add('SAVED_SOURCE_CONTINUITY_NOT_VERIFIED');
    if (pairQC?.type === 'native-continuation' && !native) add('NATIVE_PARENT_CONTEXT_ANCHOR_MISMATCH');
  }
  const qualityReady = reasons.length===0&&renderVerified&&bassManaged&&(native||conditioned||measuredCut||saved||shared||reviewed||gridMeasured);
  const liveReady = mode==='provider'&&qualityReady;
  const phase = pairBound && finite(pairQC.beatPhaseError) ? pairQC.beatPhaseError : null;
  const smoothnessCost = profileOK ? Number((levelGap / 9 * .4 + spectral * .3 + bassCollision * .15
    + (phase ?? 0) * .15 + (reviewed&&renderVerified ? pairQC.renderMetrics.seamJump/(policy.maxSeamJump??.15)*.02 : 0) + (renderVerified ? pairQC.renderMetrics.maxLevelStepDb / 6 * .1 : 0)).toFixed(6)) : null;
  const plan = {strategy:DJ_STRATEGY, llmUsed:false, roomId:c?.roomId, cueId:c?.cueId, generationId:c?.generationId,
    currentClipId:current?.clipId, currentSha256:current?.sha256, currentContextSha256:current?.contextSha256, incomingSha256:m?.asset?.sha256,
    currentPlaybackRevision:current?.playbackRevision, controlVersion:c?.controlVersion, createdAtMs:now,
    status:reasons.length ? 'HOLD' : 'ELIGIBLE', liveReady, qualityReady, offlineSaved:mode==='saved', sourceContinuity:saved?pairQC.sourceContinuity:null, fixtureOnly:mode === 'fixture',
    reviewedTransition:reviewed?pairQC.reviewedTransition:null,
    evidenceScope:measuredCrossfade?'MEASURED_OVERLAP_CROSSFADE_WITH_UNVERIFIED_MUSICAL_GRID':measuredCut?'MEASURED_NONOVERLAP_WITH_UNVERIFIED_MUSICAL_GRID':reviewed?'EXACT_USER_REVIEWED_TRANSITION':shared?'EXACT_SHARED_PASSAGE_NOT_INDEPENDENT_MIX':null,
    sharedPCM:shared?pairQC.sharedPCM:null,
    contextRelationship:measuredCrossfade?'PAIR_SPECIFIC_OVERLAP_CROSSFADE':measuredCut?'PAIR_SPECIFIC_NONOVERLAP_CUT':conditioned?'MEASURED_CONDITIONED_CONTEXT_WITH_ACTUAL_OVERLAP':reviewed?'EXACT_USER_REVIEWED_JOIN':shared?'EXACT_SHARED_PCM_BRIDGE':saved?'EXACT_SAVED_CONTIGUOUS':exactParent ? 'EXACT_CURRENT_CONTINUATION' : 'REEVALUATED_CROSS_CONTEXT', reasons,
    selectionReason:measuredCrossfade?'LOWEST_MEASURED_CROSSFADE_DISRUPTION':measuredCut?'LOWEST_MEASURED_NONOVERLAP_DISRUPTION':conditioned?'MEASURED_PROVIDER_CONDITIONED_CONTINUATION':reviewed?'USER_REVIEWED_EXACT_JOIN_LOWEST_MEASURED_COST':shared?'EXACT_SHARED_PCM_BRIDGE':saved?'VERIFIED_SAVED_CONTIGUOUS_SEAM':native ? 'VERIFIED_NATIVE_CONTINUATION_SEAM' : 'MEASURED_RENDER_DISRUPTION',
    metrics:{levelGapDb:levelGap, spectralBandDistance:spectral, bassCollision, bpmGap, tempoMeasured:bpmKnown,
      keyMeasured:keyKnown, userReviewed:reviewed, modelConfidencePromoted:false, quietIncoming, beatPhaseError:phase, renderVerified,
      rendered:renderVerified ? pairQC.renderMetrics : null}, smoothnessCost,
    transition:{...renderSpec(pairBound ? pairQC : null), entryFrame:validFrames ? pairQC.entryFrame : null,
      exitFrame:validFrames ? pairQC.exitFrame : null, overlapFrames:validFrames ? pairQC.overlapFrames : null,
      editStartFrame:validFrames ? pairQC.exitFrame-Math.max(pairQC.overlapFrames,pairQC.seamDeclickFrames??0)/2 : null,
      sampleRate:44100, beatGridVerified:gridMeasured, downbeatVerified:gridMeasured, phraseVerified:gridMeasured,
      nativeContinuationVerified:native, conditionedContinuationVerified:conditioned, measuredCutVerified:measuredCut, savedContinuityVerified:saved, sharedPCMBridgeVerified:shared, userReviewedJoinVerified:reviewed, bassCollisionManaged:bassManaged, loudnessVerified:bassManaged,
      renderVerified, renderedSha256:renderVerified ? pairQC.renderedSha256 : null,
      renderSpecSha256:renderVerified ? pairQC.renderSpecSha256 : null,
      netIncomingSeconds:validFrames ? (q.frameCount - pairQC.entryFrame - pairQC.overlapFrames / 2) / 44100 : null,
      timeStretch:false, pitchShift:false}, contribution:c?.contribution, readyAtMs:c?.readyAtMs};
  plan.planSha256 = transitionDigest(plan);
  return plan;
}

// Backend can call this immediately before scheduling, alongside its room lock.
// It validates a snapshot; it neither commits audio nor acquires a global lock.
export function validatePlanAtCommit(plan, {current, candidate, reservedCueId = null}) {
  if (!plan || plan.status !== 'ELIGIBLE') return {valid:false, reason:'PLAN_NOT_ELIGIBLE'};
  const {planSha256, ...body} = plan;
  if (transitionDigest(body) !== planSha256) return {valid:false, reason:'PLAN_MUTATED'};
  if (current?.sha256 !== plan.currentSha256 || current?.clipId !== plan.currentClipId
    || current?.contextSha256 !== plan.currentContextSha256 || current?.playbackRevision !== plan.currentPlaybackRevision
    || candidate?.music?.asset?.sha256 !== plan.incomingSha256 || candidate?.cueId !== plan.cueId
    || candidate?.roomId !== plan.roomId || candidate?.generationId !== plan.generationId || candidate?.controlVersion !== plan.controlVersion
    || !candidate.atomicReady || candidate.music?.qc?.passed !== true || candidate.video?.qc?.passed !== true
    || !(candidate.status === 'READY' || candidate.status === 'SELECTED' && reservedCueId === plan.cueId)) return {valid:false, reason:'SOURCE_OR_CUE_CHANGED'};
  if(plan.offlineSaved&&plan.transition.savedContinuityVerified&&(!current.sourceLineage||!candidate.music.sourceLineage||!plan.sourceContinuity?.current||!plan.sourceContinuity?.incoming||transitionDigest(current.sourceLineage)!==transitionDigest(plan.sourceContinuity.current)||transitionDigest(candidate.music.sourceLineage)!==transitionDigest(plan.sourceContinuity.incoming)))return {valid:false,reason:'SAVED_SOURCE_CONTINUITY_CHANGED'};
  if (!plan.fixtureOnly && (!(plan.liveReady||plan.offlineSaved&&plan.qualityReady) || !frame(current.playedUntilFrame)
    || plan.transition.editStartFrame < current.playedUntilFrame)) return {valid:false, reason:'PLAYBACK_FRONTIER_NOT_EDITABLE'};
  return {valid:true, reason:'CURRENT_PLAN_VERIFIED'};
}

export function selectBestTransition(plans, {lastParticipantId = null, servedCounts = {}, nearEqualTolerance = .02, now = Date.now(), starvationSeconds = 180} = {}) {
  const tolerance = finite(nearEqualTolerance) && nearEqualTolerance >= 0 ? Math.min(nearEqualTolerance, .02) : 0;
  const eligible = plans.filter(p => p.status === 'ELIGIBLE' && finite(p.smoothnessCost) && (p.fixtureOnly || p.liveReady || p.offlineSaved&&p.qualityReady))
    .sort((a, b) => a.smoothnessCost - b.smoothnessCost || (a.readyAtMs ?? now) - (b.readyAtMs ?? now) || String(a.cueId).localeCompare(String(b.cueId)));
  const starvation = plans.filter(p => finite(p.readyAtMs) && now - p.readyAtMs > starvationSeconds * 1000)
    .map(p => ({cueId:p.cueId, reasons:p.reasons, ageSeconds:(now - p.readyAtMs) / 1000}));
  if (!eligible.length) return {selected:null, reason:'NO_VERIFIED_SMOOTH_CANDIDATE', plans, starvation};
  const near = eligible.filter(p => p.smoothnessCost <= eligible[0].smoothnessCost + tolerance);
  // Prefer a native seam only among equally safe, near-equal candidates.
  near.sort((a, b) => Number(b.transition?.nativeContinuationVerified) - Number(a.transition?.nativeContinuationVerified)
    || Number(a.contribution?.participantId === lastParticipantId) - Number(b.contribution?.participantId === lastParticipantId)
    || (servedCounts[a.contribution?.participantId] ?? 0) - (servedCounts[b.contribution?.participantId] ?? 0)
    || (a.readyAtMs ?? now) - (b.readyAtMs ?? now) || a.smoothnessCost - b.smoothnessCost);
  return {selected:near[0], reason:near[0].transition?.userReviewedJoinVerified?'USER_REVIEWED_EXACT_JOIN_LOWEST_MEASURED_COST':near[0].transition?.sharedPCMBridgeVerified?'EXACT_SHARED_PCM_BRIDGE':near[0].transition?.savedContinuityVerified?'VERIFIED_SAVED_CONTIGUOUS_SEAM':near[0].transition?.nativeContinuationVerified ? 'VERIFIED_NATIVE_CONTINUATION_SEAM'
    : near.length > 1 ? 'NEAR_EQUAL_SMOOTHNESS_FAIR_TIE_BREAK' : 'LOWEST_MEASURED_TRANSITION_DISRUPTION', plans, starvation};
}

export function supplyPlan({cueSeconds = 24, overlapSeconds = 4, priorOverlapSeconds = 0, initialCues = 3, providerSlots = 2, serviceSeconds = null, showSeconds = 600, jitterReserve = 2} = {}) {
  if (![cueSeconds, overlapSeconds, priorOverlapSeconds, initialCues, providerSlots, showSeconds, jitterReserve].every(finite)
    || overlapSeconds < 0 || priorOverlapSeconds < 0 || cueSeconds <= overlapSeconds + priorOverlapSeconds
    || !frame(initialCues) || !frame(providerSlots) || providerSlots < 1 || showSeconds < 0 || !frame(jitterReserve)) throw Error('INVALID_SUPPLY_PLAN');
  const netSeconds = cueSeconds - overlapSeconds - priorOverlapSeconds, valid = finite(serviceSeconds) && serviceSeconds > 0;
  const arrivalIntervalSeconds = valid ? serviceSeconds / providerSlots : null;
  const deficit = valid ? Math.max(0, 1 / netSeconds - providerSlots / serviceSeconds) : null;
  return {cueSeconds, overlapSeconds, priorOverlapSeconds, netSeconds, initialCues, initialBufferSeconds:initialCues * netSeconds,
    providerSlots, serviceSeconds, serviceTimeMeasured:false, arrivalIntervalSeconds,
    sustainable:valid ? arrivalIntervalSeconds <= netSeconds : null,
    requiredInitialCues:valid ? Math.ceil(deficit * showSeconds) + jitterReserve : null,
    lowStockFallback:'CURRENT_SAFE_AUDIO_AND_LAST_ACCEPTED_RAW_VISUAL', continuousPlaybackGuaranteed:false};
}
