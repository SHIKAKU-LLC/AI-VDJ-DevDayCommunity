import test from 'node:test';
import assert from 'node:assert/strict';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';
import {createCloudMediaResolver, decodeCloudRender} from '../room-web/cloud-playback-media.mjs';
import {createCloudPlaybackAdapter} from '../room-web/cloud-playback.mjs';
import {createVideoAdapter} from '../snapshot/ui/app/scene-video-adapter.mjs';

const RATE = 44100, roomId = '11111111-1111-4111-8111-111111111111';
const intent = 'b'.repeat(64), hash = 'a'.repeat(64), videoBytes = new Uint8Array([1, 2, 3, 4]);
const pcm = new Float32Array(RATE * 24 * 2).fill(.1), pcmBytes = new Uint8Array(pcm.buffer);
const pcmHash = await pcmSha256(pcm), windowHash = await pcmSha256(pcm.subarray(0, 512)), videoHash = await pcmSha256(videoBytes);
function fixture() {
  const cue = {roomId, cueId: 'cue-1', generationId: 'generation-1', submissionId: 'submission-1',
    commonIntentSha256: intent, controlVersion: 2, atomicReady: true, status: 'READY'};
  for (const channel of ['music', 'video']) cue[channel] = {status: 'QC_READY', qc: {passed: true}, durationSeconds: 24,
    binding: {roomId, generationId: cue.generationId, submissionId: cue.submissionId, commonIntentSha256: intent, controlVersion: 2, channel},
    asset: {assetId: channel + '-1', sha256: hash}};
  cue.video.review = {accepted: true, ownerArtisticApproval: true, assetSha256: hash, commonIntentSha256: intent};
  cue.video.compositionQC = {passed: true};
  cue.video.clips = [{assetId: 'clip-1', sha256: videoHash, durationSeconds: 24}];
  cue.video.timeline = {durationSeconds: 24, timeStretch: false,
    segments: [{assetId: 'clip-1', sha256: videoHash, startSeconds: 0, endSeconds: 24, sourceInSeconds: 0, sourceOutSeconds: 24, playbackRate: 1}]};
  const plan = {cueId: cue.cueId, transition: {entryFrame: 0, exitFrame: 0, editStartFrame: 0, renderedSha256: pcmHash}};
  const input = {roomId, cue, plan, expectedRevision: 1, guard: async () => true};
  const manifest = {roomId, cueId: cue.cueId, generationId: cue.generationId, submissionId: cue.submissionId,
    commonIntentSha256: intent, controlVersion: 2,
    audio: {assetId: 'music-1', sha256: hash, render: {assetId: 'render-1', sha256: pcmHash,
      byteLength: pcm.byteLength, mimeType: 'application/vnd.ai-vdj.pcm-f32le', renderedFileSha256: pcmHash,
      renderedPcmSha256: pcmHash, expectedPlayedWindowSha256: windowHash, sampleRate: RATE, startFrame: 0, durationFrames: RATE * 24}},
    videos: [{assetId: 'clip-1', sha256: videoHash, byteLength: 4, mimeType: 'video/mp4', source: 'fake', requestId: 'fixture-video-1'}]};
  const calls = [], urls = [], revoked = [];
  const request = async (path, options) => {
    calls.push({path, options}); const render = path.includes('/render-1?');
    return new Response(render ? pcmBytes : videoBytes, {headers: {'Content-Type': render ? manifest.audio.render.mimeType : 'video/mp4'}});
  };
  const options = {origin: 'https://vdj.example', request, resolveManifest: async () => manifest,
    urlAPI: {createObjectURL(blob) { const value = 'blob:fixture-' + urls.length; urls.push({value, blob}); return value; }, revokeObjectURL(url) { revoked.push(url); }}};
  return {input, manifest, calls, urls, revoked, options};
}

test('cloud resolver binds SHA/byte counts and full render geometry through same-origin owner request closure', async () => {
  const f = fixture(), resolver = createCloudMediaResolver(f.options), media = await resolver.resolveMedia(f.input);
  assert.equal(f.calls.length, 2);
  for (const {path, options} of f.calls) {
    assert.ok(path.startsWith('/api/rooms/' + roomId + '/media/'));
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers, undefined);
  }
  const render = await resolver.loadVerifiedRender({media: media.audio});
  assert.equal(await pcmSha256(render.pcm), pcmHash); assert.equal(render.durationFrames, 24 * RATE);
  assert.equal(media.videos[0].url, 'blob:fixture-0'); media.release(); media.release();
  assert.deepEqual(f.revoked, ['blob:fixture-0']);
  await assert.rejects(resolver.loadVerifiedRender({media: media.audio}), /NOT_PREPARED/);
});

