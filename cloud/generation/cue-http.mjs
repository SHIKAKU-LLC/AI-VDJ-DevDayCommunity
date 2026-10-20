import {DispatchError} from './dispatch.mjs';

export function createCueHandler({coordinator, origin = 'https://ai-vdj.vercel.app'} = {}) {
  return async req => {
    const path = new URL(req.url).pathname;
    const match = path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/cues\/(state|publish|reserve|ack|check|stop|start)$/i);
    if (!match) return null;
    const out = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Room-Owner',
    }});
    if (req.headers.get('origin') !== origin) return out({error: 'ORIGIN_DENIED'}, 403);
    if (req.method === 'OPTIONS') return out({ok: true});
    if (req.method !== 'POST') return out({error: 'POST_REQUIRED'}, 405);
    const ownerCapability = req.headers.get('x-room-owner');
    if (!/^[a-f0-9]{64}$/.test(ownerCapability ?? '') || req.headers.has('authorization') || req.headers.has('x-fal-key'))
      return out({error: 'OWNER_ONLY_WITHOUT_PROVIDER_KEY'}, 403);
    if (!req.headers.get('content-type')?.startsWith('application/json')) return out({error: 'JSON_REQUIRED'}, 415);
    try {
      const chunks = []; let size = 0; const reader = req.body?.getReader();
      if (reader) while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 4096) { await reader.cancel(); return out({error: 'BODY_TOO_LARGE'}, 413); } chunks.push(part.value); }
      const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(k => !['operationId', 'reservationId', 'ack', 'phase'].includes(k))) return out({error: 'BODY_INVALID'}, 400);
      return out(await coordinator.execute({action: match[2], roomId: match[1], ownerCapability, ...body}));
    } catch (error) { return out({error: error instanceof DispatchError ? error.code : 'CUE_OPERATION_HOLD'}, 409); }
  };
}
