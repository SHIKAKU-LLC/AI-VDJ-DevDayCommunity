import {randomUUID} from 'node:crypto';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {evaluateTransition, selectBestTransition, validatePlanAtCommit} from '../../snapshot/app/runtime/dj-transition-selector.mjs';
import {DispatchError} from './dispatch.mjs';
import {buildVerifiedCue, verifiedPlaybackAck} from './cue-contract.mjs';

const fail = code => { throw new DispatchError(code); };
const nonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value);
// Configuration identity only; no room, operation, proof or credential is cached.
const guardedCoordinators = new WeakMap();
export const isAuthorityGuardedCueCoordinator = (coordinator, guard) =>
  typeof guard?.assert === 'function' && guardedCoordinators.get(coordinator) === guard;

// No provider access. QC/current/render adapters are required and trusted host
// dependencies. The HTTP caller supplies IDs, not QC verdicts or a chosen plan.
export function createCueCoordinator({repository, inspectGeneration, readCurrent, inspectJoin,
  now = Date.now, random = randomUUID, policy = {}, enabled = false, requireAuthority = false, authorityGuard, onTiming = () => {}, showMode = false} = {}) {
  if (!repository?.request) fail('CUE_REPOSITORY_REQUIRED');
  if (typeof requireAuthority !== 'boolean' || typeof showMode !== 'boolean') fail('CUE_AUTHORITY_CONFIGURATION_REQUIRED');
  const request = (action, input, payload = {}) => repository.request(action, input.roomId, input.ownerCapability, payload);
  async function publicationAuthority(input, phase) {
    if (!requireAuthority) return;
    if (typeof authorityGuard?.assert !== 'function') fail('CUE_AUTHORITY_GUARD_REQUIRED');
    const proof = await authorityGuard.assert({roomId: input.roomId, ownerCapability: input.ownerCapability, operationId: input.operationId, phase});
    if (proof?.kind !== 'cloud-dispatch-authority-v1' || proof.roomId !== input.roomId ||
        proof.operationId !== input.operationId || proof.phase !== phase)
      fail('CUE_AUTHORITY_HOLD');
  }
  async function current(input) {
    if (typeof readCurrent !== 'function') fail('ACTUAL_PLAYBACK_SOURCE_REQUIRED');
    const value = await readCurrent(input.roomId);
    if (!value || !Number.isSafeInteger(value.playbackRevision) || value.playbackRevision < 0 ||
        !Number.isSafeInteger(value.playedUntilFrame) || value.playedUntilFrame < 0 || value.actual !== true) fail('ACTUAL_PLAYBACK_SOURCE_REQUIRED');
    return value;
  }
  async function currentForSelection(input){
    try{return await current(input);}catch(error){
      // No reservation has been written at either selection read. A missing or
      // aged physical observation is normal waiting, never permission to use
      // old frames or replay an unknown reservation POST.
      if(error?.code==='OBSERVER_FRESH_FRONTIER_REQUIRED')return null;
      throw error;
    }
  }
  const coordinator = {async execute(input) {
    if (!enabled) fail('CUE_COORDINATOR_NOT_ACTIVATED');
    if (input.action === 'state') return request('cueState', input);
    if (input.action === 'stop') return request('cueStop', input);
    if (input.action === 'start') return request('cueStart', input, {current: await current(input)});
    if (input.action === 'publish') {
      if (!nonce(input.operationId) || typeof inspectGeneration !== 'function') fail('SERVER_QC_ADAPTER_REQUIRED');
      const op = await request('read', input, {operationId: input.operationId});
      if (op.dispatchAllowed !== true) fail('SOURCE_OR_CONTROL_CHANGED');
      await publicationAuthority(input, 'qc-before-inspect');
      const evidence = await inspectGeneration({roomId: input.roomId, operation: op});
      await publicationAuthority(input, 'qc-before-publish');
      const cue = buildVerifiedCue({roomId: input.roomId, operation: op, evidence, now: now()});
      const published = await request('cuePublish', input, {operationId: input.operationId, cue});
      await publicationAuthority(input, 'qc-after-publish');
      return published;
    }
    if (input.action === 'reserve') {
      if (typeof inspectJoin !== 'function') fail('SERVER_TRANSITION_QC_REQUIRED');
      // Independent authenticated reads overlap. The later current read and
      // atomic reservation write still fence source/control/Stop changes.
      // Diagnostic durations only (bounded labels and milliseconds). A failed
      // reservation reports the stages it reached and its bounded error code.
      const t0 = now(); let last = t0; const parts = [];
      const report = t => { try { onTiming('reserve:' + parts.join(',') + ',total=' + (t - t0)); } catch {} };
      const mark = (label, detail = '') => { const t = now(); parts.push(label + '=' + (t - last)); last = t;
        if (detail) parts.push(detail);
        if (label === 'write' || label === 'hold') report(t); };
      try { return await reserve(input, mark); }
      catch (error) {
        const code = [error?.code, error?.message].find(value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value));
        parts.push('error=' + (code ?? 'RESERVE_FAILED')); report(now()); throw error;
      }
    }
    if (!nonce(input.reservationId)) fail('PLAYBACK_RESERVATION_REQUIRED');
    // Show mode: the output's worklet atomically refuses an edit at or before
    // its consumed frame, so a prepare check reads only the reservation's own
    // validity (completed/expiry/Stop/control via the RPC), not the live frontier.
    const preparing = !showMode && input.action === 'check' && (input.phase === undefined || input.phase === 'prepare');
    const checkStart = now();
    const [reservation, preparedSource] = await Promise.all([
      request('cueReservation', input, {reservationId: input.reservationId}),
      preparing ? current(input) : null,
    ]);
    if (input.action === 'check') { try { onTiming('check:' + (input.phase ?? 'prepare') + '=' + (now() - checkStart)); } catch {} }
    if (input.action === 'check') {
      // Once sound has actually started, the old edit frontier is expected to
      // have passed. The reservation/control/expiry checks still apply. This
      // read cannot register an ACK or grant credit by itself.
      if (input.phase === 'ack') return {valid: reservation.completed !== true && now() < reservation.expiresAtMs};
      if (input.phase !== undefined && input.phase !== 'prepare') fail('PLAYBACK_CHECK_PHASE_REQUIRED');
      if (showMode) return {valid: reservation.completed !== true && now() < reservation.expiresAtMs};
      const source = preparedSource;
      return {valid: reservation.completed !== true && validatePlanAtCommit(reservation.plan, {current: source, candidate: reservation.cue,
        reservedCueId: reservation.cue.cueId}).valid && now() < reservation.expiresAtMs};
    }
    if (input.action === 'ack') {
      const ack = verifiedPlaybackAck(reservation, input.ack);
      return request('cueAck', input, {reservationId: input.reservationId, ack,
        ackSha256: cueDigest(ack)});
    }
    fail('CUE_ACTION_REQUIRED');
  }};
  async function reserve(input, mark) {
    const [state, source] = await Promise.all([request('cueState', input), currentForSelection(input)]);
    mark('current');
    if(!source){mark('hold');return {state:'HOLD',reason:'WAITING_FOR_PLAYBACK_OBSERVATION'};}
    // The production host prepares joins ahead and returns null for an
    // unprepared one (counted as a miss) instead of rendering it here.
    const plans = []; let misses = 0, slowest = 0;
    for (const cue of state.cues.filter(c => c.status === 'READY')) {
      const started = now(), pairQC = await inspectJoin({roomId: input.roomId, current: source, candidate: cue});
      slowest = Math.max(slowest, now() - started); if (!pairQC) misses++;
      plans.push(evaluateTransition({current: source, candidate: cue, pairQC, mode: 'provider', policy, now: now()}));
    }
    mark('joins', 'n=' + plans.length + ',miss=' + misses + ',slowest=' + slowest);
    const selection = selectBestTransition(plans, {lastParticipantId: state.currentCredit?.participantId,
      servedCounts: state.servedCounts ?? {}, now: now()});
    if (!selection.selected) { mark('hold'); return {state: 'HOLD', reason: selection.reason, plans}; }
    // Recovery can keep several operations under one cueId: reserve exactly
    // the READY copy the plan was evaluated from (generation, bytes, control).
    const plan = selection.selected, copies = state.cues.filter(c => c.cueId === plan.cueId && c.status === 'READY' &&
      c.generationId === plan.generationId && c.music?.asset?.sha256 === plan.incomingSha256 && c.controlVersion === plan.controlVersion);
    if (copies.length !== 1) { mark('hold'); return {state: 'HOLD', reason: 'RECOMPUTE_PLAYBACK_PLAN'}; }
    const cue = copies[0];
    const latest = await currentForSelection(input);
    mark('current2');
    if(!latest){mark('hold');return {state:'HOLD',reason:'WAITING_FOR_PLAYBACK_OBSERVATION'};}
    if (!validatePlanAtCommit(plan, {current: latest, candidate: cue}).valid)
      {mark('hold');return {state:'HOLD',reason:'RECOMPUTE_PLAYBACK_PLAN'};}
    const reserved = await request('cueReserve', input, {operationId: cue.operationId, reservationId: random(), plan,
      current: latest, expectedRevision: latest.playbackRevision + 1, expiresAtMs: now() + 30000});
    // Where the switch lands relative to the sound at reservation (seconds).
    const sec = frame => Number.isSafeInteger(frame) ? (frame / 44100).toFixed(1) : 'NA';
    mark('write', 'at=' + sec(latest.playedUntilFrame) + 's,edit=' + sec(plan.transition?.editStartFrame) +
      's,exit=' + sec(plan.transition?.exitFrame) + 's'); return reserved;
  }
  if (enabled && requireAuthority && typeof authorityGuard?.assert === 'function') {
    Object.freeze(coordinator); guardedCoordinators.set(coordinator, authorityGuard);
  }
  return coordinator;
}
