import {DispatchError} from '../generation/dispatch.mjs';
import {createProductionRepository} from '../jobs/production-repository.mjs';
import {createExistingCloudRepositoryReadPorts} from '../jobs/repository-read-ports.mjs';
import {createRecoveryCandidateReadPort} from '../jobs/recovery-candidates.mjs';
import {createSupabaseStorageTransport} from './supabase-storage-transport.mjs';
import {createSupabasePrivateStore, PRIVATE_BUCKET_TARGET} from './supabase-private-store.mjs';
import {isEdgeRuntimeTransport} from './edge-runtime-transport.mjs';

const fail = code => {throw new DispatchError(code);};
const scoped = ({roomId, sessionId, controlRevision}) => ({roomId, sessionId, controlRevision});
const same = (a, b) => a.roomId === b.roomId && Object.is(a.sessionId, b.sessionId) && a.controlRevision === b.controlRevision;

// Concrete pinned node-postgres loader. Disabled I/O never calls this factory
// or imports pg (whose defaults inspect the environment). The approved host
// supplies all connection fields explicitly and an ephemeral password resolver.
// No connection URI, password value or process.env lookup is introduced here.
export function createPinnedPgPoolFactory({readConnection, loadPg = () => import('../../snapshot/node_modules/pg/lib/index.js')} = {}) {
  if (typeof readConnection !== 'function' || typeof loadPg !== 'function') fail('PRODUCTION_PG_HOST_REQUIRED');
  return async policy => {
    let connection;
    try {connection = await readConnection();} catch {fail('PRODUCTION_PG_CONNECTION_REQUIRED');}
    const keys = ['host', 'port', 'database', 'user', 'password', 'ssl'];
    if (!connection || Object.keys(connection).some(key => !keys.includes(key)) ||
        !['host', 'database', 'user'].every(key => typeof connection[key] === 'string' && connection[key].length > 0 && !/\s|\0/.test(connection[key])) ||
        !/^(?:db\.[a-z0-9]+\.supabase\.co|[a-z0-9.-]+\.pooler\.supabase\.com)$/.test(connection.host) ||
        ![5432, 6543].includes(connection.port) || typeof connection.password !== 'function' ||
        !connection.ssl || connection.ssl.rejectUnauthorized !== true ||
        Object.keys(connection.ssl).some(key => !['rejectUnauthorized', 'ca'].includes(key))) fail('PRODUCTION_PG_CONNECTION_REQUIRED');
    if (!policy || Object.keys(policy).some(key => !['ssl', 'connectionTimeoutMillis', 'query_timeout', 'statement_timeout',
      'lock_timeout', 'max', 'idleTimeoutMillis'].includes(key)) || policy.ssl?.rejectUnauthorized !== true ||
      Object.keys(policy.ssl).some(key => key !== 'rejectUnauthorized')) fail('PRODUCTION_PG_POLICY_REQUIRED');
    let module;
    try {module = await loadPg();} catch {fail('PRODUCTION_PG_DRIVER_REQUIRED');}
    const Pool = (module?.default ?? module)?.Pool;
    if (typeof Pool !== 'function') fail('PRODUCTION_PG_DRIVER_REQUIRED');
    try {return new Pool({...connection, ...policy, ssl: {...connection.ssl, rejectUnauthorized: true}});}
    catch {fail('PRODUCTION_PG_DRIVER_REQUIRED');}
  };
}

