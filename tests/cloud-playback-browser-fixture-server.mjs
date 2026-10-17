import {createServer} from 'node:http';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Disposable synthetic-only local UI fixture. This is never part of the public
// build or an auth/proxy endpoint, and accepts no keys or arbitrary media paths.
const host = '127.0.0.1', port = 8892, origin = `http://${host}:${port}`, rate = 44100;
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'vdj-browser-synthetic-'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pcm = new Float32Array(rate * 24 * 2);
for (let i = 0; i < rate * 24; i++) pcm[i * 2] = pcm[i * 2 + 1] = Math.sin(2 * Math.PI * 220 * i / rate) * .015;
const audio = Buffer.from(pcm.buffer), videoPath = join(work, 'fixture.mp4');
await promisify(execFile)(process.env.VDJ_FIXTURE_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '24', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-preset', 'ultrafast', '-crf', '30', '-movflags', '+faststart', videoPath]);
const video = await readFile(videoPath), roomId = '11111111-1111-4111-8111-111111111111';
const intent = 'b'.repeat(64), audioSha = digest(audio), videoSha = digest(video), evidencePath = join(work, 'browser-evidence.json');
const cue = {roomId, cueId: 'cue-fixture', generationId: 'generation-fixture', submissionId: 'submission-fixture',
  commonIntentSha256: intent, controlVersion: 1, atomicReady: true, status: 'READY'};
for (const channel of ['music', 'video']) cue[channel] = {status: 'QC_READY', qc: {passed: true}, durationSeconds: 24,
  asset: {assetId: channel + '-fixture', sha256: channel === 'music' ? audioSha : videoSha},
  binding: {roomId, cueId: cue.cueId, generationId: cue.generationId, submissionId: cue.submissionId,
    commonIntentSha256: intent, controlVersion: 1, channel}};
cue.video.review = {accepted: true, ownerArtisticApproval: true, assetSha256: videoSha, commonIntentSha256: intent};
cue.video.compositionQC = {passed: true};
cue.video.clips = [{assetId: 'video-fixture', sha256: videoSha, durationSeconds: 24}];
cue.video.timeline = {durationSeconds: 24, timeStretch: false, segments: [{assetId: 'video-fixture', sha256: videoSha,
  startSeconds: 0, endSeconds: 24, sourceInSeconds: 0, sourceOutSeconds: 24, playbackRate: 1}]};
const manifest = {roomId, cue, plan: {cueId: cue.cueId, transition: {entryFrame: 0, exitFrame: 0, editStartFrame: 0,
  renderedSha256: audioSha}}, audio: {assetId: 'music-fixture', sha256: audioSha, renderedPcmSha256: audioSha,
  sampleRate: rate, startFrame: 0, durationFrames: rate * 24, byteLength: audio.byteLength,
  expectedPlayedWindowSha256: digest(audio.subarray(0, 256 * 8))},
  video: {assetId: 'video-fixture', sha256: videoSha, byteLength: video.byteLength, mimeType: 'video/mp4'}};
function wave(raw) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(raw.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 8, 28); header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(raw.length, 40);
  return Buffer.concat([header, raw]);
}
const seedWave = wave(audio), seedFileSha = digest(seedWave), contextSha = digest(wave(audio.subarray(8 * rate * 8)));
const incoming = new Float32Array(rate * 24 * 2);
for (let i = 0; i < rate * 24; i++) incoming[i * 2] = incoming[i * 2 + 1] = Math.sin(2 * Math.PI * 330 * i / rate) * .015;
const incomingBytes = Buffer.from(incoming.buffer), incomingSha = digest(incomingBytes), renderBytes = Buffer.concat([audio, incomingBytes]), renderSha = digest(renderBytes);
const seedManifest = structuredClone(manifest);
seedManifest.cue.music.asset.sha256 = incomingSha;
seedManifest.plan.transition = {entryFrame: 0, exitFrame: rate * 24, editStartFrame: rate * 20, renderedSha256: renderSha};
seedManifest.audio = {...manifest.audio, sha256: incomingSha, renderedPcmSha256: renderSha, startFrame: rate * 24, durationFrames: rate * 48,
  expectedPlayedWindowSha256: digest(incomingBytes.subarray(0, 256 * 8))};
seedManifest.renderAsset = {assetId: 'render-fixture', sha256: renderSha, byteLength: renderBytes.byteLength};
seedManifest.seed = {descriptor: {assetId: 'seed-fixture', sha256: seedFileSha, byteLength: seedWave.byteLength,
  mimeType: 'audio/wav', pcmSha256: audioSha}, source: {actual: false, clipId: 'seed-fixture', sha256: seedFileSha,
    contextSha256: contextSha, playbackRevision: 0, frameCount: rate * 24},
  firstPlan: {status: 'ELIGIBLE', currentClipId: 'seed-fixture', currentSha256: seedFileSha, currentContextSha256: contextSha,
    currentPlaybackRevision: 0, planSha256: 'c'.repeat(64), transition: {...seedManifest.plan.transition}}};
