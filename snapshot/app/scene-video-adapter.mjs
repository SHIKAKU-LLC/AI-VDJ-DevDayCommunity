// Isolated cached-scene adapter: original source versions may differ; playlist revisions own order.
import {validateMotifSnapshot} from '../src/motif-contract.mjs';
/** Browser-only, silent two-deck video player. Provider credentials stay on the server. */
export function createVideoAdapter({
  container, baseUrl = '', onState = () => {}, preloadTimeoutMs = 15000,
  pollIntervalMs = 500, jobTimeoutMs = 180000,
  crossfadeMs = 140, decodedFrameTimeoutMs = 2000, loopOverlap = true,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  videoFactory = () => document.createElement('video'),
} = {}) {
  if (!container?.append) throw new TypeError('container must be a DOM element');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  let disposed = false;
  let epoch = 0;
  let activeDeck = null;
  let activeClip = null;
  let transition = null;
  let loopClone = null;
  let frameWait = null;
  let loopMonitor = null;
  let pending = null;
  let loading = null;
  let requestAbort = null;
  let pollTimer = null;
  let pollResolve = null;
  let lastBeatIndex = -1;
  let state = { phase: 'idle', requestedVersion: -1, requestedRevision: -1, activeVersion: null, activeRevision: null, pendingVersion: null, source: null, activeClip: null, pulseMode: 'off' };

  const decks = [videoFactory(), videoFactory()];
  for (const deck of decks) {
    deck.muted = true;
    deck.defaultMuted = true;
    deck.volume = 0;
    deck.loop = true;
    deck.playsInline = true;
    deck.preload = 'auto';
    deck.setAttribute('muted', '');
    deck.setAttribute('playsinline', '');
    deck.setAttribute('aria-hidden', 'true');
    Object.assign(deck.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain', visibility: 'hidden', opacity: '0' });
    container.append(deck);
    deck.addEventListener('timeupdate', maybeLoop);
  }

  function emit(patch) {
    state = { ...state, ...patch };
    // Observers cannot prevent cleanup or interrupt a deck handoff.
    try { onState({ ...state }); } catch { /* Consumer owns its callback errors. */ }
  }
  function pauseDeck(deck) {
    try { deck.pause(); } catch { /* Disconnected media element. */ }
  }
  function clearDeck(deck) {
    pauseDeck(deck);
    deck.style.visibility = 'hidden';
    deck.style.opacity = '0';
    deck.style.transition = '';
    deck.setAttribute('aria-hidden', 'true');
    deck.removeAttribute('src');
    deck.load();
  }
  function cancelLoading() {
    if (loading) loading.finish(false);
    loading = null;
    if (pending) {
      clearDeck(decks[pending.deckIndex]);
      pending = null;
    }
  }
  function cancelRequest() {
    requestAbort?.abort();
    requestAbort = null;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    pollResolve?.();
    pollResolve = null;
  }
  function startVersion(version, phase, source = null, playbackRevision = version) {
    epoch += 1;
    frameWait?.cancel();
    settleTransition();
    cancelLoopClone();
    cancelRequest();
    cancelLoading();
    emit({ phase, requestedVersion: version, requestedRevision: playbackRevision, pendingVersion: null, source, reason: undefined });
    return epoch;
  }
  function cancelLoopClone() {
    const clone = loopClone;
    loopClone = null;
    clone?.cleanup();
    if (clone && clone.deckIndex !== activeDeck) clearDeck(decks[clone.deckIndex]);
  }
  function settleTransition() {
    if (!transition) return;
    clearTimeout(transition.timer);
    const previous = decks[transition.previous];
    previous.style.visibility = 'hidden'; previous.style.opacity = '0'; previous.style.transition = '';
    previous.setAttribute('aria-hidden', 'true'); pauseDeck(previous);
    const current = decks[activeDeck];
    current.style.opacity = '1'; current.style.transition = '';
    transition = null;
  }
  // Do not reveal an incoming element until a decoded frame is presented.
  function decodedFrame(deck) {
    return new Promise((resolve, reject) => {
      let done = false, callbackId = null;
      const cleanup = () => {
        clearTimeout(timer);
        deck.removeEventListener('error', failed);
        deck.removeEventListener('loadeddata', loaded);
        if (callbackId !== null) deck.cancelVideoFrameCallback?.(callbackId);
        if (frameWait?.cancel === cancel) frameWait = null;
      };
      const finish = error => { if (done) return; done = true; cleanup(); error ? reject(error) : resolve(); };
      const cancel = () => finish(new Error('frame_cancelled'));
      const failed = () => finish(new Error('video_decode_error'));
      const loaded = () => { if (deck.readyState >= 2) finish(); };
      const timer = setTimeout(() => finish(new Error('decoded_frame_timeout')), decodedFrameTimeoutMs);
      frameWait = { cancel };
      deck.addEventListener('error', failed);
      if (typeof deck.requestVideoFrameCallback === 'function') callbackId = deck.requestVideoFrameCallback(() => finish());
      else { deck.addEventListener('loadeddata', loaded); queueMicrotask(loaded); }
    });
  }
  function acceptedPlayback(deck) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = error => {
        if (done) return; done = true; clearTimeout(timer);
        if (frameWait?.cancel === cancel) frameWait = null;
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new Error('frame_cancelled'));
      const timer = setTimeout(() => finish(new Error('decoded_frame_timeout')), decodedFrameTimeoutMs);
      frameWait = { cancel };
      try { Promise.resolve(deck.play()).then(() => finish(), error => finish(error)); }
      catch (error) { finish(error); }
    });
  }
  function promote(candidate, selfLoop = false) {
    const previous = activeDeck, previousClip = activeClip, deck = decks[candidate.deckIndex];
    activeDeck = candidate.deckIndex; activeClip = candidate.clip;
    if (loopOverlap && loopMonitor === null) loopMonitor = setInterval(maybeLoop, 40);
    deck.style.visibility = 'visible'; deck.style.opacity = '0'; deck.style.zIndex = '2';
    deck.setAttribute('aria-hidden', 'false');
    // Force the initial opacity to be committed before the transition target.
    void deck.offsetWidth;
    deck.style.transition = `opacity ${Math.max(0, crossfadeMs)}ms linear`;
    deck.style.opacity = '1';
    if (previous !== null) {
      const old = decks[previous]; old.style.zIndex = '1';
      // Keep the opaque base beneath the incoming alpha ramp; fading both
      // independent layers would darken their midpoint under source-over.
      old.style.transition = ''; old.style.opacity = '1';
      transition = { previous, previousClip, timer: setTimeout(() => { settleTransition(); prepareLoopClone(); }, Math.max(0, crossfadeMs)) };
      if (crossfadeMs <= 0) { settleTransition(); prepareLoopClone(); }
    } else prepareLoopClone();
    emit({ phase: 'playing', activeVersion: activeClip.version, activeRevision: activeClip.playbackRevision, activeClip, pulseMode: activeClip.pulseMode, pendingVersion: null, source: activeClip.source, reason: undefined, loopHandoff: selfLoop });
  }
  function prepareLoopClone() {
    if (!loopOverlap || disposed || activeDeck === null || transition || loading || pending || requestAbort || loopClone) return;
    const deckIndex = activeDeck === 0 ? 1 : 0, deck = decks[deckIndex], clip = activeClip;
    let timeout;
    const clone = { clip, deckIndex, ready: false, switching: false, cleanup() { clearTimeout(timeout); deck.removeEventListener('canplay', ready); deck.removeEventListener('error', failed); } };
    const ready = () => { if (loopClone !== clone) return; clone.ready = true; clone.cleanup(); };
    const failed = () => { if (loopClone !== clone) return; cancelLoopClone(); };
    loopClone = clone;
    pauseDeck(deck); deck.style.visibility = 'hidden'; deck.style.opacity = '0';
    deck.addEventListener('canplay', ready); deck.addEventListener('error', failed);
    timeout = setTimeout(failed, preloadTimeoutMs);
    try {
      deck.currentTime = 0;
      if (deck.src !== clip.url && deck.getAttribute?.('src') !== clip.url) { deck.src = clip.url; deck.load(); }
      if (deck.readyState >= 3) ready();
    } catch { failed(); }
  }
  function maybeLoop() {
    if (disposed || activeDeck === null || transition || loading || pending || requestAbort) return;
    if (!loopClone) { prepareLoopClone(); return; }
    const clone = loopClone, old = decks[activeDeck];
    if (!clone.ready || clone.switching || clone.clip !== activeClip || !Number.isFinite(old.currentTime) || old.currentTime < activeClip.durationSeconds - Math.max(0, crossfadeMs) / 1000 - .08) return;
    clone.switching = true;
    const deck = decks[clone.deckIndex], token = epoch;
    const stillCurrent = () => !disposed && token === epoch && loopClone === clone && !pending && !loading && !requestAbort;
    (async () => {
      try {
        deck.currentTime = 0;
        await acceptedPlayback(deck);
        if (!stillCurrent()) return;
        await decodedFrame(deck);
        if (!stillCurrent()) return;
        clone.cleanup(); loopClone = null; promote(clone, true);
      } catch { if (stillCurrent()) cancelLoopClone(); }
    })();
  }
  function isCurrent(token, version, revision = version) {
    return !disposed && epoch === token && version === state.requestedVersion && revision === state.requestedRevision;
  }
  function waitForPoll() {
    return new Promise(resolve => {
      pollResolve = resolve;
      pollTimer = setTimeout(() => { pollTimer = null; pollResolve = null; resolve(); }, pollIntervalMs);
    });
  }

  async function preload(clip, token) {
    if (!isCurrent(token, clip.version, clip.playbackRevision)) return false;
    cancelLoading();
    const deckIndex = activeDeck === 0 ? 1 : 0;
    const deck = decks[deckIndex];
    clearDeck(deck);
    emit({ phase: 'preloading', pendingVersion: clip.version, source: clip.source, reason: undefined });
    return new Promise(resolve => {
      let finished = false;
      let timeout;
      const finish = (ready, reason) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        deck.removeEventListener('canplay', readyListener);
        deck.removeEventListener('error', errorListener);
        if (loading?.finish === finish) loading = null;
        if (!isCurrent(token, clip.version, clip.playbackRevision)) {
          clearDeck(deck);
          resolve(false);
          return;
        }
        if (ready) {
          pending = { clip, deckIndex, readyAfterBeatIndex: lastBeatIndex, switching: false };
          emit({ phase: 'ready', pendingVersion: clip.version, reason: undefined });
        } else {
          clearDeck(deck);
          emit({ phase: reason === 'preload_timeout' ? 'timeout' : 'failed', pendingVersion: null, reason: reason ?? 'preload_cancelled' });
        }
        resolve(ready);
      };
      const readyListener = () => finish(true);
      const errorListener = () => finish(false, 'video_decode_error');
      loading = { finish, deckIndex };
      deck.addEventListener('canplay', readyListener);
      deck.addEventListener('error', errorListener);
      timeout = setTimeout(() => finish(false, 'preload_timeout'), preloadTimeoutMs);
      deck.src = clip.url;
      deck.load();
      if (deck.readyState >= 3) finish(true);
    });
  }

  async function setControl(input) {
    validateControl(input);
    const control = Object.freeze(Object.fromEntries(['version', 'energy', 'tension', 'density', 'brightness', 'world', 'prompt'].map(key => [key, input[key]])));
    if (disposed || control.version <= state.requestedVersion) return;
    const token = startVersion(control.version, 'generating');
    const abort = new AbortController();
    requestAbort = abort;
    const generationTimer = setTimeout(() => abort.abort('generation_timeout'), jobTimeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/api/video/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ control }), signal: abort.signal,
      });
      if (!isCurrent(token, control.version)) return;
      if (!response.ok) throw new Error(`submit_http_${response.status}`);
      const job = await response.json();
      if (!isCurrent(token, control.version)) return;
      if (job.version !== control.version || typeof job.jobId !== 'string') throw new Error('invalid_job_response');
      emit({ source: job.source });
      while (isCurrent(token, control.version)) {
        const poll = await fetchImpl(`${baseUrl}/api/video/jobs/${encodeURIComponent(job.jobId)}`, { signal: abort.signal });
        if (!isCurrent(token, control.version)) return;
        if (!poll.ok) throw new Error(`poll_http_${poll.status}`);
        const result = await poll.json();
        if (!isCurrent(token, control.version)) return;
        if (result.version !== control.version) throw new Error('invalid_result_version');
        if (result.status === 'ready') {
          validateClip(result.clip);
          if (result.clip.version !== control.version) throw new Error('invalid_clip_version');
          clearTimeout(generationTimer);
          await preload(snapshotClip(result.clip), token);
          return;
        }
        if (['timeout', 'failed', 'stale'].includes(result.status)) {
          emit({ phase: result.status === 'timeout' ? 'timeout' : 'failed', pendingVersion: null, reason: result.reason ?? result.status });
          return;
        }
        if (result.status !== 'generating') throw new Error('invalid_job_status');
        await waitForPoll();
      }
    } catch (error) {
      if (isCurrent(token, control.version)) {
        const timedOut = abort.signal.reason === 'generation_timeout';
        emit({ phase: timedOut ? 'timeout' : 'failed', pendingVersion: null, reason: timedOut ? 'generation_timeout' : String(error.message ?? error) });
      }
    } finally {
      clearTimeout(generationTimer);
      if (requestAbort === abort) requestAbort = null;
    }
  }

  async function stage(input) {
    validateClip(input);
    const clip = snapshotClip(input);
    if (disposed || clip.playbackRevision <= state.requestedRevision) return false;
    const token = startVersion(clip.version, 'preloading', clip.source, clip.playbackRevision);
    return preload(clip, token);
  }

  function onBeat({ index, timeMs } = {}) {
    if (disposed || !Number.isSafeInteger(index) || index < 0 || !Number.isFinite(timeMs) || index <= lastBeatIndex) return;
    lastBeatIndex = index;
    const candidate = pending;
    if (!candidate || candidate.switching || index <= candidate.readyAfterBeatIndex || candidate.clip.version !== state.requestedVersion || candidate.clip.playbackRevision !== state.requestedRevision) return;
    const token = epoch;
    const deck = decks[candidate.deckIndex];
    candidate.switching = true;
    (async () => {
      // Seek and play failures are handled before changing the visible deck.
      deck.currentTime = 0;
      await acceptedPlayback(deck);
      if (!isCurrent(token, candidate.clip.version, candidate.clip.playbackRevision) || pending !== candidate) return;
      await decodedFrame(deck);
      if (!isCurrent(token, candidate.clip.version, candidate.clip.playbackRevision) || pending !== candidate) return;
      pending = null;
      promote(candidate);
    })().catch(error => {
      if (!isCurrent(token, candidate.clip.version, candidate.clip.playbackRevision) || pending !== candidate) return;
      pending = null;
      clearDeck(deck);
      emit({ phase: error.message === 'decoded_frame_timeout' ? 'timeout' : 'failed', pendingVersion: null, reason: error.message === 'decoded_frame_timeout' ? 'decoded_frame_timeout' : `playback_failed: ${error.message ?? error}` });
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    epoch += 1;
    frameWait?.cancel();
    clearInterval(loopMonitor); loopMonitor = null;
    settleTransition();
    cancelLoopClone();
    cancelRequest();
    cancelLoading();
    for (const deck of decks) { deck.removeEventListener('timeupdate', maybeLoop); clearDeck(deck); deck.remove(); }
    emit({ phase: 'disposed', pendingVersion: null });
  }
  emit({});
  function getPlaybackState() {
    return Object.freeze({ activeClip, activeDeckIndex: activeDeck, transitioning: transition !== null,
      decks: Object.freeze(decks.map((element, index) => {
        const clip = index === activeDeck ? activeClip : transition?.previous === index ? transition.previousClip : pending?.deckIndex === index ? pending.clip : loopClone?.deckIndex === index ? loopClone.clip : null;
        return Object.freeze({ element, index, clip, role: index === activeDeck ? 'active' : pending?.deckIndex === index || loopClone?.switching && loopClone.deckIndex === index ? 'incoming' : transition?.previous === index ? 'outgoing' : 'standby', currentTime: element.currentTime, visible: element.style.visibility === 'visible' });
      })) });
  }
  return { setControl, stage, onBeat, dispose, getState: () => ({ ...state }), getPlaybackState };
}

function validateControl(control) {
  if (!control || !Number.isSafeInteger(control.version) || control.version < 0) throw new TypeError('control.version must be a nonnegative safe integer');
  for (const key of ['energy', 'tension', 'density', 'brightness']) {
    if (!Number.isFinite(control[key]) || control[key] < 0 || control[key] > 1) throw new TypeError(`control.${key} must be 0..1`);
  }
  for (const key of ['world', 'prompt']) {
    const maxLength = key === 'world' ? 100 : 2000;
    if (typeof control[key] !== 'string' || control[key].length > maxLength) throw new TypeError(`control.${key} must be a string of at most ${maxLength} characters`);
  }
}

function validateClip(clip) {
  if(clip?.motifSnapshot)validateMotifSnapshot(clip.motifSnapshot);
  if (clip?.playbackRevision !== undefined && (!Number.isSafeInteger(clip.playbackRevision) || clip.playbackRevision < 0)) throw new TypeError('invalid playbackRevision');
  if (!clip || !Number.isSafeInteger(clip.version) || clip.version < 0 || typeof clip.url !== 'string' || !clip.url || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds < 0.92 || clip.durationSeconds > 30 || !['fake', 'fal', 'local-edit', 'provider-response-replay'].includes(clip.source) || typeof clip.requestId !== 'string' || clip.pulseMode !== undefined && !['raw', 'baked', 'off'].includes(clip.pulseMode)) throw new TypeError('invalid clip');
}

function snapshotClip(clip) {
  return Object.freeze({ ...Object.fromEntries(['version', 'url', 'durationSeconds', 'source', 'requestId'].map(key => [key, clip[key]])), pulseMode: clip.pulseMode ?? 'off', playbackRevision: clip.playbackRevision ?? clip.version, assetId: clip.assetId ?? null, jobId: clip.jobId ?? null,...(clip.motifSnapshot?{motifSnapshot:validateMotifSnapshot(clip.motifSnapshot)}:{}) });
}
