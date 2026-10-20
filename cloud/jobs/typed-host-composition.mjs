import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest, cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {createExistingCloudRepositoryReadPorts, createVerifiedCloudCurrentSourcePorts} from './repository-read-ports.mjs';
import {createSourceStartReceiptAdapter} from './source-start-receipts.mjs';
import {createAcknowledgedCurrentSourceSnapshot} from './current-source-snapshot.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const frame = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => keys.includes(key));
const fail = code => {throw new DispatchError(code);};
// sessionId identifies an anonymous persisted room epoch, never an Auth session.
const scoped = value => {const {roomId, sessionId, controlRevision} = value; return {roomId, sessionId, controlRevision};};
const sameScope = (a, b) => a?.roomId === b?.roomId && Object.is(a?.sessionId, b?.sessionId) && a?.controlRevision === b?.controlRevision;
const ackFields = ['kind', 'graphEpoch', 'sourceClipId', 'sourceSha256', 'sourceContextSha256', 'sourcePlaybackRevision',
  'sampleRate', 'playedUntilFrame', 'processedWindowSha256', 'actual', 'audioStarted', 'participantCredit'];
const reply = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

/** Server-only assembly of existing private dependencies, not a runtime mount.
 * Owner authorization/proofs remain in the approved host RPC closure. Selected
 * graph/target and authenticated observers are injected trusted host readers,
 * never browser-selected JSON. Private bytes, source records and source-start
 * receipts use the existing store; no default transport or persistence is made.
 * Real selected-player/observer transport has not been verified by this factory.
 */
