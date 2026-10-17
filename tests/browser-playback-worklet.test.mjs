import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';

// Execute the local queue-audio worklet with synthetic PCM, never hardware.
const worklet = fs.readFileSync(new URL('../snapshot/app/room-worklet.mjs', import.meta.url), 'utf8');
function harness() {
  let Processor, listener, state = 'running'; const messages = [], outputs = [];
  const sandbox = {Float32Array, ArrayBuffer, sampleRate: 44100, currentTime: 0,
    AudioWorkletProcessor: class {constructor() { this.port = {postMessage(data) { outputs.push(data); listener?.({data}); }}; }},
    registerProcessor(name, constructor) { assert.equal(name, 'queue-audio'); Processor = constructor; }};
  vm.runInNewContext(worklet, sandbox);
  const processor = new Processor();
  const port = {addEventListener(type, fn) { assert.equal(type, 'message'); listener = fn; },
    removeEventListener() { listener = null; }, start() {}, postMessage(data) { messages.push(data); processor.message(data); }};
  const context = {sampleRate: 44100, get state() { return state; }};
  const engine = createWorkletPlaybackEngine({context, node: {port}, readSourceCount: () => 1,
    loadVerifiedRender: async ({render}) => render,
    stopAudio: async () => { state = 'suspended'; }});
  return {engine, processor, messages, outputs,
    pump() { const out = [new Float32Array(128), new Float32Array(128)]; processor.process([], [out]); sandbox.currentTime += 128 / 44100; return out; }};
}
function input(frames = 2048) {
  const pcm = Float32Array.from({length: frames * 2}, (_, i) => Math.sin(i * .03) * .1);
  return {plan: {transition: {editStartFrame: 0}}, render: {pcm, sampleRate: 44100, startFrame: 0, durationFrames: frames}};
}

test('unchanged worklet emits a SHA-identical 256-frame processed window and finite end', async () => {
  const h = harness(), i = input(), render = await h.engine.prepare(i), observed = [];
  h.engine.subscribe(event => observed.push(event));
  await h.engine.commit(render);
  for (let n = 0; n < 16; n++) h.pump();
  const window = observed.find(e => e.playedWindow).playedWindow;
  assert.equal(window.startFrame, 0);
  assert.equal(await pcmSha256(window.pcm), await pcmSha256(render.pcm.subarray(0, 512)));
  assert.equal(observed.at(-1).telemetry.consumedFrames, 2048);
  assert.equal(observed.at(-1).telemetry.stopped, true);
  assert.equal(observed.at(-1).telemetry.underrunFrames, 0);
  assert.deepEqual(h.messages.map(m => m.type), ['set-duration', 'bound-duration', 'trace-frame', 'chunk', 'play']);
  await h.engine.stop();
});

test('bridge appends only an authorized unqueued render suffix and retains current samples', async () => {
  const h = harness(), i = input(4096);
  h.processor.message({type: 'chunk', startFrame: 0, pcm: i.render.pcm.slice(0, 1024).buffer});
  h.processor.message({type: 'play'}); h.pump();
  i.render.startFrame = 512;
  const render = await h.engine.prepare({...i, plan: {transition: {editStartFrame: 512}}});
  await h.engine.commit(render);
  const replacement = h.messages.find(m => m.type === 'replace-future');
  assert.equal(replacement.startFrame, 512); assert.equal(replacement.expectedReceived, 512);
  assert.equal(h.messages[0].type, 'replace-future');
  assert.equal(replacement.pcm.byteLength, (4096 - 512) * 8);
  assert.equal(h.processor.underruns, 0);
  await h.engine.stop();
});

test('bridge refuses edits before already queued samples and repeated commits', async () => {
  const h = harness(), i = input();
  const render = await h.engine.prepare(i);
  await h.engine.commit(render);
  await assert.rejects(h.engine.commit(render), /SINGLE_RUNNING_WORKLET_REQUIRED/);
  const next = await h.engine.prepare(i);
  await assert.rejects(h.engine.commit(next), /QUEUED_RENDER_FRONTIER_CHANGED/);
  await h.engine.stop();
});

test('aborted render and stopped graph cannot submit PCM', async () => {
  const h = harness(), controller = new AbortController(); controller.abort();
  await assert.rejects(h.engine.prepare({...input(), signal: controller.signal}), /WORKLET_ENGINE_STOPPED/);
  await h.engine.stop();
  await assert.rejects(h.engine.prepare(input()), /WORKLET_ENGINE_STOPPED/);
});
test('verified overlap may start inside the old queued tail while replacing only an unchanged unplayed seam',async()=>{
 const h=harness(),seed=input(2048);await h.engine.commit(await h.engine.prepare(seed));h.pump();
 const next=input(4096);next.render.startFrame=1792;next.plan.transition.editStartFrame=1536;next.render.pcm.fill(.25,1536*2);
 await h.engine.commit(await h.engine.prepare(next));
 const replacement=h.messages.find(m=>m.type==='replace-future');assert.equal(replacement.expectedReceived,2048);assert.equal(replacement.startFrame,1536);
 assert.equal(h.engine.readState().receivedFrames,4096);
 for(let n=0;n<16;n++)h.pump();
 const trace=h.outputs.find(x=>x.playedWindow?.startFrame===1792)?.playedWindow;
 assert(trace,'the overlap trace must come from actual processor output');
 assert.equal(await pcmSha256(new Float32Array(trace.pcm)),await pcmSha256(next.render.pcm.subarray(1792*2,(1792+256)*2)));
 assert.equal(h.processor.underruns,0);await h.engine.stop();
});
test('overlap still rejects already played edits and changes to the retained prefix',async()=>{
 for(const mutation of ['late','prefix']){
  const h=harness();await h.engine.commit(await h.engine.prepare(input(2048)));h.pump();
  const next=input(4096);next.render.startFrame=1792;next.plan.transition.editStartFrame=mutation==='late'?256:1536;
  if(mutation==='prefix')next.render.pcm[0]=.9;
  await assert.rejects(h.engine.commit(await h.engine.prepare(next)),mutation==='late'?/QUEUED_RENDER_FRONTIER_CHANGED/:/QUEUED_RENDER_PREFIX_CHANGED/);
  assert.equal(h.messages.some(m=>m.type==='replace-future'),false);await h.engine.stop();
 }
});
