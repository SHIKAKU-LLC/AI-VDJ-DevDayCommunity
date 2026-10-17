import {DispatchError} from '../generation/dispatch.mjs';
import {EXISTING_REPOSITORY_SELECTS} from './repository-read-ports.mjs';
import {RECOVERY_CANDIDATE_SELECT} from './recovery-candidates.mjs';
import {OPERATOR_STATE_SQL,OPERATOR_PERMITS_SQL} from './operator-store.mjs';
import {PLAYER_OBSERVER_SQL} from './player-observer-store.mjs';
import {DURABLE_SCHEDULER_SQL} from './durable-scheduler.mjs';

const fail = code => {throw new DispatchError(code);};
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(value);
const smallId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bound = 1024 * 1024;
const operations = new Set(['permit', 'begin', 'read', 'stop', 'claim', 'submitted', 'unknown', 'complete', 'failed', 'held',
  'cueState', 'cuePublish', 'cueReserve', 'cueReservation', 'cueAck', 'cueStop', 'cueStart']);
const rpcCodes = new Set(['OWNER_DENIED', 'GENERATION_PERMIT_REQUIRED', 'PERMIT_ALREADY_USED', 'SUBMISSION_REQUIRED',
  'STAGE_ALREADY_RESERVED', 'COMPILED_INTENT_REQUIRED', 'RESULT_IMMUTABLE', 'SOURCE_OR_CONTROL_CHANGED',
  'CUE_EVIDENCE_IMMUTABLE', 'PLAYBACK_PENDING', 'PLAYBACK_STOPPED', 'PLAYBACK_RESERVATION_REQUIRED',
  'MATCHING_ACTUAL_AV_ACK_REQUIRED', 'ACK_CONFLICT']);
// Reject objects with serialization hooks/accessors before invoking JSON.stringify.
function jsonCopy(value) {
  let nodes = 0;
  function copy(input, depth) {
    if (++nodes > 30000 || depth > 32) fail('PRODUCTION_JSON_REQUIRED');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(input)))
      fail('PRODUCTION_JSON_REQUIRED');
    const out = Array.isArray(input) ? [] : Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (key === 'length' && Array.isArray(input)) continue;
      if (!Object.hasOwn(descriptor, 'value')) fail('PRODUCTION_JSON_REQUIRED');
      if (!descriptor.enumerable || descriptor.value === undefined) continue;
      if (key === 'toJSON') fail('PRODUCTION_JSON_REQUIRED');
      out[key] = copy(descriptor.value, depth + 1);
    }
    return out;
  }
  const result = copy(value, 0);
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > bound) fail('PRODUCTION_JSON_REQUIRED');
  return JSON.parse(serialized);
}
function parameters(statement, values, roomId) {
  if (!Array.isArray(values)) fail('PRODUCTION_QUERY_REQUIRED');
  const sql = EXISTING_REPOSITORY_SELECTS;
  let valid = false;
  if (statement === sql.scope) valid = values.length === 1 && values[0] === roomId;
  if (statement === sql.runtime) valid = values.length === 1 && values[0] === roomId;
  if (statement === sql.attachments) valid = values.length === 2 && values[0] === roomId && Array.isArray(values[1]) &&
    values[1].length <= 100 && values[1].every(smallId) && new Set(values[1]).size === values[1].length;
  if (statement === sql.operation || statement === sql.permit) valid = values.length === 2 && id(values[0]) && values[1] === roomId;
  if (statement === RECOVERY_CANDIDATE_SELECT) valid = values.length === 6 && values[0] === roomId && uuid(values[1]) &&
    integer(values[2]) && integer(values[3]) && (values[4] === null || id(values[4])) && integer(values[5]) && values[5] >= 1 && values[5] <= 21;
  if (!valid) fail('PRODUCTION_QUERY_REQUIRED');
  return values.map(value => Array.isArray(value) ? [...value] : value);
}

/** Optional host transport, not a connection configuration or scheduler.
 * createPool receives non-secret pg Pool policy only. The approved host must
 * lazily load pinned pg and supply explicit connection fields without ambient
 * environment defaults. No private schema is exposed through PostgREST here.
 * Each SELECT uses one checked-out client with transaction-local bounds; never
 * SET SESSION (Supavisor may reuse sessions). Failed/unknown clients are destroyed.
 * REST mutations are never retried. A lost response needs existing ledger recovery.
 * No construction/open I/O while disabled. Actual grants/TLS/connectivity remain
 * unverified until the approved host mounts and independently verifies transport.
 */
