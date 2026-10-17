import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createCloudRoomProjection} from '../cloud/jobs/room-projection.mjs';
import {generationIdentity} from '../cloud/generation/dispatch.mjs';
import {buildVerifiedCue, operationBinding} from '../cloud/generation/cue-contract.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';

const owner = 'a'.repeat(64), guest = 'b'.repeat(64), other = 'c'.repeat(64), invitation = 'd'.repeat(64);
const operationId = 'operation_' + 'o'.repeat(24), permitId = 'permit_' + 'p'.repeat(24), hash = value => value.repeat(64);
async function fixture() {
  const db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const name of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL('../' + name, import.meta.url), 'utf8'));
  const uid = '11111111-1111-4111-a111-111111111111'; await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
  let room;
  const rpc = async (action, capability, payload = {}, verified = null) => (await db.query(
    'select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) value', [action, room?.roomId ?? null, capability, JSON.stringify(payload), verified])).rows[0].value;
  room = await rpc('create', null, {ownerCapability: owner, joinCode: invitation}, uid);
  await rpc('join', invitation, {nickname: 'synthetic guest', participantCapability: guest});
  await rpc('join', invitation, {nickname: 'synthetic other', participantCapability: other});
  const submission = await rpc('submit', guest, {nonce: 'synthetic_' + 's'.repeat(24), prompt: 'synthetic idea'});
  const hidden = await rpc('submit', other, {nonce: 'synthetic_' + 'h'.repeat(24), prompt: 'hidden synthetic idea'});
  const source = {music: {clipId: 'synthetic-parent', contextSeconds: 16, contextSha256: hash('e'), contextVerified: true,
    ready: true, control: {version: 1, energy: .5, tension: .5, density: .5, brightness: .5}},
    video: {motifId: 'synthetic-motif', motifSnapshotSha256: hash('f'), referenceSha256: hash('1')}, quality: {fixedBpm: 145}};
  const permit = {permitId, source, sourceSha256: cueDigest(cueSourceIdentity(source)),
    assets: {context: {url: 'https://synthetic.supabase.co/private/context'}}, privateCredentialMarker: 'synthetic-secret-marker'};
  await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
    select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`,
  [permitId, room.roomId, JSON.stringify(permit)]);
  const op = {operationId, submissionId: submission.submissionId, prompt: submission.prompt, permit, stopped: false,
    keyProof: hash('9'), plan: {status: 'COMPILED', commonIntentSha256: hash('2'), common: {cueId: 'synthetic-cue', control: {version: 2}}},
    stages: {intent: {state: 'COMPLETE'}, music: {state: 'SUBMITTED', requestId: 'synthetic-music'},
      video: {state: 'SUBMITTED', requestId: 'synthetic-video'}}};
  const setOperation = async () => db.query('update vdj_internal.generation_operations set document=$2::jsonb where id=$1', [operationId, JSON.stringify(op)]);
  await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
    [operationId, permitId, room.roomId, JSON.stringify(op)]);
  const ledger = async (action, payload = {}) => (await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
    [action, room.roomId, owner, JSON.stringify(payload)])).rows[0].value;
  const reads = [], attachments = [];
  const options = {
    roomRepository: {request: async (action, id, capability, payload) => (await db.query(
      'select public.vdj_room_request($1,$2,$3,$4::jsonb) value', [action, id, capability, JSON.stringify(payload)])).rows[0].value},
    authorizeOwner: async ({roomId: id, ownerCapability}) => {
      await db.query("select public.vdj_generation_request('cueState',$1,$2,'{}')", [id, ownerCapability]); return true;
    },
    readAttachments: async input => {
      attachments.push(input);
      return (await db.query(`select o.id as "operationId",p.id as "permitId",o.room_id as "roomId",p.room_epoch as "sessionId",
        p.control_revision::float as "controlRevision",o.document->>'submissionId' as "submissionId",
        p.document->>'sourceSha256' as "sourceSha256" from vdj_internal.generation_operations o
        join vdj_internal.generation_permits p on p.id=o.permit_id where o.room_id=$1`, [input.roomId])).rows
        .filter(record => input.submissionIds.includes(record.submissionId));
    },
    readOperation: async input => {
      reads.push(input);
      const saved = (await db.query(`select o.room_id as "roomId",p.room_epoch as "sessionId",p.id as "permitId",
        p.control_revision::float as "controlRevision",p.revoked,extract(epoch from p.expires_at)*1000 as "expiresAtMs"
        from vdj_internal.generation_operations o join vdj_internal.generation_permits p on p.id=o.permit_id where o.id=$1 and o.room_id=$2`,
      [input.operationId, input.roomId])).rows[0];
      return {...saved, expiresAtMs: Number(saved.expiresAtMs), operation: await ledger('read', {operationId: input.operationId})};
    },
    readPlaybackState: async () => ledger('cueState'),
  };
  const projection = createCloudRoomProjection(options), input = {roomId: room.roomId, ownerCapability: owner};
  const ready = async () => {
    for (const stage of ['music', 'video']) op.stages[stage] = {...op.stages[stage], state: 'COMPLETE', result: {resultSha256: hash(stage === 'music' ? '3' : '4'), url: 'https://v3.fal.media/synthetic-result'}};
    op.cue = {roomId: room.roomId, operationId, submissionId: submission.submissionId, cueId: op.plan.common.cueId,
      generationId: generationIdentity(operationId).generationId, sourceSha256: permit.sourceSha256,
      commonIntentSha256: op.plan.commonIntentSha256, controlVersion: 2, atomicReady: true, mode: 'provider', actualGenerationThisRun: true,
      status: 'READY', music: {asset: {assetId: 'synthetic-audio', sha256: hash('5')}}, video: {asset: {assetId: 'synthetic-timeline', sha256: hash('6')}},
      contribution: {participantId: submission.participantId, submissionId: submission.submissionId, nickname: submission.nickname}};
    await setOperation();
  };
  const fullReady = async () => {
    await ready();
    const media = channel => ({binding: operationBinding(room.roomId, op, channel), status: 'QC_READY', actualGenerationThisRun: true,
      providerReceipt: {requestId: op.stages[channel].requestId, resultSha256: op.stages[channel].result.resultSha256},
      qc: {passed: true, scope: 'synthetic-portable-worker'}, privateSaved: true, checksumVerified: true, durationSeconds: 24,
      asset: {assetId: channel === 'music' ? 'synthetic-audio' : 'synthetic-timeline', sha256: hash(channel === 'music' ? '5' : '6')}});
    const music = {...media('music'), parentClipId: source.music.clipId, contextSha256: source.music.contextSha256,
      contextVerified: true, continuationVerified: true, profile: {method: 'pcm-endpoint-profile-v1', assetSha256: hash('5'),
        sampleRate: 44100, channels: 2, frameCount: 24 * 44100}};
    const video = {...media('video'), compositionQC: {passed: true}, review: {accepted: true, ownerArtisticApproval: true,
      assetSha256: hash('6'), commonIntentSha256: op.plan.commonIntentSha256},
      clips: [{assetId: 'synthetic-clip', sha256: hash('7'), durationSeconds: 5, qcPassed: true, approved: true,
        providerRequestId: op.stages.video.requestId, providerResultSha256: op.stages.video.result.resultSha256}],
      timeline: {durationSeconds: 24, timeStretch: false, approvedLoops: true, segments: [0, 5, 10, 15, 20].map(start => ({
        assetId: 'synthetic-clip', sha256: hash('7'), startSeconds: start, endSeconds: Math.min(start + 5, 24), sourceInSeconds: 0,
        sourceOutSeconds: Math.min(5, 24 - start), playbackRate: 1}))}};
    op.cue = buildVerifiedCue({roomId: room.roomId, operation: op, evidence: {actualGenerationThisRun: true, mode: 'provider', music, video}});
    op.cue.contribution = {participantId: submission.participantId, submissionId: submission.submissionId, nickname: submission.nickname};
    await setOperation();
  };
  return {db, rpc, ledger, room, op, permit, submission, hidden, options, projection, input, reads, attachments, setOperation, ready, fullReady};
}

test('existing room proofs filter participant submissions before privileged job lookup; projection strips internal credentials and URLs', async () => {
  const x = await fixture(); try {
    const ownerView = await x.projection.readRoom(x.input); assert.equal(ownerView.submissions.length, 2);
    const guestView = await x.projection.readRoom({roomId: x.room.roomId, participantCapability: guest});
    assert.deepEqual(guestView.submissions.map(item => item.submissionId), [x.submission.submissionId]);
    assert.equal(guestView.submissions[0].state, 'PENDING'); assert.equal(guestView.actualCredit, false);
    assert.deepEqual(x.attachments.at(-1).submissionIds, [x.submission.submissionId]);
    const before = x.reads.length;
    await assert.rejects(x.projection.readSubmission({roomId: x.room.roomId, participantCapability: guest, submissionId: x.hidden.submissionId}), /OPERATION_NOT_FOUND/);
    assert.equal(x.reads.length, before);
    for (const forbidden of ['synthetic-secret-marker', owner, guest, permitId, hash('9'), 'https:'])
      assert.equal(JSON.stringify(ownerView).includes(forbidden), false);
    const persisted = await x.rpc('read', owner); assert.equal(persisted.submissions[0].state, 'QUEUED'); assert.deepEqual(persisted.submissions[0].jobs, []);
  } finally { await x.db.close(); }
});
test('a stopped revoked UNKNOWN remains archived while exactly one live replacement represents the same post',async()=>{
 const x=await fixture();try{
  const archivedId='archived_'+ 'u'.repeat(24),archivedPermit='archived_permit_'+ 'u'.repeat(24);
  await x.db.query(`insert into vdj_internal.generation_permits select $1,room_id,room_epoch,control_revision,expires_at,true,document from vdj_internal.generation_permits where id=$2`,[archivedPermit,permitId]);
  const archived={...structuredClone(x.op),operationId:archivedId,stopped:true,permit:{...x.permit,permitId:archivedPermit},
   stages:{intent:{state:'UNKNOWN',signature:hash('8')}}};delete archived.plan;
  await x.db.query('insert into vdj_internal.generation_operations values($1,$2,$3,$4::jsonb)',[archivedId,archivedPermit,x.room.roomId,JSON.stringify(archived)]);
  assert.equal((await x.projection.readSubmission({...x.input,submissionId:x.submission.submissionId})).state,'PENDING');
  assert.equal((await x.projection.readAttachment({...x.input,submissionId:x.submission.submissionId})).operationId,operationId);
  assert.equal((await x.ledger('read',{operationId:archivedId})).stages.intent.state,'UNKNOWN');
  await x.db.query('update vdj_internal.generation_permits set revoked=false where id=$1',[archivedPermit]);
  await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stopped}','false') where id=$1",[archivedId]);
  assert.equal((await x.projection.readSubmission({...x.input,submissionId:x.submission.submissionId})).state,'HOLD');
 }finally{await x.db.close();}
});
test('owner attachment is server selected and immutable; caller IDs and participant impersonation cannot attach work', async () => {
  const x = await fixture(); try {
    const input = {...x.input, submissionId: x.submission.submissionId}, first = await x.projection.prepare(input);
    assert.equal(first.operationId, operationId); assert.equal(first.permitId, permitId); assert.match(first.attachmentSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await x.projection.readAttachment(input), first);
    await assert.rejects(x.projection.prepare({...input, operationId}), /SERVER_ATTACHMENT_IDS_ONLY/);
    await assert.rejects(x.projection.prepare({...input, ownerCapability: guest}), /OWNER_DENIED/);
    await assert.rejects(x.projection.prepare({roomId: x.room.roomId, participantCapability: guest, submissionId: x.submission.submissionId}), /SERVER_ATTACHMENT_IDS_ONLY/);
  } finally { await x.db.close(); }
});
test('authoritative generation progress maps partial AV and QC review without inventing READY or participant credit', async () => {
  const x = await fixture(); try {
    const read = () => x.projection.readSubmission({...x.input, submissionId: x.submission.submissionId});
    x.op.stages.music.state = 'COMPLETE'; await x.setOperation(); assert.equal((await read()).state, 'PARTIAL_READY');
    x.op.stages.video.state = 'COMPLETE'; await x.setOperation(); assert.equal((await read()).state, 'WAIT_REVIEW');
    await x.ready(); assert.equal((await read()).state, 'READY'); assert.equal((await read()).jobs[0].actualPlayback, false);
    x.op.cue.commonIntentSha256 = hash('0'); await x.setOperation(); assert.equal((await read()).state, 'WAIT_REVIEW');
    x.op.stages.video.state = 'UNKNOWN'; await x.setOperation(); assert.equal((await read()).state, 'HOLD');
  } finally { await x.db.close(); }
});
test('server reservation and matching actual AV ACK remain separate; only actual RPC credit appears in room and own participant view', async () => {
  const x = await fixture(); try {
    await x.fullReady(); const reservationId = 'reservation_' + 'r'.repeat(24), expiresAtMs = Date.now() + 30000;
    const reservation = await x.ledger('cueReserve', {operationId, reservationId,
      plan: {status: 'ELIGIBLE', liveReady: true, cueId: x.op.cue.cueId, incomingSha256: hash('5')},
      current: {actual: true, playbackRevision: 0}, expectedRevision: 1, expiresAtMs});
    const reserved = await x.projection.readRoom(x.input); assert.equal(reserved.submissions[0].state, 'RESERVED'); assert.equal(reserved.currentCredit, null);
    const ack = {roomId: x.room.roomId, cueId: reservation.cue.cueId, clipId: reservation.cue.music.asset.assetId,
      playbackRevision: 1, audioTime: 1, actual: true, audioStarted: true, videoPresented: true};
    await assert.rejects(x.ledger('cueAck', {reservationId, ack: {...ack, videoPresented: false}, ackSha256: cueDigest(ack)}), /MATCHING_ACTUAL_AV_ACK_REQUIRED/);
    assert.equal((await x.projection.readRoom(x.input)).currentCredit, null);
    await x.ledger('cueAck', {reservationId, ack, ackSha256: cueDigest(ack)});
    const played = await x.projection.readRoom(x.input); assert.equal(played.actualCredit, true); assert.equal(played.currentCredit.actual, true);
    assert.equal(played.submissions[0].state, 'PLAYING'); assert.equal(played.submissions[0].jobs[0].playerAcknowledged, true);
    const otherView = await x.projection.readRoom({roomId: x.room.roomId, participantCapability: other});
    assert.equal(otherView.currentCredit, null); assert.equal(otherView.actualCredit, false); assert.equal(otherView.submissions.length, 1);
    // A corrupted saved cue cannot keep publishing PLAYING/credit even when
    // the prior actual ACK remains recorded in the authoritative ledger.
    const actualCue = structuredClone((await x.ledger('read', {operationId})).cue);
    x.op.cue = structuredClone(actualCue); x.op.cue.music.qc.passed = false; await x.setOperation();
    const corrupt = await x.projection.readRoom(x.input); assert.equal(corrupt.actualCredit, false);
    assert.equal(corrupt.currentCredit, null); assert.equal(corrupt.submissions[0].state, 'HOLD');
    await x.ledger('cueStop'); assert.equal((await x.projection.readRoom(x.input)).currentCredit, null);
  } finally { await x.db.close(); }
});
test('wrong room/epoch/control/source, expired permit and duplicate server attachments are held before exposing ready state', async () => {
  const x = await fixture(); try {
    await x.ready();
    for (const mutate of [record => ({...record, roomId: '22222222-2222-4222-a222-222222222222'}),
      record => ({...record, sessionId: 'example_wrong_epoch'}), record => ({...record, controlRevision: 99}),
      record => ({...record, sourceSha256: hash('0')})]) {
      const projection = createCloudRoomProjection({...x.options, readAttachments: async input => (await x.options.readAttachments(input)).map(mutate)});
      assert.equal((await projection.readRoom(x.input)).submissions[0].state, 'HOLD');
      await assert.rejects(projection.prepare({...x.input, submissionId: x.submission.submissionId}), /SCOPE_CHANGED/);
    }
    const duplicate = createCloudRoomProjection({...x.options, readAttachments: async input => { const rows = await x.options.readAttachments(input); return [...rows, ...rows]; }});
    assert.equal((await duplicate.readRoom(x.input)).submissions[0].state, 'HOLD');
    await x.db.query("update vdj_internal.generation_permits set expires_at=now()-interval '1 second' where id=$1", [permitId]);
    assert.equal((await x.projection.readRoom(x.input)).submissions[0].state, 'HOLD');
    await assert.rejects(x.projection.prepare({...x.input, submissionId: x.submission.submissionId}), /SCOPE_CHANGED/);
    await x.db.query("update vdj_internal.generation_permits set expires_at=now()+interval '10 minutes' where id=$1", [permitId]);
    await x.rpc('control', owner, {nonce: 'control_' + 'r'.repeat(24), expectedRevision: 0, accepting: false});
    assert.equal((await x.projection.readRoom(x.input)).submissions[0].state, 'HOLD');
  } finally { await x.db.close(); }
});
test('late stop and room control changes invalidate a view or attachment while it is being assembled', async () => {
  const x = await fixture(); try {
    await x.ready(); let reads = 0;
    const stop = createCloudRoomProjection({...x.options, readOperation: async input => {
      const value = await x.options.readOperation(input);
      if (++reads === 1) await x.ledger('stop', {operationId});
      return value;
    }});
    assert.equal((await stop.readRoom(x.input)).submissions[0].state, 'HOLD');
    x.op.stopped = false; await x.setOperation(); reads = 0;
    const control = createCloudRoomProjection({...x.options, readOperation: async input => {
      const value = await x.options.readOperation(input);
      if (++reads === 1) await x.rpc('control', owner, {nonce: 'late_control_' + 'r'.repeat(24), expectedRevision: 0, accepting: false});
      return value;
    }});
    await assert.rejects(control.prepare({...x.input, submissionId: x.submission.submissionId}), /SCOPE_CHANGED/);
  } finally { await x.db.close(); }
});
test('atomic channel summary requires the full persisted bound AV QC projection and rejects forged/mismatched/short/gapped cues', async () => {
  const x = await fixture(); try {
    const read = async () => (await x.projection.readRoom(x.input)).submissions[0].jobs[0];
    await x.ready(); const minimal = await read(); assert.equal(minimal.state, 'READY'); assert.equal(minimal.atomicReady, false); assert.deepEqual(minimal.channels, {});
    await x.fullReady(); const valid = structuredClone(x.op.cue), summary = await read();
    assert.equal(summary.atomicReady, true); assert.equal(summary.actualGenerationThisRun, true);
    assert.deepEqual(summary.channels.music, {status: 'QC_READY', qcPassed: true, durationSeconds: 24,
      generationId: valid.generationId, controlVersion: valid.controlVersion});
    assert.equal(summary.channels.video.compositionQcPassed, true); assert.equal(summary.cueId, valid.cueId);
    for (const mutate of [cue => { cue.music.qc.passed = false; }, cue => { delete cue.video.qc.evidenceSha256; },
      cue => { cue.video.binding.controlVersion++; }, cue => { cue.music.binding.submissionId = x.hidden.submissionId; },
      cue => { cue.video.durationSeconds = 5; }, cue => { cue.video.timeline.segments[1].startSeconds = 6; },
      cue => { cue.video.timeline.timeStretch = true; }, cue => { cue.video.review.accepted = false; },
      cue => { cue.music.profile.assetSha256 = hash('0'); }, cue => { cue.video.compositionQC.passed = false; }]) {
      x.op.cue = structuredClone(valid); mutate(x.op.cue); await x.setOperation();
      const forged = await read(); assert.equal(forged.atomicReady, false); assert.equal(forged.actualGenerationThisRun, false); assert.deepEqual(forged.channels, {});
    }
  } finally { await x.db.close(); }
});
test('job state digest tracks generation/cue updates at the same room eventSeq and stays stable across repeated reads and private text/URL changes', async () => {
  const x = await fixture(); try {
    const first = await x.projection.readRoom(x.input), repeated = await x.projection.readRoom(x.input);
    assert.equal(first.jobStateSha256, repeated.jobStateSha256); assert.match(first.jobStateSha256, /^[a-f0-9]{64}$/);
    x.op.stages.music.state = 'COMPLETE'; await x.setOperation(); const partial = await x.projection.readRoom(x.input);
    assert.equal(first.eventSeq, partial.eventSeq); assert.notEqual(first.jobStateSha256, partial.jobStateSha256);
    await x.ready(); const minimal = await x.projection.readRoom(x.input); assert.notEqual(partial.jobStateSha256, minimal.jobStateSha256);
    await x.fullReady(); const full = await x.projection.readRoom(x.input); assert.equal(full.eventSeq, first.eventSeq);
    assert.notEqual(full.jobStateSha256, minimal.jobStateSha256);
    x.op.prompt = 'changed synthetic private prompt'; x.op.keyProof = hash('8');
    x.op.permit.assets.context.url = 'https://synthetic.supabase.co/private/changed-url';
    x.op.stages.video.result.url = 'https://v3.fal.media/changed-private-result'; await x.setOperation();
    assert.equal((await x.projection.readRoom(x.input)).jobStateSha256, full.jobStateSha256);
    await x.db.query("update vdj_internal.rooms set submissions=(select jsonb_agg(value||jsonb_build_object('nickname','changed synthetic nickname','prompt','changed synthetic text')) from jsonb_array_elements(submissions)) where id=$1", [x.room.roomId]);
    assert.equal((await x.projection.readRoom(x.input)).jobStateSha256, full.jobStateSha256);
    await x.ledger('stop', {operationId}); assert.notEqual((await x.projection.readRoom(x.input)).jobStateSha256, full.jobStateSha256);
  } finally { await x.db.close(); }
});
test('projected nicknames are limited by Unicode code points and never split a surrogate pair', async () => {
  const {projectedText} = await import('../cloud/jobs/room-projection.mjs');
  const emoji = '🎧'.repeat(40);
  assert.equal(projectedText(emoji, 40), emoji, 'a valid 40-emoji nickname is kept whole');
  const mixed = 'a'.repeat(39) + '🎧🎧';
  assert.equal(projectedText(mixed, 40), 'a'.repeat(39) + '🎧');
  assert.equal(projectedText('x\u0000y', 40), 'xy');
});
test('played Cues read as finished, clarification keeps its question, and a published Cue survives permit expiry', async () => {
  const x = await fixture(); try {
    const read = () => x.projection.readSubmission({...x.input, submissionId: x.submission.submissionId});
    await x.fullReady(); assert.equal((await read()).state, 'READY');
    // Generation permits are finite; a QC-sealed published Cue stays playable and visible.
    await x.db.query("update vdj_internal.generation_permits set expires_at=now()-interval '1 minute'");
    assert.equal((await read()).state, 'READY');
    x.op.cue.status = 'PLAYED'; await x.setOperation(); assert.equal((await read()).state, 'PLAYED');
    // Revocation still hides it.
    await x.db.query('update vdj_internal.generation_permits set revoked=true'); assert.equal((await read()).state, 'HOLD');
  } finally { await x.db.close(); }
  const y = await fixture(); try {
    y.op.stages.intent = {state: 'COMPLETE'}; y.op.plan = {...y.op.plan, status: 'NEEDS_CLARIFICATION', question: '明るくしますか、暗くしますか？'};
    await y.setOperation();
    const job = (await y.projection.readSubmission({...y.input, submissionId: y.submission.submissionId})).jobs[0];
    assert.equal(job.state, 'CLARIFY'); assert.equal(job.question, '明るくしますか、暗くしますか？');
  } finally { await y.db.close(); }
});
test('a replayed run at the same revision gets a new job-state fingerprint', async () => {
  const x = await fixture(); try {
    await x.ready(); await x.fullReady();
    x.op.roomRuntime = {currentCredit: null, servedCounts: {}, acks: [], stopped: false}; await x.setOperation();
    const before = await x.projection.readRoom(x.input);
    // Stop -> Start -> the same Cue accepted again: the served total grows.
    x.op.roomRuntime = {...x.op.roomRuntime, servedCounts: {[x.op.cue.contribution.participantId]: 1}}; await x.setOperation();
    const replayed = await x.projection.readRoom(x.input);
    assert.equal(replayed.eventSeq, before.eventSeq); assert.notEqual(replayed.jobStateSha256, before.jobStateSha256);
    x.op.roomRuntime = {...x.op.roomRuntime, stopped: true}; await x.setOperation();
    assert.notEqual((await x.projection.readRoom(x.input)).jobStateSha256, replayed.jobStateSha256, 'Stop is part of the fingerprint');
  } finally { await x.db.close(); }
});
