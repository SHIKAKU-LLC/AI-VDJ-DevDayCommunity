import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createRecoveryCandidateReadPort} from '../cloud/jobs/recovery-candidates.mjs';
import {createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';

// Offline existing-schema fixtures only. No provider, credential adapter,
// live connection, private-media transport or generation runner is installed.
const proof = 'a'.repeat(64), invitation = 'b'.repeat(64), hash = 'f'.repeat(64);
const operationId = n => 'operation_' + String(n).padStart(12, '0');
const permitId = n => 'permit_' + String(n).padStart(13, '0');
const submitted = name => ({state: 'SUBMITTED', requestId: `synthetic-${name}`, signature: hash});
const complete = name => ({...submitted(name), state: 'COMPLETE', result: {synthetic: true}});
const compiled = {status: 'COMPILED', commonIntentSha256: hash};
async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  const uid = '11111111-1111-4111-a111-111111111111';
  await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
  const room = (await db.query('select public.vdj_room_request($1,null,null,$2::jsonb,$3) value',
    ['create', JSON.stringify({ownerCapability: proof, joinCode: invitation}), uid])).rows[0].value;
  const submission = {submissionId: 'synthetic-submission', participantId: 'synthetic-participant', prompt: 'synthetic-private-prompt'};
  await db.query('update vdj_internal.rooms set submissions=$2::jsonb where id=$1', [room.roomId, JSON.stringify([submission])]);
  let time = Date.now(), scopeReads = 0; const queries = [], hooks = {};
  const query = async (statement, values) => {
    assert(/^select\s/i.test(statement.trim()), 'scanner/readScope execute SELECT only');
    assert(!values.includes(proof) && !values.includes(invitation), 'no owner/join proof belongs in query values');
    queries.push({statement, values}); const result = await db.query(statement, values);
    if (statement.startsWith('select o.room_id') && hooks.afterCandidateQuery) await hooks.afterCandidateQuery();
    return result;
  };
  const ports = createExistingCloudRepositoryReadPorts({query, now: () => time,
    hostGenerationRead: async () => {assert.fail('candidate discovery cannot execute authenticated operations');}});
  const scope = await ports.readScope({roomId: room.roomId}); queries.length = 0;
  // sessionId is the anonymous persisted room epoch, never an Auth session.
  const {roomId, sessionId, controlRevision} = scope, scoped = {roomId, sessionId, controlRevision};
  const readScope = async input => {scopeReads++; return ports.readScope(input);};
  const options = {enabled: true, query, readScope, now: () => time};
  async function put(n, change = {}, permitChange = {}) {
    const pdoc = {permitId: permitId(n), sourceSha256: hash, expiresAtMs: time + 600000};
    const op = {operationId: operationId(n), submissionId: submission.submissionId, prompt: submission.prompt,
      keyProof: hash, permit: pdoc, stopped: false, stages: {}, ...change};
    await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,revoked,document)
      values($1,$2,$3,$4,to_timestamp($5::double precision/1000),$6,$7::jsonb)`,
      [permitId(n), room.roomId, permitChange.roomEpoch ?? scope.sessionId, permitChange.controlRevision ?? scope.controlRevision,
        permitChange.expiresAtMs ?? time + 600000, permitChange.revoked ?? false, JSON.stringify(pdoc)]);
    await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
      [operationId(n), permitId(n), room.roomId, JSON.stringify(op)]);
    return op;
  }
  return {db, room, scope, put, hooks, queries, options, scopeReads: () => scopeReads,
    input: extra => ({...scoped, ...extra}),
    make: overrides => createRecoveryCandidateReadPort({...options, ...overrides}),
    setNow: next => {time = next;}, now: () => time};
}

test('default-off and strict ID-only inputs perform no recovery query or execution', async t => {
  const x = await fixture(t); await x.put(1);
  const disabled = x.make({enabled: false});
  await assert.rejects(disabled.scanIds(x.input()), /NOT_ACTIVATED/); assert.equal(x.queries.length, 0);
  assert.deepEqual(disabled.capabilities(), {candidateRead: false, defaultActivation: false, executesOperations: false, durableScheduler: false});
  for (const extra of [{ownerCapability: proof}, {key: 'synthetic-secret'}, {sourceSha256: hash}, {limit: 21}, {limit: 0},
    {afterOperationId: 'short'}, {sessionId: 'example-invalid-epoch'}, {controlRevision: -1}, {limit: 1.5}]) {
    await assert.rejects(x.make().scanIds(x.input(extra)), /SCOPED_IDS_REQUIRED/);
  }
  await assert.rejects(x.make().scanIds(Object.create(x.input())), /SCOPED_IDS_REQUIRED/);
  assert.equal(x.queries.length, 0);
});

test('lost notifications and fresh read ports discover durable IDs with stable bounded cursor pages and read-idempotent replay', async t => {
  const x = await fixture(t); for (let n = 1; n <= 23; n++) await x.put(n);
  // No schedule hint is sent. All knowledge comes from the pre-existing rows.
  const before = (await x.db.query('select count(*)::int count from vdj_internal.generation_operations')).rows[0].count;
  const first = await x.make().scanIds(x.input()); assert.equal(first.candidates.length, 20); assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, operationId(20)); assert.deepEqual(await x.make().scanIds(x.input()), first);
  const second = await x.make().scanIds(x.input({afterOperationId: first.nextCursor}));
  assert.deepEqual(second.candidates.map(c => c.operationId), [21, 22, 23].map(operationId));
  assert.equal(second.hasMore, false); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.candidates, ...second.candidates].map(c => c.operationId)).size, 23);
  const empty = await x.make().scanIds(x.input({afterOperationId: operationId(23)})); assert.deepEqual(empty.candidates, []);
  for (const row of first.candidates) assert.deepEqual(Object.keys(row).sort(), ['roomId', 'operationId', 'permitId', 'sessionId', 'controlRevision'].sort());
  assert(!JSON.stringify(first).includes(proof)); assert(!JSON.stringify(first).includes(hash)); assert(!JSON.stringify(first).includes('synthetic-private-prompt'));
  assert.equal((await x.db.query('select count(*)::int count from vdj_internal.generation_operations')).rows[0].count, before);
  const scans = x.queries.filter(q => q.statement.startsWith('select o.room_id'));
  assert(scans.every(q => q.values.at(-1) === 21)); assert(x.scopeReads() === 8);
  assert(scans.every(q => !/document|proof|prompt|sha|url|uid/i.test(q.statement.slice(0, q.statement.indexOf('\n  from')))));
});

test('only structurally valid pending, saved-request poll and complete-AV candidates are enumerated; no state implies execution authority', async t => {
  const x = await fixture(t);
  await x.put(1); await x.put(2, {stages: {intent: submitted('intent')}});
  await x.put(3, {stages: {intent: complete('intent'), music: submitted('music'), video: submitted('video')}, plan: compiled});
  await x.put(4, {stages: {intent: complete('intent'), music: complete('music'), video: complete('video')}, plan: compiled});
  const invalid = [
    {stages: null}, {stages: []}, {stages: {intent: {state: 'SUBMITTED'}}},
    {stages: {intent: {state: 'SUBMITTED', requestId: 'bad/request'}}},
    {stages: {intent: {state: 'SUBMITTED', requestId: 'synthetic-intent'}}},
    {stages: {intent: {...submitted('intent'), signature: 'not-a-claim'}}},
    {stages: {intent: {state: 'COMPLETE', requestId: 'synthetic-intent'}}, plan: compiled},
    {stages: {intent: submitted('intent'), music: submitted('music')}},
    {stages: {music: submitted('music')}}, {stages: {intent: complete('intent')}},
    {stages: {intent: complete('intent')}, plan: null},
    {stages: {intent: complete('intent')}, plan: []},
    {stages: {intent: complete('intent')}, plan: {status: 'UNKNOWN'}},
    {stages: {intent: submitted('intent')}, plan: compiled},
    {stages: {}, plan: compiled},
    {stages: {intent: {...complete('intent'), result: 'not-an-object'}}, plan: compiled},
    {stages: {intent: complete('intent')}, plan: {status: 'NEEDS_CLARIFICATION'}},
    {stages: {intent: complete('intent'), arbitrary: submitted('other')}, plan: compiled},
    {stages: {intent: 'SUBMITTED'}}, {stages: {intent: {requestId: 'synthetic-intent'}}},
    {stages: {}, plan: {}}, {permit: {permitId: permitId(999)}}, {operationId: operationId(999)}, {submissionId: 'missing-submission'}, {stopped: 'false'},
  ];
  for (let i = 0; i < invalid.length; i++) await x.put(20 + i, invalid[i]);
  assert.deepEqual((await x.make().scanIds(x.input())).candidates.map(c => c.operationId), [1, 2, 3, 4].map(operationId));
});

test('RESERVED UNKNOWN FAILED HOLD, any saved cue, stopped operations and invalid permit scope remain excluded', async t => {
  const x = await fixture(t); await x.put(1);
  let n = 10;
  for (const state of ['RESERVED', 'UNKNOWN', 'FAILED', 'HOLD'])
    await x.put(n++, {stages: {intent: {state, requestId: 'synthetic-request'}}});
  for (const status of ['READY', 'SELECTED', 'PLAYING', 'HOLD']) await x.put(n++, {cue: {status}});
  await x.put(n++, {cue: null}); await x.put(n++, {stopped: true});
  await x.put(n++, {}, {revoked: true}); await x.put(n++, {}, {expiresAtMs: x.now()});
  await x.put(n++, {}, {roomEpoch: '22222222-2222-4222-a222-222222222222'}); await x.put(n++, {}, {controlRevision: 1});
  assert.deepEqual((await x.make().scanIds(x.input())).candidates.map(c => c.operationId), [operationId(1)]);
});

test('the existing roomRuntime anchor blocks stopped, malformed or ambiguous room-wide progress', async t => {
  const x = await fixture(t); await x.put(1); await x.put(2, {cue: {status: 'PLAYING'}, roomRuntime: {stopped: true}});
  assert.deepEqual((await x.make().scanIds(x.input())).candidates, []);
  for (const runtime of [null, {}, {stopped: 'false'}]) {
    await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime}',$2::jsonb) where id=$1", [operationId(2), JSON.stringify(runtime)]);
    assert.deepEqual((await x.make().scanIds(x.input())).candidates, []);
  }
  await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime}','{\"stopped\":false}'::jsonb) where id=$1", [operationId(2)]);
  assert.deepEqual((await x.make().scanIds(x.input())).candidates.map(c => c.operationId), [operationId(1)]);
  await x.put(3, {cue: {status: 'PLAYING'}, roomRuntime: {stopped: false}});
  assert.deepEqual((await x.make().scanIds(x.input())).candidates, [], 'multiple first-row anchors are ambiguous, not a resume authority');
});

test('owner disable, room expiry and before/after epoch/control/TTL races fail closed without returning IDs', async t => {
  const x = await fixture(t); await x.put(1);
  await assert.rejects(x.make({readScope: async () => ({...x.scope, closed: true})}).scanIds(x.input()), /SCOPE_CHANGED/);
  let reads = 0;
  await assert.rejects(x.make({readScope: async () => ({...x.scope, closed: ++reads === 2})}).scanIds(x.input()), /SCOPE_CHANGED/);
  await assert.rejects(x.make().scanIds(x.input({controlRevision: 1})), /SCOPE_CHANGED/);
  for (const mutation of ["control_revision=control_revision+1", "epoch='33333333-3333-4333-a333-333333333333'", "expires_at=expires_at+interval '1 second'"]) {
    x.hooks.afterCandidateQuery = async () => {await x.db.query(`update vdj_internal.rooms set ${mutation} where id=$1`, [x.room.roomId]);};
    await assert.rejects(x.make().scanIds(x.input()), /SCOPE_CHANGED/);
    x.hooks.afterCandidateQuery = null;
    await x.db.query('update vdj_internal.rooms set epoch=$2,control_revision=$3,expires_at=to_timestamp($4::double precision/1000) where id=$1',
      [x.scope.roomId, x.scope.sessionId, x.scope.controlRevision, x.scope.expiresAtMs]);
  }
  x.hooks.afterCandidateQuery = async () => {await x.db.query('update vdj_internal.owners set enabled=false');};
  await assert.rejects(x.make().scanIds(x.input()), /SCOPE_UNAVAILABLE/);
  x.hooks.afterCandidateQuery = null; await x.db.query('update vdj_internal.owners set enabled=true');
  x.setNow(x.scope.expiresAtMs); await assert.rejects(x.make().scanIds(x.input()), /SCOPE_UNAVAILABLE/);
});

test('duplicate, replayed-before-cursor, out-of-order, cross-scope and sensitive injected rows are refused', async t => {
  const x = await fixture(t); await x.put(1); await x.put(2);
  const {roomId, sessionId, controlRevision} = x.scope;
  const row = {roomId, operationId: operationId(1), permitId: permitId(1), sessionId, controlRevision};
  for (const rows of [[row, row], [{...row, operationId: operationId(2)}, row], [{...row, roomId: '44444444-4444-4444-a444-444444444444'}],
    [{...row, keyProof: hash}], [{...row, operationId: 'short'}], Array.from({length: 22}, () => row)]) {
    await assert.rejects(x.make({query: async () => ({rows})}).scanIds(x.input()), /CANDIDATE_ROWS_REQUIRED/);
  }
  await assert.rejects(x.make({query: async () => ({rows: [row]})}).scanIds(x.input({afterOperationId: operationId(1)})), /CANDIDATE_ROWS_REQUIRED/);
  await assert.rejects(x.make({query: async () => {throw Error('synthetic raw database failure');}}).scanIds(x.input()), /RECOVERY_QUERY_HOLD/);
});
