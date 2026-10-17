import test from 'node:test';
import assert from 'node:assert/strict';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';
import {createOwnerAutoDjFixture, AUTO_DJ_RATE as RATE} from './cloud-owner-autodj-fixture.mjs';

// No direct coordinator reserve/check/ACK or direct player commit in this test.
// The production owner controller drives them through its actual HTTP/pump path.
// PCM is genuinely processed by the repository worklet in a VM; video frame
// observations are injected, not a claim of real browser/hardware AV playback.
test('owner AutoDJ start/pump/once/check/ACK reconciles three synthetic nativeAV guests, then stops without further reservation',
  {skip: !process.env.VDJ_QC_PYTHON}, async t => {
  const f = await createOwnerAutoDjFixture();
  let context = {index: 0, stage: 'SOURCE_START'}, outcome = 'failed';
  try {
    await f.startSource(); context = {index: 1, stage: 'FIRST_GENERATION'}; let set = await f.generate(1);
    assert.equal(f.ownerStates.filter(state => state.state === 'PLAYING').length, 0, 'initial source is never participant credit');
    assert.equal(f.sourceReceipt().accepted, true); assert.equal(f.sourceReceipt().sourceOnly, true); assert.equal(f.sourceReceipt().participantCredit, false);
    assert.equal(f.sourceStartObjectCount(), 1); const storedSourceReceipt = await f.readStoredSourceReceipt();
    assert.equal(storedSourceReceipt.receiptSha256, f.sourceReceipt().receiptSha256); assert.equal(storedSourceReceipt.sourceOnly, true);
    assert.equal(storedSourceReceipt.participantCredit, false); assert.equal(storedSourceReceipt.startMode, 'bootstrap');
    assert.equal(storedSourceReceipt.processedWindowSha256, await pcmSha256(f.graph.observations.find(event => event.playedWindow?.startFrame === 0).playedWindow.pcm));
    assert.equal((await f.retrySourceAck()).duplicate, true); assert.equal(f.sourceStartObjectCount(), 1);
    await assert.rejects(f.deniedSourceAck(), /OWNER_DENIED/); assert.equal((await f.readState()).currentCredit, null);
    assert.equal(f.sourceAckHttpCalls(), 3, 'initial, duplicate and denied source ACK traverse the typed HTTP handler');
    await f.host.start(); const joinedFirstPump = f.host.once();
    for (const index of [1, 2, 3]) {
      context = {index, stage: 'GENERATION_AND_QUEUE'};
      if (index > 1) {set = await f.generate(index); f.scheduler.tick();}
      await f.wait(() => f.graph.commands.filter(command => command.type === 'replace-future').length === index, {index, stage: 'QUEUE'});
      assert.equal(f.port.read().phase, 'STARTING', JSON.stringify(f.describe(index, 'QUEUE')));
      assert.equal(f.ownerStates.filter(state => state.state === 'PLAYING').length, index - 1, 'reservation/commit acceptance earns no credit');
      context = {index, stage: 'PCM_AND_OWNER_ACK'};
      await f.pumpTo(index * 24 * RATE + RATE / 2, {index});
      await f.wait(() => f.ownerStates.filter(state => state.state === 'PLAYING').length === index, {index, stage: 'OWNER_PLAYING'});
      context = {index, stage: 'NEXT_TIMER'};
      await f.wait(() => f.scheduler.pending.size === 1, {index, stage: 'NEXT_TIMER'});
      const credit = f.ownerStates.filter(state => state.state === 'PLAYING').at(-1).currentCredit;
      assert.equal(credit.cueId, set.cue.cueId); assert.equal(credit.playbackRevision, index);
      assert.equal(credit.participantId, f.guests[index - 1].participantId); assert.equal(credit.nickname, f.guests[index - 1].nickname);
      assert.equal(credit.actual, true); assert.equal(credit.actualPlayback, true);
      const trace = f.graph.observations.find(event => event.playedWindow?.startFrame === index * 24 * RATE).playedWindow;
      assert.equal(await pcmSha256(trace.pcm), f.descriptors[index - 1].expectedPlayedWindowSha256);
      assert.equal(f.descriptors[index - 1].startFrame, 24 * RATE); assert.equal(f.descriptors[index - 1].durationFrames, 48 * RATE);
      assert.equal(f.graph.processor.underruns, 0); assert.equal(f.port.read().sourceCount, 1);
      if (index === 1) await joinedFirstPump;
      if (index < 3) await f.promote(set, index);
    }
    assert.equal(f.commits(), 3, 'lost ACK reply and concurrent once do not replay a cue');
    assert.equal(f.lostAck(), true); assert.equal(f.actions.filter(item => item.action === 'reserve').length, 3);
    // The lost ACK reply is confirmed by one idempotent ACK retry (same ackSha256,
    // no second credit), so no reconciliation read is needed.
    assert.equal(f.actions.filter(item => item.action === 'ack').length, 4);
    assert.equal(f.actions.filter(item => item.action === 'state').length, 0, 'idempotent ACK retry confirms the lost reply');
    assert.equal(f.actions.filter(item => item.action === 'start').length, 1);
    // cueAck rechecks reservation/expiry/Stop atomically; no separate pre-ACK read.
    assert.ok(!f.actions.filter(item => item.action === 'check').some(item => item.body.phase === 'ack'));
    assert.ok(f.scheduler.scheduled.every(item => [0,5000].includes(item.ms)));
    assert.equal(f.scheduler.scheduled.filter(item=>item.ms===0).length,3,'each accepted AV ACK schedules the next preparation immediately');
    const state = await f.readState(); assert.deepEqual(state.servedCounts, Object.fromEntries(f.guests.map(guest => [guest.participantId, 1])));
    assert.equal(f.posts.length, 9);
    for (const phase of ['credentials-before-begin', 'begin-before', 'submit-before-claim', 'submit-before-provider', 'submit-after-provider',
      'poll-before-result', 'qc-before-prepare', 'qc-after-prepare', 'qc-before-inspect', 'qc-before-publish', 'qc-after-publish'])
      assert.ok(f.authorityCalls.some(call => call.phase === phase), `typed authority must guard ${phase}`);
    assert.equal(new Set(f.authorityCalls.map(call => call.operationId)).size, 3);
    assert.equal(f.recoveryRuns.length, 6, 'two reconstructed bounded recovery invocations finish each original operation');
    assert.deepEqual(f.recoveryRuns.map(run => run.results[0].state), ['PENDING', 'READY', 'PENDING', 'READY', 'PENDING', 'READY']);
    assert.ok(f.recoveryRuns.every(run => run.durableScheduler === false && run.automaticRetry === false));
    context = {index: 3, stage: 'FINITE_END'};
    await f.pumpTo(96 * RATE, {index: 3, allowFiniteEnd: true});
    assert.equal(f.port.read().phase, 'STOPPED'); assert.equal(f.graph.processor.consumed, 96 * RATE); assert.equal(f.graph.processor.underruns, 0);
    const queuedTick = [...f.scheduler.pending.values()][0], reservations = f.actions.filter(item => item.action === 'reserve').length;
    await f.host.stop(); assert.equal(f.scheduler.pending.size, 0); queuedTick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.actions.filter(item => item.action === 'reserve').length, reservations, 'a late cancelled timer cannot reserve after Stop');
    const stopped = await f.readState(); assert.equal(stopped.stopped, true); assert.equal(stopped.pending, false); assert.equal(stopped.currentCredit, null);
    assert.deepEqual(stopped.servedCounts, state.servedCounts); assert.equal(f.posts.length, 9);
    await assert.rejects(f.host.once(), /CUE_HOST_NOT_RUNNING/);
    outcome = 'passed'; context = {index: 3, stage: 'STOP_VERIFIED'};
    t.diagnostic(JSON.stringify({nativeQcSets: 3, syntheticParticipants: 3, servedCounts: [1, 1, 1], ownerPumpReservations: 3,
      ownerCommitAttempts: 3, lostAckReplyReconciled: true, scheduledTickOnly: true, finiteGraphFrames: 96 * RATE,
      providerNetworkRequests: 0, paidGenerations: 0, syntheticVideoCallbacks: true, realBrowserOrSpeakersVerified: false,
      sourcePromotion: 'production-snapshot-and-verified-current-ports-with-fixture-authority',
      sourceStart: 'typed-host-HTTP-source-ACK-and-immutable-private-receipt-from-VM-prefix',
      offlineSourceAckHttpHandlerUsed: true, liveSourceAckHttpMounted: false, typedDispatchGuardOptIn: true,
      recoveryRunnerInvocations: f.recoveryRuns.length, reconstructedAfterFabricatedLostWakeHint: true,
      ...f.timingSummary(),
      real24sGenerationDeadlineVerified: false, constrainedLinuxCapacityVerified: false}));
  } finally {
    // Capture before dispose can replace the original terminal reason with STOP.
    // Only synthetic state enums, stable codes and numeric counters are logged.
    t.diagnostic(JSON.stringify({kind: 'owner-autodj-final-diagnostic', outcome, ...f.describe(context.index, context.stage), ...f.timingSummary()}));
    await f.close();
  }
});
