import {DispatchError, validatePermit} from '../generation/dispatch.mjs';
import {cueDigest, cueSourceIdentity, validateCueSource} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {verifiedBootstrapContext,isBootstrapPreparationSource} from '../generation/bootstrap-source-contract.mjs';

const fail = code => { throw new DispatchError(code); };
const nonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const scopeFields = value => { const {roomId, sessionId, controlRevision} = value; return {roomId, sessionId, controlRevision}; };
const sameScope = (a, b) => a?.roomId === b?.roomId && Object.is(a?.sessionId, b?.sessionId) && a?.controlRevision === b?.controlRevision;
const phases = new Set(['begin-before', 'begin-after', 'submit-before-claim', 'submit-after-claim', 'submit-before-provider',
  'initial-intent-before','initial-intent-after',
  'submit-after-provider', 'poll-before-status', 'poll-after-status', 'poll-before-result', 'poll-after-result', 'poll-before-complete',
  'credentials-before-begin', 'credentials-before-stage', 'advance-before', 'qc-before-prepare', 'qc-after-prepare',
  'qc-before-inspect', 'qc-after-inspect', 'qc-before-publish', 'qc-after-publish']);
const beforeBegin = new Set(['begin-before', 'credentials-before-begin']);

// This port is mounted by an approved server host only. The existing owner RPC
// authenticates reads; SELECT metadata proves permit epoch/control. Source bytes
// and actual/frame truth are the injected verified reader's responsibility.
// Checks bound remote POST/SQL races; they do not create cross-service atomicity.
export function createDispatchAuthority({enabled = false, repository, readScope, readPermitScope, readCurrentSource,
  readPreparationSource,mediaHost, now = Date.now} = {}) {
  if (!repository?.request || ![readScope, readPermitScope, readCurrentSource].every(value => typeof value === 'function'))
    fail('DISPATCH_AUTHORITY_PORTS_REQUIRED');
  const active = () => { if (enabled !== true) fail('DISPATCH_AUTHORITY_NOT_ACTIVATED'); };
  async function scoped(roomId) {
    const scope = await readScope({roomId});
    if (scope?.roomId !== roomId || !id(scope.sessionId) || !integer(scope.controlRevision) || scope.closed === true ||
        !Number.isFinite(scope.expiresAtMs) || scope.expiresAtMs <= now()) fail('DISPATCH_AUTHORITY_SCOPE_CHANGED');
    return scopeFields(scope);
  }
  function sourceMatches(source, permit) {
    const expected = permit.source;
    validateCueSource(source);
    const preparation=isBootstrapPreparationSource(expected);
    if ((preparation?!isBootstrapPreparationSource(source):source.playback?.actual !== true || source.playback.phase !== 'PLAYING') || !integer(source.playback.revision) || !integer(expected.playback?.revision) ||
        source.playback.revision !== expected.playback.revision || !integer(source.playback.playedUntilFrame) ||
        source.playback.playedUntilFrame >= 24 * 44100 || cueDigest(cueSourceIdentity(source)) !== permit.sourceSha256 ||
        !hash(source.music.sha256) || source.music.sha256 !== expected.music.sha256 ||
        cueDigest(source.music.profile ?? null) !== cueDigest(expected.music.profile ?? null) ||
        cueDigest(source.music.control) !== cueDigest(expected.music.control) || source.quality.fixedBpm !== expected.quality.fixedBpm ||
        ['audioAssetId', 'contextAssetId', 'referenceAssetId'].some(key => !id(source[key]) || source[key] !== expected[key]) ||
        permit.assets.context.providerOriginVerified !== true &&
          !verifiedBootstrapContext(permit.assets.context, source, {now, expiresAtMs:permit.expiresAtMs}))
      fail('DISPATCH_AUTHORITY_SOURCE_CHANGED');
    return cueDigest({identity: cueSourceIdentity(source), sha256: source.music.sha256, profile: source.music.profile ?? null,
      control: source.music.control, fixedBpm: source.quality.fixedBpm, playbackRevision: source.playback.revision,
      audioAssetId: source.audioAssetId, contextAssetId: source.contextAssetId, referenceAssetId: source.referenceAssetId});
  }
  async function facts(input) {
    const scope = await scoped(input.roomId);
    let operation = null, permitId = input.permitId;
    if (!beforeBegin.has(input.phase)) {
      operation = await repository.request('read', input.roomId, input.ownerCapability, {operationId: input.operationId});
      if (operation?.operationId !== input.operationId || operation.stopped === true || operation.dispatchAllowed !== true ||
          !nonce(operation.permit?.permitId) || permitId !== undefined && operation.permit.permitId !== permitId)
        fail('DISPATCH_AUTHORITY_OPERATION_CHANGED');
      permitId = operation.permit.permitId;
    }
    if (!nonce(permitId)) fail('DISPATCH_AUTHORITY_PERMIT_REQUIRED');
    const permit = validatePermit(await repository.request('permit', input.roomId, input.ownerCapability, {permitId}), {now, mediaHost});
    if (permit.assets.context.providerOriginVerified !== true &&
        !verifiedBootstrapContext(permit.assets.context, permit.source, {now, expiresAtMs:permit.expiresAtMs, scope}))
      fail('DISPATCH_AUTHORITY_SOURCE_CHANGED');
    if (operation && cueDigest(operation.permit) !== cueDigest(permit)) fail('DISPATCH_AUTHORITY_PERMIT_CHANGED');
    const metadata = await readPermitScope({roomId: input.roomId, permitId});
    if (!sameScope(metadata, scope) || metadata.permitId !== permitId || metadata.revoked !== false ||
        !Number.isFinite(metadata.expiresAtMs) || metadata.expiresAtMs <= now() || metadata.permitSha256 !== cueDigest(permit))
      fail('DISPATCH_AUTHORITY_PERMIT_CHANGED');
    const playback = await repository.request('cueState', input.roomId, input.ownerCapability, {});
    if (playback?.roomId !== input.roomId || playback.stopped !== false) fail('DISPATCH_AUTHORITY_GLOBAL_STOP');
    if (!sameScope(await scoped(input.roomId), scope)) fail('DISPATCH_AUTHORITY_SCOPE_CHANGED');
    return {scope, permit, fingerprint: cueDigest({scope, permit, stopped: operation?.stopped ?? false})};
  }
  async function assert(input) {
    active();
    if (!input || Object.keys(input).some(key => !['roomId', 'ownerCapability', 'operationId', 'permitId', 'phase'].includes(key)) ||
        !/^[a-f0-9-]{36}$/i.test(input.roomId ?? '') || !hash(input.ownerCapability) || !nonce(input.operationId) || !phases.has(input.phase))
      fail('DISPATCH_AUTHORITY_SERVER_INPUT_REQUIRED');
    const first = await facts(input), preparation=isBootstrapPreparationSource(first.permit.source);
    const readSource=preparation?readPreparationSource:readCurrentSource;
    if(typeof readSource!=='function')fail('DISPATCH_AUTHORITY_SOURCE_CHANGED');
    const source = await readSource({roomId: input.roomId});
    const sourceFingerprint = sourceMatches(source, first.permit), second = await facts(input);
    if (second.fingerprint !== first.fingerprint) fail('DISPATCH_AUTHORITY_SCOPE_CHANGED');
    if (sourceMatches(await readSource({roomId: input.roomId}), second.permit) !== sourceFingerprint)
      fail('DISPATCH_AUTHORITY_SOURCE_CHANGED');
    if ((await facts(input)).fingerprint !== first.fingerprint) fail('DISPATCH_AUTHORITY_SCOPE_CHANGED');
    return Object.freeze({kind: 'cloud-dispatch-authority-v1', roomId: input.roomId, operationId: input.operationId,
      permitId: first.permit.permitId, phase: input.phase, sourceSha256: first.permit.sourceSha256,
      sourcePlaybackRevision: source.playback.revision, ...first.scope});
  }
  return Object.freeze({assert});
}