function useOwnerVideo(f){const video=f.manifest.videos[0];delete video.requestId;
 video.source='owner-supplied-bootstrap-video';video.admissionId='owner-admission';video.admissionEvidenceSha256='d'.repeat(64);return video;}
test('cloud resolver retains admitted owner provenance without a provider request ID and rejects mixed origin fields',async()=>{
 const f=fixture(),video=useOwnerVideo(f),media=await createCloudMediaResolver(f.options).resolveMedia(f.input);
 assert.equal(media.videos[0].source,video.source);assert.equal(media.videos[0].admissionId,video.admissionId);
 assert.equal('requestId' in media.videos[0],false);media.release();
 for(const mutate of [v=>delete v.admissionId,v=>v.admissionEvidenceSha256='bad',v=>v.requestId='fabricated-provider',
  v=>v.source='fal']){
  const bad=fixture();mutate(useOwnerVideo(bad));await assert.rejects(createCloudMediaResolver(bad.options).resolveMedia(bad.input),/VIDEO_BINDING/);
  assert.equal(bad.calls.length,0);
 }
});

for (const [label, change] of [
  ['generation mismatch', f => { f.manifest.generationId = 'generation-2'; }],
  ['arbitrary remote URL', f => { f.manifest.videos[0].url = 'https://bad.example/fixture'; }],
  ['render plan mismatch', f => { f.manifest.audio.render.renderedFileSha256 = hash; }],
  ['oversize descriptor', f => { f.manifest.videos[0].byteLength = 33 * 1024 * 1024; }],
  ['wrong video binding', f => { f.manifest.videos[0].sha256 = hash; }],
  ['partial AV', f => { f.input.cue.video.status = 'WAIT_QC'; }],
]) test(`rejects ${label} before fetching bytes`, async () => {
  const f = fixture(); change(f);
  await assert.rejects(createCloudMediaResolver(f.options).resolveMedia(f.input)); assert.equal(f.calls.length, 0);
});

test('wrong media SHA, type, length and redirects fail without any presentation URL', async () => {
  for (const kind of ['sha', 'mime', 'length', 'redirect']) {
    const f = fixture();
    f.options.request = async () => {
      if (kind === 'redirect') return {ok: true, redirected: true};
      return new Response(kind === 'length' ? pcmBytes.subarray(0, 10) : kind === 'sha' ? new Uint8Array(pcm.byteLength) : pcmBytes,
        {headers: {'Content-Type': kind === 'mime' ? 'audio/mpeg' : 'application/vnd.ai-vdj.pcm-f32le'}});
    };
    await assert.rejects(createCloudMediaResolver(f.options).resolveMedia(f.input)); assert.equal(f.urls.length, 0);
  }
});

test('stream bound cancels an oversized body before collecting it; cancellation never retains URLs', async () => {
  const f = fixture(); let cancelled = 0;
  f.manifest.audio.render.byteLength = 1;
  f.options.request = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2)); }, cancel() { cancelled++; }}),
  {headers: {'Content-Type': f.manifest.audio.render.mimeType}});
  await assert.rejects(createCloudMediaResolver(f.options).resolveMedia(f.input), /SIZE_LIMIT/);
  assert.equal(cancelled, 1); assert.equal(f.urls.length, 0);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createCloudMediaResolver(f.options).resolveMedia({...f.input, signal: abort.signal}), /CANCELLED/);
});

test('an asset failure revokes every temporary object URL already allocated', async () => {
  const f = fixture(); f.input.cue.video.clips.push({assetId: 'clip-2', sha256: videoHash, durationSeconds: 24});
  f.manifest.videos.push({...f.manifest.videos[0], assetId: 'clip-2'});
  const request = f.options.request;
  f.options.request = (path, options) => path.includes('/clip-2?') ? Promise.reject(Error('fixture missing')) : request(path, options);
  await assert.rejects(createCloudMediaResolver(f.options).resolveMedia(f.input), /fixture missing/);
  assert.deepEqual(f.revoked, ['blob:fixture-0']);
});

test('only an HTTPS non-localhost origin is accepted, even in synthetic fixtures', () => {
  for (const origin of ['http://vdj.example', 'https://localhost', 'https://127.0.0.1', 'https://vdj.example/path'])
    assert.throws(() => createCloudMediaResolver({...fixture().options, origin}), /HTTPS_ORIGIN_REQUIRED/);
});

