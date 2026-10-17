import test from 'node:test';
import assert from 'node:assert/strict';
import {stagingCheck} from '../cloud/cloudflare/staging-check-http.mjs';

test('staging check cannot be started in production, cross-origin or with caller inputs', async () => {
  const origin = 'https://staging.example.com';
  let starts = 0;
  const env = {PUBLIC_ORIGIN: origin, STAGING_NATIVE_CHECK: 'enabled', NATIVE_PROCESSOR: {getByName(name) {
    assert.equal(name, 'staging-native-check-v1');
    return {syntheticStatus: async () => ({state: 'not-started'}), startSyntheticCheck: async () => { starts++; return {state: 'running'}; }};
  }}};
  const call = (init = {}) => new Request(origin + '/api/staging/native-check', init);
  assert.equal(await stagingCheck(call(), {...env, STAGING_NATIVE_CHECK: undefined}), null);
  assert.equal((await stagingCheck(call({method: 'POST'}), env)).status, 403);
  assert.equal((await stagingCheck(call({method: 'POST', headers: {origin}, body: 'caller input'}), env)).status, 400);
  assert.equal(starts, 0);
  assert.deepEqual(await (await stagingCheck(call(), env)).json(), {state: 'not-started'});
  assert.equal(starts, 0);
  assert.equal((await stagingCheck(call({method: 'POST', headers: {origin}}), env)).status, 202);
  assert.equal(starts, 1);
});
