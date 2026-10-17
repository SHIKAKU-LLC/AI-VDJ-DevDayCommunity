import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {gzipSync, gunzipSync} from 'node:zlib';

const RATE = 44100, sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const STATIC_BROWSER_MODULES = Object.freeze({
  'cloud-playback.mjs': 'room-web/cloud-playback.mjs', 'cloud-playback-media.mjs': 'room-web/cloud-playback-media.mjs',
  'cloud-output-bridge.mjs': 'room-web/cloud-output-bridge.mjs', 'cloud-output-credit.mjs': 'room-web/cloud-output-credit.mjs',
  'cloud-initial-audio.mjs': 'room-web/cloud-initial-audio.mjs', 'owner-cue-host.mjs': 'room-web/owner-cue-host.mjs',
  'playback/commit-playback.mjs': 'room-web/playback/commit-playback.mjs',
  'playback/worklet-engine.mjs': 'room-web/playback/worklet-engine.mjs',
  'playback/clip-timeline.mjs': 'room-web/playback/clip-timeline.mjs',
  'playback/output-lease.mjs': 'room-web/playback/output-lease.mjs', 'playback/cue-contract.mjs': 'room-web/playback/cue-contract.mjs',
  'scene-video-adapter.mjs': 'snapshot/ui/app/scene-video-adapter.mjs',
  'src/motif-contract.mjs': 'snapshot/ui/src/motif-contract.mjs', 'room-worklet.mjs': 'snapshot/app/room-worklet.mjs',
});
export const STATIC_BROWSER_FILES = Object.freeze([...Object.keys(STATIC_BROWSER_MODULES), 'fixture.mjs', 'fixture.css',
  'index.html', 'fixture-owner.html', 'fixture-output.html', 'fixture-seed-owner.html', 'fixture-seed-output.html',
  'fixture-manifest.json', 'fixture-seed-manifest.json', 'fixture-audio.f32.gz', 'fixture-render.f32.gz', 'fixture-seed.wav.gz',
  'fixture-video.mp4', 'vercel.json', 'fixture-bundle.json']);
export const STATIC_MULTI_CUE_FILES = Object.freeze(['fixture-multi-owner.html', 'fixture-multi-output.html',
  'fixture-multi-manifest.json', 'fixture-render-2.f32.gz', 'fixture-render-3.f32.gz']);

