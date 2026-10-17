import {createGenerationDispatcher, DispatchError} from './dispatch.mjs';
import {createGenerationHandler} from './http.mjs';
import {createGenerationProvider} from './provider.mjs';
import {createCueCoordinator} from './cue-coordinator.mjs';
import {createCueHandler} from './cue-http.mjs';

// Optional composition for the existing Supabase entry. No key is read here.
// platformHeaders must remain in Edge memory, supplied by the existing host.
// Installing this module alone does not create tables/permits or enable work.
export function createEdgeGenerationHandler({projectURL, platformHeaders, enabled = false,
  origin = 'https://ai-vdj.vercel.app', fetchImpl = globalThis.fetch,
  cueEnabled = false, cuePorts = {},
  loadSDK = () => import('npm:@fal-ai/client@1.10.1')} = {}) {
  const host = new URL(projectURL);
  if (host.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(host.hostname)) throw Error('DEDICATED_PROJECT_REQUIRED');
  const repository = {async request(op, roomId, ownerCapability, payload) {
    const response = await fetchImpl(host.origin + '/rest/v1/rpc/vdj_generation_request', {
      method: 'POST', headers: platformHeaders,
      body: JSON.stringify({op, room_id: roomId, capability: ownerCapability, payload}),
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    if (!response.ok) {
      const codes = new Set(['OWNER_DENIED', 'GENERATION_PERMIT_REQUIRED', 'PERMIT_ALREADY_USED',
        'SUBMISSION_REQUIRED', 'STAGE_ALREADY_RESERVED', 'COMPILED_INTENT_REQUIRED', 'RESULT_IMMUTABLE',
        'SOURCE_OR_CONTROL_CHANGED', 'CUE_EVIDENCE_IMMUTABLE', 'PLAYBACK_PENDING', 'PLAYBACK_STOPPED',
        'PLAYBACK_RESERVATION_REQUIRED', 'MATCHING_ACTUAL_AV_ACK_REQUIRED', 'ACK_CONFLICT']);
      throw new DispatchError(codes.has(result?.message) ? result.message : 'GENERATION_REPOSITORY_HOLD');
    }
    return result;
  }};
  let sdk;
  const call = async (method, input) => {
    sdk ??= await loadSDK();
    return createGenerationProvider({createFalClient: sdk.createFalClient, fetchImpl})[method](input);
  };
  const provider = Object.fromEntries(['submit', 'status', 'result'].map(method => [method, input => call(method, input)]));
  const generation = createGenerationHandler({origin, dispatcher: createGenerationDispatcher({enabled, repository, provider,
    mediaHost: host.hostname})});
  const cues = createCueHandler({origin, coordinator: createCueCoordinator({repository, enabled: cueEnabled,
    inspectGeneration: cuePorts.inspectGeneration, readCurrent: cuePorts.readCurrent, inspectJoin: cuePorts.inspectJoin})});
  return async req => (await cues(req)) ?? generation(req);
}
