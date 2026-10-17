import {createFalProvider, boundedBytes, decodeArtifact, sha256} from './fal-provider.mjs';
import {createGenerationStore} from './generation-store.mjs';
import {createProviderDelivery} from './provider-delivery.mjs';

const kinds = ['audio', 'video'];
const terminal = part => ['READY', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED'].includes(part.state);
const retryable = error => ['PROVIDER_UNAVAILABLE', 'PROVIDER_NETWORK_FAILED', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED'].includes(error?.message);
const safeReason = error => ['PROVIDER_PRICE_CHANGED', 'PROVIDER_BALANCE_REQUIRED', 'PROVIDER_PERMISSION_REQUIRED',
  'ROOM_NOT_FOUND', 'PROVIDER_NOT_CONNECTED', 'GENERATION_DISABLED'].includes(error?.message) ? error.message : 'GENERATION_FAILED';

// Import earlier serial jobs without resubmitting a paid request. Handles and
// SUBMITTING markers remain private and survive code deployment/object eviction.
function upgrade(job) {
  job.duration ??= 24;
  if (job.parts?.audio) job.parts.audio.contextSeconds ??= job.parts.audio.handle?.endpoint?.includes('outpainting') ? 16 : 0;
  if (job.parts || terminal(job)) return job;
  job.parts = Object.fromEntries(kinds.map(kind => {
    const prefix = kind.toUpperCase();
    const state = job.assets?.[kind] ? 'READY' : job.state === prefix + '_SUBMITTING' ? 'SUBMITTING' :
      job[kind + 'Handle'] ? 'WAIT' : 'QUEUED';
    return [kind, {state, ...(job[kind + 'Handle'] ? {handle: job[kind + 'Handle'], submittedAtMs: job.submittedAtMs,
      contextSeconds: kind === 'audio' && job[kind + 'Handle'].endpoint?.includes('outpainting') ? 16 : 0} : {})}];
  }));
  delete job.audioHandle; delete job.videoHandle;
  return job;
}
const pending = job => job.parts ? kinds.some(kind => !terminal(job.parts[kind])) : !terminal(job);
function summarize(job) {
  if (!job.parts) return;
  const parts = kinds.map(kind => job.parts[kind]);
  job.progress = Object.fromEntries(kinds.map(kind => [kind, job.parts[kind].state]));
  job.timings = Object.fromEntries(kinds.map(kind => [kind, Object.fromEntries(
    ['submittedAtMs', 'completedAtMs', 'readyAtMs'].filter(key => job.parts[kind][key] !== undefined)
      .map(key => [key, job.parts[kind][key]]))]));
  if (parts.every(terminal)) {
    const problem = parts.find(p => p.state === 'NEEDS_REVIEW') ?? parts.find(p => p.state === 'FAILED');
    job.state = problem?.state ?? 'READY';
    if (problem) job.reason = problem.reason;
  } else job.state = 'GENERATING';
}

// One coordinator per room, up to five sets and two independent provider jobs
// per set. Small provider requests run together; large media preparation is
// serialized so five downloads/transcodes cannot exhaust the Worker heap.
export function createGenerationClass(Base) {
  return class GenerationRoom extends Base {
    constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; this.serial = Promise.resolve(); }
    locked(fn) { const task = this.serial.then(fn); this.serial = task.catch(() => {}); return task; }
    store() { return createGenerationStore({db: this.env.DB, eventId: this.env.EVENT_ID}); }
    async saveAsset(job, name, artifact, duration) {
      const limit = name === 'video' ? 16 : 5;
      const decoded = decodeArtifact(artifact, limit * 1024 * 1024), hash = await sha256(decoded);
      if (hash !== artifact.sha256) throw Error('NATIVE_RESULT_INVALID');
      const path = 'rooms/' + await sha256(JSON.stringify(job.roomId)) + '/assets/' + hash + '.media';
      const contentType = name === 'video' ? 'video/mp4' : 'audio/wav';
      if (!await this.env.MEDIA.head(path)) await this.env.MEDIA.put(path, decoded,
        {onlyIf: {etagDoesNotMatch: '*'}, httpMetadata: {contentType}, customMetadata: {sha256: hash}});
      job.assets ??= {};
      job.assets[name] = {path, sha256: hash, byteLength: decoded.length, contentType, duration};
    }
    async enqueue(roomId, submissionIds) {
      return this.locked(async () => {
        if (this.env.GENERATION_ENABLED !== 'true' || !this.env.FAL_KEY) throw Error('GENERATION_DISABLED');
        const priorRoom = await this.ctx.storage.get('room');
        if (priorRoom && priorRoom !== roomId) throw Error('ROOM_NOT_FOUND');
        await this.ctx.storage.put('room', roomId);
        const jobs = await this.ctx.storage.get('jobs') ?? [];
        for (const id of submissionIds.slice(0, 5)) {
          const job = await this.store().enqueue(roomId, id);
          if (!jobs.some(j => j.id === id)) {
            jobs.push(job);
            await this.ctx.storage.put('jobs', jobs);
          }
          if (jobs.some(pending) && !await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 100);
        }
        return {accepted: jobs.length};
      });
    }
    async prepare(job, kind, provider) {
      const part = job.parts[kind];
      const result = await provider.result(part.handle);
      // URLs stay transient. Only vetted bytes and hashes enter R2.
      const bytes = await provider.download(result[kind]?.url);
      const native = this.env.NATIVE_PROCESSOR.getByName('cloud-media-v4');
      const response = await native.fetch(new Request('http://native.internal/prepare/' + kind,
        {method: 'POST', headers: {'content-type': 'application/octet-stream', 'x-vdj-duration-seconds': String(job.duration),
          'x-vdj-context-seconds': String(part.contextSeconds ?? 0)}, body: bytes, signal: AbortSignal.timeout(150000)}));
      if (response.status === 409 || response.status === 503) { await response.body?.cancel(); return false; }
      if (!response.ok) { await response.body?.cancel(); throw Error('NATIVE_PREPARE_FAILED'); }
      const prepared = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 24 * 1024 * 1024)));
      if (prepared.duration !== job.duration || prepared.quality?.passed !== true) throw Error('NATIVE_RESULT_INVALID');
      job.quality ??= {};
      job.quality[kind] = prepared.quality;
      await this.saveAsset(job, kind, prepared[kind], job.duration);
      if (kind === 'audio') await this.saveAsset(job, 'context', prepared.context, Math.min(16, job.duration));
      part.state = 'READY'; part.readyAtMs = Date.now(); delete part.handle;
      return true;
    }
    async alarm() {
      return this.locked(async () => {
        const jobs = (await this.ctx.storage.get('jobs') ?? []).map(upgrade);
        const active = jobs.filter(pending).slice(0, 5);
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
        } catch (error) {
          for (const job of active) {
            for (const kind of kinds) if (!terminal(job.parts[kind])) {
              const part = job.parts[kind]; part.state = 'FAILED'; part.reason = safeReason(error);
            }
            await persist(job);
          }
          return;
        }
        // A batch shares the most recent completed musical context. Waiting for
        // each new song's context would serialize the entire batch again.
        const context = jobs.filter(j => j.assets?.context && j.state === 'READY').at(-1)?.assets.context;
        const advance = async (job, kind) => {
          const part = job.parts[kind];
          if (terminal(part)) return;
          try {
            if (part.state === 'SUBMITTING') {
              part.state = 'NEEDS_REVIEW'; part.reason = 'PROVIDER_SUBMISSION_UNCERTAIN';
            } else if (part.state === 'QUEUED') {
              if (kinds.some(k => ['FAILED', 'NEEDS_REVIEW'].includes(job.parts[k].state))) { part.state = 'CANCELLED'; }
              else {
                if (!preflights.has(job.duration)) preflights.set(job.duration, provider.preflight({duration: job.duration}));
                await preflights.get(job.duration);
                let contextUrl;
                if (kind === 'audio' && context) contextUrl = (await createProviderDelivery({db: this.env.DB,
                  bucket: this.env.MEDIA, eventId: this.env.EVENT_ID, origin: this.env.PUBLIC_ORIGIN})
                  .issue({roomId: job.roomId, path: context.path, expiresIn: 3600})).url;
                part.contextSeconds = contextUrl ? context.duration : 0;
                part.state = 'SUBMITTING'; await persist(job);
                // Never automatically retry this POST: a lost receipt is held.
                part.handle = await provider.submit(kind, job.prompt, contextUrl, {duration: job.duration});
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
        await Promise.all(active.flatMap(job => kinds.map(kind => advance(job, kind))));
        // No provider POST is held behind a media download or native QC request.
        // At most two files per alarm bound duration and memory, and resuming
        // PREPARING after restart only re-reads the existing provider receipt.
        let prepared = 0;
        for (const job of active) for (const kind of kinds) {
          const part = job.parts[kind];
          if (part.state !== 'PREPARING' || prepared >= 2) continue;
          prepared++;
          try {
            if (!await this.prepare(job, kind, provider)) { prepared = 2; }
          } catch (error) { rejectPart(part, error); }
          await persist(job);
        }
        if (jobs.some(pending)) await this.ctx.storage.setAlarm(Date.now() + 5000);
        else await this.ctx.storage.deleteAlarm();
      });
    }
  };
}
