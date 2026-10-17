import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createPlayerObserverStore} from '../cloud/jobs/player-observer-store.mjs';
import {createPlayerObserverRegistry} from '../cloud/jobs/player-observer-registry.mjs';
import {createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';
import {mountCloudOwnerControls} from '../room-web/cloud-owner-controls.mjs';
import {createOwnerCueHost} from '../room-web/owner-cue-host.mjs';

// Production 2026-10-17 17:04 JST: source -> Cue A succeeded (ACK 17:05:09).
// The B reservation started at 17:05:11 and finished at 17:05:40 with
// OBSERVER_STOPPED: an owner cueStop (17:05:33) arrived while it ran. Offline
// only: the existing SQL in PGlite, synthetic PCM and in-memory owner auth.
const owner = 'a'.repeat(64), hash = n => n.repeat(64), RATE = 44100;
const CUES = {
  a: {operationId: 'synthetic-cue-a-operation-0001', cueId: 'cue-a', generationId: 'generation-a', assetId: 'generated-a', sha256: hash('f'), video: hash('1')},
  b: {operationId: 'synthetic-cue-b-operation-0001', cueId: 'cue-b', generationId: 'generation-b', assetId: 'generated-b', sha256: hash('9'), video: hash('2')},
};

async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql', 'cloud/jobs/player-observer-state.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  const uid = '11111111-1111-4111-a111-111111111111';
  await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
  const room = (await db.query("select public.vdj_room_request('create',null,null,$1::jsonb,$2) value",
    [JSON.stringify({ownerCapability: owner, joinCode: hash('c')}), uid])).rows[0].value;
  const generation = async (op, payload = {}) => (await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
    [op, room.roomId, owner, JSON.stringify(payload)])).rows[0].value;
  let now = Date.now();
  let material = {binding: {kind: 'source', assetId: 'bootstrap', sha256: hash('d'), contextSha256: hash('e'), playbackRevision: 0},
    pcm: Float32Array.from({length: 24 * RATE * 2}, (_, i) => Math.sin(i * .01) * .1), originFrame: 0, queuedFrames: 24 * RATE, maximumDurationFrames: 24 * RATE};
  const ports = createExistingCloudRepositoryReadPorts({query: (sql, values) => db.query(sql, values),
    hostGenerationRead: async () => generation('cueState'), now: () => now});
  const scope = await ports.readScope({roomId: room.roomId});
  const scoped = {roomId: scope.roomId, ['sessionId']: scope.sessionId, controlRevision: scope.controlRevision};
  // Same shape as production: one anchor row carries roomRuntime; each Cue has its own operation.
  const permit = id => db.query('insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document) values($1,$2,$3,$4,to_timestamp($5::double precision/1000),$6::jsonb)',
    [id, scope.roomId, scope.sessionId, scope.controlRevision, scope.expiresAtMs, '{}']);
  await permit('synthetic-anchor-permit-0001');
  await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
    ['synthetic-anchor-operation-0001', 'synthetic-anchor-permit-0001', scope.roomId,
      JSON.stringify({roomRuntime: {currentCredit: null, stopped: false, acks: [], servedCounts: {}}})]);
  for (const [key, cue] of Object.entries(CUES)) {
    await permit('synthetic-cue-' + key + '-permit-0001');
    await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
      [cue.operationId, 'synthetic-cue-' + key + '-permit-0001', scope.roomId, JSON.stringify({stopped: false, cue: {
        cueId: cue.cueId, generationId: cue.generationId, status: 'READY', music: {asset: {assetId: cue.assetId, sha256: cue.sha256}},
        contribution: {participantId: 'participant-' + key, nickname: 'guest-' + key, submissionId: 'submission-' + key}}})]);
  }
  const store = createPlayerObserverStore({query: (sql, values) => db.query(sql, values),
    withOwnerAuthorization: async (s, call) => call({...s, ownerCapability: owner})});
  let targets = 0;
  const registry = createPlayerObserverRegistry({enabled: true, roomId: room.roomId, origin: 'https://vdj.example', store,
    now: () => now, mintTarget: () => 'server-target-' + (++targets), showMode: true, maximumAgeMs: 30000,
    readScope: ports.readScope, readPlaybackState: async () => generation('cueState'),
    authorizeOwner: async ({ownerCapability}) => ownerCapability === owner, readVerifiedMaterial: async () => material});
  const observation = (graph, {sequence = 1, consumedFrames = 512, start = 0} = {}) => ({targetPlayerId: graph.targetPlayerId,
    graphEpoch: graph.graphEpoch, sequence, binding: {...material.binding}, sampleRate: RATE, sourceCount: 1, contextState: 'running',
    consumedFrames, receivedFrames: material.queuedFrames, underrunFrames: 0, stopped: false, windowStartFrame: start,
    windowPCM: Array.from(material.pcm.subarray(start * 2, (start + 256) * 2)), video: null});
  // The coordinator's reserve plan and the output's AV ACK, as the SQL checks them.
  const reserve = (key, currentRevision) => generation('cueReserve', {operationId: CUES[key].operationId,
    reservationId: 'reservation-' + key + '-' + 'r'.repeat(20),
    plan: {status: 'ELIGIBLE', liveReady: true, cueId: CUES[key].cueId, incomingSha256: CUES[key].sha256},
    expectedRevision: currentRevision + 1, current: {actual: true, playbackRevision: currentRevision}, expiresAtMs: Date.now() + 30000});
  const ack = (key, reservation) => generation('cueAck', {reservationId: reservation.reservationId, ackSha256: hash(key === 'a' ? '3' : '4'),
    ack: {roomId: room.roomId, cueId: CUES[key].cueId, clipId: CUES[key].assetId, playbackRevision: reservation.expectedRevision,
      actual: true, audioStarted: true, videoPresented: true, audioTime: 0.05}});
  // After the AV ACK the output's sole graph sounds the credited Cue (CURRENT binding).
  const bindCurrent = (key, revision) => { const cue = CUES[key];
    material = {...material, binding: {kind: 'current', assetId: cue.assetId, sha256: cue.sha256, contextSha256: hash('e'),
      playbackRevision: revision, cueId: cue.cueId, generationId: cue.generationId}, videoAssets: [{assetId: 'video-' + key, sha256: cue.video}]}; };
  return {db, registry, scoped, generation, observation, reserve, ack, bindCurrent, advance: ms => { now += ms; }};
}

