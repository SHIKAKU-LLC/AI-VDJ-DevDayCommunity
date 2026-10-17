import test from 'node:test';
import assert from 'node:assert/strict';
import {createScenePlayer} from '../room-web/judge-scenes.mjs';
import {mixCurve} from '../room-web/judge-player.mjs';

test('new visual scenes replace each other while the music clock keeps moving', async () => {
  let time = 0; const displayed = [];
  const player = createScenePlayer({clock: () => time, setTimer() {}, clearTimer() {}, onChange: async scene => displayed.push(scene.id)});
  for (let n = 0; n < 6; n++) player.add({id: 'a' + n, trackId: 'music-a', duration: 12});
  player.setTrack('music-a'); player.start(); await player.tick();
  for (let n = 1; n < 6; n++) { time = n * 11.3; await player.tick(); }
  assert.equal(new Set(displayed).size, 6);
  assert.equal(player.read().history.length, 6);
  assert.equal(time, 56.5);
  player.stop();
});
test('fallback stock is used until a new prompt scene arrives without repeating the active scene', async () => {
  let time = 0; const displayed = [];
  const player = createScenePlayer({clock: () => time, setTimer() {}, clearTimer() {}, onChange: async scene => displayed.push(scene.id)});
  player.add({id: 'stock-a', trackId: null, duration: 12}); player.add({id: 'stock-b', trackId: null, duration: 12});
  player.setTrack('music-a'); player.start(); await player.tick();
  time = 12; player.add({id: 'new-a', trackId: 'music-a', duration: 12}); await player.tick();
  assert.deepEqual(displayed, ['stock-a', 'new-a']);
  time = 24; await player.tick(); assert.equal(displayed.at(-1), 'stock-b');
  player.stop(); time = 100; await player.tick(); assert.equal(displayed.length, 3);
});
test('equal-power transition keeps overlap power constant with peak headroom', () => {
  const incoming = mixCurve(true), outgoing = mixCurve(false);
  for (let i = 0; i < incoming.length; i++) {
    assert.ok(Math.abs(incoming[i] ** 2 + outgoing[i] ** 2 - .49) < 1e-6);
    assert.ok(incoming[i] + outgoing[i] < 1);
  }
});
test('stopping while a scene is loading never activates the late scene', async () => {
  let release, active = false;
  const pending = new Promise(resolve => { release = resolve; });
  const player = createScenePlayer({clock: () => 0, setTimer() {}, clearTimer() {},
    async onChange(scene, previous, isCurrent) { await pending; if (isCurrent()) active = true; }});
  player.add({id: 'late', duration: 12}); player.start(); player.stop();
  release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(active, false); assert.equal(player.read().history.length, 0);
});
