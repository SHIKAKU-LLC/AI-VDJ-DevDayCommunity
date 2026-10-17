// One worklet remains the clock owner. AudioContext only fills its reporting gap.
export const AUDIO_CLOCK_SOURCE = 'worklet-counter-plus-audio-context';
const RATE = 44100, MAX_FRAMES = 180 * RATE, MAX_EXTRAPOLATION = .5;

export function readWorkletAudioTime(telemetry, contextTime, running) {
  const sampled = telemetry.consumedFrames / RATE;
  if (!running || !Number.isFinite(telemetry.outputContextTime) || !Number.isFinite(contextTime)) return sampled;
  const available = Math.max(0, (telemetry.receivedFrames - telemetry.consumedFrames) / RATE);
  return sampled + Math.min(MAX_EXTRAPOLATION, Number.isFinite(available) ? available : 0, Math.max(0, contextTime - telemetry.outputContextTime));
}

export function resolveWorkletAudioClock(body, previous = { consumedFrames: 0, receivedFrames: 0, audioTime: 0 }) {
  const t = body.telemetry;
  if (!t || t.sampleRate !== RATE || !Number.isInteger(t.consumedFrames) || t.consumedFrames < previous.consumedFrames || t.consumedFrames > MAX_FRAMES || !Number.isInteger(t.receivedFrames) || t.receivedFrames < Math.max(t.consumedFrames, previous.receivedFrames) || t.receivedFrames > MAX_FRAMES || !Number.isInteger(t.underrunFrames) || t.underrunFrames < 0 || t.underrunFrames > t.consumedFrames) throw Error('MONOTONIC_CALLBACK_REQUIRED');
  const sampled = t.consumedFrames / RATE;
  const estimated = body.audioTime === undefined ? sampled : body.audioTime;
  if (!Number.isFinite(estimated) || estimated < sampled - 1e-9 || estimated > Math.min(sampled + MAX_EXTRAPOLATION, t.receivedFrames / RATE) + 1e-9 || (body.audioTime !== undefined && body.audioClockSource !== AUDIO_CLOCK_SOURCE)) throw Error('BOUNDED_WORKLET_CLOCK_REQUIRED');
  // A repeated sample is valid between reports, even after an interpolated tick.
  return Object.freeze({ consumedFrames: t.consumedFrames, receivedFrames: t.receivedFrames, audioTime: Math.max(previous.audioTime, estimated), sampledAudioTime: sampled, source: body.audioTime === undefined ? 'worklet-counter' : AUDIO_CLOCK_SOURCE });
}

export function commitPollDelay(pending, audioTime) {
  return Number.isFinite(pending?.playAt) && Math.abs(pending.playAt - audioTime) <= .5 ? 50 : 150;
}
