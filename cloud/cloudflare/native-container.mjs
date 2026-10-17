const fail = (error, status) => Response.json({error}, {status, headers: {'cache-control': 'no-store'}});

// This class is reachable only through the Worker's private binding. The public
// Worker never forwards browser requests here. Stream bodies to the container;
// do not duplicate base64 media in the Worker's limited memory.
export function createNativeContainerClass(Container) {
  return class NativeProcessor extends Container {
    defaultPort = 8080;
    sleepAfter = '3m';
    enableInternet = false;
    #auth;
    #ready;
    #busy = false;
    #context;
    #checkStart;

    constructor(ctx, env) {
      super(ctx, env);
      this.#context = ctx;
      this.#ready = ctx.blockConcurrencyWhile(async () => {
        let value = await ctx.storage.get('native-auth-v1');
        if (!value) {
          value = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
          await ctx.storage.put('native-auth-v1', value);
        }
        this.#auth = value;
      });
    }

    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== 'http://native.internal' || !['/inspect', '/self-check', '/prepare/audio', '/prepare/video'].includes(url.pathname) || url.search || request.method !== 'POST') return fail('NOT_FOUND', 404);
      const type = url.pathname.startsWith('/prepare/') ? 'application/octet-stream' : 'application/json';
      if (request.headers.get('content-type') !== type) return fail('JSON_REQUIRED', 415);
      if (this.#busy) return fail('BUSY', 409);
      this.#busy = true;
      try {
        await this.#ready;
        await this.startAndWaitForPorts({
          ports: [8080],
          startOptions: {envVars: {VDJ_RUNTIME_AUTH: this.#auth}, enableInternet: false},
          cancellationOptions: {portReadyTimeoutMS: 30000, abort: request.signal},
        });
        // Neither browser headers nor provider credentials cross this boundary.
        const headers = new Headers([['content-type', type], ['x-vdj-runtime-auth', this.#auth]]);
        if (url.pathname.startsWith('/prepare/')) {
          const duration = request.headers.get('x-vdj-duration-seconds') ?? '24';
          const context = request.headers.get('x-vdj-context-seconds') ?? '16';
          const profile = request.headers.get('x-vdj-media-profile') ?? 'legacy';
          if (!['legacy', 'club-hd-v1'].includes(profile)) return fail('INPUT_INVALID', 400);
          if (!(url.pathname === '/prepare/audio' ? ['12', '24', '60'] : ['12', '24']).includes(duration) || !['0', '12', '16'].includes(context)) return fail('INPUT_INVALID', 400);
          headers.set('x-vdj-duration-seconds', duration); headers.set('x-vdj-context-seconds', context); headers.set('x-vdj-media-profile', profile);
        }
        const outgoing = new Request('http://container.internal' + url.pathname, {method: 'POST', headers,
          body: request.body, signal: request.signal, duplex: 'half'});
        const response = await this.containerFetch(outgoing);
        if (response.status !== 200) {
          const data = await response.json().catch(() => ({}));
          const known = ['AUDIO_FORMAT_INVALID', 'AUDIO_QC_HOLD', 'VIDEO_FORMAT_INVALID', 'VIDEO_QC_HOLD',
            'UNIFORM_BLACK_OR_WHITE_VIDEO', 'STATIC_VIDEO_HOLD', 'RAPID_LUMA_TRANSITIONS_HOLD',
            'MEDIA_INPUT_INVALID', 'MEDIA_RESULT_INVALID', 'MEDIA_PROCESS_FAILED', 'BOOTSTRAP_MEASUREMENT_FAILED'];
          return fail(known.includes(data.error) ? data.error : 'NATIVE_MEASUREMENT_FAILED',
            [400, 413, 415, 422, 409].includes(response.status) ? response.status : 502);
        }
        return new Response(response.body, {headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
      } catch {
        return fail('NATIVE_PROCESSOR_UNAVAILABLE', 503);
      } finally { this.#busy = false; }
    }

    async syntheticStatus() {
      await this.#ready;
      return await this.#context.storage.get('synthetic-check-v1') ?? {state: 'not-started'};
    }

    async startSyntheticCheck() {
      // Set the durable marker before starting work. Repeated HTTP calls and
      // eviction cannot turn the staging check into repeated paid CPU jobs.
      this.#checkStart ??= (async () => {
        await this.#ready;
        const previous = await this.#context.storage.get('synthetic-check-v1');
        if (previous) return;
        await this.#context.storage.put('synthetic-check-v1', {state: 'running'});
        this.#context.waitUntil(this.#runSyntheticCheck());
      })();
      await this.#checkStart;
      return this.syntheticStatus();
    }

    async #runSyntheticCheck() {
      let result = {state: 'failed'};
      try {
        const response = await this.fetch(new Request('http://native.internal/self-check', {
          method: 'POST', headers: {'content-type': 'application/json'}, body: '{}', signal: AbortSignal.timeout(150000),
        }));
        result = {state: 'failed', httpStatus: response.status};
        const value = await response.json();
        if (response.ok && value.kind === 'synthetic-bootstrap-check-v1' && value.passed === true &&
            value.frameCount === 24 * 44100 && value.sampleRate === 44100 && value.channels === 2) {
          result = {state: 'passed', frames: value.frameCount, sampleRate: value.sampleRate, channels: value.channels};
        }
      } catch { /* Return no credentials, internal paths, provider data or errors. */ }
      await this.#context.storage.put('synthetic-check-v1', result);
    }

    // The SDK's default error hook logs the underlying error. Keep this surface
    // free of request bodies and generated per-container credentials.
    onError() { throw Error('NATIVE_PROCESSOR_UNAVAILABLE'); }
  };
}