export async function inflateStaticFixtureAsset({response, expectedBytes, isGzip,
  decompressor = globalThis.DecompressionStream} = {}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > 180 * 44100 * 8 + 44 ||
      !response?.ok || response.redirected || !response.body?.getReader) throw Error('STATIC_FIXTURE_ASSET_BOUND_REQUIRED');
  let body = response.body;
  if (isGzip) {
    if (typeof decompressor !== 'function') throw Error('STATIC_FIXTURE_GZIP_UNSUPPORTED');
    let compressedBytes = 0;
    body = body.pipeThrough(new TransformStream({transform(chunk, controller) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > 512 * 1024) throw Error('STATIC_FIXTURE_GZIP_SIZE_LIMIT');
      controller.enqueue(chunk);
    }})).pipeThrough(new decompressor('gzip'));
  }
  const reader = body.getReader(), chunks = []; let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array) || total + value.byteLength > expectedBytes) throw Error('STATIC_FIXTURE_INFLATED_SIZE_LIMIT');
      chunks.push(value); total += value.byteLength;
    }
    if (total !== expectedBytes) throw Error('STATIC_FIXTURE_INFLATED_LENGTH_MISMATCH');
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export function staticBrowserRuntime(source) {
  function replaceExact(before, after) {
    if (source.split(before).length !== 2) throw Error('STATIC_FIXTURE_SOURCE_CHANGED');
    source = source.replace(before, after);
  }
  replaceExact("location.origin !== 'http://127.0.0.1:8892'", "location.protocol !== 'https:' || location.origin === 'null'");
  replaceExact("if (ownerRole) await fetch('/fixture-evidence', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(evidence)});",
    "// Static preview: evidence stays in this page's visible pre; no write endpoint.\n  draw();");
  replaceExact('const bytes = await response.arrayBuffer(); if (bytes.byteLength !== descriptor.byteLength || await pcmSha256(bytes) !== descriptor.sha256) throw Error(\'ASSET_SHA\');',
    "const bytes = await readStaticFixtureAsset({response, expectedBytes: descriptor.byteLength, isGzip: data.assetId !== 'video-fixture'}); if (await pcmSha256(bytes) !== descriptor.sha256) throw Error('ASSET_SHA');");
  replaceExact('const readManifest = async () =>', 'const readStaticFixtureAsset = ' + inflateStaticFixtureAsset.toString() + ';\nconst readManifest = async () =>');
  const paths = {'/fixture-owner': '/fixture-owner.html', '/fixture-output': '/fixture-output.html',
    '/fixture-seed-owner': '/fixture-seed-owner.html', '/fixture-seed-output': '/fixture-seed-output.html',
    '/fixture-multi-owner': '/fixture-multi-owner.html', '/fixture-multi-output': '/fixture-multi-output.html',
    '/fixture-multi-manifest': '/fixture-multi-manifest.json',
    '/fixture-manifest': '/fixture-manifest.json', '/fixture-seed-manifest': '/fixture-seed-manifest.json',
    '/fixture-audio': '/fixture-audio.f32.gz', '/fixture-render': '/fixture-render.f32.gz',
    '/fixture-render-2': '/fixture-render-2.f32.gz', '/fixture-render-3': '/fixture-render-3.f32.gz',
    '/fixture-seed': '/fixture-seed.wav.gz', '/fixture-video': '/fixture-video.mp4'};
  for (const [before, after] of Object.entries(paths)) source = source.replaceAll("'" + before + "'", "'" + after + "'");
  source = source.replaceAll('vdj-synthetic-browser-output-8892', 'vdj-synthetic-static-https-output');
  if (/127\.0\.0\.1|localhost|fixture-evidence|method:\s*'POST'/.test(source)) throw Error('STATIC_FIXTURE_TRANSPORT_REMAINS');
  return source;
}
function wave(raw) {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(raw.length + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(raw.length, 40);
  return Buffer.concat([h, raw]);
}
function tone(frequency) {
  const pcm = new Float32Array(RATE * 24 * 2);
  for (let i = 0; i < RATE * 24; i++) pcm[i * 2] = pcm[i * 2 + 1] = Math.sin(2 * Math.PI * frequency * i / RATE) * .015;
  return Buffer.from(pcm.buffer);
}
export function syntheticStaticManifests({audio, video}) {
  const roomId = '11111111-1111-4111-8111-111111111111', intent = 'b'.repeat(64), audioSha = sha256(audio), videoSha = sha256(video);
  const cue = {roomId, cueId: 'cue-fixture', generationId: 'generation-fixture', submissionId: 'submission-fixture',
    commonIntentSha256: intent, controlVersion: 1, atomicReady: true, status: 'READY'};
  for (const channel of ['music', 'video']) cue[channel] = {status: 'QC_READY', qc: {passed: true}, durationSeconds: 24,
    asset: {assetId: channel + '-fixture', sha256: channel === 'music' ? audioSha : videoSha},
    binding: {roomId, cueId: cue.cueId, generationId: cue.generationId, submissionId: cue.submissionId,
      commonIntentSha256: intent, controlVersion: 1, channel}};
  cue.video.review = {accepted: true, ownerArtisticApproval: true, assetSha256: videoSha, commonIntentSha256: intent};
  cue.video.compositionQC = {passed: true}; cue.video.clips = [{assetId: 'video-fixture', sha256: videoSha, durationSeconds: 24}];
  cue.video.timeline = {durationSeconds: 24, timeStretch: false, segments: [{assetId: 'video-fixture', sha256: videoSha,
    startSeconds: 0, endSeconds: 24, sourceInSeconds: 0, sourceOutSeconds: 24, playbackRate: 1}]};
  const manifest = {roomId, cue, plan: {cueId: cue.cueId, transition: {entryFrame: 0, exitFrame: 0, editStartFrame: 0, renderedSha256: audioSha}},
    audio: {assetId: 'music-fixture', sha256: audioSha, renderedPcmSha256: audioSha, sampleRate: RATE, startFrame: 0,
      durationFrames: RATE * 24, byteLength: audio.byteLength, expectedPlayedWindowSha256: sha256(audio.subarray(0, 256 * 8))},
    video: {assetId: 'video-fixture', sha256: videoSha, byteLength: video.byteLength, mimeType: 'video/mp4'}};
  const seedBytes = wave(audio), incoming = tone(330), renderBytes = Buffer.concat([audio, incoming]);
  const seedFileSha = sha256(seedBytes), contextSha = sha256(wave(audio.subarray(8 * RATE * 8))), renderSha = sha256(renderBytes);
  const seedManifest = structuredClone(manifest); seedManifest.cue.music.asset.sha256 = sha256(incoming);
  seedManifest.plan.transition = {entryFrame: 0, exitFrame: RATE * 24, editStartFrame: RATE * 20, renderedSha256: renderSha};
  seedManifest.audio = {...manifest.audio, sha256: sha256(incoming), renderedPcmSha256: renderSha,
    startFrame: RATE * 24, durationFrames: RATE * 48, expectedPlayedWindowSha256: sha256(incoming.subarray(0, 256 * 8))};
  seedManifest.renderAsset = {assetId: 'render-fixture', sha256: renderSha, byteLength: renderBytes.byteLength};
  seedManifest.seed = {descriptor: {assetId: 'seed-fixture', sha256: seedFileSha, byteLength: seedBytes.byteLength, mimeType: 'audio/wav', pcmSha256: audioSha},
    source: {actual: false, clipId: 'seed-fixture', sha256: seedFileSha, contextSha256: contextSha, playbackRevision: 0, frameCount: RATE * 24},
    firstPlan: {status: 'ELIGIBLE', currentClipId: 'seed-fixture', currentSha256: seedFileSha, currentContextSha256: contextSha,
      currentPlaybackRevision: 0, planSha256: 'c'.repeat(64), transition: {...seedManifest.plan.transition}}};
  return {manifest, seedManifest, seedBytes, renderBytes};
}
export function syntheticMultiCueManifests({audio, video}) {
  const base = syntheticStaticManifests({audio, video}), cues = [base.seedManifest], renders = [base.renderBytes];
  for (let index = 2; index <= 3; index++) {
    const incoming = tone(index === 2 ? 440 : 550), render = Buffer.concat([renders.at(-1), incoming]);
    const next = structuredClone(base.seedManifest), cueId = 'cue-fixture-' + index, generationId = 'generation-fixture-' + index,
      submissionId = 'submission-fixture-' + index, assetId = 'music-fixture-' + index;
    Object.assign(next.cue, {cueId, generationId, submissionId});
    for (const channel of ['music', 'video']) Object.assign(next.cue[channel].binding, {cueId, generationId, submissionId});
    next.cue.music.asset = {assetId, sha256: sha256(incoming)};
    next.plan = {cueId, transition: {entryFrame: 0, exitFrame: index * 24 * RATE,
      editStartFrame: (index * 24 - 4) * RATE, renderedSha256: sha256(render)}};
    next.audio = {...base.seedManifest.audio, assetId, sha256: sha256(incoming), renderedPcmSha256: sha256(render),
      startFrame: index * 24 * RATE, durationFrames: (index + 1) * 24 * RATE,
      expectedPlayedWindowSha256: sha256(incoming.subarray(0, 256 * 8))};
    next.renderAsset = {assetId: 'render-fixture-' + index, sha256: sha256(render), byteLength: render.length};
    cues.push(next); renders.push(render);
  }
  return {package: {kind: 'synthetic-three-tail-browser-fixture-v1',
    verificationScope: 'synthetic cumulative future-queue and visual three-cue continuity; native clip-relative mapping verified separately',
    maximumDurationFrames: 180 * RATE, cues}, renders};
}
const html = role => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>VDJ synthetic HTTPS ${role}</title><link rel="stylesheet" href="/fixture.css"></head><body data-role="${role}"><main><h1 lang="en">VDJ synthetic HTTPS ${role}</h1><p lang="en">Static synthetic fixture. No account, provider, real media, or physical speaker synchronization claim.</p><div id="buttons"></div><div id="video"></div><p id="fixture-credit" class="fixture-credit" role="status" hidden></p><p id="status" role="status">Preparing fixture.</p><pre id="evidence"></pre></main><script type="module" src="/fixture.mjs"></script></body></html>`;
const css = 'body{background:#0c1424;color:#eef4ff;font:16px system-ui;margin:0}main{padding:24px;max-width:1100px;margin:auto}button{padding:12px 20px;margin:8px;background:#294f78;color:white;border:1px solid #96bfd9;border-radius:6px;font:inherit}button:disabled{opacity:.4}#video{position:relative;aspect-ratio:16/9;background:black;width:min(800px,100%);overflow:hidden}body[data-role$=owner] #video{display:none}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#9adcca}p{line-height:1.5}.fixture-credit{position:fixed;left:50%;bottom:20%;transform:translateX(-50%);z-index:20;border:1px solid #8fe9cf;background:#091522e8;color:white;padding:14px 24px;border-radius:12px;font-size:36px}.fixture-credit[hidden]{display:none}';
export const STATIC_BROWSER_CONFIG = Object.freeze({version: 2, cleanUrls: false, headers: [{source: '/(.*)', headers: [
  {key: 'Content-Security-Policy', value: "default-src 'none';script-src 'self';style-src 'self';media-src 'self' blob:;connect-src 'self';worker-src 'self';object-src 'none';base-uri 'none';frame-ancestors 'none';form-action 'none'"},
  {key: 'X-Content-Type-Options', value: 'nosniff'}, {key: 'Referrer-Policy', value: 'no-referrer'},
  {key: 'Cache-Control', value: 'no-store'}, {key: 'Cross-Origin-Opener-Policy', value: 'same-origin'},
  {key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()'},
]}]});

export async function verifyStaticBrowserBundle({destination, repoRoot = fileURLToPath(new URL('../', import.meta.url))}) {
  async function paths(directory, prefix = '') {
    const out = []; for (const item of await readdir(directory, {withFileTypes: true})) {
      const name = prefix + item.name; if (item.isDirectory()) out.push(...await paths(join(directory, item.name), name + '/'));
      else if (item.isFile()) out.push(name); else throw Error('STATIC_FIXTURE_NONREGULAR_FILE');
    } return out.sort();
  }
  const actual = await paths(destination);
  const metadata = JSON.parse(await readFile(join(destination, 'fixture-bundle.json'), 'utf8'));
  const allowed = [...STATIC_BROWSER_FILES, ...(metadata.multiCue === true ? STATIC_MULTI_CUE_FILES : [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed)) throw Error('STATIC_FIXTURE_ALLOWLIST_MISMATCH');
  if (metadata.kind !== 'synthetic-static-browser-https-v1' || metadata.apiRoutes.length || metadata.backendRewrites.length || metadata.containsSecrets !== false)
    throw Error('STATIC_FIXTURE_METADATA_INVALID');
  const files = metadata.files;
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(allowed.filter(name => name !== 'fixture-bundle.json'))) throw Error('STATIC_FIXTURE_MANIFEST_MISMATCH');
  for (const name of Object.keys(files)) {
    const bytes = await readFile(join(destination, name)); if (bytes.length !== files[name].byteLength || sha256(bytes) !== files[name].sha256) throw Error('STATIC_FIXTURE_FILE_SHA_MISMATCH');
  }
  for (const [name, source] of Object.entries(STATIC_BROWSER_MODULES)) {
    if (sha256(await readFile(join(destination, name))) !== sha256(await readFile(join(repoRoot, source)))) throw Error('STATIC_FIXTURE_MODULE_CHANGED');
  }
  const config = JSON.parse(await readFile(join(destination, 'vercel.json'), 'utf8'));
  if (JSON.stringify(config) !== JSON.stringify(STATIC_BROWSER_CONFIG) || config.rewrites || config.routes || config.functions) throw Error('STATIC_FIXTURE_BACKEND_CONFIG');
  const normal = JSON.parse(await readFile(join(destination, 'fixture-manifest.json'), 'utf8')),
    seed = JSON.parse(await readFile(join(destination, 'fixture-seed-manifest.json'), 'utf8'));
  const inflatedFiles = [['fixture-audio.f32.gz', normal.audio], ['fixture-render.f32.gz', seed.renderAsset], ['fixture-seed.wav.gz', seed.seed.descriptor]];
  if (metadata.multiCue === true) {
    const multi = JSON.parse(await readFile(join(destination, 'fixture-multi-manifest.json'), 'utf8'));
    if (multi.kind !== 'synthetic-three-tail-browser-fixture-v1' || multi.maximumDurationFrames !== 180 * RATE || multi.cues?.length !== 3)
      throw Error('STATIC_FIXTURE_MULTI_CUE_INVALID');
    for (let n = 1; n < 3; n++) inflatedFiles.push(['fixture-render-' + (n + 1) + '.f32.gz', multi.cues[n].renderAsset]);
  }
  for (const [name, descriptor] of inflatedFiles) {
    const zipped = await readFile(join(destination, name)); if (zipped.length > 512 * 1024) throw Error('STATIC_FIXTURE_GZIP_SIZE_LIMIT');
    const inflated = gunzipSync(zipped, {maxOutputLength: 180 * RATE * 8 + 44});
    if (inflated.length !== descriptor.byteLength || sha256(inflated) !== descriptor.sha256) throw Error('STATIC_FIXTURE_INFLATED_SHA_MISMATCH');
  }
  return {verified: true, fileCount: actual.length, bytes: Object.values(files).reduce((n, file) => n + file.byteLength, 0), metadataSha256: sha256(await readFile(join(destination, 'fixture-bundle.json')))};
}

export async function buildStaticBrowserBundle({destination = fileURLToPath(new URL('../../cloud-browser-https-preview', import.meta.url)),
  repoRoot = fileURLToPath(new URL('../', import.meta.url)), ffmpeg = 'ffmpeg', multiCue = false, codeCommit} = {}) {
  destination = resolve(destination); repoRoot = resolve(repoRoot);
  const fromRepo = relative(repoRoot, destination);
  if (fromRepo !== '..' && !fromRepo.startsWith('../')) throw Error('STATIC_FIXTURE_OUTSIDE_GIT_REQUIRED');
  await mkdir(destination, {recursive: true}); if ((await readdir(destination)).length) throw Error('STATIC_FIXTURE_EMPTY_DESTINATION_REQUIRED');
  const head = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], {cwd: repoRoot})).stdout.trim();
  if (codeCommit !== undefined && codeCommit !== head) throw Error('STATIC_FIXTURE_CODE_COMMIT_MISMATCH');
  codeCommit = head;
  if (!/^[a-f0-9]{40}$/.test(codeCommit)) throw Error('STATIC_FIXTURE_CODE_COMMIT_REQUIRED');
  async function write(name, bytes) { const path = join(destination, name); await mkdir(resolve(path, '..'), {recursive: true}); await writeFile(path, bytes); }
  const audio = tone(220), videoPath = join(destination, 'fixture-video.mp4');
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-t', '24', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '35', '-movflags', '+faststart', videoPath]);
  const video = await readFile(videoPath), data = syntheticStaticManifests({audio, video});
  for (const [name, source] of Object.entries(STATIC_BROWSER_MODULES)) await write(name, await readFile(join(repoRoot, source)));
  await write('fixture.mjs', staticBrowserRuntime(await readFile(join(repoRoot, 'tests/cloud-playback-browser-fixture.mjs'), 'utf8')));
  await write('fixture.css', css); for (const role of ['owner', 'output', 'seed-owner', 'seed-output']) await write('fixture-' + role + '.html', html(role));
  await write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>VDJ HTTPS synthetic verification</title><link rel="stylesheet" href="/fixture.css"></head><body><main><h1>VDJ HTTPS synthetic verification</h1><p>Isolated static fixture; generated test media only. No login, backend, provider calls or production activation.</p><p><a href="/fixture-owner.html">AudioWorklet + video + credit fixture</a></p><p><a href="/fixture-seed-owner.html">Verified seed + continuation + restart fixture</a></p>' + (multiCue ? '<p><a href="/fixture-multi-owner.html">Three-cue cumulative future queue + visual continuity fixture</a></p><p>Native clip-relative mapping is verified separately.</p>' : '') + '</main></body></html>');
  await write('fixture-manifest.json', JSON.stringify(data.manifest)); await write('fixture-seed-manifest.json', JSON.stringify(data.seedManifest));
  await write('fixture-audio.f32.gz', gzipSync(audio)); await write('fixture-render.f32.gz', gzipSync(data.renderBytes)); await write('fixture-seed.wav.gz', gzipSync(data.seedBytes));
  if (multiCue) {
    const multi = syntheticMultiCueManifests({audio, video});
    await write('fixture-multi-manifest.json', JSON.stringify(multi.package));
    for (const role of ['multi-owner', 'multi-output']) await write('fixture-' + role + '.html', html(role));
    for (let n = 1; n < 3; n++) await write('fixture-render-' + (n + 1) + '.f32.gz', gzipSync(multi.renders[n]));
  }
  await write('vercel.json', JSON.stringify(STATIC_BROWSER_CONFIG, null, 2));
  const files = {};
  for (const name of [...STATIC_BROWSER_FILES, ...(multiCue ? STATIC_MULTI_CUE_FILES : [])].filter(name => name !== 'fixture-bundle.json')) {
    const bytes = await readFile(join(destination, name)); files[name] = {byteLength: bytes.length, sha256: sha256(bytes),
      ...(STATIC_BROWSER_MODULES[name] ? {exactSource: STATIC_BROWSER_MODULES[name]} : {})};
  }
  await write('fixture-bundle.json', JSON.stringify({kind: 'synthetic-static-browser-https-v1', containsSecrets: false,
    apiRoutes: [], backendRewrites: [], providerCalls: false, physicalSpeakerVerified: false, codeCommit, multiCue,
    verificationScope: multiCue ? 'synthetic cumulative future-queue and visual three-cue continuity; native clip-relative mapping verified separately' : 'synthetic browser audio and video events', files}, null, 2));
  return {destination, ...await verifyStaticBrowserBundle({destination, repoRoot})};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildStaticBrowserBundle({destination: process.argv[2], ffmpeg: process.env.VDJ_FIXTURE_FFMPEG ?? 'ffmpeg', multiCue: process.argv.includes('--multi-cue')})));
}
