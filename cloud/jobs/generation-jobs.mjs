import {createGenerationDispatcher, DispatchError, generationIdentity, validatePermit, isAuthorityGuardedDispatcher} from '../generation/dispatch.mjs';
import {hasVerifiedPersistedCloudCue} from './room-projection.mjs';
import {isAuthorityGuardedCueCoordinator} from '../generation/cue-coordinator.mjs';
import {diagnosticReasons} from '../generation/diagnostics.mjs';

const fail = code => { throw new DispatchError(code); };
const operationIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value);
const heldStates = new Set(['RESERVED', 'UNKNOWN', 'FAILED', 'HOLD']);
const jobConfigurations = new WeakMap();

// Configuration identity only; no permit, owner proof or current state is kept.
// Recovery hosts cannot establish guarded execution with capabilities booleans
// or by copying the methods of a registered factory instance.
export function isAuthorityGuardedCloudJobs(jobs, authorityGuard) {
  const config = jobConfigurations.get(jobs);
  return !!config && config.enabled === true && config.requireAuthority === true &&
    typeof authorityGuard?.assert === 'function' && config.authorityGuard === authorityGuard &&
    typeof config.credentialForOperation === 'function' &&
    isAuthorityGuardedDispatcher(config.dispatch, authorityGuard) &&
    (!config.coordinator || isAuthorityGuardedCueCoordinator(config.coordinator, authorityGuard));
}

