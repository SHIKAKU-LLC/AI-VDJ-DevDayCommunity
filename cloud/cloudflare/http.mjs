import {createD1JudgeStore} from './d1-store.mjs';
import {createD1RoomRpc} from './room-api.mjs';
import {createRoomHandler} from '../room/handler.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const proof = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const response = (value, status = 200) => Response.json(value, {status,
  headers: {'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'}});

async function admission(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw Error('JSON_REQUIRED');
  const reader = request.body?.getReader();
  const parts = []; let size = 0;
  if (reader) while (true) {
    const {value, done} = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); throw Error('BODY_TOO_LARGE'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  let body; try { body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch { throw Error('JSON_INVALID'); }
  if (!body || Object.keys(body).sort().join(',') !== 'joinCode,nonce,ownerToken' || !uuid(body.nonce) || !proof(body.ownerToken) || !proof(body.joinCode)) throw Error('JUDGE_DENIED');
  return body;
}

// This entry can collect ideas before the generation runtime is connected.
// Capabilities stay disabled until real generation and playback are wired.
export function createCloudflareRoomApi({db, eventId, origin, generationEnabled = false} = {}) {
  if (!origin || new URL(origin).origin !== origin) throw Error('JUDGE_CONFIGURATION_REQUIRED');
  const store = createD1JudgeStore({db, eventId});
  const rpc = createD1RoomRpc({db, eventId});
  const room = createRoomHandler({rpc, origin, verifyOwner: async () => null});
  return async request => {
    const url = new URL(request.url);
    if (url.origin !== origin || request.headers.has('origin') && request.headers.get('origin') !== origin) return response({error: 'ORIGIN_DENIED'}, 403);
    if (request.method === 'GET' && url.pathname === '/api/room-capabilities') return response({mode: 'judge-cloud',
      durable: true, serverManaged: true, generation: generationEnabled, autoDJ: false,
      reason: generationEnabled ? null : 'PROVIDER_NOT_CONNECTED',
      cloud: {generationJobs: generationEnabled, portableQC: generationEnabled, browserPlayback: generationEnabled,
        clipRelativeTimeline: false, playerObserver: false, macRequired: false}});
    if (request.method === 'POST' && url.pathname === '/api/judge/rooms') {
      if (request.headers.get('origin') !== origin) return response({error: 'ORIGIN_DENIED'}, 403);
      try {
        const input = await admission(request), receipt = await store.create(input);
        // An admission retry can read a room with existing members and receipts.
        // Return only the public projection, never the internal journal.
        const state = await rpc({op: 'read', room_id: receipt.roomId, capability: input.ownerToken});
        return response({...state, ownerToken: input.ownerToken, joinCode: input.joinCode,
          joinUrl: origin + '/join/' + receipt.roomId + '?code=' + input.joinCode, serverManaged: true}, 201);
      } catch (error) {
        const statuses = {BODY_TOO_LARGE: 413, JSON_REQUIRED: 415, JSON_INVALID: 400, JUDGE_DENIED: 403, JUDGE_CAPACITY: 429, JUDGE_CLOSED: 410};
        const status = statuses[error.message]; return response({error: status ? error.message : 'ROOM_BACKEND_UNAVAILABLE'}, status ?? 503);
      }
    }
    return room(request);
  };
}
