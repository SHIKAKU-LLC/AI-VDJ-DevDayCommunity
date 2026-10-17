import {createHash} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest, cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {deriveVerifiedWave} from '../../integration/runtime/verified-wave-derivation.mjs';
import {hasVerifiedPersistedCloudCue} from './room-projection.mjs';

// Exact prepared SELECT text shared with the optional production transport.
export {EXISTING_REPOSITORY_SELECTS} from './repository-statements.mjs';
import {EXISTING_REPOSITORY_SELECTS} from './repository-statements.mjs';

const fail = code => { throw new DispatchError(code); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const roomId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frame = value => Number.isSafeInteger(value) && value >= 0;
// sessionId is an opaque room epoch, never an authentication session.
const scopeFields = value => { const {roomId, sessionId, controlRevision} = value; return {roomId, sessionId, controlRevision}; };
const scopeEqual = (left, right) => left?.roomId === right?.roomId && Object.is(left?.sessionId, right?.sessionId) && left?.controlRevision === right?.controlRevision;

// SELECT-only host port over the existing prepared tables. query is injected;
// this module creates no connection, policy, role, table, transport or key lease.
// hostGenerationRead must call the existing owner-authenticated generation RPC;
// the host supplies its approved request-scoped owner proof outside this module.
export function createExistingCloudRepositoryReadPorts({query, hostGenerationRead, now = Date.now} = {}) {
  if (typeof query !== 'function' || typeof hostGenerationRead !== 'function') fail('EXISTING_REPOSITORY_PORTS_REQUIRED');
  const rows = async (sql, values) => {
    const result = await query(sql, values);
    if (!Array.isArray(result?.rows)) fail('REPOSITORY_RESULT_REQUIRED');
    return result.rows;
  };
  async function readScope(input) {
    if (!roomId(input?.roomId) || Object.keys(input).some(key => key !== 'roomId')) fail('ROOM_SCOPE_IDS_ONLY');
    const records = await rows(EXISTING_REPOSITORY_SELECTS.scope, [input.roomId]);
    if (records.length !== 1) fail('ROOM_SCOPE_UNAVAILABLE');
    const record = records[0], expiresAtMs = Number(record.expiresAtMs);
    if (!id(record.sessionId) || !frame(record.controlRevision) || !Number.isFinite(expiresAtMs) || expiresAtMs <= now() || record.ownerEnabled !== true)
      fail('ROOM_SCOPE_UNAVAILABLE');
    return {...scopeFields(record), expiresAtMs};
  }
  async function readAttachments(input) {
    const keys = ['roomId', 'sessionId', 'controlRevision', 'submissionIds'];
    if (!input || Object.keys(input).some(key => !keys.includes(key)) || !id(input.sessionId) || !frame(input.controlRevision) ||
        !Array.isArray(input.submissionIds) || input.submissionIds.length > 100 || !input.submissionIds.every(id) ||
        new Set(input.submissionIds).size !== input.submissionIds.length) fail('ATTACHMENT_SCOPE_REQUIRED');
    const scope = await readScope({roomId: input.roomId});
    if (!scopeEqual(scope, input)) fail('ROOM_JOB_SCOPE_CHANGED');
    if (!input.submissionIds.length) return [];
    const records = await rows(EXISTING_REPOSITORY_SELECTS.attachments, [input.roomId, input.submissionIds]);
    if (records.length > 100 || records.some(record => record.roomId !== input.roomId || !id(record.operationId) ||
        record.operationId.length < 20 || !id(record.permitId) || record.permitId.length < 20 || !hash(record.sourceSha256) ||
        !input.submissionIds.includes(record.submissionId))) fail('AUTHORITATIVE_ATTACHMENTS_REQUIRED');
    if (!scopeEqual(await readScope({roomId: input.roomId}), scope)) fail('ROOM_JOB_SCOPE_CHANGED');
    return records.map(record => ({...record}));
  }
  async function readOperation(input) {
    if (!input || Object.keys(input).some(key => !['roomId', 'operationId', 'permitId'].includes(key)) || !roomId(input.roomId) ||
        !id(input.operationId) || input.operationId.length < 20 || input.permitId !== undefined && !id(input.permitId)) fail('OPERATION_REFERENCE_REQUIRED');
    const scope = await readScope({roomId: input.roomId});
    const records = await rows(EXISTING_REPOSITORY_SELECTS.operation,
    [input.operationId, input.roomId]);
    if (records.length !== 1 || input.permitId !== undefined && records[0].permitId !== input.permitId) fail('OPERATION_REFERENCE_REQUIRED');
    const metadata = records[0], operation = await hostGenerationRead({action: 'read', roomId: input.roomId, operationId: input.operationId});
    if (!scopeEqual(metadata,scope)||operation?.operationId !== input.operationId || operation.permit?.permitId !== metadata.permitId ||
        cueDigest(operation.permit) !== cueDigest({...metadata.permitDocument, permitId: metadata.permitId})) fail('AUTHORITATIVE_OPERATION_CHANGED');
    if (!scopeEqual(await readScope({roomId: input.roomId}), scope)) fail('ROOM_JOB_SCOPE_CHANGED');
    return {...scopeFields(metadata),
      permitId: metadata.permitId, revoked: metadata.revoked, expiresAtMs: Number(metadata.expiresAtMs), operation: structuredClone(operation)};
  }
  async function readPlaybackState(input) {
    if (!input || Object.keys(input).some(key => !['roomId', 'sessionId', 'controlRevision'].includes(key))) fail('PLAYBACK_SCOPE_REQUIRED');
    const scope = await readScope({roomId: input.roomId});
    if (input.sessionId !== undefined && !scopeEqual(scope, input)) fail('ROOM_JOB_SCOPE_CHANGED');
    const state = await hostGenerationRead({action: 'cueState', roomId: input.roomId});
    if (state?.roomId !== input.roomId || !Array.isArray(state.cues) || state.cues.length > 100 ||
        typeof state.pending !== 'boolean' || typeof state.stopped !== 'boolean') fail('AUTHORITATIVE_PLAYBACK_STATE_REQUIRED');
    if (!scopeEqual(await readScope({roomId: input.roomId}), scope)) fail('ROOM_JOB_SCOPE_CHANGED');
    return structuredClone(state);
  }
  async function readPermitScope(input) {
    if (!input || Object.keys(input).some(key => !['roomId', 'permitId'].includes(key)) || !roomId(input.roomId) ||
        !id(input.permitId) || input.permitId.length < 20) fail('PERMIT_REFERENCE_REQUIRED');
    const scope = await readScope({roomId: input.roomId});
    const records = await rows(EXISTING_REPOSITORY_SELECTS.permit,
    [input.permitId, input.roomId]);
    if (records.length !== 1 || records[0].permitId !== input.permitId || !scopeEqual(records[0], scope) ||
        typeof records[0].revoked !== 'boolean' || !Number.isFinite(Number(records[0].expiresAtMs)) ||
        !records[0].permitDocument || typeof records[0].permitDocument !== 'object' || Array.isArray(records[0].permitDocument))
      fail('AUTHORITATIVE_PERMIT_SCOPE_REQUIRED');
    if (!scopeEqual(await readScope({roomId: input.roomId}), scope)) fail('ROOM_JOB_SCOPE_CHANGED');
    const record = records[0];
    return {...scopeFields(record), permitId: record.permitId, revoked: record.revoked, expiresAtMs: Number(record.expiresAtMs),
      permitSha256: cueDigest({...record.permitDocument, permitId: record.permitId})};
  }
  async function readRoomRuntime(input) {
    const scope = await readScope({roomId: input.roomId});
    if (!scopeEqual(input, scope)) fail('ROOM_JOB_SCOPE_CHANGED');
    const records = await rows(EXISTING_REPOSITORY_SELECTS.runtime, [input.roomId]);
    if (records.length > 1 || records.length && (!records[0].runtime || typeof records[0].runtime !== 'object' ||
        !Array.isArray(records[0].runtime.acks) || records[0].runtime.acks.length > 100)) fail('AUTHORITATIVE_ROOM_RUNTIME_REQUIRED');
    if (!scopeEqual(await readScope({roomId: input.roomId}), scope)) fail('ROOM_JOB_SCOPE_CHANGED');
    return records.length ? structuredClone(records[0].runtime) : null;
  }
  return Object.freeze({readScope, readAttachments, readOperation, readPlaybackState, readPermitScope, readRoomRuntime,
    readPublishedPlaybackOperation:async input=>{const saved=await readOperation(input);
      // Generation expiry prevents new provider work, not already-published
      // playback. Revocation, fresh room scope and owner checks still apply.
      if(saved.revoked!==false)fail('PUBLISHED_PLAYBACK_OPERATION_REQUIRED');return saved.operation;},
    readAuthoritativeOperation: async input => (await readOperation(input)).operation});
}

// Current source/frame frontier is not present in the existing generation RPC.
// Require physical private assets plus a trusted authenticated-player observer.
// ACK audioTime is never converted into frames, and browser QC flags are absent.
export function createVerifiedCloudCurrentSourcePorts({repositoryPorts, readSourceRecord, readPlayerFrontier, assetStore,
  now = Date.now, maximumAgeMs = 5000, cacheVerifiedPublished = false} = {}) {
  if (typeof cacheVerifiedPublished !== 'boolean') fail('CURRENT_SOURCE_PORTS_REQUIRED');
  if (!repositoryPorts?.readScope || !repositoryPorts?.readPlaybackState || !repositoryPorts?.readAuthoritativeOperation || typeof readSourceRecord !== 'function' ||
      typeof readPlayerFrontier !== 'function' || !assetStore?.read || !assetStore?.verifySaved ||
      !Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1 || maximumAgeMs > 30000) fail('CURRENT_SOURCE_PORTS_REQUIRED');
  async function asset(assetId, expectedSha256) {
    const record = await assetStore.read(assetId), bytes = record?.bytes;
    if (!id(assetId) || !hash(expectedSha256) || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 32 * 1024 * 1024 ||
        record.assetId !== assetId || record.sha256 !== expectedSha256 || record.byteLength !== bytes.byteLength || sha(bytes) !== expectedSha256)
      fail('CURRENT_SOURCE_PRIVATE_ASSET_REQUIRED');
    const proof = await assetStore.verifySaved({binding: structuredClone(record.binding), asset: {assetId, sha256: expectedSha256}});
    if (proof?.privateSaved !== true || proof.checksumVerified !== true || proof.assetId !== assetId || proof.sha256 !== expectedSha256 ||
        cueDigest(proof.binding ?? null) !== cueDigest(record.binding ?? null)) fail('CURRENT_SOURCE_PRIVATE_ASSET_REQUIRED');
    return record;
  }
  // Immutable published evidence: private bytes, decoded context and profile
  // of one Cue's derived current source. It cannot change while the Cue
  // content and saved source record are unchanged, so in show mode only this
  // asset work is reused. The published operation (revocation, Stop, content,
  // lineage) and every live check (scope, Stop, credit, frontier) still run on
  // each read. Preload verifies READY Cues before any Start.
  const verifiedPublished = new Map();
  const contentOf = value => { const {status, playbackRevision, ...rest} = value ?? {}; return rest; };
  const readPublished = repositoryPorts.readPublishedPlaybackOperation ?? repositoryPorts.readAuthoritativeOperation;
  async function verifyPublished({roomId: publishedRoomId, cue, source}) {
    const key = cueDigest({roomId: publishedRoomId, cue: contentOf(cue), source});
    let operation;
    try { operation = await readPublished({roomId: publishedRoomId, operationId: cue.operationId}); }
    catch (error) { if (/^PUBLISHED_PLAYBACK_OPERATION_REQUIRED$/.test(error?.message)) fail('CURRENT_SOURCE_CONTEXT_PROFILE_REQUIRED_REVOKED'); throw error; }
    // Same conditions as before, reported with a bounded reason suffix so a
    // production hold names which evidence differed (no values are exposed).
    if (!hasVerifiedPersistedCloudCue({roomId: publishedRoomId, operation})) fail('CURRENT_SOURCE_CONTEXT_PROFILE_REQUIRED_CUE');
    if (operation.stopped === true) fail('CURRENT_SOURCE_CONTEXT_PROFILE_REQUIRED_STOPPED');
    // status/playbackRevision are runtime fields SQL rewrites on reserve/ACK/
    // Stop; they are checked above against the live playback and credit. The
    // published content (media, QC, bindings, timeline) must still match.
    if (cueDigest(contentOf(operation.cue)) !== cueDigest(contentOf(cue))) {
      // Name only the first differing top-level field (bounded key name, never a value).
      const keys = [...new Set([...Object.keys(operation.cue ?? {}), ...Object.keys(cue ?? {})])].filter(k => !['status', 'playbackRevision'].includes(k)).sort();
      const differing = keys.find(key => cueDigest(operation.cue?.[key] ?? null) !== cueDigest(cue?.[key] ?? null)) ?? 'UNKNOWN';
      fail('CURRENT_SOURCE_CUE_DIGEST_' + String(differing).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 40));
    }
    // Show mode reuses the asset evidence; strict mode re-reads and re-hashes on every read.
    let evidence = cacheVerifiedPublished && verifiedPublished.get(key);
    if (!evidence) {
      const [parent, context] = await Promise.all([asset(source.audioAssetId, source.music.sha256),
        asset(source.contextAssetId, source.music.contextSha256), asset(source.referenceAssetId, source.video.referenceSha256)]);
      const decoded = deriveVerifiedWave(parent);
      if (decoded.frames !== 24 * 44100) fail('CURRENT_SOURCE_CONTEXT_PROFILE_REQUIRED_FRAMES');
      if (decoded.contextSha256 !== source.music.contextSha256 || !Buffer.from(context.bytes).equals(decoded.contextBytes))
        fail('CURRENT_SOURCE_CONTEXT_PROFILE_REQUIRED_CONTEXT');
      if (source.music.profile?.method !== 'pcm-endpoint-profile-v1' || source.music.profile.assetSha256 !== source.music.sha256 ||
          source.music.profile.sampleRate !== 44100 || source.music.profile.channels !== 2 || source.music.profile.frameCount !== decoded.frames)
        fail('CURRENT_SOURCE_CONTEXT_PROFILE_REQUIRED_PROFILE');
      evidence = Object.freeze({frames: decoded.frames, binding: structuredClone(parent.binding ?? null), provenance: structuredClone(parent.provenance ?? null)});
    }
    if (cueDigest(evidence.binding) !== cueDigest(cue.music.binding)) fail('CURRENT_SOURCE_CONTEXT_PROFILE_REQUIRED_BINDING');
    const provenance = evidence.provenance;
    if (provenance?.kind !== 'provider' || operation?.operationId !== cue.operationId || operation.submissionId !== cue.submissionId ||
        operation.stages?.music?.state !== 'COMPLETE' || provenance.operationId !== cue.operationId ||
        provenance.requestId !== operation.stages.music.requestId || provenance.resultSha256 !== operation.stages.music.result?.resultSha256 ||
        !hash(provenance.resultSha256)) fail('CURRENT_SOURCE_CONTEXT_PROFILE_REQUIRED_LINEAGE');
    if (cacheVerifiedPublished && !verifiedPublished.has(key)) {
      while (verifiedPublished.size >= 8) verifiedPublished.delete(verifiedPublished.keys().next().value);
      verifiedPublished.set(key, evidence);
    }
    return {frames: evidence.frames};
  }
  async function readCurrentSource(input) {
    if (!input || Object.keys(input).some(key => key !== 'roomId') || !roomId(input.roomId)) fail('CURRENT_SOURCE_IDS_ONLY');
    const {roomId: scopedRoomId, sessionId, controlRevision} = await repositoryPorts.readScope(input);
    const scope = {roomId: scopedRoomId, sessionId, controlRevision};
    const playback = await repositoryPorts.readPlaybackState(scope), credit = playback.currentCredit;
    const record = await readSourceRecord(scopeFields(scope));
    const source = record?.source;
    if (!scopeEqual(record, scope) || record.kind !== 'saved-current-source-v1' || record.serverQC !== true ||
        !id(record.targetPlayerId) || !hash(record.qcEvidenceSha256) || !hash(record.sourceSha256) || !source ||
        cueDigest(cueSourceIdentity(source)) !== record.sourceSha256)
      fail('TRUSTED_CURRENT_SOURCE_RECORD_REQUIRED');
    // Older copies of the same Cue from replayed operations may remain; only the
    // sounding copy (PLAYING at the credited revision) can be current.
    const sounding = playback.cues.filter(item => item.cueId === credit?.cueId && item.status === 'PLAYING' &&
      item.playbackRevision === credit?.playbackRevision);
    if (sounding.length > 1) fail('MATCHING_ACTUAL_CURRENT_CUE_REQUIRED_AMBIGUOUS');
    const cue = sounding[0];
    // The initial owner bootstrap has no generation/cue ACK in this schema.
    // It deliberately holds until the host supplies an approved startup proof
    // adapter; this module neither invents such a receipt nor stores one.
    if (playback.stopped || credit?.actual !== true || credit.actualPlayback !== true || credit.roomId !== scope.roomId ||
        !cue || cue.status !== 'PLAYING' || cue.playbackRevision !== credit.playbackRevision || cue.generationId !== credit.generationId ||
        cue.submissionId !== credit.submissionId || cue.music?.asset?.assetId !== source.audioAssetId ||
        cue.music.asset.sha256 !== source.music?.sha256 || source.music.clipId !== source.audioAssetId ||
        cue.music.qc?.passed !== true || cue.music.actualGenerationThisRun !== true ||
        cue.music.binding?.roomId !== scope.roomId || cue.music.binding.generationId !== credit.generationId ||
        cue.music.binding.submissionId !== credit.submissionId || cue.music.binding.commonIntentSha256 !== cue.commonIntentSha256 ||
        cue.music.binding.controlVersion !== cue.controlVersion || cue.music.binding.channel !== 'music' ||
        source.music.control?.version !== cue.controlVersion || cueDigest(source.music.profile ?? null) !== cueDigest(cue.music.profile ?? null))
      fail('MATCHING_ACTUAL_CURRENT_CUE_REQUIRED');
    const decoded = await verifyPublished({roomId: scope.roomId, cue, source});
    const frontier = await readPlayerFrontier({...scopeFields(scope),
      cueId: cue.cueId, generationId: cue.generationId, assetId: source.audioAssetId, sha256: source.music.sha256,
      playbackRevision: credit.playbackRevision, targetPlayerId: record.targetPlayerId});
    if (!scopeEqual(frontier, scope) || frontier?.kind !== 'authenticated-player-frontier-v1' || frontier.targetPlayerId !== record.targetPlayerId ||
        frontier.cueId !== cue.cueId || frontier.generationId !== cue.generationId || frontier.assetId !== source.audioAssetId ||
        frontier.sha256 !== source.music.sha256 || frontier.playbackRevision !== credit.playbackRevision ||
        frontier.actual !== true || frontier.audioStarted !== true || frontier.videoPresented !== true || frontier.simulated === true ||
        !frame(frontier.playedUntilFrame) || frontier.playedUntilFrame >= decoded.frames || !Number.isFinite(frontier.observedAtMs) ||
        frontier.observedAtMs > now() || now() - frontier.observedAtMs > maximumAgeMs || !hash(frontier.observationSha256))
      fail('AUTHENTICATED_PLAYER_FRONTIER_REQUIRED');
    const latest = await repositoryPorts.readPlaybackState(scope), latestScope = await repositoryPorts.readScope(input);
    const latestRecord = await readSourceRecord(scope);
    if (!scopeEqual(latestScope, scope) || latest.stopped || cueDigest(latest.currentCredit ?? null) !== cueDigest(credit))
      fail('CURRENT_SOURCE_CHANGED');
    if (cueDigest(latestRecord ?? null) !== cueDigest(record)) fail('CURRENT_SOURCE_CHANGED');
    return {...structuredClone(source), playback: {phase: 'PLAYING', revision: frontier.playbackRevision,
      playedUntilFrame: frontier.playedUntilFrame, actual: true}};
  }
  async function preverifyPublishedSource({roomId: publishedRoomId, cue, source} = {}) {
    if (!roomId(publishedRoomId) || cue?.roomId !== publishedRoomId || !['READY', 'SELECTED', 'PLAYING', 'PLAYED'].includes(cue.status) ||
        cue.music?.asset?.assetId !== source?.audioAssetId || cue.music.asset.sha256 !== source?.music?.sha256 ||
        cueDigest(source.music.profile ?? null) !== cueDigest(cue.music.profile ?? null)) fail('PUBLISHED_SOURCE_PREVERIFY_REQUIRED');
    await verifyPublished({roomId: publishedRoomId, cue, source});
    return {preverified: true, cueId: cue.cueId};
  }
  return Object.freeze({readCurrentSource, preverifyPublishedSource, readCurrent: async value => {
    const source = await readCurrentSource(typeof value === 'string' ? {roomId: value} : value);
    return {actual: true, clipId: source.music.clipId, sha256: source.music.sha256, contextSha256: source.music.contextSha256,
      profile: structuredClone(source.music.profile), playbackRevision: source.playback.revision, playedUntilFrame: source.playback.playedUntilFrame};
  }});
}
