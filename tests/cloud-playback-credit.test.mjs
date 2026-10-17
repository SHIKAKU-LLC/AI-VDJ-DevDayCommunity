import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudCreditOverlay, projectCloudPlaybackCredit} from '../room-web/cloud-output-credit.mjs';
import {createCloudOutputBridge, createCloudPlaybackChannel} from '../room-web/cloud-output-bridge.mjs';

const roomId = '11111111-1111-4111-8111-111111111111', hash = 'a'.repeat(64);
const binding = {operationId: 3, roomId, cueId: 'cue-fixture', generationId: 'generation-fixture', expectedRevision: 1};
const credit = () => ({roomId, cueId: binding.cueId, generationId: binding.generationId, playbackRevision: 1,
  actual: true, actualPlayback: true, nickname: '合成ゲスト <b>fixture</b>'});
function overlay() {
  const element = {hidden: false, textContent: 'old'}, timers = [], cancelled = [];
  let state = {phase: 'PLAYING', audioStarted: true, videoPresented: true, cueId: binding.cueId, playbackRevision: 1};
  let currentBinding = {...binding};
  const port = createCloudCreditOverlay({element, readPlayback: () => state, readBinding: () => currentBinding,
    schedule(fn, ms) { const token = {fn, ms}; timers.push(token); return token; }, cancel(token) { cancelled.push(token); }});
  return {port, element, timers, cancelled, state: patch => state = {...state, ...patch},
    binding: patch => currentBinding = {...currentBinding, ...patch}};
}

test('literal bounded nickname appears only on actual PLAYING and clears at exactly six seconds', () => {
  const h = overlay(); assert.equal(h.element.hidden, true);
  const result = h.port.show(projectCloudPlaybackCredit(credit(), binding));
  assert.equal(result.shown, true); assert.equal(h.element.hidden, false);
  assert.equal(h.element.textContent, '合成ゲスト <b>fixture</b>'); assert.equal(h.timers[0].ms, 6000);
  h.timers[0].fn(); assert.equal(h.element.hidden, true); assert.equal(h.element.textContent, '');
});

test('READY, partial audio/video, wrong cue/revision/generation and arbitrary message fields never show credit', () => {
  for (const patch of [{phase: 'READY'}, {audioStarted: false}, {videoPresented: false}, {cueId: 'old-cue'}, {playbackRevision: 0}]) {
    const h = overlay(); h.state(patch);
    assert.throws(() => h.port.show(projectCloudPlaybackCredit(credit(), binding)), /NOT_PLAYING/);
    assert.equal(h.element.hidden, true); assert.equal(h.timers.length, 0);
  }
  for (const patch of [{actual: false}, {actualPlayback: false}, {generationId: 'old'}, {playbackRevision: 0}, {cueId: 'old'},
    {nickname: 'a'.repeat(41)}, {nickname: '\u0001bad'}, {nickname: '   '}]) {
    assert.throws(() => projectCloudPlaybackCredit({...credit(), ...patch}, binding), /ACTUAL_CREDIT_REQUIRED/);
  }
  const h = overlay(); const data = projectCloudPlaybackCredit(credit(), binding);
  assert.throws(() => h.port.show({...data, operationId: 9}), /NOT_PLAYING/);
  assert.throws(() => h.port.show({...data, url: 'https://invalid.example'}), /MESSAGE_INVALID/);
});

test('duplicate credit does not reset six-second timer, including after stop/clear/rebuild; next revision may show once', () => {
  const h = overlay(), data = projectCloudPlaybackCredit(credit(), binding);
  h.port.show(data); assert.deepEqual(h.port.show(data), {shown: false, duplicate: true}); assert.equal(h.timers.length, 1);
  h.port.clear(); assert.equal(h.element.hidden, true);
  assert.deepEqual(h.port.show(data), {shown: false, duplicate: true}); assert.equal(h.timers.length, 1);
  h.binding({expectedRevision: 2}); h.state({playbackRevision: 2});
  assert.equal(h.port.show(projectCloudPlaybackCredit({...credit(), playbackRevision: 2}, {...binding, expectedRevision: 2})).shown, true);
  h.port.dispose(); assert.equal(h.element.hidden, true); assert.equal(h.element.textContent, '');
  assert.throws(() => h.port.show(data), /MESSAGE_INVALID/);
});

test('preparing/starting a future cue preserves the accepted nickname timer but cannot grant new credit before actual ACK', () => {
  const h = overlay(), data = projectCloudPlaybackCredit(credit(), binding);
  h.port.show(data); const timer = h.timers[0];
  for (const phase of ['PREPARING', 'STARTING']) {
    h.state({phase, audioStarted: false, videoPresented: false}); h.port.observePlaybackState({phase});
    assert.equal(h.element.hidden, false); assert.equal(h.element.textContent, credit().nickname);
    assert.equal(h.timers.length, 1); assert.equal(timer.ms, 6000);
    assert.throws(() => h.port.show(data), /NOT_PLAYING/);
  }
  timer.fn(); assert.equal(h.element.hidden, true);
  const other = overlay(); other.port.show(data); other.port.observePlaybackState({phase: 'STOPPED'});
  assert.equal(other.element.hidden, true); assert.equal(other.element.textContent, '');
});

