import {bindings, defineConfig, defineContainer, exports} from 'cf/config';

export default defineConfig(({mode}) => {
  const local = mode === 'development';
  const name = local ? 'ai-vdj-local' : mode === 'staging' ? 'ai-vdj-devdaycommunity-staging' : 'ai-vdj-devdaycommunity';
  const origin = local ? 'http://localhost:8787' : process.env.VDJ_PUBLIC_ORIGIN;
  const databaseId = local ? undefined : process.env.VDJ_D1_ID;
  const eventId = local ? 'judge-local' : process.env.VDJ_EVENT_ID;
  if (!origin || new URL(origin).origin !== origin || (!local && !origin.startsWith('https://')) ||
      !/^judge-[a-z0-9-]{1,60}$/.test(eventId ?? '') ||
      (!local && !/^[a-f0-9-]{36}$/.test(databaseId ?? ''))) {
    throw Error('Set the reviewed VDJ_PUBLIC_ORIGIN, VDJ_D1_ID and VDJ_EVENT_ID before a production build.');
  }
  const native = defineContainer({
    name: `${name}-native`,
    image: {dockerfile: './Dockerfile', buildContext: '../..'},
    maxInstances: 4,
    instanceType: 'standard-2',
    ssh: {enabled: false},
    observability: {enabled: false},
  });
  return {
    containers: local ? [] : [native],
    worker: {
      name,
      // Cloudflare validates this against UTC; 18 October in Japan is still 17 October UTC.
      compatibilityDate: '2026-10-17',
      entrypoint: local ? './worker.mjs' : './worker-with-containers.mjs',
      ...(!local ? {exports: {NativeProcessor: exports.durableObject({storage: 'sqlite', container: native}),
        GenerationRoom: exports.durableObject({storage: 'sqlite'}),
        AudienceRoom: exports.durableObject({storage:'sqlite'}), GenerationJob: exports.durableObject({storage:'sqlite'}), PresetBatch: exports.durableObject({storage:'sqlite'})}} : {}),
      assets: {runWorkerFirst: true, htmlHandling: 'none', notFoundHandling: 'none'},
      env: {
        ASSETS: bindings.assets(),
        DB: bindings.d1({name: local ? 'ai-vdj-local' : 'ai-vdj-room', ...(databaseId ? {id: databaseId} : {})}),
        MEDIA: bindings.r2({name: local ? 'ai-vdj-local-media' : 'ai-vdj-media'}),
        PUBLIC_ORIGIN: bindings.text(origin),
        EVENT_ID: bindings.text(eventId!),
        ...(mode === 'staging' ? {STAGING_NATIVE_CHECK: bindings.text('enabled')} : {}),
        ...(!local ? {NATIVE_PROCESSOR: bindings.durableObject({worker: name, exportName: 'NativeProcessor'})} : {}),
        ...(!local ? {GENERATION: bindings.durableObject({worker: name, exportName: 'GenerationRoom'})} : {}),
        ...(!local ? {AUDIENCE_ROOMS: bindings.durableObject({worker:name,exportName:'AudienceRoom'}),
          GENERATION_JOBS: bindings.durableObject({worker:name,exportName:'GenerationJob'}),
          PRESET_BATCHES: bindings.durableObject({worker:name,exportName:'PresetBatch'})} : {}),
        AUDIENCE_MODE: bindings.text(local ? 'false' : 'true'),
        DECISIONS_ENABLED: bindings.text(process.env.VDJ_DECISIONS_ENABLED === 'true' ? 'true' : 'false'),
        NATIVE_POOL_SIZE: bindings.text('4'),
        GENERATION_ENABLED: bindings.text(process.env.VDJ_GENERATION_ENABLED === 'true' ? 'true' : 'false'),
        IMAGE_DIRECTION_ENABLED: bindings.text(process.env.VDJ_IMAGE_DIRECTION_ENABLED === 'true' ? 'true' : 'false'),
        ...(process.env.VDJ_IMAGE_DIRECTION_ENABLED === 'true' ? {AI: bindings.ai()} : {}),
      },
      observability: {enabled: false},
      // Large validated media responses require more than a tiny API budget.
      limits: {cpuMs: 30000},
    },
  };
});
