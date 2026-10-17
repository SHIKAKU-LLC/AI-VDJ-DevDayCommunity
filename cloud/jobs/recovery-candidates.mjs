import {DispatchError} from '../generation/dispatch.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => {throw new DispatchError(code);};
const scopeEqual = (a, b) => a?.roomId === b?.roomId && Object.is(a.sessionId, b.sessionId) && a.controlRevision === b.controlRevision;
const fields = ['roomId', 'operationId', 'permitId', 'sessionId', 'controlRevision'];

// Candidate discovery only. No operation documents, proofs, private URLs or
// credentials are projected. The first roomRuntime anchor uses the same
// predicate/first-row choice as cue-operations.sql; ambiguous anchors hold.
export {RECOVERY_CANDIDATE_SELECT} from './repository-statements.mjs';
import {RECOVERY_CANDIDATE_SELECT} from './repository-statements.mjs';

/** Private host read port, not an HTTP API, runner or durable scheduler.
 * The approved host selects/authenticates the room scope before invoking this
 * port. query/readScope are injected existing server dependencies. A returned
 * COMPLETE result objects (including {}) establish ledger shape only, never
 * media quality, valid intent semantics, READY or provider execution authority.
 * An ID is only a discovery hint: fresh authenticated source/stop/permit guards
 * remain mandatory at each actual execution step, outside this module.
 */
export function createRecoveryCandidateReadPort({enabled = false, query, readScope, now = Date.now} = {}) {
  if (typeof enabled !== 'boolean' || typeof query !== 'function' || typeof readScope !== 'function' || typeof now !== 'function')
    fail('RECOVERY_READ_PORTS_REQUIRED');
  function scopeValid(scope) {
    return uuid(scope?.roomId) && uuid(scope.sessionId) && revision(scope.controlRevision) &&
      scope.closed !== true && Number.isFinite(scope.expiresAtMs) && scope.expiresAtMs > now();
  }
  async function scanIds(input) {
    if (!enabled) fail('RECOVERY_CANDIDATES_NOT_ACTIVATED');
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        !['roomId', 'sessionId', 'controlRevision'].every(key => Object.hasOwn(input, key)) ||
        Object.keys(input).some(key => !['roomId', 'sessionId', 'controlRevision', 'afterOperationId', 'limit'].includes(key)) ||
        !uuid(input.roomId) || !uuid(input.sessionId) || !revision(input.controlRevision) ||
        input.afterOperationId !== undefined && !id(input.afterOperationId) ||
        input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20))
      fail('RECOVERY_SCOPED_IDS_REQUIRED');
    const limit = input.limit ?? 20, after = input.afterOperationId ?? null;
    const before = await readScope({roomId: input.roomId});
    if (!scopeValid(before) || !scopeEqual(before, input)) fail('RECOVERY_SCOPE_CHANGED');
    const timestamp = now(); if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail('RECOVERY_CLOCK_REQUIRED');
    let result;
    try {result = await query(RECOVERY_CANDIDATE_SELECT, [input.roomId, input.sessionId, input.controlRevision, timestamp, after, limit + 1]);}
    catch {fail('RECOVERY_QUERY_HOLD');}
    if (!Array.isArray(result?.rows) || result.rows.length > limit + 1) fail('RECOVERY_CANDIDATE_ROWS_REQUIRED');
    let last = after;
    for (const record of result.rows) {
      if (!record || Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key)) ||
          !scopeEqual(record, before) || !id(record.operationId) || !id(record.permitId) ||
          last !== null && record.operationId <= last) fail('RECOVERY_CANDIDATE_ROWS_REQUIRED');
      last = record.operationId;
    }
    const latest = await readScope({roomId: input.roomId});
    if (!scopeValid(latest) || !scopeEqual(latest, before) || latest.expiresAtMs !== before.expiresAtMs)
      fail('RECOVERY_SCOPE_CHANGED');
    const candidates = result.rows.slice(0, limit).map(record => Object.fromEntries(fields.map(key => [key, record[key]])));
    const hasMore = result.rows.length > limit;
    // Cursor replays are read-idempotent. Inserts before an old cursor are
    // discovered by the next fresh sweep, not promised by this finite page.
    return {candidates, hasMore, nextCursor: hasMore ? candidates.at(-1).operationId : null};
  }
  return Object.freeze({scanIds, capabilities: () => ({candidateRead: enabled, defaultActivation: false,
    executesOperations: false, durableScheduler: false})});
}
