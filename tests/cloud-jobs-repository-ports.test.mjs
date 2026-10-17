import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createExistingCloudRepositoryReadPorts, createVerifiedCloudCurrentSourcePorts} from '../cloud/jobs/repository-read-ports.mjs';
import {createCloudRoomProjection} from '../cloud/jobs/room-projection.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {buildVerifiedCue, operationBinding} from '../cloud/generation/cue-contract.mjs';
import {contextWave, decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {syntheticWave, fixtureSha, createSyntheticPrivateStore} from './cloud-worker-fixture.mjs';

const owner = 'a'.repeat(64), guest = 'b'.repeat(64), other = 'c'.repeat(64), invitation = 'd'.repeat(64);
const operationId = 'operation_' + 'o'.repeat(24), permitId = 'permit_' + 'p'.repeat(24), h = value => value.repeat(64);
async function fixture() {
  const db = new PGlite(); await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  const uid = '11111111-1111-4111-a111-111111111111'; await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
  let room;
  const roomRequest = async (action, capability, payload = {}, verified = null) => (await db.query(
    'select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) value', [action, room?.roomId ?? null, capability, JSON.stringify(payload), verified])).rows[0].value;
  room = await roomRequest('create', null, {ownerCapability: owner, joinCode: invitation}, uid);
  await roomRequest('join', invitation, {nickname: 'synthetic guest', participantCapability: guest});
  await roomRequest('join', invitation, {nickname: 'synthetic other', participantCapability: other});
  const submission = await roomRequest('submit', guest, {nonce: 'submission_' + 's'.repeat(24), prompt: 'synthetic request'});
  const hidden = await roomRequest('submit', other, {nonce: 'submission_' + 'h'.repeat(24), prompt: 'hidden synthetic request'});
  const audio = syntheticWave(24), context = contextWave(decodeCompleteWave(audio)), reference = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const profile = {method: 'pcm-endpoint-profile-v1', assetSha256: fixtureSha(audio), sampleRate: 44100, channels: 2, frameCount: 24 * 44100};
  const source = {music: {clipId: 'synthetic-parent', sha256: fixtureSha(audio), profile, ready: true, contextSeconds: 16,
    contextVerified: true, contextSha256: fixtureSha(context), control: {version: 1, energy: .5, tension: .5, density: .5, brightness: .5}},
    video: {motifId: 'synthetic-reference', referenceSha256: fixtureSha(reference), motifSnapshotSha256: h('f')}, quality: {fixedBpm: 145}};
  const permit = {permitId, source, sourceSha256: cueDigest(cueSourceIdentity(source))};
  await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
    select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`, [permitId, room.roomId, JSON.stringify(permit)]);
  const op = {operationId, submissionId: submission.submissionId, permit, keyProof: h('9'), stopped: false,
    plan: {status: 'COMPILED', commonIntentSha256: h('2'), common: {cueId: 'synthetic-cue', control: {version: 2}}},
    stages: {music: {state: 'COMPLETE', requestId: 'synthetic-music', result: {resultSha256: h('3')}},
      video: {state: 'COMPLETE', requestId: 'synthetic-video', result: {resultSha256: h('4')}}}};
  const media = channel => ({binding: operationBinding(room.roomId, op, channel), durationSeconds: 24,
    asset: {assetId: channel === 'music' ? 'synthetic-audio' : 'synthetic-timeline', sha256: channel === 'music' ? fixtureSha(audio) : h('6')},
    providerReceipt: {requestId: op.stages[channel].requestId, resultSha256: op.stages[channel].result.resultSha256},
    privateSaved: true, checksumVerified: true, qc: {passed: true, scope: 'synthetic-server'}});
  const music = {...media('music'), parentClipId: source.music.clipId, contextSha256: source.music.contextSha256,
    contextVerified: true, continuationVerified: true, profile};
  const video = {...media('video'), compositionQC: {passed: true}, review: {accepted: true, ownerArtisticApproval: true,
    assetSha256: h('6'), commonIntentSha256: op.plan.commonIntentSha256}, clips: [{assetId: 'synthetic-clip', sha256: h('7'), durationSeconds: 5,
    qcPassed: true, approved: true, providerRequestId: op.stages.video.requestId, providerResultSha256: op.stages.video.result.resultSha256}],
    timeline: {durationSeconds: 24, timeStretch: false, approvedLoops: true, segments: [0, 5, 10, 15, 20].map(start => ({assetId: 'synthetic-clip',
      sha256: h('7'), startSeconds: start, endSeconds: Math.min(start + 5, 24), sourceInSeconds: 0, sourceOutSeconds: Math.min(5, 24 - start), playbackRate: 1}))}};
  op.cue = buildVerifiedCue({roomId: room.roomId, operation: op, evidence: {actualGenerationThisRun: true, mode: 'provider', music, video}});
  op.cue.contribution = {participantId: submission.participantId, submissionId: submission.submissionId, nickname: submission.nickname};
  await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)', [operationId, permitId, room.roomId, JSON.stringify(op)]);
  const generation = async (action, payload = {}) => (await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
    [action, room.roomId, owner, JSON.stringify(payload)])).rows[0].value;
  const sql = [], options = {query: async (statement, values) => { sql.push(statement); assert(!values.includes(owner)); return db.query(statement, values); },
    hostGenerationRead: async input => generation(input.action, input.operationId ? {operationId: input.operationId} : {})};
  const ports = createExistingCloudRepositoryReadPorts(options), scope = await ports.readScope({roomId: room.roomId});
  const projection = createCloudRoomProjection({...ports, roomRepository: {request: async (action, id, capability, payload) => (await db.query(
    'select public.vdj_room_request($1,$2,$3,$4::jsonb) value', [action, id, capability, JSON.stringify(payload)])).rows[0].value},
    authorizeOwner: async ({ownerCapability}) => { await db.query("select public.vdj_generation_request('cueState',$1,$2,'{}')", [room.roomId, ownerCapability]); return true; }});
  const store = createSyntheticPrivateStore();
  await store.save({id: 'synthetic-audio', bytes: audio, binding: music.binding, provenance: {kind: 'provider', operationId,
    requestId: op.stages.music.requestId, resultSha256: op.stages.music.result.resultSha256}, contentType: 'audio/wav'});
  await store.save({id: 'synthetic-context', bytes: context}); await store.save({id: 'synthetic-reference', bytes: reference});
  const currentSource = {...structuredClone(source), audioAssetId: 'synthetic-audio', contextAssetId: 'synthetic-context', referenceAssetId: 'synthetic-reference'};
  currentSource.music.clipId = currentSource.audioAssetId; currentSource.music.control.version = 2;
  const {roomId, sessionId, controlRevision} = scope;
  const scoped = {roomId, sessionId, controlRevision};
  const sourceRecord = {...scoped, kind: 'saved-current-source-v1', serverQC: true, qcEvidenceSha256: h('8'), targetPlayerId: 'synthetic-browser',
    sourceSha256: cueDigest(cueSourceIdentity(currentSource)), source: currentSource};
  const frontier = {...scoped, kind: 'authenticated-player-frontier-v1', targetPlayerId: 'synthetic-browser', cueId: op.cue.cueId,
    generationId: op.cue.generationId, assetId: currentSource.audioAssetId, sha256: currentSource.music.sha256,
    playbackRevision: 1, playedUntilFrame: 1024, actual: true, audioStarted: true, videoPresented: true,
    observedAtMs: Date.now(), observationSha256: h('a')};
  const sourceOptions = {repositoryPorts: ports, readSourceRecord: async () => structuredClone(sourceRecord),
    readPlayerFrontier: async () => structuredClone(frontier), assetStore: store};
  const sourcePorts = createVerifiedCloudCurrentSourcePorts(sourceOptions);
  const play = async () => {
    const reservationId = 'reservation_' + 'r'.repeat(24), r = await generation('cueReserve', {operationId, reservationId,
      plan: {status: 'ELIGIBLE', liveReady: true, cueId: op.cue.cueId, incomingSha256: fixtureSha(audio)},
      current: {actual: true, playbackRevision: 0}, expectedRevision: 1, expiresAtMs: Date.now() + 30000});
    const ack = {roomId: room.roomId, cueId: r.cue.cueId, clipId: r.cue.music.asset.assetId, playbackRevision: 1,
      audioTime: 9000, actual: true, audioStarted: true, videoPresented: true};
    const acknowledgment = {reservationId, ack, ackSha256: cueDigest(ack)};
    await generation('cueAck', acknowledgment); return acknowledgment;
  };
  return {db, room, submission, hidden, scope, ports, options, sql, projection, generation, sourcePorts, sourceOptions, sourceRecord, frontier, store, play};
}

test('existing SELECT-only repository ports compose proof-filtered immutable projection without new SQL/persistence or owner proof in query values', async () => {
  const x = await fixture(); try {
    const input = {roomId: x.room.roomId, ownerCapability: owner, submissionId: x.submission.submissionId};
    const attachment = await x.projection.prepare(input); assert.equal(attachment.operationId, operationId); assert.equal(attachment.permitId, permitId);
    assert.deepEqual(await x.projection.prepare(input), attachment);
    const participant = await x.projection.readRoom({roomId: x.room.roomId, participantCapability: guest});
    assert.deepEqual(participant.submissions.map(item => item.submissionId), [x.submission.submissionId]);
    assert.equal(participant.submissions[0].jobs[0].atomicReady, true);
    assert(x.sql.every(statement => /^select\s/i.test(statement.trim())));
    const counts = (await x.db.query('select (select count(*) from vdj_internal.generation_operations) operations,(select count(*) from vdj_internal.generation_permits) permits')).rows[0];
    assert.deepEqual(counts, {operations: 1, permits: 1});
    const current = await x.ports.readOperation({roomId: x.room.roomId, operationId, permitId}); assert.equal(current.operation.dispatchAllowed, true);
    await assert.rejects(x.ports.readOperation({roomId: x.room.roomId, operationId, permitId: 'wrong-permit'}), /REFERENCE_REQUIRED/);
    await x.db.query("update vdj_internal.generation_permits set document=document||'{\"unexpected\":true}'::jsonb where id=$1", [permitId]);
    await assert.rejects(x.ports.readOperation({roomId: x.room.roomId, operationId}), /AUTHORITATIVE_OPERATION_CHANGED/);
  } finally { await x.db.close(); }
});
test('repository scope detects control/owner/expiry guards and propagates authenticated RPC denial', async () => {
  const x = await fixture(); try {
    const {roomId, sessionId, controlRevision} = x.scope;
    const scoped = {roomId, sessionId, controlRevision};
    await assert.rejects(x.ports.readAttachments({...scoped, submissionIds: [x.submission.submissionId], qcPassed: true}), /SCOPE_REQUIRED/);
    const denied = createExistingCloudRepositoryReadPorts({...x.options, hostGenerationRead: async () => { throw Error('OWNER_DENIED'); }});
    await assert.rejects(denied.readPlaybackState(scoped), /OWNER_DENIED/);
    await x.db.query('update vdj_internal.generation_permits set revoked=true where id=$1', [permitId]);
    assert.equal((await x.ports.readOperation({roomId: x.room.roomId, operationId})).operation.dispatchAllowed, false);
    await x.db.query('update vdj_internal.rooms set control_revision=1 where id=$1', [x.room.roomId]);
    await assert.rejects(x.ports.readAttachments({...scoped, submissionIds: [x.submission.submissionId]}), /SCOPE_CHANGED/);
    await x.db.query('update vdj_internal.owners set enabled=false');
    await assert.rejects(x.ports.readScope({roomId: x.room.roomId}), /SCOPE_UNAVAILABLE/);
  } finally { await x.db.close(); }
});
test('permit metadata reads expose scoped IDs and digest only, and reread room authority without carrying owner proof', async () => {
  const x = await fixture(); try {
    const input = {roomId: x.room.roomId, permitId};
    const metadata = await x.ports.readPermitScope(input);
    const operation = await x.ports.readOperation({roomId: x.room.roomId, operationId});
    assert.equal(metadata.permitSha256, cueDigest(operation.operation.permit));
    assert.equal(metadata.permitId, permitId); assert.equal(metadata.revoked, false);
    assert.deepEqual(Object.keys(metadata).sort(), ['roomId', 'sessionId', 'controlRevision', 'permitId', 'revoked', 'expiresAtMs', 'permitSha256'].sort());
    assert(x.sql.every(statement => /^select\s/i.test(statement.trim())));
    await assert.rejects(x.ports.readPermitScope({...input, ownerCapability: owner}), /PERMIT_REFERENCE_REQUIRED/);
    await assert.rejects(x.ports.readPermitScope({...input, permitId: 'permit_' + 'q'.repeat(24)}), /PERMIT_SCOPE_REQUIRED/);
    await x.db.query('update vdj_internal.generation_permits set revoked=true where id=$1', [permitId]);
    assert.equal((await x.ports.readPermitScope(input)).revoked, true, 'metadata is not execution permission');
    let changed = false;
    const raced = createExistingCloudRepositoryReadPorts({...x.options, query: async (sql, values) => {
      const result = await x.options.query(sql, values);
      if (!changed && /p\.document as/.test(sql)) { changed = true; await x.db.query('update vdj_internal.rooms set control_revision=1 where id=$1', [x.room.roomId]); }
      return result;
    }});
    await assert.rejects(raced.readPermitScope(input), /ROOM_JOB_SCOPE_CHANGED/);
    await assert.rejects(x.ports.readPermitScope(input), /AUTHORITATIVE_PERMIT_SCOPE_REQUIRED/);
  } finally { await x.db.close(); }
});
test('private physical source and fresh player frontier require matching actual server ACK; ACK audioTime never becomes frame progress', async () => {
  const x = await fixture(); try {
    await assert.rejects(x.sourcePorts.readCurrentSource({roomId: x.room.roomId}), /MATCHING_ACTUAL_CURRENT_CUE_REQUIRED/);
    await x.play(); x.frontier.observedAtMs = Date.now();
    const current = await x.sourcePorts.readCurrent(x.room.roomId); assert.equal(current.playedUntilFrame, 1024); assert.equal(current.playbackRevision, 1);
    assert.equal(current.actual, true); assert.equal(current.clipId, 'synthetic-audio');
    const source = await x.sourcePorts.readCurrentSource({roomId: x.room.roomId}); assert.equal(source.playback.actual, true);
    assert.equal(source.music.contextSha256, fixtureSha(contextWave(decodeCompleteWave((await x.store.read('synthetic-audio')).bytes))));
    x.frontier.videoPresented = false; await assert.rejects(x.sourcePorts.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    x.frontier.videoPresented = true; x.frontier.observedAtMs = Date.now() - 30001;
    await assert.rejects(x.sourcePorts.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    x.frontier.observedAtMs = Date.now(); x.frontier.assetId = 'wrong-asset';
    await assert.rejects(x.sourcePorts.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    x.frontier.assetId = 'synthetic-audio'; x.frontier.observedAtMs = Date.now();
    x.store.records.get('synthetic-context').bytes[50] ^= 1;
    await assert.rejects(x.sourcePorts.readCurrent(x.room.roomId), /PRIVATE_ASSET_REQUIRED/);
  } finally { await x.db.close(); }
});
test('late cue stop or cross-scope private source/frontier record cannot become trusted current playback', async () => {
  const x = await fixture(); try {
    await x.play(); x.frontier.observedAtMs = Date.now();
    x.sourceRecord.controlRevision = 99;
    await assert.rejects(x.sourcePorts.readCurrent(x.room.roomId), /TRUSTED_CURRENT_SOURCE_RECORD_REQUIRED/);
    x.sourceRecord.controlRevision = 0;
    const stopped = createVerifiedCloudCurrentSourcePorts({repositoryPorts: x.ports, assetStore: x.store,
      readSourceRecord: async () => structuredClone(x.sourceRecord), readPlayerFrontier: async () => {
        await x.generation('cueStop'); return {...x.frontier, observedAtMs: Date.now()}; }});
    await assert.rejects(stopped.readCurrent(x.room.roomId), /CURRENT_SOURCE_CHANGED/);
  } finally { await x.db.close(); }
});
test('fresh read adapters recover lost responses and duplicate actual ACK without reposting or re-crediting; frame ports have no process cache', async () => {
  const x = await fixture(); try {
    const ack = await x.play(); let lost = true;
    const uncertain = createExistingCloudRepositoryReadPorts({...x.options, hostGenerationRead: async input => {
      const value = await x.options.hostGenerationRead(input); if (lost) { lost = false; throw Error('synthetic lost read response'); } return value;
    }});
    await assert.rejects(uncertain.readPlaybackState({roomId: x.room.roomId}), /synthetic lost read response/);
    const restarted = createExistingCloudRepositoryReadPorts(x.options), state = await restarted.readPlaybackState({roomId: x.room.roomId});
    assert.equal(state.currentCredit.actual, true); assert.equal(state.currentCredit.playbackRevision, 1);
    const duplicate = await x.generation('cueAck', ack); assert.equal(duplicate.duplicate, true);
    assert.equal(Object.values((await restarted.readPlaybackState({roomId: x.room.roomId})).servedCounts)[0], 1);
    const source = createVerifiedCloudCurrentSourcePorts({...x.sourceOptions, repositoryPorts: restarted});
    x.frontier.observedAtMs = Date.now(); const first = await source.readCurrent(x.room.roomId);
    assert.equal(first.playedUntilFrame, 1024);
    x.frontier.playedUntilFrame = 2048; x.frontier.observedAtMs = Date.now();
    const reconnected = createVerifiedCloudCurrentSourcePorts({...x.sourceOptions, repositoryPorts: createExistingCloudRepositoryReadPorts(x.options)});
    assert.equal((await reconnected.readCurrent(x.room.roomId)).playedUntilFrame, 2048);
    assert.equal((await reconnected.readCurrent(x.room.roomId)).playbackRevision, 1);
    x.frontier.playedUntilFrame = 24 * 44100;
    await assert.rejects(reconnected.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    await x.db.exec('set role anon');
    await assert.rejects(restarted.readScope({roomId: x.room.roomId}), /permission denied/);
  } finally { await x.db.close(); }
});
test('source record replacement during private inspection and future/cross-player observations hold without storing inferred frontier', async () => {
  const x = await fixture(); try {
    await x.play(); let reads = 0; x.frontier.observedAtMs = Date.now();
    const changing = createVerifiedCloudCurrentSourcePorts({...x.sourceOptions, readSourceRecord: async () => {
      const copy = structuredClone(x.sourceRecord); if (++reads > 1) copy.qcEvidenceSha256 = h('0'); return copy;
    }});
    await assert.rejects(changing.readCurrent(x.room.roomId), /CURRENT_SOURCE_CHANGED/);
    x.frontier.observedAtMs = Date.now() + 60000;
    await assert.rejects(x.sourcePorts.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    x.frontier.observedAtMs = Date.now(); x.frontier.roomId = '22222222-2222-4222-a222-222222222222';
    await assert.rejects(x.sourcePorts.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    x.frontier.roomId = x.room.roomId; x.frontier.targetPlayerId = 'wrong-player';
    await assert.rejects(x.sourcePorts.readCurrent(x.room.roomId), /FRONTIER_REQUIRED/);
    await assert.rejects(x.sourcePorts.readCurrentSource({roomId: x.room.roomId, actual: true, playedUntilFrame: 1024}), /IDS_ONLY/);
  } finally { await x.db.close(); }
});
