// Bridge an EXISTING single connected queue-audio worklet. It never constructs
// an AudioContext, AudioWorkletNode, BufferSource, destination, or media route.
const RATE = 44100;
const frame = value => Number.isSafeInteger(value) && value >= 0;
import {isVerifiedCloudInitialAudio,isVerifiedCloudWaitingAudio} from '../cloud-initial-audio.mjs';
import {pcmSha256} from './cue-contract.mjs';
import {isVerifiedClipRelativeRender, assembleClipRelativeRender} from './clip-timeline.mjs';

export function createWorkletPlaybackEngine({context, node, loadVerifiedRender,
  readSourceCount, initialTelemetry = {consumedFrames: 0, receivedFrames: 0, sampleRate: RATE, underrunFrames: 0},
  configuredDurationFrames = 180 * RATE, enableClipRelativeTimeline = false, allowInitialAudio = false, stopAudio} = {}) {
  if (!context || !node?.port?.addEventListener || typeof loadVerifiedRender !== 'function' ||
      typeof readSourceCount !== 'function' || typeof stopAudio !== 'function' || typeof enableClipRelativeTimeline !== 'boolean' ||
      context.sampleRate !== RATE || !frame(configuredDurationFrames) || configuredDurationFrames < 1 || configuredDurationFrames > 180 * RATE) throw Error('EXISTING_WORKLET_ENGINE_REQUIRED');
  let telemetry = {...initialTelemetry}, queuedFrontier = initialTelemetry.receivedFrames, duration = configuredDurationFrames, stopped = false;
  let retainedPCM = null, primedPlan = null, clipBinding = null, waiting=false;
  const observedWindows = new Map(), committedInputs = new WeakMap();
  const listeners = new Set(), preparedInputs = new WeakMap();
  const receive = event => {
    if (stopped) return;
    if (event.data?.telemetry) {
      queuedFrontier = Math.max(queuedFrontier, event.data.telemetry.receivedFrames ?? 0);
      telemetry = {...event.data.telemetry, receivedFrames: queuedFrontier};
    }
    if (event.data?.playedWindow?.pcm instanceof ArrayBuffer) {
      const w = event.data.playedWindow;
      if (frame(w.startFrame) && w.pcm.byteLength === 256 * 8) observedWindows.set(w.startFrame, pcmSha256(w.pcm.slice(0)));
    }
    for (const listener of listeners) listener(event.data);
  };
  node.port.addEventListener('message', receive); node.port.start?.();
  return {
    context,
    readState: () => ({...telemetry, contextState: context.state, sourceCount: readSourceCount(), finiteDurationFrames: duration}),
    readObservationState: () => ({...telemetry, contextState: context.state, sourceCount: readSourceCount(),
      stopped: stopped || telemetry.stopped === true, clip: clipBinding ? {...clipBinding} : primedPlan ? {
        clipId:primedPlan.sourceClipId,sha256:primedPlan.sourceSha256,playbackRevision:primedPlan.sourcePlaybackRevision,originFrame:0}:null}),
    requestObservationWindow() {
      if (stopped || waiting || context.state !== 'running' || readSourceCount() !== 1 || !frame(telemetry.consumedFrames)) return;
      const next = telemetry.consumedFrames + 128;
      if (next + 256 <= duration) node.port.postMessage({type:'observe-frame',frame:next});
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async startWaitingLoop(plan) {
      if(!allowInitialAudio||!isVerifiedCloudWaitingAudio(plan)||stopped||waiting||primedPlan||
          context.state!=='running'||readSourceCount()!==1||telemetry.consumedFrames!==0||queuedFrontier!==0)
        throw Error('FRESH_APPROVED_WAITING_LOOP_REQUIRED');
      const pcm=plan.pcm.slice();
      if(await pcmSha256(pcm)!==plan.pcmSha256||stopped||waiting||context.state!=='running'||readSourceCount()!==1||
          telemetry.consumedFrames!==0||queuedFrontier!==0)throw Error('WAITING_LOOP_CHANGED');
      waiting=true;node.port.postMessage({type:'waiting-loop',pcm:pcm.buffer},[pcm.buffer]);
    },
    async primeSeed(plan) {
      if (allowInitialAudio !== true || !isVerifiedCloudInitialAudio(plan) || stopped ||
          context.state !== 'running' || readSourceCount() !== 1 || telemetry.consumedFrames !== 0 ||
          telemetry.receivedFrames !== 0 || queuedFrontier !== 0 || plan.maximumDurationFrames > duration)
        throw Error('FRESH_VERIFIED_INITIAL_AUDIO_REQUIRED');
      const prefix = plan.pcm.slice();
      if (prefix.length !== plan.queuedPrefixFrames * 2 || await pcmSha256(prefix) !== plan.queuedPrefixSha256)
        throw Error('INITIAL_AUDIO_PREFIX_CHANGED');
      if (stopped || context.state !== 'running' || readSourceCount() !== 1 ||
          telemetry.consumedFrames !== 0 || telemetry.receivedFrames !== 0 || queuedFrontier !== 0)
        throw Error('INITIAL_AUDIO_GRAPH_CHANGED');
      if(waiting){node.port.postMessage({type:'end-waiting-loop'});waiting=false;}
      node.port.postMessage({type: 'set-duration', frames: plan.maximumDurationFrames});
      if (plan.mode === 'bootstrap') {
        node.port.postMessage({type: 'bound-duration', frames: plan.finiteSourceDurationFrames});
        duration = plan.finiteSourceDurationFrames;
      }
      node.port.postMessage({type: 'trace-frame', frame: 0});
      node.port.postMessage({type: 'chunk', startFrame: 0, pcm: prefix.buffer}, [prefix.buffer]);
      queuedFrontier = plan.queuedPrefixFrames;
      telemetry = {...telemetry, receivedFrames: queuedFrontier};
      retainedPCM = plan.pcm.slice(); primedPlan = plan;
      node.port.postMessage({type: 'play'});
    },
    async prepare(input) {
      if (stopped || waiting || input.signal?.aborted) throw Error('WORKLET_ENGINE_STOPPED');
      // This owner-injected function must reuse verifyRenderedRoomPlayback and
      // return its trusted, already-QC'd render plus the exact geometry.
      const prepared = await loadVerifiedRender(input);
      if (stopped || input.signal?.aborted) throw Error('WORKLET_ENGINE_STOPPED');
      if (!prepared || typeof prepared !== 'object') throw Error('VERIFIED_RENDER_REQUIRED');
      if (!(prepared.pcm instanceof Float32Array)) throw Error('VERIFIED_RENDER_REQUIRED');
      preparedInputs.set(prepared, {input: {...input, plan: structuredClone(input.plan)}, hash: await pcmSha256(prepared.pcm), startFrame: prepared.startFrame, durationFrames: prepared.durationFrames});
      return prepared;
    },
    async recordActualSource({plan, ack}) {
      if (!enableClipRelativeTimeline) return;
      if (plan !== primedPlan || !isVerifiedCloudInitialAudio(plan) || stopped || clipBinding ||
          context.state !== 'running' || readSourceCount() !== 1 || telemetry.underrunFrames !== 0 || telemetry.stopped === true || ack?.actual !== true || ack.audioStarted !== true ||
          ack.participantCredit !== false || ack.sampleRate !== RATE || !frame(ack.playedUntilFrame) ||
          ack.playedUntilFrame < 256 || ack.playedUntilFrame > plan.queuedPrefixFrames || ack.graphEpoch !== plan.graphEpoch || ack.sourceClipId !== plan.sourceClipId ||
          ack.sourceSha256 !== plan.sourceSha256 || ack.sourceContextSha256 !== plan.sourceContextSha256 || ack.sourcePlaybackRevision !== plan.sourcePlaybackRevision ||
          ack.processedWindowSha256 !== plan.expectedProcessedWindowSha256 ||
          await observedWindows.get(0) !== plan.expectedProcessedWindowSha256)
        throw Error('ACTUAL_SOURCE_TIMELINE_REQUIRED');
      if (stopped || plan !== primedPlan || context.state !== 'running' || readSourceCount() !== 1) throw Error('ACTUAL_SOURCE_TIMELINE_REQUIRED');
      clipBinding = {clipId: plan.sourceClipId, sha256: plan.sourceSha256, playbackRevision: plan.sourcePlaybackRevision, originFrame: 0};
    },
    async mapVerifiedRender(prepared) {
      const record = preparedInputs.get(prepared);
      if (!record || stopped) throw Error('VERIFIED_RENDER_REQUIRED');
      if (!isVerifiedClipRelativeRender(prepared)) return prepared;
      if (!enableClipRelativeTimeline) throw Error('CLIP_TIMELINE_ACTIVATION_GATED');
      const binding = clipBinding;
      const mapped = await assembleClipRelativeRender({render: prepared, plan: record.input.plan, binding,
        retainedPCM, ceilingFrames: configuredDurationFrames});
      if (stopped || binding !== clipBinding) throw Error('ACTUAL_CLIP_TIMELINE_CHANGED');
      preparedInputs.delete(prepared);
      preparedInputs.set(mapped, {...record, nativeRender: prepared, binding,
        hash: mapped.clipTimeline.assemblyPcmSha256, startFrame: mapped.startFrame, durationFrames: mapped.durationFrames});
      return mapped;
    },
    async recordActualCue({prepared, ack}) {
      if (!enableClipRelativeTimeline) return;
      const binding = clipBinding, record = committedInputs.get(prepared), cue = record?.input.cue, revision = record?.input.expectedRevision;
      if (!record || !cue || !clipBinding || stopped || context.state !== 'running' || readSourceCount() !== 1 ||
          telemetry.underrunFrames !== 0 || telemetry.stopped === true ||
          ack?.actual !== true || ack.audioStarted !== true || ack.videoPresented !== true ||
          ack.roomId !== cue.roomId || ack.cueId !== cue.cueId || ack.clipId !== cue.music.asset.assetId ||
          ack.playbackRevision !== revision || revision !== clipBinding.playbackRevision + 1 ||
          !frame(telemetry.consumedFrames) || telemetry.consumedFrames < prepared.startFrame + 256 ||
          await observedWindows.get(prepared.startFrame) !== prepared.expectedPlayedWindowSha256)
        throw Error('ACTUAL_CUE_TIMELINE_REQUIRED');
      if (stopped || binding !== clipBinding || context.state !== 'running' || readSourceCount() !== 1) throw Error('ACTUAL_CUE_TIMELINE_REQUIRED');
      const originFrame = prepared.startFrame - record.input.plan.transition.entryFrame;
      if (!frame(originFrame)) throw Error('ACTUAL_CUE_TIMELINE_REQUIRED');
      clipBinding = {clipId: cue.music.asset.assetId, sha256: cue.music.asset.sha256, playbackRevision: revision, originFrame};
      committedInputs.delete(prepared);
    },
    readClipState() {
      if (!clipBinding || stopped) return null;
      return {...clipBinding, playedFrames: Math.min(24 * RATE, Math.max(0, telemetry.consumedFrames - clipBinding.originFrame)),
        actual: telemetry.stopped !== true && telemetry.underrunFrames === 0 && context.state === 'running' && readSourceCount() === 1 &&
          telemetry.consumedFrames >= clipBinding.originFrame && telemetry.consumedFrames < clipBinding.originFrame + 24 * RATE, sampleRate: RATE};
    },
    async commit(prepared, {signal} = {}) {
      const record = preparedInputs.get(prepared), input = record?.input;
      if (!record || stopped || signal?.aborted || context.state !== 'running' || readSourceCount() !== 1)
        throw Error('SINGLE_RUNNING_WORKLET_REQUIRED');
      const copy = prepared.pcm.slice();
      if (prepared.startFrame !== record.startFrame || prepared.durationFrames !== record.durationFrames ||
          await pcmSha256(copy) !== record.hash) throw Error('PREPARED_RENDER_CHANGED');
      const received = queuedFrontier, consumed = telemetry.consumedFrames, edit = prepared.queueEditFrame ?? input.plan.transition?.editStartFrame;
      const fresh = received === 0 && consumed === 0;
      if (stopped || signal?.aborted || context.state !== 'running' || readSourceCount() !== 1 ||
          !frame(received) || !frame(consumed) || !frame(edit) || edit > prepared.startFrame || edit > received ||
          (!fresh && edit < consumed + 256) || consumed > received ||
          prepared.durationFrames > configuredDurationFrames || prepared.durationFrames <= received ||
          copy.length !== prepared.durationFrames * 2) {
        // Frame numbers only (no media, ids or credentials), readable by the
        // operator from the output document to name which frontier moved.
        try { globalThis.__vdjLastFrontierRefusal = {atMs: Date.now(), edit, consumed, received, fresh,
          startFrame: prepared.startFrame, durationFrames: prepared.durationFrames, configuredDurationFrames,
          queueEditFrame: prepared.queueEditFrame ?? null, planEditStartFrame: input.plan.transition?.editStartFrame ?? null}; } catch {}
        throw Error('QUEUED_RENDER_FRONTIER_CHANGED');
      }
      // An overlap's incoming trace may begin before the old queued tail.
      // replace-future replaces that unplayed seam atomically; edit remains
      // ahead of the consumed frontier and the retained prefix must match.
      if (record.nativeRender && record.binding !== clipBinding) throw Error('ACTUAL_CLIP_TIMELINE_CHANGED');
      // The already sounding and unchanged queued prefix belongs to the previous
      // verified render. A later render may replace only its approved future seam.
      if (retainedPCM) {
        if (retainedPCM.length < edit * 2) throw Error('VERIFIED_PREFIX_MISSING');
        for (let i = 0; i < edit * 2; i++) if (!Object.is(copy[i], retainedPCM[i]))
          throw Error('QUEUED_RENDER_PREFIX_CHANGED');
      }
      preparedInputs.delete(prepared); committedInputs.set(prepared, record);
      // No await after the frontier checks. The processor rechecks its live
      // consumed frame + exact received frontier atomically before mutating.
      if (fresh) {
        node.port.postMessage({type: 'set-duration', frames: configuredDurationFrames});
        node.port.postMessage({type: 'bound-duration', frames: prepared.durationFrames});
        node.port.postMessage({type: 'trace-frame', frame: prepared.startFrame});
        const suffix = copy.slice();
        node.port.postMessage({type: 'chunk', startFrame: 0, pcm: suffix.buffer}, [suffix.buffer]);
      } else {
        const suffix = copy.slice(edit * 2);
        node.port.postMessage({type: 'replace-future', startFrame: edit, expectedReceived: received,
          frames: prepared.durationFrames, pcm: suffix.buffer}, [suffix.buffer]);
        node.port.postMessage({type: 'trace-frame', frame: prepared.startFrame});
      }
      duration = prepared.durationFrames; retainedPCM = copy; queuedFrontier = prepared.durationFrames;
      telemetry = {...telemetry, receivedFrames: queuedFrontier};
      node.port.postMessage({type: 'play'});
    },
    async stop() {
      clipBinding = null; primedPlan = null; waiting=false;
      node.port.postMessage({type: 'stop'});
      // Keep observers and the output lease until the existing graph is silent.
      await stopAudio();
      stopped = true; clipBinding = null; primedPlan = null; retainedPCM = null; observedWindows.clear(); listeners.clear(); node.port.removeEventListener('message', receive);
    },
  };
}
