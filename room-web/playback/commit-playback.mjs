import {validatePlaybackCue, pcmSha256} from './cue-contract.mjs';
import {createAudioOutputLease} from './output-lease.mjs';
import {isVerifiedCloudInitialAudio} from '../cloud-initial-audio.mjs';

const RATE = 44100, WINDOW = 256;
const messages = {
  IDLE: '再生を開始すると、この画面が音声出力を担当します。',
  GESTURE_REQUIRED: '音声を有効にするには、この画面で「再生を有効にする」を押してください。',
  READY: '音声出力の準備ができました。完成済みの音楽・映像を待っています。',
  PREPARING: '同じキューの音楽・映像と再生証跡を確認中です。',
  STARTING: '音声の実再生と映像の提示を確認中です。',
  PLAYING: '音楽と映像を再生中です。',
  HOLD: '再生を保留しました。音声出力・映像・準備状態を確認してください。',
  STOPPED: '停止しました。再開するには、この画面で音声を再度有効にしてください。',
  MONITOR: '操作用画面です。音声と映像は出力画面が担当します。',
};
const failure = code => Object.assign(new Error(code), {code});
const isFrame = n => Number.isSafeInteger(n) && n >= 0;
const isHash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const validVideoOrigin = clip => clip?.source === 'owner-supplied-bootstrap-video' ?
  typeof clip.admissionId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(clip.admissionId) &&
    isHash(clip.admissionEvidenceSha256) && clip.requestId === undefined :
  ['local-edit', 'provider-response-replay', 'fal', 'fake'].includes(clip?.source) && typeof clip.requestId === 'string' &&
    clip.admissionId === undefined && clip.admissionEvidenceSha256 === undefined;

/** A browser commitPlayback port. The injected engine owns the ONLY audio graph.
 * No provider, fetch, decoding, context creation, or trust decision lives here.
 */