async function playSourceThenA(x) {
  const graph = await x.registry.register({sampleRate: RATE, sourceCount: 1, consumedFrames: 0, receivedFrames: 0, contextState: 'running'});
  await x.registry.observe(x.observation(graph));
  const reservation = await x.reserve('a', 0);
  const accepted = await x.ack('a', reservation);
  assert.equal(accepted.accepted, true);
  x.bindCurrent('a', 1);
  return graph;
}

test('show mode: B can be planned 2s after A is acknowledged when nothing stopped the room', async t => {
  const x = await fixture(t);
  await playSourceThenA(x);
  x.advance(2000);
  const state = await x.generation('cueState');
  assert.equal(state.stopped, false);
  assert.equal(state.currentCredit.cueId, 'cue-a');
  // The B reservation's readCurrent path: the selected CURRENT target from the observer.
  const target = await x.registry.readSelectedTarget(x.scoped);
  assert.equal(target.cueId, 'cue-a');
  assert.equal(target.playbackRevision, 1);
  const reservationB = await x.reserve('b', 1);
  assert.equal(reservationB.expectedRevision, 2);
});

test('show mode: a cueStop between A ACK and the B reservation yields exactly the production OBSERVER_STOPPED', async t => {
  const x = await fixture(t);
  await playSourceThenA(x);
  x.advance(1000);
  const stopped = await x.generation('cueStop');
  assert.equal(stopped.stopped, true);
  // The DB then matches the production read-back: stopped=true, no credit/pending, A back to READY.
  const state = await x.generation('cueState');
  assert.equal(state.currentCredit, null);
  assert.equal(state.pending, false);
  assert.deepEqual(state.cues.map(c => [c.cueId, c.status, c.playbackRevision ?? null]).sort(),
    [['cue-a', 'READY', 1], ['cue-b', 'READY', null]]);
  x.advance(1000);
  await assert.rejects(x.registry.readSelectedTarget(x.scoped), {code: 'OBSERVER_STOPPED'});
  await assert.rejects(x.reserve('b', 1), /PLAYBACK_STOPPED/);
});

