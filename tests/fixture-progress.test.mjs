import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForFixtureProgress} from './fixture-progress.mjs';

test('a delivered command is observed on the final resumed turn even after scheduler descheduling crosses the diagnostic deadline', async () => {
  let clock = 0, turns = 0; const commands = [];
  await waitForFixtureProgress({ready: () => commands.length === 1, now: () => clock, timeoutMs: 5000,
    yieldTurn: async () => {turns++; commands.push({type: 'replace-future'}); clock = 5001;}});
  assert.equal(turns, 1); assert.equal(commands[0].type, 'replace-future');
});

test('a terminal rejection with an old PLAYING UI is reported immediately with counters instead of waiting for a queue deadline', async () => {
  let yields = 0;
  await assert.rejects(waitForFixtureProgress({ready: () => false,
    terminal: () => ({code: 'PLAYBACK_COMMIT_BUSY'}),
    describe: () => ({phase: 'PLAYING', deliveries: 2, expectedDeliveries: 3}),
    yieldTurn: async () => {yields++;}}), error => {
    assert.equal(error.code, 'FIXTURE_PROGRESS_TERMINAL'); assert.equal(error.terminalCode, 'PLAYBACK_COMMIT_BUSY');
    assert.match(error.message, /"phase":"PLAYING"/); assert.match(error.message, /"deliveries":2/); return true;
  });
  assert.equal(yields, 0);
});

test('a queued operation that then terminates cannot be mistaken for successful preparation', async () => {
  await assert.rejects(waitForFixtureProgress({ready: () => true,
    terminal: () => ({code: 'ACTUAL_AV_ACK_TIMEOUT'}),
    describe: () => ({phase: 'HOLD', deliveries: 3})}), error => error.terminalCode === 'ACTUAL_AV_ACK_TIMEOUT');
});

test('missing commands still fail at the original diagnostic deadline with actual state and counters', async () => {
  let clock = 0;
  await assert.rejects(waitForFixtureProgress({ready: () => false, now: () => clock, timeoutMs: 5000,
    describe: () => ({phase: 'PREPARING', deliveries: 2, expectedDeliveries: 3}),
    yieldTurn: async () => {clock = 5000;}}), error => {
    assert.equal(error.code, 'FIXTURE_PROGRESS_DEADLINE'); assert.match(error.message, /"phase":"PREPARING"/); return true;
  });
});
