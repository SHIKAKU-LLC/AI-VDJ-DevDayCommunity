// One master gain, after the continuity/VJ tap. No transport changes on mute.
export function gainForDb(db, muted = false) {
  return muted || db <= -60 ? 0 : 10 ** (Math.min(0, db) / 20);
}
export function createMasterOutput(context) {
  const input = context.createGain();
  input.gain.value = 1;
  input.connect(context.destination);
  const splitter = context.createChannelSplitter(2);
  input.connect(splitter);
  const analysers = [0, 1].map((channel) => {
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    splitter.connect(analyser, channel);
    return { analyser, wave: new Float32Array(analyser.fftSize) };
  });
  return {
    input,
    set(db, muted) {
      const now = context.currentTime;
      input.gain.cancelAndHoldAtTime(now);
      input.gain.linearRampToValueAtTime(gainForDb(db, muted), now + 0.03);
    },
    read() {
      return {
        channels: analysers.map(({ analyser, wave }) => {
          analyser.getFloatTimeDomainData(wave);
          let peak = 0,
            power = 0;
          for (const value of wave) {
            peak = Math.max(peak, Math.abs(value));
            power += value * value;
          }
          const decibels = (value) =>
            value > 0 ? Math.max(-60, 20 * Math.log10(value)) : -60;
          return {
            peakDb: decibels(peak),
            rmsDb: decibels(Math.sqrt(power / wave.length)),
          };
        }),
      };
    },
  };
}
