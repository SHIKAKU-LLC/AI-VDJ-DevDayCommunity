import {createFalProvider, boundedBytes, decodeArtifact, sha256} from './fal-provider.mjs';
import {createGenerationStore} from './generation-store.mjs';
import {createProviderDelivery} from './provider-delivery.mjs';

const terminal = job => ['READY', 'FAILED', 'NEEDS_REVIEW'].includes(job.state);
const safeReason = error => ['PROVIDER_PRICE_CHANGED', 'PROVIDER_BALANCE_REQUIRED', 'PROVIDER_PERMISSION_REQUIRED',
  'ROOM_NOT_FOUND', 'PROVIDER_NOT_CONNECTED', 'GENERATION_DISABLED'].includes(error?.message) ? error.message : 'GENERATION_FAILED';

// One durable coordinator per room. Provider POST markers are persisted before
// network I/O; an unknown outcome is held for review instead of resubmitted.
export function createGenerationClass(Base) {
  return class GenerationRoom extends Base {
    constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; this.serial = Promise.resolve(); }
    locked(fn) { const task = this.serial.then(fn); this.serial = task.catch(() => {}); return task; }
    store() { return createGenerationStore({db: this.env.DB, eventId: this.env.EVENT_ID}); }
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
          if (jobs.some(j => !terminal(j)) && !await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 100);
        }
        if (jobs.some(j => !terminal(j)) && !await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 100);
        return {accepted: jobs.length};
      });
    }
    async alarm() {
      return this.locked(async () => {
        const jobs = await this.ctx.storage.get('jobs') ?? [];
        const job = jobs.find(j => !terminal(j));
        if (!job) return;
        const persist = async () => { await this.ctx.storage.put('jobs', jobs); await this.store().save(job); };
        try {
          await this.store().active(job.roomId);
          if (this.env.GENERATION_ENABLED !== 'true') throw Error('GENERATION_DISABLED');
          const provider = createFalProvider({key: this.env.FAL_KEY, fetchImpl: this.env.testFetch ?? fetch});
          if (job.state.endsWith('_SUBMITTING')) {
            job.state = 'NEEDS_REVIEW'; job.reason = 'PROVIDER_SUBMISSION_UNCERTAIN';
          } else if (job.state === 'QUEUED' || job.state === 'AUDIO_READY') {
            const kind = job.state === 'QUEUED' ? 'audio' : 'video';
            await provider.preflight();
            let contextUrl;
            if (kind === 'audio') {
              const previous = jobs.filter(j => j.state === 'READY').at(-1);
              if (previous) contextUrl = (await createProviderDelivery({db: this.env.DB, bucket: this.env.MEDIA,
                eventId: this.env.EVENT_ID, origin: this.env.PUBLIC_ORIGIN}).issue({roomId: job.roomId, path: previous.assets.context.path, expiresIn: 3600})).url;
            }
            job.state = kind.toUpperCase() + '_SUBMITTING';
            await persist();
            // Never catch-and-retry this POST. A lost receipt leaves SUBMITTING.
            job[kind + 'Handle'] = await provider.submit(kind, job.prompt, contextUrl);
            job.providerReceipts ??= [];
            job.providerReceipts.push({kind, endpoint: job[kind + 'Handle'].endpoint, requestId: job[kind + 'Handle'].id});
            job.state = kind.toUpperCase() + '_WAIT'; job.submittedAtMs = Date.now();
          } else if (job.state.endsWith('_WAIT')) {
            if (Date.now() - job.submittedAtMs > 20 * 60000) throw Error('GENERATION_TIMEOUT');
            const kind = job.state === 'AUDIO_WAIT' ? 'audio' : 'video';
            const status = await provider.status(job[kind + 'Handle']);
            if (status.status === 'COMPLETED') {
              const result = await provider.result(job[kind + 'Handle']);
              // URLs stay transient. Only vetted bytes and hashes enter R2.
              const bytes = await provider.download(result[kind]?.url);
              const native = this.env.NATIVE_PROCESSOR.getByName('cloud-media-v1');
              const response = await native.fetch(new Request('http://native.internal/prepare/' + kind,
                {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: bytes, signal: AbortSignal.timeout(150000)}));
              if (response.status === 409 || response.status === 503) {
                await response.body?.cancel();
                await this.ctx.storage.setAlarm(Date.now() + 10000); return;
              }
              if (!response.ok) { await response.body?.cancel(); throw Error('NATIVE_PREPARE_FAILED'); }
              const prepared = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16 * 1024 * 1024)));
              job.assets ??= {};
              for (const name of kind === 'audio' ? ['audio', 'context'] : ['video']) {
                const decoded = decodeArtifact(prepared[name], name === 'video' ? 8 * 1024 * 1024 : 5 * 1024 * 1024);
                const hash = await sha256(decoded);
                if (hash !== prepared[name].sha256) throw Error('NATIVE_RESULT_INVALID');
                const path = 'rooms/' + await sha256(JSON.stringify(job.roomId)) + '/assets/' + hash + '.media';
                const contentType = name === 'video' ? 'video/mp4' : 'audio/wav';
                const existing = await this.env.MEDIA.head(path);
                if (!existing) await this.env.MEDIA.put(path, decoded, {onlyIf: {etagDoesNotMatch: '*'}, httpMetadata: {contentType}, customMetadata: {sha256: hash}});
                job.assets[name] = {path, sha256: hash, byteLength: decoded.length, contentType, duration: name === 'context' ? 16 : prepared.duration};
              }
              delete job[kind + 'Handle'];
              job.state = kind === 'audio' ? 'AUDIO_READY' : 'READY';
            } else if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw Error('GENERATION_FAILED');
          }
        } catch (error) {
          if (job.state.endsWith('_SUBMITTING')) { job.state = 'NEEDS_REVIEW'; job.reason = 'PROVIDER_SUBMISSION_UNCERTAIN'; }
          else if (job.state.endsWith('_WAIT') && error.message === 'PROVIDER_UNAVAILABLE' && (job.readFailures ?? 0) < 6) {
            // Read-only retries keep the original request handle. They cannot
            // repeat the paid POST and survive an object restart.
            job.readFailures = (job.readFailures ?? 0) + 1;
          }
          else { job.state = 'FAILED'; job.reason = safeReason(error); }
        }
        await persist();
        if (jobs.some(j => !terminal(j))) await this.ctx.storage.setAlarm(Date.now() + 5000);
      });
    }
  };
}
