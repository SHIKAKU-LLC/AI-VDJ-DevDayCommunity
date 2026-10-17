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

    constructor(ctx, env) {
      super(ctx, env);
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
      if (url.origin !== 'http://native.internal' || url.pathname !== '/inspect' || url.search || request.method !== 'POST') return fail('NOT_FOUND', 404);
      if (request.headers.get('content-type') !== 'application/json') return fail('JSON_REQUIRED', 415);
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
        const headers = new Headers([['content-type', 'application/json'], ['x-vdj-runtime-auth', this.#auth]]);
        const outgoing = new Request('http://container.internal/inspect', {method: 'POST', headers,
          body: request.body, signal: request.signal, duplex: 'half'});
        const response = await this.containerFetch(outgoing);
        if (response.status !== 200) {
          await response.body?.cancel();
          return fail('NATIVE_MEASUREMENT_FAILED', [400, 413, 415, 422, 409].includes(response.status) ? response.status : 502);
        }
        return new Response(response.body, {headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
      } catch {
        return fail('NATIVE_PROCESSOR_UNAVAILABLE', 503);
      } finally { this.#busy = false; }
    }

    // The SDK's default error hook logs the underlying error. Keep this surface
    // free of request bodies and generated per-container credentials.
    onError() { throw Error('NATIVE_PROCESSOR_UNAVAILABLE'); }
  };
}
