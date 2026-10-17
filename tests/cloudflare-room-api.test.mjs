import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createCloudflareRoomApi} from '../cloud/cloudflare/http.mjs';
import {createRoomApiClient} from '../room-web/rooms/room-api-client.mjs';
import {createRoomModelPort} from '../room-web/rooms/room-model-port.mjs';

const origin = 'https://room.example.com';
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../cloud/cloudflare/schema.sql', import.meta.url), 'utf8'));
  sqlite.prepare('insert into vdj_events values(?,1,?,10,1000)').run('judge-api', Date.now() + 3600000);
  const db = {prepare: sql => ({bind(...values) { const statement = sqlite.prepare(sql); return {
    async first() { return statement.get(...values) ?? null; },
    async run() { const result = statement.run(...values); return {success: true, meta: {changes: Number(result.changes)}}; },
  }; }})};
  const handle = createCloudflareRoomApi({db, eventId: 'judge-api', origin});
  const call = (path, body, headers = {}) => handle(new Request(origin + path, {method: body === undefined ? 'GET' : 'POST',
    headers: {origin, 'content-type': 'application/json', ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
  async function create(ownerToken = a, joinCode = b) {
    const body = {nonce: crypto.randomUUID(), ownerToken, joinCode};
    const response = await call('/api/judge/rooms', body); assert.equal(response.status, 201);
    return {body, room: await response.json()};
  }
  const client = options => createRoomApiClient({...options, enabled: true, request: async (path, {method, headers, body}) => {
    const response = await handle(new Request(origin + path, {method, headers: new Headers({origin,
      'content-type': 'application/json', ...Object.fromEntries(headers)}), ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
    const value = await response.json(); if (!response.ok) throw Object.assign(Error(value.error), {status: response.status}); return value;
  }});
  return {sqlite, db, handle, call, create, client};
}

test('D1 HTTP serves existing owner and participant clients, durable receipts and sanitized room views', async () => {
  const f = await fixture();
  try {
    const {body, room} = await f.create();
    assert.deepEqual(await (await f.call('/api/judge/rooms', body)).json(), room);
    const owner = createRoomModelPort({client: f.client({roomId: room.roomId, ownerToken: a}), owner: true});
    const participant = createRoomModelPort({client: f.client({roomId: room.roomId, joinCode: b})});
    assert.equal((await owner.readRoom()).mode, 'collect');
    assert.equal((await participant.readRoom()).joinRequired, true);
    await participant.joinParticipant('参加者');
    const submitted = await participant.submit({nonce: 'submission_nonce_00001', prompt: '海を感じる音楽'});
    assert.equal(submitted.nickname, '参加者');
    assert.equal((await owner.readRoom()).requests.length, 1);
    assert.equal((await participant.readOperation('submission_nonce_00001')).requestId, submitted.requestId);
    const replay = await participant.submit({nonce: 'submission_nonce_00001', prompt: '海を感じる音楽'});
    assert.equal(replay.requestId, submitted.requestId);
    await assert.rejects(participant.submit({nonce: 'submission_nonce_00001', prompt: '別の内容'}), /NONCE_CONFLICT/);
    const restarted = createCloudflareRoomApi({db: f.db, eventId: 'judge-api', origin});
    const raw = await (await restarted(new Request(origin + '/api/rooms/' + room.roomId, {headers: {'x-room-owner': a}}))).json();
    assert.equal(raw.submissions.length, 1);
    assert.ok(!JSON.stringify(raw).includes('proof'));
    assert.ok(!JSON.stringify(raw).includes(a));
    const admissionReplay = await (await f.call('/api/judge/rooms', body)).json();
    assert.equal(admissionReplay.submissions.length, 1);
    assert.ok(!JSON.stringify(admissionReplay).includes('proof'));
    assert.ok(!Object.hasOwn(admissionReplay, 'operations'));
    assert.ok(!Object.hasOwn(admissionReplay, 'members'));
    owner.dispose(); participant.dispose();
  } finally { f.sqlite.close(); }
});

test('D1 HTTP bounds input, separates rooms and uses database expiry for writes', async () => {
  const f = await fixture();
  try {
    const {room} = await f.create();
    const another = await f.create(c, 'd'.repeat(64));
    const rejected = await f.call('/api/judge/rooms', {nonce: crypto.randomUUID(), ownerToken: a, joinCode: b, extra: 'x'.repeat(2048)});
    assert.equal(rejected.status, 413);
    assert.equal((await f.call('/api/rooms/' + another.room.roomId, undefined, {'x-room-owner': a})).status, 403);
    const crossOrigin = await f.handle(new Request(origin + '/api/room-capabilities', {headers: {origin: 'https://other.example'}}));
    assert.equal(crossOrigin.status, 403);
    f.sqlite.prepare('update vdj_rooms set expires_at_ms=? where id=?').run(Date.now() - 1, room.roomId);
    assert.equal((await f.call('/api/rooms/' + room.roomId + '/submissions', {nonce: 'expired_submit_nonce_001', nickname: '名前', prompt: '音楽'}, {'x-room-owner': a})).status, 404);
  } finally { f.sqlite.close(); }
});

test('D1 control binds owner, revision and nonce; participant writes and unavailable generation fail closed', async () => {
  const f = await fixture();
  try {
    const {room} = await f.create();
    const owner = createRoomModelPort({client: f.client({roomId: room.roomId, ownerToken: a}), owner: true});
    await owner.readRoom();
    const input = {action: 'ACCEPT_OFF', nonce: 'control_operation_00001', expectedRevision: 0};
    assert.equal((await owner.ownerControl(input)).snapshot.accepting, false);
    assert.equal((await owner.readOperation(input.nonce)).controlRevision, 1);
    assert.equal((await f.call('/api/rooms/' + room.roomId + '/participants', {joinCode: b, nickname: '参加者'})).status, 409);
    assert.equal((await f.call('/api/rooms/' + room.roomId, undefined, {'x-room-owner': c})).status, 403);
    await assert.rejects(owner.ownerControl({...input, nonce: 'stale_control_nonce_001'}), /REVISION_CONFLICT/);
    await assert.rejects(owner.ownerControl({action: 'GENERATION_RESUME', nonce: 'resume_control_nonce_01', expectedRevision: 1}), /PROVIDER_NOT_CONNECTED/);
    f.sqlite.exec('update vdj_events set enabled=0');
    assert.equal((await f.call('/api/rooms/' + room.roomId, undefined, {'x-room-owner': a})).status, 404);
    owner.dispose();
  } finally { f.sqlite.close(); }
});

test('D1 concurrent submissions retain both writes and capabilities never advertise unconnected generation', async () => {
  const f = await fixture();
  try {
    const {room} = await f.create();
    const path = '/api/rooms/' + room.roomId + '/submissions';
    const responses = await Promise.all([1, 2, 3].map(n => f.call(path, {nonce: 'parallel_submission_0000' + n,
      nickname: 'オーナー', prompt: '音楽' + n}, {'x-room-owner': a})));
    assert.deepEqual(responses.map(r => r.status), [201, 201, 201]);
    const raw = await (await f.call('/api/rooms/' + room.roomId, undefined, {'x-room-owner': a})).json();
    assert.equal(raw.submissions.length, 3);
    const capabilities = await (await f.call('/api/room-capabilities')).json();
    assert.equal(capabilities.serverManaged, true); assert.equal(capabilities.generation, false); assert.equal(capabilities.cloud.macRequired, false);
    const denied = await f.handle(new Request(origin + '/api/judge/rooms', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}));
    assert.equal(denied.status, 403);
  } finally { f.sqlite.close(); }
});

test('D1 preserves participant privacy on snapshots, feeds and direct lookups with actor-specific retries', async () => {
  const f = await fixture();
  try {
    const {room} = await f.create();
    const base = '/api/rooms/' + room.roomId;
    const join = async nickname => (await f.call(base + '/participants', {joinCode: b, nickname})).json();
    const first = await join('参加者一'), second = await join('参加者二');
    const actorHeaders = member => Object.fromEntries(new Headers([['authorization', 'Bearer ' + member.participantToken]]));
    const firstHeaders = actorHeaders(first), secondHeaders = actorHeaders(second);
    const nonce = 'shared_participant_nonce_01';
    const one = await (await f.call(base + '/submissions', {nonce, prompt: '海'}, firstHeaders)).json();
    const twoResponse = await f.call(base + '/submissions', {nonce, prompt: '空'}, secondHeaders);
    assert.equal(twoResponse.status, 201);
    const two = await twoResponse.json();
    const view = await (await f.call(base, undefined, firstHeaders)).json();
    assert.deepEqual(view.submissions.map(value => value.submissionId), [one.submissionId]);
    assert.deepEqual(view.participants.map(value => value.participantId), [first.participantId]);
    assert.equal((await f.call(base + '/submissions/' + two.submissionId, undefined, firstHeaders)).status, 404);
    const feed = await (await f.call(base + '/events', undefined, firstHeaders)).json();
    assert.equal(feed.snapshot.submissions.length, 1);
    assert.ok(!JSON.stringify(feed).includes('参加者二'));
    const owner = await (await f.call(base, undefined, {'x-room-owner': a})).json();
    assert.equal(owner.submissions.length, 2);
  } finally { f.sqlite.close(); }
});

test('D1 preserves the durable six-action burst limit while allowing the same receipt to be replayed', async () => {
  const f = await fixture();
  try {
    const {room} = await f.create();
    const path = '/api/rooms/' + room.roomId + '/submissions', headers = {'x-room-owner': a};
    const body = number => ({nonce: 'burst_operation_nonce_00' + number, nickname: 'オーナー', prompt: '音楽'});
    for (let n = 0; n < 6; n++) assert.equal((await f.call(path, body(n), headers)).status, 201);
    assert.equal((await f.call(path, body(6), headers)).status, 429);
    assert.equal((await f.call(path, body(0), headers)).status, 201);
  } finally { f.sqlite.close(); }
});
