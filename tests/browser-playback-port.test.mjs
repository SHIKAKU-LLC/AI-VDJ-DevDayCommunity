import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserCommitPlayback} from '../room-web/playback/commit-playback.mjs';
import {createAudioOutputLease} from '../room-web/playback/output-lease.mjs';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';
import {createVideoAdapter} from '../snapshot/ui/app/scene-video-adapter.mjs';

// All media and worklet observations here are synthetic; no network/provider/audio hardware.
const RATE = 44100, hash = 'a'.repeat(64), intent = 'b'.repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 3000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 1)); } assert.fail('condition not reached'); }
function locks() {
  let held = false;
  return {async request(name, options, callback) {
    if (held) return callback(null);
    held = true;
    try { return await callback({name}); } finally { held = false; }
  }};
}
class Video {
  constructor() { this.style = {}; this.videoWidth = 1280; this.videoHeight = 720; this.readyState = 3; this.currentTime = 0; this.events = new Map(); this.frames = new Map(); this.nextFrame = 0; this.plays = 0; this.attributes = {}; }
  setAttribute(k, v) { this.attributes[k] = v; }
  removeAttribute(k) { delete this.attributes[k]; if (k === 'src') delete this.src; }
  getAttribute(k) { return this.attributes[k]; }
  get currentSrc(){return this.src;}
  addEventListener(k, fn) { const a = this.events.get(k) ?? new Set(); a.add(fn); this.events.set(k, a); }
  removeEventListener(k, fn) { this.events.get(k)?.delete(fn); }
  requestVideoFrameCallback(fn) { const id = ++this.nextFrame; this.frames.set(id, fn); return id; }
  cancelVideoFrameCallback(id) { this.frames.delete(id); }
  present() { for (const [id, fn] of this.frames) { this.frames.delete(id); fn(0, {}); } }
  load() {}
  pause() { this.paused = true; }
  remove() { this.removed = true; }
  play() { this.plays++; this.paused = false; return Promise.resolve(); }
}
function cue() {
  const c = {roomId: 'room', cueId: 'cue', generationId: 'generation', submissionId: 'submission',
    commonIntentSha256: intent, controlVersion: 7, atomicReady: true, status: 'READY'};
  for (const channel of ['music', 'video']) c[channel] = {binding: {roomId: c.roomId, cueId: c.cueId,
    generationId: c.generationId, submissionId: c.submissionId, commonIntentSha256: intent, controlVersion: 7, channel},
  status: 'QC_READY', qc: {passed: true}, durationSeconds: 24, asset: {assetId: channel, sha256: hash}};
  c.video.review = {accepted: true, ownerArtisticApproval: true, assetSha256: hash, commonIntentSha256: intent};
  c.video.compositionQC = {passed: true};
  c.video.clips = [{assetId: 'clip', sha256: hash, durationSeconds: 5}];
  c.video.timeline = {durationSeconds: 24, timeStretch: false, approvedLoops: true,
    segments: [0, 5, 10, 15, 20].map(startSeconds => ({assetId: 'clip', sha256: hash,
      startSeconds, endSeconds: Math.min(startSeconds + 5, 24), sourceInSeconds: 0,
      sourceOutSeconds: Math.min(5, 24 - startSeconds), playbackRate: 1}))};
  return c;
}
const basePCM = new Float32Array(24 * RATE * 2).fill(.1);
const baseHash = await pcmSha256(basePCM);
async function setup(t, options = {}) {
  const videos = [], listeners = new Set(), events = [], lifecycleListeners = new Map(), contextListeners = new Set();
  const pcm = options.pcm ?? basePCM;
  const prepared = {pcm, sampleRate: RATE, startFrame: 0, durationFrames: pcm.length / 2,
    expectedPlayedWindowSha256: await pcmSha256(pcm.subarray(0, 512))};
  let state = {sourceCount: 1, contextState: 'suspended'}, commits = 0, stops = 0, releases = 0;
  const engine = {context: {addEventListener(type, fn) {if (type === 'statechange') contextListeners.add(fn);},
    removeEventListener(type, fn) {if (type === 'statechange') contextListeners.delete(fn);}, resume() { events.push('resume'); if (options.resumeError) return Promise.reject(options.resumeError); state.contextState = 'running'; return Promise.resolve(); }},
    readState: () => state, prepare: async () => prepared,
    commit: async () => { commits++; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async stop() { stops++; if (options.stopError) throw options.stopError; state.contextState = 'suspended';
      if (options.emitContextOnStop) for (const fn of [...contextListeners]) fn();
      await options.stopWait; }};
  const c = options.cue ?? cue();
  const input = {roomId: 'room', cue: c, plan: {cueId: c.cueId, transition: {exitFrame: 0, entryFrame: options.entryFrame ?? 0}},
    expectedRevision: 1, guard: options.guard ?? (async () => true)};
  const media = {audio: {assetId: 'music', sha256: hash, renderedPcmSha256: options.pcmHash ?? (pcm === basePCM ? baseHash : await pcmSha256(pcm))},
    videos: [{assetId: 'clip', sha256: hash, url: 'blob:synthetic-private', source: 'local-edit', requestId: 'synthetic-request'}],
    release() { releases++; }};
  const port = createBrowserCommitPlayback({audioEngine: engine,
    resolveMedia: options.resolveMedia ?? (async () => media),
    createVideoAdapter: p => createVideoAdapter({...p, crossfadeMs: 0, fetchImpl() { throw Error('network forbidden'); }}),
    videoFactory: () => { const v = new Video(); if (options.noFrameObserver) v.requestVideoFrameCallback = undefined;
      v.getBoundingClientRect=()=>options.videoBox??{width:1280,height:720};videos.push(v); return v; },
    container: {append() {},getBoundingClientRect:()=>options.outputBox??{width:1280,height:720}}, outputLease: createAudioOutputLease({locks: options.locks ?? locks()}),
    role: options.role ?? 'output', ackTimeoutMs: options.ackTimeoutMs ?? 2000,
    prepareTimeoutMs: options.prepareTimeoutMs ?? 20000,
    parallelAuthorizedMedia: options.parallelAuthorizedMedia ?? false,
    lifecycle: {addEventListener: (k, fn) => lifecycleListeners.set(k, fn), removeEventListener: k => lifecycleListeners.delete(k)},
    onState: s => events.push(s.phase)});
  t.after(() => port.dispose());
  return {port, engine, input, media, videos, events, lifecycleListeners, prepared,
    emit: async event => { for (const fn of listeners) fn(event); for (let i = 0; i < 5; i++) await turn(); },
    telemetry: (frames, extra = {}) => ({telemetry: {sampleRate: RATE, consumedFrames: frames, underrunFrames: 0, stopped: false, ...extra}}),
    window: () => ({playedWindow: {startFrame: 0, pcm: pcm.slice(0, 512).buffer}}),
    commits: () => commits, stops: () => stops, releases: () => releases,
    mutateState: patch => Object.assign(state, patch),
    contextStateChange(next) {state.contextState = next; for (const fn of [...contextListeners]) fn();},
    contextWatchCount: () => contextListeners.size};
}
async function start(h) {
  await h.port.unlock();
  const previousCommits = h.commits();
  let settled = false;
  const outcome = h.port.commitPlayback(h.input).then(ack => ({ack}), error => ({error})).finally(() => { settled = true; });
  await until(() => settled || h.commits() > previousCommits || ['HOLD', 'GESTURE_REQUIRED'].includes(h.port.read().phase));
  return {outcome};
}
async function present(h) {
  await until(() => h.videos.some(v => v.frames.size));
  h.videos.forEach(v => v.present());
  for (let i = 0; i < 10; i++) await turn();
}
async function ack(h) {
  const {outcome} = await start(h);
  await h.emit(h.telemetry(256)); await h.emit(h.window()); await present(h);
  return (await outcome).ack;
}

test('uses real adapter frame callback + consumed PCM SHA before the unchanged ACK shape', async t => {
  const h = await setup(t); const {outcome} = await start(h);
  assert.equal(h.events[1], 'resume', 'resume is synchronous before lock acquisition');
  await h.emit(h.telemetry(256));
  assert.equal(h.port.read().audioStarted, false, 'clock alone is insufficient');
  await h.emit(h.window());
  assert.equal(h.port.read().phase, 'STARTING', 'play promise alone is insufficient');
  await present(h);
  assert.deepEqual((await outcome).ack, {roomId: 'room', cueId: 'cue', clipId: 'music', playbackRevision: 1,
    audioTime: 256 / RATE, actual: true, audioStarted: true, videoPresented: true});
  assert.ok(h.videos.every(v => v.muted === true && v.volume === 0));
  assert.equal(h.port.read().sourceCount, 1);
});

test('preloads five-second clips across the complete 24-second approved timeline; no loop credit', async t => {
  const h = await setup(t); await ack(h);
  assert.equal(h.port.read().playbackRevision, 1);
  for (const seconds of [5, 10, 15, 20]) {
    await h.emit(h.telemetry(seconds * RATE)); await present(h);
    assert.equal(h.port.read().playbackRevision, 1);
    assert.equal(h.port.read().phase, 'PLAYING');
  }
  await h.emit(h.telemetry(24 * RATE, {stopped: true}));
  assert.equal(h.port.read().phase, 'STOPPED');
  assert.equal(h.stops(), 1);
});

test('approved source trims follow transition entry offset without retiming', async t => {
  const h = await setup(t, {entryFrame: 2 * RATE, pcm: basePCM.subarray(0, 22 * RATE * 2)});
  await ack(h);
  const playing = h.videos.find(v => v.plays);
  assert.ok(playing.currentTime >= 2 && playing.currentTime < 2.02);
  assert.equal(playing.loop, false);
});

for (const [name, change] of [
  ['partial AV', c => { c.video.status = 'WAIT_QC'; }],
  ['five-second cue', c => { c.video.durationSeconds = 5; }],
  ['wrong generation', c => { c.music.binding.generationId = 'other'; }],
  ['wrong intent', c => { c.video.binding.commonIntentSha256 = 'c'.repeat(64); }],
  ['missing review', c => { c.video.review.accepted = false; }],
  ['wrong review hash', c => { c.video.review.assetSha256 = 'd'.repeat(64); }],
  ['timeline gap', c => { c.video.timeline.segments[1].startSeconds = 6; }],
  ['unapproved loop', c => { c.video.timeline.approvedLoops = false; }],
  ['retimed clip', c => { c.video.timeline.segments[0].playbackRate = 2; }],
]) test(`rejects ${name} before media is queued`, async t => {
  const c = cue(); change(c); const h = await setup(t, {cue: c}); await h.port.unlock();
  await assert.rejects(h.port.commitPlayback(h.input)); assert.equal(h.commits(), 0);
});

test('wrong decoded/rendered PCM hash holds without a commit', async t => {
  const h = await setup(t, {pcmHash: 'f'.repeat(64)}), {outcome} = await start(h);
  assert.match((await outcome).error.message, /RENDER_PCM_SHA_MISMATCH/);
  assert.equal(h.commits(), 0);
  // Nothing was edited: the incoming Cue is abandoned, the sounding graph stays.
  assert.equal(h.port.read().phase, 'READY'); assert.equal(h.port.read().reason, 'RENDER_PCM_SHA_MISMATCH'); assert.equal(h.stops(), 0);
});

test('wrong played-window hash holds without credit', async t => {
  const h = await setup(t), {outcome} = await start(h);
  await h.emit(h.telemetry(256));
  await h.emit({playedWindow: {startFrame: 0, pcm: new Float32Array(512).buffer}});
  assert.match((await outcome).error.message, /PLAYED_PCM_SHA_MISMATCH/);
  assert.equal(h.port.read().playbackRevision, 0);
});

test('Stop between audio and frame presentation rejects, ignores late frames, and reopens with a fresh gesture', async t => {
  const h = await setup(t), {outcome} = await start(h);
  await h.emit(h.telemetry(256)); await h.emit(h.window());
  await h.port.stop(); h.videos.forEach(v => v.present());
  assert.ok((await outcome).error); assert.equal(h.port.read().playbackRevision, 0);
  assert.equal(h.releases(), 1);
  await h.port.reopen(); assert.equal(h.port.read().phase, 'IDLE');
  const {outcome: next} = await start(h);
  await h.emit(h.telemetry(256)); await h.emit(h.window()); await present(h);
  assert.equal((await next).ack.playbackRevision, 1);
});

test('pagehide cancels a pending ACK and unregisters on dispose', async t => {
  const h = await setup(t), {outcome} = await start(h);
  h.lifecycleListeners.get('pagehide')();
  assert.ok((await outcome).error); assert.equal(h.port.read().phase, 'STOPPED');
  await h.port.dispose(); assert.equal(h.lifecycleListeners.size, 0);
});

test('async guard becoming stale before presentation cannot acknowledge', async t => {
  let valid = true;
  const h = await setup(t, {guard: async () => valid}), {outcome} = await start(h);
  await h.emit(h.telemetry(256)); await h.emit(h.window()); valid = false; await present(h);
  assert.match((await outcome).error.message, /STALE_PLAYBACK_GUARD/);
});

test('stale revision and concurrent commits are rejected', async t => {
  const h = await setup(t), {outcome} = await start(h);
  await assert.rejects(h.port.commitPlayback(h.input), /BUSY/);
  await h.emit(h.telemetry(256)); await h.emit(h.window()); await present(h); await outcome;
  await assert.rejects(h.port.commitPlayback(h.input), /STALE_PLAYBACK_REVISION/);
});

test('two windows share one lock and transfer only after old audio stop completes', async t => {
  let finish; const stopWait = new Promise(r => { finish = r; });
  const shared = locks(), a = await setup(t, {locks: shared, stopWait}), b = await setup(t, {locks: shared});
  await a.port.unlock(); await assert.rejects(b.port.unlock(), /OTHER_AUDIO_OUTPUT_ACTIVE/);
  const stopping = a.port.stop(); await b.port.reopen();
  await assert.rejects(b.port.unlock(), /OTHER_AUDIO_OUTPUT_ACTIVE/);
  finish(); await stopping; await b.port.reopen(); await b.port.unlock();
  assert.equal(b.port.read().phase, 'READY');
});

test('monitor cannot create an audio source or claim output', async t => {
  const h = await setup(t, {role: 'monitor'});
  await assert.rejects(h.port.unlock(), /OUTPUT_SCREEN_REQUIRED/);
  assert.equal(h.commits(), 0); assert.equal(h.port.read().phase, 'MONITOR');
});

test('iOS-style autoplay refusal requires another explicit gesture', async t => {
  const h = await setup(t, {resumeError: Object.assign(Error('blocked'), {name: 'NotAllowedError'})});
  await assert.rejects(h.port.unlock(), /blocked/);
  assert.equal(h.port.read().phase, 'GESTURE_REQUIRED'); assert.equal(h.commits(), 0);
});

test('no presentation callback support holds instead of claiming an actual frame', async t => {
  const h = await setup(t, {noFrameObserver: true}), {outcome} = await start(h);
  assert.match((await outcome).error.message, /VIDEO_FRAME_OBSERVER_REQUIRED/);
  assert.equal(h.commits(), 0);
});

test('timeout never turns partial audio/video into a successful ACK', async t => {
  const h = await setup(t, {ackTimeoutMs: 30}), {outcome} = await start(h);
  assert.match((await outcome).error.message, /ACTUAL_AV_ACK_TIMEOUT/);
  assert.equal(h.port.read().playbackRevision, 0);
});

test('verified preparation does not consume the actual presentation ACK budget', async t => {
  let h;
  h = await setup(t, {ackTimeoutMs: 100, prepareTimeoutMs: 1000,
    resolveMedia: async () => { await new Promise(r => setTimeout(r, 150)); return h.media; }});
  const {outcome} = await start(h);
  assert.equal(h.commits(), 1);
  await h.emit(h.telemetry(256)); await h.emit(h.window()); await present(h);
  assert.equal((await outcome).ack.actual, true);
});

test('a stalled preparation remains bounded and cannot commit late media', async t => {
  let release;
  const h = await setup(t, {ackTimeoutMs: 100, prepareTimeoutMs: 30,
    resolveMedia: () => new Promise(r => { release = r; })});
  const {outcome} = await start(h);
  assert.match((await outcome).error.message, /PLAYBACK_PREPARE_TIMEOUT/);
  release(h.media); await turn();
  assert.equal(h.commits(), 0); assert.equal(h.port.read().playbackRevision, 0);
});

test('independently authorized media overlaps the guard but a rejected guard cannot commit',async t=>{
  let finishGuard,mediaStarted=false;
  const h=await setup(t,{parallelAuthorizedMedia:true,guard:()=>new Promise(r=>{finishGuard=r;}),
    resolveMedia:async()=>{mediaStarted=true;return h.media;}});
  await h.port.unlock();const result=h.port.commitPlayback(h.input).catch(error=>error);
  await until(()=>mediaStarted&&finishGuard);await turn();
  assert.equal(h.commits(),0);assert.equal(h.videos.length,0);
  finishGuard(false);assert.match((await result).message,/STALE_PLAYBACK_GUARD/);
  assert.equal(h.commits(),0);assert.equal(h.releases(),1);
});

for (const kind of ['underrun', 'regression', 'second source', 'suspended']) test(`HOLD on ${kind}`, async t => {
  const h = await setup(t), {outcome} = await start(h);
  await h.emit(h.telemetry(128));
  if (kind === 'second source') h.mutateState({sourceCount: 2});
  if (kind === 'suspended') h.mutateState({contextState: 'suspended'});
  await h.emit(h.telemetry(kind === 'regression' ? 64 : 256, {underrunFrames: kind === 'underrun' ? 128 : 0}));
  assert.match((await outcome).error.message, /ACTUAL_AUDIO_CLOCK_REQUIRED/);
});

test('late private resolver release cannot enqueue after Stop', async t => {
  let resolve, requested = false, released = 0;
  const h = await setup(t, {resolveMedia: () => { requested = true; return new Promise(r => { resolve = r; }); }});
  await h.port.unlock();
  const outcome = h.port.commitPlayback(h.input).catch(error => error);
  await until(() => requested);
  await h.port.stop(); await outcome;
  resolve({release() { released++; }}); await turn();
  assert.equal(released, 1); assert.equal(h.commits(), 0);
});

test('a graph that fails to stop retains the cross-window lock', async t => {
  const shared = locks();
  const h = await setup(t, {locks: shared, stopError: Error('stop failed')});
  // This deliberate failing engine cannot be disposed; remove its auto cleanup hook.
  await h.port.unlock();
  await assert.rejects(h.port.stop(), /stop failed/);
  const other = await setup(t, {locks: shared});
  await assert.rejects(other.port.unlock(), /OTHER_AUDIO_OUTPUT_ACTIVE/);
  assert.equal(h.port.read().reason, 'STOP_FAILED_OUTPUT_LOCK_RETAINED');
  h.engine.stop = async () => {};
});

test('monitor status requires no audio graph', async () => {
  const port = createBrowserCommitPlayback({role: 'monitor'});
  assert.equal(port.read().phase, 'MONITOR');
  await assert.rejects(port.unlock(), /OUTPUT_SCREEN_REQUIRED/);
  await port.dispose();
});

test('portrait decoded video cannot produce the 16:9 ACK', async t => {
  const h = await setup(t), {outcome} = await start(h);
  for (const v of h.videos) { v.videoWidth = 720; v.videoHeight = 1280; }
  await h.emit(h.telemetry(256)); await h.emit(h.window()); await present(h);
  assert.match((await outcome).error.message, /MUTED_16_9_VIDEO_REQUIRED/);
});

function containedPortraitCue(){
 const c=cue();c.video.compositionQC={passed:true,manifestSha256:hash,
  clips:[{clipId:'clip',sha256:hash,measurement:{fullyDecoded:true,rawSha256:hash,width:768,height:1152}}],
  timeline:{version:'accepted-video-timeline-v1',fit:'contain',muted:true,width:1280,height:720,
    segments:c.video.timeline.segments.map(s=>({clipId:s.assetId,startSeconds:s.startSeconds,endSeconds:s.endSeconds,
      inSeconds:s.sourceInSeconds,outSeconds:s.sourceOutSeconds}))}};
 return c;
}
test('approved portrait source presents in its measured muted 16:9 contain canvas',async t=>{
 const h=await setup(t,{cue:containedPortraitCue()}),{outcome}=await start(h);
 for(const v of h.videos){v.videoWidth=768;v.videoHeight=1152;}
 await h.emit(h.telemetry(256));await h.emit(h.window());await present(h);
 assert.equal((await outcome).ack.videoPresented,true);
 const observed=h.port.readObservationVideo();assert.deepEqual(observed.readPresentation(),{width:1280,height:720});
 h.videos.find(v=>!v.paused).getBoundingClientRect=()=>({width:720,height:1280});
 assert.equal(observed.readPresentation(),null);
});
test('verified nonsquare pixels use the approved contain display rather than encoded QC dimensions',async t=>{
 const c=containedPortraitCue();Object.assign(c.video.compositionQC.clips[0].measurement,{width:640,height:360});
 const h=await setup(t,{cue:c}),{outcome}=await start(h);
 for(const v of h.videos){v.videoWidth=240;v.videoHeight=360;}
 await h.emit(h.telemetry(256));await h.emit(h.window());await present(h);
 assert.equal((await outcome).ack.videoPresented,true);
 assert.deepEqual(h.port.readObservationVideo().readPresentation(),{width:1280,height:720});
});
for(const invalid of ['manifest','pixels','fit','canvas','element','muted','source'])test('contained portrait rejects changed '+invalid,async t=>{
 const c=containedPortraitCue(),options={cue:c};
 if(invalid==='manifest')c.video.compositionQC.manifestSha256='c'.repeat(64);
 if(invalid==='pixels')c.video.compositionQC.clips[0].measurement.rawSha256='c'.repeat(64);
 if(invalid==='fit')c.video.compositionQC.timeline.fit='cover';
 if(invalid==='canvas')options.outputBox={width:720,height:1280};
 if(invalid==='element')options.videoBox={width:720,height:1280};
 const h=await setup(t,options),{outcome}=await start(h);
 for(const v of h.videos){v.videoWidth=768;v.videoHeight=1152;}
 await h.emit(h.telemetry(256));await h.emit(h.window());
 await until(()=>h.videos.some(v=>v.frames.size));
 if(invalid==='muted')for(const v of h.videos)v.muted=false;
 if(invalid==='source')for(const v of h.videos)v.src='blob:unbound-synthetic';
 await present(h);assert.match((await outcome).error.message,/MUTED_16_9_VIDEO_REQUIRED/);
});

for (const interruptedState of ['suspended', 'interrupted']) test(`native context ${interruptedState} without another worklet message holds an acknowledged cue and releases its visual lifecycle`, async t => {
  const h = await setup(t); await ack(h);
  assert.equal(h.port.read().phase, 'PLAYING'); assert.equal(h.contextWatchCount(), 1);
  // Suspended contexts no longer process PCM and cannot emit the telemetry that
  // the audio observer normally relies on. Dispatch only the native state event.
  h.contextStateChange(interruptedState);
  assert.equal(h.port.read().phase, 'HOLD'); assert.equal(h.port.read().reason, 'ACTUAL_AUDIO_CLOCK_REQUIRED');
  await until(() => h.stops() === 1);
  assert.equal(h.port.read().playbackRevision, 1); assert.equal(h.port.read().audioStarted, false);
  assert.equal(h.contextWatchCount(), 0); assert.ok(h.videos.every(v => v.removed));
  await assert.rejects(h.port.unlock(), /REOPEN_REQUIRED/);
  await h.port.reopen(); await h.port.unlock(); assert.equal(h.port.read().phase, 'READY');
});

test('native context closure cancels private media preparation without needing new PCM telemetry', async t => {
  let resolve, requested = false, released = 0;
  const h = await setup(t, {resolveMedia: () => {requested = true; return new Promise(r => {resolve = r;});}});
  await h.port.unlock(); const pending = h.port.commitPlayback(h.input).then(ack => ({ack}), error => ({error}));
  await until(() => requested); assert.equal(h.port.read().phase, 'PREPARING');
  h.contextStateChange('closed');
  const outcome = await pending; assert.equal(outcome.error.message, 'ACTUAL_AUDIO_CLOCK_REQUIRED');
  assert.equal(h.port.read().phase, 'HOLD'); assert.equal(h.commits(), 0); assert.equal(h.port.read().playbackRevision, 0);
  resolve({release() {released++;}}); await until(() => released === 1);
});

test('internal ownerStop state events do not cause another HOLD or release the lease before silence', async t => {
  let finish; const stopWait = new Promise(resolve => {finish = resolve;});
  const shared = locks(), a = await setup(t, {locks: shared, stopWait, emitContextOnStop: true}), b = await setup(t, {locks: shared});
  await ack(a); const eventIndex = a.events.length, stopping = a.port.stop('OWNER_STOP');
  await until(() => a.stops() === 1);
  assert.equal(a.port.read().phase, 'STOPPED'); assert.equal(a.port.read().reason, 'OWNER_STOP');
  assert.equal(a.contextWatchCount(), 0); assert.equal(a.events.slice(eventIndex).includes('HOLD'), false);
  await assert.rejects(b.port.unlock(), /OTHER_AUDIO_OUTPUT_ACTIVE/);
  finish(); await stopping; await b.port.reopen(); await b.port.unlock();
  assert.equal(b.port.read().phase, 'READY'); assert.equal(a.stops(), 1);
});
