import {createGenerationStore} from './generation-store.mjs';
import {boundedBytes, sha256, createFalProvider} from './fal-provider.mjs';
const answer = (value, status = 200) => Response.json(value, {status, headers: {'cache-control': 'no-store'}});
export async function generationHttp(request, env) {
  const url = new URL(request.url), match = /^\/api\/rooms\/([a-f0-9-]{36})\/(generation|generated-media)(?:\/([a-f0-9-]{36})\/(audio|video))?$/.exec(url.pathname);
  if (!match) return null;
  if (url.origin !== env.PUBLIC_ORIGIN || request.headers.has('origin') && request.headers.get('origin') !== env.PUBLIC_ORIGIN || url.search) return answer({error: 'DENIED'}, 403);
  const [, roomId, route, jobId, kind] = match;
  const owner = request.headers.get('x-room-owner'), member = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (owner && member) return answer({error: 'DENIED'}, 403);
  const store = createGenerationStore({db: env.DB, eventId: env.EVENT_ID});
  let phase = 'authorize';
  try {
    const room = await store.authorize(roomId, owner ?? member, request.method === 'POST' || route === 'generated-media');
    if (route === 'generation' && request.method === 'GET' && !jobId) {
      let jobs = await store.records(roomId);
      if (!owner) {
        const proof = await sha256(member), document = JSON.parse(room.document);
        const actor = document.members.find(m => m.proof === proof);
        const own = new Set(document.submissions.filter(s => s.participantId === actor?.id).map(s => s.submissionId));
        jobs = jobs.filter(j => own.has(j.id));
      }
      return answer({jobs: jobs.map(({id, prompt, nickname, state, reason, maximumCents, assets}) => ({id, prompt, nickname, state, reason, maximumCents,
        ...(state === 'READY' ? {assets: Object.fromEntries(['audio', 'video'].map(k => [k, {sha256: assets[k].sha256, duration: assets[k].duration,
          byteLength: assets[k].byteLength, contentType: assets[k].contentType}]))} : {})}))});
    }
    if (route === 'generation' && request.method === 'POST' && !jobId) {
      if (request.headers.get('origin') !== env.PUBLIC_ORIGIN || request.headers.get('content-type') !== 'application/json') return answer({error: 'DENIED'}, 403);
      const input = JSON.parse(new TextDecoder().decode(await boundedBytes(new Response(request.body), 1024)));
      if (!Array.isArray(input.submissionIds) || Object.keys(input).join() !== 'submissionIds' || input.submissionIds.length < 1 || input.submissionIds.length > 5 ||
          input.submissionIds.some(v => !/^[a-f0-9-]{36}$/.test(v))) return answer({error: 'INPUT_INVALID'}, 400);
      if (env.GENERATION_ENABLED !== 'true') throw Error('GENERATION_DISABLED');
      // Configuration/price/balance errors must not consume one of the five
      // reservations. Recheck inside the durable job immediately before POST.
      phase = 'provider-preflight';
      await createFalProvider({key: env.FAL_KEY, fetchImpl: env.testFetch ?? fetch}).preflight();
      phase = 'enqueue';
      const result = await env.GENERATION.getByName(roomId).enqueue(roomId, input.submissionIds);
      return answer(result, 202);
    }
    if (route === 'generated-media' && request.method === 'GET' && jobId && kind) {
      const job = (await store.records(roomId)).find(j => j.id === jobId && j.state === 'READY');
      if (!job) return answer({error: 'NOT_READY'}, 404);
      const file = job.assets[kind], object = await env.MEDIA.get(file.path);
      if (!object?.body || object.size !== file.byteLength || object.customMetadata?.sha256 !== file.sha256) return answer({error: 'MEDIA_UNAVAILABLE'}, 503);
      return new Response(object.body, {headers: {'content-type': file.contentType, 'content-length': String(file.byteLength),
        'cache-control': 'private, no-store', 'x-content-sha256': file.sha256}});
    }
    return answer({error: 'METHOD_NOT_ALLOWED'}, 405);
  } catch (error) {
    const code = ['ACTOR_DENIED', 'ROOM_NOT_FOUND', 'JUDGE_BUDGET', 'GENERATION_DISABLED', 'SUBMISSION_NOT_FOUND',
      'PROVIDER_NOT_CONNECTED', 'PROVIDER_PERMISSION_REQUIRED', 'PROVIDER_BALANCE_REQUIRED', 'PROVIDER_PRICE_CHANGED',
      'PROVIDER_AUTHENTICATION_FAILED', 'PROVIDER_ENDPOINT_UNAVAILABLE', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE'].includes(error.message) ? error.message : 'GENERATION_UNAVAILABLE';
    return answer({error: code, phase}, code === 'ACTOR_DENIED' ? 403 : code === 'JUDGE_BUDGET' ? 429 : 503);
  }
}
