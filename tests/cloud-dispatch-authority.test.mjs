import test from 'node:test';
import assert from 'node:assert/strict';
import {createDispatchAuthority} from '../cloud/jobs/dispatch-authority.mjs';
import {createGenerationDispatcher, DispatchError, GENERATION_CONTRACT, isAuthorityGuardedDispatcher} from '../cloud/generation/dispatch.mjs';
import {createCloudGenerationJobs, isAuthorityGuardedCloudJobs} from '../cloud/jobs/generation-jobs.mjs';
import {createCueCoordinator, isAuthorityGuardedCueCoordinator} from '../cloud/generation/cue-coordinator.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';

const owner = 'a'.repeat(64), roomId = '11111111-1111-4111-a111-111111111111';
const operationId = 'operation_' + 'o'.repeat(24), permitId = 'permit_' + 'p'.repeat(24), key = 'example_ephemeral_input';
const semantic = {needsClarification:false,question:'',interpretation:'穏やかに広がる',direction:'down',intensity:.5,
  visualOpenness:'increase',musicDevelopment:'Reduce competing layers gently.',visualDevelopment:'Open geometry and preserve detail.'};
function fixture() {
  let time = 10000, op, globalStop = false, credentialReads = 0;
  const sessionId = 'example_epoch', scope = {roomId, sessionId, controlRevision: 0, expiresAtMs: time + 1000000};
  const source = {audioAssetId: 'example_parent', contextAssetId: 'example_context', referenceAssetId: 'example_reference',
    music: {clipId: 'example_parent', sha256: 'c'.repeat(64), profile: {assetSha256: 'c'.repeat(64)}, contextSeconds: 16,
      contextSha256: 'd'.repeat(64), contextVerified: true, ready: true, control: {version: 1, energy: .5, tension: .5, density: .5, brightness: .5}},
    video: {motifId: 'example_motif', motifSnapshotSha256: 'e'.repeat(64), referenceSha256: 'f'.repeat(64)},
    quality: {fixedBpm: 145}, playback: {actual: true, phase: 'PLAYING', revision: 0, playedUntilFrame: 256}};
  const current = structuredClone(source), permit = {permitId, kind: GENERATION_CONTRACT.version, counts: GENERATION_CONTRACT.counts,
    createdAtMs: time, expiresAtMs: time + 600000, maximumUsd: 1, source, sourceSha256: cueDigest(cueSourceIdentity(source)),
    quote: {verified: true, evidenceSha256: '1'.repeat(64), observedAtMs: time, maximumUsd: {intent: .01, music: .1, video: .5}},
    balance: {usd: 2, autoTopUp: false, observedAtMs: time}, assets: {
      context: {url: 'https://media.example.invalid/private/context', private: true, checksumVerified: true,
        sha256: source.music.contextSha256, expiresAtMs: time + 660000, serverAudioQC: true, providerOriginVerified: true},
      reference: {url: 'https://media.example.invalid/private/reference', private: true, checksumVerified: true,
        sha256: source.video.referenceSha256, expiresAtMs: time + 660000}}};
  const metadata = {roomId, sessionId, controlRevision: 0, permitId, revoked: false, expiresAtMs: permit.expiresAtMs, permitSha256: cueDigest(permit)};
  const events = [], mutations = {}, calls = {post: 0, status: 0, result: 0, complete: 0};
  const repository = {async request(action, room, capability, payload = {}) {
    assert.equal(room, roomId); if (capability !== owner) throw new DispatchError('OWNER_DENIED'); events.push(action);
    if (mutations.ownerDisabled) throw new DispatchError('OWNER_DENIED');
    if (action === 'cueState') return {roomId, stopped: globalStop, currentCredit: null, pending: false, cues: []};
    if (action === 'permit') { assert.equal(payload.permitId, permitId); return structuredClone(permit); }
    if (action === 'begin') {
      op ??= {operationId, submissionId: 'example_submission', keyProof: payload.keyProof, permit: structuredClone(permit),
        prompt: '静かな星空', stages: {}, stopped: false};
      await mutations.begin?.(); return {...structuredClone(op), dispatchAllowed: true};
    }
    if (!op || payload.operationId !== operationId) throw new DispatchError('GENERATION_OPERATION_REQUIRED');
    if (action === 'read') return {...structuredClone(op), dispatchAllowed: true};
    if (action === 'stop') { op.stopped = true; await mutations.stop?.(); return structuredClone(op); }
    const prior = op.stages[payload.stage];
    if (action === 'claim') {
      if (prior) throw new DispatchError('STAGE_ALREADY_RESERVED'); op.stages[payload.stage] = {state: 'RESERVED', signature: payload.signature};
      await mutations.claim?.();
    } else if (action === 'submitted' || action === 'unknown') {
      if (prior.state !== 'RESERVED' || prior.signature !== payload.signature) throw new DispatchError('STAGE_CLAIM_REQUIRED');
      if (action === 'submitted') await mutations.beforeSubmitted?.();
      prior.state = action === 'submitted' ? 'SUBMITTED' : 'UNKNOWN'; if (action === 'submitted') prior.requestId = payload.requestId;
      if (action === 'submitted') await mutations.submitted?.();
    } else if (action === 'complete') { calls.complete++; prior.state = 'COMPLETE'; prior.result = payload.result; if (payload.plan) op.plan = payload.plan; }
    else if (action === 'held' || action === 'failed') prior.state = action === 'held' ? 'HOLD' : 'FAILED';
    else throw Error('example unsupported action');
    return structuredClone(op);
  }};
  const provider = {async submit() { calls.post++; await mutations.post?.(); return {request_id: 'example_request_' + calls.post}; },
    async status() { calls.status++; await mutations.status?.(); return {status: 'COMPLETED'}; },
    async result(input) { calls.result++; await mutations.result?.(); return {data: input.model === GENERATION_CONTRACT.intent
      ? {output: JSON.stringify(semantic), usage: {cost: .001}} : input.model === GENERATION_CONTRACT.music
        ? {audio: {url: 'https://v3.fal.media/example.wav'}} : {video: {url: 'https://v3.fal.media/example.mp4'}}}; }};
  const authorityOptions = {enabled: true, repository, readScope: async () => structuredClone(scope),
    readPermitScope: async () => structuredClone(metadata), readCurrentSource: async input => {
      assert.deepEqual(input, {roomId}); return structuredClone(current); }, mediaHost: 'media.example.invalid', now: () => time};
  const real = createDispatchAuthority(authorityOptions), phases = [];
  const guard = {async assert(input) { phases.push(input.phase); await mutations[input.phase]?.(); return real.assert(input); }};
  const options = {enabled: true, repository, provider, mediaHost: 'media.example.invalid', now: () => time, requireAuthority: true, authorityGuard: guard};
  const dispatcher = createGenerationDispatcher(options), input = {roomId, operationId, ownerCapability: owner};
  const execute = (action, body = {}, custom = dispatcher) => custom.execute({action, roomId, ownerCapability: owner, key, body: {operationId, ...body}});
  const begin = () => execute('begin', {permitId, submissionId: 'example_submission'});
  const jobs = () => createCloudGenerationJobs({...options, credentialForOperation: async () => { credentialReads++; return key; }});
  return {current, permit, scope, metadata, mutations, calls, phases, events, options, authorityOptions, guard, input, execute, begin, jobs,
    op: () => op, stop: () => { globalStop = true; }, credentialReads: () => credentialReads, expire: () => { time = permit.expiresAtMs; }};
}

