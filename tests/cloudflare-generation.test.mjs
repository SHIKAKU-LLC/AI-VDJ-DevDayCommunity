import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createD1JudgeStore} from '../cloud/cloudflare/d1-store.mjs';
import {createD1RoomRpc} from '../cloud/cloudflare/room-api.mjs';
import {createGenerationStore} from '../cloud/cloudflare/generation-store.mjs';
import {createGenerationClass} from '../cloud/cloudflare/generation-runtime.mjs';
import {generationHttp} from '../cloud/cloudflare/generation-http.mjs';
import {MODELS, LEGACY_VIDEO, createFalProvider, sha256} from '../cloud/cloudflare/fal-provider.mjs';
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
    async setAlarm(t) { values.set('alarm', t); }, async getAlarm() { return values.get('alarm') ?? null; },
    async deleteAlarm() { values.delete('alarm'); }};
  const media = {async head(k) { return objects.get(k); }, async put(k, bytes, options) {
    objects.set(k, {size: bytes.length, etag: 'test-etag', bytes, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata});
  }, async get(k) { const o = objects.get(k); return o ? {...o, body: new Blob([o.bytes]).stream()} : null; }};
  let posted = 0, unknown = false;
  const fetchImpl = async (url, options) => {
    requests.push({url: String(url), method: options?.method ?? 'GET'});
    if (String(url).includes('/models/pricing')) return Response.json({prices: [...Object.entries(MODELS), ['video', LEGACY_VIDEO]].map(([k, endpoint_id]) =>
      ({endpoint_id, unit: k === 'video' ? 'seconds' : 'audios', unit_price: k === 'video' ? .05 : .04, currency: 'USD'}))});
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
      {audio: await artifact(), context: await artifact(), duration: Number(request.headers.get('x-vdj-duration-seconds')), quality: {passed: true}} :
      {video: await artifact(), duration: Number(request.headers.get('x-vdj-duration-seconds')), quality: {passed: true}})})}};
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
    assert.equal(f.sqlite.prepare('select sum(cents) n from vdj_budget_reservations').get().n, 500);
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
    assert.equal(job.assets.video.duration, 12);
    assert.equal(job.providerReceipts.filter(r => r.kind === 'video').length, 1);
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
    assert.equal(f.posted(), 2); assert.equal((await f.store.records(f.room.roomId))[0].state, 'NEEDS_REVIEW');
  } finally { f.sqlite.close(); }
});
test('five sets start all ten independent requests before any provider response, with durable markers', async () => {
  const f = await fixture();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const base = f.env.testFetch;
  let inFlight = 0, peak = 0;
  try {
    const submissions = [];
    for (let i = 0; i < 5; i++) submissions.push(await f.submit());
    await f.runtime.enqueue(f.room.roomId, submissions.map(s => s.submissionId));
    f.env.testFetch = async (url, options) => {
      if (options?.method !== 'POST') return base(url, options);
      inFlight++; peak = Math.max(peak, inFlight);
      const saved = f.values.get('jobs');
      assert.equal(saved.flatMap(j => Object.values(j.parts)).filter(p => p.state === 'SUBMITTING').length, 10);
      if (inFlight === 10) release();
      await barrier;
      const result = await base(url, options); inFlight--; return result;
    };
    await f.runtime.alarm();
    assert.equal(peak, 10); assert.equal(f.posted(), 10);
    assert.ok((await f.store.records(f.room.roomId)).every(j => j.state === 'GENERATING'));
    assert.ok(f.values.get('jobs').every(j => Object.values(j.parts).every(p => p.state === 'WAIT' && p.handle.id)));
    const restarted = new (createGenerationClass(class {}))(f.runtime.ctx, f.env);
    for (let i = 0; i < 6; i++) await restarted.alarm();
    assert.ok((await f.store.records(f.room.roomId)).every(j => j.state === 'READY'));
    assert.equal(f.posted(), 10); // recreation/result reads never repurchase
    assert.equal(f.values.get('alarm'), undefined);
  } finally { release(); f.sqlite.close(); }
});
test('a slow first set does not block later sets and heavy preparation stays serialized', async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    await f.runtime.enqueue(f.room.roomId, [a.submissionId, b.submissionId]);
    await f.runtime.alarm();
    const slow = Object.values(f.values.get('jobs')[0].parts).map(p => p.handle.id);
    const base = f.env.testFetch;
    f.env.testFetch = (url, options) => String(url).endsWith('/status') && slow.some(id => String(url).includes(id)) ?
      Promise.resolve(Response.json({status: 'IN_PROGRESS'})) : base(url, options);
    const native = f.env.NATIVE_PROCESSOR.getByName(); let active = 0, peak = 0;
    f.env.NATIVE_PROCESSOR.getByName = () => ({async fetch(request) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      const result = await native.fetch(request); active--; return result;
    }});
    await f.runtime.alarm();
    const jobs = await f.store.records(f.room.roomId);
    assert.equal(jobs.find(j => j.id === a.submissionId).state, 'GENERATING');
    assert.equal(jobs.find(j => j.id === b.submissionId).state, 'READY');
    assert.equal(peak, 1); assert.equal(f.posted(), 4);
  } finally { f.sqlite.close(); }
});
test('deployment imports a legacy video receipt and uncertain markers without resubmission', async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    await f.runtime.enqueue(f.room.roomId, [a.submissionId, b.submissionId]);
    const jobs = f.values.get('jobs'), id = crypto.randomUUID();
    jobs[0] = {...jobs[0], duration: undefined, state: 'VIDEO_WAIT', submittedAtMs: Date.now(),
      assets: {audio: {duration: 24}, context: {duration: 16}},
      videoHandle: {id, endpoint: LEGACY_VIDEO, statusUrl: `https://queue.fal.run/test/requests/${id}/status`,
        responseUrl: `https://queue.fal.run/test/requests/${id}`},
      providerReceipts: [{kind: 'video', endpoint: LEGACY_VIDEO, requestId: id}]};
    jobs[1].state = 'AUDIO_SUBMITTING'; f.values.set('jobs', structuredClone(jobs));
    const restarted = new (createGenerationClass(class {}))(f.runtime.ctx, f.env);
    await restarted.alarm();
    assert.equal(f.posted(), 0);
    const saved = await f.store.records(f.room.roomId);
    assert.equal(saved.find(j => j.id === a.submissionId).state, 'READY');
    assert.equal(saved.find(j => j.id === a.submissionId).providerReceipts[0].requestId, id);
    assert.equal(saved.find(j => j.id === b.submissionId).state, 'NEEDS_REVIEW');
    assert.ok(!JSON.stringify(saved).includes('queue.fal.run'));
  } finally { f.sqlite.close(); }
});
test('temporary native contention reuses completed results without resubmitting generation', async () => {
  const f = await fixture();
  try {
    const s = await f.submit(); await f.runtime.enqueue(f.room.roomId, [s.submissionId]);
    await f.runtime.alarm();
    const native = f.env.NATIVE_PROCESSOR.getByName();
    f.env.NATIVE_PROCESSOR.getByName = () => ({fetch: async () => new Response(null, {status: 409})});
    await f.runtime.alarm();
    assert.ok(Object.values(f.values.get('jobs')[0].parts).every(p => p.state === 'PREPARING'));
    f.env.NATIVE_PROCESSOR.getByName = () => native;
    await new (createGenerationClass(class {}))(f.runtime.ctx, f.env).alarm();
    assert.equal((await f.store.records(f.room.roomId))[0].state, 'READY'); assert.equal(f.posted(), 2);
  } finally { f.sqlite.close(); }
});
test('preflight authentication, permission and rate failures reserve no budget or paid request', async () => {
  const f = await fixture();
  try {
    const s = await f.submit();
    for (const [status, error] of [[401, 'PROVIDER_AUTHENTICATION_FAILED'], [403, 'PROVIDER_PERMISSION_REQUIRED'], [429, 'PROVIDER_RATE_LIMITED']]) {
      f.env.testFetch = async () => new Response(null, {status});
      const response = await generationHttp(new Request(`https://test.example/api/rooms/${f.room.roomId}/generation`, {
        method: 'POST', headers: {origin: f.env.PUBLIC_ORIGIN, 'content-type': 'application/json', 'x-room-owner': f.owner},
        body: JSON.stringify({submissionIds: [s.submissionId]}),
      }), f.env);
      assert.equal(response.status, 503);
      const details = await response.json();
      assert.equal(details.error, error); assert.equal(details.phase, 'provider-preflight');
      assert.ok(['pricing', 'billing'].includes(details.providerPhase)); assert.equal(details.providerStatus, status);
    }
    assert.equal(f.sqlite.prepare('select count(*) n from vdj_budget_reservations').get().n, 0);
    assert.equal(f.posted(), 0);
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
test('Wan receives one explicit 24-second video request with bounded output settings', async () => {
  let submitted;
  const provider = createFalProvider({key: 'synthetic-only', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'manual');
    submitted = {url, input: JSON.parse(options.body)};
    const id = crypto.randomUUID();
    return Response.json({request_id: id, status_url: `https://queue.fal.run/model/requests/${id}/status`, response_url: `https://queue.fal.run/model/requests/${id}`});
  }});
  await provider.submit('video', '青い波', undefined, {duration: 24});
  assert.equal(submitted.url, 'https://queue.fal.run/alibaba/wan-3.0/text-to-video');
  assert.deepEqual(submitted.input, {prompt: 'Large-screen music visual, smooth continuous movement, no flashing or strobing, no text. 青い波',
    duration: 24, resolution: '480p', aspect_ratio: '16:9', audio: false,
    enable_prompt_expansion: false, enable_thinking: false, enable_safety_checker: true});
});
test('generation-only credentials need no billing access and still enforce live model prices', async () => {
  const provider = createFalProvider({key: 'synthetic-only', fetchImpl: async (url, options) => {
    assert.ok(url.includes('/models/pricing'));
    assert.equal(options.redirect, 'manual');
    return Response.json({prices: Object.entries(MODELS).map(([kind, endpoint_id]) =>
      ({endpoint_id, unit: kind === 'video' ? 'seconds' : 'audios', unit_price: kind === 'video' ? .05 : .04, currency: 'USD'}))});
  }});
  assert.deepEqual(await provider.preflight(), {maximumCents: 100});
});
test('H3 Max receives a single 12-second visual request and matching music duration', async () => {
  const submitted = [];
  const provider = createFalProvider({key: 'synthetic-only', fetchImpl: async (url, options) => {
    submitted.push({url, input: JSON.parse(options.body)});
    const id = crypto.randomUUID();
    return Response.json({request_id: id, status_url: `https://queue.fal.run/test/requests/${id}/status`, response_url: `https://queue.fal.run/test/requests/${id}`});
  }});
  await provider.submit('video', '光の海'); await provider.submit('audio', '光の海');
  assert.equal(submitted[0].url, 'https://queue.fal.run/minimax/h3-max/text-to-video');
  assert.equal(submitted[0].input.duration, 12); assert.equal(submitted[0].input.resolution, '480P');
  assert.equal(submitted[0].input.prompt_expansion_mode, 'disabled');
  assert.equal(submitted[0].input.enable_safety_checker, true);
  assert.equal(submitted[1].input.duration, 12);
  await assert.rejects(provider.submit('video', 'invalid', undefined, {duration: 30}), /PROVIDER_DURATION_INVALID/);
});
test('budget schema migration preserves existing reservations and permits the new per-set limit', async () => {
  const f = await fixture();
  try {
    f.sqlite.prepare('insert into vdj_budget_reservations values(?,?,?,?,?)').run('judge-test', f.room.roomId, 'prior', 100, Date.now());
    f.sqlite.exec(await readFile(new URL('../cloud/cloudflare/generation-budget-migration.sql', import.meta.url), 'utf8'));
    const submission = await f.submit(); await f.store.enqueue(f.room.roomId, submission.submissionId);
    assert.equal(f.sqlite.prepare('select sum(cents) n from vdj_budget_reservations').get().n, 200);
    assert.equal(f.sqlite.prepare('select cents from vdj_budget_reservations where plan_id=?').get('prior').cents, 100);
    assert.deepEqual(f.sqlite.prepare('pragma foreign_key_check').all(), []);
  } finally { f.sqlite.close(); }
});
test('audio schedule has continuous overlap during delayed generation and adopts a ready next track', async () => {
  const intervals = []; let tick;
  const context = {currentTime: 0, state: 'running', destination: {}, async resume() {},
    createBufferSource: () => ({connect() {}, disconnect() {}, start(t) { this.at = t; }, stop(t) { if (t) intervals.push([this.at, t]); }}),
    createGain: () => ({connect() {}, disconnect() {}, gain: {setValueAtTime() {}, linearRampToValueAtTime() {}}})};
  const player = createContinuousPlayer({context, setTimer: fn => { tick = fn; }, clearTimer() {}});
  player.add({id: 'first', buffer: {duration: 24}}); await player.start();
  for (let time = 0; time < 100; time += .1) { context.currentTime = time; if (time > 30) player.add({id: 'second', buffer: {duration: 12}}); tick(); }
  assert.ok(intervals.length >= 5);
  for (let i = 1; i < intervals.length; i++) assert.ok(intervals[i][0] <= intervals[i - 1][1] - 1.49);
  assert.equal(player.read().currentId, 'second'); player.stop(); assert.equal(player.read().running, false);
});
