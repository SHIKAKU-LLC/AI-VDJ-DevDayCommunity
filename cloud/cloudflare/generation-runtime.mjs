import {createFalProvider, boundedBytes, decodeArtifact, sha256} from './fal-provider.mjs';
import {createGenerationStore} from './generation-store.mjs';
import {createProviderDelivery} from './provider-delivery.mjs';

import {partKeys, sceneKeys, mediaKind} from './generation-parts.mjs';
import {observeImage, parseImageDirection} from './image-direction.mjs';
const terminal = part => ['READY', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED'].includes(part.state);
const retryable = error => ['PROVIDER_UNAVAILABLE', 'PROVIDER_NETWORK_FAILED', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED'].includes(error?.message);
const safeReason = error => ['PROVIDER_PRICE_CHANGED', 'PROVIDER_BALANCE_REQUIRED', 'PROVIDER_PERMISSION_REQUIRED',
  'PROVIDER_RESPONSE_INVALID', 'NATIVE_RESULT_INVALID', 'NATIVE_MEASUREMENT_FAILED',
  'AUDIO_FORMAT_INVALID', 'AUDIO_QC_HOLD', 'VIDEO_FORMAT_INVALID', 'VIDEO_QC_HOLD',
  'UNIFORM_BLACK_OR_WHITE_VIDEO', 'STATIC_VIDEO_HOLD', 'RAPID_LUMA_TRANSITIONS_HOLD',
  'MEDIA_INPUT_INVALID', 'MEDIA_RESULT_INVALID', 'MEDIA_PROCESS_FAILED', 'MEDIA_PROCESS_TIMEOUT', 'MEDIA_PROCESS_RESOURCES', 'MEDIA_DECODE_FAILED', 'BOOTSTRAP_MEASUREMENT_FAILED',
  'ROOM_NOT_FOUND', 'PROVIDER_NOT_CONNECTED', 'GENERATION_DISABLED', 'IMAGE_DIRECTION_DISABLED', 'IMAGE_DIRECTION_INVALID',
  'IMAGE_DIRECTION_TIMEOUT', 'IMAGE_REFERENCE_INVALID', 'IMAGE_DIRECTION_UNCERTAIN'].includes(error?.message) ? error.message : 'GENERATION_FAILED';

// Import earlier serial jobs without resubmitting a paid request. Handles and
// SUBMITTING markers remain private and survive code deployment/object eviction.
function upgrade(job) {
  job.duration ??= 24;
  job.videoDuration ??= job.duration;
  if (job.parts?.audio) job.parts.audio.contextSeconds ??= job.parts.audio.handle?.endpoint?.includes('outpainting') ? 16 : 0;
  if (job.parts || terminal(job)) return job;
  job.parts = Object.fromEntries(partKeys(job).map(kind => {
    const prefix = kind.toUpperCase();
    const state = job.assets?.[kind] ? 'READY' : job.state === prefix + '_SUBMITTING' ? 'SUBMITTING' :
      job[kind + 'Handle'] ? 'WAIT' : 'QUEUED';
    return [kind, {state, ...(job[kind + 'Handle'] ? {handle: job[kind + 'Handle'], submittedAtMs: job.submittedAtMs,
      contextSeconds: kind === 'audio' && job[kind + 'Handle'].endpoint?.includes('outpainting') ? 16 : 0} : {})}];
  }));
  delete job.audioHandle; delete job.videoHandle;
  return job;
}
const pending = job => job.parts ? partKeys(job).some(kind => !terminal(job.parts[kind])) : !terminal(job);
function summarize(job) {
  if (!job.parts) return;
  const keys = partKeys(job), parts = keys.map(key => job.parts[key]);
  job.progress = Object.fromEntries(keys.map(key => [key, job.parts[key].state]));
  job.timings = Object.fromEntries(keys.map(key => [key, Object.fromEntries(
    ['submittedAtMs', 'completedAtMs', 'readyAtMs'].filter(k => job.parts[key][k] !== undefined)
      .map(k => [k, job.parts[key][k]]))]));
  job.failures = Object.fromEntries(keys.filter(key => ['FAILED', 'NEEDS_REVIEW'].includes(job.parts[key].state))
    .map(key => [key, {reason: job.parts[key].reason, stage: job.parts[key].stage}]));
  if (job.direction && job.direction.state !== 'READY') {
    job.state = job.direction.state === 'QUEUED' || job.direction.state === 'ANALYZING' ? 'DIRECTING' : job.direction.state;
    if (job.direction.reason) job.reason = job.direction.reason;
    return;
  }
  const videos = sceneKeys(job).map(key => job.parts[key]);
  if (job.parts.audio.state === 'READY' && (job.audioOnly || videos.some(p => p.state === 'READY'))) {
    job.state = 'READY'; job.readyAtMs ??= Math.max(...parts.filter(p => p.readyAtMs).map(p => p.readyAtMs), Date.now()); delete job.reason;
  } else if (parts.every(terminal) || ['FAILED', 'NEEDS_REVIEW'].includes(job.parts.audio.state)) {
    const problem = parts.find(p => p.state === 'NEEDS_REVIEW') ?? parts.find(p => p.state === 'FAILED');
    job.state = problem?.state ?? 'FAILED'; job.reason = problem?.reason ?? 'GENERATION_FAILED';
  } else job.state = 'GENERATING';
}

// Legacy rooms retain their existing multipart journal. New submissions use
// one instance each, so provider waits never block another participant. Media
// downloads acquire a bounded native slot before allocating large buffers.
export function createGenerationClass(Base) {
  return class GenerationRoom extends Base {
    constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; this.serial = Promise.resolve(); }
    locked(fn) { const task = this.serial.then(fn); this.serial = task.catch(() => {}); return task; }
    store() { return createGenerationStore({db: this.env.DB, eventId: this.env.EVENT_ID, normalized: this.env.AUDIENCE_MODE === 'true'}); }
    async purgeClosedRoom(roomId) {
      return this.locked(async () => {
        const requested = await this.store().purgeRequested(roomId);
        if (!requested) throw Error('ACTOR_DENIED');
        const prior = await this.ctx.storage.get('room');
        if (prior && prior !== roomId) throw Error('ACTOR_DENIED');
        const previousPurge = requested.providerPurge ? JSON.parse(requested.providerPurge) : null;
        if (requested.purged && (!previousPurge?.pending.length || !this.env.FAL_CLEANUP_KEY)) {
          await this.ctx.storage.deleteAll();
          return {purged: true, providerPurge: previousPurge};
        }
        const jobs = await this.store().records(roomId);
        const receipts = requested.purged ? previousPurge.pending.map(item => item.id) :
          [...new Set(jobs.flatMap(j => j.providerReceipts ?? []).map(r => r.requestId))];
        const providerPurge = {deleted: previousPurge?.deleted ?? 0, pending: []};
        const provider = createFalProvider({key: this.env.FAL_CLEANUP_KEY ?? this.env.FAL_KEY, fetchImpl: this.env.testFetch ?? fetch});
        for (const id of receipts) {
          try {
            const result = await provider.deleteOutputs(id);
            if (result.deleted) providerPurge.deleted++;
            else providerPurge.pending.push({id, reason: 'PROVIDER_DELETE_INCOMPLETE'});
          } catch (error) { providerPurge.pending.push({id, reason: error.message === 'PROVIDER_PERMISSION_REQUIRED' ? error.message : 'PROVIDER_DELETE_FAILED'}); }
        }
        const prefix = 'rooms/' + await sha256(JSON.stringify(roomId)) + '/';
        let cursor;
        do {
          const page = await this.env.MEDIA.list({prefix, cursor, limit: 100});
          if (page.objects.length) await this.env.MEDIA.delete(page.objects.map(object => object.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        await this.store().finishPurge(roomId, providerPurge);
        await this.ctx.storage.deleteAll();
        return {purged: true, providerPurge};
      });
    }
    async saveAsset(job, name, artifact, duration, dimensions = {}) {
      await this.store().active(job.roomId);
      const limit = name.startsWith('video') ? 16 : name === 'audio' ? 12 : 3;
      const decoded = decodeArtifact(artifact, limit * 1024 * 1024), hash = await sha256(decoded);
      if (hash !== artifact.sha256) throw Error('NATIVE_RESULT_INVALID');
      const path = 'rooms/' + await sha256(JSON.stringify(job.roomId)) + '/assets/' + hash + '.media';
      const contentType = name.startsWith('video') ? 'video/mp4' : 'audio/wav';
      if (!await this.env.MEDIA.head(path)) await this.env.MEDIA.put(path, decoded,
        {onlyIf: {etagDoesNotMatch: '*'}, httpMetadata: {contentType}, customMetadata: {sha256: hash}});
      job.assets ??= {};
      job.assets[name] = {...(name.startsWith('video') ? dimensions : {}), path, sha256: hash, byteLength: decoded.length, contentType, duration};
    }
    async enqueue(roomId, submissionIds) {
      return this.locked(async () => {
        if (this.env.GENERATION_ENABLED !== 'true' || !this.env.FAL_KEY) throw Error('GENERATION_DISABLED');
        const priorRoom = await this.ctx.storage.get('room');
        if (priorRoom && priorRoom !== roomId) throw Error('ROOM_NOT_FOUND');
        await this.ctx.storage.put('room', roomId);
        const jobs = await this.ctx.storage.get('jobs') ?? [];
        for (const id of submissionIds.slice(0, 5)) {
          const job = await this.store().enqueue(roomId, id, {imageDirectionEnabled: this.env.IMAGE_DIRECTION_ENABLED === 'true' && !!this.env.AI?.run});
          if (!jobs.some(j => j.id === id)) {
            jobs.push(job);
            await this.ctx.storage.put('jobs', jobs);
          }
          if (jobs.some(pending) && !await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 100);
        }
        return {accepted: jobs.length};
      });
    }
    async retryPreparation(roomId, ids) {
      return this.locked(async () => {
        await this.store().active(roomId);
        if (await this.ctx.storage.get('room') !== roomId) throw Error('ROOM_NOT_FOUND');
        const jobs = await this.ctx.storage.get('jobs') ?? [];
        let resumed = 0;
        for (const job of jobs.filter(j => ids.includes(j.id))) {
          if (job.direction?.state === 'FAILED' && job.direction.reason === 'IMAGE_DIRECTION_INVALID' &&
              (job.imageResponse || (job.direction.attempts ?? 1) < 3) && !job.providerReceipts?.length &&
              Object.values(job.parts ?? {}).every(part => part.state === 'CANCELLED')) {
            job.direction = {state: 'QUEUED', attempts: job.direction.attempts ?? 1};
            for (const part of Object.values(job.parts)) part.state = 'QUEUED';
            delete job.reason; summarize(job); await this.store().save(job); resumed++;
            continue;
          }
          let resumedAudio = false;
          for (const part of Object.values(job.parts ?? {})) {
            if (part.state !== 'FAILED' || !part.handle || !part.completedAtMs || (part.preparationRetries ?? 0) >= 2) continue;
            part.state = 'PREPARING'; part.preparationRetries = (part.preparationRetries ?? 0) + 1;
            delete part.reason; resumed++;
            if (part === job.parts.audio) resumedAudio = true;
          }
          // These scenes were never submitted or charged. Restore them only
          // when the owner explicitly retries the existing audio receipt.
          if (resumedAudio) for (const key of sceneKeys(job)) {
            if (job.parts[key].state === 'CANCELLED') job.parts[key].state = 'QUEUED';
          }
          delete job.reason; summarize(job); await this.store().save(job);
        }
        await this.ctx.storage.put('jobs', jobs);
        if (resumed) await this.ctx.storage.setAlarm(Date.now() + 100);
        return {resumed};
      });
    }
    async prepare(job, key, provider) {
      const kind = mediaKind(key), part = job.parts[key];
      part.stage = 'result';
      const result = await provider.result(part.handle);
      // URLs stay transient. Only vetted bytes and hashes enter R2.
      part.stage = 'download';
      const duration = kind === 'audio' ? job.duration : job.videoDuration;
      let native;
      const lease = crypto.randomUUID();
      if (this.env.NATIVE_POOL_SIZE) {
        const count = Math.min(4, Math.max(1, Number(this.env.NATIVE_POOL_SIZE) || 1));
        const start = parseInt(job.id.replaceAll('-', '').slice(0, 8), 16) % count;
        for (let n = 0; n < count; n++) {
          const candidate = this.env.NATIVE_PROCESSOR.getByName('cloud-media-v10-' + ((start + n) % count));
          if (await candidate.reserve(lease)) { native = candidate; break; }
        }
        if (!native) return false;
      } else native = this.env.NATIVE_PROCESSOR.getByName('cloud-media-v9');
      part.stage = 'native';
      try {
      const bytes = await provider.download(result[kind]?.url);
      const response = await native.fetch(new Request('http://native.internal/prepare/' + kind,
        {method: 'POST', headers: {'content-type': 'application/octet-stream', 'x-vdj-duration-seconds': String(duration),
          'x-vdj-context-seconds': String(part.contextSeconds ?? 0), 'x-vdj-media-profile': job.mediaProfile ?? 'legacy', 'x-vdj-preparation-lease': lease}, body: bytes, signal: AbortSignal.timeout(150000)}));
      if (response.status === 409 || response.status === 503) { await response.body?.cancel(); return false; }
      if (!response.ok) { const problem = await response.json().catch(() => ({})); throw Error(safeReason({message: problem.error})); }
      part.stage = 'validate';
      const prepared = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 24 * 1024 * 1024)));
      if (prepared.duration !== duration || prepared.quality?.passed !== true) throw Error('NATIVE_RESULT_INVALID');
      if (kind === 'video' && ![[854, 480], [1920, 1080], [1920, 1088]].some(([w, h]) => (prepared.width ?? 854) === w && (prepared.height ?? 480) === h)) throw Error('NATIVE_RESULT_INVALID');
      job.quality ??= {};
      job.quality[key] = prepared.quality;
      part.stage = 'store';
      await this.saveAsset(job, key, prepared[kind], duration, {width: prepared.width ?? 854, height: prepared.height ?? 480});
      if (kind === 'audio') await this.saveAsset(job, 'context', prepared.context, Math.min(16, job.duration));
      part.state = 'READY'; part.readyAtMs = Date.now(); delete part.handle;
      return true;
      } finally { if (this.env.NATIVE_POOL_SIZE) await native.release(lease); }
    }
    async directImage(job, persist) {
      if (!job.reference || job.direction?.state === 'READY') return;
      job.direction ??= {state: 'QUEUED'};
      if (job.direction.state === 'ANALYZING') {
        // A lost response may already have been charged. Never buy it again.
        job.direction = {state: 'NEEDS_REVIEW', reason: 'IMAGE_DIRECTION_UNCERTAIN'};
      } else if (job.direction.state === 'QUEUED') {
        const attempts = (job.direction.attempts ?? 0) + (job.imageResponse ? 0 : 1);
        try {
          if (this.env.IMAGE_DIRECTION_ENABLED !== 'true' || !this.env.AI?.run) throw Error('IMAGE_DIRECTION_DISABLED');
          const object = await this.env.MEDIA.get(job.reference.path);
          if (!object?.body || object.size !== job.reference.byteLength || object.customMetadata?.sha256 !== job.reference.sha256) throw Error('IMAGE_REFERENCE_INVALID');
          const bytes = await boundedBytes(new Response(object.body), 2 * 1024 * 1024);
          if (await sha256(bytes) !== job.reference.sha256) throw Error('IMAGE_REFERENCE_INVALID');
          job.direction = {state: 'ANALYZING', attempts}; await persist(job);
          const plan = job.imageResponse ? parseImageDirection(job.imageResponse) : await observeImage(this.env.AI, bytes,
            async result => {job.imageResponse=result; await persist(job);});
          job.direction = {state: 'READY', plan, attempts};
          delete job.imageResponse;
        } catch (error) {
          const uncertain = job.direction.state === 'ANALYZING' && error.message !== 'IMAGE_DIRECTION_INVALID';
          job.direction = {state: uncertain ? 'NEEDS_REVIEW' : 'FAILED',
            reason: uncertain ? 'IMAGE_DIRECTION_UNCERTAIN' : safeReason(error), attempts,
            ...(['ANSWER_TYPE','JSON_SYNTAX','OBJECT','FIELDS','KIND','SUBJECT','SUMMARY','FEATURES','PALETTE'].includes(error.diagnostic) ? {diagnostic:error.diagnostic,responseShape:error.responseShape} : {})};
        }
      }
      if (job.direction.state !== 'READY') {
        for (const part of Object.values(job.parts)) if (!terminal(part)) part.state = 'CANCELLED';
      }
      await persist(job);
    }
    async alarm() {
      return this.locked(async () => {
        const jobs = (await this.ctx.storage.get('jobs') ?? []).map(upgrade);
        const roomId = await this.ctx.storage.get('room');
        if (roomId && await this.store().purgeRequested(roomId)) { await this.ctx.storage.deleteAlarm(); return; }
        const active = jobs.filter(pending).slice(0, this.env.AUDIENCE_MODE === 'true' ? 38 : 5);
        if (!active.length) return;
        // Persist a recovery alarm before any external I/O. Cloudflare runs only
        // one alarm at a time, including retries after object interruption.
        await this.ctx.storage.setAlarm(Date.now() + 5000);
        let writes = Promise.resolve();
        const persist = job => {
          summarize(job);
          writes = writes.then(async () => {
            await this.ctx.storage.put('jobs', jobs);
            await this.store().save(job);
          });
          return writes;
        };
        const rejectPart = (part, error) => {
          if (part.state === 'SUBMITTING') { part.state = 'NEEDS_REVIEW'; part.reason = 'PROVIDER_SUBMISSION_UNCERTAIN'; }
          else if (retryable(error) && (part.readFailures ?? 0) < 6) part.readFailures = (part.readFailures ?? 0) + 1;
          else { part.state = 'FAILED'; part.reason = safeReason(error); }
        };
        let provider; const preflights = new Map();
        try {
          await this.store().active(active[0].roomId);
          if (this.env.GENERATION_ENABLED !== 'true') throw Error('GENERATION_DISABLED');
          provider = createFalProvider({key: this.env.FAL_KEY, fetchImpl: this.env.testFetch ?? fetch});
          if (this.env.AUDIENCE_MODE === 'true' && this.env.AUDIENCE_ROOMS) provider.preflight = options => this.env.AUDIENCE_ROOMS.getByName(roomId).checkPrice(options);
        } catch (error) {
          for (const job of active) {
            for (const kind of partKeys(job)) if (!terminal(job.parts[kind])) {
              const part = job.parts[kind]; part.state = 'FAILED'; part.reason = safeReason(error);
            }
            await persist(job);
          }
          return;
        }
        // Optional image interpretation runs once per reserved set. Text-only
        // jobs skip it entirely and keep the original parallel generation path.
        const directing = active.filter(job => job.reference && ['QUEUED', 'ANALYZING'].includes(job.direction?.state)).slice(0, 2);
        await Promise.all(directing.map(async job => {
          if (job.reference && job.direction?.state === 'QUEUED') {
            try {
              if (!preflights.has('reference')) preflights.set('reference', provider.preflight({duration: job.duration, reference: true}));
              await preflights.get('reference');
            } catch (error) { job.direction = {state: 'FAILED', reason: safeReason(error)}; }
          }
          await this.directImage(job, persist);
        }));
        // A batch shares the most recent completed musical context. Waiting for
        // each new song's context would serialize the entire batch again.
        const context = jobs.filter(j => j.duration > 12 && j.assets?.context && j.state === 'READY').at(-1)?.assets.context;
        const advance = async (job, key) => {
          const kind = mediaKind(key), part = job.parts[key];
          if (terminal(part)) return;
          if (job.reference && job.direction?.state !== 'READY') return;
          try {
            if (part.state === 'SUBMITTING') {
              part.state = 'NEEDS_REVIEW'; part.reason = 'PROVIDER_SUBMISSION_UNCERTAIN';
            } else if (part.state === 'QUEUED') {
              if (['FAILED', 'NEEDS_REVIEW'].includes(job.parts.audio.state)) { part.state = 'CANCELLED'; }
              else {
                const preflightKey = `${job.duration}:${!!job.reference}`;
                if (!preflights.has(preflightKey)) preflights.set(preflightKey, provider.preflight({duration: job.duration, reference: !!job.reference, audioOnly:!!job.audioOnly}));
                await preflights.get(preflightKey);
                let contextUrl;
                if (kind === 'audio' && context) contextUrl = (await createProviderDelivery({db: this.env.DB,
                  bucket: this.env.MEDIA, eventId: this.env.EVENT_ID, origin: this.env.PUBLIC_ORIGIN, maximumGrants:this.env.AUDIENCE_MODE==='true'?200:50})
                  .issue({roomId: job.roomId, path: context.path, expiresIn: 3600})).url;
                part.contextSeconds = contextUrl ? context.duration : 0;
                let referenceUrl;
                if (kind === 'video' && job.reference) referenceUrl = (await createProviderDelivery({db: this.env.DB,
                  bucket: this.env.MEDIA, eventId: this.env.EVENT_ID, origin: this.env.PUBLIC_ORIGIN, maximumGrants:this.env.AUDIENCE_MODE==='true'?200:50})
                  .issue({roomId: job.roomId, path: job.reference.path, expiresIn: 3600})).url;
                part.state = 'SUBMITTING'; await persist(job);
                await this.store().active(job.roomId);
                // Never automatically retry this POST: a lost receipt is held.
                part.handle = await provider.submit(kind, job.prompt, contextUrl, {duration: kind === 'audio' ? job.duration : job.videoDuration, mediaProfile: job.mediaProfile ?? 'legacy', sceneIndex: sceneKeys(job).indexOf(key),
                  ...(referenceUrl ? {referenceUrl, reference: job.direction.plan} : {})});
                part.state = 'WAIT'; part.submittedAtMs = Date.now();
                job.providerReceipts ??= [];
                job.providerReceipts.push({kind, endpoint: part.handle.endpoint, requestId: part.handle.id});
              }
            } else if (part.state === 'WAIT') {
              if (Date.now() - part.submittedAtMs > 20 * 60000) throw Error('GENERATION_TIMEOUT');
              const status = await provider.status(part.handle);
              if (status.status === 'COMPLETED') { part.state = 'PREPARING'; part.completedAtMs = Date.now(); }
              else if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw Error('GENERATION_FAILED');
            }
          } catch (error) { rejectPart(part, error); }
          await persist(job);
        };
        const all = active.flatMap(job => partKeys(job).map(key => ({job, key})));
        const waiting = all.filter(({job, key}) => ['WAIT', 'SUBMITTING'].includes(job.parts[key].state));
        await Promise.all(waiting.map(({job, key}) => advance(job, key)));
        const inFlight = all.filter(({job, key}) => ['WAIT', 'SUBMITTING'].includes(job.parts[key].state)).length;
        const queued = all.filter(({job, key}) => job.parts[key].state === 'QUEUED' && (!job.reference || job.direction?.state === 'READY'))
          .sort((a, b) => partKeys(a.job).indexOf(a.key) - partKeys(b.job).indexOf(b.key));
        await Promise.all(queued.slice(0, Math.max(0, (this.env.AUDIENCE_MODE === 'true' ? 30 : 8) - inFlight)).map(({job, key}) => advance(job, key)));
        // No provider POST is held behind a media download or native QC request.
        // At most two files per alarm bound duration and memory, and resuming
        // PREPARING after restart only re-reads the existing provider receipt.
        let prepared = 0;
        for (const {job, key: kind} of [...all].sort((a, b) => partKeys(a.job).indexOf(a.key) - partKeys(b.job).indexOf(b.key))) {
          const part = job.parts[kind];
          if (part.state !== 'PREPARING' || prepared >= 2) continue;
          prepared++;
          try {
            if (!await this.prepare(job, kind, provider)) { prepared = 2; }
          } catch (error) { rejectPart(part, error); }
          await persist(job);
        }
        if (jobs.some(pending)) await this.ctx.storage.setAlarm(Date.now() + (jobs.some(j => partKeys(j).some(k => j.parts?.[k]?.state === 'PREPARING')) ? 100 : 2000));
        else await this.ctx.storage.deleteAlarm();
      });
    }
  };
}
