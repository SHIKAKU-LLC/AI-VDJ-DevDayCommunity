import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';

const ownerProof = value => /^[a-f0-9]{64}$/.test(value ?? '');
function response(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
}
function authorized(req, origin, browserSameOriginGet = false) {
  const from = req.headers.get('origin');
  const sameOrigin = from === origin || browserSameOriginGet && from === null && req.method === 'GET' &&
    req.headers.get('sec-fetch-site') === 'same-origin';
  return sameOrigin && ownerProof(req.headers.get('x-room-owner')) &&
    !req.headers.has('authorization') && !req.headers.has('x-fal-key');
}
async function readBody(req, maximumBytes = 4096) {
  const reader = req.body?.getReader(), chunks = []; let size = 0;
  if (reader) while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length; if (size > maximumBytes) { await reader.cancel(); throw new DispatchError('BODY_TOO_LARGE'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const assetId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

// Manifest issuance requires a trusted callback to re-read the pending server
// reservation/current frontier. The supplied client plan is only compared with
// that reservation; describeManifest receives the authoritative reservation.
export function createCloudMediaManifestHandler({enabled = false, enableClipRelativeTimeline = false, authorizeOwner, checkReservation, describeManifest,
  origin = 'https://ai-vdj.vercel.app'} = {}) {
  return async req => {
    const path = new URL(req.url).pathname.replace(/^\/(?:functions\/v1\/)?ai-vdj-room(?=\/|$)/, '');
    const match = path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/cloud\/media\/resolve$/i); if (!match) return null;
    if (!authorized(req, origin)) return response({error: 'OWNER_OR_ORIGIN_DENIED'}, 403);
    if (req.method !== 'POST') return response({error: 'POST_REQUIRED'}, 405);
    if (!enabled || !authorizeOwner || !checkReservation || !describeManifest) return response({error: 'CLOUD_MEDIA_NOT_ACTIVATED'}, 503);
    if (!req.headers.get('content-type')?.startsWith('application/json')) return response({error: 'JSON_REQUIRED'}, 415);
    try {
      const ownerCapability = req.headers.get('x-room-owner');
      if (await authorizeOwner({roomId: match[1], ownerCapability}) !== true) return response({error: 'OWNER_DENIED'}, 403);
      const body = await readBody(req, 16384), bindingKeys = ['roomId', 'cueId', 'generationId', 'submissionId', 'controlVersion', 'commonIntentSha256'];
      if (!exact(body, [...bindingKeys, 'music', 'videos', 'plan']) || body.roomId !== match[1] ||
          !['cueId', 'generationId', 'submissionId'].every(key => assetId(body[key])) || !hash(body.commonIntentSha256) ||
          !Number.isSafeInteger(body.controlVersion) || body.controlVersion < 0 ||
          !exact(body.music, ['assetId', 'sha256']) || !assetId(body.music.assetId) || !hash(body.music.sha256) ||
          !Array.isArray(body.videos) || !body.videos.length || body.videos.length > 32 ||
          body.videos.some(video => !exact(video, ['assetId', 'sha256']) || !assetId(video.assetId) || !hash(video.sha256)) ||
          !body.plan || typeof body.plan !== 'object' || Array.isArray(body.plan)) return response({error: 'MANIFEST_BINDING_REQUIRED'}, 400);
      const verified = await checkReservation({roomId: match[1], cueId: body.cueId, ownerCapability});
      const reservation = verified?.reservation, cue = reservation?.cue;
      if (verified?.valid !== true || reservation?.roomId !== match[1] || !cue ||
          bindingKeys.some(key => cue[key] !== body[key]) || cueDigest(cue.music?.asset ?? null) !== cueDigest(body.music) ||
          cueDigest(cue.video?.clips?.map(({assetId, sha256}) => ({assetId, sha256})) ?? null) !== cueDigest(body.videos) ||
          cueDigest(reservation.plan ?? null) !== cueDigest(body.plan)) throw new DispatchError('CURRENT_RESERVATION_REQUIRED');
      const manifest = await describeManifest({roomId: match[1], ownerCapability, reservation});
      if (!exact(manifest, [...bindingKeys, 'audio', 'videos']) || bindingKeys.some(key => manifest[key] !== body[key]) ||
          !exact(manifest.audio, ['assetId', 'sha256', 'render']) || manifest.audio.assetId !== body.music.assetId ||
          manifest.audio.sha256 !== body.music.sha256) throw new DispatchError('TRUSTED_MANIFEST_REQUIRED');
      const render = manifest.audio.render, renderKeys = ['assetId', 'sha256', 'byteLength', 'mimeType', 'renderedFileSha256',
        'renderedPcmSha256', 'sampleRate', 'startFrame', 'durationFrames', 'expectedPlayedWindowSha256', 'timelineSpace'];
      const descriptor = (value, limit, mimes, extra = []) => exact(value, ['assetId', 'sha256', 'byteLength', 'mimeType', ...extra]) &&
        assetId(value.assetId) && hash(value.sha256) && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 &&
        value.byteLength <= limit && mimes.includes(value.mimeType);
      if (!exact(render, renderKeys) || !descriptor(render, 128 * 1024 * 1024,
          ['audio/wav', 'application/vnd.ai-vdj.pcm-f32le'], renderKeys.slice(4)) ||
          render.timelineSpace !== undefined && (enableClipRelativeTimeline !== true || render.timelineSpace !== 'clip-relative-v1') ||
          !hash(render.renderedPcmSha256) || !hash(render.expectedPlayedWindowSha256) ||
          render.sha256 !== render.renderedFileSha256 || render.renderedFileSha256 !== reservation.plan?.transition?.renderedSha256 ||
          render.sampleRate !== 44100 || !Number.isSafeInteger(render.startFrame) || render.startFrame < 0 ||
          !Number.isSafeInteger(render.durationFrames) || render.durationFrames <= render.startFrame + 256 ||
          render.startFrame !== reservation.plan?.transition?.exitFrame ||
          !Number.isSafeInteger(reservation.plan?.transition?.entryFrame) || reservation.plan.transition.entryFrame < 0 ||
          reservation.plan.transition.entryFrame >= 24 * 44100 ||
          render.durationFrames - render.startFrame !== 24 * 44100 - reservation.plan.transition.entryFrame ||
          render.durationFrames * 8 > 128 * 1024 * 1024 || !Array.isArray(manifest.videos) ||
          manifest.videos.length !== body.videos.length) throw new DispatchError('TRUSTED_MANIFEST_REQUIRED');
      const seen = new Set(); let totalBytes = render.byteLength;
      for (const video of manifest.videos) {
        const expected = body.videos.find(asset => asset.assetId === video.assetId);
        const ownerVideo = video.source === 'owner-supplied-bootstrap-video';
        const originValid = ownerVideo ? assetId(video.admissionId) && hash(video.admissionEvidenceSha256) && video.requestId === undefined :
          ['local-edit', 'provider-response-replay', 'fal'].includes(video.source) && assetId(video.requestId) &&
          video.admissionId === undefined && video.admissionEvidenceSha256 === undefined;
        if (!descriptor(video, 32 * 1024 * 1024, ['video/mp4'], ['source', 'requestId', 'admissionId', 'admissionEvidenceSha256']) || !expected ||
            expected.sha256 !== video.sha256 || seen.has(video.assetId) ||
            !originValid)
          throw new DispatchError('TRUSTED_MANIFEST_REQUIRED');
        seen.add(video.assetId); totalBytes += video.byteLength;
      }
      if (totalBytes > 256 * 1024 * 1024) throw new DispatchError('TRUSTED_MANIFEST_REQUIRED');
      const latest = await checkReservation({roomId: match[1], cueId: body.cueId, ownerCapability});
      if (latest?.valid !== true || cueDigest(latest.reservation ?? null) !== cueDigest(reservation))
        throw new DispatchError('CURRENT_RESERVATION_REQUIRED');
      return response(manifest);
    } catch (error) { return response({error: error instanceof DispatchError ? error.code : 'MANIFEST_HOLD'}, error?.code === 'BODY_TOO_LARGE' ? 413 : 409); }
  };
}

// No provider credential, QC verdict, price, model or media URL is accepted.
// A worker can call jobs.advance directly; HTTP requests are not its clock.
export function createCloudJobHandler({jobs, origin = 'https://ai-vdj.vercel.app'} = {}) {
  return async req => {
    const path = new URL(req.url).pathname.replace(/^\/(?:functions\/v1\/)?ai-vdj-room(?=\/|$)/, '');
    const match = path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/jobs\/(start|advance|read|stop)$/i);
    if (!match) return null;
    if (!authorized(req, origin)) return response({error: 'OWNER_OR_ORIGIN_DENIED'}, 403);
    if (req.method !== 'POST') return response({error: 'POST_REQUIRED'}, 405);
    if (!req.headers.get('content-type')?.startsWith('application/json')) return response({error: 'JSON_REQUIRED'}, 415);
    try {
      const body = await readBody(req), allowed = match[2] === 'start' ? ['operationId', 'permitId', 'submissionId'] : ['operationId'];
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)))
        return response({error: 'BODY_INVALID'}, 400);
      return response(await jobs[match[2]]({roomId: match[1], ownerCapability: req.headers.get('x-room-owner'), ...body}));
    } catch (error) {
      return response({error: error instanceof DispatchError ? error.code : 'CLOUD_JOB_HOLD', automaticRetry: false},
        error?.code === 'BODY_TOO_LARGE' ? 413 : 409);
    }
  };
}