test('authority is default off and requires server-owned IDs; source truth, finite metadata scope and global stop are independently checked', async () => {
  const x = fixture(), input = {...x.input, permitId, phase: 'begin-before'};
  await assert.rejects(createDispatchAuthority({...x.authorityOptions, enabled: false}).assert(input), /NOT_ACTIVATED/);
  await assert.rejects(x.guard.assert({...input, valid: true}), /SERVER_INPUT_REQUIRED/);
  assert.equal((await x.guard.assert(input)).kind, 'cloud-dispatch-authority-v1');
  x.current.playback.actual = false; await assert.rejects(x.guard.assert(input), /SOURCE_CHANGED/); x.current.playback.actual = true;
  x.current.playback.phase = 'IDLE'; await assert.rejects(x.guard.assert(input), /SOURCE_CHANGED/); x.current.playback.phase = 'PLAYING';
  x.metadata.permitSha256 = '0'.repeat(64); await assert.rejects(x.guard.assert(input), /PERMIT_CHANGED/); x.metadata.permitSha256 = cueDigest(x.permit);
  x.metadata.controlRevision++; await assert.rejects(x.guard.assert(input), /PERMIT_CHANGED/); x.metadata.controlRevision--;
  x.stop(); await assert.rejects(x.guard.assert(input), /GLOBAL_STOP/); assert.equal(x.calls.post, 0);
});
test('opt-in missing or unbound guard fails closed while legacy dispatch compatibility and diagnostic read/descriptor/stop remain', async () => {
  const x = fixture(), missing = createGenerationDispatcher({...x.options, authorityGuard: undefined});
  await assert.rejects(x.execute('begin', {permitId}, missing), /AUTHORITY_REQUIRED/); assert.equal(x.op(), undefined);
  const forged = createGenerationDispatcher({...x.options, authorityGuard: {assert: async () => true}});
  await assert.rejects(x.execute('begin', {permitId}, forged), /AUTHORITY_REQUIRED/);
  const legacy = createGenerationDispatcher({...x.options, requireAuthority: false, authorityGuard: undefined});
  await x.execute('begin', {permitId, submissionId: 'example_submission'}, legacy); x.stop();
  const before = x.phases.length; assert.equal((await x.execute('read')).state, 'PENDING');
  assert.equal((await x.execute('descriptor')).operationId, operationId); assert.equal((await x.execute('stop')).state, 'STOPPED');
  assert.equal(x.phases.length, before);
});
test('fresh authority permits ordinary intent then concurrent AV and reuses durable submitted IDs without reposting', async () => {
  const x = fixture(); await x.begin(); await x.execute('submit', {stage: 'intent'}); await x.execute('poll', {stage: 'intent'});
  await Promise.all(['music', 'video'].map(stage => x.execute('submit', {stage})));
  await Promise.all(['music', 'video'].map(stage => x.execute('poll', {stage})));
  assert.equal(x.calls.post, 3); assert.equal(x.calls.complete, 3); assert.equal((await x.execute('read')).state, 'WAIT_QC');
  await x.execute('submit', {stage: 'music'}); await x.execute('poll', {stage: 'video'}); assert.equal(x.calls.post, 3);
  for (const phase of ['begin-before', 'begin-after', 'submit-before-claim', 'submit-after-claim', 'submit-before-provider',
    'submit-after-provider', 'poll-before-status', 'poll-after-status', 'poll-before-result', 'poll-after-result', 'poll-before-complete']) assert(x.phases.includes(phase), phase);
});
test('source/stop invalidation before begin or claim prevents a new operation or provider delivery, including equal dispatchAllowed', async () => {
  const x = fixture(); x.current.music.sha256 = '0'.repeat(64); await assert.rejects(x.begin(), /SOURCE_CHANGED/); assert.equal(x.op(), undefined);
  const y = fixture(); await y.begin(); y.current.playback.revision++;
  await assert.rejects(y.execute('submit', {stage: 'intent'}), /SOURCE_CHANGED/); assert.equal(y.op().stages.intent, undefined); assert.equal(y.calls.post, 0);
  const z = fixture(); z.mutations.begin = z.stop; await assert.rejects(z.begin(), /GLOBAL_STOP/); assert(z.op()); assert.equal(z.calls.post, 0);
});
test('late global stop or source change after claim/prePOST holds unknown; known provider response is retained then stopped without repost', async () => {
  for (const phase of ['submit-after-claim', 'submit-before-provider']) {
    const x = fixture(); await x.begin(); x.mutations[phase] = () => { x.current.music.control.version++; };
    await assert.rejects(x.execute('submit', {stage: 'intent'}), /UNKNOWN_NO_RETRY/);
    assert.equal(x.op().stages.intent.state, 'UNKNOWN'); assert.equal(x.calls.post, 0);
    await assert.rejects(x.execute('submit', {stage: 'intent'}, createGenerationDispatcher(x.options)), /UNKNOWN_NO_RETRY/);
  }
  const y = fixture(); await y.begin(); y.mutations.claim = y.stop;
  await assert.rejects(y.execute('submit', {stage: 'intent'}), /UNKNOWN_NO_RETRY/); assert.equal(y.calls.post, 0);
  const z = fixture(); await z.begin(); z.mutations.post = z.stop;
  await assert.rejects(z.execute('submit', {stage: 'intent'}), /KNOWN_DELIVERY_STOPPED_NO_RETRY/); assert.equal(z.calls.post, 1);
  assert.equal(z.op().stages.intent.state, 'SUBMITTED'); assert.equal(z.op().stages.intent.requestId, 'example_request_1'); assert.equal(z.op().stopped, true);
  assert.equal((await z.execute('submit', {stage: 'intent'}, createGenerationDispatcher(z.options))).state, 'STOPPED');
  await assert.rejects(z.execute('poll', {stage: 'intent'}), /GENERATION_STOPPED/); assert.equal(z.calls.complete, 0); assert.equal(z.calls.status, 0);
  const source = fixture(); await source.begin(); source.mutations.post = () => { source.current.music.sha256 = '0'.repeat(64); };
  await assert.rejects(source.execute('submit', {stage: 'intent'}), /KNOWN_DELIVERY_STOPPED_NO_RETRY/);
  assert.equal(source.op().stages.intent.requestId, 'example_request_1'); assert.equal(source.op().stopped, true);
  const legacy = createGenerationDispatcher({...source.options, requireAuthority: false});
  await assert.rejects(source.execute('poll', {stage: 'intent'}, legacy), /GENERATION_STOPPED/); assert.equal(source.calls.complete, 0);
});
test('every status/result/complete checkpoint rejects late source or global stop and preserves submitted request for later reconciliation', async () => {
  for (const phase of ['poll-before-status', 'poll-after-status', 'poll-before-result', 'poll-after-result', 'poll-before-complete']) {
    const x = fixture(); await x.begin(); await x.execute('submit', {stage: 'intent'}); x.mutations[phase] = x.stop;
    await assert.rejects(x.execute('poll', {stage: 'intent'}), /GLOBAL_STOP/);
    assert.equal(x.op().stages.intent.state, 'SUBMITTED'); assert.equal(x.op().stages.intent.requestId, 'example_request_1'); assert.equal(x.calls.complete, 0);
    assert.equal(x.calls.status, phase === 'poll-before-status' ? 0 : 1);
    assert.equal(x.calls.result, ['poll-after-result', 'poll-before-complete'].includes(phase) ? 1 : 0);
    await assert.rejects(x.execute('poll', {stage: 'intent'}, createGenerationDispatcher(x.options)), /GLOBAL_STOP/); assert.equal(x.calls.post, 1);
  }
  const y = fixture(); await y.begin(); await y.execute('submit', {stage: 'intent'}); y.mutations.result = () => { y.current.music.clipId = 'example_changed'; };
  await assert.rejects(y.execute('poll', {stage: 'intent'}), /SOURCE_CHANGED/); assert.equal(y.calls.complete, 0);
});
test('permit/room expiry and owner denial block authority before work; changed source during trusted inspection is rechecked', async () => {
  const x = fixture(); x.expire(); await assert.rejects(x.begin(), /PERMIT_REQUIRED/); assert.equal(x.calls.post, 0);
  const y = fixture(); await assert.rejects(y.guard.assert({...y.input, ownerCapability: 'f'.repeat(64), permitId, phase: 'begin-before'}), /OWNER_DENIED/);
  let reads = 0; const changing = createDispatchAuthority({...y.authorityOptions, readCurrentSource: async () => {
    reads++; if (reads > 1) y.current.referenceAssetId = 'example_replaced'; return structuredClone(y.current); }});
  await assert.rejects(changing.assert({...y.input, permitId, phase: 'begin-before'}), /SOURCE_CHANGED/);
});
test('cloud jobs consult no credentials on stale authority, preserve read/stop, and never publish after a late prepare/source change', async () => {
  const x = fixture(); x.stop(); await assert.rejects(x.jobs().start({...x.input, permitId, submissionId: 'example_submission'}), /GLOBAL_STOP/);
  assert.equal(x.credentialReads(), 0);
  const y = fixture(), jobs = y.jobs(); await jobs.start({...y.input, permitId, submissionId: 'example_submission'});
  y.stop(); await assert.rejects(jobs.advance(y.input), /GLOBAL_STOP/); assert.equal(y.credentialReads(), 1); assert.equal((await jobs.read(y.input)).state, 'PENDING');
  assert.equal((await jobs.stop(y.input)).state, 'STOPPED');
  const z = fixture(); await z.begin(); z.op().stages = {intent: {state: 'COMPLETE'}, music: {state: 'COMPLETE'}, video: {state: 'COMPLETE'}};
  let publishes = 0; const qc = createCloudGenerationJobs({...z.options, prepareMedia: async () => z.stop(),
    coordinator: {execute: async () => { publishes++; }}});
  await assert.rejects(qc.advance(z.input), /GLOBAL_STOP/); assert.equal(publishes, 0); assert.equal(z.credentialReads(), 0);
});
test('strict job QC rejects an unguarded or differently guarded coordinator before inspection/publication', async () => {
  const x = fixture(); await x.begin(); x.op().stages = {intent: {state: 'COMPLETE'}, music: {state: 'COMPLETE'}, video: {state: 'COMPLETE'}};
  let publications = 0; const coordinator = {execute: async () => {publications++;}};
  const jobs = createCloudGenerationJobs({...x.options, coordinator});
  assert.equal(jobs.capabilities().serverQC, false);
  await assert.rejects(jobs.advance(x.input), /CLOUD_JOB_GUARDED_COORDINATOR_REQUIRED/);
  assert.equal(publications, 0); assert.equal(x.calls.post, 0); assert.equal((await jobs.read(x.input)).state, 'WAIT_QC');
  const real = createCueCoordinator({enabled: true, requireAuthority: true, authorityGuard: x.guard, repository: x.options.repository});
  assert.equal(isAuthorityGuardedCueCoordinator(real, x.guard), true); assert(Object.isFrozen(real));
  assert.equal(createCloudGenerationJobs({...x.options, coordinator: real}).capabilities().serverQC, true);
  const other = {assert: input => x.guard.assert(input)};
  const wrong = createCueCoordinator({enabled: true, requireAuthority: true, authorityGuard: other, repository: x.options.repository});
  const mismatched = createCloudGenerationJobs({...x.options, coordinator: wrong});
  assert.equal(mismatched.capabilities().serverQC, false);
  await assert.rejects(mismatched.advance(x.input), /CLOUD_JOB_GUARDED_COORDINATOR_REQUIRED/);
  assert.equal((await mismatched.stop(x.input)).state, 'STOPPED');
});
test('known delivery bookkeeping reconciles lost submitted/stop replies by exact signature/request ID and never adopts a conflicting ID', async () => {
  const x = fixture(); await x.begin(); x.mutations.post = x.stop;
  x.mutations.submitted = async () => { throw Error('example lost submitted reply'); };
  x.mutations.stop = async () => { throw Error('example lost stop reply'); };
  await assert.rejects(x.execute('submit', {stage: 'intent'}), /KNOWN_DELIVERY_STOPPED_NO_RETRY/);
  assert.equal(x.op().stages.intent.requestId, 'example_request_1'); assert.equal(x.op().stopped, true);
  assert.equal((await x.execute('submit', {stage: 'intent'}, createGenerationDispatcher(x.options))).state, 'STOPPED'); assert.equal(x.calls.post, 1);
  const y = fixture(); await y.begin(); y.mutations.post = y.stop;
  y.mutations.submitted = async () => { y.op().stages.intent.requestId = 'example_conflicting_delivery'; throw Error('example uncertain write'); };
  await assert.rejects(y.execute('submit', {stage: 'intent'}), /KNOWN_DELIVERY_UNCONFIRMED_NO_RETRY/);
  assert.equal(y.op().stages.intent.requestId, 'example_conflicting_delivery'); assert.equal(y.op().stopped, true);
  await assert.rejects(y.execute('poll', {stage: 'intent'}), /GENERATION_STOPPED/); assert.equal(y.calls.post, 1); assert.equal(y.calls.complete, 0);
});
test('unconfirmed or owner-denied bookkeeping stays a recovery hold; ambiguous provider replies remain UNKNOWN without repost', async () => {
  const x = fixture(); await x.begin(); x.mutations.post = x.stop;
  x.mutations.beforeSubmitted = async () => { throw Error('example unavailable write'); };
  await assert.rejects(x.execute('submit', {stage: 'intent'}), /KNOWN_DELIVERY_UNCONFIRMED_NO_RETRY/);
  assert.equal(x.op().stages.intent.state, 'UNKNOWN'); assert.equal(x.op().stages.intent.requestId, undefined); assert.equal(x.op().stopped, true);
  await assert.rejects(x.execute('submit', {stage: 'intent'}, createGenerationDispatcher(x.options)), /UNKNOWN_NO_RETRY/); assert.equal(x.calls.post, 1);
  const denied = fixture(); await denied.begin(); denied.mutations.post = () => { denied.mutations.ownerDisabled = true; };
  await assert.rejects(denied.execute('submit', {stage: 'intent'}), /KNOWN_DELIVERY_UNCONFIRMED_NO_RETRY/);
  assert.equal(denied.op().stages.intent.state, 'RESERVED'); assert.equal(denied.op().stages.intent.requestId, undefined);
  denied.mutations.ownerDisabled = false;
  await assert.rejects(denied.execute('submit', {stage: 'intent'}, createGenerationDispatcher(denied.options)), /UNKNOWN_NO_RETRY/); assert.equal(denied.calls.post, 1);
  const unknown = fixture(); await unknown.begin(); unknown.mutations.post = async () => { throw Error('example ambiguous provider reply'); };
  await assert.rejects(unknown.execute('submit', {stage: 'intent'}), /DISPATCH_UNKNOWN_NO_RETRY/);
  assert.equal(unknown.op().stages.intent.state, 'UNKNOWN'); assert.equal(unknown.op().stages.intent.requestId, undefined);
  await assert.rejects(unknown.execute('submit', {stage: 'intent'}, createGenerationDispatcher(unknown.options)), /UNKNOWN_NO_RETRY/); assert.equal(unknown.calls.post, 1);
});
test('strict cloud jobs require the exact registered dispatcher guard identity before credentials; diagnostic read and stop remain available', async () => {
  const x = fixture(); await x.begin(); let consulted = 0, customCalls = 0;
  const credentialForOperation = async () => { consulted++; return key; }, coordinator = {execute: async () => {}};
  const otherGuard = {assert: input => x.guard.assert(input)};
  const correct = createGenerationDispatcher(x.options), legacy = createGenerationDispatcher({...x.options, requireAuthority: false});
  const different = createGenerationDispatcher({...x.options, authorityGuard: otherGuard});
  const custom = {execute: async () => { customCalls++; }};
  assert.equal(isAuthorityGuardedDispatcher(correct, x.guard), true);
  assert.equal(Object.isFrozen(correct), true);
  assert.throws(() => { correct.execute = custom.execute; }, TypeError);
  assert.equal(isAuthorityGuardedDispatcher(different, x.guard), false);
  assert.equal(isAuthorityGuardedDispatcher(legacy, x.guard), false);
  assert.equal(isAuthorityGuardedDispatcher({execute: correct.execute}, x.guard), false);
  for (const dispatcher of [legacy, different, custom, {execute: correct.execute}]) {
    const jobs = createCloudGenerationJobs({...x.options, dispatcher, credentialForOperation, coordinator});
    assert.equal(jobs.capabilities().generationJobs, false); assert.equal(jobs.capabilities().serverQC, false); assert.equal(jobs.capabilities().progressRead, true);
    await assert.rejects(jobs.start({...x.input, permitId, submissionId: 'example_submission'}), /GUARDED_DISPATCHER_REQUIRED/);
    await assert.rejects(jobs.advance(x.input), /GUARDED_DISPATCHER_REQUIRED/);
    assert.equal((await jobs.read(x.input)).state, 'PENDING');
  }
  assert.equal(consulted, 0); assert.equal(customCalls, 0); assert.equal(x.calls.post, 0);
  const strict = createCloudGenerationJobs({...x.options, dispatcher: correct, credentialForOperation});
  assert.equal(strict.capabilities().generationJobs, true);
  await strict.start({...x.input, permitId, submissionId: 'example_submission'}); assert.equal(consulted, 1);
  await strict.advance(x.input); assert.equal(x.calls.post, 1);
  const stopped = createCloudGenerationJobs({...x.options, dispatcher: custom, credentialForOperation});
  x.stop(); assert.equal((await stopped.stop(x.input)).state, 'STOPPED'); assert.equal(customCalls, 0);
});