test('WAV PCM16 and float32 decode exact stereo frames and reject invalid channel layouts', () => {
  for (const format of [1, 3]) {
    const bits = format === 1 ? 16 : 32, frames = 256, bytes = new Uint8Array(44 + frames * 2 * bits / 8), d = new DataView(bytes.buffer);
    const tag = (at, value) => [...value].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
    tag(0, 'RIFF'); d.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); d.setUint32(16, 16, true);
    d.setUint16(20, format, true); d.setUint16(22, 2, true); d.setUint32(24, RATE, true); d.setUint32(28, RATE * bits / 8 * 2, true);
    d.setUint16(32, bits / 8 * 2, true); d.setUint16(34, bits, true); tag(36, 'data'); d.setUint32(40, bytes.length - 44, true);
    for (let i = 0; i < frames * 2; i++) format === 1 ? d.setInt16(44 + i * 2, 16384, true) : d.setFloat32(44 + i * 4, .5, true);
    assert.ok(decodeCloudRender(bytes, {mimeType: 'audio/wav', durationFrames: frames}).every(v => v === .5));
    d.setUint16(22, 1, true); assert.throws(() => decodeCloudRender(bytes, {mimeType: 'audio/wav', durationFrames: frames}), /WAVE_INVALID/);
  }
});

test('default production gate and distinct owner role never construct any audio graph or fetch media', async () => {
  let graphs = 0; const createAudioEngine = () => { graphs++; throw Error('forbidden'); };
  for (const options of [{enabled: false, role: 'output'}, {enabled: true, role: 'owner'}]) {
    const port = createCloudPlaybackAdapter({...options, createAudioEngine});
    await assert.rejects(port.unlock(), /ACTIVATION_GATED/); await assert.rejects(port.commitPlayback(fixture().input), /ACTIVATION_GATED/);
    assert.equal(port.read().phase, 'MONITOR'); await port.dispose();
  }
  assert.equal(graphs, 0);
});

for(const ownerVideo of [false,true])test(`injected sole engine and real video adapter wait for processed PCM and ${ownerVideo?'admitted owner':'provider'} video frame presentation before cloud ACK`, async t => {
  const f = fixture(), listeners = new Set(), videos = []; let commits = 0, sourceCount = 1, contextState = 'suspended';
  if(ownerVideo)useOwnerVideo(f);
  class Video {
    constructor() { this.style = {}; this.videoWidth = 1280; this.videoHeight = 720; this.readyState = 3; this.currentTime = 0; this.frames = new Map(); this.next = 0; }
    setAttribute() {} removeAttribute(k) { if (k === 'src') delete this.src; }
    get currentSrc(){return this.src;}
    addEventListener() {} removeEventListener() {} load() {} pause() {} remove() {} play() { return Promise.resolve(); }
    requestVideoFrameCallback(fn) { this.frames.set(++this.next, fn); return this.next; }
    cancelVideoFrameCallback(n) { this.frames.delete(n); }
    present() { for (const [n, fn] of this.frames) { this.frames.delete(n); fn(0, {}); } }
  }
  const port = createCloudPlaybackAdapter({...f.options, enabled: true, fixtureMode: true,
    lifecycle: {addEventListener() {}, removeEventListener() {}}, container: {append() {}},
    outputLease: {async acquire() { return this.token = {active: true, release() { this.active = false; }}; }, isOwner(token) { return token === this.token && token.active; }},
    createAudioEngine: ({loadVerifiedRender}) => ({context: {resume() { contextState = 'running'; return Promise.resolve(); }},
      readState: () => ({contextState, sourceCount}), prepare: loadVerifiedRender,
      async commit() { commits++; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async stop() { contextState = 'suspended'; sourceCount = 0; }}),
    createVideoAdapter: options => createVideoAdapter({...options, crossfadeMs: 0, fetchImpl() { throw Error('fixture network forbidden'); }}),
    videoFactory: () => { const video = new Video(); videos.push(video); return video; }});
  t.after(() => port.dispose()); await port.unlock();
  let done = false; const playback = port.commitPlayback(f.input).then(ack => { done = true; return ack; });
  async function until(fn) { for (let i = 0; i < 3000; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 1)); } assert.fail('synthetic output did not advance'); }
  await until(() => commits === 1); assert.equal(done, false);
  for (const fn of listeners) fn({telemetry: {sampleRate: RATE, consumedFrames: 256, underrunFrames: 0}});
  for (const fn of listeners) fn({playedWindow: {startFrame: 0, pcm: pcm.slice(0, 512).buffer}});
  await until(() => videos.some(v => v.frames.size)); assert.equal(done, false);
  videos.forEach(v => v.present());
  const ack = await playback;
  assert.deepEqual(ack, {roomId, cueId: f.input.cue.cueId, clipId: 'music-1', playbackRevision: 1,
    audioTime: 256 / RATE, actual: true, audioStarted: true, videoPresented: true});
  assert.equal(port.read().sourceCount, 1); assert.equal(port.read().fixtureMode, true);
  assert.ok(videos.every(v => v.muted && v.volume === 0));
});

export {fixture};
