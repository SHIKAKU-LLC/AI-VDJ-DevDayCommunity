import test from 'node:test';
import assert from 'node:assert/strict';
import {createPinnedPgPoolFactory, createProductionCloudIo} from '../cloud/worker/production-io.mjs';
import {EXISTING_REPOSITORY_SELECTS} from '../cloud/jobs/repository-read-ports.mjs';
import {PRIVATE_BUCKET_TARGET} from '../cloud/worker/supabase-private-store.mjs';

const roomId = '11111111-1111-4111-a111-111111111111';
const example_epoch = '22222222-2222-4222-a222-222222222222';
const projectURL = 'https://example.supabase.co', now = () => 1000;
const bucket = {id: PRIVATE_BUCKET_TARGET, public: false, file_size_limit: 32 * 1024 * 1024,
  allowed_mime_types: ['audio/wav', 'video/mp4', 'image/png', 'image/jpeg', 'application/json']};
const platformHeaders = () => new Headers({authorization: 'example_opaque_placeholder', apikey: 'example_opaque_placeholder'});
const owner = scope => ({...scope, ownerCapability: 'a'.repeat(64)});
function fixture(extra = {}) {
  const calls = [], sql = [], counters = {pool: 0, headers: 0, owner: 0, ended: 0};
  const scope = {roomId, sessionId: example_epoch, controlRevision: 0, expiresAtMs: 50000, ownerEnabled: true};
  const objects = new Map();
  const createPool = policy => {
    counters.pool++;
    return {options: policy, on() {}, end: async () => {counters.ended++;}, connect: async () => ({
      release() {}, query: async input => {sql.push(input.text);
        return {rows: input.text === EXISTING_REPOSITORY_SELECTS.scope ? [{...scope}] : []};}
    })};
  };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({path, method: init.method, profile: init.headers.get('content-profile'),
      body: init.method === 'POST' && path.startsWith('/rest/') ? JSON.parse(init.body) : undefined});
    if (path === '/storage/v1/bucket/' + PRIVATE_BUCKET_TARGET) return Response.json(bucket);
    if (path === '/rest/v1/rpc/vdj_generation_request') return Response.json({roomId, cues: [], pending: false, stopped: true});
    const get = '/storage/v1/object/authenticated/' + PRIVATE_BUCKET_TARGET + '/';
    const put = '/storage/v1/object/' + PRIVATE_BUCKET_TARGET + '/';
    if (init.method === 'GET' && path.startsWith(get)) {
      const object = objects.get(path.slice(get.length));
      return object ? new Response(Uint8Array.from(object.bytes), {headers: {'content-type': object.mime,
        'content-length': String(object.bytes.length)}}) : Response.json({code: 'NoSuchKey'}, {status: 404});
    }
    if (init.method === 'POST' && path.startsWith(put)) {
      assert.equal(init.headers.get('x-upsert'), 'false');
      const key = path.slice(put.length);
      if (objects.has(key)) return Response.json({code: 'KeyAlreadyExists'}, {status: 409});
      objects.set(key, {bytes: Uint8Array.from(init.body), mime: init.headers.get('content-type')});
      return Response.json({Key: PRIVATE_BUCKET_TARGET + '/' + key});
    }
    assert.fail('unexpected synthetic REST route');
  };
  const options = {enabled: true, roomId, projectURL, now, createPool, fetchImpl,
    withPlatformHeaders: async (_, invoke) => {counters.headers++; return invoke(platformHeaders());},
    withOwnerAuthorization: async (scope, invoke) => {counters.owner++; return invoke(owner(scope));}, ...extra};
  return {scope, calls, sql, counters, objects, io: createProductionCloudIo(options)};
}

test('disabled composition constructs no driver, connection, auth or fetch and stays unready', async () => {
  let calls = 0; const forbidden = () => {calls++; assert.fail('disabled I/O');};
  const io = createProductionCloudIo({roomId, projectURL, createPool: createPinnedPgPoolFactory({readConnection: forbidden, loadPg: forbidden}),
    withPlatformHeaders: forbidden, withOwnerAuthorization: forbidden, fetchImpl: forbidden, now: forbidden});
  await assert.rejects(io.inspectConfiguration(), /NOT_ACTIVATED/);
  await io.close(); assert.equal(calls, 0); assert.equal(io.capabilities().executionReady, false);
});

