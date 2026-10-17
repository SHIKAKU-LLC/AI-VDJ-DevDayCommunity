import {DispatchError} from '../generation/dispatch.mjs';
export {PLAYER_OBSERVER_SQL} from './repository-statements.mjs';
import {PLAYER_OBSERVER_SQL} from './repository-statements.mjs';
const fail = code => {throw new DispatchError(code);};
const stores=new WeakSet();
export const isPlayerObserverSqlStore=store=>stores.has(store);
// query is a server-only read/write transaction. Never a REST-exposed schema.
export function createPlayerObserverStore({query, withOwnerAuthorization} = {}) {
  if (typeof query !== 'function' || typeof withOwnerAuthorization !== 'function') fail('OBSERVER_STORE_REQUIRED');
  async function call(scope, action, version, record, sourceState=false) {
    let pending, used = false, finished = false, invalid = false;
    try {
      await withOwnerAuthorization(scope, context => {
        if (used || finished) {invalid = true; fail('OBSERVER_OWNER_CONTEXT_REQUIRED');}
        used = true;
        if (!context || Object.keys(context).some(k => !['roomId','sessionId','controlRevision','ownerCapability'].includes(k)) ||
            ['roomId','sessionId','controlRevision'].some(k => context[k] !== scope[k]) || !/^[a-f0-9]{64}$/.test(context.ownerCapability ?? ''))
          fail('OBSERVER_OWNER_CONTEXT_REQUIRED');
        pending = query(PLAYER_OBSERVER_SQL, [action, scope.roomId, context.ownerCapability, scope.sessionId, scope.controlRevision, version,
          record ? JSON.stringify(record) : null]);
        return pending;
      });
      finished = true;
      if (!used || invalid || !pending) fail('OBSERVER_OWNER_CONTEXT_REQUIRED');
      const result = await pending, value = result?.rows?.[0]?.value;
      if (result?.rows?.length !== 1 || !Number.isSafeInteger(value?.version) || value.version < 0) fail('OBSERVER_STORE_HOLD');
      if(sourceState){
        const s=value.scope,p=value.playback;
        if(!s||['roomId','sessionId','controlRevision'].some(k=>s[k]!==scope[k])||
          !Number.isFinite(Number(s.expiresAtMs))||!p||p.roomId!==scope.roomId||typeof p.stopped!=='boolean'||
          !Object.hasOwn(p,'currentCredit'))fail('OBSERVER_STORE_HOLD');
        const f=value.stateFence;
        if(f!==undefined&&(!f||Object.keys(f).some(k=>!['scopeExpiresAtMs','playbackSha256','runtimeSha256'].includes(k))||
          f.scopeExpiresAtMs!==Number(s.expiresAtMs)||!['playbackSha256','runtimeSha256'].every(k=>/^[a-f0-9]{64}$/.test(f[k]??''))))fail('OBSERVER_STORE_HOLD');
        return structuredClone({...value,scope:{...s,expiresAtMs:Number(s.expiresAtMs)}});
      }
      const {scope:ignoredScope,playback:ignoredPlayback,runtime:ignoredRuntime,stateFence:ignoredFence,...saved}=value;
      return structuredClone(saved);
    } catch {finished = true; await pending?.catch?.(() => {}); fail('OBSERVER_STORE_HOLD');}
  }
  async function observationState(scope){
    const value=await call(scope,'read',null,null,true),p=value.playback,r=value.runtime;
    if(!Array.isArray(p.cues)||p.cues.length>100||typeof p.pending!=='boolean'||!Object.hasOwn(value,'runtime')||
      r!==null&&(!r||typeof r!=='object'||Array.isArray(r)||!Array.isArray(r.acks)||r.acks.length>100))fail('OBSERVER_STORE_HOLD');
    return value;
  }
  const store=Object.freeze({read: scope => call(scope,'read',null,null),
    readSourceState: scope => call(scope,'read',null,null,true),
    readSourceStartReceipt:async reference=>(await call({roomId:reference.roomId,['sessionId']:reference.sessionId,controlRevision:reference.controlRevision},
      'sourceReceiptRead',null,{targetPlayerId:reference.targetPlayerId,graphEpoch:reference.graphEpoch})).record,
    putSourceStartReceipt:(reference,record)=>call({roomId:reference.roomId,['sessionId']:reference.sessionId,controlRevision:reference.controlRevision},
      'sourceReceiptPut',null,record),
    readObservationState: observationState,
    readPlaybackSnapshot: async scope => {const value=await observationState(scope);return {scope:value.scope,playback:value.playback,runtime:value.runtime};},
    compareAndSwapObserved: (scope,version,record,fence) => call(scope,'cas',version,{...record,__observationFence:fence}),
    compareAndSwap: (scope, version, record) => call(scope,'cas',version,record)});
  stores.add(store);return store;
}
