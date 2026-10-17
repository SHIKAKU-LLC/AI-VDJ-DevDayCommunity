import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createProductionRepository} from '../cloud/jobs/production-repository.mjs';
import {EXISTING_REPOSITORY_SELECTS, createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';
import {RECOVERY_CANDIDATE_SELECT, createRecoveryCandidateReadPort} from '../cloud/jobs/recovery-candidates.mjs';

const roomId = '11111111-1111-4111-a111-111111111111';
const otherRoom = '22222222-2222-4222-a222-222222222222';
const proof = 'a'.repeat(64), projectURL = 'https://example.supabase.co';
const operationId = 'operation_' + 'o'.repeat(24), permitId = 'permit_' + 'p'.repeat(24);
const headers = () => new Headers([['authorization', 'example_authorization'], ['apikey', 'example_platform']]);
const withPlatformHeaders = async (_, invoke) => invoke(headers());
function poolFixture(overrides = {}) {
  const calls = [], releases = [], state = {created: 0, connects: 0, ends: 0};
  const createPool = policy => {
    state.created++;
    return {options: {...policy, ...overrides.options}, on: () => {}, end: async () => {state.ends++;},
      connect: async () => {
        state.connects++;
        if (overrides.connect) return overrides.connect();
        return {release: destroy => releases.push(destroy), query: async input => {
          calls.push(input);
          if (overrides.query) return overrides.query(input);
          return {rows: input.text === EXISTING_REPOSITORY_SELECTS.scope ? [{roomId}] : []};
        }};
      }};
  };
  return {createPool, calls, releases, state};
}
const make = overrides => createProductionRepository({roomId, projectURL, enabled: true, withPlatformHeaders, ...overrides});

test('production transport defaults off with no pool/header/network construction, including close', async () => {
  let calls = 0;
  const port = createProductionRepository({roomId, projectURL, createPool: () => calls++,
    withPlatformHeaders: () => calls++, fetchImpl: () => calls++});
  await assert.rejects(port.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]), /NOT_ACTIVATED/);
  await assert.rejects(port.request('read', roomId, proof, {}), /NOT_ACTIVATED/);
  await port.close(); await port.close(); assert.equal(calls, 0);
  assert.equal(port.capabilities().actualConnectionVerified, false);
  const exampleUrl = new URL(projectURL); exampleUrl.username = 'example_user'; exampleUrl.password = 'example_password';
  for (const url of ['http://example.supabase.co', 'https://example.supabase.co/private', 'https://example.supabase.co?x=1',
    'https://example.supabase.co#x', 'https://example.invalid', exampleUrl.href])
    assert.throws(() => createProductionRepository({roomId, projectURL: url}), /DEDICATED_PROJECT_REQUIRED/);
});

test('exact existing SELECTs have typed fixed-room parameters and one bounded read-only transaction per client', async () => {
  const x = poolFixture(), port = make(x);
  assert.deepEqual(await port.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]), {rows: [{roomId}]});
  assert.deepEqual(x.calls.map(call => call.text), ['BEGIN TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '8000ms'",
    "SET LOCAL lock_timeout = '8000ms'", EXISTING_REPOSITORY_SELECTS.scope, 'COMMIT']);
  assert(x.calls.every(call => call.query_timeout === 8000 && !Object.hasOwn(call, 'name')));
  assert.deepEqual(x.releases, [false]);
  const invalid = [
    ['select pg_sleep(1)', [roomId]], [EXISTING_REPOSITORY_SELECTS.scope + ';select 1', [roomId]],
    [EXISTING_REPOSITORY_SELECTS.scope, [otherRoom]], [EXISTING_REPOSITORY_SELECTS.operation, ['short', roomId]],
    [EXISTING_REPOSITORY_SELECTS.attachments, [roomId, [{toPostgres: () => 'example_hook'}]]],
    [RECOVERY_CANDIDATE_SELECT, [roomId, otherRoom, 0, Infinity, null, 21]],
    [RECOVERY_CANDIDATE_SELECT, [roomId, otherRoom, 0, 1, null, 22]],
  ];
  for (const [sql, params] of invalid) await assert.rejects(port.query(sql, params), /QUERY_REQUIRED/);
  assert.equal(x.state.connects, 1);
  await port.query(EXISTING_REPOSITORY_SELECTS.operation, [operationId, roomId]);
  await port.query(EXISTING_REPOSITORY_SELECTS.permit, [permitId, roomId]);
  await port.query(EXISTING_REPOSITORY_SELECTS.attachments, [roomId, ['example_submission']]);
  await port.query(RECOVERY_CANDIDATE_SELECT, [roomId, otherRoom, 0, 1, null, 21]);
  await port.close(); await port.close(); assert.equal(x.state.ends, 1);
  await assert.rejects(port.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]), /CLOSED/);
});