export function createBrowserCommitPlayback({audioEngine, resolveMedia, createVideoAdapter,
  container, videoFactory = () => document.createElement('video'),
  outputLease = createAudioOutputLease(), role = 'output', initialPlaybackRevision = 0,
  onState = () => {}, lifecycle = globalThis.window, ackTimeoutMs = 8000, prepareTimeoutMs = 20000,
  parallelAuthorizedMedia = false} = {}) {
  if (role !== 'monitor' && (!audioEngine || typeof resolveMedia !== 'function' || typeof createVideoAdapter !== 'function') ||
      !Number.isSafeInteger(initialPlaybackRevision) || initialPlaybackRevision < 0 ||
      !Number.isFinite(ackTimeoutMs) || ackTimeoutMs <= 0 ||
      !Number.isFinite(prepareTimeoutMs) || prepareTimeoutMs <= 0 || prepareTimeoutMs > 20000 ||
      typeof parallelAuthorizedMedia !== 'boolean')
    throw failure('PLAYBACK_DEPENDENCIES_REQUIRED');
  let phase = role === 'output' ? 'IDLE' : 'MONITOR', reason = null, epoch = 0, disposed = false;
  let lease = null, operation = null, lastRevision = initialPlaybackRevision, stopTask = Promise.resolve();
  let unlockTask = null, retained = null, readyUnsubscribe = null, contextWatch = null;
  const read = () => ({phase, reason, message: messages[phase], role, playbackRevision: lastRevision,
    pendingRevision: operation?.input.expectedRevision ?? null, cueId: operation?.input.cue.cueId ?? null,
    audioStarted: operation?.audioStarted ?? false, videoPresented: operation?.videoPresented ?? false,
    sourceCount: audioEngine?.readState?.().sourceCount ?? 0});
  const emit = () => { try { onState(read()); } catch {} };
  const set = (next, code = null) => { phase = next; reason = code; emit(); };
  const ownsOutput = () => lease && outputLease.isOwner(lease);
  function videoPresentation(op,segment,element) {
    const e=element;
    const denied=reason=>({reason:'MUTED_16_9_VIDEO_REQUIRED_'+reason});
    if(!e||!Number.isInteger(e.videoWidth)||!Number.isInteger(e.videoHeight)||e.videoWidth<=0||e.videoHeight<=0)return denied('DECODED_FRAME');
    const resolved=op.media.videos.find(v=>v.assetId===segment.assetId&&v.sha256===segment.sha256);
    if(!resolved||e.currentSrc!==resolved.url)return denied('SOURCE_BYTES');
    if(!e.muted||e.volume!==0)return denied('MUTED');
    if(Math.abs(e.videoWidth-e.videoHeight*16/9)<=1)return {width:e.videoWidth,height:e.videoHeight};
    // Approved compositions may contain portrait source pixels in a 16:9
    // canvas. Verify the exact decoded source and the actual containing box;
    // a portrait file alone is still insufficient for an output-frame ACK.
    const video=op.input.cue.video,qc=video.compositionQC,t=qc?.timeline;
    const clip=qc?.clips?.find(c=>c.clipId===segment.assetId&&c.sha256===segment.sha256),m=clip?.measurement;
    const s=t?.segments?.find(s=>s.clipId===segment.assetId&&s.startSeconds===segment.startSeconds&&s.endSeconds===segment.endSeconds&&
      s.inSeconds===segment.sourceInSeconds&&s.outSeconds===segment.sourceOutSeconds);
    if(qc?.passed!==true||qc.manifestSha256!==video.asset.sha256||video.review.assetSha256!==qc.manifestSha256||
      t?.version!=='accepted-video-timeline-v1'||t.fit!=='contain'||t.muted!==true||t.width!==1280||t.height!==720||!s||
      // QC measures encoded pixels; HTMLVideoElement exposes display pixels
      // after sample aspect ratio/rotation. Their dimensions need not match.
      // currentSrc above binds the displayed decoded frame to SHA-checked bytes.
      m?.fullyDecoded!==true||m.rawSha256!==segment.sha256||!Number.isInteger(m.width)||m.width<=0||!Number.isInteger(m.height)||m.height<=0||
      e.style?.objectFit!=='contain')return denied('APPROVED_CONTAIN');
    const box=container.getBoundingClientRect?.(),rect=e.getBoundingClientRect?.();
    if(!box||!rect||![box.width,box.height,rect.width,rect.height].every(n=>Number.isFinite(n)&&n>0)||
      Math.abs(box.width-box.height*16/9)>1||Math.abs(rect.width-box.width)>1||Math.abs(rect.height-box.height)>1)return denied('DISPLAY_BOX');
    const width=Math.round(box.width),height=Math.round(box.height);
    return width>0&&height>0&&Math.abs(width-height*16/9)<=1?{width,height}:denied('DISPLAY_BOX');
  }
  const current = op => (operation === op || retained === op) && op.token === epoch && !op.abort.signal.aborted && ownsOutput();
  function check(op) { if (!current(op)) throw failure('PLAYBACK_CANCELLED'); }
  function wait(op, value) {
    check(op);
    return new Promise((resolve, reject) => {
      const cancel = () => reject(failure('PLAYBACK_CANCELLED'));
      op.abort.signal.addEventListener('abort', cancel, {once: true});
      Promise.resolve(value).then(resolve, reject).finally(() => op.abort.signal.removeEventListener('abort', cancel));
    });
  }
  async function guarded(op, phase = 'prepare') {
    check(op);
    if (await wait(op, op.input.guard({phase})) !== true) throw failure('STALE_PLAYBACK_GUARD');
    check(op);
    if (op.input.expectedRevision !== lastRevision + 1) throw failure('STALE_PLAYBACK_REVISION');
    const s = audioEngine.readState();
    if (s.contextState !== 'running' || s.sourceCount !== 1) throw failure('SINGLE_RUNNING_AUDIO_ENGINE_REQUIRED');
  }
  function cleanup(op) {
    clearTimeout(op.timer);
    try { op.unsubscribe?.(); } catch {}
    try { op.adapter?.dispose(); } catch {}
    try { op.media?.release?.(); } catch {}
  }
  function stop(reasonCode = 'OWNER_STOP', nextPhase = 'STOPPED') {
    epoch++; unlockTask = null;
    const op = operation, old = retained; operation = null; retained = null;
    readyUnsubscribe?.(); readyUnsubscribe = null;
    if (contextWatch) audioEngine.context.removeEventListener?.('statechange', contextWatch); contextWatch = null;
    if (op) { op.abort.abort(); cleanup(op); op.reject(failure(reasonCode)); }
    if (old) { old.abort.abort(); cleanup(old); }
    const owned = lease;
    // Release only after the previous graph is silent. Reopen awaits this promise.
    stopTask = stopTask.catch(() => {}).then(async () => {
      if (owned?.active) {
        try { await audioEngine.stop(); } catch (error) {
          set('HOLD', 'STOP_FAILED_OUTPUT_LOCK_RETAINED');
          throw error;
        }
        owned.release();
        if (lease === owned) lease = null;
      }
    });
    set(nextPhase, reasonCode);
    return stopTask;
  }
  function fail(op, error) {
    if (!current(op)) return;
    const code = error?.name === 'NotAllowedError' ? 'GESTURE_REQUIRED' : error?.code ?? error?.message ?? 'PLAYBACK_HOLD';
    // Before its queue edit was posted, an incoming Cue owns no sound. Abandon
    // only that Cue; the already sounding source/Cue keeps the sole graph.
    if (operation === op && !op.editing && !op.committed && code !== 'GESTURE_REQUIRED') { abandon(op, code); return; }
    void stop(code, code === 'GESTURE_REQUIRED' ? 'GESTURE_REQUIRED' : 'HOLD').catch(() => {});
  }
  function abandon(op, code) {
    clearTimeout(op.timer); op.abort.abort(); cleanup(op);
    operation = retained; retained = null;
    set(op.priorPhase, code); op.reject(failure(code));
  }
  // Invoke directly from a click/tap handler: resume is deliberately before ANY await.
  function unlock() {
    if (role !== 'output' || disposed) return Promise.reject(failure('OUTPUT_SCREEN_REQUIRED'));
    if (unlockTask) return unlockTask;
    if (!['IDLE', 'GESTURE_REQUIRED'].includes(phase)) return Promise.reject(failure('REOPEN_REQUIRED'));
    const token = epoch;
    let resumed;
    try { resumed = audioEngine.context.resume(); } catch (error) { set('GESTURE_REQUIRED', 'AUDIO_RESUME_REFUSED'); return Promise.reject(error); }
    // Observe resume rejection immediately even while waiting for the cross-window lock.
    const resumeResult = Promise.resolve(resumed).then(() => null, error => error);
    set('GESTURE_REQUIRED');
    unlockTask = (async () => {
      let acquired;
      try {
        acquired = await outputLease.acquire();
        if (epoch !== token || disposed) { acquired.release(); throw failure('PLAYBACK_CANCELLED'); }
        lease = acquired;
        const error = await resumeResult;
        if (error) throw error;
        if (epoch !== token || !ownsOutput()) throw failure('PLAYBACK_CANCELLED');
        const s = audioEngine.readState();
        if (s.contextState !== 'running' || s.sourceCount !== 1) throw failure('SINGLE_RUNNING_AUDIO_ENGINE_REQUIRED');
        // A seeded prefix can keep running while no generated operation exists.
        // Fresh empty graphs may report stopped; they have not begun playback.
        const watch = event => {
          if (phase !== 'READY' || !ownsOutput()) return;
          const t = event?.telemetry ?? audioEngine.readState(), live = audioEngine.readState();
          if (event?.error || live.contextState !== 'running' || live.sourceCount !== 1 ||
              t.underrunFrames > 0 || t.stopped && (t.consumedFrames > 0 || t.receivedFrames > 0))
            void stop('ACTUAL_AUDIO_CLOCK_REQUIRED', 'HOLD').catch(() => {});
        };
        readyUnsubscribe = audioEngine.subscribe(watch);
        // A suspended/interrupted/closed context may never emit another worklet
        // message. Observe native state changes for the whole owned lifecycle.
        // stop() removes this listener before internally stopping the graph.
        contextWatch = () => {
          if (!['READY', 'PREPARING', 'STARTING', 'PLAYING'].includes(phase) || !ownsOutput()) return;
          const live = audioEngine.readState();
          if (live.contextState !== 'running' || live.sourceCount !== 1)
            void stop('ACTUAL_AUDIO_CLOCK_REQUIRED', 'HOLD').catch(() => {});
        };
        audioEngine.context.addEventListener?.('statechange', contextWatch);
        set('READY'); watch(); return read();
      } catch (error) {
        if (epoch === token) await stop(error?.message ?? 'AUDIO_RESUME_REFUSED', 'GESTURE_REQUIRED');
        throw error;
      }
    })();
    return unlockTask;
  }
  function commitPlayback(input) {
    if (operation && !operation.acked) return Promise.reject(failure('PLAYBACK_COMMIT_BUSY'));
    if (role !== 'output' || disposed || !ownsOutput() || !['READY', 'PLAYING'].includes(phase))
      return Promise.reject(failure('OUTPUT_UNLOCK_REQUIRED'));
    try {
      validatePlaybackCue(input);
      if (typeof input.guard !== 'function' || input.expectedRevision !== lastRevision + 1) throw failure('STALE_PLAYBACK_REVISION');
    } catch (error) { return Promise.reject(error); }
    // Keep the current visual deck and beat observer until the incoming cue's
    // actual frame is presented. Its ACK has already been issued exactly once.
    retained = operation; operation = null;
    const op = {input: {...input, cue: structuredClone(input.cue), plan: structuredClone(input.plan)}, priorPhase: phase,
      token: ++epoch, abort: new AbortController(), audioStarted: false, videoPresented: false,
      acked: false, stagedIndex: -1, shownIndex: -1, beat: 0, videoRevision: 0, serial: Promise.resolve()};
    operation = op; if (retained) retained.token = epoch; set('PREPARING');
    const promise = new Promise((resolve, reject) => { op.resolve = resolve; op.reject = reject; });
    // Network guards, verified decode and video preload precede playback.
    // They have their own finite deadline; they must not consume the actual
    // presentation budget before audio has even been committed.
    op.timer = setTimeout(() => fail(op, failure('PLAYBACK_PREPARE_TIMEOUT')), prepareTimeoutMs);
    void prepare(op).catch(error => fail(op, error));
    return promise;
  }
  async function prepare(op) {
    // Production's resolver independently authenticates the exact reservation
    // before/after its manifest. Its private read may overlap the prepare guard;
    // both must succeed before any decode/stage/commit. Other ports stay serial.
    const guarding = parallelAuthorizedMedia ? guarded(op) : null;
    if (!parallelAuthorizedMedia) await guarded(op);
    // Resolvers own grants and checksum verification; never expose their URLs in state.
    const resolving = Promise.resolve(resolveMedia({roomId: op.input.roomId, cue: op.input.cue, plan: op.input.plan, signal: op.abort.signal})).then(value => {
      if (!current(op)) value?.release?.();
      else op.media = value;
      return value;
    });
    const [, media] = await Promise.all([guarding, wait(op, resolving)]);
    if (!current(op)) { media?.release?.(); return; }
    op.media = media;
    if (media?.audio?.assetId !== op.input.cue.music.asset.assetId || media.audio.sha256 !== op.input.cue.music.asset.sha256 ||
        !Array.isArray(media.videos)) throw failure('RESOLVED_MEDIA_BINDING_REQUIRED');
    for (const clip of op.input.cue.video.clips) {
      const resolved = media.videos.filter(v => v.assetId === clip.assetId);
      if (resolved.length !== 1 || resolved[0].sha256 !== clip.sha256 || typeof resolved[0].url !== 'string' ||
          !resolved[0].url || !validVideoOrigin(resolved[0])) throw failure('RESOLVED_VIDEO_BINDING_REQUIRED');
    }
    let prepared = await wait(op, audioEngine.prepare({...op.input, media: media.audio, signal: op.abort.signal}));
    check(op); op.prepared = prepared;
    const pcm = prepared?.pcm;
    // Same interleaved stereo float bytes and SHA as rendered-room-playback.pcmSha.
    if (!(pcm instanceof Float32Array) || pcm.length % 2 || prepared.sampleRate !== RATE ||
        !isFrame(prepared.startFrame) || !isFrame(prepared.durationFrames) || pcm.length !== prepared.durationFrames * 2 ||
        prepared.startFrame + WINDOW > prepared.durationFrames || !isHash(media.audio.renderedPcmSha256) ||
        !isHash(prepared.expectedPlayedWindowSha256) || !isFrame(op.input.plan.transition?.entryFrame) ||
        prepared.startFrame !== op.input.plan.transition.exitFrame) throw failure('VERIFIED_RENDER_GEOMETRY_REQUIRED');
    for (const value of pcm) if (!Number.isFinite(value) || Math.abs(value) > 1) throw failure('INVALID_RENDER_PCM');
    if (await wait(op, pcmSha256(pcm)) !== media.audio.renderedPcmSha256 ||
        await wait(op, pcmSha256(pcm.subarray(prepared.startFrame * 2, (prepared.startFrame + WINDOW) * 2))) !== prepared.expectedPlayedWindowSha256)
      throw failure('RENDER_PCM_SHA_MISMATCH');
    if (audioEngine.mapVerifiedRender) {
      prepared = await wait(op, audioEngine.mapVerifiedRender(prepared)); check(op); op.prepared = prepared;
    }
    op.entrySeconds = op.input.plan.transition.entryFrame / RATE;
    if (op.entrySeconds >= 24 || prepared.durationFrames - prepared.startFrame !== 24 * RATE - op.input.plan.transition.entryFrame)
      throw failure('RENDER_CUE_TAIL_GEOMETRY_REQUIRED');
    op.segments = op.input.cue.video.timeline.segments;
    op.descriptors = new Map();
    op.adapter = createVideoAdapter({container, loopOverlap: false, videoFactory: () => {
      const element = videoFactory();
      if (typeof element.requestVideoFrameCallback !== 'function') throw failure('VIDEO_FRAME_OBSERVER_REQUIRED');
      const nativePlay = element.play.bind(element);
      element.play = () => {
        // The existing adapter seeks to zero. Apply the approved trim immediately
        // before native play, and disable its implicit loop for timeline segments.
        const stage = op.stage;
        if (stage) {
          const offset = Math.max(stage.offset, (op.telemetry?.consumedFrames - prepared.startFrame) / RATE + op.entrySeconds - stage.segment.startSeconds || 0);
          if (offset >= stage.segment.endSeconds - stage.segment.startSeconds) return Promise.reject(failure('VISUAL_SEGMENT_MISSED'));
          element.currentTime = stage.segment.sourceInSeconds + offset;
        }
        element.loop = false; element.muted = true; element.defaultMuted = true; element.volume = 0;
        try {
          return Promise.resolve(nativePlay()).catch(error => {
            if (error?.name === 'NotAllowedError') fail(op, error);
            throw error;
          });
        } catch (error) { if (error?.name === 'NotAllowedError') fail(op, error); throw error; }
      };
      return element;
    }, onState: state => {
      if (!current(op)) return;
      if (['failed', 'timeout'].includes(state.phase)) { fail(op, failure('VIDEO_PRESENTATION_FAILED')); return; }
      if (state.phase !== 'playing' || state.loopHandoff) return;
      const stage = op.descriptors.get(state.activeRevision);
      if (!stage || state.activeClip?.assetId !== stage.segment.assetId || state.activeVersion !== op.input.cue.controlVersion ||
          state.activeClip?.jobId !== op.input.cue.generationId) { fail(op, failure('VIDEO_PRESENTATION_BINDING_REQUIRED')); return; }
      const active = op.adapter?.getPlaybackState().decks.find(d => d.role === 'active')?.element;
      const presentation=videoPresentation(op,stage.segment,active);
      if (presentation.reason) {
        fail(op, failure(presentation.reason)); return;
      }
      op.shownIndex = stage.index; op.videoPresented = true;
      if (operation === op && retained) { const old = retained; retained = null; old.abort.abort(); cleanup(old); }
      enqueue(op, async () => { await maybeAck(op); await advanceVideo(op); });
    }});
    const index = op.segments.findIndex(s => s.startSeconds <= op.entrySeconds && op.entrySeconds < s.endSeconds);
    await stage(op, index, op.entrySeconds - op.segments[index].startSeconds);
    await guarded(op);
    op.unsubscribe = audioEngine.subscribe(event => enqueue(op, () => observeAudio(op, event)));
    set('STARTING');
    clearTimeout(op.timer);
    op.timer = setTimeout(() => fail(op, failure('ACTUAL_AV_ACK_TIMEOUT')), ackTimeoutMs);
    // The engine rejects only before posting its edit; after that the
    // incoming audio owns the graph and failures must stop it as before.
    op.editing = true;
    const editing = audioEngine.commit(prepared, {signal: op.abort.signal});
    Promise.resolve(editing).then(() => {}, () => { op.editing = false; });
    await wait(op, editing);
    check(op); op.committed = true; // acceptance alone never acknowledges actual playback.
    const live = audioEngine.readState();
    if (!op.acked && live.sampleRate === RATE && isFrame(live.consumedFrames) &&
        isFrame(live.finiteDurationFrames) && live.finiteDurationFrames <= 180 * RATE &&
        prepared.startFrame <= live.finiteDurationFrames && prepared.startFrame > live.consumedFrames) {
      // A verified seed prefix is already sounding. Wait until the scheduled
      // incoming frame, then allow the same bounded observation budget. Clock
      // passage still cannot substitute for processed PCM + video presentation.
      const scheduledMs = Math.ceil((prepared.startFrame - live.consumedFrames) * 1000 / RATE);
      clearTimeout(op.timer);
      op.timer = setTimeout(() => fail(op, failure('ACTUAL_AV_ACK_TIMEOUT')), scheduledMs + ackTimeoutMs);
    }
  }
  function enqueue(op, fn) {
    op.serial = op.serial.then(() => { if (current(op)) return fn(); }).catch(error => fail(op, error));
  }
  async function stage(op, index, offset = 0) {
    const segment = op.segments[index], resolved = op.media.videos.find(v => v.assetId === segment.assetId);
    const descriptor = {index, segment, offset, revision: ++op.videoRevision};
    op.stage = descriptor; op.descriptors.set(descriptor.revision, descriptor);
    const accepted = await wait(op, op.adapter.stage({version: op.input.cue.controlVersion,
      playbackRevision: descriptor.revision, assetId: segment.assetId, jobId: op.input.cue.generationId,
      url: resolved.url, durationSeconds: op.input.cue.video.clips.find(c => c.assetId === segment.assetId).durationSeconds,
      source: resolved.source, ...(resolved.source === 'owner-supplied-bootstrap-video' ? {
        admissionId: resolved.admissionId, admissionEvidenceSha256: resolved.admissionEvidenceSha256} : {requestId: resolved.requestId}), pulseMode: 'raw'}));
    if (accepted !== true) throw failure('VIDEO_PRELOAD_FAILED');
    op.stagedIndex = index;
  }
  async function observeAudio(op, event) {
    check(op);
    if (event.error) throw failure('AUDIO_ENGINE_FAILURE');
    if (event.playedWindow) {
      const window = event.playedWindow;
      if (window.startFrame !== op.prepared.startFrame) return;
      if (!(window.pcm instanceof ArrayBuffer) || window.pcm.byteLength !== WINDOW * 8 ||
          await wait(op, pcmSha256(window.pcm)) !== op.prepared.expectedPlayedWindowSha256)
        throw failure('PLAYED_PCM_SHA_MISMATCH');
      op.playedWindow = true;
    }
    if (event.telemetry) {
      const t = {...event.telemetry}, previous = op.telemetry?.consumedFrames ?? 0;
      if (t.sampleRate !== RATE || !isFrame(t.consumedFrames) || t.consumedFrames < previous ||
          (t.consumedFrames > op.prepared.durationFrames && !(retained === op && operation?.committed)) || t.underrunFrames !== 0 ||
          audioEngine.readState().sourceCount !== 1 || audioEngine.readState().contextState !== 'running')
        throw failure('ACTUAL_AUDIO_CLOCK_REQUIRED');
      op.telemetry = t;
      if (retained === op && operation?.committed && t.consumedFrames >= op.prepared.durationFrames && !t.stopped) return;
      if (t.stopped || t.consumedFrames === op.prepared.durationFrames) {
        if (!op.acked) throw failure('AV_ENDED_BEFORE_ACK');
        await stop('CUE_DURATION_END'); return;
      }
    }
    const t = op.telemetry;
    if (!t || t.consumedFrames < op.prepared.startFrame + WINDOW || !op.playedWindow) return;
    op.audioStarted = true;
    await maybeAck(op);
    await advanceVideo(op);
  }
  function visualIndex(op) {
    const time = (op.telemetry.consumedFrames - op.prepared.startFrame) / RATE + op.entrySeconds;
    return {time, index: op.segments.findIndex(s => s.startSeconds <= time && time < s.endSeconds)};
  }
  async function advanceVideo(op) {
    if (!current(op) || !op.audioStarted) return;
    const {time, index} = visualIndex(op);
    if (index < 0) throw failure('VISUAL_TIMELINE_EXHAUSTED');
    if (op.shownIndex === index) {
      // Preload the next approved segment while the current deck stays visible.
      if (index + 1 < op.segments.length && op.stagedIndex !== index + 1) await stage(op, index + 1);
      return;
    }
    if (op.stagedIndex !== index) await stage(op, index, time - op.segments[index].startSeconds);
    op.adapter.onBeat({index: ++op.beat, timeMs: op.telemetry.consumedFrames / RATE * 1000});
  }
  async function maybeAck(op) {
    if (op.acked || !op.audioStarted || !op.videoPresented || op.shownIndex !== visualIndex(op).index) return;
    await guarded(op, 'ack');
    // Guard is async; cancellation and exclusivity are rechecked immediately before resolution.
    check(op);
    const ack = {roomId: op.input.roomId, cueId: op.input.cue.cueId, clipId: op.input.cue.music.asset.assetId,
      playbackRevision: op.input.expectedRevision, audioTime: op.telemetry.consumedFrames / RATE,
      actual: true, audioStarted: true, videoPresented: true};
    await wait(op, audioEngine.recordActualCue?.({prepared: op.prepared, ack}));
    check(op); op.acked = true; lastRevision = op.input.expectedRevision; clearTimeout(op.timer);
    set('PLAYING'); op.resolve(ack);
  }
  const onHide = () => { void stop('PAGE_HIDE').catch(() => {}); };
  lifecycle?.addEventListener?.('pagehide', onHide);
  emit();
  return {commitPlayback, unlock, stop, read,
    adoptInitialSourceRevision(plan) {
      if(!isVerifiedCloudInitialAudio(plan)||phase!=='READY'||!ownsOutput()||operation||retained)
        throw failure('ACTUAL_INITIAL_SOURCE_REVISION_REQUIRED');
      if(lastRevision===plan.sourcePlaybackRevision)return read();
      const source=audioEngine.readClipState?.();
      if(source?.actual!==true||source.sampleRate!==RATE||source.clipId!==plan.sourceClipId||source.sha256!==plan.sourceSha256||
        source.playbackRevision!==plan.sourcePlaybackRevision||source.originFrame!==0||source.playedFrames<WINDOW||
        audioEngine.readState().contextState!=='running'||audioEngine.readState().sourceCount!==1)
        throw failure('ACTUAL_INITIAL_SOURCE_REVISION_REQUIRED');
      // Only the acknowledged source on this fresh sole graph can rebase its
      // local revision. Durable participant ACKs/served counts stay untouched.
      lastRevision=source.playbackRevision;emit();return read();
    },
    readObservationVideo() {
      // A staged incoming operation cannot displace the actual current deck.
      const op = operation?.acked ? operation : retained?.acked ? retained : null;
      if (!op || !current(op) || !op.videoPresented) return null;
      const deck = op.adapter?.getPlaybackState().decks.find(d => d.role === 'active'), segment = op.segments[op.shownIndex];
      if (!deck?.element || !segment) return null;
      const clip = op.input.cue.video.clips.find(c => c.assetId === segment.assetId);
      if (!clip) return null;
      return {element:deck.element,assetId:clip.assetId,sha256:clip.sha256,cueId:op.input.cue.cueId,
        readPresentation:()=>{const p=videoPresentation(op,segment,deck.element);return p.reason?null:p;},
        generationId:op.input.cue.generationId,playbackRevision:op.input.expectedRevision};
    },
    async reopen(nextEngine = audioEngine) {
      await stop('REOPEN');
      if (disposed) throw failure('PLAYBACK_DISPOSED');
      audioEngine = nextEngine;
      set(role === 'output' ? 'IDLE' : 'MONITOR');
    },
    async dispose() { disposed = true; lifecycle?.removeEventListener?.('pagehide', onHide); await stop('DISPOSE'); }};
}
