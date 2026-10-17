import {Container} from '@cloudflare/containers';
import {createNativeContainerClass} from './native-container.mjs';
import {stagingCheck} from './staging-check-http.mjs';
import worker from './worker.mjs';

export class NativeProcessor extends createNativeContainerClass(Container) {}
export default {
  async fetch(request, env) {
    try { return await stagingCheck(request, env) ?? await worker.fetch(request, env); }
    catch { return Response.json({error: 'STAGING_CHECK_UNAVAILABLE'}, {status: 503, headers: {'cache-control': 'no-store'}}); }
  },
};