test('unverified TLS/unbounded pool policy and private SQL errors fail closed without error detail', async () => {
  for (const options of [{ssl: {rejectUnauthorized: false}}, {connectionTimeoutMillis: 0}, {query_timeout: 9000}, {max: 10}]) {
    const x = poolFixture({options}), port = make(x);
    await assert.rejects(port.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]), /POOL_POLICY_REQUIRED/);
    assert.equal(x.state.connects, 0); assert.equal(x.state.ends, 1); await port.close();
  }
  const x = poolFixture({query: async input => {
    if (input.text === EXISTING_REPOSITORY_SELECTS.scope) throw Error('example_private_connection_detail');
    return {rows: []};
  }}), port = make(x);
  await assert.rejects(port.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]), error => error.message === 'PRODUCTION_QUERY_HOLD');
  assert.deepEqual(x.releases, [true]); assert(!x.calls.some(call => call.text === 'COMMIT'));
  await port.close();
});

test('query/acquisition timeout and close destroy unknown clients and discard late checkout results', async () => {
  const never = () => new Promise(() => {});
  const x = poolFixture({query: input => input.text === EXISTING_REPOSITORY_SELECTS.scope ? never() : Promise.resolve({rows: []})});
  const port = make({...x, timeoutMs: 15});
  await assert.rejects(port.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]), /TIMEOUT/);
  assert.deepEqual(x.releases, [true]); assert(!x.calls.some(call => call.text === 'COMMIT')); await port.close();
  let acquired;
  const late = poolFixture({connect: () => new Promise(resolve => {acquired = resolve;})});
  const waiting = make({...late, timeoutMs: 15});
  await assert.rejects(waiting.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]), /TIMEOUT/);
  const releases = []; acquired({release: value => releases.push(value), query: () => assert.fail('late query')});
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(releases, [true]); await waiting.close();
  const running = poolFixture({query: never}), stopped = make({...running, timeoutMs: 100});
  const pending = stopped.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]);
  await new Promise(resolve => setImmediate(resolve)); await stopped.close();
  await assert.rejects(pending, /CLOSED/); assert.deepEqual(running.releases, [true]);
  const unopened = poolFixture(), shut = make(unopened);
  const noCheckout = shut.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]);
  await shut.close(); await assert.rejects(noCheckout, /CLOSED/); assert.equal(unopened.state.created, 0);
  const stuck = make({timeoutMs: 15, createPool: policy => ({options: policy, on: () => {}, connect: never, end: never})});
  await assert.rejects(stuck.query(EXISTING_REPOSITORY_SELECTS.scope, [roomId]), /TIMEOUT/);
  await assert.rejects(stuck.close(), /CLOSE_HOLD/);
});

test('public RPC maps the exact existing body and ephemeral opaque headers with no retries or header results', async () => {
  const sent = [], port = make({fetchImpl: async (url, init) => {
    sent.push({url, init}); return Response.json({operationId, stopped: false});
  }});
  assert.deepEqual(await port.request('read', roomId, proof, {operationId}), {operationId, stopped: false});
  assert.equal(sent[0].url, projectURL + '/rest/v1/rpc/vdj_generation_request');
  assert.deepEqual(JSON.parse(sent[0].init.body), {op: 'read', room_id: roomId, capability: proof, payload: {operationId}});
  assert.equal(sent[0].init.method, 'POST'); assert.equal(sent[0].init.redirect, 'error');
  assert.equal(sent[0].init.headers.get('content-profile'), 'public'); assert(sent[0].init.signal.aborted);
  await assert.rejects(port.request('read', otherRoom, proof, {}), /SCOPE_REQUIRED/);
  await assert.rejects(port.request('newGrant', roomId, proof, {}), /SCOPE_REQUIRED/);
  await assert.rejects(port.request('read', roomId, proof, {get operationId() {assert.fail('getter');}}), /JSON_REQUIRED/);
  await assert.rejects(port.request('read', roomId, proof, {toJSON: () => ({})}), /JSON_REQUIRED/);
  assert.equal(sent.length, 1); await port.close();
  let posts = 0;
  const lost = make({fetchImpl: async () => {posts++; throw Error('example_private_reply_lost');}});
  await assert.rejects(lost.request('submitted', roomId, proof, {operationId}), error => error.message === 'GENERATION_REPOSITORY_HOLD');
  assert.equal(posts, 1); await lost.close();
});