export function createTypedCloudHostComposition(options = {}) {
  const keys = ['enabled', 'roomId', 'query', 'hostGenerationRead', 'authorizeOwner', 'privateStore', 'authorities', 'now', 'maximumAgeMs', 'origin', 'allowStoppedRestart', 'onHold','cachePreparedMaterial','showMode'];
  if (!exact(options, keys)) fail('TYPED_HOST_CONFIG_REQUIRED');
  const {enabled = false, roomId, query, hostGenerationRead, authorizeOwner, privateStore, authorities,
    now = Date.now, maximumAgeMs = 5000, origin = 'https://ai-vdj.vercel.app', allowStoppedRestart = false, onHold = () => {},cachePreparedMaterial=false,showMode=false} = options;
  const authorityKeys = ['readStartAuthority', 'readGraphAuthority', 'readPriorStopReceipt', 'verifyContinuation',
    'readSourceFrontier', 'readSelectedTarget', 'readCurrentFrontier', 'readSourceStartState','readPlaybackSnapshot','readAcknowledgedSourceFrontier'];
  if (typeof enabled !== 'boolean' || typeof allowStoppedRestart !== 'boolean' || !uuid(roomId) || ![query, hostGenerationRead, authorizeOwner, now].every(f => typeof f === 'function') ||
      !exact(authorities, authorityKeys) || !['readStartAuthority', 'readGraphAuthority', 'readSourceFrontier', 'readSelectedTarget', 'readCurrentFrontier']
        .every(key => typeof authorities[key] === 'function') ||
      ['readPriorStopReceipt', 'verifyContinuation','readSourceStartState','readPlaybackSnapshot','readAcknowledgedSourceFrontier'].some(key => authorities[key] !== undefined && typeof authorities[key] !== 'function') ||
      !Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1 || maximumAgeMs > 30000 ||
      !['read', 'save', 'verifySaved'].every(key => typeof privateStore?.assetStore?.[key] === 'function') ||
      !['read', 'save'].every(key => typeof privateStore?.sourceStore?.[key] === 'function') ||
      !['read', 'saveImmutable'].every(key => typeof privateStore?.sourceStartReceiptStore?.[key] === 'function'))
    fail('TYPED_HOST_PORTS_REQUIRED');
  let base; try {base = new URL(origin);} catch {fail('TYPED_HOST_ORIGIN_REQUIRED');}
  if (base.protocol !== 'https:' || base.origin !== origin || base.username || base.password) fail('TYPED_HOST_ORIGIN_REQUIRED');
  let closed = false;
  const clock = () => {const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail('TYPED_HOST_CLOCK_REQUIRED'); return value;};
  const active = () => {if (!enabled || closed) fail(closed ? 'TYPED_HOST_CLOSED' : 'TYPED_HOST_NOT_ACTIVATED'); clock();};
  const bound = input => {if (!exact(input, ['roomId']) || input.roomId !== roomId) fail('TYPED_HOST_ROOM_IDS_ONLY');};
  const boundAuthority = fn => async input => {
    active(); if (input?.roomId !== roomId) fail('TYPED_HOST_ROOM_IDS_ONLY');
    const result = await fn(structuredClone(input)); active(); return result;
  };
  const repositoryPorts = createExistingCloudRepositoryReadPorts({query, hostGenerationRead, now: clock});
  const ownerAuthority = async input => {
    active(); let accepted;
    try {accepted = await authorizeOwner(structuredClone(input));} catch {fail('OWNER_DENIED');}
    active(); return accepted === true;
  };
  const initial = createSourceStartReceiptAdapter({enabled, now: clock, maximumAgeMs, allowStoppedRestart, showMode, authorizeOwner: ownerAuthority,
    readStartState:authorities.readSourceStartState&&boundAuthority(authorities.readSourceStartState),
    readAcknowledgedFrontier:authorities.readAcknowledgedSourceFrontier&&boundAuthority(authorities.readAcknowledgedSourceFrontier),
    readScope: repositoryPorts.readScope, readPlaybackState: repositoryPorts.readPlaybackState,
    readStartAuthority: boundAuthority(authorities.readStartAuthority), readGraphAuthority: boundAuthority(authorities.readGraphAuthority),
    readPriorStopReceipt: authorities.readPriorStopReceipt && boundAuthority(authorities.readPriorStopReceipt),
    verifyContinuation: authorities.verifyContinuation && (async input => {
      active(); if (input?.scope?.roomId !== roomId) fail('TYPED_HOST_ROOM_IDS_ONLY');
      const result = await authorities.verifyContinuation(structuredClone(input)); active(); return result;
    }),
    readPlayerFrontier: boundAuthority(authorities.readSourceFrontier), assetStore: privateStore.assetStore,
    receiptStore: privateStore.sourceStartReceiptStore});
  const snapshot = createAcknowledgedCurrentSourceSnapshot({enabled, now: clock, repositoryPorts,
    cachePreparedMaterial,
    assetStore: privateStore.assetStore, sourceStore: privateStore.sourceStore,
    readSelectedTarget: boundAuthority(authorities.readSelectedTarget)});
  const generated = createVerifiedCloudCurrentSourcePorts({repositoryPorts, now: clock, maximumAgeMs, cacheVerifiedPublished: showMode,
    assetStore: privateStore.assetStore, readSourceRecord: snapshot.readSourceRecord,
    readPlayerFrontier: boundAuthority(authorities.readCurrentFrontier)});
  async function scope(input) {
    bound(input); const value = await repositoryPorts.readScope(input);
    if (value.closed === true || value.expiresAtMs <= clock()) fail('TYPED_HOST_SCOPE_CHANGED'); return value;
  }
  async function markSourceStarted(input) {
    active(); if (!exact(input, ['roomId', 'ownerCapability', 'ack']) || input.roomId !== roomId || !hash(input.ownerCapability) ||
        !exact(input.ack, ackFields)) fail('TYPED_SOURCE_ACK_REQUIRED');
    const result = await initial.markSourceStarted(input); active();
    if (result.accepted !== true || result.sourceOnly !== true || result.participantCredit !== false || !frame(result.graphEpoch) || result.graphEpoch < 1 ||
        !hash(result.sourceSha256) || !frame(result.sourcePlaybackRevision) || !hash(result.receiptSha256)) fail('TYPED_SOURCE_ACK_HOLD');
    return {accepted: true, duplicate: result.duplicate === true, sourceOnly: true, participantCredit: false,
      graphEpoch: result.graphEpoch, sourceSha256: result.sourceSha256,
      sourcePlaybackRevision: result.sourcePlaybackRevision, receiptSha256: result.receiptSha256};
  }
  async function readCurrentSource(input) {
    active();bound(input);
    // A completed initial ACK has immutable verified source bytes. Its reader
    // already performs a fresh owner/Stop/graph/current/physical frontier read.
    // Avoid a separate routing query before that same live read. If CURRENT
    // advanced, only an independent fresh CURRENT snapshot may change routes;
    // an initial-source failure is never hidden by another initial fallback.
    let acknowledgedError;
    try {const source=await initial.readAcknowledgedCurrentSource(input,{requirePlaying:true});
      active();if(source)return source;}catch(error){acknowledgedError=error;}
    const readSnapshot=async()=>{
      if(!authorities.readPlaybackSnapshot){const value=await scope(input);return {scope:value,playback:await repositoryPorts.readPlaybackState(scoped(value))};}
      const value=await boundAuthority(authorities.readPlaybackSnapshot)(input);active();
      if(!value?.scope||value.scope.roomId!==roomId||typeof value.scope.sessionId!=='string'||
        !frame(value.scope.controlRevision)||!Number.isFinite(value.scope.expiresAtMs)||value.scope.expiresAtMs<=clock()||
        value.playback?.roomId!==roomId||typeof value.playback.stopped!=='boolean'||!Object.hasOwn(value.playback,'currentCredit'))fail('TYPED_HOST_SCOPE_CHANGED');
      return value;
    };
    const before=await readSnapshot(),first=before.scope,state=before.playback;
    if (state.stopped !== false) fail('TYPED_HOST_PLAYBACK_STOPPED');
    let source;
    if (state.currentCredit === null) {
      if(acknowledgedError)throw acknowledgedError;
      // This reader already brackets physical/receipt/frontier work with fresh
      // graph/scope/current checks. Require stopped=false at both boundaries;
      // an additional outer scope/playback bracket repeats the same network IO.
      source=await initial.readInitialCurrentSource(input,{requirePlaying:true});active();return source;
    }
    else {
      if (state.currentCredit?.actual !== true || state.currentCredit.actualPlayback !== true) fail('TYPED_HOST_CURRENT_CREDIT_REQUIRED');
      // Never mask generated-source/target/observer failures by replaying an old
      // bootstrap receipt once a current Cue credit exists.
      source = await generated.readCurrentSource(input);
    }
    const after=await readSnapshot(),latest=after.scope,current=after.playback;active();
    if (!sameScope(first, latest) || first.expiresAtMs !== latest.expiresAtMs || current.stopped !== false ||
        cueDigest(current.currentCredit) !== cueDigest(state.currentCredit)) fail('TYPED_HOST_SOURCE_CHANGED');
    return source;
  }
  async function prepareCurrentSource(input) {
    active(); bound(input); const result = await snapshot.prepareCurrentSource(input); active(); return result;
  }
  // This method returns private material solely to the trusted server worker.
  // It is deliberately absent from the HTTP route and browser capability DTO.
  async function readSourceRecord(input) {
    active(); if (!exact(input, ['roomId', 'sessionId', 'controlRevision']) || input.roomId !== roomId ||
        typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.sessionId) || !frame(input.controlRevision))
      fail('TYPED_HOST_SCOPE_CHANGED');
    const first = await scope({roomId}), result = await snapshot.readSourceRecord(input), latest = await scope({roomId}); active();
    if (!sameScope(input, first) || !sameScope(first, latest) || first.expiresAtMs !== latest.expiresAtMs ||
        !sameScope(result, latest) || result.kind !== 'saved-current-source-v1' || result.serverQC !== true ||
        !hash(result.qcEvidenceSha256) || !hash(result.sourceSha256) || !result.source ||
        cueDigest(cueSourceIdentity(result.source)) !== result.sourceSha256) fail('TYPED_HOST_SCOPE_CHANGED');
    return result;
  }
  async function handleRequest(request) {
    const path = new URL(request.url).pathname;
    const match = path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/source\/ack$/i); if (!match) return null;
    if (match[1] !== roomId || request.headers.get('origin') !== origin || !hash(request.headers.get('x-room-owner')) ||
        request.headers.has('authorization') || request.headers.has('x-fal-key') || request.headers.has('x-api-key'))
      return reply({error: 'OWNER_OR_ORIGIN_DENIED'}, 403);
    if (request.method !== 'POST') return reply({error: 'POST_REQUIRED'}, 405);
    if (!enabled || closed) return reply({error: closed ? 'TYPED_HOST_CLOSED' : 'TYPED_HOST_NOT_ACTIVATED'}, 503);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return reply({error: 'JSON_REQUIRED'}, 415);
    try {
      const reader = request.body?.getReader(), chunks = []; let length = 0;
      if (reader) while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength; if (length > 4096) {await reader.cancel(); fail('BODY_TOO_LARGE');}
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length); let offset = 0; for (const part of chunks) {bytes.set(part, offset); offset += part.byteLength;}
      let body; try {body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {return reply({error: 'BODY_INVALID'}, 400);}
      if (!exact(body, ['ack']) || !exact(body.ack, ackFields)) return reply({error: 'TYPED_SOURCE_ACK_REQUIRED'}, 400);
      return reply(await markSourceStarted({roomId, ownerCapability: request.headers.get('x-room-owner'), ack: body.ack}));
    } catch (error) {
      if (typeof onHold === 'function' && /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '')) try {onHold(error.code);} catch {}
      const safeCodes = ['BODY_TOO_LARGE', 'OWNER_DENIED', 'TYPED_HOST_CLOSED', 'TYPED_HOST_NOT_ACTIVATED', 'TYPED_HOST_CLOCK_REQUIRED'];
      const code = error instanceof DispatchError && safeCodes.includes(error.code) ? error.code : 'TYPED_SOURCE_ACK_HOLD';
      return reply({error: code}, code === 'BODY_TOO_LARGE' ? 413 : code === 'OWNER_DENIED' ? 403 : 409);
    }
  }
  return Object.freeze({markSourceStarted, prepareCurrentSource, readSourceRecord, readCurrentSource, handleRequest,
    preparePublishedSource:async input=>{active();if(input?.roomId!==roomId)fail('TYPED_HOST_ROOM_IDS_ONLY');
      const result=await snapshot.preparePublishedSource(input);active();return result;},
    // Verifies a READY Cue's immutable current-source evidence before Start so
    // its later reservation/check reads only live state.
    preverifyPublishedSource:async input=>{active();if(input?.roomId!==roomId)fail('TYPED_HOST_ROOM_IDS_ONLY');
      const result=await generated.preverifyPublishedSource(structuredClone(input));active();return result;},
    readStartupCurrent: async input => {
      active(); bound(input); const source = await initial.readInitialCurrentSource(input); active();
      return {actual: true, clipId: source.music.clipId, sha256: source.music.sha256, contextSha256: source.music.contextSha256,
        profile: structuredClone(source.music.profile), playbackRevision: source.playback.revision, playedUntilFrame: source.playback.playedUntilFrame};
    },
    readCurrent: async value => {
      const source = await readCurrentSource(typeof value === 'string' ? {roomId: value} : value);
      return {actual: true, clipId: source.music.clipId, sha256: source.music.sha256, contextSha256: source.music.contextSha256,
        profile: structuredClone(source.music.profile), playbackRevision: source.playback.revision, playedUntilFrame: source.playback.playedUntilFrame};
    }, close() {closed = true;}, capabilities: () => ({typedSourceHost: enabled && !closed, defaultActivation: false,
      actualObserverTransportVerified: false, credentialPersistence: false, durableScheduler: false})});
}
