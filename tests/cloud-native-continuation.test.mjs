import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createSyntheticCloudWorkerFixture, fixtureSha} from './cloud-worker-fixture.mjs';
import {createCloudGenerationJobs} from '../cloud/jobs/generation-jobs.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import {createCueCoordinator} from '../cloud/generation/cue-coordinator.mjs';
import {createCloudRoomProjection} from '../cloud/jobs/room-projection.mjs';
import {createCloudPlaybackAdapter} from '../room-web/cloud-playback.mjs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {createAudioOutputLease} from '../room-web/playback/output-lease.mjs';
import {createVideoAdapter} from '../snapshot/ui/app/scene-video-adapter.mjs';
import {prepareCloudInitialAudio, createCloudSeedPlayback} from '../room-web/cloud-initial-audio.mjs';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {evaluateTransition} from '../snapshot/app/runtime/dj-transition-selector.mjs';
import {decodeCompleteWave, contextWave} from '../integration/runtime/bootstrap.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';

// Real local Python/ffmpeg QC, production SQL/coordinator/resolver/processor.
// Provider and private-ingestion projection are fabricated in-memory fixtures.
// Video callbacks are injected; this is not real browser or paid generation.
const RATE = 44100, OWNER = 'a'.repeat(64), FOREIGN_OWNER = 'f'.repeat(64), INVITE = 'c'.repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) {for (let n = 0; n < 5000; n++) {if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 1));} assert.fail('native continuation did not advance');}
class Video {
  constructor() {this.style = {}; this.videoWidth = 160; this.videoHeight = 90; this.readyState = 3; this.currentTime = 0; this.frames = new Map(); this.next = 0;}
  get currentSrc(){return this.src;}
  setAttribute() {} removeAttribute(k) {if (k === 'src') delete this.src;} addEventListener() {} removeEventListener() {} load() {} pause() {this.playing=false;} remove() {}
  play() {this.playing=true;return Promise.resolve();} requestVideoFrameCallback(fn) {const id = ++this.next; this.frames.set(id, fn); return id;}
  cancelVideoFrameCallback(id) {this.frames.delete(id);} present() {if(!this.playing)return;for (const [id, fn] of this.frames) {this.frames.delete(id); fn(0, {});}}
}
function graph() {
  let Processor, state = 'suspended', stopped = 0; const listeners = new Set(), commands = [], observations = [];
  const sandbox = {Float32Array, ArrayBuffer, sampleRate: RATE, currentTime: 0,
    AudioWorkletProcessor: class {constructor() {this.port = {postMessage(data) {observations.push(data); for (const fn of listeners) fn({data});}};}},
    registerProcessor(name, ctor) {assert.equal(name, 'queue-audio'); Processor = ctor;}};
  const processorSource = readFile(new URL('../snapshot/app/room-worklet.mjs', import.meta.url), 'utf8');
  return {async initialize() {vm.runInNewContext(await processorSource, sandbox); this.processor = new Processor();},
    context: {sampleRate: RATE, get state() {return state;}, resume() {state = 'running'; return Promise.resolve();}},
    node: {port: {start() {}, addEventListener(type, fn) {listeners.add(fn);}, removeEventListener(type, fn) {listeners.delete(fn);},
      postMessage(data) {commands.push(data); this.owner.message(data);}, owner: null}},
    commands, observations, stops: () => stopped, async stopAudio() {state = 'suspended'; stopped++;},
    pump(blocks = 1) {const output = [new Float32Array(128), new Float32Array(128)]; for (let n = 0; n < blocks; n++) {output[0].fill(0); output[1].fill(0); this.processor.process([], [output]); sandbox.currentTime += 128 / RATE;}}};
}

