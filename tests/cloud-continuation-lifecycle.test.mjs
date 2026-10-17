import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';

// Synthetic sample clocks only. Real browser/rVFC evidence is kept separately.
const source = readFileSync(new URL('../snapshot/app/room-worklet.mjs', import.meta.url), 'utf8');
function graph(ceiling = 8192) {
  let Processor, listener; const commands = [], events = [];
  const sandbox = {Float32Array, ArrayBuffer, sampleRate: 44100, currentTime: 0,
    AudioWorkletProcessor: class {constructor() {this.port = {postMessage(data) {events.push(data); listener?.({data});}};}},
    registerProcessor(name, ctor) {Processor = ctor;}};
  vm.runInNewContext(source, sandbox); const processor = new Processor();
  const engine = createWorkletPlaybackEngine({configuredDurationFrames: ceiling,
    context: {sampleRate: 44100, state: 'running'}, readSourceCount: () => 1,
    node: {port: {start() {}, addEventListener(type, fn) {listener = fn;}, removeEventListener() {listener = null;},
      postMessage(data) {commands.push(data); processor.message(data);}}},
    loadVerifiedRender: async input => input.render, stopAudio: async () => {}});
  function pump() {const out = [new Float32Array(128), new Float32Array(128)]; processor.process([], [out]); return out;}
  return {engine, processor, commands, events, pump};
}
function render(frames, startFrame = 0, prefix) {
  const pcm = Float32Array.from({length: frames * 2}, (_, i) => Math.sin(i * .03) * .1);
  if (prefix) pcm.set(prefix);
  return {pcm, sampleRate: 44100, startFrame, durationFrames: frames};
}
const input = (r, edit = 0) => ({render: r, plan: {transition: {editStartFrame: edit}}});
const queueSnapshot = p => ({received: p.received, consumed: p.consumed, queued: p.queued,
  duration: p.duration, offset: p.offset, queue: p.queue.map(q => Array.from(q))});

test('verified continuation extends finite duration while preserving exact consumed/queued prefix', async () => {
  const h = graph(), first = render(2048);
  await h.engine.commit(await h.engine.prepare(input(first))); h.pump();
  const next = render(4096, 2048, first.pcm); next.pcm.fill(.25, 1536 * 2);
  const at = h.processor.consumed;
  await h.engine.commit(await h.engine.prepare(input(next, 1536)));
  assert.equal(h.processor.consumed, at); assert.equal(h.processor.duration, 4096);
  const out = h.pump();
  for (let i = 0; i < 128; i++) {
    assert.equal(out[0][i], first.pcm[(at + i) * 2]);
    assert.equal(out[1][i], first.pcm[(at + i) * 2 + 1]);
  }
  while (h.processor.consumed < 1536) h.pump();
  assert.equal(h.pump()[0][0], .25);
  while (h.processor.playing) h.pump();
  assert.equal(h.processor.consumed, 4096); assert.equal(h.processor.underruns, 0);
  assert.equal(h.events.filter(e => e.telemetry).at(-1).telemetry.stopped, true);
  await h.engine.stop();
});

test('processor rejects stale frontier/late edit/cap/invalid PCM atomically without queue mutation', async () => {
  const h = graph(), first = render(2048);
  await h.engine.commit(await h.engine.prepare(input(first))); h.pump();
  const base = {type: 'replace-future', startFrame: 1536, expectedReceived: 2048, frames: 4096,
    pcm: new Float32Array((4096 - 1536) * 2).fill(.25).buffer};
  for (const patch of [{expectedReceived: 2047}, {startFrame: h.processor.consumed + 128},
    {frames: 8193}, {pcm: new Float32Array((4096 - 1536) * 2).fill(NaN).buffer}]) {
    const before = queueSnapshot(h.processor);
    h.processor.message({...base, ...patch});
    assert.deepEqual(queueSnapshot(h.processor), before);
    assert.ok(h.events.at(-1).error);
  }
  assert.equal(h.pump()[0][0], first.pcm[128 * 2]);
  await h.engine.stop();
});

test('configured ceiling below180s stays fixed across finite extension', async () => {
  const h = graph(4096), first = render(2048);
  await h.engine.commit(await h.engine.prepare(input(first))); h.pump();
  assert.equal(h.processor.ceiling, 4096);
  const beyond = render(8192, 2048, first.pcm), before = h.commands.length;
  await assert.rejects(h.engine.commit(await h.engine.prepare(input(beyond, 1536))), /FRONTIER/);
  assert.equal(h.commands.length, before); assert.equal(h.processor.duration, 2048);
  h.processor.message({type: 'replace-future', startFrame: 1536, expectedReceived: 2048,
    frames: 8192, pcm: beyond.pcm.slice(1536 * 2).buffer});
  assert.equal(h.events.at(-1).error, 'INVALID_FUTURE_REPLACEMENT');
  assert.equal(h.processor.received, 2048); await h.engine.stop();
});

test('prepared PCM mutation and changed immutable prefix cannot enqueue a continuation', async () => {
  const h = graph(), first = render(2048);
  await h.engine.commit(await h.engine.prepare(input(first))); h.pump();
  const changed = render(4096, 2048, first.pcm), prepared = await h.engine.prepare(input(changed, 1536));
  changed.pcm[4000] = .4;
  await assert.rejects(h.engine.commit(prepared), /PREPARED_RENDER_CHANGED/);
  const prefix = render(4096, 2048, first.pcm); prefix.pcm[100] = .2;
  const before = h.commands.length;
  await assert.rejects(h.engine.commit(await h.engine.prepare(input(prefix, 1536))), /PREFIX_CHANGED/);
  assert.equal(h.commands.length, before); assert.equal(h.processor.received, 2048); await h.engine.stop();
});

test('a render prepared before its seam cannot commit after consumed clock passes safety margin', async () => {
  const h = graph(), first = render(2048);
  await h.engine.commit(await h.engine.prepare(input(first)));
  const next = await h.engine.prepare(input(render(4096, 2048, first.pcm), 1536));
  // Telemetry is deliberately sparse. Even if main-thread consumed telemetry
  // lags, the processor checks its live clock and rejects before queue mutation.
  for (let i = 0; i < 11; i++) h.pump();
  const before = queueSnapshot(h.processor);
  await h.engine.commit(next);
  assert.equal(h.events.some(e => e.error === 'INVALID_FUTURE_REPLACEMENT'), true);
  assert.deepEqual(queueSnapshot(h.processor), before);
  await h.engine.stop();
});
