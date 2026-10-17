import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {DispatchError, generationIdentity} from './dispatch.mjs';
import {TECHNICAL_VISUAL_POLICY,assessTechnicalVisual} from '../../integration/qc/visual-policy.mjs';

const fail = code => { throw new DispatchError(code); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const close = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1 / 44100;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

export function operationBinding(roomId, operation, channel) {
  return {roomId, submissionId: operation.submissionId, generationId: generationIdentity(operation.operationId).generationId,
    commonIntentSha256: operation.plan.commonIntentSha256, controlVersion: operation.plan.common.control.version, channel};
}

// Evidence is returned by an injected server QC adapter, never by a browser POST.
// A five-second provider result remains a clip inside the full 24-second visual
// timeline. This validator does not truncate a cue, invent frames or run QC.
export function buildVerifiedCue({roomId, operation, evidence, now = Date.now()}) {
  const op = operation;
  if (op.stopped || op.plan?.status !== 'COMPILED' || !hash(op.plan.commonIntentSha256) ||
      !['music', 'video'].every(channel => op.stages?.[channel]?.state === 'COMPLETE')) fail('COMPLETE_AV_REQUIRED');
  if (evidence?.actualGenerationThisRun !== true || evidence.mode !== 'provider') fail('REAL_MEDIA_EVIDENCE_REQUIRED');
  for (const channel of ['music', 'video']) {
    const media = evidence[channel], stage = op.stages[channel];
    if (cueDigest(media?.binding) !== cueDigest(operationBinding(roomId, op, channel)) ||
        media?.providerReceipt?.requestId !== stage.requestId ||
        media?.providerReceipt?.resultSha256 !== stage.result.resultSha256 ||
        media?.qc?.passed !== true || media.privateSaved !== true || media.checksumVerified !== true ||
        !id(media.asset?.assetId) || !hash(media.asset?.sha256) || !close(media.durationSeconds, 24)) fail('BOUND_SAVED_AV_QC_REQUIRED');
  }
  const music = evidence.music, video = evidence.video, p = music.profile;
  if (music.parentClipId !== op.permit.source.music.clipId ||
      music.contextSha256 !== op.permit.source.music.contextSha256 || music.contextVerified !== true ||
      music.continuationVerified !== true || p?.method !== 'pcm-endpoint-profile-v1' ||
      p.assetSha256 !== music.asset.sha256 || p.sampleRate !== 44100 || p.channels !== 2 ||
      p.frameCount !== 24 * 44100) fail('VERIFIED_AUDIO_CONTINUATION_REQUIRED');
  const timeline = video.timeline;
  const technicalApproval = video.review?.kind === 'technical-qc' &&
    cueDigest(op.permit.visualPolicy ?? null) === cueDigest(TECHNICAL_VISUAL_POLICY) &&
    video.review.policySha256 === cueDigest(TECHNICAL_VISUAL_POLICY) &&
    video.compositionQC?.visualPolicySha256 === video.review.policySha256 &&
    Array.isArray(video.compositionQC?.clips) && video.compositionQC.clips.length > 0 &&
    video.compositionQC.clips.every(clip => assessTechnicalVisual(clip.measurement).passed);
  if (!timeline || !close(timeline.durationSeconds, 24) || timeline.timeStretch !== false ||
      !Array.isArray(timeline.segments) || timeline.segments.length < 1 || timeline.segments.length > 128 ||
      !Array.isArray(video.clips) || !video.clips.length || video.clips.length > 32 ||
      video.compositionQC?.passed !== true || video.review?.accepted !== true ||
      !(video.review.ownerArtisticApproval === true || technicalApproval) || video.review.assetSha256 !== video.asset.sha256 ||
      video.review.commonIntentSha256 !== op.plan.commonIntentSha256) fail('FULL_VISUAL_TIMELINE_REVIEW_REQUIRED');
  const clips = new Map(); let newClip = false;
  for (const clip of video.clips) {
    if (!id(clip.assetId) || !hash(clip.sha256) || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0 ||
        clip.qcPassed !== true || clip.approved !== true || clips.has(clip.assetId)) fail('VISUAL_CLIP_EVIDENCE_REQUIRED');
    if (clip.provenanceKind === 'owner-supplied-bootstrap-video' &&
        (!id(clip.ownerAdmission?.admissionId) || !hash(clip.ownerAdmission?.admissionEvidenceSha256) ||
         !hash(clip.ownerAdmission?.originalBindingSha256) || clip.ownerAdmission?.actualGenerationThisRun !== false ||
         clip.providerRequestId != null || clip.providerResultSha256 != null || clip.originalGenerationId != null))
      fail('OWNER_VISUAL_ADMISSION_REQUIRED');
    if (clip.providerRequestId === op.stages.video.requestId && clip.providerResultSha256 === op.stages.video.result.resultSha256) newClip = true;
    clips.set(clip.assetId, clip);
  }
  if (!newClip) fail('GENERATED_CLIP_NOT_IN_TIMELINE');
  let end = 0; const seen = new Set();
  for (const segment of timeline.segments) {
    const clip = clips.get(segment.assetId);
    if (!clip || segment.sha256 !== clip.sha256 || !close(segment.startSeconds, end) ||
        !Number.isFinite(segment.endSeconds) || segment.endSeconds <= segment.startSeconds ||
        !Number.isFinite(segment.sourceInSeconds) || segment.sourceInSeconds < 0 ||
        !Number.isFinite(segment.sourceOutSeconds) || segment.sourceOutSeconds > clip.durationSeconds + 1 / 44100 ||
        !close(segment.endSeconds - segment.startSeconds, segment.sourceOutSeconds - segment.sourceInSeconds) ||
        segment.playbackRate !== 1 || (seen.has(segment.assetId) && timeline.approvedLoops !== true)) fail('VISUAL_TIMELINE_GAP_OR_RETIME');
    end = segment.endSeconds; seen.add(segment.assetId);
  }
  if (!close(end, 24)) fail('FULL_CUE_DURATION_REQUIRED');
  const project = media => ({binding: structuredClone(media.binding), status: 'QC_READY', durationSeconds: media.durationSeconds,
    asset: {assetId: media.asset.assetId, sha256: media.asset.sha256}, qc: {passed: true,
      scope: typeof media.qc.scope === 'string' ? media.qc.scope.slice(0, 160) : 'server-qc', evidenceSha256: cueDigest(media.qc)},
    actualGenerationThisRun: true});
  return {roomId, operationId: op.operationId, submissionId: op.submissionId, cueId: op.plan.common.cueId,
    generationId: generationIdentity(op.operationId).generationId, commonIntentSha256: op.plan.commonIntentSha256,
    controlVersion: op.plan.common.control.version, status: 'READY', atomicReady: true, mode: 'provider',
    actualGenerationThisRun: true, readyAtMs: now, evidenceSha256: cueDigest(evidence),
    sourceSha256: op.permit.sourceSha256, playbackRevision: null,
    music: {...project(music), profile: structuredClone(music.profile), parentClipId: music.parentClipId,
      contextSha256: music.contextSha256, contextVerified: true, continuationVerified: true,
      ...(music.conditionedContinuation?{conditionedContinuation:structuredClone(music.conditionedContinuation)}:{})},
    video: {...project(video), compositionQC: structuredClone(video.compositionQC), review: structuredClone(video.review),
      timeline: structuredClone(timeline), clips: video.clips.map(clip => ({assetId: clip.assetId, sha256: clip.sha256,
        durationSeconds: clip.durationSeconds,...(clip.provenanceKind === 'owner-supplied-bootstrap-video' ? {
          provenanceKind: clip.provenanceKind, ownerAdmission: structuredClone(clip.ownerAdmission)} : {})}))}};
}

export function verifiedPlaybackAck(reservation, ack) {
  if (!reservation || !ack || ack.roomId !== reservation.roomId || ack.cueId !== reservation.cue.cueId ||
      ack.clipId !== reservation.cue.music.asset.assetId || ack.playbackRevision !== reservation.expectedRevision ||
      !Number.isFinite(ack.audioTime) || ack.audioTime < 0 || ack.actual !== true || ack.audioStarted !== true ||
      ack.videoPresented !== true || ack.simulated === true) fail('MATCHING_ACTUAL_AV_ACK_REQUIRED');
  return {roomId: ack.roomId, cueId: ack.cueId, clipId: ack.clipId, playbackRevision: ack.playbackRevision,
    audioTime: ack.audioTime, actual: true, audioStarted: true, videoPresented: true};
}
