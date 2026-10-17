export const mixCurve = fadeIn => Float32Array.from({length: 128}, (_, i) => .7 * (fadeIn ? Math.sin(i / 127 * Math.PI / 2) : Math.cos(i / 127 * Math.PI / 2)));
// Schedule against the audio clock, not network or JavaScript timer completion.
// Each source overlaps the next one. Until new media is decoded, repeat the
// current track; a late/failed generation never removes the playing buffer.
export function createContinuousPlayer({context, destination = context.destination, onTrack = () => {}, setTimer = setInterval, clearTimer = clearInterval}) {
  let tracks = [], position = 0, nextAt = 0, running = false, timer, revision = 0;
  const sources = new Set(), scheduled = [];
  const crossfade = 1.5;
  function schedule(track, at, fadeIn) {
    const source = context.createBufferSource(), gain = context.createGain(), bass = context.createBiquadFilter();
    bass.type = 'lowshelf'; bass.frequency.value = 110;
    source.buffer = track.buffer;
    const end = at + track.buffer.duration;
    gain.gain.setValueAtTime(fadeIn ? 0 : .7, at);
    if (fadeIn) gain.gain.setValueCurveAtTime(mixCurve(true), at, crossfade);
    gain.gain.setValueAtTime(.7, end - crossfade);
    gain.gain.setValueCurveAtTime(mixCurve(false), end - crossfade, crossfade);
    bass.gain.setValueAtTime(fadeIn ? -18 : 0, at);
    if (fadeIn) bass.gain.linearRampToValueAtTime(0, at + crossfade / 2);
    bass.gain.setValueAtTime(0, end - crossfade);
    bass.gain.linearRampToValueAtTime(-18, end - crossfade / 2);
    source.connect(bass); bass.connect(gain); gain.connect(destination);
    source.start(at); source.stop(end);
    sources.add(source); source.onended = () => { sources.delete(source); source.disconnect(); bass.disconnect(); gain.disconnect(); };
    scheduled.push({id: track.id, start: at, end});
    if (scheduled.length > 100) scheduled.shift();
    nextAt = end - crossfade;
  }
  function tick() {
    if (!running) return;
    // If a backgrounded tab's timer was suspended, resume using the current
    // buffer rather than scheduling obsolete sources in the past.
    if (nextAt < context.currentTime) nextAt = context.currentTime + 0.05;
    if (nextAt < context.currentTime + 4) {
      position = Math.min(position + 1, tracks.length - 1);
      const track = tracks[position]; schedule(track, nextAt, true);
    }
    const current = scheduled.findLast(s => s.start <= context.currentTime && s.end > context.currentTime);
    if (current && current.id !== tick.current) { tick.current = current.id; onTrack(tracks.find(t => t.id === current.id)); }
  }
  return {
    add(track) { if (!tracks.some(t => t.id === track.id) && track.buffer.duration > 4) tracks.push(track); },
    async start() {
      if (running || !tracks.length) return;
      await context.resume(); running = true; revision++; tick.current = null;
      schedule(tracks[position], context.currentTime + 0.1, true); timer = setTimer(tick, 100);
    },
    stop() {
      running = false; revision++; clearTimer(timer);
      for (const source of sources) { try { source.stop(); } catch { /* already ended */ } }
      sources.clear(); scheduled.length = 0; tick.current = null;
    },
    read() { return {running, revision, contextState: context.state, audioTime: context.currentTime,
      currentId: tick.current, scheduled: scheduled.map(s => ({...s})), ready: tracks.length}; },
    tick,
  };
}
