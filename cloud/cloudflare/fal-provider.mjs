import {musicPrompt, visualPrompt, MUSIC_NEGATIVE_PROMPT, DJ_DIRECTION} from './creative-direction.mjs';

export const MODELS = Object.freeze({initial: 'fal-ai/stable-audio-3/medium/text-to-audio',
  continuation: 'fal-ai/stable-audio-3/medium/audio-outpainting', video: 'minimax/h3-max/text-to-video'});
export const REFERENCE_VIDEO_MODEL = 'minimax/h3-max/reference-to-video';
const deny = () => { throw Error('PROVIDER_RESPONSE_INVALID'); };
export const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  typeof value === 'string' ? new TextEncoder().encode(value) : value)), v => v.toString(16).padStart(2, '0')).join('');
export async function boundedBytes(response, limit) {
  if (!response.ok || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); deny(); }
  const parts = []; let size = 0;
  for await (const bytes of response.body ?? []) {
    size += bytes.length;
    if (size > limit) deny();
    parts.push(bytes);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const bytes of parts) { data.set(bytes, offset); offset += bytes.length; }
  return data;
}
export function decodeArtifact(value, limit) {
  if (!value || typeof value.data !== 'string' || value.data.length > Math.ceil(limit / 3) * 4 || !/^[a-f0-9]{64}$/.test(value.sha256)) deny();
  if (value.data.length % 4) deny();
  const size = value.data.length / 4 * 3 - (value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0);
  if (!size || size > limit) deny();
  // Uint8Array.from(string, mapper) creates a large intermediate array.
  // Decode bounded chunks so a one-minute WAV fits a Worker's memory budget.
  const bytes = new Uint8Array(size); let position = 0;
  for (let offset = 0; offset < value.data.length; offset += 65536) {
    const chunk = atob(value.data.slice(offset, offset + 65536));
    for (let i = 0; i < chunk.length; i++) bytes[position++] = chunk.charCodeAt(i);
  }
  if (position !== size) deny();
  return bytes;
}
export function encodeBytes(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}
export function createFalProvider({key, fetchImpl = fetch} = {}) {
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw Error('PROVIDER_NOT_CONNECTED');
  if (!/^[\x21-\x7e]+$/.test(key)) throw Error('PROVIDER_KEY_FORMAT');
  async function json(url, method = 'GET', input) {
    const phase = url.includes('/models/pricing') ? 'pricing' : url.includes('/account/billing') ? 'billing' : 'generation';
    const problem = (code, status) => Object.assign(Error(code), {providerPhase: phase, ...(status ? {providerStatus: status} : {})});
    let response;
    try {
      response = await fetchImpl(url, {method, redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: new Headers([['authorization', ['Key', key].join(' ')], ['content-type', 'application/json'], ['x-fal-store-io', '0']]),
        ...(input ? {body: JSON.stringify(input)} : {})});
    } catch (error) { throw problem(error?.name === 'TimeoutError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_FAILED'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw problem(({401: 'PROVIDER_AUTHENTICATION_FAILED', 403: 'PROVIDER_PERMISSION_REQUIRED',
        404: 'PROVIDER_ENDPOINT_UNAVAILABLE', 429: 'PROVIDER_RATE_LIMITED'})[response.status] ?? 'PROVIDER_UNAVAILABLE', response.status);
    }
    return JSON.parse(new TextDecoder().decode(await boundedBytes(response, 262144)));
  }
  function queueUrl(value, id) {
    const url = new URL(value);
    if (url.origin !== 'https://queue.fal.run' || url.search || url.hash || url.username || url.password ||
        !url.pathname.includes('/requests/' + id) || !/^[a-f0-9-]{36}$/.test(id)) deny();
    return url.href;
  }
  return {
    async preflight({duration = 12, reference = false, audioOnly = false, videoOnly = false} = {}) {
      if (![12, 60].includes(duration)) throw Error('PROVIDER_DURATION_INVALID');
      const models = videoOnly ? {video:reference ? REFERENCE_VIDEO_MODEL : MODELS.video} : audioOnly ? {initial:MODELS.initial,...(duration===60?{continuation:MODELS.continuation}:{})} : reference ? {...MODELS, video: REFERENCE_VIDEO_MODEL} : MODELS;
      // The runtime uses a generation-only key. Billing is verified by the
      // operator; D1 reserves the event and room ceilings before paid requests.
      const price = await json('https://api.fal.ai/v1/models/pricing?endpoint_id=' + encodeURIComponent(Object.values(models).join(',')));
      for (const [kind, endpoint] of Object.entries(models)) {
        const rate = price.prices?.find(p => p.endpoint_id === endpoint);
        if (!rate || rate.currency !== 'USD' || rate.unit !== (kind === 'video' ? 'seconds' : 'audios') ||
            !Number.isFinite(rate.unit_price) || rate.unit_price <= 0 || rate.unit_price > (kind === 'video' ? 0.05 : 0.10)) throw Error('PROVIDER_PRICE_CHANGED');
      }
      return {maximumCents: DJ_DIRECTION.maximumCents};
    },
    async submit(kind, prompt, contextUrl, {duration = kind === 'audio' ? 60 : 12, mediaProfile = DJ_DIRECTION.mediaProfile, sceneIndex = 0, referenceUrl, reference} = {}) {
      if (!(kind === 'audio' ? [12, 60] : [12]).includes(duration)) throw Error('PROVIDER_DURATION_INVALID');
      if (kind === 'video' && (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= 6)) throw Error('PROVIDER_SCENE_INVALID');
      if (kind === 'video' && (!!referenceUrl !== !!reference)) throw Error('PROVIDER_REFERENCE_INVALID');
      if (referenceUrl) {
        const url = new URL(referenceUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
            !/^\/provider-media\/[a-f0-9]{64}$/.test(url.pathname)) throw Error('PROVIDER_REFERENCE_INVALID');
      }
      const endpoint = kind === 'audio' ? contextUrl ? MODELS.continuation : MODELS.initial : referenceUrl ? REFERENCE_VIDEO_MODEL : MODELS.video;
      const input = kind === 'audio' ? {prompt: musicPrompt(prompt, {duration}), negative_prompt: MUSIC_NEGATIVE_PROMPT,
        output_format: 'wav', enable_prompt_expansion: false, enable_safety_checker: true,
        ...(contextUrl ? {audio_url: contextUrl, extend_seconds_before: 0, extend_seconds_after: duration} : {duration})} :
        {prompt: visualPrompt(prompt, {sceneIndex, reference}), ...(referenceUrl ? {reference_image_urls: [referenceUrl]} : {}),
          duration, resolution: ['club-hd-v1', 'club-flow-v1'].includes(mediaProfile) ? '1080P' : '480P', aspect_ratio: '16:9',
          prompt_expansion_mode: mediaProfile === 'club-flow-v1' ? 'balanced' : mediaProfile === 'club-hd-v1' ? 'quality' : 'disabled', enable_safety_checker: true};
      const result = await json('https://queue.fal.run/' + endpoint, 'POST', input);
      const id = result.request_id;
      return {id, endpoint, statusUrl: queueUrl(result.status_url, id), responseUrl: queueUrl(result.response_url, id)};
    },
    async status(handle) { return json(queueUrl(handle.statusUrl, handle.id)); },
    async result(handle) { return json(queueUrl(handle.responseUrl, handle.id)); },
    async deleteOutputs(requestId) {
      if (!/^[a-f0-9-]{36}$/.test(requestId)) deny();
      const result = await json('https://api.fal.ai/v1/models/requests/' + requestId + '/payloads', 'DELETE');
      if (!Array.isArray(result.cdn_delete_results)) deny();
      return {deleted: result.cdn_delete_results.every(item => item.exception == null), files: result.cdn_delete_results.length};
    },
    async download(value) {
      let url = new URL(value);
      for (let redirects = 0; redirects < 3; redirects++) {
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
            !(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media') ||
              url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/falserverless/'))) deny();
        const response = await fetchImpl(url.href, {redirect: 'manual', signal: AbortSignal.timeout(45000)});
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const target = response.headers.get('location'); await response.body?.cancel();
          if (!target) deny(); url = new URL(target, url); continue;
        }
        return boundedBytes(response, 48 * 1024 * 1024);
      }
      deny();
    },
  };
}
