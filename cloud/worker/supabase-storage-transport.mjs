import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {PRIVATE_BUCKET_TARGET} from './storage-contract.mjs';
import {Buffer} from 'node:buffer';

const MEDIA_LIMIT = 32 * 1024 * 1024, JSON_LIMIT = 64 * 1024;
const MIME_TYPES = ['audio/wav', 'video/mp4', 'image/png', 'image/jpeg', 'application/json'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => keys.includes(key));
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export class StorageTransportHold extends DispatchError {
  constructor(reason) {super('STORAGE_TRANSPORT_HOLD'); this.holdReason = reason; this.message = reason;}
}
const fail = reason => {throw new StorageTransportHold(reason);};
const discard = response => {try {response?.body?.cancel().catch(() => {});} catch { /* No response details escape. */ }};

/** Server-only Storage REST mapping. The injected host resolves fresh opaque
 * auth headers; this adapter neither reads environment keys nor stores them.
 * Official contract sources (reviewed 2026-10-14, not a live deployment probe):
 * https://github.com/supabase/storage/blob/master/src/http/routes/bucket/getBucket.ts
 * https://github.com/supabase/storage/blob/master/src/http/routes/object/getObject.ts
 * https://github.com/supabase/storage/blob/master/src/http/routes/object/createObject.ts
 * https://github.com/supabase/storage/blob/master/src/internal/errors/codes.ts
 * https://supabase.com/docs/guides/storage/uploads/standard-uploads
 * Standard binary POST supports this bounded 32MiB contract. Supabase recommends
 * resumable uploads above 6MB; no TUS configuration or reliability is invented.
 * A successful/duplicate POST is only a hint: private-store must reread and
 * verify the physical bytes/canonical record. Network uncertainty is never
 * automatically retried. Only typed missing/duplicate 400 envelopes are recognized; other 400 errors HOLD.
 */