// All progress lives in the existing generation/cue RPC repository. schedule is
// only a wake-up hint: a new worker always re-reads the operation before acting.
// No request signal, browser lifecycle, timer, job map or credential cache lives here.
export function createCloudGenerationJobs({enabled = false, repository, dispatcher,
  provider, mediaHost, coordinator, credentialForOperation, schedule, prepareMedia,
  now = Date.now, requireAuthority = false, authorityGuard,onDiagnostic=()=>{},onPublished=()=>{}} = {}) {
  if (!repository?.request) fail('CLOUD_JOB_REPOSITORY_REQUIRED');
  if (typeof requireAuthority !== 'boolean') fail('DISPATCH_AUTHORITY_CONFIGURATION_REQUIRED');
  const dispatch = dispatcher ?? (provider ? createGenerationDispatcher({enabled, repository, provider, mediaHost, now,
    requireAuthority, authorityGuard,onDiagnostic}) : null);
  const active = () => { if (!enabled) fail('CLOUD_JOBS_NOT_ACTIVATED'); };
  const executionConfigured = () => {
    if (requireAuthority && !isAuthorityGuardedDispatcher(dispatch, authorityGuard)) fail('CLOUD_JOB_GUARDED_DISPATCHER_REQUIRED');
  };
  const validateInput = input => {
    if (!input || !/^[a-f0-9-]{36}$/i.test(input.roomId ?? '') || !operationIdValid(input.operationId)) fail('CLOUD_JOB_ID_REQUIRED');
    if (!/^[a-f0-9]{64}$/.test(input.ownerCapability ?? '')) fail('OWNER_DENIED');
  };
  const request = (action, input, payload = {}) => repository.request(action, input.roomId, input.ownerCapability, payload);
  async function operation(input) {
    validateInput(input);
    const op = await request('read', input, {operationId: input.operationId});
    if (op?.operationId !== input.operationId || !operationIdValid(op.permit?.permitId) || !op.submissionId) fail('CLOUD_JOB_BINDING_REQUIRED');
    return op;
  }
  const stateOf = op => op.stopped ? 'STOPPED' : Object.values(op.stages ?? {}).some(stage => heldStates.has(stage.state)) ? 'HOLD' :
    op.dispatchAllowed !== true ? 'HOLD' : op.plan?.status === 'NEEDS_CLARIFICATION' ? 'NEEDS_CLARIFICATION' :
    ['music', 'video'].every(stage => op.stages?.[stage]?.state === 'COMPLETE') ? 'WAIT_QC' : 'PENDING';
  function projection(input, op) {
    const cue = op.cue, verified = hasVerifiedPersistedCloudCue({roomId: input.roomId, operation: op});
    const revisionValid = Number.isSafeInteger(cue?.playbackRevision) && cue.playbackRevision > 0;
    let state = stateOf(op);
    if (state === 'WAIT_QC' && ['READY', 'SELECTED', 'PLAYING'].includes(cue?.status) &&
        (!verified || cue.status === 'PLAYING' && !revisionValid)) state = 'HOLD';
    const ready = state === 'WAIT_QC' && verified && cue.status === 'READY';
    const playing = state === 'WAIT_QC' && verified && cue.status === 'PLAYING' && revisionValid;
    return {roomId: input.roomId, operationId: op.operationId, submissionId: op.submissionId,
      generationId: generationIdentity(op.operationId).generationId, state: ready ? 'READY' : playing ? 'PLAYING' : state,
      commonIntentSha256: op.plan?.commonIntentSha256 ?? null, controlVersion: op.plan?.common?.control?.version ?? null,
      stages: Object.fromEntries(Object.entries(op.stages ?? {}).map(([stage, value]) => [stage,
        {state: value.state, requestId: value.requestId ?? null}])),
      question: op.plan?.question ?? null, cueReady: ready, actualPlayback: playing,
      reservationAcknowledged: state === 'WAIT_QC' && verified && ['SELECTED', 'PLAYING'].includes(cue?.status),
      playerAcknowledged: playing, automaticRetry: false};
  }
  async function read(input) { return projection(input, await operation(input)); }
  async function authority(input, phase, permitId) {
    if (!requireAuthority) return;
    if (typeof authorityGuard?.assert !== 'function') fail('DISPATCH_AUTHORITY_REQUIRED');
    const evidence = await authorityGuard.assert({roomId: input.roomId, ownerCapability: input.ownerCapability,
      operationId: input.operationId, ...(permitId ? {permitId} : {}), phase});
    if (evidence?.kind !== 'cloud-dispatch-authority-v1' || evidence.roomId !== input.roomId ||
        evidence.operationId !== input.operationId || evidence.phase !== phase || permitId && evidence.permitId !== permitId)
      fail('DISPATCH_AUTHORITY_REQUIRED');
  }
  async function credentials(input, phase = 'credentials-before-stage', permitId) {
    await authority(input, phase, permitId);
    if (!dispatch?.execute || typeof credentialForOperation !== 'function') fail('CLOUD_JOB_CREDENTIAL_ADAPTER_REQUIRED');
    const key = await credentialForOperation({roomId: input.roomId, operationId: input.operationId});
    if (typeof key !== 'string') fail('SESSION_BYOK_REQUIRED');
    return key;
  }
  const execute = (input, key, action, body = {}) => dispatch.execute({action, roomId: input.roomId,
    ownerCapability: input.ownerCapability, key, body: {operationId: input.operationId, ...body}});
  const wake = async input => {
    if (typeof schedule === 'function') {
      // Notification failure cannot invalidate committed database progress.
      // The durable host must recover due work by scanning the repository.
      try { await schedule({roomId: input.roomId, operationId: input.operationId}); } catch {}
    }
  };
  async function start(input) {
    active(); executionConfigured(); validateInput(input);
    if (!operationIdValid(input.permitId) || typeof input.submissionId !== 'string') fail('CLOUD_JOB_BINDING_REQUIRED');
    // Authenticate the owner and validate the finite server permit before a
    // credential adapter is consulted, including on duplicate starts.
    validatePermit(await request('permit', input, {permitId: input.permitId}), {now, mediaHost});
    const key = await credentials(input, 'credentials-before-begin', input.permitId);
    await execute(input, key, 'begin', {permitId: input.permitId, submissionId: input.submissionId});
    const op = await operation(input);
    if (op.permit.permitId !== input.permitId || op.submissionId !== input.submissionId) fail('CLOUD_JOB_BINDING_REQUIRED');
    await authority(input, 'begin-after', input.permitId);
    // A lost hint does not roll back the durable begin; start may be repeated.
    await wake(input);
    return projection(input, op);
  }
  async function submitInitialIntent(input) {
    active(); executionConfigured(); const op = await operation(input); guard(op);
    if (Object.keys(op.stages ?? {}).length === 0) {
      await authority(input, 'initial-intent-before', op.permit.permitId);
      const key = await credentials(input);
      await execute(input, key, 'submit', {stage: 'intent'});
      await authority(input, 'initial-intent-after', op.permit.permitId);
    }
    await wake(input); return read(input);
  }
  function guard(op) {
    if (op.stopped) fail('GENERATION_STOPPED');
    if (op.dispatchAllowed !== true) fail('SOURCE_OR_CONTROL_CHANGED');
    validatePermit(op.permit, {now, mediaHost});
  }
  async function advance(input) {
    active(); executionConfigured(); let op = await operation(input);
    if (['STOPPED', 'HOLD', 'NEEDS_CLARIFICATION'].includes(stateOf(op))) return projection(input, op);
    guard(op);
    await authority(input, 'advance-before', op.permit.permitId);
    let keyPromise;
    async function step(stage) {
      const current = await operation(input); guard(current);
      const state = current.stages?.[stage]?.state;
      if (state === 'COMPLETE') return;
      if (state !== 'SUBMITTED' && state !== undefined) return;
      const key = await (keyPromise ??= credentials(input));
      if (state === 'SUBMITTED') await execute(input, key, 'poll', {stage});
      else if (state === undefined) await execute(input, key, 'submit', {stage});
      // RESERVED and UNKNOWN are reconciliation holds, never reposts.
    }
    await step('intent'); op = await operation(input);
    if (op.stages?.intent?.state === 'COMPLETE' && op.plan?.status === 'COMPILED' && stateOf(op) === 'PENDING') {
      const results = await Promise.allSettled(['music', 'video'].map(step));
      // Settle both concurrent stages before returning a failure. A successful
      // sibling's request_id remains authoritative and is reused next time.
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      op = await operation(input);
    }
    if (stateOf(op) === 'WAIT_QC' && !op.cue && coordinator?.execute) {
      guard(op);
      try {
        await authority(input, 'qc-before-prepare', op.permit.permitId);
        if (typeof prepareMedia === 'function') await prepareMedia({roomId: input.roomId, operationId: input.operationId});
        guard(await operation(input));
        await authority(input, 'qc-after-prepare', op.permit.permitId);
        await authority(input, 'qc-before-publish', op.permit.permitId);
        if (requireAuthority && !isAuthorityGuardedCueCoordinator(coordinator, authorityGuard)) fail('CLOUD_JOB_GUARDED_COORDINATOR_REQUIRED');
        await coordinator.execute({action: 'publish', roomId: input.roomId, operationId: input.operationId,
          ownerCapability: input.ownerCapability});
        await authority(input, 'qc-after-publish', op.permit.permitId);
        // A newly READY Cue starts its join preparation (IDs only, best effort).
        try { onPublished({roomId: input.roomId, operationId: input.operationId}); } catch {}
      } catch (error) {
        try{onDiagnostic({event:'GENERATION_QC_HOLD',reason:input.operationId+':'+diagnosticReasons(error).join(':')});}catch{}
        // Incomplete, unsaved or untrusted worker evidence remains WAIT_QC.
        // Source/authorization and unexpected adapter failures remain errors.
        if (!(error instanceof DispatchError) ||
            !/^(COMPLETE_AV|REAL_MEDIA|BOUND_SAVED_AV_QC|VERIFIED_AUDIO|FULL_VISUAL|VISUAL_|GENERATED_CLIP|FULL_CUE|SERVER_QC|SAVED_MEDIA|PORTABLE_QC|PRIVATE_INGESTION_HOLD)/.test(error.code)) throw error;
      }
      op = await operation(input);
    }
    const result = projection(input, op);
    if (result.state === 'PENDING' || result.state === 'WAIT_QC') await wake(input);
    return result;
  }
  async function stop(input) {
    active(); await operation(input);
    await request('stop', input, {operationId: input.operationId});
    return read(input);
  }
  const capabilities = () => ({generationJobs: enabled === true && !!dispatch?.execute &&
    typeof credentialForOperation === 'function' && (!requireAuthority || isAuthorityGuardedDispatcher(dispatch, authorityGuard)),
    progressRead: true, serverQC: enabled === true && !!coordinator?.execute && (!requireAuthority ||
      isAuthorityGuardedDispatcher(dispatch, authorityGuard) && isAuthorityGuardedCueCoordinator(coordinator, authorityGuard)),
    durableScheduler: false, wakeHintConfigured: typeof schedule === 'function',
    defaultActivation: false, actualProviderWorkVerified: false});
  const jobs = Object.freeze({start, submitInitialIntent, advance, read, stop, capabilities});
  jobConfigurations.set(jobs, {enabled, requireAuthority, authorityGuard, dispatch, coordinator, credentialForOperation});
  return jobs;
}
