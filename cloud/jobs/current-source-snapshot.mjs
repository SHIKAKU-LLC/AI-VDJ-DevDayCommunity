import {createHash} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {operationBinding} from '../generation/cue-contract.mjs';
import {hasVerifiedPersistedCloudCue} from './room-projection.mjs';
import {cueDigest, cueSourceIdentity, validateCueSource} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {deriveVerifiedWave} from '../../integration/runtime/verified-wave-derivation.mjs';

const fail = code => { throw new DispatchError(code); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const room = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scopeFields = value => { const {roomId, sessionId, controlRevision} = value; return {roomId, sessionId, controlRevision}; };
const sameScope = (left, right) => left?.roomId === right?.roomId && Object.is(left?.sessionId, right?.sessionId) && left?.controlRevision === right?.controlRevision;
const sourceIdFor = (roomId, source) => 'source-' + cueDigest({roomId, identity: cueSourceIdentity(source),
  audioAssetId: source.audioAssetId, contextAssetId: source.contextAssetId, referenceAssetId: source.referenceAssetId}).slice(0, 48);

// Server-only preparation over existing immutable stores. No current pointer,
// live observation, capability, prompt or participant credit is stored here.
// Actual source/frame truth remains the existing verified current-source port.
export function createAcknowledgedCurrentSourceSnapshot({enabled = false, repositoryPorts, assetStore, sourceStore,
  readSelectedTarget, now = Date.now,cachePreparedMaterial=false} = {}) {
  if (!['readScope', 'readPlaybackState', 'readAuthoritativeOperation'].every(key => typeof repositoryPorts?.[key] === 'function') ||
      !['read', 'save', 'verifySaved'].every(key => typeof assetStore?.[key] === 'function') ||
      !['read', 'save'].every(key => typeof sourceStore?.[key] === 'function') || typeof readSelectedTarget !== 'function'||typeof cachePreparedMaterial!=='boolean')
    fail('CURRENT_SOURCE_SNAPSHOT_PORTS_REQUIRED');
  const preparedMaterials=new Map();
  const materialKey=state=>{const {status,playbackRevision,...cue}=state.cue;
    return cueDigest({scope:state.scope,cue,source:state.operation.permit,plan:state.operation.plan,stages:state.operation.stages});};
  const active = () => { if (enabled !== true) fail('CURRENT_SOURCE_SNAPSHOT_NOT_ACTIVATED'); };
  async function authority(input, expectedScope) {
    const scope = await repositoryPorts.readScope({roomId: input.roomId});
    if (scope?.roomId !== input.roomId || !id(scope.sessionId) || !integer(scope.controlRevision) || scope.closed === true ||
        !Number.isFinite(scope.expiresAtMs) || scope.expiresAtMs <= now() || expectedScope && !sameScope(scope, expectedScope))
      fail('CURRENT_SOURCE_SNAPSHOT_SCOPE_REQUIRED');
    const playback = await repositoryPorts.readPlaybackState(scopeFields(scope)), credit = playback?.currentCredit;
    if (playback?.roomId !== scope.roomId) fail('ACKNOWLEDGED_CURRENT_CUE_REQUIRED_PLAYBACK_ROOM');
    if (playback.stopped !== false) fail('ACKNOWLEDGED_CURRENT_CUE_REQUIRED_PLAYBACK_STOPPED');
    if (!Array.isArray(playback.cues) || playback.cues.length > 100) fail('ACKNOWLEDGED_CURRENT_CUE_REQUIRED_PLAYBACK_CUES_' + (Array.isArray(playback.cues) ? playback.cues.length : 'NONE'));
    if (credit?.roomId !== scope.roomId || credit.actual !== true || credit.actualPlayback !== true || !integer(credit.playbackRevision) ||
        credit.playbackRevision < 1 || !id(credit.cueId) || !id(credit.generationId) || !id(credit.submissionId))
      fail('ACKNOWLEDGED_CURRENT_CUE_REQUIRED_CREDIT');
    // Replayed/recovered operations can keep older copies of the same Cue
    // (READY/HOLD/PLAYED). Exactly one copy may be the sounding one: PLAYING
    // at the credited revision.
    const matches = playback.cues.filter(cue => cue?.cueId === credit.cueId && cue.status === 'PLAYING' &&
      cue.playbackRevision === credit.playbackRevision);
    if (matches.length !== 1) fail(matches.length ? 'ACKNOWLEDGED_CURRENT_CUE_REQUIRED_AMBIGUOUS' : 'ACKNOWLEDGED_CURRENT_CUE_REQUIRED_NOT_PLAYING');
    const cue = matches[0],published=typeof repositoryPorts.readPublishedPlaybackOperation==='function';let operation;
    try{operation=await (published?repositoryPorts.readPublishedPlaybackOperation:repositoryPorts.readAuthoritativeOperation)(
      {roomId:scope.roomId,operationId:cue.operationId});}
    // Keep the read failure's bounded code for diagnosis (never its message).
    catch(error){fail('ACKNOWLEDGED_CURRENT_CUE_REQUIRED_READ_'+String(error?.code??'UNKNOWN').replace(/[^A-Z0-9_]/g,'').slice(0,40));}
    // status/playbackRevision are runtime fields SQL rewrites on reserve/ACK/
    // Stop and an operation read right after an ACK may still carry the prior
    // value; the live playback Cue is checked for PLAYING + credited revision.
    const content = value => { const {status, playbackRevision, ...rest} = value ?? {}; return cueDigest(rest); };
    if (!hasVerifiedPersistedCloudCue({roomId: scope.roomId, operation}) || operation.stopped || !published&&operation.dispatchAllowed !== true)
      fail('ACKNOWLEDGED_CURRENT_CUE_REQUIRED_OPERATION');
    if (content(operation.cue) !== content(cue)) fail('ACKNOWLEDGED_CURRENT_CUE_REQUIRED_CONTENT');
    if (cue.status !== 'PLAYING' || cue.playbackRevision !== credit.playbackRevision ||
        cue.generationId !== credit.generationId || cue.submissionId !== credit.submissionId)
      fail('ACKNOWLEDGED_CURRENT_CUE_REQUIRED');
    const selected = await readSelectedTarget(scopeFields(scope));
    if (!sameScope(selected, scope) || selected.kind !== 'selected-current-player-v1' || !id(selected.targetPlayerId) ||
        selected.cueId !== cue.cueId || selected.generationId !== cue.generationId || selected.playbackRevision !== credit.playbackRevision ||
        !Number.isFinite(selected.expiresAtMs) || selected.expiresAtMs <= now()) fail('CURRENT_SOURCE_SELECTED_TARGET_REQUIRED');
    const target = {...scopeFields(selected), targetPlayerId: selected.targetPlayerId, cueId: selected.cueId,
      generationId: selected.generationId, playbackRevision: selected.playbackRevision};
    return {scope: scopeFields(scope), cue: structuredClone(cue), operation: structuredClone(operation), target,
      fingerprint: cueDigest({scope: scopeFields(scope), credit, cue, target, source: operation.permit.source,
        control: operation.plan.common.control, stage: operation.stages.music})};
  }
  async function unchanged(state) {
    if ((await authority({roomId: state.scope.roomId}, state.scope)).fingerprint !== state.fingerprint)
      fail('CURRENT_SOURCE_SNAPSHOT_CHANGED');
  }
  async function asset(assetId, expectedSha256) {
    if (!id(assetId) || !hash(expectedSha256)) fail('CURRENT_SOURCE_SNAPSHOT_ASSET_REQUIRED');
    const record = structuredClone(await assetStore.read(assetId)), bytes = record?.bytes;
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 32 * 1024 * 1024 || record.assetId !== assetId ||
        record.sha256 !== expectedSha256 || record.byteLength !== bytes.length || sha(bytes) !== expectedSha256)
      fail('CURRENT_SOURCE_SNAPSHOT_ASSET_REQUIRED');
    const proof = await assetStore.verifySaved({binding: structuredClone(record.binding), asset: {assetId, sha256: expectedSha256}});
    if (proof?.privateSaved !== true || proof.checksumVerified !== true || proof.assetId !== assetId || proof.sha256 !== expectedSha256 ||
        cueDigest(proof.binding ?? null) !== cueDigest(record.binding ?? null)) fail('CURRENT_SOURCE_SNAPSHOT_ASSET_REQUIRED');
    return record;
  }
  async function derive(state) {
    const {scope, cue, operation: op} = state, prior = op.permit.source, stage = op.stages.music;
    validateCueSource(prior);
    if (cueDigest(cueSourceIdentity(prior)) !== op.permit.sourceSha256) fail('CURRENT_SOURCE_PRIOR_CONTEXT_REQUIRED');
    const [previousParent, previousContext] = await Promise.all([asset(prior.audioAssetId, prior.music.sha256),
      asset(prior.contextAssetId, prior.music.contextSha256)]);
    const previousAudio = deriveVerifiedWave(previousParent);
    if (previousParent.contentType !== 'audio/wav' || previousContext.contentType !== 'audio/wav' || previousAudio.frames !== 24 * 44100 ||
        !Buffer.from(previousContext.bytes).equals(previousAudio.contextBytes)) fail('CURRENT_SOURCE_PRIOR_CONTEXT_REQUIRED');
    const parent = await asset(cue.music.asset.assetId, cue.music.asset.sha256), provenance = parent.provenance;
    const binding = operationBinding(scope.roomId, op, 'music');
    if (parent.contentType !== 'audio/wav' || cueDigest(parent.binding ?? null) !== cueDigest(binding) || provenance?.kind !== 'provider' ||
        provenance.requestId !== stage.requestId || provenance.resultSha256 !== stage.result?.resultSha256 || !id(stage.requestId) ||
        !hash(stage.result?.resultSha256) || provenance.operationId !== op.operationId)
      fail('CURRENT_SOURCE_PROVIDER_LINEAGE_REQUIRED');
    if (!id(prior.referenceAssetId) || !hash(prior.video?.referenceSha256)) fail('CURRENT_SOURCE_REFERENCE_REQUIRED');
    const reference = await asset(prior.referenceAssetId, prior.video.referenceSha256);
    if (!['image/png', 'image/jpeg'].includes(reference.contentType) || reference.byteLength > 4 * 1024 * 1024)
      fail('CURRENT_SOURCE_REFERENCE_REQUIRED');
    const decoded = deriveVerifiedWave(parent);
    if (decoded.frames !== 24 * 44100) fail('CURRENT_SOURCE_EXACT_PARENT_REQUIRED');
    const contextBytes = decoded.contextBytes, contextSha256 = decoded.contextSha256;
    const contextAssetId = 'context-' + cueDigest({roomId: scope.roomId, operationId: op.operationId,
      parentSha256: parent.sha256, contextSha256}).slice(0, 48);
    const control = Object.fromEntries(['version', 'energy', 'tension', 'density', 'brightness'].map(key => [key, op.plan.common.control[key]]));
    const source = {audioAssetId: parent.assetId, contextAssetId, referenceAssetId: reference.assetId,
      music: {clipId: parent.assetId, sha256: parent.sha256, profile: structuredClone(cue.music.profile), ready: true,
        contextSeconds: 16, contextVerified: true, contextSha256, control},
      video: {motifId: prior.video.motifId, motifSnapshotSha256: prior.video.motifSnapshotSha256, referenceSha256: reference.sha256},
      quality: {fixedBpm: prior.quality.fixedBpm},
      playback: {phase: 'IDLE', revision: 0, playedUntilFrame: 0, actual: false}};
    validateCueSource(source);
    const sourceEvidence = {kind: 'verified-source-context-v1', roomId: scope.roomId, originKind: 'provider',
      parentAssetId: parent.assetId, parentSha256: parent.sha256, contextAssetId, contextSha256,
      referenceAssetId: reference.assetId, referenceSha256: reference.sha256, contextSeconds: 16, serverAudioQC: true,
      providerReceipt: {operationId: op.operationId, requestId: stage.requestId, resultSha256: stage.result.resultSha256}};
    return {source, sourceEvidence, sourceId: sourceIdFor(scope.roomId, source), contextBytes, binding,
      contextProvenance: {kind: 'derived-context', operationId: op.operationId, parentSha256: parent.sha256,
        contextSha256, actualGenerationThisRun: false}};
  }
  async function persisted(state, material) {
    const context = await asset(material.source.contextAssetId, material.source.music.contextSha256);
    if (context.contentType !== 'audio/wav' || cueDigest(context.binding ?? null) !== cueDigest(material.binding) ||
        cueDigest(context.provenance ?? null) !== cueDigest(material.contextProvenance) ||
        !Buffer.from(context.bytes).equals(material.contextBytes)) fail('CURRENT_SOURCE_DERIVED_CONTEXT_REQUIRED');
    const saved = await sourceStore.read(material.sourceId);
    if (saved?.version !== 'private-source-v1' || saved.roomId !== state.scope.roomId || saved.sourceId !== material.sourceId ||
        cueDigest(saved.source ?? null) !== cueDigest(material.source) || cueDigest(saved.sourceEvidence ?? null) !== cueDigest(material.sourceEvidence))
      fail('CURRENT_SOURCE_SAVED_SNAPSHOT_REQUIRED');
    return saved;
  }
  async function prepareCurrentSource(input) {
    active(); if (!input || Object.keys(input).some(key => key !== 'roomId') || !room(input.roomId)) fail('CURRENT_SOURCE_SNAPSHOT_IDS_ONLY');
    const state = await authority(input),cached=preparedMaterials.get(materialKey(state));
    if(cached)return preparedResult(state,cached.material);
    const material = await derive(state); await unchanged(state);
    try { await assetStore.save({id: material.source.contextAssetId, bytes: Buffer.from(material.contextBytes), contentType: 'audio/wav',
      binding: structuredClone(material.binding), provenance: structuredClone(material.contextProvenance)}); }
    catch (error) { try { await asset(material.source.contextAssetId, material.source.music.contextSha256); } catch { throw error; } }
    await unchanged(state);
    try { await sourceStore.save({source: structuredClone(material.source), sourceEvidence: structuredClone(material.sourceEvidence)}); }
    catch (error) { try { await persisted(state, material); } catch { throw error; } }
    await persisted(state, material); await unchanged(state);
    return preparedResult(state,material);
  }
  const preparedResult=(state,material)=>({roomId:state.scope.roomId,sourceId:material.sourceId,
    sourceSha256:cueDigest(cueSourceIdentity(material.source)),cueId:state.cue.cueId,playbackRevision:state.cue.playbackRevision});
  async function preparePublishedSource(input){
    active();if(!input||Object.keys(input).some(k=>!['roomId','operationId'].includes(k))||!room(input.roomId)||!id(input.operationId))
      fail('CURRENT_SOURCE_SNAPSHOT_IDS_ONLY');
    const read=async()=>{const scope=await repositoryPorts.readScope({roomId:input.roomId}),saved=await repositoryPorts.readOperation(input),op=saved.operation;
      if(scope.closed||scope.expiresAtMs<=now()||!sameScope(saved,scope)||saved.revoked!==false||op.stopped||
        !hasVerifiedPersistedCloudCue({roomId:input.roomId,operation:op})||!['READY','SELECTED','PLAYING'].includes(op.cue.status))
        fail('PUBLISHED_PLAYBACK_OPERATION_REQUIRED');
      return {scope:scopeFields(scope),operation:op,cue:op.cue};};
    const state=await read(),key=materialKey(state),material=await derive(state);
    // These are preparation-only immutable records with actual:false. They
    // grant no CURRENT truth, observation, reservation or participant credit.
    await assetStore.save({id:material.source.contextAssetId,bytes:Buffer.from(material.contextBytes),contentType:'audio/wav',
      binding:structuredClone(material.binding),provenance:structuredClone(material.contextProvenance)});
    await sourceStore.save({source:structuredClone(material.source),sourceEvidence:structuredClone(material.sourceEvidence)});
    const saved=await persisted(state,material);
    if(materialKey(await read())!==key)fail('CURRENT_SOURCE_SNAPSHOT_CHANGED');
    if(cachePreparedMaterial){while(preparedMaterials.size>=3)preparedMaterials.delete(preparedMaterials.keys().next().value);
      preparedMaterials.set(key,structuredClone({material,saved}));}
    return {prepared:true,sourceOnly:true,participantCredit:false,source:structuredClone(material.source)};
  }
  async function readSourceRecord(input) {
    active(); if (!input || Object.keys(input).some(key => !['roomId', 'sessionId', 'controlRevision'].includes(key)) ||
        !room(input.roomId) || !id(input.sessionId) || !integer(input.controlRevision)) fail('CURRENT_SOURCE_SNAPSHOT_SCOPE_REQUIRED');
    const state = await authority({roomId: input.roomId}, input),cached=preparedMaterials.get(materialKey(state));
    const material=cached?.material??await derive(state),saved=cached?.saved??await persisted(state,material);
    if(!cached)await unchanged(state);
    return {...state.scope, kind: 'saved-current-source-v1', serverQC: true, qcEvidenceSha256: state.cue.music.qc.evidenceSha256,
      targetPlayerId: state.target.targetPlayerId, sourceSha256: cueDigest(cueSourceIdentity(saved.source)), source: structuredClone(saved.source)};
  }
  return Object.freeze({prepareCurrentSource,preparePublishedSource,readSourceRecord});
}