export function createSupabaseStorageTransport(options = {}) {
  if (!exact(options, ['enabled', 'roomId', 'projectUrl', 'fetchImpl', 'readAuthHeaders', 'timeoutMs','now'])) fail('STORAGE_CONFIG_REQUIRED');
  const {enabled = false, roomId, projectUrl, fetchImpl, readAuthHeaders, timeoutMs = 30000,now=Date.now} = options;
  if (typeof enabled !== 'boolean' || !safeId(roomId) || typeof fetchImpl !== 'function' || typeof readAuthHeaders !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000) fail('STORAGE_HOST_PORTS_REQUIRED');
  let project; try {project = new URL(projectUrl);} catch {fail('STORAGE_PROJECT_REQUIRED');}
  if (project.protocol !== 'https:' || project.origin !== projectUrl || project.username || project.password ||
      project.port || !/^[a-z0-9-]{1,63}\.supabase\.co$/.test(project.hostname)) fail('STORAGE_PROJECT_REQUIRED');
  const prefix = 'rooms/' + cueDigest(roomId), controllers = new Set(); let closed = false;
  const active = () => {if (!enabled) fail('STORAGE_NOT_ACTIVATED'); if (closed) fail('STORAGE_CLOSED');};
  const pathValid = path => typeof path === 'string' && path.startsWith(prefix + '/') &&
    /^(?:assets\/[A-Za-z0-9_-]{1,100}\.(?:media|json)|(?:sources|receipts|source-start-receipts)\/[A-Za-z0-9_-]{1,100}\.json)$/.test(path.slice(prefix.length + 1));
  function inputValid(input, keys, object = false) {
    active(); if (!exact(input, keys) || input.bucket !== PRIVATE_BUCKET_TARGET || !(input.signal instanceof AbortSignal) ||
        object && !pathValid(input.path)) fail('STORAGE_ROOM_PATH_REQUIRED');
    if (input.signal.aborted) fail('STORAGE_ABORTED');
  }
  function operation(signal) {
    const controller = new AbortController(); controllers.add(controller);
    let finished = false, rejectStopped, reason = null;
    const stopped = new Promise((_, reject) => {rejectStopped = reject;}); stopped.catch(() => {});
    const abort = code => {if (finished || reason) return; reason = code; controller.abort(); rejectStopped(new StorageTransportHold(code)); finish();};
    const onCallerAbort = () => abort('STORAGE_ABORTED'); signal.addEventListener('abort', onCallerAbort, {once: true});
    const onClose = () => abort('STORAGE_CLOSED'); controller.addClose = onClose;
    const timer = setTimeout(() => abort('STORAGE_TIMEOUT'), timeoutMs);
    const finish = () => {if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', onCallerAbort);
      controllers.delete(controller); controller.abort();};
    return {controller, stopped, finish, check() {active(); if (reason) fail(reason); if (signal.aborted) fail('STORAGE_ABORTED');},
      wait: promise => Promise.race([promise, stopped])};
  }
  async function fetchResponse(op, path, method, contentType, body) {
    op.check(); let headers;
    try {
      headers = new Headers(await op.wait(Promise.resolve().then(() => {op.check(); return readAuthHeaders({signal: op.controller.signal});})));
      if ([...headers.keys()].some(key => !['authorization', 'apikey'].includes(key)) ||
          !headers.has('authorization') || !headers.has('apikey') || !headers.get('authorization') || !headers.get('apikey')) fail('STORAGE_AUTH_HEADERS_REQUIRED');
    } catch (error) {if (error instanceof StorageTransportHold) throw error; fail('STORAGE_AUTH_HEADERS_REQUIRED');}
    op.check(); headers.set('Accept-Encoding', 'identity');
    if (method === 'POST') {headers.set('Content-Type', contentType); headers.set('Content-Length', String(body.byteLength));
      headers.set('x-upsert', 'false');}
    const url = project.origin + '/storage/v1/' + path;
    let response;
    try {response = await op.wait(Promise.resolve().then(() => {op.check(); return fetchImpl(url, {method, headers,
      ...(body ? {body} : {}), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: op.controller.signal});}));}
    catch (error) {if (error instanceof StorageTransportHold) throw error;
      fail(method === 'POST' ? 'STORAGE_WRITE_UNCERTAIN' : 'STORAGE_NETWORK_HOLD');}
    try {op.check();
      if (!(response instanceof Response) || response.redirected || response.url && response.url !== url || response.status >= 300 && response.status < 400)
        fail('STORAGE_REDIRECT_HOLD');
      return response;
    } catch (error) {discard(response); throw error;}
  }
  function boundedStream(response, op, maximumBytes) {
    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader === null ? undefined : /^\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : NaN;
    const encoding = response.headers.get('content-encoding');
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maximumBytes) ||
        encoding && encoding !== 'identity' || typeof response.body?.getReader !== 'function') {
      discard(response); op.finish(); fail('STORAGE_OBJECT_SIZE_REQUIRED');
    }
    const reader = response.body.getReader(); let length = 0, ended = false;
    const cancel = () => {try {reader.cancel().catch(() => {});} catch { /* Sanitized by caller. */ }};
    op.controller.signal.addEventListener('abort', cancel, {once: true});
    const body = new ReadableStream({
      async pull(controller) {
        if (ended) return;
        try {op.check(); const part = await op.wait(reader.read()); op.check();
          if (part.done) {
            if (length < 1 || contentLength !== undefined && length !== contentLength) fail('STORAGE_OBJECT_LENGTH_MISMATCH');
            ended = true; op.finish(); controller.close(); return;
          }
          if (!(part.value instanceof Uint8Array) || part.value.length < 1) fail('STORAGE_BOUNDED_STREAM_REQUIRED');
          length += part.value.length; if (length > maximumBytes) fail('STORAGE_OBJECT_TOO_LARGE');
          controller.enqueue(part.value);
        } catch (error) {ended = true; cancel(); op.finish(); controller.error(error instanceof StorageTransportHold ? error : new StorageTransportHold('STORAGE_STREAM_HOLD'));}
      }, cancel() {ended = true; cancel(); op.finish();},
    }, {highWaterMark: 0});
    return {body, contentLength};
  }
  async function readJSON(response, op) {
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      discard(response); fail('STORAGE_JSON_REQUIRED');
    }
    const {body} = boundedStream(response, op, JSON_LIMIT), reader = body.getReader(), chunks = []; let length = 0;
    try {while (true) {const part = await reader.read(); if (part.done) break; chunks.push(Buffer.from(part.value)); length += part.value.length;}
      try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, length)));} catch {fail('STORAGE_JSON_REQUIRED');}
    } finally {reader.cancel().catch(() => {});}
  }
  async function describeBucket(input) {
    inputValid(input, ['bucket', 'signal']); const op = operation(input.signal);
    try {
      const response = await fetchResponse(op, 'bucket/' + PRIVATE_BUCKET_TARGET, 'GET');
      if (response.status !== 200) {discard(response); fail('STORAGE_BUCKET_HOLD');}
      const raw = await readJSON(response, op);
      // Null/missing/malformed policy values are never silently normalized.
      if (raw?.id !== PRIVATE_BUCKET_TARGET || typeof raw.public !== 'boolean' || !Number.isSafeInteger(raw.file_size_limit) ||
          raw.file_size_limit < 1 || !Array.isArray(raw.allowed_mime_types) || raw.allowed_mime_types.length > 20 ||
          !raw.allowed_mime_types.every(value => typeof value === 'string')) fail('STORAGE_BUCKET_METADATA_REQUIRED');
      return {id: raw.id, public: raw.public, fileSizeLimit: raw.file_size_limit, allowedMimeTypes: [...raw.allowed_mime_types]};
    } finally {op.finish();}
  }
  async function readObject(input) {
    inputValid(input, ['bucket', 'path', 'maximumBytes', 'signal'], true);
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 || input.maximumBytes > MEDIA_LIMIT ||
        input.path.endsWith('.json') && input.maximumBytes > JSON_LIMIT) fail('STORAGE_OBJECT_SIZE_REQUIRED');
    const op = operation(input.signal); let streaming = false;
    try {
      const response = await fetchResponse(op, 'object/authenticated/' + PRIVATE_BUCKET_TARGET + '/' + input.path, 'GET');
      if (response.status !== 200) {
        if ([400,404].includes(response.status)) {
          const error=await readJSON(response,op);
          const legacyMissing=Object.keys(error??{}).sort().join(',')==='error,message,statusCode'&&
            error.statusCode==='404'&&error.error==='not_found'&&error.message==='Object not found';
          const typedMissing=error?.code==='NoSuchKey'&&error.statusCode==='404';
          if(response.status===404&&error?.code==='NoSuchKey'||typedMissing||legacyMissing)return null;
        }
        discard(response); fail('STORAGE_OBJECT_READ_HOLD');
      }
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!MIME_TYPES.includes(contentType)) {discard(response); fail('STORAGE_OBJECT_MIME_REQUIRED');}
      const result = boundedStream(response, op, input.maximumBytes); streaming = true;
      return {contentType, ...result};
    } finally {if (!streaming) op.finish();}
  }
  async function putObjectIfAbsent(input) {
    inputValid(input, ['bucket', 'path', 'bytes', 'contentType', 'upsert', 'signal'], true);
    if (input.upsert !== false || !(input.bytes instanceof Uint8Array) || input.bytes.length < 1 || input.bytes.length > MEDIA_LIMIT ||
        !MIME_TYPES.includes(input.contentType) || input.path.endsWith('.json') && (input.contentType !== 'application/json' || input.bytes.length > JSON_LIMIT))
      fail('STORAGE_IMMUTABLE_UPLOAD_REQUIRED');
    const bytes = Buffer.from(input.bytes), op = operation(input.signal);
    try {
      const response = await fetchResponse(op, 'object/' + PRIVATE_BUCKET_TARGET + '/' + input.path, 'POST', input.contentType, bytes);
      const result = await readJSON(response, op);
      if ((response.status === 409 || response.status === 400 && result?.statusCode==='409') && ['KeyAlreadyExists', 'ResourceAlreadyExists'].includes(result?.code)) return {created: false, duplicate: true};
      if (![200, 201].includes(response.status) || result?.Key !== PRIVATE_BUCKET_TARGET + '/' + input.path) fail('STORAGE_OBJECT_WRITE_HOLD');
      return {created: true, duplicate: false};
    } finally {op.finish();}
  }
  async function signObject(input){
    inputValid(input,['bucket','path','expiresIn','signal'],true);
    if(!input.path.endsWith('.media')||!Number.isSafeInteger(input.expiresIn)||input.expiresIn<1||input.expiresIn>3600||typeof now!=='function')fail('STORAGE_SIGNING_BOUND_REQUIRED');
    if(!Number.isSafeInteger(now())||now()<0)fail('STORAGE_SIGNING_BOUND_REQUIRED');
    const op=operation(input.signal);
    try{const response=await fetchResponse(op,'object/sign/'+PRIVATE_BUCKET_TARGET+'/'+input.path,'POST','application/json',Buffer.from(JSON.stringify({expiresIn:input.expiresIn})));
      if(response.status!==200){discard(response);fail('STORAGE_SIGNING_HOLD');}
      const raw=await readJSON(response,op),expected='/object/sign/'+PRIVATE_BUCKET_TARGET+'/'+input.path;
      if(typeof raw?.signedURL!=='string'||raw.signedURL.length>16384)fail('STORAGE_SIGNING_RESPONSE_REQUIRED');
      let signed;try{signed=new URL(raw.signedURL,project.origin+'/storage/v1/');}catch{fail('STORAGE_SIGNING_RESPONSE_REQUIRED');}
      // API returns /object/sign/... relative to the storage endpoint, not site root.
      if(raw.signedURL.startsWith('/object/'))signed.pathname='/storage/v1'+signed.pathname;
      if(signed.origin!==project.origin||signed.username||signed.password||signed.hash||signed.pathname!=='/storage/v1'+expected||
        signed.searchParams.size!==1||!signed.searchParams.has('token'))fail('STORAGE_SIGNING_RESPONSE_REQUIRED');
      const token=signed.searchParams.get('token');let claims;
      try{if(!token||token.length>12288||token.split('.').length!==3)throw Error();claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));}catch{fail('STORAGE_SIGNING_RESPONSE_REQUIRED');}
      const observedAt=now();
      if(!Number.isSafeInteger(observedAt)||!Number.isSafeInteger(claims.exp)||claims.url!==PRIVATE_BUCKET_TARGET+'/'+input.path||claims.exp*1000<=observedAt||claims.exp*1000>observedAt+input.expiresIn*1000+timeoutMs+1000)fail('STORAGE_SIGNING_RESPONSE_REQUIRED');
      // Claims are an expiry/path bound, not a locally verified JWT signature.
      // Authenticity rests on the authenticated fixed-origin HTTPS response.
      return {url:signed.href,expiresAtMs:claims.exp*1000};
    }finally{op.finish();}
  }
  return Object.freeze({describeBucket, readObject, putObjectIfAbsent,signObject, close() {closed = true; for (const controller of controllers) controller.addClose();},
    capabilities: () => ({storageRestTransport: enabled && !closed, defaultActivation: false, maximumObjectBytes: MEDIA_LIMIT,
      standardUpload: true, resumableUpload: false, automaticWriteRetry: false,
      largeUploadReliabilityVerified: false, actualPlatformStreamVerified: false, credentialPersistence: false})});
}
