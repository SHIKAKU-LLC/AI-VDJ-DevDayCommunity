import {DispatchError} from './dispatch.mjs';

// Mounted separately from collect routes. Owner capability only; a participant
// bearer and a browser-supplied permit/budget never grant provider authority.
export function createGenerationHandler({dispatcher, origin = 'https://ai-vdj.vercel.app'} = {}) {
  return async req => {
    const path = new URL(req.url).pathname.replace(/^\/(?:functions\/v1\/)?ai-vdj-room(?=\/|$)/, '');
    const match = path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/generation\/(begin|submit|poll|read|descriptor|stop)$/i);
    if (!match) return null;
    const out = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Room-Owner, X-Fal-Key',
    }});
    if (req.headers.get('origin') !== origin) return out({error: 'ORIGIN_DENIED'}, 403);
    if (req.method === 'OPTIONS') return out({ok: true});
    if (req.method !== 'POST') return out({error: 'POST_REQUIRED'}, 405);
    const ownerCapability = req.headers.get('x-room-owner');
    if (!/^[a-f0-9]{64}$/.test(ownerCapability ?? '') || req.headers.has('authorization')) return out({error: 'OWNER_DENIED'}, 403);
    if (!req.headers.get('content-type')?.startsWith('application/json')) return out({error: 'JSON_REQUIRED'}, 415);
    try {
      let bytes = 0; const chunks = [], reader = req.body?.getReader();
      if (reader) while (true) { const part = await reader.read(); if (part.done) break;
        bytes += part.value.length; if (bytes > 4096) { await reader.cancel(); return out({error: 'BODY_TOO_LARGE'}, 413); }
        chunks.push(part.value);
      }
      const joined = new Uint8Array(bytes); let at = 0; for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
      const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(joined));
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(k => !['operationId', 'permitId', 'submissionId', 'stage'].includes(k))) return out({error: 'BODY_INVALID'}, 400);
      return out(await dispatcher.execute({action: match[2], roomId: match[1], ownerCapability,
        key: req.headers.get('x-fal-key'), body, signal: req.signal}));
    } catch (e) {
      // No provider payload, auth header or raw database error reaches a response.
      return out({error: e instanceof DispatchError ? e.code : 'GENERATION_HOLD', automaticRetry: false}, 409);
    }
  };
}
