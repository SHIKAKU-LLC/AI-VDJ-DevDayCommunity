import test from "node:test";
import assert from "node:assert/strict";
import { gainForDb, createMasterOutput } from "../room-web/judge-output.mjs";
test("master output is unity by default, never amplifies and silences at the floor", () => {
  assert.equal(gainForDb(0), 1);
  assert.equal(gainForDb(6), 1);
  assert.ok(Math.abs(gainForDb(-6) - 0.501187) < 0.00001);
  assert.equal(gainForDb(-60), 0);
  assert.equal(gainForDb(0, true), 0);
});
test("one speaker path, post-gain stereo measurement and a 30ms ramp without transport mutation", () => {
  const calls = [],
    links = [];
  let index = 0;
  const node = () => ({
    id: index++,
    connect(...args) {
      links.push([this.id, ...args]);
    },
  });
  const gain = node();
  gain.gain = {
    value: 0,
    cancelAndHoldAtTime: (t) => calls.push(["hold", t]),
    linearRampToValueAtTime: (v, t) => calls.push(["ramp", v, t]),
  };
  const context = {
    currentTime: 2,
    destination: { id: "speaker" },
    createGain: () => gain,
    createChannelSplitter: node,
    createAnalyser: () =>
      Object.assign(node(), { getFloatTimeDomainData: (a) => a.fill(0.5) }),
  };
  const output = createMasterOutput(context);
  assert.equal(gain.gain.value, 1);
  output.set(-6, false);
  assert.deepEqual(calls, [
    ["hold", 2],
    ["ramp", gainForDb(-6), 2.03],
  ]);
  assert.equal(links.filter((x) => x[1] === context.destination).length, 1);
  assert.equal(output.read().channels.length, 2);
  assert.ok(Math.abs(output.read().channels[0].peakDb + 6.0206) < 0.001);
  output.set(0, true);
  assert.deepEqual(calls.at(-1), ["ramp", 0, 2.03]);
});
