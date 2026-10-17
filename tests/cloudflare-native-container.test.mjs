import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeContainerClass} from '../cloud/cloudflare/native-container.mjs';

const context = (values = new Map()) => ({
  pending: [],
  waitUntil(promise) { this.pending.push(promise); },
  storage: {get: async key => values.get(key), put: async (key, value) => values.set(key, value)},
  blockConcurrencyWhile: callback => callback(),
});

test('synthetic validation is started once and its result survives object recreation', async () => {
  class Measured extends FakeContainer {
    async containerFetch() { return Response.json({kind: 'synthetic-bootstrap-check-v1', passed: true,
      frameCount: 24 * 44100, sampleRate: 44100, channels: 2}); }
  }
  const NativeProcessor = createNativeContainerClass(Measured);
  const state = context(), native = new NativeProcessor(state, {});
  assert.equal((await native.syntheticStatus()).state, 'not-started');
  await Promise.all([native.startSyntheticCheck(), native.startSyntheticCheck()]);
  await Promise.all(state.pending);
  assert.equal(native.starts.length, 1);
  assert.deepEqual(await native.syntheticStatus(), {state: 'passed', frames: 24 * 44100, sampleRate: 44100, channels: 2});
  const recreated = new NativeProcessor(state, {});
  assert.equal((await recreated.startSyntheticCheck()).state, 'passed');
  assert.equal(recreated.starts.length, 0);
});
const request = (headers = {}) => new Request('http://native.internal/inspect', {
  method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: '{"synthetic":true}',
});

class FakeContainer {
  starts = [];
  async startAndWaitForPorts(options) { this.starts.push(options); }
  async containerFetch(request) {
    this.forwarded = request;
    return Response.json({measured: true});
  }
}

test('native binding rejects other routes before starting a container', async () => {
  const NativeProcessor = createNativeContainerClass(FakeContainer);
  const native = new NativeProcessor(context(), {});
  for (const url of ['https://example.com/inspect', 'http://native.internal/health', 'http://native.internal/inspect?x=1']) {
    assert.equal((await native.fetch(new Request(url))).status, 404);
  }
  assert.equal((await native.fetch(new Request('http://native.internal/inspect'))).status, 404);
  assert.equal((await native.fetch(request({'content-type': 'text/plain'}))).status, 415);
  assert.equal(native.starts.length, 0);
});

test('native binding keeps generated authentication across object recreation and strips caller headers', async () => {
  const NativeProcessor = createNativeContainerClass(FakeContainer);
  const state = context();
  const first = new NativeProcessor(state, {});
  const response = await first.fetch(request({'x-caller-private': 'discard-this-header', 'x-vdj-runtime-auth': 'caller-value'}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {measured: true});
  assert.equal(first.starts[0].startOptions.enableInternet, false);
  assert.equal(first.enableInternet, false);
  assert.equal(first.sleepAfter, '3m');
  const generated = first.starts[0].startOptions.envVars.VDJ_RUNTIME_AUTH;
  assert.match(generated, /^[a-f0-9]{64}$/);
  assert.deepEqual([...first.forwarded.headers.keys()], ['content-type', 'x-vdj-runtime-auth']);
  assert.equal(first.forwarded.headers.get('x-vdj-runtime-auth'), generated);
  assert.equal(await first.forwarded.text(), '{"synthetic":true}');
  const second = new NativeProcessor(state, {});
  await second.fetch(request());
  assert.equal(second.starts[0].startOptions.envVars.VDJ_RUNTIME_AUTH, generated);
});

test('native binding admits one measurement at a time and removes container error details', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  class Delayed extends FakeContainer {
    async containerFetch() {
      started();
      await new Promise(resolve => { release = resolve; });
      return new Response('internal detail', {status: 422});
    }
  }
  const NativeProcessor = createNativeContainerClass(Delayed);
  const native = new NativeProcessor(context(), {});
  const running = native.fetch(request());
  await began;
  assert.equal((await native.fetch(request())).status, 409);
  release();
  const result = await running;
  assert.equal(result.status, 422);
  assert.deepEqual(await result.json(), {error: 'NATIVE_MEASUREMENT_FAILED'});
});

test('native binding recovers after a failed start without exposing underlying error text', async () => {
  class Failed extends FakeContainer {
    async startAndWaitForPorts() { throw Error('internal instance detail'); }
  }
  const NativeProcessor = createNativeContainerClass(Failed);
  const native = new NativeProcessor(context(), {});
  for (let i = 0; i < 2; i++) {
    const response = await native.fetch(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: 'NATIVE_PROCESSOR_UNAVAILABLE'});
  }
});

test('a failed synthetic check is not retried after object recreation', async () => {
  class Failed extends FakeContainer {
    async startAndWaitForPorts() { throw Error('unavailable'); }
  }
  const NativeProcessor = createNativeContainerClass(Failed);
  const state = context(), first = new NativeProcessor(state, {});
  await first.startSyntheticCheck();
  await Promise.all(state.pending);
  assert.deepEqual(await first.syntheticStatus(), {state: 'failed', httpStatus: 503});
  const second = new NativeProcessor(state, {});
  assert.deepEqual(await second.startSyntheticCheck(), {state: 'failed', httpStatus: 503});
  assert.equal(second.starts.length, 0);
});
