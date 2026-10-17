import {cueDigest, cueSourceIdentity, validateCueSource} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {INTENT_PROVIDER, inferenceInput, parseSemanticIntent, compileSemanticIntent} from '../../snapshot/app/runtime/intent-semantics.mjs';
import {verifiedBootstrapContext,isBootstrapPreparationSource} from './bootstrap-source-contract.mjs';
import {acceptsFundedBalance} from './funded-balance.mjs';

export const GENERATION_CONTRACT = Object.freeze({
  version: 'unified-intent-av-v1',
  intent: INTENT_PROVIDER.endpoint,
  music: 'fal-ai/stable-audio-3/medium/audio-outpainting',
  video: 'minimax/h3-max/image-to-video',
  counts: {intent: 1, music: 1, video: 1},
  contextSeconds: 16, audioTailSeconds: 24, videoSeconds: 5,
});
export class DispatchError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new DispatchError(code); };
// Factory configuration identity only: no operations, credentials or progress.
// A custom wrapper cannot claim the internal checkpoints of this dispatcher.
const guardedDispatchers = new WeakMap();
export const isAuthorityGuardedDispatcher = (dispatcher, guard) =>
  typeof guard?.assert === 'function' && guardedDispatchers.get(dispatcher) === guard;
const smallId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value);
const sha = value => /^[a-f0-9]{64}$/.test(value ?? '');
const credentialProof = (key, operationId) => cueDigest({domain: 'room-generation-key-v1', key, operationId});
const stageModel = stage => GENERATION_CONTRACT[stage];
export const generationIdentity = operationId => ({generationId: 'generation-' + cueDigest(operationId).slice(0, 32),
  cueId: 'cue-' + cueDigest(operationId).slice(0, 32)});
const mediaUrl = value => {
  let u; try { u = new URL(value); } catch { fail('PROVIDER_MEDIA_REQUIRED'); }
  if (u.protocol !== 'https:' || u.username || u.password || !/(^|\.)fal\.media$/.test(u.hostname)) fail('PROVIDER_MEDIA_REFUSED');
  return u.href;
};
const assertNotSecret = (value, key) => { if (JSON.stringify(value).includes(key)) fail('SECRET_IN_PAYLOAD'); };

// A permit comes only from the private server repository. No browser boolean,
// submitted budget, or LLM response grants spending authority.
export function validatePermit(permit, {now = Date.now, mediaHost} = {}) {
  if (!permit || permit.kind !== GENERATION_CONTRACT.version || !smallId(permit.permitId) ||
      !Number.isFinite(permit.expiresAtMs) || permit.expiresAtMs <= now() ||
      !Number.isFinite(permit.createdAtMs) || permit.expiresAtMs - permit.createdAtMs > 3600000 ||
      permit.expiresAtMs <= permit.createdAtMs || permit.revoked ||
      cueDigest(permit.counts) !== cueDigest(GENERATION_CONTRACT.counts)) fail('GENERATION_PERMIT_REQUIRED');
  const quote = permit.quote;
  const rates = ['intent', 'music', 'video'].map(k => quote?.maximumUsd?.[k]);
  if (quote?.verified !== true || !sha(quote.evidenceSha256) ||
      rates.some(x => !Number.isFinite(x) || x <= 0) || !Number.isFinite(permit.maximumUsd) ||
      rates.reduce((a, b) => a + b, 0) > permit.maximumUsd ||
      !Number.isFinite(quote.observedAtMs) || now() < quote.observedAtMs || now() - quote.observedAtMs > 3600000 ||
      !acceptsFundedBalance(permit.balance,{now,requiredUsd:permit.maximumUsd}) ||
      !Number.isFinite(permit.balance?.observedAtMs) || now() < permit.balance.observedAtMs || now() - permit.balance.observedAtMs > 3600000) fail('VERIFIED_PRICE_BALANCE_REQUIRED');
  validateCueSource(permit.source);
  if (!sha(permit.sourceSha256) || cueDigest(cueSourceIdentity(permit.source)) !== permit.sourceSha256) fail('SOURCE_BINDING_REQUIRED');
  if(isBootstrapPreparationSource(permit.source)&&
      (permit.assets?.context?.bootstrapEvidence?.kind!=='verified-owner-bootstrap-preparation-v1'||
       permit.assets.context.providerOriginVerified!==false))fail('VERIFIED_CONTEXT_REQUIRED');
  for (const name of ['context', 'reference']) {
    const asset = permit.assets?.[name]; let u;
    try { u = new URL(asset?.url); } catch { fail('PRIVATE_SOURCE_REQUIRED'); }
    if (u.protocol !== 'https:' || u.username || u.password || !mediaHost || u.hostname !== mediaHost ||
        asset.private !== true || asset.checksumVerified !== true || !sha(asset.sha256) ||
        !Number.isFinite(asset.expiresAtMs) || asset.expiresAtMs < permit.expiresAtMs) fail('PRIVATE_SOURCE_REQUIRED');
  }
  if (permit.assets.context.sha256 !== permit.source.music.contextSha256 ||
      permit.assets.reference.sha256 !== permit.source.video.referenceSha256 ||
      permit.assets.context.serverAudioQC !== true || !(permit.assets.context.providerOriginVerified === true &&
        permit.assets.context.originKind !== 'owner-supplied-bootstrap' ||
        verifiedBootstrapContext(permit.assets.context, permit.source, {now, expiresAtMs:permit.expiresAtMs}))) fail('VERIFIED_CONTEXT_REQUIRED');
  return permit;
}

