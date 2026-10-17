class ContinuityMeter extends AudioWorkletProcessor {
  constructor() { super(); this.active = false; this.frames = 0; this.zeroRun = 0; this.maximumZeroRun = 0; this.nonfinite = 0;
    this.port.onmessage = event => { this.active = event.data === 'start'; this.frames = 0; this.zeroRun = 0; this.maximumZeroRun = 0; this.nonfinite = 0; };
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    for (let c = 0; c < output.length; c++) output[c].set(input[c] ?? new Float32Array(output[c].length));
    if (this.active) for (let i = 0; i < output[0].length; i++) {
      let peak = 0;
      for (const channel of input) { const value = channel[i]; if (!Number.isFinite(value)) this.nonfinite++; peak = Math.max(peak, Math.abs(value)); }
      // Ignore the first second's intentional fade-in. Record silence in the
      // actual browser graph without exporting samples or personal audio data.
      this.frames++;
      if (this.frames > sampleRate) {
        this.zeroRun = peak < 0.00001 ? this.zeroRun + 1 : 0;
        this.maximumZeroRun = Math.max(this.maximumZeroRun, this.zeroRun);
      }
    }
    if (this.active && this.frames % 16384 === 0) this.port.postMessage({frames: this.frames, sampleRate,
      maximumSilentSeconds: this.maximumZeroRun / sampleRate, nonfinite: this.nonfinite});
    return true;
  }
}
registerProcessor('vdj-continuity-meter', ContinuityMeter);
