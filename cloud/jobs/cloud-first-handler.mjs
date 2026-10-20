import {DispatchError} from '../generation/dispatch.mjs';
import {createCueHandler} from '../generation/cue-http.mjs';
import {createCloudJobHandler, createCloudMediaHandler, createCloudMediaManifestHandler} from './http.mjs';

// Optional local assembly for an existing host. It does not replace the cloud
// production entry, create provider clients or grant capabilities. Activation
// is false even if an injected test jobs/coordinator happens to be enabled.
export function createCloudFirstHandler({enabled = false, jobs, coordinator, roomProjection,
  mediaPorts = {}, fallback, origin = 'https://ai-vdj.vercel.app'} = {}) {
  const denied = () => { throw new DispatchError('CLOUD_FIRST_NOT_ACTIVATED'); };
  const jobBoundary = jobs ? createCloudJobHandler({origin, jobs: {
    read: input => jobs.read(input), start: enabled ? input => jobs.start(input) : denied,
    advance: enabled ? input => jobs.advance(input) : denied, stop: enabled ? input => jobs.stop(input) : denied}}) : null;
  const cueBoundary = coordinator && enabled ? createCueHandler({origin, coordinator}) : null;
  const mediaBoundary = createCloudMediaHandler({...mediaPorts, origin});
  const manifestBoundary = createCloudMediaManifestHandler({...mediaPorts, enabled, origin});
  const reply = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
  const attachmentBody = async request => {
    const reader = request.body?.getReader(), parts = []; let size = 0;
    if (reader) while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024) { await reader.cancel(); throw new DispatchError('BODY_TOO_LARGE'); }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  };
  return async request => {
    const url = new URL(request.url), path = url.pathname;
    const attachment = path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/jobs\/attachment$/i);
    if (attachment) {
      if (request.headers.get('origin') !== origin || request.headers.has('authorization') || request.headers.has('x-fal-key') ||
          !/^[a-f0-9]{64}$/.test(request.headers.get('x-room-owner') ?? '')) return reply({error: 'OWNER_OR_ORIGIN_DENIED'}, 403);
      if (request.method !== 'POST') return reply({error: 'POST_REQUIRED'}, 405);
      if (!roomProjection) return reply({error: 'ROOM_PROJECTION_NOT_CONFIGURED'}, 503);
      if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({error: 'JSON_REQUIRED'}, 415);
      try {
        const body = await attachmentBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'submissionId'))
          return reply({error: 'SERVER_ATTACHMENT_IDS_ONLY'}, 400);
        return reply(await roomProjection.prepare({roomId: attachment[1], ownerCapability: request.headers.get('x-room-owner'), submissionId: body.submissionId}));
      } catch (error) { return reply({error: error instanceof DispatchError ? error.code : 'ROOM_ATTACHMENT_HOLD'}, error?.code === 'BODY_TOO_LARGE' ? 413 : 409); }
    }
    const room = path.match(/^\/api\/rooms\/([a-f0-9-]{36})(?:\/(?:submissions\/([A-Za-z0-9_-]{1,100})|(events)))?$/i);
    if (room && request.method === 'GET' && roomProjection) {
      const from = request.headers.get('origin');
      if (from !== origin && !(from === null && request.headers.get('sec-fetch-site') === 'same-origin')) return reply({error: 'ORIGIN_DENIED'}, 403);
      if (request.headers.has('x-fal-key')) return reply({error: 'ROOM_ACTOR_REQUIRED'}, 403);
      const ownerCapability = request.headers.get('x-room-owner'), participantCapability = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!!ownerCapability === !!participantCapability || ownerCapability && request.headers.has('authorization')) return reply({error: 'ROOM_ACTOR_REQUIRED'}, 403);
      try {
        const input = {roomId: room[1], ...(ownerCapability ? {ownerCapability} : {participantCapability})};
        if (room[3] === 'events') {
          if (typeof fallback !== 'function') return reply({error: 'EVENT_FEED_NOT_CONFIGURED'}, 503);
          // Preserve existing proof/cursor checks. The authenticated feed is a
          // wake-up hint; replace its old snapshot with an authoritative view.
          const upstream = await fallback(request);
          if (!upstream || !upstream.ok) return upstream ?? reply({error: 'EVENT_FEED_NOT_CONFIGURED'}, 503);
          const feed = await upstream.json();
          if (!Array.isArray(feed?.events) || feed.events.length > 100) throw new DispatchError('EVENT_FEED_INVALID');
          const snapshot = await roomProjection.readRoom(input);
          const kinds = new Set(['room.changed', 'submission.changed', 'job.changed', 'cue.changed', 'participantCredit', 'submission', 'owner-control']);
          const events = feed.events.map(event => ({type: kinds.has(event?.type ?? event?.kind) ? event.type ?? event.kind : 'room.changed',
            ...(Number.isSafeInteger(event?.seq) && event.seq >= 0 ? {seq: event.seq} : {}),
            ...(Number.isSafeInteger(event?.eventSeq) && event.eventSeq >= 0 ? {eventSeq: event.eventSeq} : {}), hint: true}));
          return reply({eventSeq: snapshot.eventSeq, events, snapshot});
        }
        return reply(await (room[2] ? roomProjection.readSubmission({...input, submissionId: room[2]}) : roomProjection.readRoom(input)));
      } catch (error) { return reply({error: error instanceof DispatchError ? error.code : 'ROOM_PROJECTION_HOLD'}, 409); }
    }
    if (!enabled && /^\/api\/rooms\/[a-f0-9-]{36}\/(?:cues(?:\/|$)|media\/|cloud\/media\/)/i.test(path))
      return reply({error: 'CLOUD_FIRST_NOT_ACTIVATED'}, 503);
    for (const handler of [jobBoundary, cueBoundary, manifestBoundary, mediaBoundary]) {
      if (!handler) continue; const result = await handler(request); if (result) return result;
    }
    return typeof fallback === 'function' ? fallback(request) : null;
  };
}
