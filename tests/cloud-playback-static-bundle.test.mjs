import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {staticBrowserRuntime, STATIC_BROWSER_CONFIG, STATIC_BROWSER_MODULES, STATIC_BROWSER_FILES,
  buildStaticBrowserBundle, verifyStaticBrowserBundle, inflateStaticFixtureAsset, syntheticMultiCueManifests} from './cloud-playback-browser-static-builder.mjs';

const root = new URL('../', import.meta.url), hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('static runtime uses only HTTPS and relative static files, with no POST/evidence API or localhost fallback', async () => {
  const source = await readFile(new URL('./cloud-playback-browser-fixture.mjs', import.meta.url), 'utf8');
  const result = staticBrowserRuntime(source);
  assert.match(result, /location\.protocol !== 'https:'/); assert.match(result, /fixture-output\.html/);
  assert.match(result, /fixture-manifest\.json/); assert.match(result, /fixture-audio\.f32/);
  assert.match(result, /fixture-audio\.f32\.gz/); assert.match(result, /STATIC_FIXTURE_GZIP_UNSUPPORTED/);
  assert.doesNotMatch(result, /127\.0\.0\.1|localhost|fixture-evidence|method:\s*'POST'/);
  assert.throws(() => staticBrowserRuntime(source.replace("location.origin !== 'http://127.0.0.1:8892'", 'false')), /SOURCE_CHANGED/);
});

test('HTTPS static config allows same-origin modules/worklet/blob video and defines no API/backend routes', () => {
  assert.equal(STATIC_BROWSER_CONFIG.rewrites, undefined); assert.equal(STATIC_BROWSER_CONFIG.routes, undefined);
  assert.equal(STATIC_BROWSER_CONFIG.functions, undefined);
  const csp = STATIC_BROWSER_CONFIG.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self';/); assert.match(csp, /worker-src 'self';/); assert.match(csp, /media-src 'self' blob:;/);
  assert.match(csp, /connect-src 'self';/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|http:\/\//);
  assert.ok(STATIC_BROWSER_FILES.includes('room-worklet.mjs')); assert.ok(!STATIC_BROWSER_FILES.some(name => name.startsWith('api/')));
});

test('bundle verification rejects arbitrary files, source drift and modified asset bytes', async t => {
  const destination = await mkdtemp(join(tmpdir(), 'vdj-static-bundle-check-')); t.after(() => rm(destination, {recursive: true, force: true}));
  const payload = Buffer.from('synthetic-fixture'), descriptor = {byteLength: payload.length, sha256: hash(payload)};
  const files = {};
  for (const name of STATIC_BROWSER_FILES.filter(name => name !== 'fixture-bundle.json')) {
    const bytes = STATIC_BROWSER_MODULES[name] ? await readFile(new URL(STATIC_BROWSER_MODULES[name], root)) :
      name === 'vercel.json' ? Buffer.from(JSON.stringify(STATIC_BROWSER_CONFIG)) :
      name.endsWith('.gz') ? gzipSync(payload) :
      name === 'fixture-manifest.json' ? Buffer.from(JSON.stringify({audio: descriptor})) :
      name === 'fixture-seed-manifest.json' ? Buffer.from(JSON.stringify({renderAsset: descriptor, seed: {descriptor}})) : payload;
    await mkdir(join(destination, name, '..'), {recursive: true}); await writeFile(join(destination, name), bytes);
    files[name] = {byteLength: bytes.length, sha256: hash(bytes)};
  }
  await writeFile(join(destination, 'fixture-bundle.json'), JSON.stringify({kind: 'synthetic-static-browser-https-v1',
    apiRoutes: [], backendRewrites: [], containsSecrets: false, files}));
  assert.equal((await verifyStaticBrowserBundle({destination})).verified, true);
  await writeFile(join(destination, 'fixture-audio.f32.gz'), 'changed');
  await assert.rejects(verifyStaticBrowserBundle({destination}), /FILE_SHA_MISMATCH/);
  await writeFile(join(destination, 'fixture-audio.f32.gz'), gzipSync(payload));
  await writeFile(join(destination, 'api.mjs'), 'unallowlisted');
  await assert.rejects(verifyStaticBrowserBundle({destination}), /ALLOWLIST_MISMATCH/);
});

test('gzip fixture transport verifies bounded inflated length and fails closed without browser support', async () => {
  const original = Buffer.from('synthetic-PCM-only'), zipped = gzipSync(original);
  const result = await inflateStaticFixtureAsset({response: new Response(zipped), expectedBytes: original.length, isGzip: true});
  assert.equal(hash(new Uint8Array(result)), hash(original));
  await assert.rejects(inflateStaticFixtureAsset({response: new Response(zipped), expectedBytes: original.length, isGzip: true, decompressor: null}), /GZIP_UNSUPPORTED/);
  await assert.rejects(inflateStaticFixtureAsset({response: new Response(gzipSync(Buffer.alloc(1024))), expectedBytes: 16, isGzip: true}), /INFLATED_SIZE_LIMIT/);
  await assert.rejects(inflateStaticFixtureAsset({response: new Response(zipped), expectedBytes: original.length + 1, isGzip: true}), /INFLATED_LENGTH_MISMATCH/);
  await assert.rejects(inflateStaticFixtureAsset({response: new Response(new Uint8Array(512 * 1024 + 1)), expectedBytes: 16, isGzip: true}), /GZIP_SIZE_LIMIT/);
  await assert.rejects(inflateStaticFixtureAsset({response: new Response(zipped), expectedBytes: 180 * 44100 * 8 + 45, isGzip: true}), /ASSET_BOUND_REQUIRED/);
});

test('three-tail fixture binds unique generations and exact 48/72/96-second full renders under the immutable 180-second cap', () => {
  const audio = Buffer.alloc(24 * 44100 * 8), data = syntheticMultiCueManifests({audio, video: Buffer.from('synthetic-video')});
  assert.equal(data.package.maximumDurationFrames, 180 * 44100); assert.equal(data.package.cues.length, 3);
  const ids = new Set();
  data.package.cues.forEach((item, n) => {
    ids.add(item.cue.generationId);
    assert.equal(item.plan.transition.exitFrame, (n + 1) * 24 * 44100);
    assert.equal(item.plan.transition.editStartFrame, ((n + 1) * 24 - 4) * 44100);
    assert.equal(item.audio.durationFrames, (n + 2) * 24 * 44100);
    assert.equal(item.audio.durationFrames - item.audio.startFrame, 24 * 44100);
    assert.equal(item.renderAsset.sha256, hash(data.renders[n]));
    assert.equal(item.renderAsset.byteLength, data.renders[n].length);
    if (n) assert.ok(data.renders[n].subarray(0, data.renders[n - 1].length).equals(data.renders[n - 1]));
  });
  assert.equal(ids.size, 3);
});

test('builder refuses a destination in Git and cannot silently replace existing files', async t => {
  await assert.rejects(buildStaticBrowserBundle({destination: new URL('../tests/not-created-static-fixture', import.meta.url).pathname}), /OUTSIDE_GIT_REQUIRED/);
  const destination = await mkdtemp(join(tmpdir(), 'vdj-static-bundle-existing-')); t.after(() => rm(destination, {recursive: true, force: true}));
  await writeFile(join(destination, 'preserve.txt'), 'preserve');
  await assert.rejects(buildStaticBrowserBundle({destination}), /EMPTY_DESTINATION_REQUIRED/);
  assert.equal(await readFile(join(destination, 'preserve.txt'), 'utf8'), 'preserve');
});
