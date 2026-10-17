// Inject the pinned SDK factory. Each operation gets one request-scoped client;
// no queue helper with hidden polling/retries, global config or credential store.
export function createGenerationProvider({createFalClient, fetchImpl = globalThis.fetch, onDiagnostic=()=>{},readOnly=false} = {}) {
  if (typeof createFalClient !== 'function') throw Error('PINNED_FAL_SDK_REQUIRED');
  const run = async (operation, {key, model, input, requestId, signal, operationId, stage}) => {
    let sent = false;
    const emit=(event,detail)=>{if(operation!=='submit'||!['intent','music','video'].includes(stage)||
      !/^[A-Za-z0-9_-]{20,100}$/.test(operationId??''))return;
      try{onDiagnostic({event,reason:[operationId,stage,detail].join(':')});}catch{}};
    const client = createFalClient({credentials: key, retry: {maxRetries: 0}, fetch: async (url, init = {}) => {
      const u = new URL(url);
      if(readOnly&&String(init.method??'GET').toUpperCase()!=='GET')throw Error('PROVIDER_READ_ONLY_REQUIRED');
      if (sent || u.protocol !== 'https:' || u.hostname !== 'queue.fal.run' || u.username || u.password || signal?.aborted) throw Error('PROVIDER_TRANSPORT_REFUSED');
      sent = true;
      emit('PROVIDER_HTTP_ATTEMPT','FETCH_ENTER');
      try{
        const response=await fetchImpl(url, {...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)});
        emit('PROVIDER_HTTP_RESPONSE',String(response.status));return response;
      }catch(error){
        const code=error?.cause?.code??error?.code??error?.name;
        emit('PROVIDER_HTTP_REJECTED',/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|TimeoutError|AbortError)$/.test(code??'')?code:'NETWORK_STAGE_UNKNOWN');
        throw error;
      }
    }});
    if (operation === 'submit') {
      const reply=await client.queue.submit(model, {input, startTimeout: 60, headers: {'X-Fal-No-Retry': '1'}});
      if(/^[A-Za-z0-9_-]{1,100}$/.test(reply?.request_id??'')&&!reply.request_id.includes(key))emit('PROVIDER_ACCEPTED',reply.request_id);
      return reply;
    }
    if (operation === 'status') return client.queue.status(model, {requestId, logs: false});
    return client.queue.result(model, {requestId});
  };
  return Object.fromEntries((readOnly?['status','result']:['submit', 'status', 'result']).map(k => [k, args => run(k, args)]));
}
export const createReadOnlyGenerationProvider=options=>createGenerationProvider({...options,readOnly:true});