test('pinned driver loader supplies explicit fields, lazy password resolver and verified TLS only', async () => {
  let loaded = 0, passwords = 0, configuration;
  const example_resolver = async () => {passwords++; return 'example_unused_placeholder';};
  const connection = {host: 'db.example.supabase.co', port: 5432, database: 'postgres', user: 'example_user',
    password: example_resolver, ssl: {rejectUnauthorized: true, ca: 'example_ca'}};
  const factory = createPinnedPgPoolFactory({readConnection: async () => connection,
    loadPg: async () => {loaded++; return {default: {Pool: class {constructor(options) {configuration = options;}}}};}});
  const policy = {ssl: {rejectUnauthorized: true}, max: 4, connectionTimeoutMillis: 100};
  assert.equal(loaded, 0); await factory(policy); assert.equal(loaded, 1); assert.equal(passwords, 0);
  assert.equal(configuration.password, connection.password); assert.equal(configuration.ssl.rejectUnauthorized, true);
  assert.equal(configuration.ssl.ca, 'example_ca'); assert.equal(configuration.max, 4);
  await assert.rejects(factory({...policy, ssl: {rejectUnauthorized: false}}), /POLICY_REQUIRED/);
  await assert.rejects(factory({...policy, connectionString: 'example_forbidden'}), /POLICY_REQUIRED/);
  for (const override of [{host: 'example.invalid'}, {port: 1234}, {password: 'example_literal'}, {ssl: {rejectUnauthorized: false}}]) {
    const invalid = createPinnedPgPoolFactory({readConnection: async () => ({...connection, ...override}), loadPg: async () => assert.fail('invalid config loads driver')});
    await assert.rejects(invalid(policy), /CONNECTION_REQUIRED/);
  }
  const failed = createPinnedPgPoolFactory({readConnection: () => {throw Error('example_private_detail');}});
  await assert.rejects(failed(policy), error => error.message === 'PRODUCTION_PG_CONNECTION_REQUIRED');
});

test('production readiness maps actual readonly SQL, public cueState RPC and bucket REST without claiming playback readiness', async () => {
  const x = fixture();
  const result = await x.io.inspectConfiguration();
  assert.equal(result.privateBucketCompatible, true); assert.equal(result.ownerCueRpcRead, true);
  assert.equal(result.playbackStopped, true); assert.equal(result.executionReady, false);
  assert.equal(result.observerContractAvailable, false); assert.equal(result.durableScheduler, false);
  assert(result.blockers.includes('AUTHENTICATED_PLAYER_FRONTIER_TRANSPORT_REQUIRED'));
  assert(x.sql.includes('BEGIN TRANSACTION READ ONLY')); assert(!x.sql.some(s => /^SET SESSION|INSERT|UPDATE|DELETE/.test(s)));
  assert(x.sql.every(s => s === EXISTING_REPOSITORY_SELECTS.scope || /^BEGIN TRANSACTION READ ONLY|SET LOCAL|COMMIT/.test(s)));
  const rpc = x.calls.find(c => c.path.startsWith('/rest/'));
  assert.deepEqual(rpc.body, {op: 'cueState', room_id: roomId, capability: 'a'.repeat(64), payload: {}});
  assert.equal(rpc.profile, 'public'); assert.equal(x.calls.length, 2);
  assert.equal(x.counters.headers, 2); assert.equal(x.counters.owner, 1);
  assert.equal(x.io.capabilities().actualApiConnectivityVerified, false);
  await x.io.close(); await assert.rejects(x.io.inspectConfiguration(), /CLOSED/);
});

