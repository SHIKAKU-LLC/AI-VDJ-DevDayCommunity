import {DispatchError} from '../generation/dispatch.mjs';
import {isAuthorityGuardedCloudJobs} from './generation-jobs.mjs';

const fail = code => { throw new DispatchError(code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const nonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const scopeFields = value => { const {roomId, sessionId, controlRevision} = value; return {roomId, sessionId, controlRevision}; };
const sameScope = (a, b) => a?.roomId === b?.roomId && Object.is(a?.sessionId, b?.sessionId) && a?.controlRevision === b?.controlRevision;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeCodes = new Set(['RECOVERY_NOT_ACTIVATED', 'RECOVERY_GUARDED_JOBS_REQUIRED', 'RECOVERY_SCOPED_IDS_REQUIRED',
  'RECOVERY_SCOPE_CHANGED', 'RECOVERY_ROOM_STOPPED', 'RECOVERY_OWNER_CONTEXT_REQUIRED', 'RECOVERY_OWNER_CONTEXT_REUSED',
  'RECOVERY_CANDIDATE_PAGE_REQUIRED', 'RECOVERY_JOB_VIEW_REQUIRED', 'RECOVERY_AUTHORITY_REQUIRED', 'RECOVERY_QUERY_HOLD',
  'RECOVERY_CANDIDATES_NOT_ACTIVATED', 'RECOVERY_CANDIDATE_ROWS_REQUIRED', 'RECOVERY_CLOCK_REQUIRED',
  'DISPATCH_AUTHORITY_REQUIRED', 'DISPATCH_AUTHORITY_NOT_ACTIVATED', 'DISPATCH_AUTHORITY_SCOPE_CHANGED',
  'DISPATCH_AUTHORITY_PERMIT_CHANGED', 'DISPATCH_AUTHORITY_SOURCE_CHANGED', 'DISPATCH_AUTHORITY_GLOBAL_STOP',
  'DISPATCH_AUTHORITY_OPERATION_CHANGED', 'DISPATCH_UNKNOWN_NO_RETRY', 'DISPATCH_KNOWN_DELIVERY_STOPPED_NO_RETRY',
  'DISPATCH_KNOWN_DELIVERY_UNCONFIRMED_NO_RETRY', 'GENERATION_STOPPED', 'SOURCE_OR_CONTROL_CHANGED',
  'GENERATION_PERMIT_REQUIRED', 'VERIFIED_PRICE_BALANCE_REQUIRED', 'SESSION_BYOK_REQUIRED', 'GENERATION_KEY_MISMATCH',
  'OWNER_DENIED', 'CLOUD_JOB_GUARDED_DISPATCHER_REQUIRED', 'CLOUD_JOB_GUARDED_COORDINATOR_REQUIRED']);
const safeCode = error => error instanceof DispatchError && safeCodes.has(error.code) ? error.code : 'RECOVERY_EXECUTION_HOLD';
const states = new Set(['PENDING', 'WAIT_QC', 'READY', 'PLAYING', 'STOPPED', 'HOLD', 'NEEDS_CLARIFICATION']);

// One finite host invocation, not a scheduler or durable job lease. Existing
// stage claims remain the billable delivery fence. The host owns ephemeral
// owner authorization, wake-up policy and any approved credential lifecycle.
export function createCloudRecoveryRunner({enabled = false, candidates, jobs, authorityGuard, repository, readScope,
  withOwnerAuthorization, now = Date.now} = {}) {
  if (typeof enabled !== 'boolean' || typeof candidates?.scanIds !== 'function' || !repository?.request ||
      typeof readScope !== 'function' || typeof withOwnerAuthorization !== 'function' || typeof now !== 'function')
    fail('RECOVERY_RUNNER_PORTS_REQUIRED');
  const configured = () => isAuthorityGuardedCloudJobs(jobs, authorityGuard);
  const timestamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail('RECOVERY_CLOCK_REQUIRED');
    return value;
  };
  async function runOnce(input) {
    if (!enabled) fail('RECOVERY_NOT_ACTIVATED');
    // Verify factory identity before even asking the host for an owner context.
    if (!configured()) fail('RECOVERY_GUARDED_JOBS_REQUIRED');
    if (!plain(input) || Object.keys(input).some(key => !['roomId', 'sessionId', 'controlRevision', 'limit', 'afterOperationId'].includes(key)) ||
        !uuid(input.roomId) || !uuid(input.sessionId) || !integer(input.controlRevision) ||
        input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) ||
        input.afterOperationId !== undefined && !nonce(input.afterOperationId)) fail('RECOVERY_SCOPED_IDS_REQUIRED');
    const requested = Object.freeze({...scopeFields(input), limit: input.limit ?? 20,
      ...(input.afterOperationId === undefined ? {} : {afterOperationId: input.afterOperationId})});
    let used = false, finished = false, invalidated = false, pending = null;
    const validContext = () => { if (finished || invalidated) fail('RECOVERY_OWNER_CONTEXT_REUSED'); };
    async function process(context) {
      if (!plain(context) || Object.keys(context).some(key => !['roomId', 'sessionId', 'controlRevision', 'ownerCapability'].includes(key)) ||
          !sameScope(context, requested) || !/^[a-f0-9]{64}$/.test(context.ownerCapability ?? '')) fail('RECOVERY_OWNER_CONTEXT_REQUIRED');
      const ownerCapability = context.ownerCapability;
      async function facts() {
        validContext(); timestamp();
        const before = await readScope({roomId: requested.roomId}); validContext();
        if (!sameScope(before, requested) || before.closed === true || !Number.isFinite(before.expiresAtMs) || before.expiresAtMs <= timestamp())
          fail('RECOVERY_SCOPE_CHANGED');
        const playback = await repository.request('cueState', requested.roomId, ownerCapability, {}); validContext();
        if (playback?.roomId !== requested.roomId || playback.stopped !== false) fail('RECOVERY_ROOM_STOPPED');
        const after = await readScope({roomId: requested.roomId}); validContext();
        if (!sameScope(after, before) || after.closed === true || after.expiresAtMs !== before.expiresAtMs || after.expiresAtMs <= timestamp())
          fail('RECOVERY_SCOPE_CHANGED');
      }
      function viewValid(view, candidate) {
        if (!view || view.roomId !== requested.roomId || view.operationId !== candidate.operationId || !states.has(view.state))
          fail('RECOVERY_JOB_VIEW_REQUIRED');
        return view;
      }
      function eligible(view) {
        if (!['PENDING', 'WAIT_QC'].includes(view.state)) return false;
        if (!plain(view.stages) || Object.keys(view.stages).some(stage => !['intent', 'music', 'video'].includes(stage))) return false;
        const entries = Object.entries(view.stages);
        if (!entries.length) return false;
        if (entries.some(([, stage]) => !plain(stage) || !['SUBMITTED', 'COMPLETE'].includes(stage.state) ||
            typeof stage.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(stage.requestId))) return false;
        if (entries.length && view.stages.intent?.state !== 'COMPLETE' && !(entries.length === 1 && view.stages.intent?.state === 'SUBMITTED')) return false;
        return view.state !== 'WAIT_QC' || ['music', 'video'].every(stage => view.stages[stage]?.state === 'COMPLETE');
      }
      await facts();
      const page = await candidates.scanIds({...requested}); validContext();
      if (!plain(page) || Object.keys(page).some(key => !['candidates', 'hasMore', 'nextCursor'].includes(key)) ||
          !Array.isArray(page.candidates) || page.candidates.length > requested.limit || typeof page.hasMore !== 'boolean')
        fail('RECOVERY_CANDIDATE_PAGE_REQUIRED');
      let last = requested.afterOperationId ?? null;
      for (const candidate of page.candidates) {
        if (!plain(candidate) || Object.keys(candidate).length !== 5 || Object.keys(candidate).some(key =>
          !['roomId', 'sessionId', 'controlRevision', 'operationId', 'permitId'].includes(key)) || !sameScope(candidate, requested) ||
            !nonce(candidate.operationId) || !nonce(candidate.permitId) || last !== null && candidate.operationId <= last)
          fail('RECOVERY_CANDIDATE_PAGE_REQUIRED');
        last = candidate.operationId;
      }
      if (page.hasMore ? !page.candidates.length || page.nextCursor !== last : page.nextCursor !== null)
        fail('RECOVERY_CANDIDATE_PAGE_REQUIRED');
      // Copies prevent a host scan result from changing while an async step is
      // running. IDs still grant no execution authority.
      const selected = page.candidates.map(candidate => Object.freeze({...candidate})), results = [];
      await facts();
      for (const candidate of selected) {
        await facts();
        const jobInput = {roomId: requested.roomId, operationId: candidate.operationId, ownerCapability};
        let attempted = false, reason = null, state = 'HOLD';
        try {
          let view = viewValid(await jobs.read(jobInput), candidate); validContext();
          state = view.state;
          if (!eligible(view)) reason = 'RECOVERY_NOT_ELIGIBLE';
          else {
            await facts();
            view = viewValid(await jobs.read(jobInput), candidate); validContext();
            state = view.state;
            if (!eligible(view)) reason = 'RECOVERY_NOT_ELIGIBLE';
            else {
              const proof = await authorityGuard.assert({...jobInput, permitId: candidate.permitId, phase: 'advance-before'}); validContext();
              if (proof?.kind !== 'cloud-dispatch-authority-v1' || proof.roomId !== requested.roomId || proof.operationId !== candidate.operationId ||
                  proof.permitId !== candidate.permitId || proof.phase !== 'advance-before') fail('RECOVERY_AUTHORITY_REQUIRED');
              await facts(); validContext(); attempted = true;
              await jobs.advance(jobInput); validContext();
              state = viewValid(await jobs.read(jobInput), candidate).state;
            }
          }
        } catch (error) { reason = safeCode(error); state = 'HOLD'; }
        // Stop/owner/scope changes during a step interrupt the finite page.
        await facts();
        results.push({roomId: requested.roomId, operationId: candidate.operationId, attempted, state, reason});
      }
      await facts();
      return {...scopeFields(requested), results, hasMore: page.hasMore, nextCursor: page.nextCursor,
        durableScheduler: false, automaticRetry: false};
    }
    try {
      await withOwnerAuthorization(Object.freeze(scopeFields(requested)), context => {
        if (used || finished) { invalidated = true; fail('RECOVERY_OWNER_CONTEXT_REUSED'); }
        used = true; pending = process(context); return pending;
      });
      if (!used || !pending) fail('RECOVERY_OWNER_CONTEXT_REQUIRED');
      const result = await pending; validContext(); return result;
    } catch (error) {
      invalidated = true;
      if (pending) await pending.catch(() => {});
      throw new DispatchError(safeCode(error));
    } finally { finished = true; }
  }
  return Object.freeze({runOnce, capabilities: () => ({recoveryRunner: enabled && configured(), defaultActivation: false,
    durableScheduler: false, createsOperations: false, automaticRetry: false})});
}