function normalizedResult(stage, result, operation) {
  if (stage === 'intent') {
    const semantic = parseSemanticIntent(result);
    if (!Number.isFinite(result.usage?.cost) || result.usage.cost < 0 || result.usage.cost > operation.permit.quote.maximumUsd.intent) fail('INTENT_COST_HOLD');
    return {output: result.output, usage: {cost: result.usage.cost}, semantic};
  }
  const media = stage === 'music' ? result.audio : result.video;
  const url = mediaUrl(media?.url);
  return {url, contentType: stage === 'music' ? 'audio/wav' : 'video/mp4', resultSha256: cueDigest(result), providerObserved: true};
}
// Pure receipt validation for the separate GET-only reconciliation path. This
// does not validate, renew or grant a spending permit.
export {normalizedResult as normalizeCompletedProviderResult};
export const matchesOperationCredential=(op,key)=>op?.keyProof===credentialProof(key,op?.operationId);

// Short request-driven steps: no background key lease, timers, process queue or
// global credential fallback. The browser must remain connected to advance work.
// The durable repository claims each billable stage BEFORE the provider POST.
export function createGenerationDispatcher({enabled = false, repository, provider, mediaHost, now = Date.now,
  requireAuthority = false, authorityGuard,onDiagnostic=()=>{}} = {}) {
  if (!repository?.request || !provider?.submit || !provider?.status || !provider?.result) fail('DISPATCH_DEPENDENCIES_REQUIRED');
  if (typeof requireAuthority !== 'boolean') fail('DISPATCH_AUTHORITY_CONFIGURATION_REQUIRED');
  async function authority(input, phase, permitId) {
    if (!requireAuthority) return;
    if (typeof authorityGuard?.assert !== 'function') fail('DISPATCH_AUTHORITY_REQUIRED');
    const evidence = await authorityGuard.assert({roomId: input.roomId, ownerCapability: input.ownerCapability,
      operationId: input.body.operationId, ...(permitId ? {permitId} : {}), phase});
    if (evidence?.kind !== 'cloud-dispatch-authority-v1' || evidence.roomId !== input.roomId ||
        evidence.operationId !== input.body.operationId || evidence.phase !== phase || permitId && evidence.permitId !== permitId)
      fail('DISPATCH_AUTHORITY_REQUIRED');
  }
  async function operation(roomId, ownerCapability, operationId, key) {
    if (!smallId(operationId)) fail('OPERATION_ID_REQUIRED');
    const op = await repository.request('read', roomId, ownerCapability, {operationId});
    if (op.keyProof !== credentialProof(key, operationId)) fail('GENERATION_KEY_MISMATCH');
    return op;
  }
  async function retainStoppedDelivery({roomId, ownerCapability, operationId, key, stage, signature, requestId}) {
    // A known accepted request is bookkeeping, not fresh execution authority.
    // The unchanged submitted RPC records its reserved signature/request ID.
    // Unknown write/stop responses are reconciled from authoritative state.
    const args = {operationId};
    try { await repository.request('submitted', roomId, ownerCapability, {...args, stage, signature, requestId}); } catch {}
    // Observe the stage before stop as well: never infer persistence from a
    // successful transport reply or mistake a conflicting ID for this reply.
    const before = await operation(roomId, ownerCapability, operationId, key).catch(() => null), observed = before?.stages?.[stage];
    const conflicting = observed?.state === 'SUBMITTED' && (observed.signature !== signature || observed.requestId !== requestId);
    try { await repository.request('stop', roomId, ownerCapability, args); } catch {}
    const saved = await operation(roomId, ownerCapability, operationId, key).catch(() => null), record = saved?.stages?.[stage];
    return !conflicting && saved?.stopped === true && record?.state === 'SUBMITTED' && record.signature === signature && record.requestId === requestId;
  }
  function inputFor(op, stage) {
    if (stage === 'intent') return inferenceInput({text: op.prompt, source: op.permit.source});
    if (!op.plan || op.plan.status !== 'COMPILED') fail('COMPILED_INTENT_REQUIRED');
    return stage === 'music' ? {prompt: op.plan.music.prompt, audio_url: op.permit.assets.context.url,
      extend_seconds_before: 0, extend_seconds_after: 24, output_format: 'wav', enable_prompt_expansion: false} :
      {prompt: op.plan.video.prompt, image_url: op.permit.assets.reference.url,
        duration: 5, resolution: '480P', prompt_expansion_mode: 'disabled'};
  }
  const publicOperation = op => ({operationId: op.operationId, submissionId: op.submissionId,
    generationId: generationIdentity(op.operationId).generationId, commonIntentSha256: op.plan?.commonIntentSha256 ?? null,
    controlVersion: op.plan?.common?.control?.version ?? null,
    state: op.stopped ? 'STOPPED' : Object.values(op.stages ?? {}).some(s => ['UNKNOWN', 'FAILED', 'HOLD'].includes(s.state)) ? 'HOLD' :
      op.plan?.status === 'NEEDS_CLARIFICATION' ? 'NEEDS_CLARIFICATION' :
      ['music', 'video'].every(k => op.stages?.[k]?.state === 'COMPLETE') ? 'WAIT_QC' : 'PENDING',
    question: op.plan?.question ?? null,
    stages: Object.fromEntries(Object.entries(op.stages ?? {}).map(([name, s]) => [name, {
      state: s.state, requestId: s.requestId ?? null,
      ...(s.state === 'COMPLETE' && name !== 'intent' ? {media: s.result} : {}),
    }])), cueReady: false, actualPlayback: false, automaticRetry: false});
  const dispatcher = {async execute({action, roomId, ownerCapability, key, body, signal}) {
    if (!enabled) fail('GENERATION_NOT_ACTIVATED');
    if (typeof key !== 'string' || key.trim() !== key || key.length < 8 || key.length > 4096 || /[\r\n]/.test(key)) fail('SESSION_BYOK_REQUIRED');
    assertNotSecret(body, key);
    const live = () => !signal?.aborted;
    if (!live()) fail('CALLER_DISCONNECTED');
    const args = {operationId: body.operationId};
    if (action === 'begin') {
      if (!smallId(body.operationId) || !smallId(body.permitId)) fail('OPERATION_ID_REQUIRED');
      const permit = validatePermit(await repository.request('permit', roomId, ownerCapability, {permitId: body.permitId}), {now, mediaHost});
      await authority({roomId, ownerCapability, body}, 'begin-before', permit.permitId);
      const op = await repository.request('begin', roomId, ownerCapability, {...args, permitId: permit.permitId,
        submissionId: body.submissionId, keyProof: credentialProof(key, body.operationId)});
      await authority({roomId, ownerCapability, body}, 'begin-after', permit.permitId);
      return publicOperation(op);
    }
    let op = await operation(roomId, ownerCapability, body.operationId, key);
    if (action === 'read') return publicOperation(op);
    if (action === 'descriptor') return {operationId:op.operationId,submissionId:op.submissionId,prompt:op.prompt,
      plan:op.plan??null,stages:structuredClone(op.stages),stopped:op.stopped===true,
      permit:{source:structuredClone(op.permit.source),sourceSha256:op.permit.sourceSha256,
        visualPolicy:op.permit.visualPolicy??null,visualReviewMode:op.permit.visualReviewMode??null}};
    if (action === 'stop') return publicOperation(await repository.request('stop', roomId, ownerCapability, args));
    const stage = body.stage;
    if (!['intent', 'music', 'video'].includes(stage)) fail('GENERATION_STAGE_REQUIRED');
    const current = op.stages?.[stage];
    if (action === 'submit') {
      if (current?.state === 'SUBMITTED' || current?.state === 'COMPLETE') return publicOperation(op);
      if (current) fail('DISPATCH_UNKNOWN_NO_RETRY');
      if (op.stopped) fail('GENERATION_STOPPED');
      validatePermit(op.permit, {now, mediaHost});
      await authority({roomId, ownerCapability, body}, 'submit-before-claim', op.permit.permitId);
      const input = inputFor(op, stage); assertNotSecret(input, key);
      const signature = cueDigest({stage, model: stageModel(stage), input});
      await repository.request('claim', roomId, ownerCapability, {...args, stage, signature});
      let retainedDeliveryError = null,providerInvoked=false;
      try {
        // Recheck stop/source after the durable claim, immediately before POST.
        const fresh = await operation(roomId, ownerCapability, body.operationId, key);
        if (fresh.stopped || fresh.dispatchAllowed !== true || !live()) fail('GENERATION_STOPPED');
        validatePermit(fresh.permit, {now, mediaHost});
        await authority({roomId, ownerCapability, body}, 'submit-after-claim', fresh.permit.permitId);
        await authority({roomId, ownerCapability, body}, 'submit-before-provider', fresh.permit.permitId);
        providerInvoked=true;
        const reply = await provider.submit({key, model: stageModel(stage), input, signal,operationId:body.operationId,stage});
        assertNotSecret(reply, key);
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(reply?.request_id ?? '')) fail('PROVIDER_REQUEST_ID_REQUIRED');
        const requestId = reply.request_id;
        try { await authority({roomId, ownerCapability, body}, 'submit-after-provider', fresh.permit.permitId); }
        catch {
          const retained = await retainStoppedDelivery({roomId, ownerCapability, operationId: body.operationId, key,
            stage, signature, requestId});
          retainedDeliveryError = retained ? 'DISPATCH_KNOWN_DELIVERY_STOPPED_NO_RETRY' : 'DISPATCH_KNOWN_DELIVERY_UNCONFIRMED_NO_RETRY';
          fail(retainedDeliveryError);
        }
        op = await repository.request('submitted', roomId, ownerCapability, {...args, stage, signature, requestId});
        return publicOperation(op);
      } catch (e) {
        const code=e instanceof DispatchError&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.code)&&!e.code.includes(key)?e.code:'HELD';
        try{onDiagnostic({event:providerInvoked?'PROVIDER_OUTCOME_UNKNOWN':'PROVIDER_NOT_INVOKED',reason:[body.operationId,stage,code].join(':')});}catch{}
        await repository.request('unknown', roomId, ownerCapability, {...args, stage, signature}).catch(() => {});
        throw new DispatchError(retainedDeliveryError ?? 'DISPATCH_UNKNOWN_NO_RETRY');
      }
    }
    if (action !== 'poll' || !current?.requestId) fail('SUBMITTED_STAGE_REQUIRED');
    if (current.state === 'COMPLETE') return publicOperation(op);
    if (current.state !== 'SUBMITTED') fail('DISPATCH_UNKNOWN_NO_RETRY');
    if (op.stopped) fail('GENERATION_STOPPED');
    await authority({roomId, ownerCapability, body}, 'poll-before-status', op.permit.permitId);
    const observed = await provider.status({key, model: stageModel(stage), requestId: current.requestId, signal});
    assertNotSecret(observed, key);
    await authority({roomId, ownerCapability, body}, 'poll-after-status', op.permit.permitId);
    if (observed.error || observed.error_type) {
      await repository.request('failed', roomId, ownerCapability, {...args, stage}); fail('PROVIDER_STAGE_FAILED');
    }
    if (['IN_QUEUE', 'IN_PROGRESS'].includes(observed.status)) return publicOperation(op);
    if (observed.status !== 'COMPLETED') fail('PROVIDER_STATUS_HOLD');
    await authority({roomId, ownerCapability, body}, 'poll-before-result', op.permit.permitId);
    const raw = await provider.result({key, model: stageModel(stage), requestId: current.requestId, signal});
    assertNotSecret(raw, key);
    await authority({roomId, ownerCapability, body}, 'poll-after-result', op.permit.permitId);
    const data = raw.data ?? raw; let result, plan = null;
    try {
      result = normalizedResult(stage, data, op);
      if (stage === 'intent') plan = compileSemanticIntent({text: op.prompt, source: op.permit.source,
        cueId: generationIdentity(op.operationId).cueId, controlVersion: op.permit.source.music.control.version + 1,
        semantic: result.semantic, provenance: {endpoint: INTENT_PROVIDER.endpoint, model: INTENT_PROVIDER.model,
          providerRequestId: current.requestId, actualProviderInference: true, resultSha256: cueDigest(data), usage: result.usage}});
    } catch {
      await repository.request('held', roomId, ownerCapability, {...args, stage, observedResultSha256: cueDigest(data)});
      fail('PROVIDER_RESULT_QC_HOLD');
    }
    await authority({roomId, ownerCapability, body}, 'poll-before-complete', op.permit.permitId);
    op = await repository.request('complete', roomId, ownerCapability, {...args, stage, result, plan});
    return publicOperation(op);
  }};
  if (enabled === true && requireAuthority && typeof authorityGuard?.assert === 'function') {
    guardedDispatchers.set(dispatcher, authorityGuard);
    Object.freeze(dispatcher);
  }
  return dispatcher;
}
