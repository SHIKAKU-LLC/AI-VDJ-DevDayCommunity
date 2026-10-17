import {verifyClipRelativeRender} from './playback/clip-timeline.mjs';
import {pcmSha256, validatePlaybackCue} from './playback/cue-contract.mjs';

const MiB = 1024 * 1024, RATE = 44100;
const anonymous = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const room = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const frame = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw Error(code); };
function exact(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail(code);
}
function descriptor(value, limit, mimes, extra = []) {
  exact(value, ['assetId', 'sha256', 'byteLength', 'mimeType', ...extra], 'CLOUD_MEDIA_DESCRIPTOR_INVALID');
  if (!anonymous(value.assetId) || !hash(value.sha256) || !Number.isSafeInteger(value.byteLength) ||
      value.byteLength <= 0 || value.byteLength > limit || !mimes.includes(value.mimeType)) fail('CLOUD_MEDIA_DESCRIPTOR_INVALID');
}
function cancelled(signal) { if (signal?.aborted) fail('CLOUD_MEDIA_CANCELLED'); }

// Read streaming responses under a hard ceiling; arrayBuffer() would allocate
// an unbounded body before its declared length could be checked.
async function readBounded(response, limit, signal, expectedLength) {
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit ||
      expectedLength !== undefined && Number(declared) !== expectedLength)) fail('CLOUD_MEDIA_LENGTH_MISMATCH');
  if (!response.body?.getReader) fail('CLOUD_MEDIA_STREAM_REQUIRED');
  const reader = response.body.getReader(), chunks = []; let total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    while (true) {
      cancelled(signal);
      const {value, done} = await reader.read(); cancelled(signal);
      if (done) break;
      if (!(value instanceof Uint8Array) || total + value.byteLength > limit) fail('CLOUD_MEDIA_SIZE_LIMIT');
      chunks.push(value); total += value.byteLength;
    }
    if (expectedLength !== undefined && total !== expectedLength) fail('CLOUD_MEDIA_LENGTH_MISMATCH');
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}

export function decodeCloudRender(bytes, metadata) {
  if (!(bytes instanceof Uint8Array)) fail('CLOUD_RENDER_BYTES_REQUIRED');
  let data = bytes, encoding = 3, bits = 32;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (metadata.mimeType === 'audio/wav') {
    const tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
    if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) fail('CLOUD_RENDER_WAVE_INVALID');
    let fmt = null, audio = null, at = 12;
    while (at < bytes.length) {
      if (at + 8 > bytes.length) fail('CLOUD_RENDER_WAVE_INVALID');
      const size = view.getUint32(at + 4, true), end = at + 8 + size;
      if (end > bytes.length) fail('CLOUD_RENDER_WAVE_INVALID');
      if (tag(at) === 'fmt ') {
        if (fmt || size < 16) fail('CLOUD_RENDER_WAVE_INVALID');
        fmt = {encoding: view.getUint16(at + 8, true), channels: view.getUint16(at + 10, true),
          rate: view.getUint32(at + 12, true), byteRate: view.getUint32(at + 16, true),
          align: view.getUint16(at + 20, true), bits: view.getUint16(at + 22, true)};
      }
      if (tag(at) === 'data') { if (audio) fail('CLOUD_RENDER_WAVE_INVALID'); audio = bytes.subarray(at + 8, end); }
      at = end + size % 2;
    }
    if (at !== bytes.length || !fmt || !audio || fmt.channels !== 2 || fmt.rate !== RATE ||
        !((fmt.encoding === 1 && fmt.bits === 16) || (fmt.encoding === 3 && fmt.bits === 32)) ||
        fmt.align !== fmt.bits / 8 * 2 || fmt.byteRate !== RATE * fmt.align) fail('CLOUD_RENDER_WAVE_INVALID');
    data = audio; encoding = fmt.encoding; bits = fmt.bits;
  } else if (metadata.mimeType !== 'application/vnd.ai-vdj.pcm-f32le') fail('CLOUD_RENDER_FORMAT_INVALID');
  if (data.byteLength !== metadata.durationFrames * 2 * bits / 8) fail('CLOUD_RENDER_GEOMETRY_INVALID');
  const raw = new DataView(data.buffer, data.byteOffset, data.byteLength), pcm = new Float32Array(metadata.durationFrames * 2);
  for (let i = 0; i < pcm.length; i++) {
    const value = encoding === 1 ? raw.getInt16(i * 2, true) / 32768 : raw.getFloat32(i * 4, true);
    if (!Number.isFinite(value) || Math.abs(value) > 1) fail('CLOUD_RENDER_PCM_INVALID');
    pcm[i] = value;
  }
  return pcm;
}

