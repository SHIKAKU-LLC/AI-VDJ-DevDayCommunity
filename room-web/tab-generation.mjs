// Owner-only, tab-memory BYOK. This module is not automatically mounted or armed.
// Server-side permits authorize spend; the client cannot supply a quote or budget.
export function createSessionGeneration({roomId, ownerCapability, credentials, fetchImpl = globalThis.fetch,
  lifecycle = globalThis.window, onState = () => {}, delay = ms => new Promise(r => setTimeout(r, ms))} = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(roomId ?? '') || !/^[a-f0-9]{64}$/.test(ownerCapability ?? '') ||
      typeof credentials !== 'string' || credentials.length < 8) throw Error('OWNER_SESSION_REQUIRED');
  let key = credentials, owner = ownerCapability, closed = false, epoch = 0;
  const inflight = new Set();
  function forget() { closed = true; key = ''; owner = ''; epoch++; for (const c of inflight) c.abort(); inflight.clear();
    lifecycle?.removeEventListener?.('pagehide', forget); }
  lifecycle?.addEventListener?.('pagehide', forget);
  async function request(action, body) {
    if (closed) throw Error('SESSION_CLOSED');
    const generation = epoch, controller = new AbortController(); inflight.add(controller);
    try {
      const headers = new Headers({'Content-Type': 'application/json'});
      headers.set('X-Room-Owner', owner); headers.set('X-Fal-Key', key);
      const response = await fetchImpl(`/api/rooms/${roomId}/generation/${action}`, {method: 'POST', headers,
        body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])});
      const result = await response.json();
      if (generation !== epoch || closed) throw Error('SESSION_CLOSED');
      if (!response.ok) throw Error(result.error ?? 'GENERATION_HOLD');
      onState(result); return result;
    } finally { inflight.delete(controller); }
  }
  const terminal = op => op.state === 'STOPPED' || op.state === 'NEEDS_CLARIFICATION';
  async function stage(operationId, channel) {
    let result = await request('submit', {operationId, stage: channel});
    for (let poll = 0; poll < 90; poll++) {
      const state = result.stages[channel]?.state;
      if (state === 'COMPLETE' || terminal(result)) return result;
      if (state !== 'SUBMITTED') throw Error('DISPATCH_UNKNOWN_NO_RETRY');
      await delay(2000);
      result = await request('poll', {operationId, stage: channel});
    }
    throw Error('POLL_LIMIT_NO_REPOST');
  }
  return {
    async run({operationId, permitId, submissionId}) {
      let op = await request('begin', {operationId, permitId, submissionId});
      if (terminal(op)) return op;
      op = await stage(operationId, 'intent');
      if (terminal(op)) return op;
      // One music and one video stage proceed concurrently, never separate CTAs.
      await Promise.all([stage(operationId, 'music'), stage(operationId, 'video')]);
      return request('read', {operationId});
    },
    read: operationId => request('read', {operationId}),
    descriptor: operationId => request('descriptor', {operationId}),
    // This stops new dispatch; an accepted provider request can still finish/bill.
    stop: operationId => request('stop', {operationId}),
    forget,
    state: () => ({connected: !closed, keyStorage: 'tab-memory-only', inflight: inflight.size}),
  };
}
