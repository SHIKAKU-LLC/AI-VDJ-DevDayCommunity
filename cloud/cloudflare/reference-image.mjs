import {sha256} from './fal-provider.mjs';
import {createGenerationStore} from './generation-store.mjs';
import {referenceId} from './reference-store.mjs';

export const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
const fail = code => { throw Error(code); };
const clock = "cast(unixepoch('subsec')*1000 as integer)";
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0;
}

// Browsers decode JPEG/WebP/etc and send a bounded PNG. The server independently
// verifies its dimensions and chunks and removes metadata before persistence.
export function cleanReferencePng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 57 || bytes.length > MAX_REFERENCE_BYTES ||
      signature.some((v, i) => bytes[i] !== v)) fail('IMAGE_FORMAT_INVALID');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks = [bytes.subarray(0, 8)];
  let offset = 8, width, height, seenData = false, ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('IMAGE_FORMAT_INVALID');
    const length = view.getUint32(offset), end = offset + length + 12;
    if (end > bytes.length) fail('IMAGE_FORMAT_INVALID');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) fail('IMAGE_FORMAT_INVALID');
    if (offset === 8 && type !== 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(type)) fail('IMAGE_FORMAT_INVALID');
    if (type === 'IHDR') {
      if (width !== undefined || length !== 13) fail('IMAGE_FORMAT_INVALID');
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      if (width < 32 || height < 32 || width > 1024 || height > 1024 || bytes[offset + 16] !== 8 ||
          ![2, 6].includes(bytes[offset + 17]) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20]) fail('IMAGE_FORMAT_INVALID');
    } else if (type === 'IDAT') { if (!length) fail('IMAGE_FORMAT_INVALID'); seenData = true; }
    else if (type === 'IEND') {
      if (length || !seenData || end !== bytes.length) fail('IMAGE_FORMAT_INVALID'); ended = true;
    } else if (type[0] === type[0].toUpperCase()) fail('IMAGE_FORMAT_INVALID');
    if (['IHDR', 'IDAT', 'IEND'].includes(type)) chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  if (!ended) fail('IMAGE_FORMAT_INVALID');
  const clean = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0)); let pos = 0;
  for (const chunk of chunks) { clean.set(chunk, pos); pos += chunk.length; }
  return {bytes: clean, width, height};
}

export async function verifyReferencePixels({bytes, width, height}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), parts = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset), name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (name === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const stride = width * (bytes[25] === 6 ? 4 : 3) + 1, expected = stride * height;
  const reader = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      if (size + value.length > expected) fail('IMAGE_FORMAT_INVALID');
      for (let i = (stride - size % stride) % stride; i < value.length; i += stride) {
        if (value[i] > 4) fail('IMAGE_FORMAT_INVALID');
      }
      size += value.length;
    }
    if (size !== expected) fail('IMAGE_FORMAT_INVALID');
  } catch { await reader.cancel().catch(() => {}); fail('IMAGE_FORMAT_INVALID'); }
  finally { reader.releaseLock(); }
}