const files = new Map([
  ['/fixture.mjs', 'tests/cloud-playback-browser-fixture.mjs'],
  ['/cloud-playback.mjs', 'room-web/cloud-playback.mjs'], ['/cloud-playback-media.mjs', 'room-web/cloud-playback-media.mjs'],
  ['/cloud-output-bridge.mjs', 'room-web/cloud-output-bridge.mjs'], ['/owner-cue-host.mjs', 'room-web/owner-cue-host.mjs'],
  ['/cloud-output-credit.mjs', 'room-web/cloud-output-credit.mjs'],
  ['/cloud-initial-audio.mjs', 'room-web/cloud-initial-audio.mjs'],
  ['/playback/commit-playback.mjs', 'room-web/playback/commit-playback.mjs'],
  ['/playback/worklet-engine.mjs', 'room-web/playback/worklet-engine.mjs'],
  ['/playback/clip-timeline.mjs', 'room-web/playback/clip-timeline.mjs'],
  ['/playback/output-lease.mjs', 'room-web/playback/output-lease.mjs'],
  ['/playback/cue-contract.mjs', 'room-web/playback/cue-contract.mjs'],
  ['/scene-video-adapter.mjs', 'snapshot/ui/app/scene-video-adapter.mjs'],
  ['/src/motif-contract.mjs', 'snapshot/ui/src/motif-contract.mjs'],
  ['/room-worklet.mjs', 'snapshot/app/room-worklet.mjs'],
]);
const html = role => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>VDJ synthetic browser ${role}</title><link rel="stylesheet" href="/fixture.css"></head><body data-role="${role}"><main><h1>VDJ synthetic browser ${role}</h1><p>Disposable local fixture. No account, provider, real media, or physical speaker synchronization claim.</p><div id="buttons"></div><div id="video"></div><p id="fixture-credit" class="fixture-credit" role="status" hidden></p><p id="status" role="status">Preparing fixture.</p><pre id="evidence"></pre></main><script type="module" src="/fixture.mjs"></script></body></html>`;
const css = 'body{background:#0c1424;color:#eef4ff;font:16px system-ui;margin:0}main{padding:24px;max-width:1100px;margin:auto}button{padding:12px 20px;margin:8px;background:#294f78;color:white;border:1px solid #96bfd9;border-radius:6px;font:inherit}button:disabled{opacity:.4}#video{position:relative;aspect-ratio:16/9;background:black;width:min(800px,100%);overflow:hidden}body[data-role=owner] #video{display:none}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#9adcca}p{line-height:1.5}';
const creditCSS = '.fixture-credit{position:fixed;left:50%;bottom:20%;transform:translateX(-50%);z-index:20;border:1px solid #8fe9cf;background:#091522e8;color:white;padding:14px 24px;border-radius:12px;font-size:36px}.fixture-credit[hidden]{display:none}';
let evidence = null;
const server = createServer(async (req, res) => {
  try {
    const target = new URL(req.url, origin);
    if (req.headers.host !== `${host}:${port}` || target.origin !== origin || target.search || target.hash) { res.writeHead(400); res.end(); return; }
    const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self';script-src 'self';style-src 'self';media-src 'self' blob:;connect-src 'self';object-src 'none';base-uri 'none';frame-ancestors 'none'"};
    const send = (body, type) => { res.writeHead(200, {...headers, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body))}); res.end(body); };
    if (req.method === 'POST' && target.pathname === '/fixture-evidence') {
      if (req.headers.origin !== origin) { res.writeHead(403); res.end(); return; }
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 64 * 1024) throw Error('evidence size'); chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString());
      if (value.fixture !== 'synthetic-browser-v1' || value.physicalSpeakerVerified !== false ||
          Object.keys(value).some(k => !['fixture', 'physicalSpeakerVerified', 'browser', 'secureContext', 'sampleRate', 'ack',
            'processedWindow', 'videoFrames', 'states', 'guards', 'checks', 'events', 'error', 'seedAck', 'seedStates', 'restartAck'].includes(k)) ||
          /authorization|bearer|ownerToken|ownerCapability|signedUrl|apiKey/i.test(JSON.stringify(value))) throw Error('evidence schema');
      evidence = value; await writeFile(evidencePath, JSON.stringify(evidence, null, 2)); send('{"saved":true}', 'application/json'); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (['/fixture-owner', '/fixture-output', '/fixture-seed-owner', '/fixture-seed-output'].includes(target.pathname)) { send(html(target.pathname.slice(9)), 'text/html; charset=utf-8'); return; }
    if (target.pathname === '/fixture.css') { send(css + creditCSS, 'text/css'); return; }
    if (target.pathname === '/fixture-manifest') { send(JSON.stringify(manifest), 'application/json'); return; }
    if (target.pathname === '/fixture-seed-manifest') { send(JSON.stringify(seedManifest), 'application/json'); return; }
    if (target.pathname === '/fixture-seed') { send(seedWave, 'audio/wav'); return; }
    if (target.pathname === '/fixture-render') { send(renderBytes, 'application/vnd.ai-vdj.pcm-f32le'); return; }
    if (target.pathname === '/fixture-audio') { send(audio, 'application/vnd.ai-vdj.pcm-f32le'); return; }
    if (target.pathname === '/fixture-video') { send(video, 'video/mp4'); return; }
    if (target.pathname === '/fixture-evidence') { send(JSON.stringify(evidence ?? {pending: true}), 'application/json'); return; }
    if (files.has(target.pathname)) { send(await readFile(join(root, files.get(target.pathname))), 'text/javascript; charset=utf-8'); return; }
    res.writeHead(404, headers); res.end();
  } catch { res.writeHead(400); res.end('Invalid fixture request'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
console.log(JSON.stringify({fixture: 'synthetic-browser-v1', origin, owner: origin + '/fixture-owner', evidencePath,
  audioBytes: audio.byteLength, videoBytes: video.byteLength, audioSha256: audioSha, videoSha256: videoSha}));
async function stop() { server.close(); await rm(work, {recursive: true, force: true}); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