test('private-store writes use actual immutable REST and physical rereads through the production composition', async () => {
  const x = fixture(), binding = {kind: 'owner-supplied-bootstrap'};
  const saved = await x.io.privateStore.assetStore.save({id: 'example_reference', bytes: Uint8Array.of(137, 80, 78, 71),
    contentType: 'image/png', binding, provenance: binding});
  assert.deepEqual(await x.io.privateStore.assetStore.read(saved.assetId), saved);
  const posts = x.calls.filter(c => c.method === 'POST').length;
  assert.equal(posts, 2); assert.equal(x.counters.owner, 0); assert.equal(x.counters.pool, 0);
  await x.io.privateStore.assetStore.save({id: 'example_reference', bytes: Uint8Array.of(137, 80, 78, 71),
    contentType: 'image/png', binding, provenance: binding});
  assert.equal(x.calls.filter(c => c.method === 'POST').length, posts);
  await x.io.close();
});

test('fixed identifiers and invalid clocks stop configuration checks before I/O', async () => {
  for (const input of [[], {roomId}, {headers: 'example_forbidden'}]) {
    const x = fixture(); await assert.rejects(x.io.inspectConfiguration(input), /IDS_FIXED/);
    assert.equal(x.counters.pool, 0); assert.equal(x.calls.length, 0); await x.io.close();
  }
  for (const value of [NaN, Infinity, -1, 0.1]) {
    const x = fixture({now: () => value}); await assert.rejects(x.io.inspectConfiguration(), /CLOCK_REQUIRED/);
    assert.equal(x.counters.pool, 0); assert.equal(x.calls.length, 0); await x.io.close();
  }
});

test('owner authorization rejects missing, reused, late, timed-out or changed scope without late RPC', async () => {
  let retained;
  const late = fixture({withOwnerAuthorization: (_, invoke) => {retained = invoke;}});
  await assert.rejects(late.io.inspectConfiguration(), /OWNER_CONTEXT_REQUIRED/);
  assert.throws(() => retained(owner(late.scope)), /OWNER_CONTEXT_REQUIRED/);
  assert.equal(late.calls.filter(c => c.path.startsWith('/rest/')).length, 0); await late.io.close();
  const wrong = fixture({withOwnerAuthorization: (scope, invoke) => invoke({...owner(scope), controlRevision: 9})});
  await assert.rejects(wrong.io.inspectConfiguration(), /OWNER_CONTEXT_REQUIRED/);
  assert.equal(wrong.calls.filter(c => c.path.startsWith('/rest/')).length, 0); await wrong.io.close();
  const replay = fixture({withOwnerAuthorization: async (scope, invoke) => {
    await invoke(owner(scope)); try {await invoke(owner(scope));} catch {}
  }});
  await assert.rejects(replay.io.inspectConfiguration(), /OWNER_CONTEXT_REQUIRED/);
  assert.equal(replay.calls.filter(c => c.path.startsWith('/rest/')).length, 1); await replay.io.close();
  const hung = fixture({timeoutMs: 20, withOwnerAuthorization: (_, invoke) => {retained = invoke; return new Promise(() => {});}});
  await assert.rejects(hung.io.inspectConfiguration(), /OWNER_CONTEXT_REQUIRED/);
  assert.throws(() => retained(owner(hung.scope)), /OWNER_CONTEXT_REQUIRED/); await hung.io.close();
});

test('changed room scope, bucket mismatch and private callback errors fail or remain explicitly unready', async () => {
  const changed = fixture({withOwnerAuthorization: (scope, invoke) => {
    changed.scope.controlRevision++; return invoke(owner(scope));
  }});
  await assert.rejects(changed.io.inspectConfiguration(), /SCOPE_CHANGED/); await changed.io.close();
  const failed = fixture({withOwnerAuthorization: () => {throw Error('example_private_owner_detail');}});
  await assert.rejects(failed.io.inspectConfiguration(), error => error.message === 'PRODUCTION_OWNER_CONTEXT_REQUIRED'); await failed.io.close();
  const mismatch = fixture({fetchImpl: async url => url.includes('/storage/') ? Response.json({...bucket, public: true}) :
    Response.json({roomId, cues: [], pending: false, stopped: true})});
  const result = await mismatch.io.inspectConfiguration(); assert.equal(result.privateBucketCompatible, false);
  assert(result.blockers.includes('PRIVATE_BUCKET_POLICY_MISMATCH')); assert.equal(result.executionReady, false); await mismatch.io.close();
});
