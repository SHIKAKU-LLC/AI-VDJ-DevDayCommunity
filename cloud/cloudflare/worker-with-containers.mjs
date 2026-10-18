import {createPresetBatchClass} from './preset-batch.mjs';
import {createAudienceRoomClass} from './audience-room.mjs';
import {Container} from '@cloudflare/containers';
import {createNativeContainerClass} from './native-container.mjs';
import {stagingCheck} from './staging-check-http.mjs';
import worker from './worker.mjs';
import {DurableObject} from 'cloudflare:workers';
import {createGenerationClass} from './generation-runtime.mjs';

export class NativeProcessor extends createNativeContainerClass(Container) {}
export class GenerationRoom extends createGenerationClass(DurableObject) {}
export default {
  async fetch(request, env) {
    try { return await stagingCheck(request, env) ?? await worker.fetch(request, env); }
    catch { return Response.json({error: 'STAGING_CHECK_UNAVAILABLE'}, {status: 503, headers: {'cache-control': 'no-store'}}); }
  },
};

export class AudienceRoom extends createAudienceRoomClass(DurableObject) {}
export class GenerationJob extends createGenerationClass(DurableObject) {
  async alarm() { try { await super.alarm(); } finally { const room=await this.ctx.storage.get('room'); if(room) await this.env.AUDIENCE_ROOMS.getByName(room).wake(room); } }
}

export class PresetBatch extends createPresetBatchClass(DurableObject) {}