test('recovery composition recognizes only immutable enabled jobs with exact guarded configuration and no saved execution state', () => {
  const x = fixture(), jobs = x.jobs(), other = {assert: input => x.guard.assert(input)};
  assert.equal(isAuthorityGuardedCloudJobs(jobs, x.guard), true);
  assert.equal(isAuthorityGuardedCloudJobs(jobs, other), false);
  assert.equal(isAuthorityGuardedCloudJobs({...jobs}, x.guard), false);
  assert.equal(Object.isFrozen(jobs), true);
  assert.throws(() => { jobs.advance = async () => {}; }, TypeError);
  for (const changed of [{enabled: false}, {requireAuthority: false}, {credentialForOperation: undefined},
    {coordinator: {execute: async () => {}}}]) {
    const configured = createCloudGenerationJobs({...x.options, credentialForOperation: async () => key, ...changed});
    assert.equal(isAuthorityGuardedCloudJobs(configured, x.guard), false);
  }
  const coordinator = createCueCoordinator({...x.options});
  const paired = createCloudGenerationJobs({...x.options, coordinator, credentialForOperation: async () => key});
  assert.equal(isAuthorityGuardedCloudJobs(paired, x.guard), true);
  const mismatched = createCloudGenerationJobs({...x.options,
    coordinator: createCueCoordinator({...x.options, authorityGuard: other}), credentialForOperation: async () => key});
  assert.equal(isAuthorityGuardedCloudJobs(mismatched, x.guard), false);
  assert.equal(x.credentialReads(), 0); assert.equal(x.calls.post, 0); assert.equal(x.phases.length, 0);
});