function cueInput() {
  const cue = {roomId, cueId: binding.cueId, generationId: binding.generationId, submissionId: 'submission-fixture',
    commonIntentSha256: hash, controlVersion: 1, atomicReady: true, status: 'READY'};
  for (const channel of ['music', 'video']) cue[channel] = {status: 'READY', qc: {passed: true}, durationSeconds: 24,
    asset: {assetId: channel + '-fixture', sha256: hash}, binding: {roomId, submissionId: cue.submissionId, generationId: cue.generationId,
      commonIntentSha256: hash, controlVersion: 1, channel}};
  cue.video.review = {accepted: true, ownerArtisticApproval: true, assetSha256: hash, commonIntentSha256: hash};
  cue.video.compositionQC = {passed: true}; cue.video.clips = [{assetId: 'video-fixture', sha256: hash, durationSeconds: 24}];
  cue.video.timeline = {durationSeconds: 24, timeStretch: false, segments: [{assetId: 'video-fixture', sha256: hash,
    startSeconds: 0, endSeconds: 24, sourceInSeconds: 0, sourceOutSeconds: 24, playbackRate: 1}]};
  return {roomId, cue, plan: {cueId: cue.cueId, transition: {exitFrame: 0, renderedSha256: hash}}, expectedRevision: 1, guard: async () => true};
}
async function bridgeFixture(t, {creditFailures = 0} = {}) {
  const listeners = new Map(), commands = []; let outputChannel, resolveCommit;
  const output = {closed: false, postMessage(message, origin, ports) {
    outputChannel = createCloudPlaybackChannel({port: ports[0], handle: async (type, data) => {
      commands.push({type, data});
      if (type === 'init') { await outputChannel.call('state', {phase: 'READY', cloudRole: 'output', playbackRevision: 0}); return {ready: true}; }
      if (type === 'commit') return new Promise(resolve => { resolveCommit = resolve; });
      if (type === 'credit') { if (creditFailures-- > 0) throw Error('CLOUD_OUTPUT_TRANSIENT'); return {shown: true, cueId: data.cueId, playbackRevision: data.playbackRevision}; }
      return {stopped: true};
    }});
  }};
  const window = {location: {origin: 'https://vdj.example'}, open: () => output,
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type)};
  const bridge = createCloudOutputBridge({window, enabled: true, fixtureMode: true}); bridge.openOutput();
  listeners.get('message')({source: output, origin: window.location.origin, data: {type: 'ai-vdj-cloud-output-ready', version: 1}});
  async function until(fn) { for (let n = 0; n < 1000; n++) { if (fn()) return; await new Promise(r => setImmediate(r)); } assert.fail('fixture did not advance'); }
  await until(() => bridge.read().phase === 'READY');
  t.after(async () => { await bridge.dispose(); outputChannel.close(); });
  return {bridge, commands, until, resolve() { resolveCommit({roomId, cueId: binding.cueId, clipId: 'music-fixture', playbackRevision: 1,
    audioTime: .25, actual: true, audioStarted: true, videoPresented: true}); }};
}

test('owner bridge cannot emit credit from READY or pending ACK, rejects forged/old credit and emits once after acknowledged operation', async t => {
  const h = await bridgeFixture(t);
  await assert.rejects(h.bridge.showCredit(credit()), /ACK_REQUIRED/);
  const pending = h.bridge.commitPlayback(cueInput()); await h.until(() => h.commands.some(c => c.type === 'commit'));
  await assert.rejects(h.bridge.showCredit(credit()), /ACK_REQUIRED/); h.resolve(); await pending;
  for (const patch of [{generationId: 'old'}, {cueId: 'old'}, {playbackRevision: 0}, {actual: false}, {actualPlayback: false}])
    await assert.rejects(h.bridge.showCredit({...credit(), ...patch}), /ACTUAL_CREDIT_REQUIRED/);
  assert.equal((await h.bridge.showCredit({...credit(), participantId: 'excluded-fixture-id', prompt: 'excluded prompt'})).shown, true);
  assert.deepEqual(await h.bridge.showCredit(credit()), {shown: false, duplicate: true});
  const sent = h.commands.filter(c => c.type === 'credit'); assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0].data).sort(), ['operationId', 'roomId', 'cueId', 'generationId', 'playbackRevision', 'nickname', 'actual', 'actualPlayback'].sort());
  await h.bridge.stop(); await assert.rejects(h.bridge.showCredit(credit()), /ACK_REQUIRED/);
});
test('a Stop -> Start graph restarts revisions; reset lets its first Cue credit show again', () => {
  const h = overlay();
  assert.equal(h.port.show(projectCloudPlaybackCredit(credit(), binding)).shown, true);
  assert.equal(h.port.show(projectCloudPlaybackCredit(credit(), binding)).duplicate, true, 'same graph still deduplicates');
  h.port.reset(); h.binding({operationId: 9});
  assert.equal(h.port.show(projectCloudPlaybackCredit(credit(), {...binding, operationId: 9})).shown, true);
});

test('a credit whose delivery failed is retried instead of being reported as a duplicate', async t => {
  const h = await bridgeFixture(t, {creditFailures: 1}), pending = h.bridge.commitPlayback(cueInput());
  await h.until(() => h.commands.some(c => c.type === 'commit')); h.resolve(); await pending;
  await assert.rejects(h.bridge.showCredit(credit()), /CLOUD_OUTPUT_REQUEST_FAILED/);
  assert.equal((await h.bridge.showCredit(credit())).shown, true, 'the accepted nickname still appears');
  assert.deepEqual(await h.bridge.showCredit(credit()), {shown: false, duplicate: true});
});