export function createProductionRepository({enabled = false, roomId, projectURL, createPool, withPlatformHeaders,
  fetchImpl = globalThis.fetch, timeoutMs = 8000} = {}) {
  if (typeof enabled !== 'boolean' || !uuid(roomId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 5 || timeoutMs > 8000)
    fail('PRODUCTION_REPOSITORY_CONFIGURATION_REQUIRED');
  let origin;
  try {
    const url = new URL(projectURL);
    if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.username || url.password ||
        url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) throw Error();
    origin = url.origin;
  } catch {fail('DEDICATED_PROJECT_REQUIRED');}
  const policy = Object.freeze({ssl: Object.freeze({rejectUnauthorized: true}), connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs, statement_timeout: timeoutMs, lock_timeout: timeoutMs, max: 4, idleTimeoutMillis: timeoutMs});
  let closed = false, poolPromise, closing;
  const active = new Set();
  const activated = () => {if (!enabled) fail('PRODUCTION_REPOSITORY_NOT_ACTIVATED'); if (closed) fail('PRODUCTION_REPOSITORY_CLOSED');};
  function invocation() {
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    active.add(controller);
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () =>
      reject(new DispatchError(closed ? 'PRODUCTION_REPOSITORY_CLOSED' : 'PRODUCTION_REPOSITORY_TIMEOUT')), {once: true}));
    // Also observe aborts while an injected adapter has not settled.
    aborted.catch(() => {});
    const check = () => {
      if (closed || performance.now() >= deadline) controller.abort();
      if (controller.signal.aborted) fail(closed ? 'PRODUCTION_REPOSITORY_CLOSED' : 'PRODUCTION_REPOSITORY_TIMEOUT');
    };
    return {signal: controller.signal, check,
      wait: promise => {
        const observed = Promise.resolve(promise); observed.catch(() => {});
        check(); return Promise.race([observed, aborted]).then(value => {check(); return value;});
      },
      finish: () => {clearTimeout(timer); active.delete(controller); controller.abort();}};
  }
  async function getPool() {
    if (typeof createPool !== 'function') fail('PRODUCTION_POOL_REQUIRED');
    poolPromise ??= Promise.resolve().then(() => {if (closed) fail('PRODUCTION_REPOSITORY_CLOSED'); return createPool(policy);}).then(async pool => {
      const options = pool?.options;
      if (typeof pool?.connect !== 'function' || typeof pool.end !== 'function' || typeof pool.on !== 'function' ||
          options?.ssl?.rejectUnauthorized !== true || !['connectionTimeoutMillis', 'query_timeout', 'statement_timeout', 'lock_timeout']
            .every(key => Number.isSafeInteger(options[key]) && options[key] > 0 && options[key] <= timeoutMs) ||
          !Number.isSafeInteger(options.max) || options.max < 1 || options.max > 4) {
        try {await pool?.end?.();} catch {}
        fail('PRODUCTION_POOL_POLICY_REQUIRED');
      }
      pool.on('error', () => {}); // pg removes failed idle clients; never log private errors.
      return pool;
    });
    return poolPromise;
  }
  async function executeQuery(statement, params, writable = false) {
    const call = invocation();
    let client, released = false, succeeded = false;
    const release = destroy => {if (client && !released) {released = true; try {client.release(destroy);} catch {}}};
    const abort = () => release(true); call.signal.addEventListener('abort', abort, {once: true});
    try {
      const pool = await call.wait(getPool());
      await call.wait(Promise.resolve().then(() => {call.check(); return pool.connect();}).then(acquired => {
        client = acquired;
        try {call.check();} catch (error) {release(true); throw error;}
        return client;
      }));
      if (typeof client?.query !== 'function' || typeof client.release !== 'function') fail('PRODUCTION_POOL_REQUIRED');
      const run = (text, values = []) => call.wait(Promise.resolve().then(() => {
        call.check(); return client.query({text, values, query_timeout: timeoutMs});
      }));
      await run(writable ? 'BEGIN TRANSACTION READ WRITE' : 'BEGIN TRANSACTION READ ONLY');
      await run(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
      await run(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
      const result = await run(statement, params);
      if (!Array.isArray(result?.rows) || result.rows.length > 101) fail('PRODUCTION_QUERY_RESULT_REQUIRED');
      const rows = jsonCopy(result.rows);
      await run('COMMIT'); succeeded = true;
      return {rows};
    } catch (error) {
      // On an unknown/timed-out query do not send another SQL command or reuse
      // this client. release(true) terminates the connection and its transaction.
      if (error instanceof DispatchError && /^PRODUCTION_/.test(error.code)) throw error;
      fail('PRODUCTION_QUERY_HOLD');
    } finally {release(!succeeded); call.signal.removeEventListener('abort', abort); call.finish();}
  }
  async function query(statement, values) {
    activated(); return executeQuery(statement, parameters(statement, values, roomId));
  }
  // Compiled internal function calls only. The private schema remains absent
  // from REST; the approved existing privileged PG principal is required. SQL
  // functions recheck room owner/scope/expiry/Stop atomically under row locks.
  // No arbitrary write SQL or caller-defined transaction statement is accepted.
  async function privateStateQuery(statement, values) {
    activated();
    const operatorInsert=statement===OPERATOR_PERMITS_SQL;
    if (!Array.isArray(values) || values[operatorInsert?0:1] !== roomId || !/^[a-f0-9]{64}$/.test(values[operatorInsert?1:2] ?? '')) fail('PRODUCTION_STATE_QUERY_REQUIRED');
    if (statement === PLAYER_OBSERVER_SQL || statement===OPERATOR_STATE_SQL) {
      const receipt=statement===PLAYER_OBSERVER_SQL&&['sourceReceiptRead','sourceReceiptPut'].includes(values[0]);
      if (values.length !== 7 || !['read', 'cas'].includes(values[0])&&!receipt || !uuid(values[3]) || !integer(values[4]) ||
          (receipt?values[5]!==null||typeof values[6]!=='string':values[0] === 'read' ? values[5] !== null || values[6] !== null : !integer(values[5]) || typeof values[6] !== 'string'))
        fail('PRODUCTION_STATE_QUERY_REQUIRED');
    } else if(statement===OPERATOR_PERMITS_SQL){
      if(values.length!==6||!uuid(values[2])||!integer(values[3])||!id(values[4])||typeof values[5]!=='string')fail('PRODUCTION_STATE_QUERY_REQUIRED');
    } else if (statement === DURABLE_SCHEDULER_SQL) {
      if (values.length !== 4 || !['enqueue', 'claim', 'assert', 'renew', 'finish'].includes(values[0]) || typeof values[3] !== 'string')
        fail('PRODUCTION_STATE_QUERY_REQUIRED');
    } else fail('PRODUCTION_STATE_QUERY_REQUIRED');
    const params = [...values], position = statement === PLAYER_OBSERVER_SQL || statement===OPERATOR_STATE_SQL ? 6 : operatorInsert?5:3;
    if (params[position] !== null) {
      let parsed; try {parsed = JSON.parse(params[position]);} catch {fail('PRODUCTION_STATE_QUERY_REQUIRED');}
      const transient=statement===PLAYER_OBSERVER_SQL&&values[0]==='cas'&&parsed?.__observationFence&&
        typeof parsed.__observationFence==='object'&&!Array.isArray(parsed.__observationFence);
      const record=transient?Object.fromEntries(Object.entries(parsed).filter(([k])=>k!=='__observationFence')):parsed;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          Buffer.byteLength(params[position])>(transient?131072:65536)||Buffer.byteLength(JSON.stringify(record))>65536)
        fail('PRODUCTION_STATE_QUERY_REQUIRED');
      params[position] = JSON.stringify(jsonCopy(parsed));
    }
    return executeQuery(statement, params, true);
  }
  async function responseJson(response, call) {
    if (!response || response.redirected || !response.body?.getReader) fail('GENERATION_REPOSITORY_HOLD');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > bound)) fail('GENERATION_REPOSITORY_HOLD');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      for (;;) {
        call.check(); const {done, value} = await call.wait(reader.read()); if (done) break;
        if (!(value instanceof Uint8Array) || (size += value.byteLength) > bound) fail('GENERATION_REPOSITORY_HOLD');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } finally {try {Promise.resolve(reader.cancel()).catch(() => {});} catch {} try {reader.releaseLock();} catch {}}
  }
  async function requestRpc(op, requestedRoomId, ownerCapability, payload = {}, roomRead = false) {
    activated();
    if (requestedRoomId !== roomId || !(roomRead ? ['read','submission'].includes(op) : operations.has(op)) || typeof ownerCapability !== 'string' || !/^[a-f0-9]{64}$/.test(ownerCapability))
      fail('PRODUCTION_RPC_SCOPE_REQUIRED');
    const safePayload = jsonCopy(payload);
    if (!safePayload || Array.isArray(safePayload) || typeof safePayload !== 'object') fail('PRODUCTION_JSON_REQUIRED');
    const body = JSON.stringify({op, room_id: roomId, capability: ownerCapability, payload: safePayload,
      ...(roomRead ? {verified_uid: null} : {})});
    if (Buffer.byteLength(body) > bound || typeof withPlatformHeaders !== 'function' || typeof fetchImpl !== 'function')
      fail('PRODUCTION_RPC_PORTS_REQUIRED');
    const call = invocation(); let invoked = false, replay = false, task;
    try {
      await call.wait(Promise.resolve().then(() => withPlatformHeaders({roomId, signal: call.signal}, headers => {
        if (invoked || call.signal.aborted || closed) {replay = true; fail('PRODUCTION_RPC_CONTEXT_REQUIRED');}
        invoked = true;
        const selected = new Headers(headers);
        if ([...selected.keys()].some(key => !['authorization', 'apikey', 'content-type', 'accept', 'content-profile', 'accept-profile'].includes(key)) ||
            !selected.get('authorization') || !selected.get('apikey') ||
            ['content-profile', 'accept-profile'].some(key => selected.has(key) && selected.get(key) !== 'public'))
          fail('PRODUCTION_RPC_HEADERS_REQUIRED');
        selected.set('content-type', 'application/json'); selected.set('content-profile', 'public'); selected.set('accept-profile', 'public');
        task = (async () => {
          call.check();
          const response = await call.wait(fetchImpl(origin + '/rest/v1/rpc/' + (roomRead ? 'vdj_room_request' : 'vdj_generation_request'),
            {method: 'POST', headers: selected, body, redirect: 'error', signal: call.signal}));
          const result = await responseJson(response, call);
          if (!response.ok) throw new DispatchError(rpcCodes.has(result?.message) ? result.message : 'GENERATION_REPOSITORY_HOLD');
          return result;
        })();
        task.catch(() => {});
        return task;
      })));
      if (!invoked || replay || !task) fail('PRODUCTION_RPC_CONTEXT_REQUIRED');
      const result = await call.wait(task);
      if (replay) fail('PRODUCTION_RPC_CONTEXT_REQUIRED');
      return result;
    } catch (error) {
      if (error instanceof DispatchError && (rpcCodes.has(error.code) || /^PRODUCTION_/.test(error.code))) throw error;
      fail('GENERATION_REPOSITORY_HOLD');
    } finally {call.finish();}
  }
  function close() {
    if (closing) return closing;
    closed = true; for (const controller of active) controller.abort();
    if (!poolPromise) return closing = Promise.resolve();
    const end = poolPromise.then(pool => pool.end(), () => {}).catch(() => fail('PRODUCTION_CLOSE_HOLD'));
    let timer;
    const expiry = new Promise((_, reject) => {timer = setTimeout(() => reject(new DispatchError('PRODUCTION_CLOSE_HOLD')), timeoutMs);});
    closing = Promise.race([end, expiry]).finally(() => clearTimeout(timer));
    return closing;
  }
  return Object.freeze({query, privateStateQuery,
    request: (op, id, capability, payload) => requestRpc(op, id, capability, payload),
    readRoom: (id, capability) => requestRpc('read', id, capability, {}, true),
    roomRead: (op, id, capability, payload = {}) => requestRpc(op, id, capability, payload, true),
    close, capabilities: () => ({defaultActivation: false, transportConfigured: enabled && !closed,
    actualConnectionVerified: false, durableScheduler: false, privateSchemaExposed: false})});
}
