import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeService} from '../cloud/cloudflare/native-service.mjs';
import {createPortableNativeRuntime} from '../cloud/worker/native-runtime.mjs';
import {syntheticWave} from './cloud-worker-fixture.mjs';

const encode = value => { const bytes = Buffer.from(value); return {data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex')}; };
const call = (value, options = {}) => new Request('http://container.internal/inspect', {method: 'POST',
  headers: {'content-type': 'application/json', ...options.headers}, body: JSON.stringify(value)});
const input = () => ({requestId: 'synthetic-qc-request', action: 'bootstrap', input: {}, files: {bytes: encode([1, 2, 3])}});

test('private native service checks authorization, typed inputs and digests before invoking the runtime', async () => {
  let calls = 0;
  const service = createNativeService({authorize: request => request.headers.get('x-test-permit') === 'approved',
    createRuntime: async () => ({inspectBootstrap: async bytes => { calls++; return {frameCount: bytes.length}; }})});
  const headers = {'x-test-permit': 'approved'};
  assert.equal((await service.fetch(call(input()))).status, 403);
  assert.equal((await service.fetch(new Request('http://container.internal/self-check', {method: 'POST'}))).status, 403);
  const invalid = input(); invalid.files.bytes.sha256 = '0'.repeat(64);
  assert.equal((await service.fetch(call(invalid, {headers}))).status, 400);
  assert.equal((await service.fetch(call({...input(), input: {url: 'https://example.com/'}}, {headers}))).status, 400);
  assert.equal(calls, 0);
  const response = await service.fetch(call(input(), {headers}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {requestId: 'synthetic-qc-request', measurements: {frameCount: 3}, artifacts: {}});
  assert.equal(calls, 1);
});

test('native service runs one measurement at a time and sanitizes native errors', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const service = createNativeService({authorize: () => true, createRuntime: async () => ({inspectBootstrap: async () => {
    started(); await new Promise(resolve => { release = resolve; }); throw Error('private native detail');
  }})});
  const first = service.fetch(call(input())); await began;
  assert.equal((await service.fetch(call(input()))).status, 409);
  release();
  assert.deepEqual(await (await first).json(), {error: 'NATIVE_MEASUREMENT_FAILED'});
});

test('native service moves PCM artifacts into separately hashed result fields', async () => {
  const bytes = Buffer.from([4, 5, 6]);
  const service = createNativeService({authorize: () => true, createRuntime: async () => ({
    native: {inspectVideo: async () => ({decodedFrames: 20, renderBytes: bytes})},
  })});
  const response = await service.fetch(call({...input(), action: 'video'}));
  const result = await response.json();
  assert.deepEqual(result.measurements, {decodedFrames: 20});
  assert.deepEqual(result.artifacts.renderBytes, encode(bytes));
});

test('native service performs actual Python DSP from synthetic WAV bytes', {skip: !process.env.VDJ_QC_PYTHON}, async () => {
  const service = createNativeService({authorize: () => true,
    createRuntime: () => createPortableNativeRuntime({python: process.env.VDJ_QC_PYTHON})});
  try {
    const bytes = syntheticWave(24);
    const response = await service.fetch(call({...input(), files: {bytes: encode(bytes)}}));
    assert.equal(response.status, 200);
    const {measurements} = await response.json();
    assert.equal(measurements.assetSha256, encode(bytes).sha256);
    assert.equal(measurements.frameCount, 24 * 44100);
    assert.equal(measurements.nonfiniteSamples, 0);
    const check = await service.fetch(new Request('http://container.internal/self-check', {method: 'POST'}));
    assert.equal(check.status, 200);
    assert.deepEqual(await check.json(), {kind: 'synthetic-bootstrap-check-v1', passed: true,
      frameCount: 24 * 44100, sampleRate: 44100, channels: 2});
  } finally { await service.close(); }
});
