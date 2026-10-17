import {bindings, defineConfig} from 'cf/config';

export default defineConfig({
  worker: ({mode}) => {
    const local = mode === 'development';
    const origin = local ? 'http://localhost:8787' : process.env.VDJ_PUBLIC_ORIGIN;
    const databaseId = local ? undefined : process.env.VDJ_D1_ID;
    const eventId = local ? 'judge-local' : process.env.VDJ_EVENT_ID;
    if (!origin || new URL(origin).origin !== origin || (!local && !origin.startsWith('https://')) ||
        !/^judge-[a-z0-9-]{1,60}$/.test(eventId ?? '') ||
        (!local && !/^[a-f0-9-]{36}$/.test(databaseId ?? ''))) {
      throw Error('Set the reviewed VDJ_PUBLIC_ORIGIN, VDJ_D1_ID and VDJ_EVENT_ID before a production build.');
    }
    return {
      name: local ? 'ai-vdj-local' : 'ai-vdj-app',
      // Cloudflare validates this against UTC; 18 October in Japan is still 17 October UTC.
      compatibilityDate: '2026-10-17',
      entrypoint: './worker.mjs',
      assets: {runWorkerFirst: true, htmlHandling: 'none', notFoundHandling: 'none'},
      env: {
        ASSETS: bindings.assets(),
        DB: bindings.d1({name: local ? 'ai-vdj-local' : 'ai-vdj-room', ...(databaseId ? {id: databaseId} : {})}),
        MEDIA: bindings.r2({name: local ? 'ai-vdj-local-media' : 'ai-vdj-media'}),
        PUBLIC_ORIGIN: bindings.text(origin),
        EVENT_ID: bindings.text(eventId!),
      },
      observability: {enabled: false},
      limits: {cpuMs: 50},
    };
  },
});
