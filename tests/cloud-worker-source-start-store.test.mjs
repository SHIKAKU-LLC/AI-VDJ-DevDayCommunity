import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupabasePrivateStore} from '../cloud/worker/supabase-private-store.mjs';
import {syntheticStorageTransport} from './cloud-worker-store-fixture.mjs';
import {cueDigest} from '../snapshot/app/runtime/intent-compiler.mjs';

// This tests typed metadata persistence only. All IDs/hashes/ACKs are synthetic;
// no receipt below claims that native audio or a real user/browser was observed.
const roomId = '11111111-1111-4111-a111-111111111111';
const key = {roomId, sessionId: 'example_epoch', controlRevision: 0, targetPlayerId: 'synthetic-player', graphEpoch: 1};
const seal = body => ({...body, receiptSha256: cueDigest(body)});
function record() {
  const ack = {kind: 'cloud-source-playback-started-v1', graphEpoch: 1, sourceClipId: 'synthetic-source', sourceSha256: 'a'.repeat(64),
    sourceContextSha256: 'b'.repeat(64), sourcePlaybackRevision: 0, sampleRate: 44100, playedUntilFrame: 512,
    processedWindowSha256: 'd'.repeat(64), actual: true, audioStarted: true, participantCredit: false};
  return seal({kind: 'immutable-source-start-receipt-v1', ...key, sourceClipId: ack.sourceClipId, sourceSha256: ack.sourceSha256,
    sourceContextSha256: ack.sourceContextSha256, sourcePlaybackRevision: 0, queuedPrefixFrames: 24 * 44100,
    queuedPrefixSha256: 'c'.repeat(64), processedWindowSha256: ack.processedWindowSha256, startMode: 'bootstrap', maximumDurationFrames: 24 * 44100,
    continuationPlanSha256: null, continuationRenderSha256: null, authoritySha256: 'e'.repeat(64), ackSha256: cueDigest(ack), ack,
    serverReceivedAtMs: 1, actual: true, sourceOnly: true, participantCredit: false});
}

test('source-start private store is default-off and has a dedicated typed namespace surviving restart without ingestion receipt reuse', async () => {
  const transport = syntheticStorageTransport(), off = createSupabasePrivateStore({roomId, transport: transport.transport});
  await assert.rejects(off.sourceStartReceiptStore.saveImmutable(record()), /NOT_ACTIVATED/);
  assert.equal(transport.calls.length, 0); off.close();
  const live = createSupabasePrivateStore({enabled: true, roomId, transport: transport.transport});
  try {
    const saved = await live.sourceStartReceiptStore.saveImmutable(record()); assert.equal(saved.duplicate, false);
    assert.equal([...transport.objects.keys()].length, 1); assert([...transport.objects.keys()].every(path => path.includes('/source-start-receipts/')));
    const puts = transport.calls.filter(call => call.action === 'put').length;
    const restarted = createSupabasePrivateStore({enabled: true, roomId, transport: transport.transport});
    try {
      assert.deepEqual(await restarted.sourceStartReceiptStore.read(key), record());
      assert.equal((await restarted.sourceStartReceiptStore.saveImmutable(record())).duplicate, true);
      assert.equal(transport.calls.filter(call => call.action === 'put').length, puts);
    } finally {restarted.close();}
  } finally {live.close();}
});

test('source-start typed store rejects cross-room keys, changed ACKs and physical metadata corruption without overwriting', async () => {
  const transport = syntheticStorageTransport(), live = createSupabasePrivateStore({enabled: true, roomId, transport: transport.transport});
  try {
    await live.sourceStartReceiptStore.saveImmutable(record()); const puts = transport.calls.filter(call => call.action === 'put').length;
    await assert.rejects(live.sourceStartReceiptStore.read({...key, roomId: '22222222-2222-4222-a222-222222222222'}), /ROOM_BINDING/);
    const {receiptSha256, ...body} = record(); body.ack.playedUntilFrame = 768; body.ackSha256 = cueDigest(body.ack);
    await assert.rejects(live.sourceStartReceiptStore.saveImmutable(seal(body)), /ACK_CONFLICT/);
    await assert.rejects(live.sourceStartReceiptStore.saveImmutable({...record(), arbitraryQC: true}), /IMMUTABLE_SOURCE_START_RECEIPT/);
    assert.equal(transport.calls.filter(call => call.action === 'put').length, puts);
    const physical = [...transport.objects.values()][0], original = Buffer.from(physical.bytes);
    physical.bytes = Buffer.from(original.toString().replace('synthetic-source', 'changed--source'));
    await assert.rejects(live.sourceStartReceiptStore.read(key), /RECORD_CHANGED/); physical.bytes = original;
    assert.deepEqual(await live.sourceStartReceiptStore.read(key), record());
  } finally {live.close();}
});

test('unknown source-start write reply recovers the same immutable typed receipt after process replacement without another put', async () => {
  const transport = syntheticStorageTransport(), basePut = transport.transport.putObjectIfAbsent; let lose = true;
  transport.transport.putObjectIfAbsent = async input => {await basePut(input); if (lose) {lose = false; throw Error('synthetic lost metadata response');}};
  const first = createSupabasePrivateStore({enabled: true, roomId, transport: transport.transport});
  await assert.rejects(first.sourceStartReceiptStore.saveImmutable(record()), /PRIVATE_STORE_FAILED/); first.close();
  const fresh = createSupabasePrivateStore({enabled: true, roomId, transport: transport.transport});
  try {
    const recovered = await fresh.sourceStartReceiptStore.saveImmutable(record()); assert.equal(recovered.duplicate, true);
    assert.deepEqual(recovered.record, record()); assert.equal(transport.calls.filter(call => call.action === 'put').length, 1);
  } finally {fresh.close();}
});