// Actual PostgreSQL, PostgREST RPC and Storage REST wiring for a fixed room.
// It deliberately exposes only read-only configuration checks and existing
// server adapters: no fake observer, scheduler, permit or provider dispatch.
export function createProductionCloudIo({enabled = false, roomId, projectURL, createPool, withPlatformHeaders,
  withOwnerAuthorization,edgeTransport, fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now} = {}) {
  if (typeof withOwnerAuthorization !== 'function') fail('PRODUCTION_OWNER_CONTEXT_REQUIRED');
  if (typeof now !== 'function') fail('PRODUCTION_CLOCK_REQUIRED');
  let closed = false;
  const clock = () => {const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail('PRODUCTION_CLOCK_REQUIRED'); return value;};
  const active = () => {if (!enabled || closed) fail(closed ? 'PRODUCTION_IO_CLOSED' : 'PRODUCTION_IO_NOT_ACTIVATED'); clock();};
  if(edgeTransport&&(!isEdgeRuntimeTransport(edgeTransport)||edgeTransport.capabilities().roomId!==roomId||
    edgeTransport.capabilities().projectURL!==undefined&&edgeTransport.capabilities().projectURL!==projectURL||
    enabled&&edgeTransport.capabilities().enabled!==true))fail('PRODUCTION_EDGE_TRANSPORT_REQUIRED');
  const repository = edgeTransport?.repository??createProductionRepository({enabled, roomId, projectURL, createPool, withPlatformHeaders, fetchImpl, timeoutMs});
  const storage = edgeTransport?.storage??createSupabaseStorageTransport({enabled, roomId, projectUrl: projectURL, fetchImpl, timeoutMs,now:clock,
    readAuthHeaders: async ({signal}) => {
      let headers, calls = 0, finished = false;
      try {
        await withPlatformHeaders({roomId, signal}, value => {
          if (finished || closed || signal.aborted || ++calls !== 1) fail('PRODUCTION_PLATFORM_CONTEXT_REUSED');
          headers = new Headers(value);
        });
        if (calls !== 1) fail('PRODUCTION_PLATFORM_CONTEXT_REQUIRED');
        return headers;
      } finally {finished = true;}
    }});
  const privateStore = createSupabasePrivateStore({enabled, roomId, transport: storage, timeoutMs:edgeTransport?30000:timeoutMs});
  let ports;
  async function ownerCall(scope, action) {
    let pending, used = false, invalid = false, finished = false, timer;
    const deadline = performance.now() + timeoutMs;
    const check = () => {active(); if (finished || performance.now() >= deadline) fail('PRODUCTION_OWNER_CONTEXT_REQUIRED');};
    const timeout = new Promise((_, reject) => {timer = setTimeout(() => {
      finished = true; reject(new DispatchError('PRODUCTION_OWNER_CONTEXT_REQUIRED'));
    }, timeoutMs);});
    const task = Promise.resolve().then(() => withOwnerAuthorization(Object.freeze(scoped(scope)), context => {
      check(); if (used) {invalid = true; fail('PRODUCTION_OWNER_CONTEXT_REUSED');} used = true;
      if (!context || !same(context, scope) || !/^[a-f0-9]{64}$/.test(context.ownerCapability ?? '') ||
          Object.keys(context).some(key => !['roomId', 'sessionId', 'controlRevision', 'ownerCapability'].includes(key)))
        fail('PRODUCTION_OWNER_CONTEXT_REQUIRED');
      pending = Promise.resolve().then(() => {check(); return action(context.ownerCapability);});
      pending.catch(() => {}); return pending;
    })).then(async () => {
      check(); if (!used || !pending || invalid) fail('PRODUCTION_OWNER_CONTEXT_REQUIRED');
      const value = await pending; check(); if (invalid) fail('PRODUCTION_OWNER_CONTEXT_REQUIRED'); return value;
    });
    task.catch(() => {});
    try {return await Promise.race([task, timeout]);}
    catch (error) {if (error instanceof DispatchError) throw error; fail('PRODUCTION_OWNER_CONTEXT_REQUIRED');}
    finally {finished = true; clearTimeout(timer);}
  }
  const query = (...args) => {active(); return repository.query(...args);};
  ports = createExistingCloudRepositoryReadPorts({query, now: clock,
    hostGenerationRead: async input => {
      active(); const scope = await ports.readScope({roomId: input.roomId});
      return ownerCall(scope, proof => repository.request(input.action, input.roomId, proof,
        input.operationId ? {operationId: input.operationId} : {}));
    }});
  const candidates = createRecoveryCandidateReadPort({enabled, query, readScope: ports.readScope, now: clock});
  async function inspectConfiguration(input = {}) {
    active(); if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length) fail('PRODUCTION_CONFIGURATION_IDS_FIXED');
    const before = await ports.readScope({roomId});
    const controller = new AbortController(); let bucket;
    try {bucket = await storage.describeBucket({bucket: PRIVATE_BUCKET_TARGET, signal: controller.signal});}
    finally {controller.abort();}
    const state = await ports.readPlaybackState(scoped(before)), after = await ports.readScope({roomId}); active();
    if (!same(before, after) || before.expiresAtMs !== after.expiresAtMs) fail('PRODUCTION_CONFIGURATION_CHANGED');
    const types = ['audio/wav', 'video/mp4', 'image/png', 'image/jpeg', 'application/json'].sort();
    const bucketCompatible = bucket.id === PRIVATE_BUCKET_TARGET && bucket.public === false && bucket.fileSizeLimit === 32 * 1024 * 1024 &&
      Array.isArray(bucket.allowedMimeTypes) && JSON.stringify([...bucket.allowedMimeTypes].sort()) === JSON.stringify(types);
    return {...scoped(after), repositoryRead: true, ownerCueRpcRead: true, privateBucketCompatible: bucketCompatible,
      playbackStopped: state.stopped, executionReady: false, observerContractAvailable: false, durableScheduler: false,
      blockers: ['SERVER_SELECTED_TARGET_REGISTRY_REQUIRED', 'AUTHENTICATED_PLAYER_FRONTIER_TRANSPORT_REQUIRED',
        'APPROVED_WORKER_INVOKER_REQUIRED', ...(bucketCompatible ? [] : ['PRIVATE_BUCKET_POLICY_MISMATCH'])]};
  }
  return Object.freeze({repository, privateStore, repositoryPorts: ports, candidates, inspectConfiguration,
    capabilities: () => ({productionApiAdapters: enabled && !closed, executionReady: false,
      actualApiConnectivityVerified: false, observerContractAvailable: false, durableScheduler: false}),
    async close() {closed = true; privateStore.close(); storage.close(); await repository.close();}});
}
