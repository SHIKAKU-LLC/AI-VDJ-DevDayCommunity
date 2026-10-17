const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

// Split the playing mix into frequency bands. Attack and decay follow the
// actual signal; the visual clock never advances or restarts the music.
export function createVjDynamics({sampleRate = 44100, fftSize = 1024} = {}) {
  const state = {bass: 0, mid: 0, high: 0, level: 0, pulse: 0, beats: 0};
  let priorBass = 0, lastBeat = -1, baseline = 0;
  const band = (bins, low, high) => {
    const from = Math.max(1, Math.floor(low * fftSize / sampleRate));
    const to = Math.min(bins.length - 1, Math.ceil(high * fftSize / sampleRate));
    let sum = 0;
    for (let i = from; i <= to; i++) sum += clamp(bins[i] / 255);
    return to >= from ? sum / (to - from + 1) : 0;
  };
  return {
    state,
    step(bins, rms, time, delta) {
      const dt = Math.max(.001, Math.min(.1, delta));
      const bass = band(bins, 45, 190);
      const onset = bass > .1 && bass > priorBass + .035 && bass > baseline * 1.08 && time - lastBeat > .18;
      if (onset) { lastBeat = time; state.beats++; }
      baseline += (bass - baseline) * (1 - Math.exp(-dt / 1.2));
      state.pulse = Math.max(state.pulse * Math.exp(-dt / .18), onset ? 1 : clamp((bass - baseline) * 2));
      const follow = 1 - Math.exp(-dt / .08);
      state.bass += (bass - state.bass) * follow;
      state.mid += (band(bins, 190, 2000) - state.mid) * follow;
      state.high += (band(bins, 2000, 10000) - state.high) * follow;
      state.level += (clamp(rms * 3) - state.level) * follow;
      priorBass = bass;
      return state;
    },
  };
}

export function createAudioReactiveVj({context, input, canvas, videoLayer}) {
  const graphics = canvas?.getContext('2d');
  if (!graphics) return {start() {}, stop() {}, setTrack() {}, dispose() {}, read: () => ({active: false, reason: 'canvas-unavailable'})};
  const analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = .12;
  analyser.minDecibels = -90; analyser.maxDecibels = -5;
  // AnalyserNode also works with an unconnected output; keep the speaker path
  // untouched so adding visuals cannot duplicate, mute or delay the sound.
  input.connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount), wave = new Float32Array(analyser.fftSize);
  const dynamics = createVjDynamics({sampleRate: context.sampleRate, fftSize: analyser.fftSize});
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let running = false, frameId, width = 1, height = 1, prior = 0, frames = 0, started = 0, trackStart = 0, hue = 285;
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 1.5, 1920 / Math.max(1, rect.width), 1080 / Math.max(1, rect.height));
    width = canvas.width = Math.max(1, Math.round(rect.width * ratio));
    height = canvas.height = Math.max(1, Math.round(rect.height * ratio));
  };
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  function draw() {
    if (!running) return;
    const time = context.currentTime, delta = prior ? time - prior : 1 / 60; prior = time;
    analyser.getByteFrequencyData(bins); analyser.getFloatTimeDomainData(wave);
    let power = 0; for (const sample of wave) power += sample * sample;
    const signal = dynamics.step(bins, Math.sqrt(power / wave.length), time, delta);
    const amount = motion.matches ? .12 : 1, pulse = signal.pulse * amount;
    const age = Math.max(0, time - trackStart), mode = Math.floor(age / 13.714) % 3;
    const radius = Math.hypot(width, height) * .55, sides = [6, 3, 8][mode];
    graphics.clearRect(0, 0, width, height);
    graphics.save(); graphics.translate(width / 2, height / 2); graphics.globalCompositeOperation = 'screen';
    const colour = hue + Math.floor(signal.beats / 16) * 35;
    for (let ring = 0; ring < 8; ring++) {
      const phase = (ring / 8 + age * .12 * amount) % 1;
      const r = radius * phase * phase * (1 + pulse * .18);
      const turn = age * .09 * amount + ring * .1 + signal.mid * .12;
      graphics.beginPath();
      for (let point = 0; point <= sides; point++) {
        const angle = point / sides * Math.PI * 2 + turn;
        const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
        if (point) graphics.lineTo(x, y); else graphics.moveTo(x, y);
      }
      graphics.strokeStyle = `hsla(${colour + ring * 13},95%,65%,${(.15 + pulse * .48) * (1 - phase * .55)})`;
      graphics.lineWidth = Math.max(1, height / 450) * (1 + pulse * 2); graphics.stroke();
    }
    for (let ray = 0; ray < 24; ray++) {
      const angle = ray * Math.PI / 12 - age * .035 * amount;
      const inner = radius * (.2 + .1 * signal.mid), outer = inner + radius * (.08 + signal.high * .2) * (ray % 3 ? .5 : 1);
      graphics.beginPath(); graphics.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      graphics.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
      graphics.strokeStyle = `hsla(${colour + 100},95%,75%,${.1 + signal.high * .5})`;
      graphics.lineWidth = Math.max(1, height / 600); graphics.stroke();
    }
    graphics.restore();
    videoLayer.style.transform = `scale(${1.06 + pulse * .075}) rotate(${Math.sin(age * .35) * .5 * amount}deg)`;
    frames++; frameId = requestAnimationFrame(draw);
  }
  const stop = () => { running = false; cancelAnimationFrame(frameId); graphics.clearRect(0, 0, width, height); videoLayer.style.transform = ''; };
  return {
    start() { if (!running) { running = true; started = context.currentTime; prior = 0; frames = 0; draw(); } },
    stop,
    setTrack(id) { trackStart = context.currentTime; hue = [...String(id)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0); },
    read: () => ({active: running, ...dynamics.state, frames, fps: frames / Math.max(.1, context.currentTime - started), width, height, reducedMotion: motion.matches}),
    dispose() { stop(); observer.disconnect(); input.disconnect(analyser); },
  };
}