// Injected private-byte port only. The caller selects an anonymous asset ID and
// checksum; authorizeOwner must authenticate against the authoritative room.
export function createCloudMediaHandler({authorizeOwner, readMedia, origin = 'https://ai-vdj.vercel.app',
  pathPrefix = 'media', maximumBytes = 64 * 1024 * 1024} = {}) {
  if (!['media', 'cloud/media'].includes(pathPrefix)) throw new DispatchError('MEDIA_PATH_REQUIRED');
  const route = new RegExp('^/api/rooms/([a-f0-9-]{36})/' + pathPrefix + '/([A-Za-z0-9_-]{1,100})$');
  return async req => {
    const url = new URL(req.url), path = url.pathname.replace(/^\/(?:functions\/v1\/)?ai-vdj-room(?=\/|$)/, '');
    const match = path.match(route); if (!match) return null;
    if (!authorized(req, origin, true)) return response({error: 'OWNER_OR_ORIGIN_DENIED'}, 403);
    if (req.method !== 'GET') return response({error: 'GET_REQUIRED'}, 405);
    if (url.searchParams.size !== 1 || !/^[a-f0-9]{64}$/.test(url.searchParams.get('sha256') ?? ''))
      return response({error: 'MEDIA_BINDING_REQUIRED'}, 400);
    try {
      if (typeof authorizeOwner !== 'function' || typeof readMedia !== 'function') throw new DispatchError('PRIVATE_MEDIA_ADAPTER_REQUIRED');
      const input = {roomId: match[1], assetId: match[2], sha256: url.searchParams.get('sha256'),
        ownerCapability: req.headers.get('x-room-owner')};
      if (await authorizeOwner(input) !== true) return response({error: 'OWNER_DENIED'}, 403);
      const media = await readMedia(input);
      const bytes = media?.bytes instanceof Uint8Array ? media.bytes : null;
      if (!bytes || bytes.byteLength < 1 || bytes.byteLength > maximumBytes || media.assetId !== input.assetId ||
          media.sha256 !== input.sha256 || media.privateSaved !== true || media.checksumVerified !== true ||
          !['audio/wav', 'video/mp4', 'application/vnd.ai-vdj.pcm-f32le'].includes(media.contentType))
        throw new DispatchError('PRIVATE_SAVED_MEDIA_REQUIRED');
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
      if (digest !== input.sha256) throw new DispatchError('MEDIA_CHECKSUM_MISMATCH');
      return new Response(bytes, {headers: {'Content-Type': media.contentType, 'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin'}});
    } catch (error) { return response({error: error instanceof DispatchError ? error.code : 'PRIVATE_MEDIA_HOLD'}, 409); }
  };
}
