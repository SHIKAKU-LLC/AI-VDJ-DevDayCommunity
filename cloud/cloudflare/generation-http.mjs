import {publicAssets, sceneKeys} from './generation-parts.mjs';
import {createGenerationStore} from './generation-store.mjs';
import {boundedBytes, sha256, createFalProvider} from './fal-provider.mjs';
const answer = (value, status = 200) => Response.json(value, {status, headers: {'cache-control': 'no-store'}});
export async function generationHttp(request, env) {
  const url = new URL(request.url), match = /^\/api\/rooms\/([a-f0-9-]{36})\/(generation|generated-media)(?:\/([a-f0-9-]{36})\/(audio|video(?:-[1-5])?))?$/.exec(url.pathname);
  if (!match) return null;
  if (url.origin !== env.PUBLIC_ORIGIN || request.headers.has('origin') && request.headers.get('origin') !== env.PUBLIC_ORIGIN || url.search) return answer({error: 'DENIED'}, 403);
  const [, roomId, route, jobId, kind] = match;
  const owner = request.headers.get('x-room-owner'), member = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (owner && member) return answer({error: 'DENIED'}, 403);
  const store = createGenerationStore({db: env.DB, eventId: env.EVENT_ID});
  let phase = 'authorize';
  try {
    if (route === 'generation' && !jobId && request.method === 'DELETE' &&
        request.headers.get('origin') === env.PUBLIC_ORIGIN && await store.purgeRequested(roomId)) {
      // Only a server-side administrative tombstone can authorize erasure.
      // Owner/participant payloads cannot set this flag through the room API.
      const result = await env.GENERATION.getByName(roomId).purgeClosedRoom(roomId);
      return answer({purged: result.purged, providerDeleted: result.providerPurge.deleted,
        providerPending: result.providerPurge.pending.length});
    }
    const room = await store.authorize(roomId, owner ?? member, request.method === 'POST' || route === 'generated-media');
    if (route === 'generation' && request.method === 'GET' && !jobId) {
      let jobs = await store.records(roomId);
      if (!owner) {
        const proof = await sha256(member), document = JSON.parse(room.document);
        const actor = document.members.find(m => m.proof === proof);
        const own = new Set(document.submissions.filter(s => s.participantId === actor?.id).map(s => s.submissionId));
        jobs = jobs.filter(j => own.has(j.id));
      }
      return answer({jobs: jobs.map(job => {
        const {id, prompt, nickname, state, reason, maximumCents, progress, sceneCount = 1} = job;
        return {id, prompt, nickname, state, reason, maximumCents, progress, sceneCount, assets: publicAssets(job)};
      })});
    }
    if (route === 'generation' && request.method === 'POST' && !jobId) {
      if (request.headers.get('origin') !== env.PUBLIC_ORIGIN || request.headers.get('content-type') !== 'application/json') return answer({error: 'DENIED'}, 403);
      const input = JSON.parse(new TextDecoder().decode(await boundedBytes(new Response(request.body), 1024)));
      if (Array.isArray(input.retryPreparation) && Object.keys(input).join() === 'retryPreparation' &&
          input.retryPreparation.length >= 1 && input.retryPreparation.length <= 5 &&
          input.retryPreparation.every(v => /^[a-f0-9-]{36}$/.test(v))) {
        return answer(await env.GENERATION.getByName(roomId).retryPreparation(roomId, input.retryPreparation), 202);
      }
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
      const job = (await store.records(roomId)).find(j => j.id === jobId);
      if (!job?.assets?.[kind]) return answer({error: 'NOT_READY'}, 404);
      const file = job.assets[kind], object = await env.MEDIA.get(file.path);
      if (!object?.body || object.size !== file.byteLength || object.customMetadata?.sha256 !== file.sha256) return answer({error: 'MEDIA_UNAVAILABLE'}, 503);
      return new Response(object.body, {headers: {'content-type': file.contentType, 'content-length': String(file.byteLength),
        'cache-control': 'private, no-store', 'x-content-sha256': file.sha256}});
    }
    return answer({error: 'METHOD_NOT_ALLOWED'}, 405);
  } catch (error) {
    const code = ['ACTOR_DENIED', 'ROOM_NOT_FOUND', 'JUDGE_BUDGET', 'GENERATION_DISABLED', 'SUBMISSION_NOT_FOUND',
      'PROVIDER_NOT_CONNECTED', 'PROVIDER_PERMISSION_REQUIRED', 'PROVIDER_BALANCE_REQUIRED', 'PROVIDER_PRICE_CHANGED',
      'PROVIDER_AUTHENTICATION_FAILED', 'PROVIDER_ENDPOINT_UNAVAILABLE', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE',
      'PROVIDER_TIMEOUT', 'PROVIDER_NETWORK_FAILED', 'PROVIDER_KEY_FORMAT'].includes(error.message) ? error.message : 'GENERATION_UNAVAILABLE';
    return answer({error: code, phase,
      ...(['pricing', 'billing', 'generation'].includes(error.providerPhase) ? {providerPhase: error.providerPhase} : {}),
      ...(Number.isInteger(error.providerStatus) ? {providerStatus: error.providerStatus} : {}),
    }, code === 'ACTOR_DENIED' ? 403 : code === 'JUDGE_BUDGET' ? 429 : 503);
  }
}


// Only explicitly approved, non-personal stock rooms can supply fallback scenes.
export async function sceneLibraryHttp(request, env) {
  const url = new URL(request.url);
  const match = /^\/api\/rooms\/([a-f0-9-]{36})\/(scene-library|library-media)(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET' || url.origin !== env.PUBLIC_ORIGIN || url.search ||
      request.headers.has('origin') && request.headers.get('origin') !== env.PUBLIC_ORIGIN) return answer({error: 'DENIED'}, 403);
  try {
    await createGenerationStore({db: env.DB, eventId: env.EVENT_ID}).authorize(match[1], request.headers.get('x-room-owner'), true);
    const result = await env.DB.prepare(`select g.document from vdj_runtime_records g
      join vdj_stock_sources s on s.room_id=g.room_id join vdj_rooms r on r.id=s.room_id
      where s.event_id=? and g.kind='cloud-generation' and coalesce(json_extract(r.document,'$.purged'),0)=0`).bind(env.EVENT_ID).all();
    const files = result.results.flatMap(row => {
      const job = JSON.parse(row.document);
      return sceneKeys(job).filter(key => job.assets?.[key]).map(key => job.assets[key]);
    }).slice(0, 50);
    if (match[2] === 'scene-library' && !match[3]) return answer({scenes: files.map(({sha256, duration, byteLength, contentType, width, height}) =>
      ({sha256, duration, byteLength, contentType, width, height}))});
    const file = files.find(f => f.sha256 === match[3]);
    if (!file) return answer({error: 'NOT_FOUND'}, 404);
    const object = await env.MEDIA.get(file.path);
    if (!object?.body || object.size !== file.byteLength || object.customMetadata?.sha256 !== file.sha256) return answer({error: 'MEDIA_UNAVAILABLE'}, 503);
    return new Response(object.body, {headers: {'content-type': 'video/mp4', 'content-length': String(file.byteLength),
      'cache-control': 'private, no-store', 'x-content-sha256': file.sha256}});
  } catch { return answer({error: 'DENIED'}, 403); }
}