// lifecycle.json: A ended (CUE_DURATION_END) at 17:05:33 while the slow B
// reservation still ran; the output reported STOPPED and the owner controls
// turned that into a room-wide cueStop. A finite Cue's natural end now leaves
// the room and its credits alone; the owner restarts with Stop -> Start.
function ownerControls() {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const roomId = '22222222-2222-4222-a222-222222222222', paths = [], stopReasons = [];
  let reserves = 0, output = {phase: 'IDLE', activationEnabled: true}, onOutput;
  const request = async path => {
    const action = path.split('/').pop(); paths.push(action);
    if (action === 'start') return {stopped: false, currentCredit: null};
    if (action === 'reserve') return ++reserves === 1
      ? {reservationId: 'reservation-a-' + 'r'.repeat(20), roomId, cue: {cueId: 'cue-a'}, plan: {cueId: 'cue-a'}, expectedRevision: 1, expiresAtMs: Date.now() + 30000}
      : {state: 'HOLD', reason: 'WAITING_FOR_PLAYBACK_OBSERVATION'};
    if (action === 'ack') return {accepted: true, currentCredit: {cueId: 'cue-a', playbackRevision: 1, actual: true}};
    if (action === 'stop') return {stopped: true, currentCredit: null};
    throw Error('UNEXPECTED_' + action);
  };
  const fields = Object.fromEntries(['cloud-open-output', 'cloud-start', 'cloud-stop', 'cloud-status'].map(id => [id, {disabled: false, textContent: ''}]));
  const port = {role: 'output', read: () => output, dispose: async () => {}};
  const ui = mountCloudOwnerControls({root: {querySelector: s => fields[s.slice(1)]},
    capabilities: {generation: true, autoDJ: true, cloud: {generationJobs: true, portableQC: true, browserPlayback: true}},
    openOutput: ({onState}) => { onOutput = onState; return port; },
    createController: ({onState}) => createOwnerCueHost({request, roomId, ownerCapability: 'a'.repeat(64), lifecycle: null, onState,
      intervalMs: 60000, commitPlayback: async () => ({actual: true}), stopPlayback: async reason => { stopReasons.push(reason);return {stopped:true,graphStopConfirmed:true}; }})});
  const report = (phase, extra = {}) => { output = {...output, phase, ...extra}; onOutput?.(output); };
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  return {fields, ui, paths, stopReasons, report, settle, async playA() {
    fields['cloud-open-output'].onclick(); await tick();
    report('READY'); fields['cloud-start'].onclick(); await settle();
    assert.deepEqual(paths.slice(0, 3), ['start', 'reserve', 'ack'], 'source -> A reserved and acknowledged');
    report('PLAYING'); await settle();
  }};
}

test('a Cue that plays to its end (CUE_DURATION_END) does not stop the room; the owner restarts with Stop', async () => {
  const x = ownerControls(); await x.playA();
  x.report('STOPPED', {reason: 'CUE_DURATION_END'}); await x.settle();
  assert.equal(x.paths.includes('stop'), false, 'no server cueStop for a natural end');
  assert.deepEqual(x.stopReasons, []);
  assert.match(x.fields['cloud-status'].textContent, /最後まで再生/);
  assert.match(x.fields['cloud-status'].textContent, /演奏停止/);
  assert.equal(x.fields['cloud-stop'].disabled, false, 'the owner can still stop and restart');
  const reservesBefore = x.paths.filter(p => p === 'reserve').length;
  await x.settle(); assert.equal(x.paths.filter(p => p === 'reserve').length, reservesBefore, 'no further reservations for an ended graph');
  x.fields['cloud-stop'].onclick(); await x.settle();
  assert.deepEqual(x.stopReasons, ['OWNER_STOP']); assert.equal(x.paths.at(-1), 'stop');
  await x.ui.dispose();
});

test('an output HOLD or a closed output still stops the room as before', async () => {
  for (const [phase, reason] of [['HOLD', 'ACTUAL_AUDIO_CLOCK_REQUIRED'], ['STOPPED', 'OUTPUT_CLOSED']]) {
    const x = ownerControls(); await x.playA();
    x.report(phase, {reason}); await x.settle();
    assert.deepEqual(x.stopReasons, ['OUTPUT_STOP']); assert.equal(x.paths.at(-1), 'stop');
    await x.ui.dispose();
  }
});
