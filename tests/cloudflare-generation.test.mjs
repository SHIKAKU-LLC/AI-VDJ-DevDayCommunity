import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createD1JudgeStore} from '../cloud/cloudflare/d1-store.mjs';
import {createD1RoomRpc} from '../cloud/cloudflare/room-api.mjs';
import {createGenerationStore} from '../cloud/cloudflare/generation-store.mjs';
import {createGenerationClass} from '../cloud/cloudflare/generation-runtime.mjs';
import {generationHttp} from '../cloud/cloudflare/generation-http.mjs';
import {MODELS, createFalProvider, sha256} from '../cloud/cloudflare/fal-provider.mjs';
import {createContinuousPlayer} from '../room-web/judge-player.mjs';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../cloud/cloudflare/schema.sql', import.meta.url), 'utf8'));
  sqlite.prepare('insert into vdj_events values(?,1,?,10,1000)').run('judge-test', Date.now() + 3600000);
  const db = {prepare: sql => ({bind(...args) {
    const s = sqlite.prepare(sql);
    return {async first() { return s.get(...args) ?? null; }, async all() { return {results: s.all(...args)}; },
      async run() { return {meta: {changes: Number(s.run(...args).changes)}}; }};
  }})};
  const owner = 'a'.repeat(64), join = 'b'.repeat(64);
  const room = await createD1JudgeStore({db, eventId: 'judge-test'}).create({nonce: crypto.randomUUID(), ownerToken: owner, joinCode: join});
  const rpc = createD1RoomRpc({db, eventId: 'judge-test'});
  const submit = async (capability = owner) => rpc({op: 'submit', room_id: room.roomId, capability,
    payload: {nonce: crypto.randomUUID(), nickname: '合成テスト', prompt: '青い波と静かな電子音楽'}});
  const store = createGenerationStore({db, eventId: 'judge-test'});
  const values = new Map(), objects = new Map(), requests = [];
  const storage = {async get(k) { return structuredClone(values.get(k)); }, async put(k, v) { values.set(k, structuredClone(v)); },
    async setAlarm(t) { values.set('alarm', t); }, async getAlarm() { return values.get('alarm') ?? null; }};
  const media = {async head(k) { return objects.get(k); }, async put(k, bytes, options) {
    objects.set(k, {size: bytes.length, etag: 'test-etag', bytes, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata});
  }, async get(k) { const o = objects.get(k); return o ? {...o, body: new Blob([o.bytes]).stream()} : null; }};
  let posted = 0, unknown = false;
  const fetchImpl = async (url, options) => {
    requests.push({url: String(url), method: options?.method ?? 'GET'});
    if (String(url).includes('/models/pricing')) return Response.json({prices: Object.entries(MODELS).map(([k, endpoint_id]) =>
      ({endpoint_id, unit: k === 'video' ? 'seconds' : 'audios', unit_price: k === 'video' ? .0325 : .04, currency: 'USD'}))});
    if (String(url).includes('/account/billing')) return Response.json({credits: {currency: 'USD', current_balance: 10}});
    if (options?.method === 'POST') {
      posted++; if (unknown) throw Error('lost receipt');
      const id = crypto.randomUUID();
      return Response.json({request_id: id, status_url: `https://queue.fal.run/test/model/requests/${id}/status`, response_url: `https://queue.fal.run/test/model/requests/${id}`});
    }
    if (String(url).endsWith('/status')) return Response.json({status: 'COMPLETED'});
    if (String(url).includes('queue.fal.run')) return Response.json({audio: {url: 'https://v3.fal.media/files/test.wav'}, video: {url: 'https://v3.fal.media/files/test.mp4'}});
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const artifact = async () => ({data: 'AQID', sha256: await sha256(new Uint8Array([1, 2, 3]))});
  const env = {DB: db, MEDIA: media, EVENT_ID: 'judge-test', PUBLIC_ORIGIN: 'https://test.example', GENERATION_ENABLED: 'true', FAL_KEY: 'synthetic-test-value', testFetch: fetchImpl,
    NATIVE_PROCESSOR: {getByName: () => ({fetch: async request => Response.json(request.url.endsWith('audio') ?
      {audio: await artifact(), context: await artifact(), duration: 24} : {video: await artifact(), duration: 5})})}};
  const Class = createGenerationClass(class {}), runtime = new Class({storage}, env);
  env.GENERATION = {getByName: () => runtime};
  return {sqlite, db, room, owner, join, rpc, submit, store, env, runtime, values, requests, posted: () => posted, uncertain: () => { unknown = true; }};
}

