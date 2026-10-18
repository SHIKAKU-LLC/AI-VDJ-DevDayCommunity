import {createGenerationClass} from './generation-runtime.mjs';
import {publicAssets} from './generation-parts.mjs';

const terminal = job => ['READY','FAILED','NEEDS_REVIEW','CANCELLED'].includes(job.state);

// Reuse the registered GenerationRoom class in a separate per-room namespace.
// Its journal, provider receipts and alarms have the same recovery guarantees
// as participant generation; no browser holds a provider key or paid receipt.
export function createSoundtrackClass(Base) {
  return class extends createGenerationClass(Base) {
    async soundtrack(roomId, input) {
      return this.locked(async () => {
        if (this.env.INDEPENDENT_AUDIO !== 'true') throw Error('SOUNDTRACK_DISABLED');
        await this.store().active(roomId);
        const prior = await this.ctx.storage.get('room');
        if (prior && prior !== roomId) throw Error('ACTOR_DENIED');
        const state = await this.ctx.storage.get('soundtrack') ?? {played:[],until:0};
        if (input.action !== 'view') {
          if (state.clientId && state.clientId !== input.clientId && state.until > Date.now()) throw Error('PLAYBACK_IN_USE');
          if(input.action==='start' && (state.stopped??[]).includes(input.runId))throw Error('PLAYBACK_INPUT_INVALID');
          if(input.action!=='start' && input.action!=='stop' && (state.runId!==input.runId || state.until<=Date.now()))throw Error('PLAYBACK_INPUT_INVALID');
          if (input.action === 'stop') {
            state.stopped=[...(state.stopped??[]),input.runId].slice(-100);
            if(!state.runId || state.runId===input.runId)state.until = 0;
          }
          else {
            if(this.env.GENERATION_ENABLED!=='true' || !this.env.FAL_KEY)throw Error('SOUNDTRACK_DISABLED');
            state.clientId = input.clientId;
            state.runId = input.runId;
            state.until = Date.now() + 20000;
            if (input.action === 'played') {
              const jobs = await this.ctx.storage.get('jobs') ?? [];
              if (!jobs.some(j=>j.id===input.id && j.state==='READY')) throw Error('PLAYBACK_INPUT_INVALID');
              if (!state.played.includes(input.id)) state.played.push(input.id);
            }
          }
          await this.ctx.storage.put('room',roomId);
          await this.ctx.storage.put('soundtrack',state);
          await this.ctx.storage.setAlarm(Date.now()+100);
        }
        const jobs = await this.ctx.storage.get('jobs') ?? [];
        return {active:state.until>Date.now(),reason:state.reason ?? null,
          songs:jobs.filter(j=>!state.played.includes(j.id)).map(j=>({id:j.id,state:j.state,reason:j.reason,
            sequence:j.sequence,assets:publicAssets(j)}))};
      });
    }
    async fillSoundtrack() {
      return this.locked(async () => {
        const state = await this.ctx.storage.get('soundtrack');
        if (!state) return false;
        const jobs = await this.ctx.storage.get('jobs') ?? [];
        if (state.until <= Date.now() || this.env.GENERATION_ENABLED!=='true') {
          // Stop/expired heartbeat prevents new charges, including a job that
          // was persisted but had not reached the provider before the stop.
          for (const job of jobs) {
            if (job.parts?.audio?.state === 'QUEUED') {
              job.parts.audio.state='CANCELLED';job.state='CANCELLED';
              await this.store().save(job);
            }
          }
          await this.ctx.storage.put('jobs',jobs);
          return true;
        }
        const available = jobs.filter(j=>!state.played.includes(j.id) && !['FAILED','NEEDS_REVIEW','CANCELLED'].includes(j.state));
        const last=jobs.at(-1);
        // Generate continuations after the prior song is validated, so the
        // provider receives its actual tail instead of unrelated seed audio.
        if (available.length>=2 || last && !terminal(last)) return true;
        if (last && ['FAILED','NEEDS_REVIEW'].includes(last.state)) {
          state.reason=last.reason ?? 'GENERATION_FAILED';
          await this.ctx.storage.put('soundtrack',state);
          return true;
        }
        try {
          const roomId=await this.ctx.storage.get('room');
          const job=await this.store().enqueueSoundtrack(roomId,jobs.length+1);
          job.parts ??= {audio:{state:'QUEUED'}};
          jobs.push(job);
          await this.ctx.storage.put('jobs',jobs);
          await this.ctx.storage.setAlarm(Date.now()+100);
        } catch(error) {
          state.reason=['JUDGE_BUDGET','SOUNDTRACK_LIMIT','ROOM_NOT_FOUND'].includes(error.message)?error.message:'GENERATION_FAILED';
          state.until=0;
          await this.ctx.storage.put('soundtrack',state);
        }
        return true;
      });
    }
    async alarm() {
      const soundtrack=await this.fillSoundtrack();
      await super.alarm();
      if (soundtrack) await this.fillSoundtrack();
    }
  };
}
