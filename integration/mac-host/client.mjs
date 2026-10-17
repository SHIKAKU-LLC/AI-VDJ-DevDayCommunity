// Browser-side ephemeral transport. Only this session credential enters memory;
// provider credentials/Keychain values never enter this module or browser URLs.
export function createMacConnection({origin, session, fetchImpl = globalThis.fetch, onEnd = () => {}} = {}) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      typeof session !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session)) throw Error('LOCAL_SESSION_REQUIRED');
  let credential = session; const pending = new Set();
  function forget() { credential = ''; for (const c of pending) c.abort(); pending.clear(); onEnd(); }
  async function request(path, value, {bytes = false, signal, body, consume} = {}) {
    if (!credential) throw Error('LOCAL_SESSION_ENDED');
    const controller = new AbortController(); pending.add(controller);
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    try {
      const response = await fetchImpl(origin + path, {method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', keepalive: path === '/api/stop',
        headers: {'Content-Type': bytes ? 'application/octet-stream' : 'application/json', 'X-VDJ-Session': credential},
        body: bytes ? body : JSON.stringify(value), signal: controller.signal});
      if (response.status === 401) forget();
      if (!response.ok) throw Error('LOCAL_REQUEST_HELD');
      const result = await (consume ? consume(response) : response.json());
      if (!credential || controller.signal.aborted) throw Error('LOCAL_SESSION_ENDED');
      return result;
    } finally { pending.delete(controller); signal?.removeEventListener('abort', cancel); }
  }
  return {
    state: () => request('/api/state', {}),
    ownerState: () => request('/api/owner/state', {}),
    pairCloud: () => request('/api/pair-cloud', {}),
    async bootstrap({audioBytes, referenceBytes}) {
      await request('/api/bootstrap/audio', null, {bytes: true, body: audioBytes});
      await request('/api/bootstrap/reference', null, {bytes: true, body: referenceBytes});
      return request('/api/bootstrap/prepare', {});
    },
    async readArtifact({roomId, assetId, signal}) {
      return request('/api/artifact', {roomId, assetId}, {signal, consume: async r => {
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 32 * 1024 * 1024 || r.headers.get('X-Asset-Id') !== assetId) throw Error('PRIVATE_ASSET_REQUIRED');
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== r.headers.get('X-Asset-Sha256')) throw Error('PRIVATE_ASSET_CHANGED');
      const provenance = JSON.parse(r.headers.get('X-Asset-Provenance') || '{}');
      return {bytes, assetId, sha256: digest, contentType: r.headers.get('X-Asset-Type'), provenance};
      }});
    },
    async readRender({roomId, cue, expectedRevision, signal}) {
      return request('/api/render', {roomId, cueId: cue.cueId, expectedRevision}, {signal, consume: async r => {
      const raw = await r.arrayBuffer(), meta = JSON.parse(r.headers.get('X-Render-Metadata'));
      if (raw.byteLength > 64 * 1024 * 1024 || raw.byteLength % 8 || meta?.sampleRate !== 44100 ||
          !Number.isSafeInteger(meta.durationFrames) || raw.byteLength !== meta.durationFrames * 8 ||
          !Number.isSafeInteger(meta.startFrame) || meta.startFrame < 0 || meta.startFrame + 256 > meta.durationFrames ||
          !['expectedPlayedWindowSha256', 'renderedPcmSha256', 'renderedFileSha256'].every(k => /^[a-f0-9]{64}$/.test(meta[k])))
        throw Error('VERIFIED_PCM_REQUIRED');
      return {...meta, pcm: new Float32Array(raw)};
      }});
    },
    async stop() { try { await request('/api/stop', {}); } finally { forget(); } },
    forget,
  };
}
