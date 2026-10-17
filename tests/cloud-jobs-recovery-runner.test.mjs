import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createCloudRecoveryRunner} from '../cloud/jobs/recovery-runner.mjs';
import {createRecoveryCandidateReadPort} from '../cloud/jobs/recovery-candidates.mjs';
import {createCloudGenerationJobs} from '../cloud/jobs/generation-jobs.mjs';
import {createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';
import {createDispatchAuthority} from '../cloud/jobs/dispatch-authority.mjs';
import {createCueCoordinator} from '../cloud/generation/cue-coordinator.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';

// Synthetic RPC/provider/source ports only. These processing times do not
// establish a deployed scheduler, actual provider work or hardware playback.
const owner = 'a'.repeat(64), guest = 'b'.repeat(64), invitation = 'c'.repeat(64), key = 'example_fixture_input';
const operationId = n => 'operation_' + String(n).padStart(12, '0'), permitId = n => 'permit_' + String(n).padStart(13, '0');
const semantic = {needsClarification:false,question:'',interpretation:'穏やかに広がる',direction:'down',intensity:.5,
  visualOpenness:'increase',musicDevelopment:'Reduce competing layers gently.',visualDevelopment:'Open geometry and preserve detail.'};
async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  const uid = '11111111-1111-4111-a111-111111111111'; await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
  let room; const roomCall = async (action, proof, payload = {}, verified = null) => (await db.query(
    'select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) value', [action, room?.roomId ?? null, proof, JSON.stringify(payload), verified])).rows[0].value;
  room = await roomCall('create', null, {ownerCapability: owner, joinCode: invitation}, uid);
  await roomCall('join', invitation, {nickname: 'example_guest', participantCapability: guest});
  const submission = await roomCall('submit', guest, {nonce: 'submission_' + 's'.repeat(24), prompt: 'example private prompt'});
  let time = Date.now(), credentialReads = 0, ownerContexts = 0; const hooks = {}, calls = {posts: [], status: [], result: [], qc: 0, scans: 0};
  const source = {audioAssetId: 'example_parent', contextAssetId: 'example_context', referenceAssetId: 'example_reference',
    music: {clipId: 'example_parent', sha256: 'c'.repeat(64), profile: {assetSha256: 'c'.repeat(64)}, contextSeconds: 16,
      contextSha256: 'd'.repeat(64), contextVerified: true, ready: true, control: {version: 1, energy: .5, tension: .5, density: .5, brightness: .5}},
    video: {motifId: 'example_motif', motifSnapshotSha256: 'e'.repeat(64), referenceSha256: 'f'.repeat(64)},
    quality: {fixedBpm: 145}, playback: {actual: true, phase: 'PLAYING', revision: 0, playedUntilFrame: 256}};
  const current = structuredClone(source);
  const repository = {request: async (action, roomId, proof, payload = {}) => {
    const value = (await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
      [action, roomId, proof, JSON.stringify(payload)])).rows[0].value;
    if (action === 'read') await hooks.read?.(payload, value);
    return value;
  }};
  const ports = createExistingCloudRepositoryReadPorts({query: (sql, values) => db.query(sql, values), now: () => time,
    hostGenerationRead: input => repository.request(input.action, input.roomId, owner, input.operationId ? {operationId: input.operationId} : {})});
  const authorityGuard = createDispatchAuthority({enabled: true, repository, readScope: ports.readScope, readPermitScope: ports.readPermitScope,
    readCurrentSource: async () => structuredClone(current), mediaHost: 'example.supabase.co', now: () => time});
  const coordinator = createCueCoordinator({enabled: true, requireAuthority: true, authorityGuard, repository,
    inspectGeneration: async () => { calls.qc++; return null; }});
  const provider = {submit: async input => { calls.posts.push(input.model); await hooks.post?.(); return {request_id: 'example_request_' + calls.posts.length}; },
    status: async input => { calls.status.push(input.requestId); await hooks.status?.(); return {status: 'COMPLETED'}; },
    result: async input => { calls.result.push(input.requestId); return {data: input.model === GENERATION_CONTRACT.intent
      ? {output: JSON.stringify(semantic), usage: {cost: .001}} : input.model === GENERATION_CONTRACT.music
        ? {audio: {url: 'https://v3.fal.media/example.wav'}} : {video: {url: 'https://v3.fal.media/example.mp4'}}}; }};
  const jobsOptions = {enabled: true, requireAuthority: true, authorityGuard, repository, coordinator, provider, mediaHost: 'example.supabase.co',
    now: () => time, credentialForOperation: async () => { credentialReads++; return key; }, schedule: async () => { throw Error('example lost wake hint'); }};
  const jobs = createCloudGenerationJobs(jobsOptions);
  async function admit(n) {
    const permit = {permitId: permitId(n), kind: GENERATION_CONTRACT.version, counts: GENERATION_CONTRACT.counts,
      createdAtMs: time, expiresAtMs: time + 600000, maximumUsd: 1, source, sourceSha256: cueDigest(cueSourceIdentity(source)),
      quote: {verified: true, evidenceSha256: '1'.repeat(64), observedAtMs: time, maximumUsd: {intent: .01, music: .1, video: .5}},
      balance: {usd: 2, autoTopUp: false, observedAtMs: time}, assets: {
        context: {url: 'https://example.supabase.co/private/context', private: true, checksumVerified: true,
          sha256: source.music.contextSha256, expiresAtMs: time + 660000, serverAudioQC: true, providerOriginVerified: true},
        reference: {url: 'https://example.supabase.co/private/reference', private: true, checksumVerified: true,
          sha256: source.video.referenceSha256, expiresAtMs: time + 660000}}};
    await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
      select $1,id,epoch,control_revision,to_timestamp($3),$4::jsonb from vdj_internal.rooms where id=$2`,
    [permit.permitId, room.roomId, permit.expiresAtMs / 1000, JSON.stringify(permit)]);
    await jobs.start({roomId: room.roomId, ownerCapability: owner, operationId: operationId(n), permitId: permitId(n), submissionId: submission.submissionId});
  }
  await admit(1); credentialReads = 0;
  const {roomId, sessionId, controlRevision} = await ports.readScope({roomId: room.roomId}), scope = {roomId, sessionId, controlRevision};
  const candidates = createRecoveryCandidateReadPort({enabled: true, readScope: ports.readScope, now: () => time,
    query: async (sql, values) => { calls.scans++; const result = await db.query(sql, values); await hooks.scan?.(); return result; }});
  const options = {enabled: true, candidates, jobs, authorityGuard, repository, readScope: ports.readScope, now: () => time,
    withOwnerAuthorization: async (requested, callback) => { ownerContexts++; return callback({...requested, ownerCapability: owner}); }};
  const input = n => ({roomId: room.roomId, ownerCapability: owner, operationId: operationId(n)});
  const hint = n => ({...scope, operationId: operationId(n), permitId: permitId(n)});
  return {db, room, scope, jobs, jobsOptions, options, authorityGuard, current, calls, hooks, admit, input, hint, repository,
    make: extra => createCloudRecoveryRunner({...options, ...extra}), resetCredentials: () => { credentialReads = 0; },
    credentialReads: () => credentialReads, ownerContexts: () => ownerContexts, advanceClock: ms => { time += ms; }};
}

test('runner stays default off and rejects custom/legacy/mismatched jobs before resolving owner authorization', async t => {
  const x = await fixture(t);
  await assert.rejects(x.make({enabled: false}).runOnce(x.scope), /NOT_ACTIVATED/);
  const legacy = createCloudGenerationJobs({...x.jobsOptions, requireAuthority: false});
  for (const jobs of [{...x.jobs}, legacy]) {
    const runner = x.make({jobs}); assert.equal(runner.capabilities().recoveryRunner, false);
    await assert.rejects(runner.runOnce(x.scope), /GUARDED_JOBS_REQUIRED/);
  }
  await assert.rejects(x.make({authorityGuard: {assert: value => x.authorityGuard.assert(value)}}).runOnce(x.scope), /GUARDED_JOBS_REQUIRED/);
  assert.equal(x.ownerContexts(), 0); assert.equal(x.calls.posts.length, 0); assert.equal(x.credentialReads(), 0);
  for (const extra of [{key: 'example_input'}, {ownerCapability: owner}, {limit: 21}, {limit: 0}, {afterOperationId: 'short'}])
    await assert.rejects(x.make().runOnce({...x.scope, ...extra}), /SCOPED_IDS_REQUIRED/);
  assert.equal(x.ownerContexts(), 0);
});
test('lost hints and fresh workers recover submitted intent then AV IDs with one bounded advance, never certify unsaved QC', async t => {
  const x = await fixture(t); await x.jobs.advance(x.input(1)); assert.equal(x.calls.posts.length, 1); x.resetCredentials();
  const fresh = createCloudGenerationJobs(x.jobsOptions), first = await x.make({jobs: fresh}).runOnce(x.scope);
  assert.equal(first.results[0].attempted, true); assert.equal(first.results[0].state, 'PENDING'); assert.equal(x.calls.posts.length, 3);
  const second = await x.make({jobs: createCloudGenerationJobs(x.jobsOptions)}).runOnce(x.scope);
  assert.equal(second.results[0].state, 'WAIT_QC'); assert.equal(x.calls.posts.length, 3);
  const before = x.credentialReads(), third = await x.make().runOnce(x.scope);
  assert.equal(third.results[0].state, 'WAIT_QC'); assert.equal(x.credentialReads(), before); assert.equal(x.calls.posts.length, 3); assert(x.calls.qc > 0);
  assert.equal(first.durableScheduler, false); assert.equal(first.automaticRetry, false);
  assert.equal(JSON.stringify(first).includes(owner), false); assert.equal(JSON.stringify(first).includes('example private prompt'), false);
  assert.equal(JSON.stringify(first).includes('http'), false); assert.equal(JSON.stringify(first).includes('request_'), false);
  assert.equal((await x.db.query('select count(*)::int count from vdj_internal.generation_operations')).rows[0].count, 1);
});
test('one page processes IDs sequentially, preserves cursor, and never invents initial intent from an empty-stage hint', async t => {
  const x = await fixture(t), empty = await x.make().runOnce(x.scope);
  assert.equal(empty.results[0].attempted, false); assert.equal(empty.results[0].reason, 'RECOVERY_NOT_ELIGIBLE'); assert.equal(x.credentialReads(), 0);
  await x.jobs.advance(x.input(1)); for (const n of [2, 3]) { await x.admit(n); await x.jobs.advance(x.input(n)); }
  const page = await x.make().runOnce({...x.scope, limit: 2}); assert.equal(page.results.length, 2);
  assert.equal(page.hasMore, true); assert.equal(page.nextCursor, operationId(2)); assert.deepEqual(page.results.map(row => row.operationId), [operationId(1), operationId(2)]);
  const next = await x.make().runOnce({...x.scope, afterOperationId: page.nextCursor, limit: 2});
  assert.deepEqual(next.results.map(row => row.operationId), [operationId(3)]); assert.equal(next.hasMore, false);
  assert.equal(x.calls.posts.length, 9); assert.equal(page.results.every(row => row.attempted), true);
});
test('UNKNOWN/RESERVED hints never repost, and a stage changed after discovery is reread before credentials', async t => {
  const x = await fixture(t); x.hooks.post = async () => { throw Error('example lost provider reply'); };
  await assert.rejects(x.jobs.advance(x.input(1)), /UNKNOWN_NO_RETRY/); x.resetCredentials();
  assert.deepEqual((await x.make().runOnce(x.scope)).results, []);
  const forced = x.make({candidates: {scanIds: async () => ({candidates: [x.hint(1)], hasMore: false, nextCursor: null})}});
  assert.equal((await forced.runOnce(x.scope)).results[0].attempted, false); assert.equal(x.calls.posts.length, 1); assert.equal(x.credentialReads(), 0);
  await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stages,intent,state}','\"RESERVED\"') where id=$1", [operationId(1)]);
  assert.equal((await forced.runOnce(x.scope)).results[0].attempted, false); assert.equal(x.calls.posts.length, 1);
  delete x.hooks.post; await x.admit(2); await x.jobs.advance(x.input(2)); x.resetCredentials();
  const second = x.make({candidates: {scanIds: async () => ({candidates: [x.hint(2)], hasMore: false, nextCursor: null})}});
  let changed = false; x.hooks.read = async () => { if (!changed) { changed = true;
    await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stages,intent,state}','\"UNKNOWN\"') where id=$1", [operationId(2)]); }};
  const stale = await second.runOnce(x.scope); assert.equal(changed, true); assert.equal(stale.results[0].attempted, false);
  assert.equal(x.calls.posts.length, 2); assert.equal(x.credentialReads(), 0);
});
test('scope, Stop, source, expiry and invalid clock block recovery work after discovery with no new provider request', async t => {
  const x = await fixture(t); await x.jobs.advance(x.input(1)); x.resetCredentials();
  for (const value of [NaN, Infinity, -1]) await assert.rejects(x.make({now: () => value}).runOnce(x.scope), /CLOCK_REQUIRED/);
  x.current.playback.revision++; const stale = await x.make().runOnce(x.scope);
  assert.equal(stale.results[0].reason, 'DISPATCH_AUTHORITY_SOURCE_CHANGED'); assert.equal(stale.results[0].attempted, false);
  x.current.playback.revision--; x.advanceClock(600001);
  const expired = await x.make({candidates: {scanIds: async () => ({candidates: [x.hint(1)], hasMore: false, nextCursor: null})}}).runOnce(x.scope);
  assert.equal(expired.results[0].attempted, false); assert.equal(x.credentialReads(), 0); assert.equal(x.calls.posts.length, 1);
  await x.repository.request('cueStop', x.room.roomId, owner, {});
  await assert.rejects(x.make().runOnce(x.scope), /ROOM_STOPPED/);
  const y = await fixture(t); await y.jobs.advance(y.input(1)); y.resetCredentials();
  y.hooks.scan = () => y.db.query('update vdj_internal.rooms set control_revision=control_revision+1 where id=$1', [y.room.roomId]);
  await assert.rejects(y.make().runOnce(y.scope), /SCOPE_CHANGED/); assert.equal(y.calls.posts.length, 1); assert.equal(y.credentialReads(), 0);
});
test('a late Stop during a submitted status observation prevents result/complete and interrupts the page', async t => {
  const x = await fixture(t); await x.jobs.advance(x.input(1));
  x.hooks.status = () => x.repository.request('cueStop', x.room.roomId, owner, {});
  await assert.rejects(x.make().runOnce(x.scope), /ROOM_STOPPED/);
  assert.equal(x.calls.posts.length, 1); assert.equal(x.calls.result.length, 0);
  const op = await x.repository.request('read', x.room.roomId, owner, {operationId: operationId(1)});
  assert.equal(op.stages.intent.state, 'SUBMITTED'); assert.equal(op.stages.intent.requestId, 'example_request_1');
});
test('malformed/duplicate candidate pages and adapter exceptions are scrubbed before execution', async t => {
  const x = await fixture(t); await x.jobs.advance(x.input(1)); x.resetCredentials();
  for (const page of [{candidates: [x.hint(1), x.hint(1)], hasMore: false, nextCursor: null},
    {candidates: [{...x.hint(1), url: 'https://example.invalid/private'}], hasMore: false, nextCursor: null},
    {candidates: [x.hint(1)], hasMore: true, nextCursor: operationId(2)}])
    await assert.rejects(x.make({candidates: {scanIds: async () => page}}).runOnce(x.scope), /CANDIDATE_PAGE_REQUIRED/);
  const broken = x.make({candidates: {scanIds: async () => { throw Error('https://example.invalid/private/example_secret'); }}});
  await assert.rejects(broken.runOnce(x.scope), error => error.code === 'RECOVERY_EXECUTION_HOLD' && !error.message.includes('http'));
  assert.equal(x.calls.posts.length, 1); assert.equal(x.credentialReads(), 0);
});
test('owner-context callbacks cannot be replayed, invoked twice or reused under a different scope; resolver return data is ignored', async t => {
  const x = await fixture(t); let savedCallback;
  const once = x.make({withOwnerAuthorization: async (scope, callback) => { savedCallback = callback;
    await callback({...scope, ownerCapability: owner}); return {url: 'https://example.invalid/private'}; }});
  const result = await once.runOnce(x.scope); assert.equal(JSON.stringify(result).includes('http'), false);
  assert.throws(() => savedCallback({...x.scope, ownerCapability: owner}), /CONTEXT_REUSED/);
  const repeated = x.make({withOwnerAuthorization: async (scope, callback) => {
    const pending = callback({...scope, ownerCapability: owner}); const caught = pending.catch(() => {});
    try { callback({...scope, ownerCapability: owner}); } finally { await caught; }
  }});
  await assert.rejects(repeated.runOnce(x.scope), /CONTEXT_REUSED/);
  await assert.rejects(x.make({withOwnerAuthorization: (scope, callback) => callback({...scope, roomId: '22222222-2222-4222-a222-222222222222', ownerCapability: owner})}).runOnce(x.scope), /CONTEXT_REQUIRED/);
  await assert.rejects(x.make({withOwnerAuthorization: (scope, callback) => callback({...scope, ownerCapability: guest})}).runOnce(x.scope), /RECOVERY_EXECUTION_HOLD/);
  assert.equal(x.calls.posts.length, 0); assert.equal(x.credentialReads(), 0);
});
