import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createAcknowledgedCurrentSourceSnapshot} from '../cloud/jobs/current-source-snapshot.mjs';
import {createExistingCloudRepositoryReadPorts, createVerifiedCloudCurrentSourcePorts} from '../cloud/jobs/repository-read-ports.mjs';
import {createSupabasePrivateStore} from '../cloud/worker/supabase-private-store.mjs';
import {syntheticStorageTransport} from './cloud-worker-store-fixture.mjs';
import {syntheticWave, fixtureSha} from './cloud-worker-fixture.mjs';
import {contextWave, decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {buildVerifiedCue, operationBinding} from '../cloud/generation/cue-contract.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';

const owner = 'a'.repeat(64), guest = 'b'.repeat(64), invitation = 'c'.repeat(64), h = value => value.repeat(64);
const operationId = 'operation_' + 'o'.repeat(24), permitId = 'permit_' + 'p'.repeat(24);
async function fixture() {
  const db = new PGlite(); await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  const uid = '11111111-1111-4111-a111-111111111111'; await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
  let room, time = Date.now();
  const roomRequest = async (action, capability, payload = {}, verified = null) => (await db.query(
    'select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) value', [action, room?.roomId ?? null, capability, JSON.stringify(payload), verified])).rows[0].value;
  room = await roomRequest('create', null, {ownerCapability: owner, joinCode: invitation}, uid);
  await roomRequest('join', invitation, {nickname: 'example_guest', participantCapability: guest});
  const submission = await roomRequest('submit', guest, {nonce: 'submission_' + 's'.repeat(24), prompt: 'example request'});
  const transport = syntheticStorageTransport(), store = createSupabasePrivateStore({enabled: true, roomId: room.roomId, transport: transport.transport});
  const seed = syntheticWave(24), incoming = Buffer.from(seed); for (let n = 44; n < incoming.length; n += 2) incoming.writeInt16LE(-incoming.readInt16LE(n), n);
  const oldContext = contextWave(decodeCompleteWave(seed)), reference = Buffer.from([137,80,78,71,13,10,26,10]);
  const bootstrap = {kind: 'owner-supplied-bootstrap'};
  for (const [id, bytes, contentType] of [['example_seed', seed, 'audio/wav'], ['example_context', oldContext, 'audio/wav'], ['example_reference', reference, 'image/png']])
    await store.assetStore.save({id, bytes, contentType, binding: bootstrap, provenance: bootstrap});
  const control = {version: 1, energy: .5, tension: .5, density: .5, brightness: .5};
  const profile = {method: 'pcm-endpoint-profile-v1', assetSha256: fixtureSha(incoming), sampleRate: 44100, channels: 2, frameCount: 24 * 44100};
  const source = {audioAssetId: 'example_seed', contextAssetId: 'example_context', referenceAssetId: 'example_reference',
    music: {clipId: 'example_seed', sha256: fixtureSha(seed), ready: true, contextSeconds: 16, contextVerified: true,
      contextSha256: fixtureSha(oldContext), control, profile: {...profile, assetSha256: fixtureSha(seed)}},
    video: {motifId: 'example_motif', referenceSha256: fixtureSha(reference), motifSnapshotSha256: h('f')}, quality: {fixedBpm: 145},
    playback: {phase: 'IDLE', revision: 0, playedUntilFrame: 0, actual: false}};
  const permit = {permitId, source, sourceSha256: cueDigest(cueSourceIdentity(source))};
  await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
    select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`, [permitId, room.roomId, JSON.stringify(permit)]);
  const op = {operationId, submissionId: submission.submissionId, permit, stopped: false,
    plan: {status: 'COMPILED', commonIntentSha256: h('2'), common: {cueId: 'example_cue', control: {...control, version: 2, prompt: 'example private prompt'}}},
    stages: {music: {state: 'COMPLETE', requestId: 'example_music', result: {resultSha256: h('3')}},
      video: {state: 'COMPLETE', requestId: 'example_video', result: {resultSha256: h('4')}}}};
  const media = channel => ({binding: operationBinding(room.roomId, op, channel), durationSeconds: 24,
    asset: {assetId: channel === 'music' ? 'example_incoming' : 'example_timeline', sha256: channel === 'music' ? fixtureSha(incoming) : h('6')},
    providerReceipt: {requestId: op.stages[channel].requestId, resultSha256: op.stages[channel].result.resultSha256},
    privateSaved: true, checksumVerified: true, qc: {passed: true, scope: 'example_server'}});
  const music = {...media('music'), parentClipId: source.music.clipId, contextSha256: source.music.contextSha256,
    contextVerified: true, continuationVerified: true, profile};
  const video = {...media('video'), compositionQC: {passed: true}, review: {accepted: true, ownerArtisticApproval: true,
    assetSha256: h('6'), commonIntentSha256: op.plan.commonIntentSha256}, clips: [{assetId: 'example_clip', sha256: h('7'), durationSeconds: 5,
    qcPassed: true, approved: true, providerRequestId: op.stages.video.requestId, providerResultSha256: op.stages.video.result.resultSha256}],
    timeline: {durationSeconds: 24, timeStretch: false, approvedLoops: true, segments: [0,5,10,15,20].map(start => ({assetId: 'example_clip', sha256: h('7'),
      startSeconds: start, endSeconds: Math.min(start + 5, 24), sourceInSeconds: 0, sourceOutSeconds: Math.min(5, 24 - start), playbackRate: 1}))}};
  op.cue = buildVerifiedCue({roomId: room.roomId, operation: op, evidence: {actualGenerationThisRun: true, mode: 'provider', music, video}});
  op.cue.contribution = {participantId: submission.participantId, submissionId: submission.submissionId, nickname: submission.nickname};
  await store.assetStore.save({id: 'example_incoming', bytes: incoming, contentType: 'audio/wav', binding: music.binding,
    provenance: {kind: 'provider', operationId, requestId: op.stages.music.requestId, resultSha256: op.stages.music.result.resultSha256}});
  await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)', [operationId, permitId, room.roomId, JSON.stringify(op)]);
  const generation = async (action, payload = {}) => (await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
    [action, room.roomId, owner, JSON.stringify(payload)])).rows[0].value;
  const ports = createExistingCloudRepositoryReadPorts({query: (sql, values) => db.query(sql, values), now: () => time,
    hostGenerationRead: input => generation(input.action, input.operationId ? {operationId: input.operationId} : {})});
  const {roomId, sessionId, controlRevision} = await ports.readScope({roomId: room.roomId});
  const scope = {roomId, sessionId, controlRevision}, selected = {...scope, kind: 'selected-current-player-v1',
    targetPlayerId: 'example_target', cueId: op.cue.cueId, generationId: op.cue.generationId, playbackRevision: 1, expiresAtMs: time + 30000};
  const options = {enabled: true, repositoryPorts: ports, assetStore: store.assetStore, sourceStore: store.sourceStore,
    readSelectedTarget: async () => structuredClone(selected), now: () => time};
  const adapter = createAcknowledgedCurrentSourceSnapshot(options), input = {roomId: room.roomId};
  const reservationId = 'reservation_' + 'r'.repeat(24);
  const reserve = () => generation('cueReserve', {operationId, reservationId,
    plan: {status: 'ELIGIBLE', liveReady: true, cueId: op.cue.cueId, incomingSha256: fixtureSha(incoming)},
    current: {actual: true, playbackRevision: 0}, expectedRevision: 1, expiresAtMs: Date.now() + 30000});
  const ack = () => generation('cueAck', {reservationId, ackSha256: h('8'), ack: {roomId: room.roomId, cueId: op.cue.cueId,
    clipId: 'example_incoming', playbackRevision: 1, audioTime: 9000, actual: true, audioStarted: true, videoPresented: true}});
  const play = async () => { await reserve(); return ack(); };
  return {db, room, scope, selected, store, transport, ports, options, adapter, input, generation, reserve, ack, play, incoming, oldContext,
    advance: ms => { time += ms; }, now: () => time, close: async () => { store.close(); await db.close(); }};
}

test('snapshot preparation is default off, IDs only and requires real server ACK rather than READY or reservation', async () => {
  const x = await fixture(); try {
    const calls = x.transport.calls.length, disabled = createAcknowledgedCurrentSourceSnapshot({...x.options, enabled: false});
    await assert.rejects(disabled.prepareCurrentSource(x.input), /NOT_ACTIVATED/); await assert.rejects(disabled.readSourceRecord(x.scope), /NOT_ACTIVATED/);
    assert.equal(x.transport.calls.length, calls);
    await assert.rejects(x.adapter.prepareCurrentSource({...x.input, cueId: 'caller_choice'}), /IDS_ONLY/);
    await assert.rejects(x.adapter.prepareCurrentSource(x.input), /ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
    await x.reserve(); await assert.rejects(x.adapter.prepareCurrentSource(x.input), /ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
    assert.equal(x.transport.calls.filter(call => call.action === 'put').length, 8);
  } finally { await x.close(); }
});
test('acknowledged incoming cue derives its own exact16s tail and canonical immutable snapshot; only verified frontier supplies actual frames', async () => {
  const x = await fixture(); try {
    await x.play(); const prepared = await x.adapter.prepareCurrentSource(x.input), record = await x.adapter.readSourceRecord(x.scope);
    const expected = contextWave(decodeCompleteWave(x.incoming)); assert.notEqual(fixtureSha(expected), fixtureSha(x.oldContext));
    assert.equal(record.source.music.contextSha256, fixtureSha(expected)); assert.equal(record.source.referenceAssetId, 'example_reference');
    assert.deepEqual(record.source.playback, {phase: 'IDLE', revision: 0, playedUntilFrame: 0, actual: false});
    assert.equal(record.source.music.control.prompt, undefined); assert.equal(JSON.stringify(record).includes('example_guest'), false);
    assert.equal(JSON.stringify(record).includes('audioTime'), false);
    const puts = x.transport.calls.filter(call => call.action === 'put').length;
    assert.deepEqual(await x.adapter.prepareCurrentSource(x.input), prepared);
    const restartedStore = createSupabasePrivateStore({enabled: true, roomId: x.room.roomId, transport: x.transport.transport});
    const restarted = createAcknowledgedCurrentSourceSnapshot({...x.options, assetStore: restartedStore.assetStore, sourceStore: restartedStore.sourceStore});
    assert.deepEqual(await restarted.readSourceRecord(x.scope), record); assert.deepEqual(await restarted.prepareCurrentSource(x.input), prepared);
    assert.equal(x.transport.calls.filter(call => call.action === 'put').length, puts);
    const frontier = {...x.scope, kind: 'authenticated-player-frontier-v1', targetPlayerId: x.selected.targetPlayerId,
      cueId: x.selected.cueId, generationId: x.selected.generationId, assetId: record.source.audioAssetId, sha256: record.source.music.sha256,
      playbackRevision: 1, playedUntilFrame: 1024, actual: true, audioStarted: true, videoPresented: true, observedAtMs: x.now(), observationSha256: h('a')};
    const current = createVerifiedCloudCurrentSourcePorts({repositoryPorts: x.ports, readSourceRecord: restarted.readSourceRecord,
      assetStore: restartedStore.assetStore, readPlayerFrontier: async () => structuredClone(frontier), now: x.options.now});
    assert.equal((await current.readCurrent(x.room.roomId)).playedUntilFrame, 1024);
    assert.equal((await current.readCurrentSource(x.input)).playback.actual, true);
    frontier.observedAtMs -= 5001; await assert.rejects(current.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    assert.deepEqual((await restartedStore.sourceStore.read(prepared.sourceId)).source.playback, record.source.playback);
    restartedStore.close();
  } finally { await x.close(); }
});
test('lost immutable context or source save replies reconcile physical saved records across fresh adapters without duplicate uploads', async () => {
  const x = await fixture(); try {
    await x.play(); let contextLost = true, sourceLost = true;
    const uncertain = createAcknowledgedCurrentSourceSnapshot({...x.options,
      assetStore: {...x.store.assetStore, save: async input => { const saved = await x.store.assetStore.save(input);
        if (contextLost) { contextLost = false; throw Error('example lost context reply'); } return saved; }},
      sourceStore: {...x.store.sourceStore, save: async input => { const saved = await x.store.sourceStore.save(input);
        if (sourceLost) { sourceLost = false; throw Error('example lost source reply'); } return saved; }}});
    const result = await uncertain.prepareCurrentSource(x.input), puts = x.transport.calls.filter(call => call.action === 'put').length;
    assert.deepEqual(await createAcknowledgedCurrentSourceSnapshot(x.options).prepareCurrentSource(x.input), result);
    assert.equal(x.transport.calls.filter(call => call.action === 'put').length, puts);
    assert.equal(Object.values((await x.generation('cueState')).servedCounts)[0], 1);
  } finally { await x.close(); }
});
test('missing provider association, invalid full QC, ambiguous cue and expired selected target stay held', async () => {
  const x = await fixture(); try {
    await x.play();
    for (const modify of [op => { op.cue.video.binding.controlVersion++; }, op => { op.cue.music.qc.passed = false; },
      op => { op.cue.commonIntentSha256 = h('0'); }]) {
      const adapter = createAcknowledgedCurrentSourceSnapshot({...x.options, repositoryPorts: {...x.ports,
        readPublishedPlaybackOperation: async input => { const op = await x.ports.readPublishedPlaybackOperation(input); modify(op); return op; }}});
      await assert.rejects(adapter.prepareCurrentSource(x.input), /ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
    }
    // An operation read that still carries the pre-ACK runtime status/revision
    // is accepted: the live playback Cue is the authority for those fields.
    const lagging = createAcknowledgedCurrentSourceSnapshot({...x.options, repositoryPorts: {...x.ports,
      readPublishedPlaybackOperation: async input => { const op = await x.ports.readPublishedPlaybackOperation(input);
        op.cue.status = 'SELECTED'; op.cue.playbackRevision = 0; return op; }}});
    assert.equal((await lagging.prepareCurrentSource(x.input)).cueId, x.selected.cueId);
    const ambiguous = createAcknowledgedCurrentSourceSnapshot({...x.options, repositoryPorts: {...x.ports, readPlaybackState: async input => {
      const state = await x.ports.readPlaybackState(input); state.cues.push(structuredClone(state.cues[0])); return state; }}});
    await assert.rejects(ambiguous.prepareCurrentSource(x.input), /ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
    // A stale copy of the same Cue from a replayed operation (not PLAYING at
    // the credited revision) does not hide the sounding copy.
    const withStale = createAcknowledgedCurrentSourceSnapshot({...x.options, repositoryPorts: {...x.ports, readPlaybackState: async input => {
      const state = await x.ports.readPlaybackState(input);
      state.cues.unshift({...structuredClone(state.cues[0]), status: 'READY', playbackRevision: 0, operationId: 'synthetic-replayed-operation-0001'});
      return state; }}});
    assert.equal((await withStale.prepareCurrentSource(x.input)).cueId, x.selected.cueId);
    const legacy = createAcknowledgedCurrentSourceSnapshot({...x.options, assetStore: {...x.store.assetStore, read: async id => {
      const record = await x.store.assetStore.read(id); if (id === 'example_incoming') delete record.provenance.operationId; return record; }}});
    await assert.rejects(legacy.prepareCurrentSource(x.input), /PROVIDER_LINEAGE_REQUIRED/);
    x.advance(30001); await assert.rejects(x.adapter.prepareCurrentSource(x.input), /SELECTED_TARGET_REQUIRED/);
  } finally { await x.close(); }
});
test('late stop, target replacement and scope/control change invalidate preparation without publishing current-source truth', async () => {
  const x = await fixture(); try {
    await x.play();
    const late = createAcknowledgedCurrentSourceSnapshot({...x.options, assetStore: {...x.store.assetStore, save: async input => {
      const result = await x.store.assetStore.save(input); await x.generation('cueStop'); return result; }}});
    await assert.rejects(late.prepareCurrentSource(x.input), /ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
    await assert.rejects(x.adapter.readSourceRecord(x.scope), /ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
  } finally { await x.close(); }
  const y = await fixture(); try {
    await y.play(); const moved = createAcknowledgedCurrentSourceSnapshot({...y.options, assetStore: {...y.store.assetStore, save: async input => {
      const result = await y.store.assetStore.save(input); y.selected.targetPlayerId = 'example_other_target'; return result; }}});
    await assert.rejects(moved.prepareCurrentSource(y.input), /SNAPSHOT_CHANGED/);
    await y.db.query('update vdj_internal.rooms set control_revision=1 where id=$1', [y.room.roomId]);
    await assert.rejects(y.adapter.readSourceRecord(y.scope), /SCOPE_REQUIRED/);
  } finally { await y.close(); }
});
test('physical old context/new parent/reference corruption and custom saved snapshots with live playback fields cannot authorize a read', async () => {
  const x = await fixture(); try {
    await x.play(); await x.adapter.prepareCurrentSource(x.input);
    const forged = createAcknowledgedCurrentSourceSnapshot({...x.options, sourceStore: {...x.store.sourceStore, read: async id => {
      const record = await x.store.sourceStore.read(id); record.source.playback = {actual: true, revision: 1, playedUntilFrame: 1024, phase: 'PLAYING'}; return record; }}});
    await assert.rejects(forged.readSourceRecord(x.scope), /SAVED_SNAPSHOT_REQUIRED/);
    for (const id of ['example_context', 'example_incoming', 'example_reference']) {
      const physical = [...x.transport.objects].find(([path]) => path.endsWith('/' + id + '.media'))[1], original = Buffer.from(physical.bytes);
      physical.bytes[physical.bytes.length - 1] ^= 1;
      await assert.rejects(x.adapter.readSourceRecord(x.scope), error => error.code === 'PRIVATE_STORE_HOLD' && error.holdReason === 'PRIVATE_ASSET_PHYSICAL_SHA_MISMATCH');
      physical.bytes = original;
    }
    await x.db.query('update vdj_internal.generation_permits set revoked=true where id=$1', [permitId]);
    await assert.rejects(x.adapter.readSourceRecord(x.scope), /ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
  } finally { await x.close(); }
});
test('a storage success response without a durable snapshot cannot promote source truth', async () => {
  const x = await fixture(); try {
    await x.play(); const unconfirmed = createAcknowledgedCurrentSourceSnapshot({...x.options,
      sourceStore: {...x.store.sourceStore, save: async () => ({sourceId: 'example_unconfirmed', success: true})}});
    await assert.rejects(unconfirmed.prepareCurrentSource(x.input), error => error.code === 'PRIVATE_STORE_HOLD' && error.holdReason === 'PRIVATE_SOURCE_RECORD_REQUIRED');
    await assert.rejects(x.adapter.readSourceRecord(x.scope), error => error.code === 'PRIVATE_STORE_HOLD' && error.holdReason === 'PRIVATE_SOURCE_RECORD_REQUIRED');
    assert.equal(Object.values((await x.generation('cueState')).servedCounts)[0], 1);
  } finally { await x.close(); }
});
test('an injected save port cannot mutate the canonical comparison into a persisted actual/frame claim', async () => {
  const x = await fixture(); try {
    await x.play(); const mutable = createAcknowledgedCurrentSourceSnapshot({...x.options,
      sourceStore: {...x.store.sourceStore, save: async input => {
        input.source.playback = {phase: 'PLAYING', revision: 1, playedUntilFrame: 1024, actual: true};
        return x.store.sourceStore.save(input);
      }}});
    await assert.rejects(mutable.prepareCurrentSource(x.input), /SAVED_SNAPSHOT_REQUIRED/);
    await assert.rejects(x.adapter.readSourceRecord(x.scope), /SAVED_SNAPSHOT_REQUIRED/);
    assert.equal(Object.values((await x.generation('cueState')).servedCounts)[0], 1);
  } finally { await x.close(); }
});

test('expired generation permission cannot dispatch again but an already acknowledged published cue remains a playback source',async()=>{
 const x=await fixture();try{
  await x.play();await x.db.query("update vdj_internal.generation_permits set expires_at=clock_timestamp()-interval '1 second' where id=$1",[permitId]);
  assert.equal((await x.ports.readAuthoritativeOperation({roomId:x.room.roomId,operationId})).dispatchAllowed,false);
  await x.adapter.prepareCurrentSource(x.input);assert.equal((await x.adapter.readSourceRecord(x.scope)).source.music.ready,true);
  await x.db.query('update vdj_internal.generation_permits set revoked=true where id=$1',[permitId]);
  await assert.rejects(x.adapter.readSourceRecord(x.scope),/ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
 }finally{await x.close();}
});

test('published source preparation stays non-actual; cached immutable material still needs fresh actual ACK, Stop and revocation checks',async()=>{
 for(const mutation of ['stop','revoke']){
  const x=await fixture();try{
   const adapter=createAcknowledgedCurrentSourceSnapshot({...x.options,cachePreparedMaterial:true});
   const prepared=await adapter.preparePublishedSource({roomId:x.room.roomId,operationId});
   const {source:preparedSource,...preparedStatus}=prepared;
   assert.deepEqual(preparedStatus,{prepared:true,sourceOnly:true,participantCredit:false});
   assert.equal(preparedSource.playback.actual,false);assert.equal(preparedSource.music.clipId,'example_incoming');
   assert.equal((await x.generation('cueState')).currentCredit,null);
   await assert.rejects(adapter.readSourceRecord(x.scope),/ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
   const io=x.transport.calls.length;await x.play();await adapter.prepareCurrentSource(x.input);
   const record=await adapter.readSourceRecord(x.scope);assert.equal(record.source.playback.actual,false);
   assert.equal(x.transport.calls.length,io,'actual source reads reuse only fully persisted preflight material');
   if(mutation==='stop')await x.generation('cueStop');
   else await x.db.query('update vdj_internal.generation_permits set revoked=true where id=$1',[permitId]);
   await assert.rejects(adapter.readSourceRecord(x.scope),/ACKNOWLEDGED_CURRENT_CUE_REQUIRED/);
  }finally{await x.close();}
 }
});
test('verified published evidence is reused across reads while frontier, Stop and credit stay live on every read', async () => {
  const x = await fixture(); try {
    await x.play(); await x.adapter.prepareCurrentSource(x.input); const record = await x.adapter.readSourceRecord(x.scope);
    let reads = 0; const store = {...x.options.assetStore, read: async id => { reads++; return x.options.assetStore.read(id); }};
    const frontier = {...x.scope, kind: 'authenticated-player-frontier-v1', targetPlayerId: x.selected.targetPlayerId,
      cueId: x.selected.cueId, generationId: x.selected.generationId, assetId: record.source.audioAssetId, sha256: record.source.music.sha256,
      playbackRevision: 1, playedUntilFrame: 1024, actual: true, audioStarted: true, videoPresented: true, observedAtMs: x.now(), observationSha256: h('a')};
    const current = createVerifiedCloudCurrentSourcePorts({repositoryPorts: x.ports, readSourceRecord: x.adapter.readSourceRecord,
      assetStore: store, readPlayerFrontier: async () => structuredClone(frontier), now: x.options.now, cacheVerifiedPublished: true});
    const playback = await x.ports.readPlaybackState({roomId: x.room.roomId}), cue = playback.cues.find(c => c.cueId === playback.currentCredit.cueId);
    await current.preverifyPublishedSource({roomId: x.room.roomId, cue: {...cue, status: 'READY'}, source: record.source});
    const afterPreverify = reads;assert.ok(afterPreverify >= 3, 'preload reads and verifies the private bytes once');
    assert.equal((await current.readCurrent(x.room.roomId)).playedUntilFrame, 1024);
    frontier.playedUntilFrame = 2048; frontier.observedAtMs = x.now();
    assert.equal((await current.readCurrent(x.room.roomId)).playedUntilFrame, 2048, 'frontier is still read live');
    assert.equal(reads, afterPreverify, 'no private byte re-reads inside the Cue window');
    frontier.observedAtMs -= 5001; await assert.rejects(current.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    frontier.observedAtMs = x.now();
    // Cached asset evidence never outlives the operation's authorization.
    // Even if the saved source record were stale, the cached path re-reads the operation.
    const frozen = createVerifiedCloudCurrentSourcePorts({repositoryPorts: x.ports, readSourceRecord: async () => structuredClone(record),
      assetStore: store, readPlayerFrontier: async () => structuredClone(frontier), now: x.options.now, cacheVerifiedPublished: true});
    await frozen.preverifyPublishedSource({roomId: x.room.roomId, cue: {...cue, status: 'READY'}, source: record.source});
    const cached = reads; assert.equal((await frozen.readCurrent(x.room.roomId)).playedUntilFrame, 2048);
    await x.db.query('update vdj_internal.generation_permits set revoked=true where id=$1', [permitId]);
    await assert.rejects(frozen.readCurrent(x.room.roomId), /REQUIRED_REVOKED/);
    await assert.rejects(current.readCurrent(x.room.roomId), /PUBLISHED_PLAYBACK_OPERATION_REQUIRED/);
    assert.equal(reads, cached, 'revocation is found without re-reading private bytes');
    await x.db.query('update vdj_internal.generation_permits set revoked=false where id=$1', [permitId]);
    await assert.rejects(current.preverifyPublishedSource({roomId: x.room.roomId, cue: {...cue, music: {...cue.music, asset: {...cue.music.asset, sha256: h('9')}}},
      source: record.source}), /PREVERIFY_REQUIRED/);
  } finally { await x.close(); }
});
