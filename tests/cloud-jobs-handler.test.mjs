import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudFirstHandler} from '../cloud/jobs/cloud-first-handler.mjs';

const roomId = '11111111-1111-4111-a111-111111111111', owner = 'a'.repeat(64), guest = 'b'.repeat(64);
const origin = 'https://ai-vdj.vercel.app', operationId = 'operation_' + 'o'.repeat(24);
function request(path, body, extra = {}) {
  return new Request(origin + '/api/rooms/' + roomId + path, {method: body === undefined ? 'GET' : 'POST',
    headers: {Origin: origin, 'X-Room-Owner': owner, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...extra},
    ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})});
}
test('optional assembly is disabled even with activated injected adapters, and read-only progress still works', async () => {
  let mutations = 0, media = 0, fallback = 0;
  const jobs = {read: async () => ({state: 'WAIT_QC'}), start: async () => { mutations++; },
    advance: async () => { mutations++; }, stop: async () => { mutations++; }};
  const handler = createCloudFirstHandler({jobs, coordinator: {execute: async () => { mutations++; }},
    mediaPorts: {authorizeOwner: async () => true, readMedia: async () => { media++; }},
    fallback: async () => { fallback++; return new Response('fallback'); }});
  assert.equal((await handler(request('/jobs/read', {operationId}))).status, 200);
  for (const action of ['start', 'advance', 'stop']) assert.equal((await handler(request('/jobs/' + action, {operationId}))).status, 409);
  assert.equal((await handler(request('/cues/reserve', {}))).status, 503);
  assert.equal((await handler(request('/cloud/media/resolve', {}))).status, 503);
  assert.equal((await handler(request('/media/synthetic?sha256=' + '1'.repeat(64)))).status, 503);
  assert.equal(mutations, 0); assert.equal(media, 0); assert.equal(fallback, 0);
  assert.equal(await (await handler(request('/unrelated'))).text(), 'fallback'); assert.equal(fallback, 1);
});
test('attachment route accepts submission ID only and neither participant nor supplied operation/QC flags can attach work', async () => {
  let prepares = 0;
  const handler = createCloudFirstHandler({roomProjection: {prepare: async input => { prepares++; assert.equal(input.submissionId, 'synthetic-submission');
    return {operationId, permitId: 'permit_' + 'p'.repeat(24)}; }}});
  assert.equal((await handler(request('/jobs/attachment', {submissionId: 'synthetic-submission'}))).status, 200);
  for (const extra of [{operationId}, {permitId: 'forged'}, {qcPassed: true}, {url: 'https://evil.invalid'}])
    assert.equal((await handler(request('/jobs/attachment', {submissionId: 'synthetic-submission', ...extra}))).status, 400);
  assert.equal((await handler(request('/jobs/attachment', {submissionId: 'synthetic-submission'}, {...Object.fromEntries([['Authorization', ['Bearer', guest].join(' ')]])}))).status, 403);
  assert.equal((await handler(request('/jobs/attachment', ' '.repeat(1025)))).status, 413); assert.equal(prepares, 1);
});
test('projection assembly preserves exclusive room proof actors and the same-origin boundary', async () => {
  const calls = [], projection = {readRoom: async input => { calls.push(input); return {submissions: []}; },
    readSubmission: async input => { calls.push(input); return {submissionId: input.submissionId}; }};
  const handler = createCloudFirstHandler({roomProjection: projection});
  assert.equal((await handler(request(''))).status, 200);
  const participant = new Request(origin + '/api/rooms/' + roomId + '/submissions/synthetic-submission',
    {headers: {Origin: origin, ...Object.fromEntries([['Authorization', ['Bearer', guest].join(' ')]])}});
  assert.equal((await handler(participant)).status, 200); assert.deepEqual(calls.at(-1), {roomId, participantCapability: guest, submissionId: 'synthetic-submission'});
  assert.equal((await handler(request('', undefined, {Authorization: 'example_malformed'}))).status, 403);
  assert.equal((await handler(request('', undefined, {Origin: 'https://evil.invalid'}))).status, 403);
  const sameOrigin = new Request(origin + '/api/rooms/' + roomId,
    {headers: {'Sec-Fetch-Site': 'same-origin', 'X-Room-Owner': owner}});
  assert.equal((await handler(sameOrigin)).status, 200);
  const crossSite = new Request(origin + '/api/rooms/' + roomId, {headers: {'Sec-Fetch-Site': 'cross-site', 'X-Room-Owner': owner}});
  assert.equal((await handler(crossSite)).status, 403);
});
test('events preserve existing proof/cursor boundary and compose a fresh projected snapshot; event hints cannot create job or credit state', async () => {
  let reads = 0, feeds = 0, fail = false;
  const snapshot = {roomId, sessionId: 'example_epoch', eventSeq: 8, jobStateSha256: '1'.repeat(64),
    submissions: [{submissionId: 'synthetic-submission', state: 'WAIT_REVIEW'}], currentCredit: null};
  const handler = createCloudFirstHandler({roomProjection: {readRoom: async () => { reads++; return snapshot; }},
    fallback: async req => { feeds++; assert.equal(new URL(req.url).searchParams.get('after'), '4');
      if (fail) return new Response(JSON.stringify({error: 'ACTOR_DENIED'}), {status: 403});
      return new Response(JSON.stringify({eventSeq: 7, snapshot: {submissions: [{state: 'PLAYING'}], currentCredit: {actual: true}},
        secret: 'example_private_feed_marker', events: [{type: 'participantCredit', seq: 7, actual: true,
          payload: {qcPassed: true, url: 'https://example.invalid/private'}}]})); }});
  const result = await handler(request('/events?after=4')); assert.equal(result.status, 200);
  const feed = await result.json(); assert.deepEqual(feed.snapshot, snapshot); assert.equal(feed.eventSeq, 8);
  assert.deepEqual(feed.events, [{type: 'participantCredit', seq: 7, hint: true}]);
  assert.equal(JSON.stringify(feed).includes('private'), false); assert.equal(feed.snapshot.currentCredit, null);
  fail = true; assert.equal((await handler(request('/events?after=4'))).status, 403); assert.equal(feeds, 2); assert.equal(reads, 1);
});
