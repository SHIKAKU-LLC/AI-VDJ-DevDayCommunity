/** Browser-only visual effects. Reads the caller's audio clock; never changes audio. */
const clamp = value => Math.max(0, Math.min(1, value));
export function centeredZoomWave(audioSeconds,beatGrid) {
  if(!Number.isFinite(audioSeconds)||!beatGrid)return 0;
  const phase=(audioSeconds-(beatGrid.offsetSeconds??0))*beatGrid.bpm/60;
  return .5+.5*Math.cos(phase*2*Math.PI);
}

export function validatePulseTimeline(timeline) {
  if (!timeline || !Number.isFinite(timeline.frameRate) || timeline.frameRate <= 0 || timeline.frameRate > 120 || !Number.isFinite(timeline.durationSeconds) || timeline.durationSeconds <= 0 || !Array.isArray(timeline.frameImpulses) || timeline.frameImpulses.length !== Math.round(timeline.frameRate * timeline.durationSeconds) || timeline.frameImpulses.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new TypeError('invalid measured pulse timeline');
  return Object.freeze({ ...timeline, frameImpulses: Object.freeze([...timeline.frameImpulses]) });
}

export function samplePulseTimeline(timeline, audioSeconds) {
  if (!Number.isFinite(audioSeconds) || audioSeconds < 0) return 0;
  const time = audioSeconds % timeline.durationSeconds;
  const frame = time * timeline.frameRate;
  const index = Math.floor(frame), weight = frame - index;
  const a = timeline.frameImpulses[index] ?? 0;
  const b = timeline.frameImpulses[(index + 1) % timeline.frameImpulses.length] ?? 0;
  return clamp(a + (b - a) * weight);
}

/** Optional reader for an ALREADY CONNECTED caller-owned AnalyserNode. */
export function createLowBandEnvelopeReader(analyser, { sampleRate, floorDb = -70, ceilingDb = -15 } = {}) {
  const rate = sampleRate ?? analyser?.context?.sampleRate;
  if (!analyser || typeof analyser.getFloatFrequencyData !== 'function' || !Number.isFinite(rate) || rate <= 0 || !Number.isInteger(analyser.frequencyBinCount) || analyser.frequencyBinCount <= 0 || !Number.isFinite(floorDb) || !Number.isFinite(ceilingDb) || ceilingDb <= floorDb) throw new TypeError('caller-owned analyser required');
  const bins = new Float32Array(analyser.frequencyBinCount);
  const step = rate / (bins.length * 2);
  const first = Math.max(0, Math.floor(40 / step)), last = Math.min(bins.length - 1, Math.ceil(180 / step));
  return () => {
    analyser.getFloatFrequencyData(bins);
    let power = 0, count = 0;
    for (let index = first; index <= last; index++) if (Number.isFinite(bins[index])) { power += 10 ** (bins[index] / 10); count++; }
    if (!count || power === 0) return 0;
    return clamp((10 * Math.log10(power / count) - floorDb) / (ceilingDb - floorDb));
  };
}

export function createRealtimePulse({
  adapter, readAudioTime, isAudioPlaying = () => true,
  timeline, readEnvelope, beatGrid, foregroundUrl, container,
  overlayFactory = () => document.createElement('div'),
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = handle => cancelAnimationFrame(handle),
  now = () => performance.now(), maxBeatLatenessSeconds = .10,
  readPulseStrength = () => .6, readZoomFraction = () => .025,
} = {}) {
  if (!adapter || typeof adapter.getPlaybackState !== 'function' || typeof readAudioTime !== 'function' || typeof requestFrame !== 'function' || typeof cancelFrame !== 'function' || typeof now !== 'function' || typeof isAudioPlaying !== 'function') throw new TypeError('adapter and caller audio clock required');
  if (!!timeline === (typeof readEnvelope === 'function')) throw new TypeError('choose measured timeline OR caller envelope reader');
  const measured = timeline ? validatePulseTimeline(timeline) : null;
  if (beatGrid && (!Number.isFinite(beatGrid.bpm) || beatGrid.bpm < 20 || beatGrid.bpm > 400 || !Number.isFinite(beatGrid.offsetSeconds ?? 0))) throw new TypeError('invalid caller beat grid');
  if (!Number.isFinite(maxBeatLatenessSeconds) || maxBeatLatenessSeconds < 0 || maxBeatLatenessSeconds > .25) throw new TypeError('invalid beat callback tolerance');
  if(typeof readPulseStrength!=='function'||typeof readZoomFraction!=='function')throw new TypeError('pulse strength/amplitude readers required');
  let overlay = null;
  if (foregroundUrl) {
    if (!container?.append || typeof foregroundUrl !== 'string' || !foregroundUrl || /[\r\n]/.test(foregroundUrl)) throw new TypeError('foreground container required');
    overlay = overlayFactory();
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '4', backgroundImage: `url(${JSON.stringify(foregroundUrl)})`, backgroundSize: 'cover', backgroundPosition: 'center', opacity: '0', maskImage: 'linear-gradient(to right, black, transparent 14%, transparent 86%, black), linear-gradient(to bottom, black, transparent 14%, transparent 86%, black)' });
    container.append(overlay);
  }
  const savedTransforms = new Map();
  let disposed = false, running = false, frameHandle = null, previousTime = null, previousRaf = null;
  let lastGridIndex = null, globalBeatIndex = 0, envelope = 0;
  let amplitude=0,zoom=0;
  const missedBeatDetails = [];
  const metrics = { source: measured ? 'measured-fixed-audio-timeline' : 'caller-live-envelope', pulseProfile:'centered-uniform-smooth-zoom-v1',translationApplied:false,rotationApplied:false,nonUniformScaleApplied:false,edgeOverlayPulseApplied:false,currentScale:1,maximumObservedScale:1,maximumScaleStep:0,pulseStrength:0,zoomFraction:0, frameUpdates: 0, rawDeckTransforms: 0, bakedDeckSuppressions: 0, maximumRafGapMs: 0, beatNotifications: 0, maximumBeatCallbackDelayMs: 0, missedBeatBoundaries: 0, clockResets: 0, lastAudioSeconds: null, lastImpulse: 0, audioRunning: false, beatGridVerified: beatGrid?.verified === true, measuredTimelineOfflineLookahead: !!measured, liveEnvelopeCausalAttackSeconds: measured ? null : .05, speakerToDisplaySyncMeasured: false };

  function resetTransform(element) {
    if (!savedTransforms.has(element)) savedTransforms.set(element, {transform:element.style.transform??'',transformOrigin:element.style.transformOrigin??''});
    Object.assign(element.style,savedTransforms.get(element));
  }
  function update() {
    if (disposed) return;
    const wall = now();
    const rafGapMs = previousRaf === null ? null : wall - previousRaf;
    if (rafGapMs !== null) metrics.maximumRafGapMs = Math.max(metrics.maximumRafGapMs, rafGapMs);
    previousRaf = wall;
    let time;
    try { time = readAudioTime(); } catch { time = NaN; }
    let playing = false;
    try { playing = !!isAudioPlaying(); } catch { /* Read-only consumer failure. */ }
    const valid = Number.isFinite(time) && time >= 0;
    if (valid && previousTime !== null && time < previousTime - .10) { lastGridIndex = null; metrics.clockResets++; envelope = 0; }
    const delta = valid && previousTime !== null ? Math.max(0, Math.min(.25, time - previousTime)) : 0;
    let impulse = 0;
    if (valid && measured) impulse = samplePulseTimeline(measured, time);
    else if (valid) {
      let observed = 0;
      try { observed = readEnvelope(time); } catch { /* Effects fail quiet, music is untouched. */ }
      observed = Number.isFinite(observed) ? clamp(observed) : 0;
      const duration = observed > envelope ? .05 : .15;
      envelope += (observed - envelope) * Math.min(1, delta / duration);
      impulse = clamp(envelope);
    }
    if (valid && playing && beatGrid) {
      const period = 60 / beatGrid.bpm, offset = beatGrid.offsetSeconds ?? 0;
      const index = Math.floor((time - offset) / period + 1e-9);
      if (index >= 0 && index !== lastGridIndex) {
        const lateness = time - (offset + index * period);
        if (lateness >= -1e-6 && lateness <= maxBeatLatenessSeconds) {
          adapter.onBeat({ index: globalBeatIndex++, timeMs: time * 1000 });
          metrics.beatNotifications++; metrics.maximumBeatCallbackDelayMs = Math.max(metrics.maximumBeatCallbackDelayMs, Math.max(0, lateness * 1000));
        } else {
          metrics.missedBeatBoundaries++;
          missedBeatDetails.push(Object.freeze({ reason: 'BEAT_CALLBACK_LATE', gridIndex: index, expectedAudioSeconds: offset + index * period, observedAudioSeconds: time, latenessMs: lateness * 1000, toleranceMs: maxBeatLatenessSeconds * 1000, previousAudioSeconds: previousTime, rafGapMs, wallMs: wall }));
          if (missedBeatDetails.length > 16) missedBeatDetails.shift();
        }
        lastGridIndex = index;
      }
    }
    let strength=0,fraction=0;
    try{strength=readPulseStrength();fraction=readZoomFraction();}catch{}
    strength=Number.isFinite(strength)?clamp(strength):0;fraction=Number.isFinite(fraction)?Math.max(0,Math.min(.06,fraction)):0;
    const visualDelta=rafGapMs===null?0:Math.max(0,Math.min(.05,rafGapMs/1000));
    const oldZoom=zoom;
    const disabled=strength===0||fraction===0;
    {
      const targetAmplitude=valid&&playing?fraction*strength*impulse:0;
      if(disabled)amplitude=0;else amplitude+=(targetAmplitude-amplitude)*(1-Math.exp(-visualDelta/.25));
      const wave=valid?(beatGrid?centeredZoomWave(time,beatGrid):impulse):0;
      const change=(amplitude*wave-zoom)*(1-Math.exp(-visualDelta/.025));
      const stepLimit=Math.min(.0025,.18*visualDelta);
      zoom=Math.max(0,Math.min(.06,zoom+Math.max(-stepLimit,Math.min(stepLimit,change))));
      if(disabled&&zoom<.0000005)zoom=0;
    }
    metrics.currentScale=1+zoom;metrics.maximumObservedScale=Math.max(metrics.maximumObservedScale,1+zoom);metrics.maximumScaleStep=Math.max(metrics.maximumScaleStep,Math.abs(zoom-oldZoom));metrics.pulseStrength=strength;metrics.zoomFraction=fraction;
    const playback = adapter.getPlaybackState();
    for (const deck of playback.decks) {
      const element = deck.element;
      if (!savedTransforms.has(element)) savedTransforms.set(element, {transform:element.style.transform??'',transformOrigin:element.style.transformOrigin??''});
      if (deck.clip?.pulseMode === 'raw' && (deck.visible || deck.role === 'incoming')) {
        element.style.transformOrigin='50% 50%';
        element.style.transform = `scale(${(1+zoom).toFixed(6)})`;
        metrics.rawDeckTransforms++;
      } else { resetTransform(element); if (deck.clip?.pulseMode === 'baked') metrics.bakedDeckSuppressions++; }
    }
    // Disable the separately pulsing edge image so the field scales uniformly.
    if (overlay) {
      overlay.style.opacity='0';overlay.style.transform='none';
    }
    previousTime = valid ? time : null;
    metrics.frameUpdates++; metrics.lastAudioSeconds = valid ? time : null; metrics.lastImpulse = impulse; metrics.audioRunning = playing;
    return metricSnapshot();
  }
  function metricSnapshot() { return Object.freeze({ ...metrics, missedBeatDetails: Object.freeze([...missedBeatDetails]) }); }
  function frame() {
    if (!running || disposed) return;
    frameHandle = null;
    try { update(); } catch { /* A visual consumer cannot stop the audio transport. */ }
    if (running && !disposed) frameHandle = requestFrame(frame);
  }
  function start() { if (disposed || running) return; running = true; frameHandle = requestFrame(frame); }
  function stop() { running = false; if (frameHandle !== null) cancelFrame(frameHandle); frameHandle = null; previousRaf = null; }
  function dispose() { if (disposed) return; stop(); disposed = true; for (const [element, style] of savedTransforms) Object.assign(element.style,style); savedTransforms.clear(); overlay?.remove(); }
  return Object.freeze({ start, stop, update, dispose, getMetrics: metricSnapshot });
}
