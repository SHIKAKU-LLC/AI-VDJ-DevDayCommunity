import test from 'node:test';
import assert from 'node:assert/strict';
import {createPairPreparation} from '../cloud/worker/pair-preparation.mjs';

// Production 2026-10-17: the A -> B join was rendered inside the B reservation
// (~29s), longer than A's 24s. Pairs are prepared ahead in the background.
const cue = (cueId, status) => ({cueId, operationId: 'operation-' + cueId, status});
function fixture({cues, preparePair, maxAttempts, now} = {}) {
  let list = cues, reads = 0;
  const calls = {sources: [], preverified: [], pairs: [], background: 0}, diagnostics = [];
  const preparation = createPairPreparation({enabled: true, maxAttempts, ...(now ? {now, cooldownMs: 60000} : {}),
    readCues: async () => { reads++; return structuredClone(list); },
    prepareSource: async parent => { calls.sources.push(parent.cueId); return {kind: 'source', cueId: parent.cueId, playback: {actual: false}}; },
    preverifySource: async (parent, source) => { assert.equal(source.cueId, parent.cueId); calls.preverified.push(parent.cueId); },
    preparePair: async ({parent, candidate, source}) => { assert.equal(source.cueId, parent.cueId);
      calls.pairs.push(parent.cueId + '>' + candidate.cueId); return preparePair ? preparePair(parent, candidate) : {assetId: 'pair'}; },
    runBackground: callback => { calls.background++; return callback(); },
    onDiagnostic: value => diagnostics.push(value)});
  return {preparation, calls, diagnostics, reads: () => reads, setCues: value => { list = value; }};
}

test('prepares every READY join from the sounding Cue first, each parent source once', async () => {
  const x = fixture({cues: [cue('b', 'READY'), cue('a', 'PLAYING'), cue('c', 'READY'), cue('d', 'PLAYED')]});
  x.preparation.schedule('preload'); await x.preparation.idle();
  assert.deepEqual(x.calls.pairs, ['a>b', 'a>c', 'b>c', 'c>b']);
  assert.deepEqual(x.calls.sources, ['a', 'b', 'c']); assert.deepEqual(x.calls.preverified, ['a', 'b', 'c']);
  assert.equal(x.calls.background, 1);
  assert(x.diagnostics.every(d => d.event === 'PLAYBACK_PAIR_PREPARED' && /^[a-z0-9-]{1,24}>[a-z0-9-]{1,24}:\d+ms$/.test(d.reason)));
});

test('a newly READY Cue adds only its own joins; prepared joins are not repeated', async () => {
  const x = fixture({cues: [cue('a', 'PLAYING'), cue('b', 'READY')]});
  x.preparation.schedule('reserve'); await x.preparation.idle();
  x.preparation.schedule('reserve'); await x.preparation.idle();
  assert.deepEqual(x.calls.pairs, ['a>b']);
  x.setCues([cue('a', 'PLAYING'), cue('b', 'READY'), cue('e', 'READY')]);
  x.preparation.schedule('published'); await x.preparation.idle();
  assert.deepEqual(x.calls.pairs, ['a>b', 'a>e', 'b>e', 'e>b']);
  assert.deepEqual(x.calls.sources, ['a', 'b', 'e'], 'a parent source is prepared once per Cue');
});

test('requests during a sweep coalesce into exactly one more pass', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const x = fixture({cues: [cue('a', 'PLAYING'), cue('b', 'READY')], preparePair: async () => { await gate; return {assetId: 'pair'}; }});
  x.preparation.schedule('preload'); x.preparation.schedule('reserve'); x.preparation.schedule('published');
  release(); await x.preparation.idle();
  assert.equal(x.reads(), 2); assert.deepEqual(x.calls.pairs, ['a>b']);
});

test('a failed join is retried a bounded number of times; a QC-rejected join is not retried', async () => {
  const x = fixture({cues: [cue('a', 'PLAYING'), cue('b', 'READY'), cue('c', 'READY')], maxAttempts: 2,
    preparePair: async (parent, candidate) => {
      if (candidate.cueId === 'b') throw Object.assign(Error('NATIVE_DECODE_OR_MEASUREMENT_FAILED'), {code: 'NATIVE_DECODE_OR_MEASUREMENT_FAILED'});
      return parent.cueId === 'a' ? null : {assetId: 'pair'};
    }});
  for (let i = 0; i < 3; i++) { x.preparation.schedule('reserve'); await x.preparation.idle(); }
  assert.deepEqual(x.calls.pairs.filter(p => p === 'a>b'), ['a>b', 'a>b'], 'two attempts, then waits for the cooldown');
  assert.deepEqual(x.calls.pairs.filter(p => p === 'a>c'), ['a>c'], 'QC-rejected join is final');
  assert(x.diagnostics.some(d => d.event === 'PLAYBACK_PAIR_HOLD' && d.reason === 'a>b:NATIVE_DECODE_OR_MEASUREMENT_FAILED'));
});

test('disabled or closed preparation does no work', async () => {
  const off = createPairPreparation({readCues: async () => assert.fail('disabled'), prepareSource: async () => {},
    preverifySource: async () => {}, preparePair: async () => {}});
  off.schedule('preload'); await off.idle();
  const x = fixture({cues: [cue('a', 'PLAYING'), cue('b', 'READY')]});
  x.preparation.close(); x.preparation.schedule('preload'); await x.preparation.idle();
  assert.equal(x.reads(), 0); assert.deepEqual(x.calls.pairs, []);
});

