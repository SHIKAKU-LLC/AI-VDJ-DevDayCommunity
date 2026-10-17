export async function stagingCheck(request, env) {
  const url = new URL(request.url);
  if (env.STAGING_NATIVE_CHECK !== 'enabled' || url.pathname !== '/api/staging/native-check') return null;
  const headers = {'cache-control': 'no-store', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff'};
  if (url.search || !['GET', 'POST'].includes(request.method)) return Response.json({error: 'NOT_FOUND'}, {status: 404, headers});
  if (request.method === 'POST') {
    if (request.headers.get('origin') !== env.PUBLIC_ORIGIN) return Response.json({error: 'DENIED'}, {status: 403, headers});
    // The public caller cannot select an input, command, object identity or URL.
    for await (const chunk of request.body ?? []) {
      if (chunk.byteLength) return Response.json({error: 'EMPTY_BODY_REQUIRED'}, {status: 400, headers});
    }
  }
  // v1 was allocated before the first image rollout finished. Allocate this
  // fixed replacement only after the /self-check image reached 100%.
  const instance = env.NATIVE_PROCESSOR.getByName('staging-native-check-v2');
  const result = request.method === 'GET' ? await instance.syntheticStatus() : await instance.startSyntheticCheck();
  return Response.json(result, {status: result.state === 'running' ? 202 : 200, headers});
}
