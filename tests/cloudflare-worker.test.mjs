import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloud/cloudflare/worker.mjs';

test('Worker serves room entry without passing invitation data or credentials to assets', async () => {
  const requests = [];
  const env = {ASSETS: {fetch: async request => {
    requests.push(request);
    return new Response('<!doctype html>', {headers: {'content-type': 'text/html'}});
  }}};
  const roomId = '11111111-1111-4111-8111-111111111111';
  for (const path of ['/', '/room', '/join/' + roomId + '?code=' + 'a'.repeat(64)]) {
    const response = await worker.fetch(new Request('https://room.example.com' + path, {headers: {'x-room-owner': 'test-only'}}), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(!response.headers.get('content-security-policy').includes('127.0.0.1'));
  }
  for (const request of requests) {
    assert.equal(new URL(request.url).pathname, '/judge-room.html');
    assert.equal(new URL(request.url).search, '');
    assert.equal(request.headers.get('x-room-owner'), null);
  }
});

test('Worker fails closed for missing configuration and isolates API from static fallback', async () => {
  let assets = 0;
  const env = {ASSETS: {fetch: async () => { assets++; return new Response('asset'); }}};
  const response = await worker.fetch(new Request('https://room.example.com/api/room-capabilities'), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {error: 'ROOM_BACKEND_UNAVAILABLE'});
  assert.equal(assets, 0);
  const privateRoute = await worker.fetch(new Request('https://room.example.com/provider-media/' + 'a'.repeat(64)), env);
  assert.equal(privateRoute.status, 404);
  assert.equal(assets, 0);
  const denied = await worker.fetch(new Request('https://room.example.com/room', {method: 'POST'}), env);
  assert.equal(denied.status, 405);
  const output = await worker.fetch(new Request('https://room.example.com/cloud-output.html'), env);
  assert.match(output.headers.get('content-security-policy'), /frame-ancestors 'self'/);
});
