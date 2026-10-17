// Offline native fixture for the actual owner host's AutoDJ pump.
// Every proof/provider response/media asset below is fabricated. Native QC is
// real, but VM processing and synthetic visual callbacks are not browser claims.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {waitForFixtureProgress} from './fixture-progress.mjs';
import {SyntheticVideo, waitForSyntheticVideoProgress} from './synthetic-video-clock.mjs';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createSyntheticCloudWorkerFixture} from './cloud-worker-fixture.mjs';
import {createCloudGenerationJobs} from '../cloud/jobs/generation-jobs.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import {createCueCoordinator} from '../cloud/generation/cue-coordinator.mjs';
import {createCueHandler} from '../cloud/generation/cue-http.mjs';
import {createTypedCloudHostComposition} from '../cloud/jobs/typed-host-composition.mjs';
import {createRecoveryCandidateReadPort} from '../cloud/jobs/recovery-candidates.mjs';
import {createCloudRecoveryRunner} from '../cloud/jobs/recovery-runner.mjs';
import {createCloudPlaybackAdapter, createCloudOwnerPlaybackController} from '../room-web/cloud-playback.mjs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {createAudioOutputLease} from '../room-web/playback/output-lease.mjs';
import {createVideoAdapter} from '../snapshot/ui/app/scene-video-adapter.mjs';
import {prepareCloudInitialAudio, createCloudSeedPlayback} from '../room-web/cloud-initial-audio.mjs';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {createDispatchAuthority} from '../cloud/jobs/dispatch-authority.mjs';
import {createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';
import {createSupabasePrivateStore} from '../cloud/worker/supabase-private-store.mjs';
import {syntheticStorageTransport} from './cloud-worker-store-fixture.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';

export const AUTO_DJ_RATE = 44100;
const RATE = AUTO_DJ_RATE, OWNER = 'a'.repeat(64), INVITE = 'c'.repeat(64), ORIGIN = 'https://ai-vdj.vercel.app';
const turn = () => new Promise(resolve => setImmediate(resolve));
const diagnosticCode = (value, fallback = 'UNCLASSIFIED_FIXTURE_REASON') => /^[A-Z][A-Z0-9_]{0,99}$/.test(value ?? '') ? value : fallback;
export async function autoDjUntil(fn, options = {}) {
  return waitForFixtureProgress({ready: fn, label: 'offline owner AutoDJ fixture', ...options});
}
async function createGraph() {
  let Processor, state = 'suspended', stops = 0; const listeners = new Set(), commands = [], observations = [];
  const sandbox = {Float32Array, ArrayBuffer, sampleRate: RATE, currentTime: 0,
    AudioWorkletProcessor: class {constructor() {this.port = {postMessage(data) {observations.push(data); for (const fn of listeners) fn({data});}};}},
    registerProcessor(name, ctor) {assert.equal(name, 'queue-audio'); Processor = ctor;}};
  vm.runInNewContext(await readFile(new URL('../snapshot/app/room-worklet.mjs', import.meta.url), 'utf8'), sandbox);
  const processor = new Processor(), output = [new Float32Array(128), new Float32Array(128)];
  return {processor, commands, observations, stops: () => stops,
    context: {sampleRate: RATE, get state() {return state;}, resume() {state = 'running'; return Promise.resolve();}},
    node: {port: {start() {}, addEventListener(type, fn) {listeners.add(fn);}, removeEventListener(type, fn) {listeners.delete(fn);}, postMessage(data) {commands.push(data); processor.message(data);}}},
    async stopAudio() {state = 'suspended'; stops++;},
    pump(blocks = 1) {for (let n = 0; n < blocks; n++) {output[0].fill(0); output[1].fill(0); processor.process([], [output]); sandbox.currentTime += 128 / RATE;}}};
}
function deterministicScheduler() {
  const pending = new Map(), scheduled = []; let next = 0;
  return {pending, scheduled, schedule(fn, ms) {const id = ++next; pending.set(id, fn); scheduled.push({id, ms}); return id;},
    cancel(id) {pending.delete(id);}, tick() {const entry = pending.entries().next().value; assert.ok(entry, 'a completed owner pump must schedule its next tick'); pending.delete(entry[0]); entry[1]();}};
}

export async function createOwnerAutoDjFixture() {
  const db = new PGlite(), operations = new Map(), videos = [], posts = [], actions = [], descriptors = [], ownerStates = [], authorityCalls = [], syntheticPreparationTimings = [], nativeInspectionTimings = [];
  const scheduler = deterministicScheduler(), guests = ['b', 'd', 'e'].map((value, index) => ({capability: value.repeat(64), nickname: `合成参加者${index + 1}`}));
  const recoveryRuns = [];
  let room, current, fixture, jobs, port, engine, seed, activeCommit, host, lostAck = false, commits = 0, privateStore, typedSourceHost,
    derivedSourcePorts, initialSourceAdapter, sourceReceiptAccepted = false, selectedGraph, sourceReceipt, sourceAck, seedFailureCode = null, sourceAckHttpCalls = 0;
  const close = async () => {await host?.dispose(); await port?.dispose(); await seed?.dispose(); await fixture?.cleanup(); typedSourceHost?.close(); privateStore?.close(); await db.close();};
  try {
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
    for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql']) await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
    const uid = '11111111-1111-4111-a111-111111111111'; await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
    const roomCall = async (action, capability, payload = {}, verified = null) => (await db.query('select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) r',
      [action, room?.roomId ?? null, capability, JSON.stringify(payload), verified])).rows[0].r;
    room = await roomCall('create', null, {ownerCapability: OWNER, joinCode: INVITE}, uid);
    for (const guest of guests) guest.participantId = (await roomCall('join', INVITE, {nickname: guest.nickname, participantCapability: guest.capability})).participantId;
    const repository = {request: async (action, id, capability, payload) => (await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) r',
      [action, id, capability, JSON.stringify(payload)])).rows[0].r};
    const objects = syntheticStorageTransport(); privateStore = createSupabasePrivateStore({enabled: true, roomId: room.roomId, transport: objects.transport});
    fixture = await createSyntheticCloudWorkerFixture({roomId: room.roomId, assetStore: privateStore.assetStore,
      readCurrent: async () => derivedSourcePorts ? derivedSourcePorts.readCurrentSource({roomId: room.roomId}) : sourceReceiptAccepted ? initialSourceAdapter.readInitialCurrentSource({roomId: room.roomId}) : current, readOperation: async input => operations.get(input.operationId),
      runtime: {python: process.env.VDJ_QC_PYTHON, ffmpeg: process.env.VDJ_QC_FFMPEG ?? 'ffmpeg', ffprobe: process.env.VDJ_QC_FFPROBE ?? 'ffprobe'}});
    current = structuredClone(fixture.source); current.playback.actual = false;
    const bootstrapSource = structuredClone(current);
    const existingReadPorts = createExistingCloudRepositoryReadPorts({query: (sql, values) => db.query(sql, values),
      hostGenerationRead: input => repository.request(input.action, input.roomId, OWNER, input.operationId ? {operationId: input.operationId} : {})});
    const dispatchAuthority = createDispatchAuthority({enabled: true, repository, mediaHost: 'synthetic.supabase.co',
      readScope: existingReadPorts.readScope, readPermitScope: existingReadPorts.readPermitScope,
      readCurrentSource: input => derivedSourcePorts ? derivedSourcePorts.readCurrentSource(input) : initialSourceAdapter.readInitialCurrentSource(input)});
    const authorityGuard = {assert: async input => {
      const started = performance.now(), entry = {phase: input.phase, operationId: input.operationId, startedAtMs: started}; authorityCalls.push(entry);
      try {return await dispatchAuthority.assert(input);} finally {entry.wallMs = Math.round((performance.now() - started) * 1000) / 1000;}
    }};
    const coordinator = createCueCoordinator({enabled: true, requireAuthority: true, authorityGuard, repository, inspectGeneration: async input => {
      const started = performance.now(); try {return await fixture.worker.inspectGeneration(input);} finally {nativeInspectionTimings.push(Math.round(performance.now() - started));}
    },
      readCurrent: fixture.worker.readCurrent, inspectJoin: fixture.worker.inspectJoin});
    const provider = {async submit({model}) {posts.push(model); return {request_id: 'autodj-fixture-' + posts.length};}, async status() {return {status: 'COMPLETED'};},
      async result({model}) {return {data: model === GENERATION_CONTRACT.intent ? {output: JSON.stringify({needsClarification: false, question: '', interpretation: '静かに光を広げる',
        direction: 'down', intensity: .5, visualOpenness: 'increase', musicDevelopment: 'Preserve pulse and reduce competing layers.', visualDevelopment: 'Open geometry and preserve detail.'}), usage: {cost: .001}} :
        model === GENERATION_CONTRACT.music ? {audio: {url: 'https://v3.fal.media/autodj-fixture.wav'}} : {video: {url: 'https://v3.fal.media/autodj-fixture.mp4'}}};}};
    jobs = createCloudGenerationJobs({enabled: true, requireAuthority: true, authorityGuard, repository, provider, mediaHost: 'synthetic.supabase.co', coordinator,
      credentialForOperation: async () => 'synthetic-only-credential', prepareMedia: async input => {
        operations.set(input.operationId, await fixture.projectOperation({...await repository.request('read', input.roomId, OWNER, {operationId: input.operationId}), roomId: input.roomId}));
      }});
    async function generate(index) {
      const started = performance.now();
      const operationId = 'autodj_operation_' + String(index).repeat(24), permitId = 'autodj_permit_' + String(index).repeat(24), guest = guests[index - 1];
      const submission = await roomCall('submit', guest.capability, {nonce: 'autodj_submission_' + String(index).repeat(24), prompt: `合成案${index}:静かな星空へ、光を広げて`});
      const now = Date.now(), source = structuredClone(current), permit = {permitId, kind: GENERATION_CONTRACT.version, counts: GENERATION_CONTRACT.counts, createdAtMs: now, expiresAtMs: now + 600000,
        maximumUsd: 1, source, sourceSha256: cueDigest(cueSourceIdentity(source)), visualPolicy: TECHNICAL_VISUAL_POLICY,
        quote: {verified: true, evidenceSha256: '1'.repeat(64), observedAtMs: now, maximumUsd: {intent: .01, music: .1, video: .5}},
        balance: {usd: 2, autoTopUp: false, observedAtMs: now}, assets: {context: {url: 'https://synthetic.supabase.co/private/context', private: true,
          checksumVerified: true, sha256: source.music.contextSha256, expiresAtMs: now + 660000, serverAudioQC: true, providerOriginVerified: true},
          reference: {url: 'https://synthetic.supabase.co/private/reference', private: true, checksumVerified: true, sha256: source.video.referenceSha256, expiresAtMs: now + 660000}}};
      await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
        select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`, [permitId, room.roomId, JSON.stringify(permit)]);
      const input = {roomId: room.roomId, operationId, ownerCapability: OWNER};
      await jobs.start({...input, permitId, submissionId: submission.submissionId});
      await jobs.advance(input); // Initial delivery, before a fabricated lost wake hint.
      const candidates = createRecoveryCandidateReadPort({enabled: true, query: (sql, values) => db.query(sql, values), readScope: existingReadPorts.readScope});
      const {roomId, sessionId, controlRevision} = await existingReadPorts.readScope({roomId: room.roomId});
      for (let n = 0; n < 2; n++) {
        const restarted = createCloudRecoveryRunner({enabled: true, candidates, jobs, authorityGuard, repository,
          readScope: existingReadPorts.readScope, withOwnerAuthorization: (scope, callback) => callback({...scope, ownerCapability: OWNER})});
        const result = await restarted.runOnce({roomId, sessionId, controlRevision});
        assert.equal(result.results.length, 1); assert.equal(result.results[0].operationId, operationId);
        assert.equal(result.results[0].attempted, true); assert.equal(result.results[0].reason, null); recoveryRuns.push(result);
      }
      assert.equal((await jobs.read(input)).state, 'READY');
      const cue = (await coordinator.execute({action: 'state', ...input})).cues.find(c => c.operationId === operationId);
      syntheticPreparationTimings.push({index, wallMs: Math.round(performance.now() - started)});
      return {input, cue, operation: operations.get(operationId), submission};
    }
    const graph = await createGraph(), lease = createAudioOutputLease({locks: {request: async (name, options, callback) => callback({name})}});
    port = createCloudPlaybackAdapter({enabled: true, fixtureMode: true, enableClipRelativeTimeline: true, origin: ORIGIN, lifecycle: {}, container: {append() {}}, outputLease: lease,
      urlAPI: {createObjectURL() {return 'blob:autodj-fixture';}, revokeObjectURL() {}}, resolveManifest: async payload => {
        const cue = activeCommit.cue, desc = await fixture.worker.describeRender({roomId: room.roomId, cue, plan: payload.plan, expectedRevision: activeCommit.expectedRevision}); descriptors.push(desc);
        const render = Object.fromEntries(['assetId', 'sha256', 'byteLength', 'mimeType', 'renderedFileSha256', 'renderedPcmSha256', 'sampleRate', 'startFrame', 'durationFrames', 'expectedPlayedWindowSha256'].map(k => [k, desc[k]]));
        render.timelineSpace = 'clip-relative-v1'; const op = operations.get(cue.operationId);
        return {roomId: room.roomId, cueId: cue.cueId, generationId: cue.generationId, submissionId: cue.submissionId, controlVersion: cue.controlVersion, commonIntentSha256: cue.commonIntentSha256,
          audio: {...cue.music.asset, render}, videos: await Promise.all(cue.video.clips.map(async clip => ({assetId: clip.assetId, sha256: clip.sha256,
            byteLength: (await fixture.store.read(clip.assetId)).byteLength, mimeType: 'video/mp4', source: 'provider-response-replay', requestId: op.stages.video.requestId})))};
      }, request: async path => {const record = await fixture.store.read(path.split('/media/')[1].split('?')[0]);
        return new Response(record.bytes, {headers: {'Content-Type': record.contentType, 'Content-Length': String(record.byteLength)}});},
      createAudioEngine: ({loadVerifiedRender, enableClipRelativeTimeline}) => engine = createWorkletPlaybackEngine({enableClipRelativeTimeline, context: graph.context, node: graph.node,
        allowInitialAudio: true, loadVerifiedRender, readSourceCount: () => 1, stopAudio: graph.stopAudio}),
      createVideoAdapter: input => createVideoAdapter({...input, crossfadeMs: 0, fetchImpl() {throw Error('network forbidden');}}),
      videoFactory: () => {const video = new SyntheticVideo(); video.cueId = activeCommit.cue.cueId; video.generationId = activeCommit.cue.generationId; videos.push(video); return video;}});
    const handler = createCueHandler({coordinator});
    const request = async (path, options) => {
      const action = path.split('/').at(-1); actions.push({action, body: structuredClone(options.body)});
      const response = await handler(new Request(ORIGIN + path, {...options, headers: new Headers({...Object.fromEntries(options.headers), 'Content-Type': 'application/json', Origin: ORIGIN}), body: JSON.stringify(options.body)}));
      const data = await response.json(); if (!response.ok) throw Error(data.error);
      if (action === 'ack' && options.body.ack.playbackRevision === 2 && !lostAck) {lostAck = true; throw Error('synthetic ACK reply lost after durable commit');}
      return data;
    };
    host = createCloudOwnerPlaybackController({outputPort: {...port,
      async stop(reason){await port.stop(reason);return {stopped:true,graphStopConfirmed:true};},
      commitPlayback(input) {activeCommit = input; commits++; return port.commitPlayback(input);}}, request,
      roomId: room.roomId, ownerCapability: OWNER, lifecycle: {}, schedule: scheduler.schedule, cancel: scheduler.cancel, onState: state => ownerStates.push(state)});
    async function startSource() {
      const {roomId, sessionId, controlRevision} = await sourceRepositoryPorts.readScope({roomId: room.roomId}), selectedAtMs = Date.now();
      selectedGraph = {roomId, sessionId, controlRevision, kind: 'selected-player-graph-v1', targetPlayerId: 'synthetic-output-graph-1', graphEpoch: 1,
        mode: 'initial', phase: 'SELECTED', freshGraph: true, sourceCount: engine.readState().sourceCount,
        receivedFramesBeforeStart: graph.processor.received, consumedFramesBeforeStart: graph.processor.consumed,
        selectedAtMs, expiresAtMs: selectedAtMs + 30000, finiteDurationFrames: 24 * RATE};
      const record = await fixture.store.read(current.audioAssetId), pcm = decodeCompleteWave(record.bytes).pcm;
      const plan = await prepareCloudInitialAudio({bytes: new Uint8Array(record.bytes), descriptor: {assetId: current.music.clipId, sha256: current.music.sha256,
        pcmSha256: await pcmSha256(pcm), byteLength: record.byteLength, mimeType: 'audio/wav'}, source: {actual: false, clipId: current.music.clipId,
        sha256: current.music.sha256, contextSha256: current.music.contextSha256, playbackRevision: 0, frameCount: 24 * RATE}, mode: 'bootstrap', graphEpoch: 1});
      seed = createCloudSeedPlayback({enabled: true, plan, audioEngine: engine, outputLease: lease, guard: async () => true, markSourceStarted: async ack => {
        sourceAck = structuredClone(ack);
        sourceReceipt = await initialSourceAdapter.markSourceStarted({roomId: room.roomId, ownerCapability: OWNER, ack});
        selectedGraph.phase = 'SOURCE_STARTED';
        current = await initialSourceAdapter.readInitialCurrentSource({roomId: room.roomId}); sourceReceiptAccepted = true;
        return sourceReceipt;}});
      const started = seed.start(); void started.catch(error => {seedFailureCode = diagnosticCode(error.code ?? error.message);});
      await waitForFixtureProgress({ready: () => graph.commands.some(command => command.type === 'play'), terminal: () => terminal(),
        describe: () => describe(0, 'SOURCE_QUEUE'), label: 'owner AutoDJ source queue'}); graph.pump(90); await started;
      await port.unlock(); seed.handoff(port);
    }
    // Production derivation/physical validation uses an entirely in-memory
    // immutable storage transport. Selected-player authority and fresh observer
    // transport are fixture ports, never claims of real browser authentication.
    const sourceRepositoryPorts = existingReadPorts;
    // Typed authorities describe the single fixture-selected graph and the
    // physically measured private bootstrap. They are not browser-chosen data.
    typedSourceHost = createTypedCloudHostComposition({enabled: true, roomId: room.roomId, privateStore,
      query: (sql, values) => db.query(sql, values),
      hostGenerationRead: input => repository.request(input.action, input.roomId, OWNER, input.operationId ? {operationId: input.operationId} : {}),
      authorizeOwner: async input => {await repository.request('cueState', input.roomId, input.ownerCapability, {}); return true;},
      authorities: {
      readStartAuthority: async scope => ({...scope, kind: 'server-selected-source-start-v1', mode: 'bootstrap', serverQC: true,
        qcEvidenceSha256: cueDigest(bootstrapSource.music.profile), sourceSha256: cueDigest(cueSourceIdentity(bootstrapSource)), source: structuredClone(bootstrapSource)}),
      readGraphAuthority: async () => structuredClone(selectedGraph),
      readSourceFrontier: async () => {
        const state = engine.readState(), window = graph.observations.find(event => event.playedWindow?.startFrame === 0)?.playedWindow;
        assert.ok(window, 'source-start frontier must contain the actually processed VM prefix window');
        const {roomId, sessionId, controlRevision} = selectedGraph;
        return {roomId, sessionId, controlRevision, kind: 'authenticated-source-frontier-v1', targetPlayerId: selectedGraph.targetPlayerId,
          graphEpoch: selectedGraph.graphEpoch, sourceClipId: bootstrapSource.music.clipId, sourceSha256: bootstrapSource.music.sha256,
          sourceContextSha256: bootstrapSource.music.contextSha256, sourcePlaybackRevision: bootstrapSource.playback.revision,
          processedWindowSha256: await pcmSha256(window.pcm), sampleRate: state.sampleRate, playedUntilFrame: state.consumedFrames,
          receivedFrames: state.receivedFrames, sourceCount: state.sourceCount, underrunFrames: state.underrunFrames,
          stopped: state.stopped === true || !graph.processor.playing, actual: state.contextState === 'running' && graph.processor.playing,
          audioStarted: state.consumedFrames >= 256, participantCredit: false, serverObservedAtMs: Date.now()};
      }, readSelectedTarget: async scope => {
        const credit = (await sourceRepositoryPorts.readPlaybackState(scope)).currentCredit;
        return {...scope, kind: 'selected-current-player-v1', targetPlayerId: 'synthetic-output-graph-1', cueId: credit.cueId,
          generationId: credit.generationId, playbackRevision: credit.playbackRevision, expiresAtMs: Date.now() + 10000};
      }, readCurrentFrontier: async input => {
        const observed = port.readSourceState(), window = graph.observations.find(event => event.playedWindow?.startFrame === observed?.originFrame)?.playedWindow;
        const currentVideo = videos.find(video => video.cueId === input.cueId && !video.paused && !video.removed && video.presentedWhilePlaying > 0);
        assert.ok(observed?.actual && window && currentVideo, 'fixture current frontier needs its processed PCM and still-playing presented video');
        return {...input, cueId: currentVideo.cueId, generationId: currentVideo.generationId, kind: 'authenticated-player-frontier-v1', actual: observed.actual, audioStarted: true, videoPresented: true,
          assetId: observed.clipId, sha256: observed.sha256, playbackRevision: observed.playbackRevision,
          playedUntilFrame: observed.playedFrames, observedAtMs: Date.now(), observationSha256: cueDigest({source: observed, processedWindowSha256: await pcmSha256(window.pcm)})};
      }}});
    initialSourceAdapter = {readInitialCurrentSource: typedSourceHost.readCurrentSource,
      markSourceStarted: async input => {
        sourceAckHttpCalls++;
        const response = await typedSourceHost.handleRequest(new Request(ORIGIN + `/api/rooms/${input.roomId}/source/ack`, {
          method: 'POST', headers: {'Content-Type': 'application/json', Origin: ORIGIN, 'X-Room-Owner': input.ownerCapability},
          body: JSON.stringify({ack: input.ack})}));
        const result = await response.json(); if (!response.ok) throw Error(result.error); return result;
      }};
    async function promote(set, revision) {
      const credit = (await coordinator.execute({action: 'state', ...set.input})).currentCredit;
      assert.equal(credit.cueId, set.cue.cueId); assert.equal(credit.playbackRevision, revision); assert.equal(credit.actual, true);
      const prepared = await typedSourceHost.prepareCurrentSource({roomId: room.roomId});
      // sessionId is only the synthetic room epoch, never a login session.
      const {roomId, sessionId, controlRevision} = await sourceRepositoryPorts.readScope({roomId: room.roomId});
      const saved = await typedSourceHost.readSourceRecord({roomId, sessionId, controlRevision});
      assert.equal(saved.source.playback.actual, false); assert.equal(saved.source.playback.playedUntilFrame, 0);
      assert.equal(saved.source.playback.revision, 0); assert.equal(saved.source.playback.phase, 'IDLE');
      assert.equal(prepared.playbackRevision, revision);
      current = await typedSourceHost.readCurrentSource({roomId: room.roomId}); derivedSourcePorts = typedSourceHost;
      assert.equal(current.music.clipId, set.cue.music.asset.assetId); assert.equal(current.music.sha256, set.cue.music.asset.sha256);
      assert.equal(current.playback.actual, true); assert.equal(current.playback.revision, revision); assert.ok(current.playback.playedUntilFrame >= 256);
    }
    function terminal({allowFiniteEnd = false, targetFrame} = {}) {
      if (seedFailureCode) return {code: seedFailureCode};
      const output = port.read(), owner = ownerStates.at(-1);
      if (['HOLD', 'STOPPED'].includes(owner?.state)) return {code: diagnosticCode(owner.reason, `OWNER_${owner.state}`)};
      if (['HOLD', 'STOPPED', 'GESTURE_REQUIRED'].includes(output.phase)) {
        if (allowFiniteEnd && output.phase === 'STOPPED' && output.reason === 'CUE_DURATION_END' && graph.processor.consumed === targetFrame) return null;
        return {code: diagnosticCode(output.reason, `OUTPUT_${output.phase}`)};
      }
      return null;
    }
    function timingSummary() {
      const phaseTiming = Object.fromEntries([...new Set(authorityCalls.map(call => call.phase))].sort().map(phase => {
        const calls = authorityCalls.filter(call => call.phase === phase), values = calls.map(call => call.wallMs).filter(Number.isFinite);
        return [phase, {checks: calls.length, completed: values.length, totalWallMs: Math.round(values.reduce((sum, value) => sum + value, 0)),
          maxWallMs: values.length ? Math.round(Math.max(...values)) : null}];
      }));
      return {timingScope: 'synthetic-QC-and-authority-processing-zero-provider-network', realModelSpeedMeasured: false,
        guardedAuthorityChecks: authorityCalls.length, phaseTiming, syntheticPreparationTimings: structuredClone(syntheticPreparationTimings),
        nativeInspectionWallMs: [...nativeInspectionTimings], phaseWallTotalsMayOverlap: true};
    }
    function describe(index, stage, targetFrame = null) {
      const output = port.read(), owner = ownerStates.at(-1), state = engine.readState(), currentAuthority = authorityCalls.at(-1);
      const count = values => Object.fromEntries([...new Set(values)].map(value => [value, values.filter(item => item === value).length]));
      return {index, stage, targetFrame,
        owner: owner ? {state: owner.state, reason: owner.reason ? diagnosticCode(owner.reason) : null, creditRevision: owner.currentCredit?.playbackRevision ?? null} : null,
        output: {phase: output.phase, reason: output.reason ? diagnosticCode(output.reason) : null, playbackRevision: output.playbackRevision,
          pendingRevision: output.pendingRevision, audioStarted: output.audioStarted, videoPresented: output.videoPresented, sourceCount: output.sourceCount},
        actions: actions.map(item => item.action), actionCounts: count(actions.map(item => item.action)),
        engine: {contextState: state.contextState, sampleRate: state.sampleRate, consumedFrames: state.consumedFrames, receivedFrames: state.receivedFrames,
          finiteDurationFrames: state.finiteDurationFrames, underrunFrames: state.underrunFrames, stopped: state.stopped ?? false, sourceCount: state.sourceCount},
        processor: {consumedFrames: graph.processor.consumed, receivedFrames: graph.processor.received, queuedFrames: graph.processor.queued,
          durationFrames: graph.processor.duration, underrunFrames: graph.processor.underruns, playing: graph.processor.playing},
        commands: count(graph.commands.map(command => command.type)), processedWindows: graph.observations.filter(event => event.playedWindow).map(event => event.playedWindow.startFrame),
        scheduledPending: scheduler.pending.size, scheduledTotal: scheduler.scheduled.length, commitAttempts: commits, acknowledgedOwnerCues: ownerStates.filter(value => value.state === 'PLAYING').length,
        currentAuthority: currentAuthority ? {phase: currentAuthority.phase, completed: Number.isFinite(currentAuthority.wallMs),
          wallMs: Math.round(currentAuthority.wallMs ?? performance.now() - currentAuthority.startedAtMs)} : null};
    }
    async function wait(ready, {index, stage, targetFrame = null, allowFiniteEnd = false} = {}) {
      return waitForSyntheticVideoProgress({videos, ready, terminal: () => terminal({allowFiniteEnd, targetFrame}),
        describe: () => describe(index, stage, targetFrame), label: `owner AutoDJ ${stage} index ${index}`});
    }
    async function pumpTo(frame, {index = activeCommit?.expectedRevision ?? 0, allowFiniteEnd = false} = {}) {
      const check = () => wait(() => true, {index, stage: 'PCM_PUMP', targetFrame: frame, allowFiniteEnd});
      await check();
      while (graph.processor.consumed < frame) {
        await check(); graph.pump(Math.min(64, Math.ceil((frame - graph.processor.consumed) / 128)));
        for (let n = 0; n < 4; n++) await turn(); videos.forEach(video => video.present()); await check();
      }
      for (let n = 0; n < 10; n++) {await turn(); videos.forEach(video => video.present()); await check();}
    }
    return {host, port, graph, scheduler, guests, ownerStates, posts, actions, descriptors, authorityCalls, syntheticPreparationTimings, nativeInspectionTimings,
      recoveryRuns, sourceAckHttpCalls: () => sourceAckHttpCalls, generate, startSource, promote, pumpTo, wait, describe, timingSummary,
      commits: () => commits, lostAck: () => lostAck,
      sourceReceipt: () => structuredClone(sourceReceipt), sourceStartObjectCount: () => [...objects.objects.keys()].filter(path => path.includes('/source-start-receipts/')).length,
      readStoredSourceReceipt: async () => {const {roomId, sessionId, controlRevision, targetPlayerId, graphEpoch} = selectedGraph; return privateStore.sourceStartReceiptStore.read({roomId, sessionId, controlRevision, targetPlayerId, graphEpoch});},
      retrySourceAck: () => initialSourceAdapter.markSourceStarted({roomId: room.roomId, ownerCapability: OWNER, ack: sourceAck}),
      deniedSourceAck: () => initialSourceAdapter.markSourceStarted({roomId: room.roomId, ownerCapability: guests[0].capability, ack: sourceAck}),
      readState: () => coordinator.execute({action: 'state', roomId: room.roomId, ownerCapability: OWNER}), close};
  } catch (error) {await close(); throw error;}
}
