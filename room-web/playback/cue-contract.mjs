const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const close = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1 / 44100;
const fail = code => { throw Error(code); };

// Mirror the integration owner's verified cue projection; never promote partial AV.
export function validatePlaybackCue({roomId, cue, plan, expectedRevision}) {
  if (!cue || cue.roomId !== roomId || !['READY', 'SELECTED'].includes(cue.status) ||
      cue.atomicReady !== true || !cue.cueId || !cue.generationId || !cue.submissionId ||
      !hash(cue.commonIntentSha256) || !Number.isSafeInteger(cue.controlVersion) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || plan?.cueId !== cue.cueId)
    fail('ATOMIC_CUE_AND_PLAN_REQUIRED');
  for (const channel of ['music', 'video']) {
    const media = cue[channel], binding = media?.binding;
    if (!['QC_READY', 'READY'].includes(media?.status) || media?.qc?.passed !== true ||
        !media.asset?.assetId || !hash(media.asset.sha256) || !close(media.durationSeconds, 24) ||
        !binding || binding.roomId !== roomId || binding.submissionId !== cue.submissionId ||
        binding.generationId !== cue.generationId || binding.commonIntentSha256 !== cue.commonIntentSha256 ||
        binding.controlVersion !== cue.controlVersion || binding.channel !== channel)
      fail('SAME_SET_24_SECOND_AV_REQUIRED');
  }
  const {video} = cue, timeline = video.timeline;
  const technicalApproval = video.review?.kind === 'technical-qc' && hash(video.review.policySha256) &&
    video.review.policySha256 === video.compositionQC?.visualPolicySha256 &&
    video.compositionQC?.approval?.kind === 'technical-qc';
  if (video.compositionQC?.passed !== true || video.review?.accepted !== true ||
      !(video.review.ownerArtisticApproval === true || technicalApproval) || video.review.assetSha256 !== video.asset.sha256 ||
      video.review.commonIntentSha256 !== cue.commonIntentSha256 || !close(timeline?.durationSeconds, 24) ||
      timeline.timeStretch !== false || !Array.isArray(timeline.segments) ||
      !timeline.segments.length || timeline.segments.length > 128 ||
      !Array.isArray(video.clips) || !video.clips.length || video.clips.length > 32)
    fail('APPROVED_FULL_VISUAL_TIMELINE_REQUIRED');
  const clips = new Map();
  for (const clip of video.clips) {
    if (!clip.assetId || !hash(clip.sha256) || !Number.isFinite(clip.durationSeconds) ||
        clip.durationSeconds <= 0 || clips.has(clip.assetId)) fail('VISUAL_CLIP_REQUIRED');
    clips.set(clip.assetId, clip);
  }
  let end = 0; const seen = new Set();
  for (const s of timeline.segments) {
    const clip = clips.get(s.assetId);
    if (!clip || clip.sha256 !== s.sha256 || !close(s.startSeconds, end) ||
        !Number.isFinite(s.endSeconds) || s.endSeconds <= s.startSeconds ||
        !Number.isFinite(s.sourceInSeconds) || s.sourceInSeconds < 0 ||
        !Number.isFinite(s.sourceOutSeconds) || s.sourceOutSeconds > clip.durationSeconds + 1 / 44100 ||
        !close(s.endSeconds - s.startSeconds, s.sourceOutSeconds - s.sourceInSeconds) ||
        s.playbackRate !== 1 || seen.has(s.assetId) && timeline.approvedLoops !== true)
      fail('VISUAL_TIMELINE_GAP_OR_RETIME');
    seen.add(s.assetId); end = s.endSeconds;
  }
  if (!close(end, 24)) fail('FULL_CUE_DURATION_REQUIRED');
  return cue;
}

export async function pcmSha256(pcm) {
  const bytes = ArrayBuffer.isView(pcm)
    ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) : pcm;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