test('generation reserves at most five sets, is idempotent and enforces global budget', async () => {
  const f = await fixture();
  try {
    const submissions = [];
    for (let i = 0; i < 6; i++) submissions.push(await f.submit());
    for (const s of submissions.slice(0, 5)) await f.store.enqueue(f.room.roomId, s.submissionId);
    await f.store.enqueue(f.room.roomId, submissions[0].submissionId);
    await assert.rejects(f.store.enqueue(f.room.roomId, submissions[5].submissionId), /JUDGE_BUDGET/);
    assert.equal(f.sqlite.prepare('select sum(cents) n from vdj_budget_reservations').get().n, 250);
    assert.equal((await f.store.records(f.room.roomId)).length, 5);
  } finally { f.sqlite.close(); }
});
test('durable generation continues through audio/video, keeps handles private and serves only owner media', async () => {
  const f = await fixture();
  try {
    const s = await f.submit(); await f.runtime.enqueue(f.room.roomId, [s.submissionId]);
    for (let i = 0; i < 4; i++) await f.runtime.alarm();
    assert.equal(f.posted(), 2);
    const [job] = await f.store.records(f.room.roomId); assert.equal(job.state, 'READY');
    assert.ok(!JSON.stringify(job).includes('queue.fal.run'));
    const response = await generationHttp(new Request(`https://test.example/api/rooms/${f.room.roomId}/generated-media/${s.submissionId}/audio`,
      {headers: {'x-room-owner': f.owner}}), f.env);
    assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 3);
    const denied = await generationHttp(new Request(`https://test.example/api/rooms/${f.room.roomId}/generation`,
      {headers: {'x-room-owner': 'c'.repeat(64)}}), f.env);
    assert.equal(denied.status, 403);
    await f.runtime.enqueue(f.room.roomId, [s.submissionId]); await f.runtime.alarm(); assert.equal(f.posted(), 2);
  } finally { f.sqlite.close(); }
});
test('an unknown paid submission is never retried after object recreation', async () => {
  const f = await fixture();
  try {
    const s = await f.submit(); f.uncertain(); await f.runtime.enqueue(f.room.roomId, [s.submissionId]); await f.runtime.alarm();
    const Class = createGenerationClass(class {});
    const restarted = new Class(f.runtime.ctx, f.env); await restarted.alarm();
    assert.equal(f.posted(), 1); assert.equal((await f.store.records(f.room.roomId))[0].state, 'NEEDS_REVIEW');
  } finally { f.sqlite.close(); }
});
test('disabled or expired events cannot trigger generation and participants see only their own jobs', async () => {
  const f = await fixture();
  try {
    const participant = 'c'.repeat(64);
    await f.rpc({op: 'join', room_id: f.room.roomId, capability: f.join, payload: {nickname: '参加者', participantCapability: participant}});
    const own = await f.submit(participant), other = await f.submit();
    await f.runtime.enqueue(f.room.roomId, [own.submissionId, other.submissionId]);
    const response = await generationHttp(new Request(`https://test.example/api/rooms/${f.room.roomId}/generation`, {headers: new Headers([['authorization', ['Bearer', participant].join(' ')]])}), f.env);
    const result = await response.json(); assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].id, own.submissionId);
    f.sqlite.exec('update vdj_events set enabled=0'); await f.runtime.alarm(); assert.equal(f.posted(), 0);
  } finally { f.sqlite.close(); }
});
test('provider rejects price changes and private-network media without making a media request', async () => {
  let requests = 0;
  const provider = createFalProvider({key: 'test-only', fetchImpl: async () => { requests++; return Response.json({prices: []}); }});
  await assert.rejects(provider.download('http://127.0.0.1/secret'), /PROVIDER_RESPONSE_INVALID/);
  assert.equal(requests, 0); await assert.rejects(provider.preflight(), /PROVIDER_PRICE_CHANGED/);
});
test('audio schedule has continuous overlap during delayed generation and adopts a ready next track', async () => {
  const intervals = []; let tick;
  const context = {currentTime: 0, state: 'running', destination: {}, async resume() {},
    createBufferSource: () => ({connect() {}, disconnect() {}, start(t) { this.at = t; }, stop(t) { if (t) intervals.push([this.at, t]); }}),
    createGain: () => ({connect() {}, disconnect() {}, gain: {setValueAtTime() {}, linearRampToValueAtTime() {}}})};
  const player = createContinuousPlayer({context, setTimer: fn => { tick = fn; }, clearTimer() {}});
  player.add({id: 'first', buffer: {duration: 24}}); await player.start();
  for (let time = 0; time < 100; time += .1) { context.currentTime = time; if (time > 30) player.add({id: 'second', buffer: {duration: 24}}); tick(); }
  assert.ok(intervals.length >= 5);
  for (let i = 1; i < intervals.length; i++) assert.ok(intervals[i][0] <= intervals[i - 1][1] - 1.49);
  assert.equal(player.read().currentId, 'second'); player.stop(); assert.equal(player.read().running, false);
});
