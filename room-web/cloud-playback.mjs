import {createBrowserCommitPlayback} from './playback/commit-playback.mjs';
import {createWorkletPlaybackEngine} from './playback/worklet-engine.mjs';
import {createAudioOutputLease} from './playback/output-lease.mjs';
import {createOwnerCueHost} from './owner-cue-host.mjs';
import {createCloudMediaResolver} from './cloud-playback-media.mjs';
import {createCloudSeedPlayback} from './cloud-initial-audio.mjs';

const disabled = () => Promise.reject(Error('CLOUD_PLAYBACK_ACTIVATION_GATED'));

/** Creates a portable output port on an existing sole graph. The owner control
 * role never creates a graph, fetches media or claims the output lock.
 * Production enablement requires an explicit reviewed activation flag; the
 * fixture flag only labels synthetic observations and never grants activation.
 * createAudioEngine is a fixture/integration seam receiving loadVerifiedRender;
 * worklet wraps the existing queue node without constructing another context.
 */
export function createCloudPlaybackAdapter({role = 'output', enabled = false, fixtureMode = false,
  enableClipRelativeTimeline = false, allowInitialAudio = false, request, origin, resolveManifest, urlAPI, mediaResolver, worklet, createAudioEngine,
  createVideoAdapter, container, videoFactory, outputLease, initialPlaybackRevision = 0,
  onState = () => {}, lifecycle, ackTimeoutMs} = {}) {
  if (!['owner', 'output'].includes(role) || typeof enabled !== 'boolean' || typeof fixtureMode !== 'boolean' || typeof enableClipRelativeTimeline !== 'boolean') throw Error('CLOUD_PLAYBACK_ROLE_INVALID');
  const report = state => onState({...state, cloudRole: role, activationEnabled: enabled, fixtureMode});
  if (role === 'owner' || !enabled) {
    const monitor = createBrowserCommitPlayback({role: 'monitor', initialPlaybackRevision, onState: report, lifecycle});
    return {...monitor, role, unlock: disabled, commitPlayback: disabled,
      read: () => ({...monitor.read(), cloudRole: role, activationEnabled: enabled, fixtureMode})};
  }
  const resolver = mediaResolver ?? createCloudMediaResolver({enableClipRelativeTimeline, request, origin, resolveManifest, urlAPI});
  if (!resolver || typeof resolver.resolveMedia !== 'function' || typeof resolver.loadVerifiedRender !== 'function') throw Error('CLOUD_MEDIA_RESOLVER_REQUIRED');
  const loadVerifiedRender = input => resolver.loadVerifiedRender(input);
  const engine = createAudioEngine ? createAudioEngine({loadVerifiedRender, enableClipRelativeTimeline}) :
    createWorkletPlaybackEngine({...worklet, loadVerifiedRender, enableClipRelativeTimeline,allowInitialAudio});
  const sharedLease = outputLease ?? createAudioOutputLease();
  const port = createBrowserCommitPlayback({audioEngine: engine, resolveMedia: input => resolver.resolveMedia(input),
    createVideoAdapter, container, videoFactory, outputLease: sharedLease,
    initialPlaybackRevision, onState: report, lifecycle, ackTimeoutMs, parallelAuthorizedMedia: true});
  return {...port, role, readSourceState: () => engine.readClipState?.() ?? null,
    readObservationState: () => engine.readObservationState?.() ?? null,
    subscribeObservation: listener => engine.subscribe(listener),
    requestObservationWindow: () => engine.requestObservationWindow?.(),
    async startWaitingLoop(plan) {
      if(!allowInitialAudio||port.read().phase!=='READY')throw Error('WAITING_AUDIO_NOT_ACTIVATED');
      return engine.startWaitingLoop(plan);
    },
    async startInitialSource(plan,{guard,markSourceStarted}={}) {
      if (!allowInitialAudio || port.read().phase !== 'READY') throw Error('INITIAL_AUDIO_NOT_ACTIVATED');
      const seed=createCloudSeedPlayback({enabled,plan,audioEngine:engine,outputLease:sharedLease,guard,markSourceStarted});
      try {const ack=await seed.start();port.adoptInitialSourceRevision(plan);seed.handoff({...port,role});return ack;}catch(error){await seed.dispose();throw error;}
    },
    read: () => ({...port.read(), cloudRole: role, activationEnabled: enabled, fixtureMode})};
}

