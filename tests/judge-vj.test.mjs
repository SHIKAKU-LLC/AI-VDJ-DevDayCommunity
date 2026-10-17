import test from 'node:test';
import assert from 'node:assert/strict';
import {createVjDynamics, createAudioReactiveVj} from '../room-web/judge-vj.mjs';

test('low-frequency attacks create pulses that decay between kicks', () => {
  const bins = new Uint8Array(512), dynamics = createVjDynamics();
  dynamics.step(bins, 0, 0, .02);
  bins.fill(220, 1, 6);
  const hit = dynamics.step(bins, .2, .02, .02);
  assert.equal(hit.beats, 1); assert.equal(hit.pulse, 1);
  assert.ok(hit.bass > hit.high);
  bins.fill(0);
  for (let n = 2; n < 70; n++) dynamics.step(bins, 0, n * .02, .02);
  assert.ok(dynamics.state.pulse < .01);
  bins.fill(220, 1, 6); dynamics.step(bins, .2, 1.5, .02);
  assert.equal(dynamics.state.beats, 2);
});

test('high-frequency detail cannot trigger bass pulses and invalid samples stay bounded', () => {
  const bins = new Uint8Array(512), dynamics = createVjDynamics(); bins.fill(220, 50, 230);
  const high = dynamics.step(bins, .3, 1, .02);
  assert.equal(high.beats, 0); assert.ok(high.high > high.bass);
  dynamics.step(new Float32Array(512).fill(NaN), Infinity, 2, .02);
  for (const value of Object.values(dynamics.state)) assert.ok(Number.isFinite(value) && value >= 0);
});

test('an unavailable canvas leaves audio untouched', () => {
  const vj = createAudioReactiveVj({canvas: {getContext: () => null}});
  vj.start(); vj.stop(); vj.dispose();
  assert.deepEqual(vj.read(), {active: false, reason: 'canvas-unavailable'});
});
