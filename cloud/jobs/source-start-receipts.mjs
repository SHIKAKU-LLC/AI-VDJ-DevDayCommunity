import {createHash} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest, cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {transitionDigest} from '../../snapshot/app/runtime/dj-transition-selector.mjs';
import {deriveVerifiedWave} from '../../integration/runtime/verified-wave-derivation.mjs';

const RATE = 44100, FRAMES = 24 * RATE, WINDOW = 256;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const roomId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const frame = value => Number.isSafeInteger(value) && value >= 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pcmSha = pcm => sha(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
// sessionId is an opaque room epoch, never an authentication session.
const scopeFields = value => { const {roomId, sessionId, controlRevision} = value; return {roomId, sessionId, controlRevision}; };
const sameScope = (left, right) => left?.roomId === right?.roomId && Object.is(left?.sessionId, right?.sessionId) && left?.controlRevision === right?.controlRevision;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const fail = code => { throw new DispatchError(code); };
const seal = body => ({...body, receiptSha256: cueDigest(body)});
const ackKeys = ['kind', 'graphEpoch', 'sourceClipId', 'sourceSha256', 'sourceContextSha256', 'sourcePlaybackRevision',
  'sampleRate', 'playedUntilFrame', 'processedWindowSha256', 'actual', 'audioStarted', 'participantCredit'];

// No default store: read + atomic putIfAbsent must be durable host ports. A
// successful write is re-read; an unknown write is reconciled by the same key.
export function createImmutableSourceStartReceiptStore({readRecord, putIfAbsent,putObservedIfAbsent} = {}) {
  if (typeof readRecord !== 'function' || typeof putIfAbsent !== 'function') fail('SOURCE_START_RECEIPT_STORE_REQUIRED');
  if(putObservedIfAbsent!==undefined&&typeof putObservedIfAbsent!=='function')fail('SOURCE_START_RECEIPT_STORE_REQUIRED');
  const reference = key => {
    if (!exact(key, ['roomId', 'sessionId', 'controlRevision', 'targetPlayerId', 'graphEpoch']) || !roomId(key.roomId) ||
        !id(key.sessionId) || !frame(key.controlRevision) || !id(key.targetPlayerId) || !frame(key.graphEpoch) || key.graphEpoch < 1)
      fail('SOURCE_START_RECEIPT_KEY_REQUIRED');
    return {...scopeFields(key), targetPlayerId: key.targetPlayerId, graphEpoch: key.graphEpoch};
  };
  const validate = (record, key) => {
    const allowed = ['kind', 'roomId', 'sessionId', 'controlRevision', 'targetPlayerId', 'graphEpoch', 'sourceClipId', 'sourceSha256',
      'sourceContextSha256', 'sourcePlaybackRevision', 'queuedPrefixFrames', 'queuedPrefixSha256', 'processedWindowSha256',
      'startMode', 'maximumDurationFrames', 'continuationPlanSha256', 'continuationRenderSha256', 'authoritySha256', 'ackSha256', 'ack', 'serverReceivedAtMs',
      'actual', 'sourceOnly', 'participantCredit', 'receiptSha256'];
    if (!exact(record, allowed) || record.kind !== 'immutable-source-start-receipt-v1' || !sameScope(record, key) ||
        record.targetPlayerId !== key.targetPlayerId || record.graphEpoch !== key.graphEpoch || record.actual !== true ||
        record.sourceOnly !== true || record.participantCredit !== false || !hash(record.receiptSha256) || !hash(record.ackSha256) ||
        !exact(record.ack, ackKeys) || cueDigest(record.ack) !== record.ackSha256 || !Number.isFinite(record.serverReceivedAtMs) ||
        !['bootstrap', 'continuation'].includes(record.startMode) || !id(record.sourceClipId) || !hash(record.sourceSha256) ||
        !hash(record.sourceContextSha256) || !frame(record.sourcePlaybackRevision) || !frame(record.queuedPrefixFrames) ||
        record.queuedPrefixFrames < WINDOW || record.queuedPrefixFrames > FRAMES || !hash(record.queuedPrefixSha256) ||
        !hash(record.processedWindowSha256) || !hash(record.authoritySha256) ||
        record.ack.kind !== 'cloud-source-playback-started-v1' || record.ack.actual !== true || record.ack.audioStarted !== true ||
        record.ack.participantCredit !== false || record.ack.graphEpoch !== record.graphEpoch || record.ack.sourceClipId !== record.sourceClipId ||
        record.ack.sourceSha256 !== record.sourceSha256 || record.ack.sourceContextSha256 !== record.sourceContextSha256 ||
        record.ack.sourcePlaybackRevision !== record.sourcePlaybackRevision || record.ack.sampleRate !== RATE ||
        !frame(record.ack.playedUntilFrame) || record.ack.playedUntilFrame < WINDOW || record.ack.playedUntilFrame > record.queuedPrefixFrames ||
        record.ack.processedWindowSha256 !== record.processedWindowSha256 ||
        record.startMode === 'bootstrap' && (record.queuedPrefixFrames !== FRAMES || record.maximumDurationFrames !== FRAMES ||
          record.continuationPlanSha256 !== null || record.continuationRenderSha256 !== null) ||
        record.startMode === 'continuation' && (record.maximumDurationFrames !== 180 * RATE ||
          !hash(record.continuationPlanSha256) || !hash(record.continuationRenderSha256)))
      fail('IMMUTABLE_SOURCE_START_RECEIPT_REQUIRED');
    const {receiptSha256, ...body} = record;
    if (cueDigest(body) !== receiptSha256) fail('IMMUTABLE_SOURCE_START_RECEIPT_REQUIRED');
    return structuredClone(record);
  };
  const location = key => ({id: 'source-start-' + cueDigest(key), reference: key});
  async function read(input) {
    const key = reference(input), record = await readRecord(location(key));
    return record === null || record === undefined ? null : validate(record, key);
  }
  const saveObservedImmutable=putObservedIfAbsent&&async function(record){
    const key=reference({...scopeFields(record),targetPlayerId:record.targetPlayerId,graphEpoch:record.graphEpoch}),value=validate(record,key);
    let persisted,duplicate;
    // This port must atomically fence owner/scope/Stop, graph, physical source
    // window and freshness in the SAME durable transaction as the write.
    // A lost result is reconciled by key; a mutation is never resent.
    try{const saved=await putObservedIfAbsent({...location(key),record:value});
      if(typeof saved?.duplicate!=='boolean')fail('SOURCE_START_RECEIPT_SAVE_REQUIRED');
      persisted=validate(saved.record,key);duplicate=saved.duplicate;}
    catch(error){persisted=await read(key);if(!persisted)throw error;duplicate=true;}
    if(persisted.ackSha256!==value.ackSha256||persisted.authoritySha256!==value.authoritySha256)fail('SOURCE_START_ACK_CONFLICT');
    return {record:persisted,duplicate};
  };
  return Object.freeze({read,...(saveObservedImmutable?{saveObservedImmutable}:{}), async saveImmutable(record) {
    const key = reference({...scopeFields(record), targetPlayerId: record.targetPlayerId, graphEpoch: record.graphEpoch});
    const value = validate(record, key), previous = await read(key);
    if (previous && (previous.ackSha256 !== value.ackSha256 || previous.authoritySha256 !== value.authoritySha256)) fail('SOURCE_START_ACK_CONFLICT');
    if (previous) return {record: previous, duplicate: true};
    await putIfAbsent({...location(key), record: value});
    const persisted = await read(key);
    if (!persisted || persisted.ackSha256 !== value.ackSha256 || persisted.authoritySha256 !== value.authoritySha256)
      fail('SOURCE_START_RECEIPT_SAVE_REQUIRED');
    return {record: persisted, duplicate: persisted.receiptSha256 !== value.receiptSha256};
  }});
}

// Host-selected seed/plan/graph, trusted measured-render verification and
// authenticated target telemetry are mandatory. There is no browser-controlled
// selection, client QC, native-hardware attestation, participant credit or permit.
export function createSourceStartReceiptAdapter({enabled = false, authorizeOwner, readScope, readStartAuthority,
  verifyContinuation, readPlaybackState, readGraphAuthority, readPriorStopReceipt, readPlayerFrontier, assetStore, receiptStore,
  now = Date.now, maximumAgeMs = 5000, allowStoppedRestart = false, readStartState,readAcknowledgedFrontier,showMode = false} = {}) {
  if (typeof allowStoppedRestart !== 'boolean' || typeof showMode !== 'boolean') fail('SOURCE_START_HOST_PORTS_REQUIRED');
  // The 30s graph lease bounds registration -> first processed window. In show
  // mode it never expires an acknowledged, still-playing source: Stop, scope,
  // graph identity and physical frontier checks continue on every read.
  const leaseExpired = (graph, playing) => !(showMode && playing) && graph.expiresAtMs <= now();
  if (![authorizeOwner, readScope, readStartAuthority, readPlaybackState, readGraphAuthority, readPlayerFrontier].every(value => typeof value === 'function') ||
      !assetStore?.read || !assetStore?.verifySaved || !receiptStore?.read || !receiptStore?.saveImmutable ||
      readStartState!==undefined&&typeof readStartState!=='function'||readAcknowledgedFrontier!==undefined&&typeof readAcknowledgedFrontier!=='function'||
      !Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1 || maximumAgeMs > 30000) fail('SOURCE_START_HOST_PORTS_REQUIRED');
  const active = () => { if (!enabled) fail('SOURCE_START_NOT_ACTIVATED'); };
  let acknowledgedInitial=null;
  async function asset(assetId, expectedSha256) {
    if (!id(assetId) || !hash(expectedSha256)) fail('SOURCE_START_PRIVATE_ASSET_REQUIRED');
    const record = await assetStore.read(assetId), bytes = record?.bytes;
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024 || record.assetId !== assetId ||
        record.sha256 !== expectedSha256 || record.byteLength !== bytes.byteLength || sha(bytes) !== expectedSha256)
      fail('SOURCE_START_PRIVATE_ASSET_REQUIRED');
    const proof = await assetStore.verifySaved({binding: structuredClone(record.binding), asset: {assetId, sha256: expectedSha256}});
    if (proof?.privateSaved !== true || proof.checksumVerified !== true || proof.assetId !== assetId || proof.sha256 !== expectedSha256 ||
        cueDigest(proof.binding ?? null) !== cueDigest(record.binding ?? null)) fail('SOURCE_START_PRIVATE_ASSET_REQUIRED');
    return record;
  }
  async function authority(input,{requirePlaying=false}={}) {
    const combined=readStartState?await readStartState({roomId:input.roomId}):null;
    const rawScope = combined?combined.scope:await readScope({roomId: input.roomId}), scope = scopeFields(rawScope);
    if (scope.roomId !== input.roomId || !id(scope.sessionId) || !frame(scope.controlRevision) || rawScope.closed === true ||
        !Number.isFinite(rawScope.expiresAtMs) || rawScope.expiresAtMs <= now()) fail('SOURCE_START_SCOPE_REQUIRED');
    const playback = combined?combined.playback:await readPlaybackState(scope);
    if (playback?.roomId !== scope.roomId || typeof playback.stopped !== 'boolean' || playback.currentCredit !== null ||
        playback.stopped && (!allowStoppedRestart||requirePlaying))
      fail('INITIAL_SOURCE_PLAYBACK_SCOPE_REQUIRED');
    const selected = await readStartAuthority({...scope, ...(combined?{expiresAtMs:rawScope.expiresAtMs}:{})}),
      graph = combined?combined.graph:await readGraphAuthority(scope), source = selected?.source, plan = selected?.firstPlan;
    if (!sameScope(selected, scope) || selected.kind !== 'server-selected-source-start-v1' || selected.serverQC !== true ||
        !hash(selected.qcEvidenceSha256) || !hash(selected.sourceSha256) || !source || source.playback?.actual !== false || source.music?.ready !== true ||
        cueDigest(cueSourceIdentity(source)) !== selected.sourceSha256 || !frame(source.playback?.revision) ||
        source.music?.clipId !== source.audioAssetId || source.music.contextSeconds !== 16 || source.music.contextVerified !== true)
      fail('SERVER_SELECTED_SOURCE_REQUIRED');
    if (!sameScope(graph, scope) || graph.kind !== 'selected-player-graph-v1' || !id(graph.targetPlayerId) ||
        !frame(graph.graphEpoch) || graph.graphEpoch < 1 || !['initial', 'restart'].includes(graph.mode) ||
        !['SELECTED', 'SOURCE_STARTED'].includes(graph.phase) || graph.freshGraph !== true || graph.sourceCount !== 1 ||
        graph.receivedFramesBeforeStart !== 0 || graph.consumedFramesBeforeStart !== 0 || graph.stopped === true ||
        !Number.isFinite(graph.selectedAtMs) || graph.selectedAtMs > now() || !Number.isFinite(graph.expiresAtMs) || leaseExpired(graph, requirePlaying) ||
        graph.expiresAtMs - graph.selectedAtMs > 30000 || graph.expiresAtMs <= graph.selectedAtMs)
      fail('FRESH_SELECTED_GRAPH_REQUIRED');
    if (graph.mode === 'initial' && (graph.graphEpoch !== 1 || graph.previousGraphEpoch !== undefined)) fail('FRESH_SELECTED_GRAPH_REQUIRED');
    if (playback.stopped && graph.mode !== 'restart') fail('INITIAL_SOURCE_PLAYBACK_SCOPE_REQUIRED');
    if (graph.mode === 'restart') {
      if (!frame(graph.previousGraphEpoch) || graph.previousGraphEpoch < 1 || graph.previousGraphEpoch !== graph.graphEpoch - 1 ||
          !id(graph.previousTargetPlayerId) || !hash(graph.priorStopReceiptSha256) || typeof readPriorStopReceipt !== 'function')
        fail('PRIOR_GRAPH_STOP_REQUIRED');
      const stop = combined?combined.priorStopReceipt:await readPriorStopReceipt({...scope, targetPlayerId: graph.previousTargetPlayerId, graphEpoch: graph.previousGraphEpoch});
      if (!sameScope(stop, scope) || stop?.kind !== 'selected-player-graph-stopped-v1' || stop.targetPlayerId !== graph.previousTargetPlayerId ||
          stop.graphEpoch !== graph.previousGraphEpoch || stop.stopped !== true || stop.receiptSha256 !== graph.priorStopReceiptSha256 ||
          !Number.isFinite(stop.serverStoppedAtMs) || stop.serverStoppedAtMs > graph.selectedAtMs) fail('PRIOR_GRAPH_STOP_REQUIRED');
      const {receiptSha256, ...body} = stop;
      if (cueDigest(body) !== receiptSha256) fail('PRIOR_GRAPH_STOP_REQUIRED');
    }
    const [parent, context, reference] = await Promise.all([asset(source.audioAssetId, source.music.sha256),
      asset(source.contextAssetId, source.music.contextSha256), asset(source.referenceAssetId, source.video.referenceSha256)]);
    const audio = deriveVerifiedWave(parent), profile = source.music.profile;
    if (parent.provenance?.kind !== 'owner-supplied-bootstrap' || parent.provenance.actualGenerationThisRun !== false ||
        audio.frames !== FRAMES || audio.contextSha256 !== source.music.contextSha256 || !Buffer.from(context.bytes).equals(audio.contextBytes) ||
        profile?.method !== 'pcm-endpoint-profile-v1' || profile.assetSha256 !== source.music.sha256 || profile.sampleRate !== RATE ||
        profile.channels !== 2 || profile.frameCount !== FRAMES || profile.nonfiniteSamples !== 0 ||
        !Number.isFinite(profile.clippedFraction) || profile.clippedFraction > .001 || profile.activity?.effectiveSilence !== false ||
        !Number.isFinite(profile.activity.maxQuietRunSeconds) || profile.activity.maxQuietRunSeconds > .5 ||
        !Number.isFinite(profile.loudness?.truePeakDbtp) || profile.loudness.truePeakDbtp > -.3 || reference.byteLength > 4 * 1024 * 1024 ||
        !['image/png', 'image/jpeg'].includes(reference.contentType))
      fail('EXACT_PRIVATE_BOOTSTRAP_REQUIRED');
    const bootstrap = selected.mode === 'bootstrap';
    if (selected.mode !== undefined && !['bootstrap', 'continuation'].includes(selected.mode)) fail('SERVER_SELECTED_SOURCE_REQUIRED');
    let planSha256 = null, renderSha256 = null, prefixFrames = FRAMES, measuredEvidenceSha256 = selected.qcEvidenceSha256;
    if (bootstrap) {
      if (plan !== undefined && plan !== null || graph.finiteDurationFrames !== FRAMES) fail('FINITE_BOOTSTRAP_SOURCE_REQUIRED');
    } else {
      const transition = plan?.transition, {planSha256: planDigest, ...planBody} = plan ?? {};
      if (plan?.status !== 'ELIGIBLE' || plan.liveReady !== true || plan.qualityReady !== true || plan.fixtureOnly !== false || plan.roomId !== scope.roomId ||
        !hash(planDigest) || transitionDigest(planBody) !== planDigest ||
        plan.currentClipId !== source.music.clipId || plan.currentSha256 !== source.music.sha256 || plan.currentContextSha256 !== source.music.contextSha256 ||
        plan.currentPlaybackRevision !== source.playback.revision || !hash(transition?.renderedSha256) || transition.renderVerified !== true ||
        transition.timeStretch !== false || transition.pitchShift !== false || transition.sampleRate !== RATE || !frame(transition.editStartFrame) || transition.editStartFrame < WINDOW ||
        transition.editStartFrame > FRAMES ||
        // A measured cut ends at the seed's last frame; a measured crossfade ends
        // there too, centred overlapFrames/2 earlier with the incoming at half.
        !frame(transition.overlapFrames ?? 0) || (transition.overlapFrames ?? 0) % 2 ||
        transition.exitFrame + (transition.overlapFrames ?? 0) / 2 !== FRAMES || transition.entryFrame !== (transition.overlapFrames ?? 0) / 2)
        fail('MEASURED_FIRST_CONTINUATION_REQUIRED');
      if (typeof verifyContinuation !== 'function') fail('MEASURED_FIRST_CONTINUATION_REQUIRED');
      const measured = await verifyContinuation({scope, source: structuredClone(source), firstPlan: structuredClone(plan)});
      if (measured?.kind !== 'verified-first-continuation-v1' || measured.valid !== true || !sameScope(measured, scope) ||
        measured.planSha256 !== planDigest || measured.renderedSha256 !== transition.renderedSha256 ||
        measured.sourceSha256 !== source.music.sha256 || measured.contextSha256 !== source.music.contextSha256 || !hash(measured.evidenceSha256))
        fail('MEASURED_FIRST_CONTINUATION_REQUIRED');
      planSha256 = planDigest; renderSha256 = transition.renderedSha256; prefixFrames = transition.editStartFrame;
      measuredEvidenceSha256 = measured.evidenceSha256;
    }
    const prefix = audio.copyPcm().subarray(0, prefixFrames * 2), expected = {...scope, targetPlayerId: graph.targetPlayerId,
      graphEpoch: graph.graphEpoch, sourceClipId: source.music.clipId, sourceSha256: source.music.sha256,
      sourceContextSha256: source.music.contextSha256, sourcePlaybackRevision: source.playback.revision,
      startMode: bootstrap ? 'bootstrap' : 'continuation', maximumDurationFrames: bootstrap ? FRAMES : 180 * RATE,
      queuedPrefixFrames: prefixFrames, queuedPrefixSha256: pcmSha(prefix),
      processedWindowSha256: pcmSha(prefix.subarray(0, WINDOW * 2)), continuationPlanSha256: planSha256,
      continuationRenderSha256: renderSha256};
    return {scope, graph, source: structuredClone(source), expected, authoritySha256: cueDigest({...expected,
      selectedSourceSha256: selected.sourceSha256, qcEvidenceSha256: selected.qcEvidenceSha256, measuredEvidenceSha256,
      mode: graph.mode, priorStopReceiptSha256: graph.priorStopReceiptSha256 ?? null})};
  }
  const keyFor = expected => ({...scopeFields(expected), targetPlayerId: expected.targetPlayerId, graphEpoch: expected.graphEpoch});
  const checkAck = (ack, expected) => {
    if (!exact(ack, ackKeys) || ack.kind !== 'cloud-source-playback-started-v1' || ack.graphEpoch !== expected.graphEpoch ||
        ack.sourceClipId !== expected.sourceClipId || ack.sourceSha256 !== expected.sourceSha256 || ack.sourceContextSha256 !== expected.sourceContextSha256 ||
        ack.sourcePlaybackRevision !== expected.sourcePlaybackRevision || ack.sampleRate !== RATE || !frame(ack.playedUntilFrame) ||
        ack.playedUntilFrame < WINDOW || ack.playedUntilFrame > expected.queuedPrefixFrames || ack.processedWindowSha256 !== expected.processedWindowSha256 ||
        ack.actual !== true || ack.audioStarted !== true || ack.participantCredit !== false) fail('MATCHING_SOURCE_ONLY_PCM_ACK_REQUIRED');
  };
  async function frontier(state, minimum,reader=readPlayerFrontier) {
    const expected = state.expected, value = await reader({...expected});
    if (!sameScope(value, expected) || value?.kind !== 'authenticated-source-frontier-v1' || value.targetPlayerId !== expected.targetPlayerId ||
        value.graphEpoch !== expected.graphEpoch || value.sourceClipId !== expected.sourceClipId || value.sourceSha256 !== expected.sourceSha256 ||
        value.sourceContextSha256 !== expected.sourceContextSha256 || value.sourcePlaybackRevision !== expected.sourcePlaybackRevision ||
        value.processedWindowSha256 !== expected.processedWindowSha256 || value.sampleRate !== RATE ||
        !frame(value.playedUntilFrame) || value.playedUntilFrame < minimum || value.playedUntilFrame >= expected.queuedPrefixFrames ||
        value.receivedFrames !== expected.queuedPrefixFrames || value.sourceCount !== 1 || value.underrunFrames !== 0 || value.stopped === true ||
        value.actual !== true || value.audioStarted !== true || value.participantCredit !== false ||
        !Number.isFinite(value.serverObservedAtMs) || value.serverObservedAtMs > now() || now() - value.serverObservedAtMs > maximumAgeMs)
      fail('FRESH_SOURCE_PLAYER_FRONTIER_REQUIRED');
    return value;
  }
  async function unchanged(input, previous, options) {
    const fresh = await authority(input,options);
    if (fresh.authoritySha256 !== previous.authoritySha256) fail('SOURCE_START_AUTHORITY_CHANGED');
    return fresh;
  }
  const receiptMatches = (record, state) => {
    if (!record || record.authoritySha256 !== state.authoritySha256 || cueDigest(keyFor(record)) !== cueDigest(keyFor(state.expected)) ||
        record.kind !== 'immutable-source-start-receipt-v1' || record.sourceOnly !== true || record.participantCredit !== false || record.actual !== true ||
        !Number.isFinite(record.serverReceivedAtMs) || record.serverReceivedAtMs < state.graph.selectedAtMs || record.serverReceivedAtMs > now() ||
        !hash(record.receiptSha256) || !hash(record.ackSha256))
      fail('VERIFIED_SOURCE_START_RECEIPT_REQUIRED');
    if (Object.entries(state.expected).some(([key, value]) => record[key] !== value)) fail('VERIFIED_SOURCE_START_RECEIPT_REQUIRED');
    checkAck(record.ack, state.expected);
    const {receiptSha256, ...body} = record;
    if (cueDigest(body) !== receiptSha256 || cueDigest(record.ack) !== record.ackSha256) fail('VERIFIED_SOURCE_START_RECEIPT_REQUIRED');
  };
  async function markSourceStarted(input) {
    active();
    if (!exact(input, ['roomId', 'ownerCapability', 'ack']) || !roomId(input.roomId) || !hash(input.ownerCapability) ||
        await authorizeOwner({roomId: input.roomId, ownerCapability: input.ownerCapability}) !== true) fail('OWNER_DENIED');
    const state = await authority({roomId: input.roomId}); checkAck(input.ack, state.expected);
    if(typeof receiptStore.saveObservedImmutable==='function'){
      // The trusted atomic port validates this physical frontier in the same
      // transaction as its write. A separate pre-read only repeats that fence.
      // Keep the fresh post-write check for Stop/change/lost-reply recovery.
      const record=seal({kind:'immutable-source-start-receipt-v1',...state.expected,authoritySha256:state.authoritySha256,
        ackSha256:cueDigest(input.ack),ack:structuredClone(input.ack),serverReceivedAtMs:now(),actual:true,sourceOnly:true,participantCredit:false});
      const saved=await receiptStore.saveObservedImmutable(record);receiptMatches(saved?.record,state);
      // This fresh read also rejects Stop/scope/graph changes after commit or
      // during reconciliation. The atomic write replaces repeated HTTP reads,
      // never the physical proof or the live authorization checks.
      await frontier(state,input.ack.playedUntilFrame);
      if(state.graph.expiresAtMs<=now())fail('FRESH_SELECTED_GRAPH_REQUIRED');
      if(readAcknowledgedFrontier)acknowledgedInitial=structuredClone({state,receipt:saved.record});
      return {accepted:true,duplicate:saved.duplicate===true,sourceOnly:true,participantCredit:false,graphEpoch:state.expected.graphEpoch,
        sourceSha256:state.expected.sourceSha256,sourcePlaybackRevision:state.expected.sourcePlaybackRevision,receiptSha256:saved.record.receiptSha256};
    }
    await frontier(state, input.ack.playedUntilFrame); await unchanged({roomId: input.roomId}, state);
    const key = keyFor(state.expected), previous = await receiptStore.read(key);
    if (previous) {
      receiptMatches(previous, state);
      if (previous.ackSha256 !== cueDigest(input.ack)) fail('SOURCE_START_ACK_CONFLICT');
      await frontier(state, input.ack.playedUntilFrame); await unchanged({roomId: input.roomId}, state);
      if(readAcknowledgedFrontier)acknowledgedInitial=structuredClone({state,receipt:previous});
      return {accepted: true, duplicate: true, sourceOnly: true, participantCredit: false, graphEpoch: state.expected.graphEpoch,
        sourceSha256: state.expected.sourceSha256, sourcePlaybackRevision: state.expected.sourcePlaybackRevision,
        receiptSha256: previous.receiptSha256};
    }
    if (state.graph.phase !== 'SELECTED') fail('SOURCE_START_PRIOR_RECEIPT_REQUIRED');
    const record = seal({kind: 'immutable-source-start-receipt-v1', ...state.expected, authoritySha256: state.authoritySha256,
      ackSha256: cueDigest(input.ack), ack: structuredClone(input.ack), serverReceivedAtMs: now(), actual: true, sourceOnly: true, participantCredit: false});
    const saved = await receiptStore.saveImmutable(record); receiptMatches(saved?.record, state);
    await frontier(state, input.ack.playedUntilFrame);
    await unchanged({roomId: input.roomId}, state);
    if(readAcknowledgedFrontier)acknowledgedInitial=structuredClone({state,receipt:saved.record});
    return {accepted: true, duplicate: saved.duplicate === true, sourceOnly: true, participantCredit: false, graphEpoch: state.expected.graphEpoch,
      sourceSha256: state.expected.sourceSha256, sourcePlaybackRevision: state.expected.sourcePlaybackRevision,
      receiptSha256: saved.record.receiptSha256};
  }
  async function readInitialCurrentSource(input,{requirePlaying=false}={}) {
    active(); if (!exact(input, ['roomId']) || !roomId(input.roomId)) fail('INITIAL_SOURCE_IDS_ONLY');
    if(readAcknowledgedFrontier&&acknowledgedInitial){
      // Reuse only the already verified immutable source and durable receipt.
      // The live reader still authenticates scope/Stop/current graph and exact
      // physical PCM before returning its fresh bounded frontier on EVERY call.
      const {state,receipt}=acknowledgedInitial;
      if(state.scope.roomId!==input.roomId||leaseExpired(state.graph,requirePlaying))fail('FRESH_SELECTED_GRAPH_REQUIRED');
      receiptMatches(receipt,state);
      const observed=await frontier(state,receipt.ack.playedUntilFrame,readAcknowledgedFrontier);
      if(typeof observed.playbackStopped!=='boolean'||requirePlaying&&observed.playbackStopped)fail('INITIAL_SOURCE_PLAYBACK_SCOPE_REQUIRED');
      if(leaseExpired(state.graph,requirePlaying))fail('FRESH_SELECTED_GRAPH_REQUIRED');
      return {...structuredClone(state.source),playback:{phase:'PLAYING',revision:state.expected.sourcePlaybackRevision,
        playedUntilFrame:observed.playedUntilFrame,actual:true,graphEpoch:state.expected.graphEpoch},
        sourceStart:{receiptSha256:receipt.receiptSha256,targetPlayerId:state.expected.targetPlayerId,graphEpoch:state.expected.graphEpoch,
          startMode:state.expected.startMode,maximumDurationFrames:state.expected.maximumDurationFrames,sourceOnly:true,participantCredit:false}};
    }
    const state = await authority(input,{requirePlaying}), receipt = await receiptStore.read(keyFor(state.expected)); receiptMatches(receipt, state);
    const observed = await frontier(state, receipt.ack.playedUntilFrame); await unchanged(input, state,{requirePlaying});
    return {...state.source, playback: {phase: 'PLAYING', revision: state.expected.sourcePlaybackRevision, playedUntilFrame: observed.playedUntilFrame,
      actual: true, graphEpoch: state.expected.graphEpoch}, sourceStart: {receiptSha256: receipt.receiptSha256, targetPlayerId: state.expected.targetPlayerId,
      graphEpoch: state.expected.graphEpoch, startMode: state.expected.startMode, maximumDurationFrames: state.expected.maximumDurationFrames,
      sourceOnly: true, participantCredit: false}};
  }
  return Object.freeze({markSourceStarted, readInitialCurrentSource,
    readAcknowledgedCurrentSource:async(input,options)=>acknowledgedInitial&&readAcknowledgedFrontier?readInitialCurrentSource(input,options):null,
    readCurrent: async value => {
    const source = await readInitialCurrentSource(typeof value === 'string' ? {roomId: value} : value);
    return {actual: true, clipId: source.music.clipId, sha256: source.music.sha256, contextSha256: source.music.contextSha256,
      profile: structuredClone(source.music.profile), playbackRevision: source.playback.revision, playedUntilFrame: source.playback.playedUntilFrame,
      graphEpoch: source.sourceStart.graphEpoch, sourceOnly: true, participantCredit: false};
  }});
}