/** Trusted server verifies current parent/render/plan before issuing this
 * manifest. Browser verifies bytes and bindings again; no grant or URL is kept.
 * `request` is an owner-scoped closure, never a token/capability argument.
 */
export function createCloudMediaResolver({request = globalThis.fetch?.bind(globalThis),
  origin = globalThis.location?.origin, resolveManifest, urlAPI = globalThis.URL,
  enableClipRelativeTimeline = false, maxRenderBytes = 128 * MiB, maxVideoBytes = 32 * MiB, maxTotalBytes = 256 * MiB} = {}) {
  if (typeof request !== 'function' || !urlAPI?.createObjectURL || !urlAPI?.revokeObjectURL ||
      ![maxRenderBytes, maxVideoBytes, maxTotalBytes].every(n => Number.isSafeInteger(n) && n > 0 && n <= 256 * MiB)) fail('CLOUD_MEDIA_DEPENDENCIES_REQUIRED');
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin || /^(localhost|127\.|\[::1\])/.test(base.hostname)) fail('CLOUD_HTTPS_ORIGIN_REQUIRED');
  const prepared = new WeakMap();
  async function call(path, options, limit, expectedLength) {
    const target = new URL(path, origin);
    if (target.origin !== origin || target.username || target.password) fail('CLOUD_SAME_ORIGIN_REQUIRED');
    cancelled(options.signal);
    const response = await request(target.pathname + target.search, {...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error'});
    cancelled(options.signal);
    if (!response?.ok || response.redirected || response.url && new URL(response.url).href !== target.href) fail('CLOUD_MEDIA_RESPONSE_INVALID');
    return {bytes: await readBounded(response, limit, options.signal, expectedLength), mimeType: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()};
  }
  return {
    async resolveMedia(input) {
      const {roomId, cue, plan, signal} = input;
      validatePlaybackCue({...input, expectedRevision: input.expectedRevision ?? 1});
      if (!room(roomId) || ![cue.cueId, cue.generationId, cue.submissionId, cue.music.asset.assetId, ...cue.video.clips.map(c => c.assetId)].every(anonymous)) fail('CLOUD_ANONYMOUS_IDS_REQUIRED');
      cancelled(signal);
      const binding = {roomId, cueId: cue.cueId, generationId: cue.generationId, submissionId: cue.submissionId,
        controlVersion: cue.controlVersion, commonIntentSha256: cue.commonIntentSha256};
      const payload = {...binding, music: cue.music.asset, videos: cue.video.clips.map(({assetId, sha256}) => ({assetId, sha256})), plan};
      let manifest;
      if (resolveManifest) manifest = await resolveManifest({...payload, signal});
      else {
        const response = await call(`/api/rooms/${roomId}/cloud/media/resolve`, {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal}, 64 * 1024);
        if (response.mimeType !== 'application/json') fail('CLOUD_MANIFEST_FORMAT_INVALID');
        try { manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(response.bytes)); } catch { fail('CLOUD_MANIFEST_FORMAT_INVALID'); }
      }
      cancelled(signal);
      exact(manifest, [...Object.keys(binding), 'audio', 'videos'], 'CLOUD_MANIFEST_INVALID');
      if (Object.keys(binding).some(k => manifest[k] !== binding[k])) fail('CLOUD_MANIFEST_BINDING_INVALID');
      exact(manifest.audio, ['assetId', 'sha256', 'render'], 'CLOUD_AUDIO_BINDING_INVALID');
      if (manifest.audio.assetId !== cue.music.asset.assetId || manifest.audio.sha256 !== cue.music.asset.sha256) fail('CLOUD_AUDIO_BINDING_INVALID');
      const render = manifest.audio.render;
      descriptor(render, maxRenderBytes, ['audio/wav', 'application/vnd.ai-vdj.pcm-f32le'],
        ['renderedFileSha256', 'renderedPcmSha256', 'sampleRate', 'startFrame', 'durationFrames', 'expectedPlayedWindowSha256', 'timelineSpace']);
      if (render.timelineSpace !== undefined && (enableClipRelativeTimeline !== true || render.timelineSpace !== 'clip-relative-v1')) fail('CLOUD_CLIP_TIMELINE_ACTIVATION_GATED');
      if (!hash(plan.transition?.renderedSha256) || render.sha256 !== render.renderedFileSha256 ||
          render.renderedFileSha256 !== plan.transition.renderedSha256 || !hash(render.renderedPcmSha256) ||
          !hash(render.expectedPlayedWindowSha256) || render.sampleRate !== RATE || !frame(render.startFrame) ||
          !frame(render.durationFrames) || render.startFrame !== plan.transition.exitFrame ||
          render.startFrame + 256 > render.durationFrames || !frame(plan.transition.entryFrame) || plan.transition.entryFrame >= 24 * RATE ||
          render.durationFrames - render.startFrame !== 24 * RATE - plan.transition.entryFrame || render.durationFrames * 8 > maxRenderBytes) fail('CLOUD_RENDER_BINDING_INVALID');
      if (!Array.isArray(manifest.videos) || manifest.videos.length !== cue.video.clips.length) fail('CLOUD_VIDEO_BINDING_INVALID');
      let total = render.byteLength;
      const ids = new Set();
      for (const video of manifest.videos) {
        descriptor(video, maxVideoBytes, ['video/mp4'], ['source', 'requestId', 'admissionId', 'admissionEvidenceSha256']);
        const clip = cue.video.clips.find(c => c.assetId === video.assetId);
        const ownerVideo = video.source === 'owner-supplied-bootstrap-video';
        const originValid = ownerVideo ? anonymous(video.admissionId) && hash(video.admissionEvidenceSha256) && video.requestId === undefined :
          ['local-edit', 'provider-response-replay', 'fal', 'fake'].includes(video.source) && anonymous(video.requestId) &&
          video.admissionId === undefined && video.admissionEvidenceSha256 === undefined;
        if (!clip || clip.sha256 !== video.sha256 || ids.has(video.assetId) ||
            !originValid) fail('CLOUD_VIDEO_BINDING_INVALID');
        ids.add(video.assetId); total += video.byteLength;
      }
      if (total > maxTotalBytes) fail('CLOUD_MEDIA_SIZE_LIMIT');
      async function readAsset(asset) {
        const response = await call(`/api/rooms/${roomId}/media/${asset.assetId}?sha256=${asset.sha256}`, {method: 'GET', signal}, asset.byteLength, asset.byteLength);
        if (response.mimeType !== asset.mimeType || await pcmSha256(response.bytes) !== asset.sha256) fail('CLOUD_MEDIA_SHA_OR_TYPE_MISMATCH');
        cancelled(signal); return response.bytes;
      }
      const bytes = await readAsset(render), pcm = decodeCloudRender(bytes, render);
      if (await pcmSha256(pcm) !== render.renderedPcmSha256 ||
          await pcmSha256(pcm.subarray(render.startFrame * 2, (render.startFrame + 256) * 2)) !== render.expectedPlayedWindowSha256) fail('CLOUD_RENDER_PCM_SHA_MISMATCH');
      cancelled(signal);
      const urls = [], videos = [], audio = {assetId: cue.music.asset.assetId, sha256: cue.music.asset.sha256, renderedPcmSha256: render.renderedPcmSha256};
      try {
        for (const video of manifest.videos) {
          const content = await readAsset(video);
          const url = urlAPI.createObjectURL(new Blob([content], {type: video.mimeType})); urls.push(url);
          videos.push({assetId: video.assetId, sha256: video.sha256, url, source: video.source,
            ...(video.source === 'owner-supplied-bootstrap-video' ? {admissionId: video.admissionId,
              admissionEvidenceSha256: video.admissionEvidenceSha256} : {requestId: video.requestId})});
        }
        cancelled(signal); const verifiedRender = {...render, pcm};
        if (render.timelineSpace === 'clip-relative-v1') await verifyClipRelativeRender(verifiedRender);
        cancelled(signal); prepared.set(audio, verifiedRender);
        let released = false;
        return {audio, videos, release() { if (released) return; released = true; prepared.delete(audio); for (const url of urls) urlAPI.revokeObjectURL(url); }};
      } catch (error) { for (const url of urls) urlAPI.revokeObjectURL(url); throw error; }
    },
    async loadVerifiedRender({media, signal}) {
      cancelled(signal); const render = prepared.get(media);
      if (!render) fail('CLOUD_RENDER_NOT_PREPARED'); return render;
    },
  };
}
