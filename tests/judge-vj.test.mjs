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

test('display requests can sample the signal without the owner animation loop', () => {
  const originals = Object.fromEntries(['matchMedia','ResizeObserver','devicePixelRatio','cancelAnimationFrame'].map(key => [key, globalThis[key]]));
  const connections = [], analyser = {
    frequencyBinCount:512, fftSize:1024,
    getByteFrequencyData: bins => bins.fill(220,1,6),
    getFloatTimeDomainData: wave => wave.fill(.2),
  };
  Object.assign(globalThis, {
    matchMedia: () => ({matches:false}),
    ResizeObserver: class {observe(){} disconnect(){}},
    devicePixelRatio:1, cancelAnimationFrame() {},
  });
  try {
    const context = {currentTime:1, sampleRate:44100, createAnalyser:()=>analyser};
    const input = {connect:node=>connections.push(node),disconnect() {}};
    const vj=createAudioReactiveVj({context,input,canvas:{getContext:()=>({clearRect(){}}),getBoundingClientRect:()=>({width:100,height:100})},videoLayer:{style:{}}});
    const sampled=vj.sample();
    assert.ok(sampled.signal.bass>0);
    assert.equal(vj.read().frames,0);
    assert.equal(vj.read().active,false);
    assert.deepEqual(connections,[analyser]);
    const sameFrame=vj.sample();assert.equal(sameFrame.signal.beats,sampled.signal.beats);
    vj.dispose();
  } finally {
    for(const [key,value] of Object.entries(originals)) {
      if(value===undefined)delete globalThis[key];else globalThis[key]=value;
    }
  }
});
