import {pcmSha256} from './cue-contract.mjs';
const RATE = 44100, CLIP = 24 * RATE, WINDOW = 256;
const frame = n => Number.isSafeInteger(n) && n >= 0;
const hash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const verified = new WeakMap();

// The resolver calls this only for an explicit owner-scoped server manifest.
// It independently checks physical local bytes; a caller's QC flag cannot brand
// a render. Native plan/file/PCM/window hashes remain the local48s evidence.
export async function verifyClipRelativeRender(render) {
  if (render?.timelineSpace !== 'clip-relative-v1' || render.sampleRate !== RATE ||
      !frame(render.startFrame) || render.startFrame > CLIP || !frame(render.durationFrames) ||
      render.durationFrames > 2 * CLIP || render.durationFrames <= render.startFrame + WINDOW ||
      !(render.pcm instanceof Float32Array) || render.pcm.length !== render.durationFrames * 2 ||
      !hash(render.renderedPcmSha256) || !hash(render.renderedFileSha256) || !hash(render.expectedPlayedWindowSha256) ||
      await pcmSha256(render.pcm) !== render.renderedPcmSha256 ||
      await pcmSha256(render.pcm.subarray(render.startFrame * 2, (render.startFrame + WINDOW) * 2)) !== render.expectedPlayedWindowSha256)
    throw Error('VERIFIED_CLIP_RELATIVE_RENDER_REQUIRED');
  verified.set(render, {nativePcmSha256: render.renderedPcmSha256, nativeFileSha256: render.renderedFileSha256,
    startFrame: render.startFrame, durationFrames: render.durationFrames, expectedWindow: render.expectedPlayedWindowSha256});
  return render;
}
export function isVerifiedClipRelativeRender(render) {return verified.has(render);}

// `binding` and `retainedPCM` are private engine state derived from accepted
// source/actual AV ACKs. They never come from a caller's desired offset.
export async function assembleClipRelativeRender({render, plan, binding, retainedPCM, ceilingFrames}) {
  const proof = verified.get(render), t = plan?.transition;
  if (!proof || render.timelineSpace !== 'clip-relative-v1' || render.renderedPcmSha256 !== proof.nativePcmSha256 ||
      render.renderedFileSha256 !== proof.nativeFileSha256 || !binding || plan.currentClipId !== binding.clipId || plan.currentSha256 !== binding.sha256 ||
      plan.currentPlaybackRevision !== binding.playbackRevision || !frame(binding.originFrame) ||
      !frame(t?.editStartFrame) || !frame(t.exitFrame) || !frame(t.entryFrame) || t.entryFrame >= CLIP ||
      t.exitFrame !== proof.startFrame || t.editStartFrame > t.exitFrame || t.exitFrame > CLIP ||
      render.durationFrames !== proof.durationFrames || render.startFrame !== proof.startFrame ||
      render.expectedPlayedWindowSha256 !== proof.expectedWindow || t.renderedSha256 !== proof.nativeFileSha256 ||
      render.durationFrames - render.startFrame !== CLIP - t.entryFrame ||
      await pcmSha256(render.pcm) !== proof.nativePcmSha256)
    throw Error('ACTUAL_CLIP_TIMELINE_BINDING_REQUIRED');
  const edit = binding.originFrame + t.editStartFrame, start = binding.originFrame + t.exitFrame,
    end = binding.originFrame + render.durationFrames;
  if (!frame(edit) || !frame(start) || !frame(end) || !frame(ceilingFrames) || ceilingFrames > 180 * RATE || end > ceilingFrames ||
      !(retainedPCM instanceof Float32Array) || retainedPCM.length < edit * 2)
    throw Error('CLIP_TIMELINE_CEILING_OR_PREFIX_REQUIRED');
  // Preserve all historical samples, including previous verified seams. The
  // native local prefix can differ there and is never used to rewrite history.
  const pcm = new Float32Array(end * 2);
  pcm.set(retainedPCM.subarray(0, edit * 2)); pcm.set(render.pcm.subarray(t.editStartFrame * 2), edit * 2);
  const assemblyPcmSha256 = await pcmSha256(pcm);
  return {...render, pcm, startFrame: start, durationFrames: end, queueEditFrame: edit,
    clipTimeline: Object.freeze({kind: 'verified-clip-graph-map-v1', originFrame: binding.originFrame,
      localStartFrame: proof.startFrame, localEditFrame: t.editStartFrame, localDurationFrames: proof.durationFrames,
      nativePcmSha256: proof.nativePcmSha256, nativeFileSha256: proof.nativeFileSha256, assemblyPcmSha256})};
}
