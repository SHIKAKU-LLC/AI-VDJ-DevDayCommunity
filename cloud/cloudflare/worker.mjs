import {createCloudflareRoomApi} from './http.mjs';
import {createProviderDelivery} from './provider-delivery.mjs';
import {generationHttp} from './generation-http.mjs';

const page = /^\/(?:room\/?|join\/[a-f0-9-]{36}\/?)?$/;
const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function secured(response, path) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', path === '/cloud-output.html' ? policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : policy);
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Room URLs contain invitation data. Do not cache HTML or API responses.
  if (path.startsWith('/api/') || page.test(path) || path.endsWith('.html')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/provider-media/')) {
        try {
          const delivery = createProviderDelivery({db: env.DB, bucket: env.MEDIA, eventId: env.EVENT_ID, origin: env.PUBLIC_ORIGIN});
          return secured(await delivery.handle(request), url.pathname);
        } catch { return secured(new Response(null, {status: 404, headers: {'cache-control': 'no-store'}}), url.pathname); }
      }
      if (url.pathname.startsWith('/api/')) {
        const generated = await generationHttp(request, env);
        if (generated) return secured(generated, url.pathname);
        const api = createCloudflareRoomApi({db: env.DB, eventId: env.EVENT_ID, origin: env.PUBLIC_ORIGIN,
          generationEnabled: env.GENERATION_ENABLED === 'true' && !!env.FAL_KEY && !!env.GENERATION});
        return secured(await api(request), url.pathname);
      }
      if (!['GET', 'HEAD'].includes(request.method)) return secured(new Response(null, {status: 405, headers: {Allow: 'GET, HEAD'}}), url.pathname);
      if (page.test(url.pathname)) url.pathname = '/judge-room.html';
      url.search = '';
      // Do not forward invitation codes or client authorization to the asset service.
      const asset = await env.ASSETS.fetch(new Request(url, {method: request.method}));
      return secured(asset, url.pathname);
    } catch {
      return secured(Response.json({error: 'ROOM_BACKEND_UNAVAILABLE'}, {status: 503}), url.pathname);
    }
  },
};