test('three proof-scoped synthetic guests each earn one nativeAV credit on one96s graph; cross-user/owner and duplicate attempts do not spend or replay',
 {skip: !process.env.VDJ_QC_PYTHON}, async t => {
  const db = new PGlite(), operations = new Map(), videos = [], descriptors = [], posts = [], privilegedReads = [];
  // Browser video presentation continues while owner/SQL promises settle,
  // including after a manual audio pump has reached its requested frontier.
  const presentation=setInterval(()=>videos.forEach(video=>video.present()),5);
  const guests = ['b', 'd', 'e'].map((value, index) => ({capability: value.repeat(64), nickname: `合成参加者${index + 1}`, prompt: `合成案${index + 1}:静かな星空へ、光を広げて`}));
  let credentialReads = 0;
  let room, current, fixture, jobs, port, engine, seed, reservation;
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
    for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql']) await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
    const uid = '11111111-1111-4111-a111-111111111111'; await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
    const roomCall = async (action, capability, payload = {}, verified = null) => (await db.query('select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) r',
      [action, room?.roomId ?? null, capability, JSON.stringify(payload), verified])).rows[0].r;
    room = await roomCall('create', null, {ownerCapability: OWNER, joinCode: INVITE}, uid);
    for (const participant of guests) {
      const joined = await roomCall('join', INVITE, {nickname: participant.nickname, participantCapability: participant.capability});
      participant.participantId = joined.participantId;
    }
    const foreignUid = '22222222-2222-4222-a222-222222222222'; await db.query('insert into vdj_internal.owners(uid) values($1)', [foreignUid]);
    const foreignRoom = await roomCall('create', null, {ownerCapability: FOREIGN_OWNER, joinCode: '9'.repeat(64)}, foreignUid);
    assert.notEqual(foreignRoom.roomId, room.roomId);
    await assert.rejects(roomCall('read', FOREIGN_OWNER), /ACTOR_DENIED/);
    const repository = {request: async (action, id, capability, payload) => (await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) r',
      [action, id, capability, JSON.stringify(payload)])).rows[0].r};
    fixture = await createSyntheticCloudWorkerFixture({roomId: room.roomId, readCurrent: async () => current,
      readOperation: async ({operationId}) => operations.get(operationId),
      runtime: {python: process.env.VDJ_QC_PYTHON, ffmpeg: process.env.VDJ_QC_FFMPEG ?? 'ffmpeg', ffprobe: process.env.VDJ_QC_FFPROBE ?? 'ffprobe'}});
    current = structuredClone(fixture.source); current.playback.actual = false;
    const coordinator = createCueCoordinator({enabled: true, repository, inspectGeneration: fixture.worker.inspectGeneration,
      readCurrent: fixture.worker.readCurrent, inspectJoin: fixture.worker.inspectJoin});
    const provider = {async submit({model}) {posts.push(model); return {request_id: 'native-fixture-' + posts.length};},
      async status() {return {status: 'COMPLETED'};}, async result({model}) {return {data: model === GENERATION_CONTRACT.intent ?
        {output: JSON.stringify({needsClarification: false, question: '', interpretation: '静かに光を広げる', direction: 'down', intensity: .5,
          visualOpenness: 'increase', musicDevelopment: 'Preserve pulse and reduce competing layers.', visualDevelopment: 'Open geometry and preserve detail.'}), usage: {cost: .001}} :
        model === GENERATION_CONTRACT.music ? {audio: {url: 'https://v3.fal.media/native-fixture.wav'}} : {video: {url: 'https://v3.fal.media/native-fixture.mp4'}}};}};
    jobs = createCloudGenerationJobs({enabled: true, repository, provider, mediaHost: 'synthetic.supabase.co', coordinator,
      credentialForOperation: async () => {credentialReads++; return 'synthetic-only-credential';}, prepareMedia: async input => {
        const op = {...await repository.request('read', input.roomId, OWNER, {operationId: input.operationId}), roomId: input.roomId};
        operations.set(input.operationId, await fixture.projectOperation(op));
      }});
    async function generate(index) {
      const operationId = 'native_operation_' + String(index).repeat(24), permitId = 'native_permit_' + String(index).repeat(24);
      const participant = guests[index - 1], payload = {nonce: 'native_submit_' + String(index).repeat(24), prompt: participant.prompt};
      const submission = await roomCall('submit', participant.capability, payload);
      assert.equal(submission.participantId, participant.participantId); assert.equal(submission.nickname, participant.nickname);
      assert.deepEqual(await roomCall('submit', participant.capability, payload), submission, 'identical nonce retry creates no second submission');
      await assert.rejects(roomCall('submit', participant.capability, {...payload, prompt: 'different synthetic idea'}), /NONCE_CONFLICT/);
      assert.equal((await roomCall('read', OWNER)).submissions.length, index);
      const now = Date.now(), source = structuredClone(current);
      const permit = {permitId, kind: GENERATION_CONTRACT.version, counts: GENERATION_CONTRACT.counts, createdAtMs: now, expiresAtMs: now + 600000,
        maximumUsd: 1, source, sourceSha256: cueDigest(cueSourceIdentity(source)), visualPolicy: TECHNICAL_VISUAL_POLICY,
        quote: {verified: true, evidenceSha256: '1'.repeat(64), observedAtMs: now, maximumUsd: {intent: .01, music: .1, video: .5}},
        balance: {usd: 2, autoTopUp: false, observedAtMs: now}, assets: {
          context: {url: 'https://synthetic.supabase.co/private/context', private: true, checksumVerified: true, sha256: source.music.contextSha256,
            expiresAtMs: now + 660000, serverAudioQC: true, providerOriginVerified: true},
          reference: {url: 'https://synthetic.supabase.co/private/reference', private: true, checksumVerified: true,
            sha256: source.video.referenceSha256, expiresAtMs: now + 660000}}};
      await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
        select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`, [permitId, room.roomId, JSON.stringify(permit)]);
      const input = {roomId: room.roomId, operationId, ownerCapability: OWNER};
      const start = {...input, permitId, submissionId: submission.submissionId}, postsBefore = posts.length, keysBefore = credentialReads;
      for (const deniedCapability of [guests[(index + 1) % 3].capability, FOREIGN_OWNER]) {
        await assert.rejects(jobs.start({...start, ownerCapability: deniedCapability}), /OWNER_DENIED/);
        await assert.rejects(jobs.advance({...input, ownerCapability: deniedCapability}), /OWNER_DENIED/);
      }
      assert.equal(posts.length, postsBefore); assert.equal(credentialReads, keysBefore, 'authentication precedes credential adapter access');
      await jobs.start(start); await jobs.start(start);
      assert.equal(posts.length, postsBefore, 'duplicate durable begin never dispatches another provider request');
      for (let n = 0; n < 3; n++) await jobs.advance(input);
      assert.equal((await jobs.read(input)).state, 'READY');
      const cue = (await coordinator.execute({action: 'state', ...input})).cues.find(c => c.operationId === operationId);
      assert.equal(cue.atomicReady, true); assert.equal(cue.music.durationSeconds, 24); assert.equal(cue.video.timeline.durationSeconds, 24);
      return {input, cue, operation: operations.get(operationId), submission};
    }
    const first = await generate(1), firstSource = await fixture.worker.readCurrent(room.roomId);
    const firstReceipt = await fixture.worker.inspectJoin({current: firstSource, candidate: first.cue});
    const firstPlan = evaluateTransition({current: firstSource, candidate: first.cue, pairQC: firstReceipt, mode: 'provider'});
    assert.equal(firstPlan.status, 'ELIGIBLE');
    const seedRecord = await fixture.store.read(current.audioAssetId), sourcePcm = decodeCompleteWave(seedRecord.bytes).pcm;
    const seedPlan = await prepareCloudInitialAudio({bytes: new Uint8Array(seedRecord.bytes),
      descriptor: {assetId: current.music.clipId, sha256: current.music.sha256, pcmSha256: await pcmSha256(sourcePcm), byteLength: seedRecord.byteLength, mimeType: 'audio/wav'},
      source: {actual: false, clipId: current.music.clipId, sha256: current.music.sha256, contextSha256: current.music.contextSha256, playbackRevision: 0, frameCount: 24 * RATE},
      mode: 'bootstrap', graphEpoch: 1});
    const g = graph(); await g.initialize(); g.node.port.owner = g.processor;
    const lease = createAudioOutputLease({locks: {request: async (name, options, callback) => callback({name})}});
    port = createCloudPlaybackAdapter({enabled: true, fixtureMode: true, enableClipRelativeTimeline: true, origin: 'https://ai-vdj.vercel.app', lifecycle: {}, container: {append() {}},
      outputLease: lease, urlAPI: {createObjectURL() {return 'blob:native-fixture';}, revokeObjectURL() {}},
      resolveManifest: async payload => {
        const desc = await fixture.worker.describeRender({roomId: room.roomId, cue: reservation.cue, plan: payload.plan, expectedRevision: reservation.expectedRevision});
        descriptors.push(desc);
        const render = Object.fromEntries(['assetId', 'sha256', 'byteLength', 'mimeType', 'renderedFileSha256', 'renderedPcmSha256', 'sampleRate', 'startFrame', 'durationFrames', 'expectedPlayedWindowSha256'].map(k => [k, desc[k]]));
        render.timelineSpace = 'clip-relative-v1';
        const op = operations.get(reservation.operationId), cue = reservation.cue;
        return {roomId: room.roomId, cueId: cue.cueId, generationId: cue.generationId, submissionId: cue.submissionId, controlVersion: cue.controlVersion,
          commonIntentSha256: cue.commonIntentSha256, audio: {...cue.music.asset, render}, videos: await Promise.all(cue.video.clips.map(async clip => ({assetId: clip.assetId, sha256: clip.sha256,
            byteLength: (await fixture.store.read(clip.assetId)).byteLength, mimeType: 'video/mp4', source: 'provider-response-replay', requestId: op.stages.video.requestId})))};
      }, request: async path => {
        const record = await fixture.store.read(path.split('/media/')[1].split('?')[0]);
        return new Response(record.bytes, {headers: {'Content-Type': record.contentType, 'Content-Length': String(record.byteLength)}});
      }, createAudioEngine: ({loadVerifiedRender, enableClipRelativeTimeline}) => engine = createWorkletPlaybackEngine({enableClipRelativeTimeline, context: g.context, node: g.node, allowInitialAudio: true,
        loadVerifiedRender, readSourceCount: () => 1, stopAudio: g.stopAudio}),
      createVideoAdapter: input => createVideoAdapter({...input, crossfadeMs: 0, fetchImpl() {throw Error('network forbidden');}}),
      videoFactory: () => {const video = new Video(); videos.push(video); return video;}});
    seed = createCloudSeedPlayback({enabled: true, plan: seedPlan, audioEngine: engine, outputLease: lease, guard: async () => true,
      markSourceStarted: async ack => {current.playback = {...current.playback, actual: true, phase: 'PLAYING', playedUntilFrame: ack.playedUntilFrame};
        return {accepted: true, graphEpoch: ack.graphEpoch, sourceSha256: ack.sourceSha256, sourcePlaybackRevision: ack.sourcePlaybackRevision};}});
    const sourceStarted = seed.start(); await until(() => g.commands.some(c => c.type === 'play')); g.pump(90); await sourceStarted;
    await port.unlock(); seed.handoff(port); await coordinator.execute({action: 'start', ...first.input});
    async function playReservation(input) {
      reservation = await coordinator.execute({action: 'reserve', ...input}); assert.equal(reservation.plan.status, 'ELIGIBLE');
      return {nativePlan: JSON.stringify(reservation.plan), outcome: port.commitPlayback({roomId: room.roomId, cue: reservation.cue, plan: reservation.plan, expectedRevision: reservation.expectedRevision,
        guard: async ({phase}) => (await coordinator.execute({action: 'check', ...input, reservationId: reservation.reservationId, phase})).valid}).then(ack => ({ack}), error => ({error}))};
    }
    async function pumpTo(frame) {
      while (g.processor.consumed < frame && !['HOLD', 'STOPPED'].includes(port.read().phase)) {
        g.pump(Math.min(64, Math.ceil((frame - g.processor.consumed) / 128))); for (let n = 0; n < 4; n++) await turn(); videos.forEach(v => v.present());
      }
      for (let n = 0; n < 10; n++) await turn();
    }
    const playing = await playReservation(first.input);
    await until(() => g.commands.some(c => c.type === 'replace-future') || port.read().phase === 'HOLD');
    await pumpTo(24 * RATE + RATE / 2); const ack1 = (await playing.outcome).ack; assert.ok(ack1, port.read().reason); assert.equal(JSON.stringify(reservation.plan), playing.nativePlan);
    const accepted1 = await coordinator.execute({action: 'ack', ...first.input, reservationId: reservation.reservationId, ack: ack1});
    assert.equal(accepted1.accepted, true); assert.equal(accepted1.currentCredit.playbackRevision, 1);
    assert.equal(accepted1.currentCredit.participantId, guests[0].participantId); assert.equal(accepted1.currentCredit.nickname, guests[0].nickname);
    const replay = await coordinator.execute({action: 'ack', ...first.input, reservationId: reservation.reservationId, ack: ack1});
    assert.equal(replay.duplicate, true); assert.equal((await coordinator.execute({action: 'state', ...first.input})).servedCounts[guests[0].participantId], 1);
    for (const deniedCapability of [guests[1].capability, FOREIGN_OWNER]) {
      await assert.rejects(coordinator.execute({action: 'ack', ...first.input, ownerCapability: deniedCapability, reservationId: reservation.reservationId, ack: ack1}), /OWNER_DENIED/);
    }
    // Test-only current-source promotion uses the physically saved generated cue
    // and its exact16s context. No bootstrap/provider origin is relabelled.
    async function promote(set, revision) {
      const incoming = await fixture.store.read(set.cue.music.asset.assetId), audio = decodeCompleteWave(incoming.bytes), contextBytes = contextWave(audio);
      const context = await fixture.store.save({id: `native-derived-context-${revision}`, bytes: contextBytes, contentType: 'audio/wav',
        binding: {kind: 'synthetic-derived-context'}, provenance: {kind: 'synthetic-derived-context'}});
      assert.equal(context.sha256, fixtureSha(contextBytes));
      const observed = port.readSourceState();
      assert.equal(observed.clipId, incoming.assetId); assert.equal(observed.sha256, incoming.sha256);
      assert.equal(observed.playbackRevision, revision); assert.equal(observed.originFrame, revision * 24 * RATE);
      assert.equal(observed.actual, true); assert.ok(observed.playedFrames >= 256 && observed.playedFrames < 24 * RATE);
      current = {...current, audioAssetId: incoming.assetId, contextAssetId: context.assetId,
        music: {...current.music, clipId: incoming.assetId, sha256: incoming.sha256, profile: set.cue.music.profile,
          contextSha256: context.sha256, control: set.operation.plan.common.control},
        playback: {actual: observed.actual, phase: 'PLAYING', revision: observed.playbackRevision, playedUntilFrame: observed.playedFrames}};
    }
    await promote(first, 1);
    const second = await generate(2), secondSource = await fixture.worker.readCurrent(room.roomId);
    assert.equal(secondSource.playbackRevision, 1); assert.ok(secondSource.playedUntilFrame < 24 * RATE);
    const playing2 = await playReservation(second.input);
    await until(() => g.commands.filter(c => c.type === 'replace-future').length === 2 || port.read().phase === 'HOLD');
    await pumpTo(48 * RATE + RATE / 2); const result2 = await playing2.outcome;
    assert.equal(result2.error, undefined, result2.error?.message); assert.equal(result2.ack.playbackRevision, 2); assert.equal(JSON.stringify(reservation.plan), playing2.nativePlan);
    const accepted2 = await coordinator.execute({action: 'ack', ...second.input, reservationId: reservation.reservationId, ack: result2.ack});
    assert.equal(accepted2.accepted, true); assert.equal(accepted2.currentCredit.playbackRevision, 2);
    assert.equal(accepted2.currentCredit.participantId, guests[1].participantId); assert.equal(accepted2.currentCredit.nickname, guests[1].nickname);
    assert.equal(port.read().phase, 'PLAYING'); assert.equal(port.read().playbackRevision, 2);
    assert.equal(g.processor.underruns, 0); assert.equal(engine.readState().sourceCount, 1);
    for (const [index, desc] of descriptors.entries()) {
      const trace = g.observations.find(e => e.playedWindow?.startFrame === (index + 1) * 24 * RATE).playedWindow;
      assert.equal(await pcmSha256(trace.pcm), desc.expectedPlayedWindowSha256);
    }
    await promote(second, 2);
    const third = await generate(3), playing3 = await playReservation(third.input);
    await until(() => g.commands.filter(c => c.type === 'replace-future').length === 3 || port.read().phase === 'HOLD');
    await pumpTo(72 * RATE + RATE / 2); const result3 = await playing3.outcome;
    assert.equal(result3.error, undefined, result3.error?.message); assert.equal(result3.ack.playbackRevision, 3); assert.equal(JSON.stringify(reservation.plan), playing3.nativePlan);
    const accepted3 = await coordinator.execute({action: 'ack', ...third.input, reservationId: reservation.reservationId, ack: result3.ack});
    assert.equal(accepted3.accepted, true); assert.equal(accepted3.currentCredit.playbackRevision, 3);
    assert.equal(accepted3.currentCredit.participantId, guests[2].participantId); assert.equal(accepted3.currentCredit.nickname, guests[2].nickname);
    assert.equal(port.read().phase, 'PLAYING'); assert.equal(port.read().playbackRevision, 3);
    assert.equal(g.processor.underruns, 0); assert.equal(engine.readState().sourceCount, 1);
    const trace3 = g.observations.find(e => e.playedWindow?.startFrame === 72 * RATE).playedWindow;
    assert.equal(await pcmSha256(trace3.pcm), descriptors[2].expectedPlayedWindowSha256);
    assert.deepEqual(descriptors.map(d => [d.startFrame, d.durationFrames]), [[24 * RATE, 48 * RATE], [24 * RATE, 48 * RATE], [24 * RATE, 48 * RATE]]);
    for (const desc of descriptors) {
      const bytes = await fixture.store.read(desc.assetId); assert.equal(fixtureSha(bytes.bytes), desc.renderedFileSha256);
      assert.equal(await pcmSha256(decodeCompleteWave(bytes.bytes).pcm), desc.renderedPcmSha256);
    }
    const state = await coordinator.execute({action: 'state', ...third.input});
    assert.equal(state.currentCredit.playbackRevision, 3);
    assert.equal(new Set([first.submission.participantId, second.submission.participantId, third.submission.participantId]).size, 3);
    assert.deepEqual(state.servedCounts, Object.fromEntries(guests.map(participant => [participant.participantId, 1])));
    assert.equal(state.cues.find(c => c.cueId === second.cue.cueId).status, 'PLAYED'); assert.equal((await jobs.read(third.input)).playerAcknowledged, true); assert.equal(posts.length, 9);
    const roomProjection = createCloudRoomProjection({
      roomRepository: {request: async (action, id, capability, payload) => (await db.query('select public.vdj_room_request($1,$2,$3,$4::jsonb) r',
        [action, id, capability, JSON.stringify(payload)])).rows[0].r},
      authorizeOwner: async input => {await repository.request('cueState', input.roomId, input.ownerCapability, {}); return true;},
      readAttachments: async input => (await db.query(`select o.id as "operationId",p.id as "permitId",o.room_id as "roomId",p.room_epoch as "sessionId",
        p.control_revision::float as "controlRevision",o.document->>'submissionId' as "submissionId",p.document->>'sourceSha256' as "sourceSha256"
        from vdj_internal.generation_operations o join vdj_internal.generation_permits p on p.id=o.permit_id
        where o.room_id=$1 and o.document->>'submissionId'=any($2::text[])`, [input.roomId, input.submissionIds])).rows,
      readOperation: async input => {
        privilegedReads.push(input.operationId);
        const saved = (await db.query(`select o.room_id as "roomId",p.room_epoch as "sessionId",p.id as "permitId",p.control_revision::float as "controlRevision",
          p.revoked,extract(epoch from p.expires_at)*1000 as "expiresAtMs" from vdj_internal.generation_operations o
          join vdj_internal.generation_permits p on p.id=o.permit_id where o.id=$1 and o.room_id=$2`, [input.operationId, input.roomId])).rows[0];
        return {...saved, expiresAtMs: Number(saved.expiresAtMs), operation: await repository.request('read', input.roomId, OWNER, {operationId: input.operationId})};
      }, readPlaybackState: input => repository.request('cueState', input.roomId, OWNER, {}),
    });
    const sets = [first, second, third], ownerView = await roomProjection.readRoom({roomId: room.roomId, ownerCapability: OWNER});
    assert.equal(ownerView.submissions.length, 3); assert.equal(ownerView.currentCredit.participantId, guests[2].participantId);
    for (const [index, participant] of guests.entries()) {
      const set = sets[index], proof = {roomId: room.roomId, participantCapability: participant.capability};
      const ownRaw = await roomCall('read', participant.capability), ownFeed = await roomCall('events', participant.capability);
      assert.deepEqual(ownRaw.submissions.map(item => item.submissionId), [set.submission.submissionId]);
      assert.deepEqual(ownFeed.snapshot.submissions.map(item => item.submissionId), [set.submission.submissionId]);
      privilegedReads.length = 0; const own = await roomProjection.readRoom(proof);
      assert.deepEqual(own.submissions.map(item => item.submissionId), [set.submission.submissionId]);
      assert.equal(own.submissions[0].jobs[0].operationId, set.input.operationId);
      assert.ok(privilegedReads.length > 0 && privilegedReads.every(id => id === set.input.operationId), 'proof filters precede every privileged job lookup');
      const serialized = JSON.stringify(own);
      for (const other of guests.filter(other => other !== participant)) {
        assert.equal(serialized.includes(other.nickname), false); assert.equal(serialized.includes(other.prompt), false);
        assert.equal(serialized.includes(other.participantId), false);
      }
      for (const value of [OWNER, FOREIGN_OWNER, ...guests.map(item => item.capability), 'native_permit_', 'https:']) assert.equal(serialized.includes(value), false);
      assert.equal(own.currentCredit?.participantId ?? null, index === 2 ? participant.participantId : null);
      const readsBefore = privilegedReads.length, hidden = sets[(index + 1) % 3].submission.submissionId;
      await assert.rejects(roomProjection.readSubmission({...proof, submissionId: hidden}), /OPERATION_NOT_FOUND/);
      assert.equal(privilegedReads.length, readsBefore, 'cross-guest denial happens before private generation data is read');
    }
    const readsBeforeOwnerDenial = privilegedReads.length;
    for (const deniedCapability of [guests[0].capability, FOREIGN_OWNER]) await assert.rejects(roomProjection.readRoom({roomId: room.roomId, ownerCapability: deniedCapability}), /OWNER_DENIED/);
    assert.equal(privilegedReads.length, readsBeforeOwnerDenial);
    assert.equal(posts.length, 9, 'scope reads, wrong proofs and duplicate ACKs consume no additional generation');
    await pumpTo(96 * RATE); assert.equal(port.read().phase, 'STOPPED'); assert.equal(g.processor.consumed, 96 * RATE); assert.equal(g.processor.underruns, 0);
    assert.equal(port.readSourceState(), null, 'a stopped graph cannot serve an actual current-source projection');
    t.diagnostic(JSON.stringify({syntheticNativeQcSets: 3, syntheticParticipants: 3, acceptedCreditCounts: [1, 1, 1], providerNetworkRequests: 0, paidGenerations: 0,
      descriptorFrames: descriptors.map(d => ({startFrame: d.startFrame, durationFrames: d.durationFrames})),
      actualVmAckRevisions: [1, 2, 3], graphDurationFrames: engine.readState().finiteDurationFrames, cumulativeRenderInvented: false, realBrowser: false}));
  } finally {clearInterval(presentation);await port?.dispose(); await seed?.dispose(); await fixture?.cleanup(); await db.close();}
});