test('a replayed operation reusing a cueId gets its own source and join; a status change does not', async () => {
  const x = fixture({cues: [cue('a', 'PLAYING'), cue('b', 'READY')]});
  x.preparation.schedule('preload'); await x.preparation.idle();
  x.setCues([cue('a', 'PLAYED'), {...cue('b', 'PLAYING'), playbackRevision: 1}]);
  x.preparation.schedule('ack'); await x.preparation.idle();
  assert.deepEqual(x.calls.pairs, ['a>b'], 'status and revision changes keep the prepared join');
  x.setCues([cue('a', 'PLAYING'), {...cue('b', 'READY'), operationId: 'operation-b-replay'}]);
  x.preparation.schedule('published'); await x.preparation.idle();
  assert.deepEqual(x.calls.pairs, ['a>b', 'a>b'], 'the replayed operation is prepared again');
  x.setCues([{...cue('a', 'READY'), operationId: 'operation-a-replay'}, cue('b', 'PLAYING')]);
  x.preparation.schedule('published'); await x.preparation.idle();
  assert.deepEqual(x.calls.sources.filter(s => s === 'a').length, 1, 'a Cue never joins to its own identical operation');
});

test('a join that failed during a temporary outage is retried after the cooldown', async () => {
  let clock = 1000, outage = true;
  const x = fixture({cues: [cue('a', 'PLAYING'), cue('b', 'READY')], maxAttempts: 2, now: () => clock,
    preparePair: async () => { if (outage) throw Object.assign(Error('PRIVATE_STORE_FAILED'), {code: 'PRIVATE_STORE_FAILED'}); return {assetId: 'pair'}; }});
  for (let i = 0; i < 3; i++) { x.preparation.schedule('reserve'); await x.preparation.idle(); }
  assert.equal(x.calls.pairs.length, 2, 'bounded attempts during the outage');
  outage = false; clock += 60001;
  x.preparation.schedule('reserve'); await x.preparation.idle();
  assert.equal(x.calls.pairs.length, 3, 'retried once the cooldown passed');
  assert(x.diagnostics.some(d => d.event === 'PLAYBACK_PAIR_PREPARED'));
  x.preparation.schedule('reserve'); await x.preparation.idle();
  assert.equal(x.calls.pairs.length, 3, 'a prepared join is final');
});

test('a join the preload already prepared or rejected is not rendered again by the sweep', async () => {
  const x = fixture({cues: [cue('a', 'READY'), cue('b', 'READY')]});
  x.preparation.settle(cue('a', 'READY'), cue('b', 'READY'));
  x.preparation.settle(cue('b', 'READY'), cue('a', 'READY'));
  x.preparation.schedule('preload'); await x.preparation.idle();
  assert.deepEqual(x.calls.pairs, [], 'no ~70s native render is repeated at Start');
  x.setCues([cue('a', 'PLAYING'), cue('b', 'READY')]);
  x.preparation.schedule('reserve'); await x.preparation.idle();
  assert.deepEqual(x.calls.pairs, [], 'a status change keeps the settled join');
});

test('a PLAYING operation gets a join to a newer READY operation that reuses its cueId', async () => {
  const x = fixture({cues: [cue('a', 'PLAYING'), {...cue('a', 'READY'), operationId: 'operation-a-replay'}]});
  x.preparation.schedule('published'); await x.preparation.idle();
  assert.deepEqual(x.calls.pairs, ['a>a'], 'old -> replayed copy is prepared; identical operation is skipped');
});

test('a join requested by the preload while the sweep renders it is rendered once', async () => {
  let release, renders = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const x = fixture({cues: [cue('a', 'PLAYING'), cue('b', 'READY')], preparePair: async () => { renders++; await gate; return {assetId: 'pair'}; }});
  x.preparation.schedule('published');
  for (let i = 0; i < 20 && renders === 0; i++) await new Promise(r => setImmediate(r));
  let preloadRuns = 0;
  const preload = x.preparation.prepareOnce(cue('a', 'PLAYING'), cue('b', 'READY'), async () => { preloadRuns++; return {assetId: 'other'}; });
  release();
  assert.deepEqual(await preload, {assetId: 'pair'}, 'the preload receives the in-flight render');
  await x.preparation.idle();
  assert.equal(renders, 1); assert.equal(preloadRuns, 0, 'no second ~70s render');
  x.preparation.schedule('reserve'); await x.preparation.idle(); assert.equal(renders, 1, 'settled after the shared render');
});

test('the preload reuses a join the sweep already settled, including a final QC rejection', async () => {
  let renders = 0;
  const x = fixture({cues: [cue('a', 'PLAYING'), cue('b', 'READY'), cue('c', 'READY')],
    preparePair: async (parent, candidate) => { renders++; return candidate.cueId === 'b' ? null : {assetId: 'pair-' + candidate.cueId}; }});
  x.preparation.schedule('published'); await x.preparation.idle();
  const before = renders, run = async () => { renders++; return {assetId: 'again'}; };
  assert.equal(await x.preparation.prepareOnce(cue('a', 'PLAYING'), cue('b', 'READY'), run), null, 'a rejection is final');
  assert.deepEqual(await x.preparation.prepareOnce(cue('a', 'PLAYING'), cue('c', 'READY'), run), {assetId: 'pair-c'});
  assert.equal(renders, before, 'no native join is repeated at preload');
});
