export const MODELS = Object.freeze({initial: 'fal-ai/stable-audio-3/medium/text-to-audio',
  continuation: 'fal-ai/stable-audio-3/medium/audio-outpainting', video: 'minimax/h3-max/image-to-video'});
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
  const bytes = Uint8Array.from(atob(value.data), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > limit) deny();
  return bytes;
}
export function encodeBytes(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}
export function createFalProvider({key, fetchImpl = fetch} = {}) {
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw Error('PROVIDER_NOT_CONNECTED');
  async function json(url, method = 'GET', input) {
    let response;
    try {
      response = await fetchImpl(url, {method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: new Headers([['authorization', ['Key', key].join(' ')], ['content-type', 'application/json'], ['x-fal-store-io', '0']]),
        ...(input ? {body: JSON.stringify(input)} : {})});
    } catch { throw Error('PROVIDER_UNAVAILABLE'); }
    if (!response.ok) { await response.body?.cancel(); throw Error(response.status === 403 ? 'PROVIDER_PERMISSION_REQUIRED' : 'PROVIDER_UNAVAILABLE'); }
    return JSON.parse(new TextDecoder().decode(await boundedBytes(response, 262144)));
  }
  function queueUrl(value, id) {
    const url = new URL(value);
    if (url.origin !== 'https://queue.fal.run' || url.search || url.hash || url.username || url.password ||
        !url.pathname.includes('/requests/' + id) || !/^[a-f0-9-]{36}$/.test(id)) deny();
    return url.href;
  }
  return {
    async preflight() {
      const [price, bill] = await Promise.all([
        json('https://api.fal.ai/v1/models/pricing?endpoint_id=' + encodeURIComponent(Object.values(MODELS).join(','))),
        json('https://api.fal.ai/v1/account/billing?expand=credits'),
      ]);
      for (const [kind, endpoint] of Object.entries(MODELS)) {
        const rate = price.prices?.find(p => p.endpoint_id === endpoint);
        if (!rate || rate.currency !== 'USD' || rate.unit !== (kind === 'video' ? 'seconds' : 'audios') ||
            !Number.isFinite(rate.unit_price) || rate.unit_price <= 0 || rate.unit_price > (kind === 'video' ? 0.0345 : 0.10)) throw Error('PROVIDER_PRICE_CHANGED');
      }
      if (bill.credits?.currency !== 'USD' || !Number.isFinite(bill.credits.current_balance) || bill.credits.current_balance < 1) throw Error('PROVIDER_BALANCE_REQUIRED');
      return {balanceUsd: bill.credits.current_balance, maximumCents: 100};
    },
    async submit(kind, prompt, contextUrl) {
      const endpoint = kind === 'audio' ? contextUrl ? MODELS.continuation : MODELS.initial : MODELS.video;
      const input = kind === 'audio' ? {prompt: `Instrumental electronic dance music, steady beat, no speech. ${prompt}`,
        output_format: 'wav', enable_prompt_expansion: false, enable_safety_checker: true,
        ...(contextUrl ? {audio_url: contextUrl, extend_seconds_before: 0, extend_seconds_after: 24} : {duration: 24})} :
        {prompt: `Large-screen music visual, smooth continuous movement, no flashing or strobing, no text. ${prompt}`,
          duration: 12, resolution: '480P', prompt_expansion_mode: 'disabled', enable_safety_checker: true,
          ...(contextUrl ? {image_url: contextUrl} : {})};
      const result = await json('https://queue.fal.run/' + endpoint, 'POST', input);
      const id = result.request_id;
      return {id, endpoint, statusUrl: queueUrl(result.status_url, id), responseUrl: queueUrl(result.response_url, id)};
    },
    async status(handle) { return json(queueUrl(handle.statusUrl, handle.id)); },
    async result(handle) { return json(queueUrl(handle.responseUrl, handle.id)); },
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
        return boundedBytes(response, 20 * 1024 * 1024);
      }
      deny();
    },
  };
}
