import {cueDigest, cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {DispatchError} from '../generation/dispatch.mjs';

// Server-only physical admission. The source may be prepared without playing;
// owner, room deadline, epoch/control and explicit Stop remain authoritative.
export function createBootstrapPreparationReader({roomId, readScope, readPlaybackState, readBootstrapAuthority, now = Date.now}) {
  const fail = () => {throw new DispatchError('GENERATION_PREPARATION_HOLD');};
  const scopeKey = s => cueDigest([s.roomId, s.sessionId, s.controlRevision, s.expiresAtMs]);
  async function state() {
    const scope = await readScope({roomId}), playback = await readPlaybackState({roomId});
    if (scope.roomId !== roomId || scope.closed === true || scope.expiresAtMs <= now() || playback.stopped !== false) fail();
    return scope;
  }
  return async ({roomId: requested}) => {
    if (requested !== roomId) fail();
    const before = await state(), selected = await readBootstrapAuthority(before), source = selected?.source;
    if (selected?.kind !== 'server-selected-source-start-v1' || selected.mode !== 'bootstrap' || selected.serverQC !== true ||
        ['roomId', 'sessionId', 'controlRevision'].some(k => selected[k] !== before[k]) ||
        source?.playback?.actual !== false || source.playback.revision !== 0 ||
        selected.sourceSha256 !== cueDigest(cueSourceIdentity(source))) fail();
    if (scopeKey(before) !== scopeKey(await state())) fail();
    return {...structuredClone(source), playback: {actual: false, phase: 'PREPARING', revision: 0, playedUntilFrame: 0}};
  };
}