const answer = (value, status = 200) => Response.json(value, {status, headers: {'cache-control': 'no-store'}});
async function readBody(request) {
  const parts = []; let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.length; if (size > MAX_REFERENCE_BYTES) fail('IMAGE_TOO_LARGE'); parts.push(chunk);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

export async function referenceImageHttp(request, env) {
  const url = new URL(request.url), match = /^\/api\/rooms\/([a-f0-9-]{36})\/reference-image\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'PUT') return answer({error: 'METHOD_NOT_ALLOWED'}, 405);
  if (url.origin !== env.PUBLIC_ORIGIN || request.headers.get('origin') !== env.PUBLIC_ORIGIN || url.search) return answer({error: 'DENIED'}, 403);
  if (env.GENERATION_ENABLED !== 'true' || env.IMAGE_DIRECTION_ENABLED !== 'true' || !env.AI?.run) return answer({error: 'IMAGE_DIRECTION_DISABLED'}, 503);
  const owner = request.headers.get('x-room-owner'), member = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (owner && member) return answer({error: 'DENIED'}, 403);
  const [roomId, nonce] = match.slice(1);
  try {
    const row = await createGenerationStore({db: env.DB, eventId: env.EVENT_ID}).authorize(roomId, owner ?? member, !!owner);
    const actorProof = await sha256(owner ?? member), document = JSON.parse(row.document);
    if (row.owner_proof !== actorProof && !document.accepting) fail('ACCEPTANCE_OFF');
    if (request.headers.get('content-type') !== 'image/png' || !/^[a-f0-9]{64}$/.test(request.headers.get('x-vdj-prompt-sha256') ?? '')) fail('IMAGE_FORMAT_INVALID');
    if (Number(request.headers.get('content-length')) > MAX_REFERENCE_BYTES) fail('IMAGE_TOO_LARGE');
    const clean = cleanReferencePng(await readBody(request)); await verifyReferencePixels(clean);
    const hash = await sha256(clean.bytes);
    const id = await referenceId(actorProof, nonce), promptHash = request.headers.get('x-vdj-prompt-sha256');
    const q = (sql, ...values) => env.DB.prepare(sql).bind(...values);
    const prior = await q("select document from vdj_runtime_records where room_id=? and kind='image-reference' and record_id=?", roomId, id).first();
    if (prior) {
      const value = JSON.parse(prior.document);
      if (value.image.sha256 !== hash || value.promptHash !== promptHash) fail('IMAGE_REFERENCE_CONFLICT');
      if (value.state === 'READY') return answer({attached: true, sha256: hash});
    }
    if (document.submissions.some(s => s.nonce === nonce && (s.participantId === 'owner' ? row.owner_proof : document.members.find(m => m.id === s.participantId)?.proof) === actorProof)) fail('IMAGE_REFERENCE_LOCKED');
    const path = 'rooms/' + await sha256(JSON.stringify(roomId)) + '/assets/' + hash + '.media';
    const value = {state: 'UPLOADING', actorProof, promptHash, image: {path, sha256: hash, byteLength: clean.bytes.length,
      width: clean.width, height: clean.height, contentType: 'image/png'}};
    await q(`insert into vdj_runtime_records(room_id,kind,record_id,version,document)
      select r.id,'image-reference',?,0,? from vdj_rooms r join vdj_events e on e.id=r.event_id
      where r.id=? and e.id=? and e.enabled=1 and e.expires_at_ms>${clock} and r.expires_at_ms>${clock}
      and (select count(*) from vdj_runtime_records where room_id=r.id and kind='image-reference')<30
      and (select count(*) from vdj_runtime_records where room_id=r.id and kind='image-reference' and json_extract(document,'$.actorProof')=?)<6
      on conflict(room_id,kind,record_id) do nothing`, id, JSON.stringify(value), roomId, env.EVENT_ID, actorProof).run();
    const saved = await q("select document from vdj_runtime_records where room_id=? and kind='image-reference' and record_id=?", roomId, id).first();
    if (!saved) fail('IMAGE_REFERENCE_LIMIT');
    const current = JSON.parse(saved.document);
    if (current.image.sha256 !== hash || current.promptHash !== promptHash) fail('IMAGE_REFERENCE_CONFLICT');
    if (!await env.MEDIA.head(path)) await env.MEDIA.put(path, clean.bytes,
      {onlyIf: {etagDoesNotMatch: '*'}, httpMetadata: {contentType: 'image/png'}, customMetadata: {sha256: hash}});
    await q("update vdj_runtime_records set document=json_set(document,'$.state','READY'),version=version+1 where room_id=? and kind='image-reference' and record_id=?", roomId, id).run();
    return answer({attached: true, sha256: hash}, 201);
  } catch (error) {
    const statuses = {ACTOR_DENIED: 403, ROOM_NOT_FOUND: 404, ACCEPTANCE_OFF: 403, IMAGE_TOO_LARGE: 413,
      IMAGE_FORMAT_INVALID: 415, IMAGE_REFERENCE_LIMIT: 429, IMAGE_REFERENCE_CONFLICT: 409, IMAGE_REFERENCE_LOCKED: 409};
    const status = statuses[error.message]; return answer({error: status ? error.message : 'IMAGE_UPLOAD_UNAVAILABLE'}, status ?? 503);
  }
}

