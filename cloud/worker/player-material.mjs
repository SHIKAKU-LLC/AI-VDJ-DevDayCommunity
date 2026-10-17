import {createHash} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {decodeCompleteWave} from '../../integration/runtime/bootstrap.mjs';
import {verifyRenderedRoomPlayback} from '../../snapshot/app/runtime/rendered-room-playback.mjs';
import {verifyClipRelativeRender, assembleClipRelativeRender} from '../../room-web/playback/clip-timeline.mjs';
import {createProductionRenderRecordStore} from './render-record-store.mjs';
import {transitionDigest} from '../../snapshot/app/runtime/dj-transition-selector.mjs';

const fail = code => {throw new DispatchError(code);};
const RATE = 44100, MAX = 180 * RATE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scoped = ({roomId, sessionId, controlRevision}) => ({roomId, sessionId, controlRevision});

// Reconstruct the exact finite global queue from private native render receipts
// and persisted server ACK/reservation plans. Pending prepared audio can extend
// that queue while the selected CURRENT binding remains the old accepted cue.
// No observed audioTime, STAGING flag or caller offset creates a current source.
export function createProductionPlayerMaterial({enabled = false, roomId, bootstrapAuthority, repositoryPorts, assetStore, now = Date.now} = {}) {
  if (!bootstrapAuthority?.readStartAuthority || !repositoryPorts?.readScope || !repositoryPorts?.readPlaybackState ||
      !repositoryPorts?.readRoomRuntime || !assetStore?.read || !assetStore?.verifySaved || typeof now !== 'function') fail('PLAYER_MATERIAL_PORTS_REQUIRED');
  const records = createProductionRenderRecordStore({enabled, assetStore});
  let cached=null,closed=false;
  const clear=()=>{cached?.value.pcm.fill(0);cached?.value.installedPrefixPCM?.fill(0);cached=null;};
  const stateKey=(scope,expiry,state,runtime)=>cueDigest({scope,expiry,mode:state.currentCredit===null?'source':'current',
    stopped:state.stopped,currentCredit:state.currentCredit,cues:state.cues,
    pending:runtime?.pending??null,acks:runtime?.acks??[]});
  async function readState(scope){
    if(typeof repositoryPorts.readPlaybackSnapshot==='function'){
      const value=await repositoryPorts.readPlaybackSnapshot(scope);
      if(!value?.scope||cueDigest(scoped(value.scope))!==cueDigest(scope)||!Number.isFinite(value.scope.expiresAtMs)||
        value.scope.expiresAtMs<=now()||value.playback?.roomId!==roomId||!Array.isArray(value.playback.cues)||
        value.playback.cues.length>100||typeof value.playback.pending!=='boolean'||typeof value.playback.stopped!=='boolean'||
        !Object.hasOwn(value.playback,'currentCredit')||value.runtime!==null&&(!value.runtime||!Array.isArray(value.runtime.acks)||value.runtime.acks.length>100))
        fail('PLAYER_MATERIAL_SCOPE_CHANGED');
      return {before:value.scope,state:value.playback,runtime:value.runtime};
    }
    return {before:await repositoryPorts.readScope({roomId}),state:await repositoryPorts.readPlaybackState(scope),
      runtime:await repositoryPorts.readRoomRuntime(scope)};
  }
  async function stable(before,state,runtime,scope){
    const {before:after,state:latest,runtime:latestRuntime}=await readState(scope);
    if(cueDigest(scoped(after))!==cueDigest(scope)||before.expiresAtMs!==after.expiresAtMs||latest.stopped!==state.stopped||
      cueDigest(latest.currentCredit)!==cueDigest(state.currentCredit)||latest.pending!==state.pending||
      cueDigest({pending:runtime?.pending??null,acks:runtime?.acks??[]})!==cueDigest({pending:latestRuntime?.pending??null,acks:latestRuntime?.acks??[]}))fail('PLAYER_MATERIAL_SCOPE_CHANGED');
  }
  async function asset(assetId, expected) {
    const record = await assetStore.read(assetId);
    if (!(record?.bytes instanceof Uint8Array) || record.bytes.length < 1 || record.bytes.length > 32 * 1024 * 1024 ||
        record.assetId !== assetId || record.sha256 !== expected || record.byteLength !== record.bytes.length || sha(record.bytes) !== expected)
      fail('PLAYER_MATERIAL_PHYSICAL_CHANGED');
    const proof = await assetStore.verifySaved({binding: record.binding, asset: {assetId, sha256: expected}});
    if (proof?.privateSaved !== true || proof.checksumVerified !== true || proof.assetId !== assetId || proof.sha256 !== expected ||
        cueDigest(proof.binding) !== cueDigest(record.binding)) fail('PLAYER_MATERIAL_PHYSICAL_CHANGED');
    return record;
  }
  async function material({scope, mode}) {
    if (!enabled||closed) fail('PLAYER_MATERIAL_NOT_ACTIVATED');
    const {before,state,runtime}=await readState(scope);
    if (cueDigest(scoped(before)) !== cueDigest(scope)||before.expiresAtMs<=now()) {clear();fail('PLAYER_MATERIAL_SCOPE_CHANGED');}
    if (state.stopped && mode !== 'source' || (state.currentCredit === null ? 'source' : 'current') !== mode) fail('PLAYER_MATERIAL_CURRENT_CHANGED');
    if(runtime?.pending&&runtime.pending.expiresAtMs<=now())fail('PLAYER_MATERIAL_PENDING_CHANGED');
    const key=stateKey(scope,before.expiresAtMs,state,runtime);
    // Reuse only our own physically verified immutable PCM. Mutable owner,
    // scope, playback, pending reservation and ACK state are freshly rechecked.
    // Admission/download paths still verify stored bytes independently.
    if(cached?.key===key&&before.expiresAtMs>now()){const hit=cached;await stable(before,state,runtime,scope);
      if(closed||cached!==hit||before.expiresAtMs<=now())fail('PLAYER_MATERIAL_SCOPE_CHANGED');return structuredClone(hit.value);}
    clear();
    const selected = await (bootstrapAuthority.readPreparedAuthority??bootstrapAuthority.readStartAuthority)(scope), seed = selected.source;
    const seedRecord = await asset(seed.audioAssetId, seed.music.sha256), decodedSeed = decodeCompleteWave(seedRecord.bytes);
    if (decodedSeed.frames !== 24 * RATE) fail('PLAYER_MATERIAL_BOOTSTRAP_REQUIRED');
    let pcm = decodedSeed.pcm, binding = {clipId: seed.music.clipId, sha256: seed.music.sha256, playbackRevision: 0, originFrame: 0}, currentCue = null;
    const credit = state.currentCredit;
    // Follow server-ACKed playback parents. Generation's conditioning parent
    // can differ from the CURRENT source of an independently measured pair.
    // Revisions restart at 1 on each new graph, while the durable ACK ledger
    // retains prior graphs. The latest server-ordered 1..CURRENT sequence is
    // the active physical chain. Earlier replays may use a different measured
    // join; they must neither be erased nor substituted for this chain.
    const acks=runtime?.acks??[];
    let run=[];
    if(credit){
      const start=acks.findLastIndex(a=>a.reservation?.expectedRevision===1);
      run=start<0?[]:acks.slice(start);
      if(!run.length||run.length!==credit.playbackRevision||run.some((a,i)=>a.reservation?.expectedRevision!==i+1)||
        run.at(-1).reservation.cue?.cueId!==credit.cueId)fail('PLAYER_MATERIAL_SERVER_ACK_REQUIRED');
    }
    function acknowledgedReservation(cue){
      const matches=run.filter(a=>a.reservation?.cue?.cueId===cue.cueId&&
        a.reservation.expectedRevision===cue.playbackRevision&&a.reservation.cue.generationId===cue.generationId);
      if(matches.length!==1)fail('PLAYER_MATERIAL_SERVER_ACK_REQUIRED');
      const reservation=matches[0].reservation,{planSha256,...body}=reservation.plan??{};
      if(transitionDigest(body)!==planSha256)fail('PLAYER_MATERIAL_SERVER_ACK_REQUIRED');
      return reservation;
    }
    // Replayed operations can share a cueId; only the credited sounding copy is current.
    const credited = credit ? state.cues.filter(c => c.cueId === credit.cueId &&
      c.status === 'PLAYING' && c.playbackRevision === credit.playbackRevision) : [];
    if (credit && credited.length !== 1) fail('PLAYER_MATERIAL_CURRENT_CHANGED');
    const chain = []; let cue = credited[0];
    while (cue) {
      // A replay can play right after the older copy of the same cueId: detect
      // a cycle by each copy's own operation/generation/revision, not cueId.
      const copy = c => [c.operationId, c.generationId, c.playbackRevision].join('|');
      if (chain.length >= 7 || chain.some(c => copy(c) === copy(cue))) fail('PLAYER_MATERIAL_FINITE_CHAIN_REQUIRED');
      chain.unshift(cue);
      const parentPlan=acknowledgedReservation(cue).plan;
      if(parentPlan?.currentClipId===seed.music.clipId&&parentPlan.currentSha256===seed.music.sha256&&parentPlan.currentPlaybackRevision===0)break;
      const parents = state.cues.filter(c => c.music?.asset?.assetId === parentPlan?.currentClipId&&
        c.music.asset.sha256===parentPlan.currentSha256&&c.status === 'PLAYED' &&
        c.playbackRevision===parentPlan.currentPlaybackRevision&&c.playbackRevision===cue.playbackRevision-1);
      if (parents.length !== 1) fail('PLAYER_MATERIAL_PARENT_REQUIRED'); cue = parents[0];
    }
    async function append(reservation, selectedCue) {
      const immutable = value => {const {status, playbackRevision, ...rest} = value; return rest;};
      if (!['READY','SELECTED'].includes(reservation.cue?.status) ||
          cueDigest(immutable(reservation.cue)) !== cueDigest(immutable(selectedCue)))
        fail('PLAYER_MATERIAL_CUE_CHANGED');
      const plan=reservation.plan,pairCurrent=plan?.transition?.measuredCutVerified?{clipId:plan.currentClipId,
        sha256:plan.currentSha256,contextSha256:plan.currentContextSha256,playbackRevision:plan.currentPlaybackRevision}:null;
      const proof = await records.read({roomId, cue: selectedCue,...(pairCurrent?{pairCurrent}:{})}), render = proof.render, source = proof.source;
      if (plan.currentClipId !== binding.clipId || plan.currentSha256 !== binding.sha256 ||
          plan.currentPlaybackRevision !== binding.playbackRevision || source.music.clipId !== binding.clipId ||
          reservation.expectedRevision !== binding.playbackRevision + 1 || reservation.cue.cueId !== selectedCue.cueId)
        fail('PLAYER_MATERIAL_PLAN_CHANGED');
      const [parent, incoming, rendered] = await Promise.all([asset(source.audioAssetId, source.music.sha256),
        asset(selectedCue.music.asset.assetId, selectedCue.music.asset.sha256), asset(render.assetId, render.receipt.renderedSha256)]);
      const current = {clipId: source.music.clipId, sha256: source.music.sha256, contextSha256: source.music.contextSha256,
        profile: source.music.profile, playbackRevision: binding.playbackRevision, playedUntilFrame: 0, actual: true};
      const audio = decodeCompleteWave(rendered.bytes);
      const verified = verifyRenderedRoomPlayback({current, candidate: reservation.cue, currentAudio: decodeCompleteWave(parent.bytes),
        record: {audio, incoming: decodeCompleteWave(incoming.bytes), receipt: render.receipt}, plan, mode: 'provider'});
      if (!verified.valid) fail('PLAYER_MATERIAL_NATIVE_PROOF_REQUIRED');
      const startFrame = verified.geometry.startFrame, local = await verifyClipRelativeRender({timelineSpace: 'clip-relative-v1',
        pcm: audio.pcm, sampleRate: RATE, startFrame, durationFrames: audio.frames, renderedFileSha256: audio.sha256,
        renderedPcmSha256: sha(new Uint8Array(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength)),
        expectedPlayedWindowSha256: sha(new Uint8Array(audio.pcm.buffer, audio.pcm.byteOffset + startFrame * 8, 256 * 8))});
      const mapped = await assembleClipRelativeRender({render: local, plan, binding, retainedPCM: pcm, ceilingFrames: MAX});
      pcm = mapped.pcm;
      return {clipId: selectedCue.music.asset.assetId, sha256: selectedCue.music.asset.sha256,
        playbackRevision: reservation.expectedRevision, originFrame: mapped.startFrame - plan.transition.entryFrame};
    }
    for (const entry of chain) {
      binding = await append(acknowledgedReservation(entry), entry); currentCue = entry;
    }
    if (mode === 'current' && (!currentCue || currentCue.cueId !== credit.cueId || currentCue.status !== 'PLAYING' ||
        binding.playbackRevision !== credit.playbackRevision)) fail('PLAYER_MATERIAL_CURRENT_CHANGED');
    let installedPrefixPCM=null;
    if (runtime?.pending) {
      const pending = runtime.pending, candidates = state.cues.filter(c => c.cueId === pending.cue?.cueId &&
        c.generationId === pending.cue?.generationId && c.status === 'SELECTED'), candidate = candidates.length === 1 ? candidates[0] : null;
      if (!candidate || candidate.status !== 'SELECTED' || pending.completed || pending.controlRevision !== scope.controlRevision || pending.expiresAtMs <= now())
        fail('PLAYER_MATERIAL_PENDING_CHANGED');
      // A reservation is not yet an installed browser queue. Retain the exact
      // verified current queue for observations before the future render has
      // been installed; only its still-unplayed tail may later be replaced.
      installedPrefixPCM=pcm.slice();
      await append(pending, candidate); // Queue changes; CURRENT binding does not.
    }
    await stable(before,state,runtime,scope);
    const value={binding: {kind: mode, assetId: binding.clipId, sha256: binding.sha256,
      contextSha256: currentCue?.music.contextSha256 ?? seed.music.contextSha256, playbackRevision: binding.playbackRevision,
      ...(currentCue ? {cueId: currentCue.cueId, generationId: currentCue.generationId} : {})}, pcm,
      originFrame: binding.originFrame, queuedFrames: pcm.length / 2, maximumDurationFrames: mode === 'source' && !runtime?.pending ? 24 * RATE : MAX,
      ...(installedPrefixPCM?{acceptedPrefixFrames:installedPrefixPCM.length/2,installedPrefixPCM}:{}),
      videoAssets: currentCue?.video.clips.map(({assetId, sha256}) => ({assetId, sha256})) ?? []};
    if(closed||before.expiresAtMs<=now())fail('PLAYER_MATERIAL_SCOPE_CHANGED');
    cached={key,value:structuredClone(value),scope:structuredClone(scope),expiresAtMs:before.expiresAtMs,
      initial:mode==='source'&&!state.pending&&!runtime?.pending,
      playbackDigest:cueDigest(state),sourceBytesDigest:cueDigest({...state,stopped:false})};return value;
  }
    // Synchronous immutable bytes for a caller that JUST read the authenticated
    // live state. Stop changes authority, never these source samples; the
    // caller checks Stop/current graph itself. No Storage or owner IO here.
    function readSourceSnapshot(input){
      // A fresh authenticated atomic snapshot may reuse exact immutable CURRENT
      // PCM too. No observation, credit or owner state is taken from this cache.
      if(!closed&&input.mode==='current'&&cached&&Object.hasOwn(input,'runtime')&&
        input.playback.stopped===false&&input.playback.currentCredit?.actual===true&&
        (!input.runtime?.pending||input.runtime.pending.expiresAtMs>now())&&
        cached.expiresAtMs>now()&&cached.expiresAtMs===input.expiresAtMs&&cueDigest(cached.scope)===cueDigest(input.scope)&&
        cached.key===stateKey(input.scope,input.expiresAtMs,input.playback,input.runtime))return structuredClone(cached.value);
      if(!closed&&input.mode==='source'&&cached&&Object.hasOwn(input,'runtime')&&input.playback.currentCredit===null&&
        (!input.runtime?.pending||input.runtime.pending.expiresAtMs>now())&&
        cached.expiresAtMs>now()&&cached.expiresAtMs===input.expiresAtMs&&cueDigest(cached.scope)===cueDigest(input.scope)&&
        cached.key===stateKey(input.scope,input.expiresAtMs,input.playback,input.runtime))return structuredClone(cached.value);
      if(!closed&&input.mode==='source'&&cached?.initial&&input.playback.currentCredit===null&&!input.playback.pending&&
        cached.expiresAtMs>now()&&cached.expiresAtMs===input.expiresAtMs&&cueDigest(cached.scope)===cueDigest(input.scope)&&
        cueDigest({...input.playback,stopped:false})===cached.sourceBytesDigest)return structuredClone(cached.value);
      return null;
    }
  return Object.freeze({readVerifiedMaterial: material,readSourceSnapshot,
    // Registry already fetched this scope/playback and checks it again before
    // committing. READY cues do not enter the audio queue. With no pending
    // entry or current credit, immutable initial PCM has no
    // mutable render lineage to fetch a second time.
    async readObserverMaterial(input){
      if(Object.hasOwn(input,'runtime')){const hit=readSourceSnapshot(input);if(hit)return hit;}
      if(!closed&&input.mode==='source'&&cached?.initial&&cached.expiresAtMs>now()&&
        cached.expiresAtMs===input.expiresAtMs&&cueDigest(cached.scope)===cueDigest(input.scope)&&
        cueDigest(input.playback)===cached.playbackDigest)return structuredClone(cached.value);
      return material(input);
    },close(){closed=true;clear();}});
}
