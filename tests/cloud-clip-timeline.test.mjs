import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {verifyClipRelativeRender, assembleClipRelativeRender} from '../room-web/playback/clip-timeline.mjs';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {prepareCloudInitialAudio, createCloudSeedPlayback} from '../room-web/cloud-initial-audio.mjs';
import {createAudioOutputLease} from '../room-web/playback/output-lease.mjs';
import {syntheticWave} from './cloud-worker-fixture.mjs';
import {decodeCloudRender} from '../room-web/cloud-playback-media.mjs';
const RATE = 44100, H = 'a'.repeat(64);
async function local(entryFrame = 0) {
  const pcm = new Float32Array((48 * RATE - entryFrame) * 2).fill(.1);
  pcm.fill(.2, 24 * RATE * 2);
  const render = {pcm, sampleRate: RATE, startFrame: 24 * RATE, durationFrames: pcm.length / 2,
    renderedPcmSha256: await pcmSha256(pcm), renderedFileSha256: H,
    expectedPlayedWindowSha256: await pcmSha256(pcm.subarray(24 * RATE * 2, (24 * RATE + 256) * 2)), timelineSpace: 'clip-relative-v1'};
  const plan = {currentClipId: 'parent', currentSha256: H, currentPlaybackRevision: 1,
    planSha256: H, transition: {editStartFrame: 20 * RATE, exitFrame: 24 * RATE, entryFrame, renderedSha256: H}};
  return {render: await verifyClipRelativeRender(render), plan,
    binding: {clipId: 'parent', sha256: H, playbackRevision: 1, originFrame: 24 * RATE},
    retainedPCM: new Float32Array(48 * RATE * 2).fill(.33), ceilingFrames: 180 * RATE};
}
test('native48s proof stays unchanged while historical seam bytes map into graph72s', async () => {
  const f = await local(), original = JSON.stringify(f.plan), nativeHash = f.render.renderedPcmSha256;
  const mapped = await assembleClipRelativeRender(f);
  assert.equal(mapped.startFrame, 48 * RATE); assert.equal(mapped.durationFrames, 72 * RATE);
  assert.equal(mapped.queueEditFrame, 44 * RATE); assert.equal(mapped.pcm[100], f.retainedPCM[100]);
  assert.equal(mapped.pcm[44 * RATE * 2 - 1], f.retainedPCM[44 * RATE * 2 - 1]);
  assert.equal(mapped.pcm[44 * RATE * 2], f.render.pcm[20 * RATE * 2]);
  assert.equal(mapped.renderedPcmSha256, nativeHash); assert.equal(mapped.renderedFileSha256, H);
  assert.equal(mapped.expectedPlayedWindowSha256, f.render.expectedPlayedWindowSha256);
  assert.equal(await pcmSha256(mapped.pcm.subarray(mapped.startFrame * 2, (mapped.startFrame + 256) * 2)), f.render.expectedPlayedWindowSha256);
  assert.equal(mapped.clipTimeline.assemblyPcmSha256, await pcmSha256(mapped.pcm));
  assert.notEqual(mapped.clipTimeline.assemblyPcmSha256, nativeHash); assert.equal(JSON.stringify(f.plan), original);
});
test('entry offsets use actual clip origin without stretching native geometry', async () => {
  const f = await local(2 * RATE); f.binding.originFrame = 22 * RATE;
  const mapped = await assembleClipRelativeRender(f);
  assert.equal(mapped.startFrame, 46 * RATE); assert.equal(mapped.durationFrames, 68 * RATE);
  assert.equal(mapped.durationFrames - mapped.startFrame, 22 * RATE);
  assert.equal(mapped.clipTimeline.localStartFrame, 24 * RATE);
});
test('caller markers, wrong current ACK binding, mutated native bytes and graph cap cannot map', async () => {
  const f = await local();
  await assert.rejects(assembleClipRelativeRender({...f, render: {...f.render}}), /ACTUAL_CLIP/);
  for (const patch of [{clipId: 'other'}, {sha256: 'b'.repeat(64)}, {playbackRevision: 0}])
    await assert.rejects(assembleClipRelativeRender({...f, binding: {...f.binding, ...patch}}), /ACTUAL_CLIP/);
  await assert.rejects(assembleClipRelativeRender({...f, ceilingFrames: 60 * RATE}), /CEILING/);
  f.render.pcm[0] = .4;
  await assert.rejects(assembleClipRelativeRender(f), /ACTUAL_CLIP/);
});
function engineGraph(enabled) {
  let Processor, state = 'suspended'; const listeners = new Set(), commands = [];
  const sandbox = {Float32Array, ArrayBuffer, sampleRate: RATE, currentTime: 0,
    AudioWorkletProcessor: class {constructor() {this.port = {postMessage(data) {for (const fn of listeners) fn({data});}};}},
    registerProcessor(n, ctor) {Processor = ctor;}};
  vm.runInNewContext(readFileSync(new URL('../snapshot/app/room-worklet.mjs', import.meta.url), 'utf8'), sandbox);
  const processor = new Processor(), context = {sampleRate: RATE, get state() {return state;}, resume() {state = 'running'; return Promise.resolve();}};
  const engine = createWorkletPlaybackEngine({context, node: {port: {start() {}, addEventListener(t, fn) {listeners.add(fn);}, removeEventListener(t, fn) {listeners.delete(fn);},
    postMessage(data) {commands.push(data); processor.message(data);}}}, allowInitialAudio: true, enableClipRelativeTimeline: enabled,
    loadVerifiedRender: async input => input.render, readSourceCount: () => 1, stopAudio: async () => {state = 'suspended';}});
  const pump = blocks => {for (let i = 0; i < blocks; i++) processor.process([], [[new Float32Array(128), new Float32Array(128)]]);};
  return {engine, processor, commands, pump};
}
test('clip-relative mapping is default disabled and requires actual source ACK even when enabled', async () => {
  assert.throws(() => engineGraph('true'), /EXISTING_WORKLET_ENGINE_REQUIRED/);
  const f = await local(), off = engineGraph(false), on = engineGraph(true);
  await assert.rejects(off.engine.mapVerifiedRender(await off.engine.prepare({render: f.render, plan: f.plan})), /ACTIVATION_GATED/);
  await assert.rejects(on.engine.mapVerifiedRender(await on.engine.prepare({render: f.render, plan: f.plan})), /ACTUAL_CLIP/);
  assert.equal(on.commands.length, 0); await off.engine.stop(); await on.engine.stop();
});
test('bootstrap physically verifies24s, assumes no first QC plan, emits source-only ACK then stops finite', async () => {
  const bytes = new Uint8Array(syntheticWave(24)), sha256 = await pcmSha256(bytes), pcm = decodeCloudRender(bytes, {mimeType: 'audio/wav', durationFrames: 24 * RATE});
  const args = {mode: 'bootstrap', graphEpoch: 1, bytes,
    descriptor: {assetId: 'bootstrap', sha256, pcmSha256: await pcmSha256(pcm), byteLength: bytes.length, mimeType: 'audio/wav'},
    source: {actual: false, clipId: 'bootstrap', sha256, contextSha256: H, playbackRevision: 0, frameCount: 24 * RATE}};
  await assert.rejects(prepareCloudInitialAudio({...args, firstPlan: {status: 'ELIGIBLE'}}), /CANNOT_ASSUME/);
  const plan = await prepareCloudInitialAudio(args), h = engineGraph(true);
  assert.equal(plan.continuationPlanSha256, null); assert.equal(plan.continuationRenderSha256, null);
  assert.equal(plan.queuedPrefixFrames, 24 * RATE); assert.equal(plan.participantCredit, false);
  const lease = createAudioOutputLease({locks: {request: async (n, o, cb) => cb({name: n})}});
  const seed = createCloudSeedPlayback({enabled: true, plan, audioEngine: h.engine, outputLease: lease, guard: async () => true,
    markSourceStarted: async ack => ({accepted: true, graphEpoch: ack.graphEpoch, sourceSha256: ack.sourceSha256, sourcePlaybackRevision: ack.sourcePlaybackRevision})});
  const pending = seed.start();
  for (let i = 0; i < 1000 && !h.commands.some(c => c.type === 'play'); i++) await new Promise(r => setTimeout(r, 1));
  h.pump(90); const ack = await pending;
  assert.equal(ack.actual, true); assert.equal(ack.participantCredit, false);
  assert.equal(h.engine.readClipState().originFrame, 0); assert.equal(h.engine.readClipState().playbackRevision, 0);
  assert.equal(h.processor.duration, 24 * RATE); assert.equal(h.processor.ceiling, 180 * RATE);
  h.pump(Math.ceil(24 * RATE / 128)); assert.equal(h.processor.consumed, 24 * RATE);
  assert.equal(h.processor.playing, false); assert.equal(h.engine.readClipState()?.actual ?? false, false);
  await seed.dispose(); assert.equal(h.engine.readClipState(), null);
});