test('RPC rejects private profiles/header replay, scrubbed errors, oversized/invalid JSON and late opaque callbacks', async () => {
  let posts = 0;
  const send = async () => {posts++; return Response.json({accepted: true});};
  for (const modify of [h => h.set('content-profile', 'vdj_internal'), h => h.set('x-provider-key', 'example_forbidden')]) {
    const port = make({fetchImpl: send, withPlatformHeaders: (_, invoke) => {const h = headers(); modify(h); return invoke(h);}});
    await assert.rejects(port.request('cueState', roomId, proof), /HEADERS_REQUIRED/); await port.close();
  }
  assert.equal(posts, 0);
  const replay = make({fetchImpl: send, withPlatformHeaders: async (_, invoke) => {
    await invoke(headers()); try {await invoke(headers());} catch {} return {example_private_ignored: true};
  }});
  await assert.rejects(replay.request('cueState', roomId, proof), /CONTEXT_REQUIRED/); assert.equal(posts, 1); await replay.close();
  let late;
  const deferred = make({fetchImpl: send, withPlatformHeaders: (_, invoke) => {late = invoke;}});
  await assert.rejects(deferred.request('cueState', roomId, proof), /CONTEXT_REQUIRED/);
  assert.throws(() => late(headers()), /CONTEXT_REQUIRED/); assert.equal(posts, 1); await deferred.close();
  for (const response of [Response.json({message: 'OWNER_DENIED'}, {status: 403}),
    Response.json({message: 'example_private_url'}, {status: 500}), new Response('{bad'), new Response('x'.repeat(1024 * 1024 + 1))]) {
    const port = make({fetchImpl: async () => response});
    await assert.rejects(port.request('cueState', roomId, proof), error => ['OWNER_DENIED', 'GENERATION_REPOSITORY_HOLD'].includes(error.message));
    await port.close();
  }
  const timeout = make({timeoutMs: 15, fetchImpl: () => new Promise(() => {})});
  await assert.rejects(timeout.request('submitted', roomId, proof, {operationId}), /TIMEOUT/); await timeout.close();
});

test('offline PGlite existing SELECT/RPC contract composes fresh scope, operation, permit and recovery readers', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  await db.query('insert into vdj_internal.owners(uid) values($1)', [roomId]);
  const room = (await db.query('select public.vdj_room_request($1,null,null,$2::jsonb,$3) value',
    ['create', JSON.stringify({ownerCapability: proof, joinCode: 'b'.repeat(64)}), roomId])).rows[0].value;
  const submissionId = 'example_submission', signature = 'f'.repeat(64);
  await db.query('update vdj_internal.rooms set submissions=$2::jsonb where id=$1', [room.roomId, JSON.stringify([{submissionId}])]);
  const permit = {sourceSha256: signature}, op = {operationId, submissionId, permit: {...permit, permitId}, stopped: false,
    stages: {intent: {state: 'SUBMITTED', requestId: 'example_intent', signature}}};
  await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
    select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`,
  [permitId, room.roomId, JSON.stringify(permit)]);
  await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
    [operationId, permitId, room.roomId, JSON.stringify(op)]);
  const sql = [], releases = [];
  const transport = make({roomId: room.roomId, createPool: policy => ({options: policy, on: () => {}, end: async () => {},
    connect: async () => ({release: destroy => releases.push(destroy), query: async input => {
      sql.push(input.text); return db.query(input.text, input.values);
    }})}), fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body);
    try {return Response.json((await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
      [body.op, body.room_id, body.capability, JSON.stringify(body.payload)])).rows[0].value);}
    catch {return Response.json({message: 'OWNER_DENIED'}, {status: 403});}
  }});
  t.after(() => transport.close());
  const ports = createExistingCloudRepositoryReadPorts({query: transport.query,
    hostGenerationRead: input => transport.request(input.action, input.roomId, proof, input.operationId ? {operationId: input.operationId} : {})});
  const scope = await ports.readScope({roomId: room.roomId});
  assert.equal((await ports.readOperation({roomId: room.roomId, operationId})).operation.stages.intent.requestId, 'example_intent');
  assert.equal((await ports.readPermitScope({roomId: room.roomId, permitId})).revoked, false);
  const {roomId: scopedRoom, sessionId, controlRevision} = scope, input = {roomId: scopedRoom, sessionId, controlRevision};
  assert.equal((await ports.readAttachments({...input, submissionIds: [submissionId]}))[0].operationId, operationId);
  const candidates = createRecoveryCandidateReadPort({enabled: true, query: transport.query, readScope: ports.readScope});
  assert.equal((await candidates.scanIds(input)).candidates.length, 1);
  await transport.request('cueStop', room.roomId, proof, {});
  assert.equal((await ports.readPlaybackState(input)).stopped, true);
  assert.equal((await candidates.scanIds(input)).candidates.length, 0);
  await db.query('update vdj_internal.rooms set control_revision=control_revision+1 where id=$1', [room.roomId]);
  await assert.rejects(candidates.scanIds(input), /SCOPE_CHANGED/);
  assert(sql.filter(text => text.startsWith('select')).every(text => [...Object.values(EXISTING_REPOSITORY_SELECTS), RECOVERY_CANDIDATE_SELECT].includes(text)));
  assert(releases.every(value => value === false));
});