// Authoritative reservations, stop invalidation and lost-ACK reconciliation
// stay in the existing owner host. Pass a selected output port (local object or
// reviewed same-origin bridge facade); this controller never owns an engine.
export function createCloudOwnerPlaybackController({outputPort, ...options} = {}) {
  if (outputPort?.role !== 'output' || typeof outputPort.commitPlayback !== 'function' ||
      typeof outputPort.stop !== 'function') throw Error('CLOUD_OUTPUT_PORT_REQUIRED');
  return createOwnerCueHost({...options,
    // Activation belongs to the output window's direct gesture handler. Owner
    // start may wait for preparation, then reserve only after actual source ACK.
    activateAudio() {
      const state=outputPort.read();
      if (!( ['READY','PLAYING'].includes(state.phase)||state.phase==='PREPARING'&&state.sourceStartAvailable===true) ||
          state.activationEnabled!==true)throw Error('CLOUD_OUTPUT_GESTURE_REQUIRED');
      // One user Start owns preparation through the authenticated source ACK.
      // The owner host starts Cue selection immediately after this resolves.
      return outputPort.startSource?.();
    },
    commitPlayback: input => outputPort.commitPlayback(input),
    stopPlayback: reason => outputPort.stop(reason)});
}

/** Minimal output-only controls. Call directly on a reviewed output mount.
 * The activation button is an audio gesture, with no login/code input.
 */
export function mountCloudPlaybackControls({container, port, document = globalThis.document,
  onError = () => {}, onActivated = () => {}, onStopped = () => {},
  stopPlayback = reason => port.stop(reason), activateLabel = '音声出力を有効にする'} = {}) {
  if (!container?.append || !document?.createElement || port?.role !== 'output') throw Error('CLOUD_OUTPUT_CONTROLS_REQUIRED');
  const panel = document.createElement('section'), activate = document.createElement('button'),
    stop = document.createElement('button'), status = document.createElement('p');
  panel.className = 'cloud-playback-controls';
  activate.type = stop.type = 'button'; activate.textContent = activateLabel; activate.className = 'cloud-activate'; stop.textContent = '停止';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  let activating = false, stopping = false, disposed = false;
  const draw = () => {
    const state = port.read(); status.textContent = state.activationEnabled ? state.message : 'クラウド音声・映像出力は、検証完了まで保留中です。';
    status.dataset.phase = state.phase;
    activate.disabled = activating || stopping || !state.activationEnabled || !['IDLE', 'GESTURE_REQUIRED'].includes(state.phase);
    // A terminal graph cannot be unlocked. Stop remains the recovery action:
    // the output confirms server invalidation before mounting a fresh graph.
    stop.disabled = stopping || !state.activationEnabled || ['IDLE', 'MONITOR'].includes(state.phase);
  };
  const report = error => { if (!disposed) { onError(error); draw(); } };
  activate.onclick = () => {
    if (disposed || activate.disabled || activating || stopping) return;
    activating = true;
    // resume occurs inside unlock synchronously, before any owner/API await.
    let activation;
    try { activation = port.unlock(); } catch (error) { activation = Promise.reject(error); }
    draw();
    void Promise.resolve(activation).then(() => {
      if (disposed || stopping) return;
      draw(); return onActivated();
    }).catch(report).finally(() => { activating = false; if (!disposed) draw(); });
  };
  stop.onclick = () => {
    if (disposed || stop.disabled || stopping) return;
    stopping = true;
    let pending;
    try { pending = stopPlayback('OUTPUT_STOP'); } catch (error) { pending = Promise.reject(error); }
    draw();
    void Promise.resolve(pending).then(() => { if (!disposed) return onStopped(); }).catch(report)
      .finally(() => { stopping = false; if (!disposed) draw(); });
  };
  panel.append(activate, stop, status); container.append(panel); draw();
  return {refresh: draw, dispose() { disposed = true; activate.onclick = stop.onclick = null; panel.remove(); }};
}
