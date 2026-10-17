import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {syntheticWave} from './cloud-worker-fixture.mjs';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';
import {decodeCloudRender} from '../room-web/cloud-playback-media.mjs';
import {prepareCloudInitialAudio, createCloudSeedPlayback} from '../room-web/cloud-initial-audio.mjs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {createAudioOutputLease} from '../room-web/playback/output-lease.mjs';
import {createBrowserCommitPlayback} from '../room-web/playback/commit-playback.mjs';
import {createVideoAdapter} from '../snapshot/ui/app/scene-video-adapter.mjs';
import {waitForFixtureProgress} from './fixture-progress.mjs';
import {createCloudCreditOverlay, projectCloudPlaybackCredit} from '../room-web/cloud-output-credit.mjs';
import {createOwnerCueHost} from '../room-web/owner-cue-host.mjs';

// Synthetic PCM, injected visual callbacks and the repository processor in a VM.
// This is deterministic software-clock coverage, not browser/hardware evidence.
const RATE = 44100, HASH = 'a'.repeat(64), ROOM = '11111111-1111-4111-8111-111111111111';
const source = await readFile(new URL('../snapshot/app/room-worklet.mjs', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(fn, label = 'synthetic longrun state', diagnostic = () => ({}), terminal = () => null) {
  await waitForFixtureProgress({ready: fn, label, describe: diagnostic, terminal, timeoutMs: 5000});
}
function graph() {
  let Processor, contextState = 'suspended', stops = 0, resumes = 0;
  const listeners = new Set(), commands = [], observations = [];
  const sandbox = {Float32Array, ArrayBuffer, sampleRate: RATE, currentTime: 0,
    AudioWorkletProcessor: class {constructor() {this.port = {postMessage(data) {
      observations.push(data); for (const fn of listeners) fn({data});
    }};}}, registerProcessor(name, ctor) {assert.equal(name, 'queue-audio'); Processor = ctor;}};
  vm.runInNewContext(source, sandbox); const processor = new Processor();
  const port = {start() {}, addEventListener(type, fn) {listeners.add(fn);}, removeEventListener(type, fn) {listeners.delete(fn);},
    postMessage(data) {commands.push(data); processor.message(data);}};
  const context = {sampleRate: RATE, get state() {return contextState;}, resume() {resumes++; contextState = 'running'; return Promise.resolve();}};
  const engine = createWorkletPlaybackEngine({context, node: {port}, allowInitialAudio: true, readSourceCount: () => 1,
    loadVerifiedRender: async input => input.fixtureRender,
    stopAudio: async () => {stops++; contextState = 'suspended';}});
  const output = [new Float32Array(128), new Float32Array(128)];
  function pump(blocks = 1) {for (let n = 0; n < blocks; n++) {output[0].fill(0); output[1].fill(0); processor.process([], [output]); sandbox.currentTime += 128 / RATE;}}
  return {engine, processor, commands, observations, pump, output, stops: () => stops, resumes: () => resumes};
}
class SyntheticVideo {
  constructor() {this.style = {}; this.videoWidth = 320; this.videoHeight = 180; this.readyState = 3; this.currentTime = 0;
    this.events = new Map(); this.frames = new Map(); this.attributes = {}; this.nextFrame = 0;}
  get currentSrc(){return this.src;}
  setAttribute(k, v) {this.attributes[k] = v;}
  getAttribute(k) {return this.attributes[k];}
  removeAttribute(k) {delete this.attributes[k]; if (k === 'src') delete this.src;}
  addEventListener(k, fn) {const events = this.events.get(k) ?? new Set(); events.add(fn); this.events.set(k, events);}
  removeEventListener(k, fn) {this.events.get(k)?.delete(fn);}
  requestVideoFrameCallback(fn) {const id = ++this.nextFrame; this.frames.set(id, fn); return id;}
  cancelVideoFrameCallback(id) {this.frames.delete(id);}
  present() {for (const [id, fn] of this.frames) {this.frames.delete(id); fn(0, {presentedFrames: 1});}}
  load() {} pause() {this.paused = true;} remove() {this.removed = true;} play() {this.paused = false; this.plays = (this.plays ?? 0) + 1; return Promise.resolve();}
}
function cue(revision) {
  const c = {roomId: ROOM, cueId: `cue-${revision}`, generationId: `generation-${revision}`, submissionId: `submission-${revision}`,
    commonIntentSha256: HASH, controlVersion: 1, atomicReady: true, status: 'READY'};
  for (const channel of ['music', 'video']) c[channel] = {status: 'QC_READY', qc: {passed: true}, durationSeconds: 24,
    asset: {assetId: `${channel}-${revision}`, sha256: HASH}, binding: {roomId: ROOM, generationId: c.generationId,
      submissionId: c.submissionId, commonIntentSha256: HASH, controlVersion: 1, channel}};
  c.video.review = {accepted: true, ownerArtisticApproval: true, assetSha256: HASH, commonIntentSha256: HASH};
  c.video.compositionQC = {passed: true}; c.video.clips = [{assetId: `clip-${revision}`, sha256: HASH, durationSeconds: 24}];
  c.video.timeline = {durationSeconds: 24, timeStretch: false, segments: [{assetId: `clip-${revision}`, sha256: HASH,
    startSeconds: 0, endSeconds: 24, sourceInSeconds: 0, sourceOutSeconds: 24, playbackRate: 1}]};
  return c;
}
async function seedInput(epoch = 1) {
  const bytes = new Uint8Array(syntheticWave(24)), sha256 = await pcmSha256(bytes);
  const pcm = decodeCloudRender(bytes, {mimeType: 'audio/wav', durationFrames: 24 * RATE});
  return {bytes, descriptor: {assetId: 'seed-fixture', sha256, pcmSha256: await pcmSha256(pcm), byteLength: bytes.length, mimeType: 'audio/wav'},
    source: {actual: false, clipId: 'seed-fixture', sha256, contextSha256: HASH, playbackRevision: 0, frameCount: 24 * RATE},
    firstPlan: {status: 'ELIGIBLE', currentClipId: 'seed-fixture', currentSha256: sha256, currentContextSha256: HASH,
      currentPlaybackRevision: 0, planSha256: HASH, transition: {editStartFrame: 24 * RATE - 442,
        exitFrame: 24 * RATE, entryFrame: 0, renderedSha256: HASH}}, graphEpoch: epoch,
    mode: epoch === 1 ? 'initial' : 'restart', previousGraphStopped: epoch > 1};
}
async function fixture(t) {
  let currentGraph = graph(), sourceMarks = 0; const videos = [], media = new Map();
  const lease = createAudioOutputLease({locks: {request: async (name, options, callback) => callback({name})}});
  const port = createBrowserCommitPlayback({audioEngine: currentGraph.engine, outputLease: lease, lifecycle: {},
    resolveMedia: async input => media.get(input.cue.cueId),
    createVideoAdapter: input => createVideoAdapter({...input, crossfadeMs: 0, fetchImpl() {throw Error('network forbidden');}}),
    videoFactory: () => {const element = new SyntheticVideo(); videos.push(element); return element;}, container: {append() {}}, ackTimeoutMs: 2000});
  const seeds = [];
  async function prime(epoch = 1) {
    const plan = await prepareCloudInitialAudio(await seedInput(epoch));
    const seed = createCloudSeedPlayback({enabled: true, plan, audioEngine: currentGraph.engine, outputLease: lease, guard: async () => true,
      markSourceStarted: async ack => {sourceMarks++; return {accepted: true, graphEpoch: ack.graphEpoch, sourceSha256: ack.sourceSha256,
        sourcePlaybackRevision: ack.sourcePlaybackRevision};}});
    seeds.push(seed); const promise = seed.start(); let sourceError; void promise.catch(error => {sourceError = error;});
    await until(() => currentGraph.commands.some(c => c.type === 'play'), 'source play command',
      () => ({source: seed.read(), engine: currentGraph.engine.readState(), commands: currentGraph.commands.map(c => c.type), terminalCode: sourceError?.message ?? null}),
      () => sourceError ? {code: sourceError.message} : null);
    currentGraph.pump(90); const ack = await promise; assert.equal(ack.participantCredit, false);
    await port.unlock(); seed.handoff({role: 'output', read: port.read}); return plan;
  }
  async function input(revision, pcmPrefix) {
    const c = cue(revision), startFrame = revision * 24 * RATE, durationFrames = startFrame + 24 * RATE;
    const pcm = new Float32Array(durationFrames * 2); if (pcmPrefix) pcm.set(pcmPrefix);
    pcm.fill(.07 + revision * .01, startFrame * 2);
    const render = {pcm, sampleRate: RATE, startFrame, durationFrames,
      expectedPlayedWindowSha256: await pcmSha256(pcm.subarray(startFrame * 2, (startFrame + 256) * 2))};
    media.set(c.cueId, {audio: {assetId: c.music.asset.assetId, sha256: HASH, renderedPcmSha256: await pcmSha256(pcm)},
      videos: [{assetId: `clip-${revision}`, sha256: HASH, url: 'blob:synthetic-longrun', source: 'local-edit', requestId: `synthetic-${revision}`}], release() {}});
    return {roomId: ROOM, cue: c, expectedRevision: revision, fixtureRender: render, guard: async () => true,
      plan: {cueId: c.cueId, transition: {exitFrame: startFrame, entryFrame: 0,
        editStartFrame: startFrame - 442, renderedSha256: HASH}}};
  }
  async function pumpTo(frame, present = true) {
    while (currentGraph.processor.consumed < frame && !['HOLD', 'STOPPED'].includes(port.read().phase)) {
      currentGraph.pump(Math.min(64, Math.ceil((frame - currentGraph.processor.consumed) / 128)));
      for (let i = 0; i < 3; i++) await turn();
      if (present) videos.forEach(v => v.present());
    }
    const trace = currentGraph.commands.findLast(c => c.type === 'trace-frame');
    const revision = port.read().pendingRevision;
    if (trace && frame >= trace.frame + 256) {
      // A played-window message still requires its asynchronous SHA and serial
      // observer before audioStarted/AVACK. Elapsed VM time or a fixed number
      // of immediate turns cannot stand in for that state transition.
      await until(() => {
        if (present) videos.forEach(v => v.present());
        const state = port.read();
        return ['HOLD', 'STOPPED'].includes(state.phase) || state.audioStarted &&
          (!present || state.videoPresented && state.playbackRevision === revision);
      }, `processed audio${present ? ' + visual ACK' : ''} at frame ${frame}`);
    }

  }
  function deliveries() {return currentGraph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length;}
  async function waitForQueue(expected, pending, label = 'cue queue') {
    let settled; void pending.then(result => {settled = result;}, error => {settled = {error};});
    const describe = () => ({playback: port.read(), engine: currentGraph.engine.readState(),
      consumedFrames: currentGraph.processor.consumed, receivedFrames: currentGraph.processor.received,
      deliveries: deliveries(), expectedDeliveries: expected,
      terminalCode: settled?.error?.message ?? (settled?.ack ? 'ACK' : null)});
    await until(() => deliveries() === expected, label, describe, () => {
      if (settled?.error) return {code: settled.error.message};
      const state = port.read();
      if (['HOLD', 'STOPPED', 'GESTURE_REQUIRED'].includes(state.phase)) return {code: state.reason ?? state.phase};
      if (settled?.ack && deliveries() !== expected) return {code: 'ACK_WITHOUT_EXPECTED_QUEUE'};
      return null;
    });
  }
  t.after(async () => {await port.dispose(); for (const seed of seeds) await seed.dispose();});
  return {port, prime, input, pumpTo, waitForQueue, videos, sourceMarks: () => sourceMarks, get graph() {return currentGraph;},
    async restart() {await port.stop(); const previous = currentGraph; currentGraph = graph(); await port.reopen(currentGraph.engine); return previous;}};
}

async function startFirst(h) {
  const plan = await h.prime(), input = await h.input(1, plan.pcm);
  const outcome = h.port.commitPlayback(input).then(ack => ({ack}), error => ({error}));
  await h.waitForQueue(2, outcome, 'first cue queue');
  return {input, outcome};
}

test('seed→24s tail uses one real processor, actual PCM+video ACK and exactly one nickname credit; lost ACK retry cannot replay', async t => {
  const h = await fixture(t), {input, outcome} = await startFirst(h);
  assert.equal(h.port.read().playbackRevision, 0); assert.equal(h.sourceMarks(), 1);
  await h.pumpTo(24 * RATE + RATE / 2); const {ack} = await outcome;
  assert.equal(ack.actual, true); assert.equal(ack.audioStarted, true); assert.equal(ack.videoPresented, true);
  assert.equal(ack.playbackRevision, 1); assert.equal(h.graph.resumes(), 2);
  assert.equal(h.graph.engine.readState().sourceCount, 1); assert.equal(h.graph.processor.underruns, 0);
  const actualWindow = h.graph.observations.find(o => o.playedWindow?.startFrame === 24 * RATE).playedWindow;
  assert.equal(await pcmSha256(actualWindow.pcm), input.fixtureRender.expectedPlayedWindowSha256);
  const binding = {operationId: 1, roomId: ROOM, cueId: input.cue.cueId, generationId: input.cue.generationId, expectedRevision: 1};
  const element = {textContent: '', hidden: true}, timers = [];
  const overlay = createCloudCreditOverlay({element, readPlayback: h.port.read, readBinding: () => binding,
    schedule(fn, ms) {timers.push({fn, ms}); return timers.length;}, cancel() {}});
  const credit = projectCloudPlaybackCredit({...ack, generationId: input.cue.generationId, nickname: '合成ゲスト', actualPlayback: true}, binding);
  assert.equal(overlay.show(credit).shown, true); assert.deepEqual(overlay.show(credit), {shown: false, duplicate: true});
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 6000); timers[0].fn(); assert.equal(element.hidden, true);
  const chunks = h.graph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length;
  const retry = h.port.commitPlayback(input).then(ack => ({ack}), error => ({error}));
  await assert.rejects(h.waitForQueue(chunks + 1, retry, 'lost ACK retry queue'), error => {
    assert.equal(error.terminalCode, 'STALE_PLAYBACK_REVISION'); assert.match(error.message, /"phase":"PLAYING"/); return true;
  });
  assert.equal((await retry).error.message, 'STALE_PLAYBACK_REVISION');
  assert.equal(h.graph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length, chunks, 'lost transport ACK cannot enqueue the same revision again');
  overlay.dispose();
});

test('three generated24s tails extend one graph through96s; every cue needs its own PCM+video ACK and one credit', async t => {
  const h = await fixture(t), {input, outcome} = await startFirst(h);
  let prior = input, binding, creditCount = 0;
  const overlay = createCloudCreditOverlay({element: {textContent: '', hidden: true}, readPlayback: h.port.read,
    readBinding: () => binding, schedule() {return 1;}, cancel() {}});
  t.after(() => overlay.dispose());
  async function verify(ack, current) {
    assert.equal(ack.actual, true); assert.equal(ack.audioStarted, true); assert.equal(ack.videoPresented, true);
    const revision = current.expectedRevision;
    assert.equal(ack.playbackRevision, revision); assert.equal(h.graph.processor.underruns, 0);
    const trace = h.graph.observations.find(e => e.playedWindow?.startFrame === revision * 24 * RATE).playedWindow;
    assert.equal(await pcmSha256(trace.pcm), current.fixtureRender.expectedPlayedWindowSha256);
    binding = {operationId: revision, roomId: ROOM, cueId: current.cue.cueId,
      generationId: current.cue.generationId, expectedRevision: revision};
    const credit = projectCloudPlaybackCredit({...ack, generationId: current.cue.generationId,
      nickname: `合成ゲスト${revision}`, actualPlayback: true}, binding);
    if (overlay.show(credit).shown) creditCount++;
    assert.deepEqual(overlay.show(credit), {shown: false, duplicate: true});
  }
  await h.pumpTo(24 * RATE + RATE / 2); await verify((await outcome).ack, input);
  for (const revision of [2, 3]) {
    const next = await h.input(revision, prior.fixtureRender.pcm), at = h.graph.processor.consumed;
    const oldVisible = h.videos.find(v => v.plays && !v.paused && !v.removed); assert.ok(oldVisible);
    const pending = h.port.commitPlayback(next).then(ack => ({ack}), error => ({error}));
    await h.waitForQueue(revision + 1, pending, `cue ${revision} queue`);
    assert.equal(h.graph.processor.consumed, at, 'future seam replacement cannot move the consumed clock');
    assert.equal(oldVisible.removed, undefined, 'current visual remains until the next tail actually presents');
    assert.equal(oldVisible.paused, false);
    h.graph.pump();
    assert.equal(h.graph.output[0][0], prior.fixtureRender.pcm[at * 2], 'already sounding tail retains its exact next sample');
    await h.pumpTo(revision * 24 * RATE + RATE / 2);
    const result = await pending; assert.equal(result.error, undefined); await verify(result.ack, next);
    assert.equal(oldVisible.removed, true, 'previous visual releases after the next actual AV handoff'); prior = next;
  }
  assert.equal(creditCount, 3); assert.equal(h.graph.resumes(), 2, 'seed and unlock resume the same graph');
  assert.equal(h.graph.engine.readState().sourceCount, 1); assert.equal(h.port.read().playbackRevision, 3);
  await h.pumpTo(96 * RATE); assert.equal(h.port.read().phase, 'STOPPED');
  assert.equal(h.port.read().reason, 'CUE_DURATION_END'); assert.equal(h.graph.processor.consumed, 96 * RATE);
  assert.equal(h.graph.processor.underruns, 0);
});

test('processed audio plus elapsed24s without a video callback gives no credit, and explicit stop permits a fresh source graph', async t => {
  const h = await fixture(t), {outcome} = await startFirst(h);
  await h.pumpTo(24 * RATE + RATE / 2, false);
  assert.equal(h.port.read().audioStarted, true); assert.equal(h.port.read().videoPresented, false);
  assert.equal(h.port.read().playbackRevision, 0);
  const old = await h.restart(); assert.ok((await outcome).error); assert.equal(old.stops(), 1);
  h.videos.forEach(v => v.present()); assert.equal(h.port.read().playbackRevision, 0, 'late old visual callback cannot earn credit');
  await h.prime(2); assert.equal(h.sourceMarks(), 2); assert.equal(h.port.read().phase, 'READY');
  assert.equal(h.graph.processor.consumed, 11520); assert.equal(h.graph.resumes(), 2); assert.equal(old.processor.playing, false);
  const nextInput = await h.input(1, (await prepareCloudInitialAudio(await seedInput(2))).pcm);
  const restarted = h.port.commitPlayback(nextInput).then(ack => ({ack}), error => ({error}));
  await h.waitForQueue(2, restarted, 'restarted cue queue');
  await h.pumpTo(24 * RATE + RATE / 2); const result = await restarted;
  assert.equal(result.error, undefined); assert.equal(result.ack.playbackRevision, 1);
  assert.equal(h.graph.processor.underruns, 0); assert.equal(old.processor.consumed > 24 * RATE, true);
});

test('an exhausted source prefix yields underrun HOLD without fabricated AV success', async t => {
  const h = await fixture(t); const plan = await h.prime();
  // Source handoff does not authorize PCM padding. No generated Cue is committed.
  h.graph.pump(Math.ceil((plan.queuedPrefixFrames + RATE / 2 - h.graph.processor.consumed) / 128));
  assert.ok(h.graph.processor.underruns > 0); assert.equal(h.port.read().playbackRevision, 0);
  await until(() => h.port.read().phase === 'HOLD');
  await until(() => h.graph.stops() === 1);
  assert.equal(h.port.read().audioStarted, false); assert.equal(h.port.read().videoPresented, false);
  assert.equal(h.graph.stops(), 1, 'idle output watchdog stops the exhausted source graph');
  await h.port.stop(); assert.equal(h.port.read().phase, 'STOPPED');
});

test('cross-generation AVpair, unsafe future edit, and stale control guard cannot advance credit', async t => {
  const h = await fixture(t), plan = await h.prime();
  const mixed = await h.input(1, plan.pcm); mixed.cue.video.binding.generationId = 'different-generation';
  const originalDeliveries = h.graph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length;
  await assert.rejects(h.port.commitPlayback(mixed), /SAME_SET_24_SECOND_AV_REQUIRED/);
  assert.equal(h.graph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length, originalDeliveries);
  assert.equal(h.port.read().playbackRevision, 0);
  const first = await h.input(1, plan.pcm), started = h.port.commitPlayback(first).then(ack => ({ack}), error => ({error}));
  await h.waitForQueue(2, started, 'first guarded cue queue');
  await h.pumpTo(24 * RATE + RATE / 2); assert.ok((await started).ack);
  const unsafe = await h.input(2, first.fixtureRender.pcm);
  unsafe.plan.transition.editStartFrame = h.graph.engine.readState().consumedFrames;
  const prepared = await h.graph.engine.prepare(unsafe);
  const deliveries = h.graph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length;
  await assert.rejects(h.graph.engine.commit(prepared), /FRONTIER|FUTURE|REPLACE/);
  assert.equal(h.graph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length, deliveries);
  let valid = true; const next = await h.input(2, first.fixtureRender.pcm); next.guard = async () => valid;
  const pending = h.port.commitPlayback(next).then(ack => ({ack}), error => ({error}));
  await h.waitForQueue(deliveries + 1, pending, 'next guarded cue queue');
  valid = false; await h.pumpTo(48 * RATE + RATE / 2);
  assert.match((await pending).error.message, /STALE_PLAYBACK_GUARD/);
  assert.equal(h.port.read().phase, 'HOLD'); assert.equal(h.port.read().playbackRevision, 1);
});

test('repository processor stops at the hard180s cap, rejects extension/noncontiguous bytes, and reports all processed frames', () => {
  const h = graph(), maximum = 180 * RATE;
  h.processor.message({type: 'set-duration', frames: maximum});
  h.processor.message({type: 'chunk', startFrame: 0, pcm: new Float32Array(maximum * 2).fill(.125).buffer});
  h.processor.message({type: 'play'}); h.pump(Math.ceil(maximum / 128) + 3);
  assert.equal(h.processor.consumed, maximum); assert.equal(h.processor.playing, false); assert.equal(h.processor.underruns, 0);
  const ended = h.observations.filter(e => e.telemetry).at(-1).telemetry;
  assert.equal(ended.stopped, true); assert.equal(ended.consumedFrames, maximum); assert.equal(ended.receivedFrames, maximum);
  h.processor.message({type: 'bound-duration', frames: maximum + 1});
  h.processor.message({type: 'chunk', startFrame: maximum, pcm: new Float32Array(256).buffer});
  h.processor.message({type: 'chunk', startFrame: maximum - 1, pcm: new Float32Array(256).buffer});
  assert.deepEqual(h.observations.filter(e => e.error).map(e => e.error), ['INVALID_RENDER_DURATION_BOUND', 'PCM_EXCEEDS_FINITE_RENDER', 'NONCONTIGUOUS_PCM']);
  assert.equal(h.processor.consumed, maximum);
});

// Show mode: the output page is the clock. One owner Start runs source -> A -> B
// on the same graph while the owner/server path loses an ACK response and
// rejects one incoming preparation. Neither failure may stop the sounding Cue.
for(const cueCount of [2,5])test(`one Start carries source and ${cueCount} cues on one graph through a lost ACK reply and a rejected incoming preparation`, async t => {
  const h = await fixture(t), plan = await h.prime(), owner = 'b'.repeat(64);
  const renders = new Map(), acks = [], calls = [];
  let prior = plan.pcm, revision = 0, pending = null, droppedAck = false, rejectedCheck = false;
  const request = async (path, {body}) => {
    const action = path.split('/').at(-1); calls.push(action);
    if (action === 'start' || action === 'stop') return {};
    if (action === 'reserve') {
      if (pending) throw Object.assign(Error('PLAYBACK_PENDING'), {code: 'PLAYBACK_PENDING'});
      if (revision >= cueCount) return {state: 'HOLD', reason: 'NO_READY_CUE'};
      const input = await h.input(revision + 1, prior);
      renders.set(input.cue.cueId, input.fixtureRender);
      pending = {reservationId: 'reservation_' + String(revision + 1).repeat(24), roomId: ROOM, cue: input.cue, plan: input.plan,
        expectedRevision: revision + 1, expiresAtMs: Date.now() + 30000};
      return pending;
    }
    if (action === 'check') {
      if (body.reservationId !== pending?.reservationId) return {valid: false};
      // The first guard of Cue B is rejected before any queue edit.
      if (pending.expectedRevision === 2 && !rejectedCheck) { rejectedCheck = true; return {valid: false}; }
      return {valid: true};
    }
    if (action === 'ack') {
      const credit = {cueId: body.ack.cueId, playbackRevision: body.ack.playbackRevision, actual: true};
      if (!acks.some(a => a.playbackRevision === credit.playbackRevision)) acks.push(credit);
      if (pending?.reservationId === body.reservationId) {
        revision = pending.expectedRevision; prior = renders.get(pending.cue.cueId).pcm; pending = null;
      }
      // The first ACK commits but its reply is lost; the idempotent retry confirms.
      if (!droppedAck) { droppedAck = true; throw Error('lost response'); }
      return {accepted: true, currentCredit: credit};
    }
    if (action === 'state') return {currentCredit: acks.at(-1) ?? null};
    throw Error('unexpected ' + action);
  };
  const states = [];
  const host = createOwnerCueHost({request, roomId: ROOM, ownerCapability: owner, lifecycle: null, intervalMs: 20, retryDelayMs: 5,
    onState: s => states.push(s), stopPlayback: () => assert.fail('a network failure must not stop playback'),
    commitPlayback: input => h.port.commitPlayback({...input, fixtureRender: renders.get(input.cue.cueId)})});
  t.after(() => host.dispose().catch(() => {}));
  await host.start();
  await until(() => h.graph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length === 2, 'cue A queued');
  await h.pumpTo(24 * RATE + RATE / 2);
  await until(() => acks.length === 1 && states.some(s => s.state === 'PLAYING'), 'cue A acknowledged');
  await until(() => h.graph.commands.filter(c => ['chunk', 'replace-future'].includes(c.type)).length === 3, 'cue B queued',
    () => ({states: states.slice(-3), calls: calls.slice(-6), phase: h.port.read()}));
  assert.equal(rejectedCheck, true, 'the rejected preparation was retried on the same reservation');
  await h.pumpTo(48 * RATE + RATE / 2);
  await until(() => acks.length === 2 && h.port.read().playbackRevision === 2, 'cue B acknowledged');
  for(let index=3;index<=cueCount;index++){
    await until(()=>h.graph.commands.filter(c=>['chunk','replace-future'].includes(c.type)).length===index+1,`cue ${index} queued`);
    await h.pumpTo(index*24*RATE+RATE/2);
    await until(()=>acks.length===index&&h.port.read().playbackRevision===index,`cue ${index} acknowledged`);
  }
  assert.deepEqual(acks.map(a => a.playbackRevision), Array.from({length:cueCount},(_,i)=>i+1));
  assert.equal(droppedAck, true); assert.ok(calls.filter(c => c === 'ack').length >= 3, 'lost ACK reply was retried idempotently');
  assert.equal(calls.filter(c => c === 'start').length, 1, 'one owner Start');
  assert.equal(h.graph.stops(), 0); assert.equal(h.graph.processor.underruns, 0);
  assert.equal(h.graph.engine.readState().sourceCount, 1); assert.equal(h.port.read().phase, 'PLAYING');
  await until(() => states.at(-1)?.reason === 'NO_READY_CUE', 'waiting for the next Cue without stopping');
});
