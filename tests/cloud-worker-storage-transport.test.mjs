import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseStorageTransport} from '../cloud/worker/supabase-storage-transport.mjs';
import {createSupabasePrivateStore, PRIVATE_BUCKET_TARGET} from '../cloud/worker/supabase-private-store.mjs';
import {cueDigest} from '../snapshot/app/runtime/intent-compiler.mjs';
import {fixtureSha} from './cloud-worker-fixture.mjs';

const example_header = 'Bearer example-host-only-placeholder';
const roomId = '11111111-1111-4111-a111-111111111111', projectUrl = 'https://example.supabase.co';
const prefix = 'rooms/' + cueDigest(roomId), bucket = PRIVATE_BUCKET_TARGET;
const mime = ['audio/wav','video/mp4','image/png','image/jpeg','application/json'];
const input = extra => ({bucket, signal: new AbortController().signal, ...extra});
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const reason = expected => error => error.code === 'STORAGE_TRANSPORT_HOLD' && error.holdReason === expected;
function fixture(extra = {}) {
  const objects = new Map(), calls = [], counters = {auth: 0}, config = {id: bucket, public: false,
    file_size_limit: 32 * 1024 * 1024, allowed_mime_types: mime, owner: 'example_owner_not_projected', created_at: 'example_ignored'};
  const readAuthHeaders = async ({signal}) => {counters.auth++; assert(signal instanceof AbortSignal);
    return new Headers({'Authorization': example_header, 'apikey': 'example-host-only-placeholder'});};
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), {method, headers, body, signal} = options;
    assert.equal(parsed.origin, projectUrl); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store'); assert(signal instanceof AbortSignal);
    assert.equal(headers.get('authorization'), example_header); assert.equal(headers.get('apikey'), 'example-host-only-placeholder');
    // Capture request geometry only; auth header values are deliberately omitted.
    calls.push({url, method, size: body?.length, contentType: headers.get('content-type'), upsert: headers.get('x-upsert'), length: headers.get('content-length'), signal});
    if (parsed.pathname === '/storage/v1/bucket/' + bucket) return json(config);
    const readPrefix = '/storage/v1/object/authenticated/' + bucket + '/', putPrefix = '/storage/v1/object/' + bucket + '/';
    if (method === 'GET' && parsed.pathname.startsWith(readPrefix)) {
      const record = objects.get(parsed.pathname.slice(readPrefix.length));
      if (!record) return json({statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found'}, 404);
      return new Response(Uint8Array.from(record.bytes), {headers: {'Content-Type': record.contentType, 'Content-Length': String(record.bytes.length)}});
    }
    if (method === 'POST' && parsed.pathname.startsWith(putPrefix)) {
      assert.equal(headers.get('x-upsert'), 'false'); assert.equal(headers.get('content-length'), String(body.length));
      const path = parsed.pathname.slice(putPrefix.length);
      if (objects.has(path)) return json({statusCode: '409', code: 'KeyAlreadyExists', error: 'Duplicate', message: 'The resource already exists'}, 409);
      objects.set(path, {bytes: Buffer.from(body), contentType: headers.get('content-type')});
      return json({Id: 'example_upload_id', Key: bucket + '/' + path}, 200);
    }
    throw Error('example unexpected fake fetch route');
  };
  const options = {enabled: true, roomId, projectUrl, readAuthHeaders, fetchImpl, ...extra};
  return {objects, calls, config, counters, options, transport: createSupabaseStorageTransport(options)};
}
async function bytesOf(response) {
  const reader = response.body.getReader(), chunks = []; try {while (true) {const part = await reader.read(); if (part.done) break; chunks.push(Buffer.from(part.value));}
    return Buffer.concat(chunks);} finally {await reader.cancel().catch(() => {});}
}

test('REST transport is default-off with zero constructor/auth/fetch IO and strict project/bucket/room path authority', async () => {
  let io = 0; const forbidden = () => {io++; throw Error('example IO forbidden');};
  const transport = createSupabaseStorageTransport({roomId, projectUrl, readAuthHeaders: forbidden, fetchImpl: forbidden});
  await assert.rejects(transport.describeBucket(input()), reason('STORAGE_NOT_ACTIVATED'));
  await assert.rejects(transport.readObject(input({path: prefix + '/assets/example.media', maximumBytes: 10})), reason('STORAGE_NOT_ACTIVATED'));
  await assert.rejects(transport.putObjectIfAbsent(input({path: prefix + '/assets/example.media', bytes: Uint8Array.of(1), contentType: 'audio/wav', upsert: false})), reason('STORAGE_NOT_ACTIVATED'));
  assert.equal(io, 0); assert.equal(transport.capabilities().actualPlatformStreamVerified, false);
  const example_user_url = new URL(projectUrl); example_user_url.username = 'example_user';
  for (const invalid of ['http://example.supabase.co', 'https://example.supabase.co/', 'https://example.supabase.co:443',
    'https://example.supabase.co?example=1', 'https://example.supabase.co/storage/v1', 'https://example.invalid', example_user_url.toString()])
    assert.throws(() => createSupabaseStorageTransport({enabled: true, roomId, projectUrl: invalid, readAuthHeaders: forbidden, fetchImpl: forbidden}), reason('STORAGE_PROJECT_REQUIRED'));
  const x = fixture();
  for (const path of ['rooms/' + cueDigest('example_other_room') + '/assets/example.media', prefix + '/../example.media',
    prefix + '/assets/example%2fescape.media', prefix + '/assets/example.media?example=1', prefix + '/assets/example.media#example',
    prefix + '/assets//example.media', prefix + '/unknown/example.json', prefix + '/assets/example\\escape.media'])
    await assert.rejects(x.transport.readObject(input({path, maximumBytes: 10})), reason('STORAGE_ROOM_PATH_REQUIRED'));
  await assert.rejects(x.transport.describeBucket(input({bucket: 'example_other_bucket'})), reason('STORAGE_ROOM_PATH_REQUIRED'));
  await assert.rejects(x.transport.describeBucket(input({headers: {example: 'caller'}})), reason('STORAGE_ROOM_PATH_REQUIRED'));
  assert.equal(x.counters.auth, 0); assert.equal(x.calls.length, 0);
});

test('official REST path/header/snake_case schema mapping composes existing private store and immutable reread verification', async () => {
  const x = fixture(), store = createSupabasePrivateStore({enabled: true, roomId, transport: x.transport});
  try {
    assert.deepEqual(await x.transport.describeBucket(input()), {id: bucket, public: false, fileSizeLimit: 32 * 1024 * 1024, allowedMimeTypes: mime});
    const binding = {kind: 'owner-supplied-bootstrap'}, bytes = Uint8Array.from([137,80,78,71,13,10,26,10]);
    const saved = await store.assetStore.save({id: 'example_reference', bytes, contentType: 'image/png', binding, provenance: binding});
    assert.equal(saved.sha256, fixtureSha(bytes)); assert.deepEqual(Buffer.from(saved.bytes), Buffer.from(bytes));
    const puts = x.calls.filter(c => c.method === 'POST').length;
    assert.equal(puts, 2); assert.deepEqual(await store.assetStore.read(saved.assetId), saved);
    assert.deepEqual(await store.assetStore.save({id: 'example_reference', bytes, contentType: 'image/png', binding, provenance: binding}), saved);
    assert.equal(x.calls.filter(c => c.method === 'POST').length, puts);
    assert(x.calls.filter(c => c.method === 'POST').every(c => c.upsert === 'false' && Number(c.length) === c.size));
    assert(x.calls.some(c => c.url.endsWith('/storage/v1/object/authenticated/' + bucket + '/' + prefix + '/assets/example_reference.media')));
    assert.equal(x.counters.auth, x.calls.length, 'opaque host auth is resolved afresh for each request');
    assert(!JSON.stringify(saved).includes('example-host-only-placeholder'));
    assert.equal(x.transport.capabilities().largeUploadReliabilityVerified, false); assert.equal(x.transport.capabilities().automaticWriteRetry, false);
  } finally {store.close(); x.transport.close();}
});

test('null/missing/malformed bucket policy holds, and incompatible public/size/MIME policies are not hidden or configured', async () => {
  for (const config of [{id: bucket, public: false, file_size_limit: null, allowed_mime_types: mime},
    {id: bucket, public: false, file_size_limit: 32 * 1024 * 1024}, {id: bucket, public: false, file_size_limit: '33554432', allowed_mime_types: mime}]) {
    const x = fixture({fetchImpl: async () => json(config)}); await assert.rejects(x.transport.describeBucket(input()), reason('STORAGE_BUCKET_METADATA_REQUIRED'));
  }
  for (const patch of [{public: true}, {file_size_limit: 1024}, {allowed_mime_types: ['application/json']}]) {
    const x = fixture(); Object.assign(x.config, patch); const store = createSupabasePrivateStore({enabled: true, roomId, transport: x.transport});
    await assert.rejects(store.assetStore.read('example_reference'), error => error.code === 'PRIVATE_STORE_HOLD' && error.holdReason === 'PRIVATE_BUCKET_CONFIGURATION_MISMATCH');
    assert.equal(x.calls.length, 1); assert.equal(x.calls[0].method, 'GET'); store.close(); x.transport.close();
  }
});

test('only typed NoSuchKey 404 is absent; auth/bucket/unknown errors and redirects are sanitized HOLD', async () => {
  const object = input({path: prefix + '/assets/example.media', maximumBytes: 10});
  assert.equal(await fixture().transport.readObject(object), null);
  for (const [status, code] of [[401, 'InvalidJWT'], [403, 'AccessDenied'], [404, 'NoSuchBucket'], [404, 'example_unknown'], [500, 'InternalError']]) {
    const x = fixture({fetchImpl: async () => json({code, message: 'example private backend detail'}, status)});
    await assert.rejects(x.transport.readObject(object), error => error.code === 'STORAGE_TRANSPORT_HOLD' && !error.message.includes('backend detail'));
  }
  for (const response of [new Response(null, {status: 302, headers: {Location: 'https://example.invalid'}}), (() => {
    const value = new Response(Uint8Array.of(1), {headers: {'Content-Type': 'audio/wav'}});
    Object.defineProperty(value, 'url', {value: 'https://example.invalid/storage/v1/object'}); return value;})()]) {
    const x = fixture({fetchImpl: async () => response}); await assert.rejects(x.transport.readObject(object), reason('STORAGE_REDIRECT_HOLD'));
  }
  for (const override of [{readAuthHeaders: async () => {throw Error('example secret callback detail');}},
    {readAuthHeaders: async () => ({Authorization: 'example-placeholder', apikey: 'example-placeholder', 'X-Upsert': 'true'})},
    {readAuthHeaders: async () => ({})}, {fetchImpl: async () => {throw Error('example secret network detail');}}]) {
    const x = fixture(override); await assert.rejects(x.transport.readObject(object), error => error.code === 'STORAGE_TRANSPORT_HOLD' && !error.message.includes('detail'));
  }
});

test('adapter itself bounds unknown-length streams, validates length/MIME/encoding and cancels overflow', async () => {
  const object = input({path: prefix + '/assets/example.media', maximumBytes: 4});
  let cancelled = 0;
  const x = fixture({fetchImpl: async () => new Response(new ReadableStream({start(controller) {controller.enqueue(Uint8Array.of(1,2,3)); controller.enqueue(Uint8Array.of(4,5));},
    cancel() {cancelled++;}}), {headers: {'Content-Type': 'audio/wav'}})});
  await assert.rejects(bytesOf(await x.transport.readObject(object)), reason('STORAGE_OBJECT_TOO_LARGE')); assert.equal(cancelled, 1);
  for (const [headers, expected] of [[{'Content-Type': 'audio/wav', 'Content-Length': '5'}, 'STORAGE_OBJECT_SIZE_REQUIRED'],
    [{'Content-Type': 'audio/wav', 'Content-Length': 'example'}, 'STORAGE_OBJECT_SIZE_REQUIRED'],
    [{'Content-Type': 'text/html'}, 'STORAGE_OBJECT_MIME_REQUIRED'], [{'Content-Type': 'audio/wav', 'Content-Encoding': 'gzip'}, 'STORAGE_OBJECT_SIZE_REQUIRED']]) {
    const y = fixture({fetchImpl: async () => new Response(Uint8Array.of(1,2), {headers})});
    await assert.rejects(y.transport.readObject(object), reason(expected));
  }
  const shorter = fixture({fetchImpl: async () => new Response(Uint8Array.of(1,2), {headers: {'Content-Type': 'audio/wav', 'Content-Length': '3'}})});
  await assert.rejects(bytesOf(await shorter.transport.readObject(object)), reason('STORAGE_OBJECT_LENGTH_MISMATCH'));
  const empty = fixture({fetchImpl: async () => new Response(new Uint8Array(), {headers: {'Content-Type': 'audio/wav'}})});
  await assert.rejects(bytesOf(await empty.transport.readObject(object)), reason('STORAGE_OBJECT_LENGTH_MISMATCH'));
  const oversized = fixture({fetchImpl: async () => new Response(' '.repeat(65537), {headers: {'Content-Type': 'application/json'}})});
  await assert.rejects(oversized.transport.describeBucket(input()), reason('STORAGE_OBJECT_TOO_LARGE'));
});

test('409 typed duplicate is a hint only; downstream physically verifies equal bytes and rejects conflicting objects, with no blind write retry', async () => {
  const path = prefix + '/assets/example.media', upload = input({path, bytes: Uint8Array.of(1,2), contentType: 'audio/wav', upsert: false}), x = fixture();
  assert.deepEqual(await x.transport.putObjectIfAbsent(upload), {created: true, duplicate: false});
  assert.deepEqual(await x.transport.putObjectIfAbsent(upload), {created: false, duplicate: true}); assert.equal(x.calls.filter(c => c.method === 'POST').length, 2);
  for (const override of [{fetchImpl: async () => json({code: 'ResourceReferenced'}, 409)}, {fetchImpl: async () => json({error: 'Duplicate'}, 400)},
    {fetchImpl: async () => json({Key: bucket + '/example_wrong_path'})}, {fetchImpl: async () => {throw Error('example uncertain POST');}}]) {
    let posts = 0; const wrapped = override.fetchImpl;
    const y = fixture({fetchImpl: async (...args) => {posts++; return wrapped(...args);}});
    await assert.rejects(y.transport.putObjectIfAbsent(upload), error => error.code === 'STORAGE_TRANSPORT_HOLD'); assert.equal(posts, 1);
  }
  await assert.rejects(x.transport.putObjectIfAbsent({...upload, upsert: true}), reason('STORAGE_IMMUTABLE_UPLOAD_REQUIRED'));
  const reconcile = async conflict => {
    const y = fixture(), underlying = y.options.fetchImpl;
    const transport = createSupabaseStorageTransport({...y.options, fetchImpl: async (url, options) => {
      if (options.method === 'GET' && url.endsWith('/example_race.media') && !y.objects.has(prefix + '/assets/example_race.media')) {
        y.objects.set(prefix + '/assets/example_race.media', {bytes: Buffer.from(conflict ? [9,9] : [1,2]), contentType: 'audio/wav'});
        return json({code: 'NoSuchKey'}, 404); // Fixture competing writer after absent read.
      }
      return underlying(url, options);
    }});
    const store = createSupabasePrivateStore({enabled: true, roomId, transport});
    try {const save = store.assetStore.save({id: 'example_race', bytes: Uint8Array.of(1,2), contentType: 'audio/wav',
      binding: {kind: 'owner-supplied-bootstrap'}, provenance: {kind: 'owner-supplied-bootstrap'}});
      if (conflict) await assert.rejects(save, error => error.holdReason === 'PRIVATE_ASSET_PHYSICAL_SHA_MISMATCH');
      else assert.equal((await save).sha256, fixtureSha(Uint8Array.of(1,2)));
      assert.equal(y.calls.filter(c => c.method === 'POST' && c.url.endsWith('/example_race.media')).length, 1);
    } finally {store.close(); transport.close();}
  };
  await reconcile(false); await reconcile(true);
});

test('timeout/abort/close remain active through auth, headers and body without raw errors or hanging stream reads', async () => {
  const path = prefix + '/assets/example.media', hold = () => new Promise(() => {});
  for (const override of [{readAuthHeaders: hold}, {fetchImpl: hold}, {fetchImpl: async () => new Response(new ReadableStream({pull: hold}), {headers: {'Content-Type': 'audio/wav'}})}]) {
    const x = fixture({...override, timeoutMs: 10}), task = x.transport.readObject(input({path, maximumBytes: 10}));
    await assert.rejects((async () => {const value = await task; return bytesOf(value);})(), reason('STORAGE_TIMEOUT'));
  }
  const controller = new AbortController(); controller.abort(); const x = fixture();
  await assert.rejects(x.transport.describeBucket(input({signal: controller.signal})), reason('STORAGE_ABORTED')); assert.equal(x.counters.auth, 0);
  let entered; const observed = new Promise(resolve => {entered = resolve;});
  const y = fixture({fetchImpl: async () => new Response(new ReadableStream({pull() {entered(); return hold();}}), {headers: {'Content-Type': 'audio/wav'}})});
  const response = await y.transport.readObject(input({path, maximumBytes: 10})), pending = bytesOf(response); await observed;
  y.transport.close(); await assert.rejects(pending, reason('STORAGE_CLOSED'));
  await assert.rejects(y.transport.describeBucket(input()), reason('STORAGE_CLOSED'));
  const cancelled = new AbortController(), z = fixture({fetchImpl: hold}), query = z.transport.describeBucket(input({signal: cancelled.signal}));
  cancelled.abort(); await assert.rejects(query, reason('STORAGE_ABORTED'));
});

test('physical upper bound remains 32MiB; over-6MB standard POST is fixture-contract only, and abort prevents deferred auth/fetch side effects', async () => {
  const path = prefix + '/assets/example_large.media'; let posts = 0, uploadSize = 0;
  const x = fixture({fetchImpl: async (url, options) => {posts++; uploadSize = options.body.length;
    assert.equal(options.headers.get('content-length'), String(uploadSize)); return json({Key: bucket + '/' + path});}});
  assert.deepEqual(await x.transport.putObjectIfAbsent(input({path, bytes: new Uint8Array(7 * 1024 * 1024), contentType: 'video/mp4', upsert: false})), {created: true, duplicate: false});
  assert.equal(uploadSize, 7 * 1024 * 1024); assert.equal(x.transport.capabilities().largeUploadReliabilityVerified, false);
  await assert.rejects(x.transport.putObjectIfAbsent(input({path, bytes: new Uint8Array(32 * 1024 * 1024 + 1), contentType: 'video/mp4', upsert: false})), reason('STORAGE_IMMUTABLE_UPLOAD_REQUIRED'));
  await assert.rejects(x.transport.readObject(input({path, maximumBytes: 32 * 1024 * 1024 + 1})), reason('STORAGE_OBJECT_SIZE_REQUIRED')); assert.equal(posts, 1);
  let pulls = 0, cancelled = 0; const chunk = new Uint8Array(1024 * 1024);
  const stream = fixture({fetchImpl: async () => new Response(new ReadableStream({pull(controller) {pulls++; controller.enqueue(chunk);}, cancel() {cancelled++;}}, {highWaterMark: 0}),
    {headers: {'Content-Type': 'video/mp4'}})});
  const body = (await stream.transport.readObject(input({path, maximumBytes: 32 * 1024 * 1024}))).body, reader = body.getReader(); let consumed = 0;
  await assert.rejects((async () => {while (true) {const result = await reader.read(); if (result.done) break; consumed += result.value.length;}})(), reason('STORAGE_OBJECT_TOO_LARGE'));
  assert.equal(consumed, 32 * 1024 * 1024); assert.equal(pulls, 33); assert.equal(cancelled, 1);
  const controller = new AbortController(), off = fixture(), deferred = off.transport.describeBucket(input({signal: controller.signal}));
  controller.abort(); await assert.rejects(deferred, reason('STORAGE_ABORTED')); assert.equal(off.counters.auth, 0); assert.equal(off.calls.length, 0);
  const headersThenAbort = new AbortController(); let fetches = 0;
  const y = fixture({readAuthHeaders: async () => {headersThenAbort.abort(); return {'Authorization': example_header, 'apikey': 'example-placeholder'};},
    fetchImpl: async () => {fetches++; return json({});}});
  await assert.rejects(y.transport.describeBucket(input({signal: headersThenAbort.signal})), reason('STORAGE_ABORTED')); assert.equal(fetches, 0);
});

// Production Storage still emits this exact legacy absence body with HTTP 400.
test('legacy missing-object envelope is accepted without accepting auth or generic 400 errors',async()=>{
 const object=input({path:prefix+'/assets/example.media',maximumBytes:10});
 const missing={statusCode:'404',error:'not_found',message:'Object not found'};
 for(const status of [400,404])for(const body of [missing,{...missing,code:'NoSuchKey',error:'NoSuchKey'}]){const f=fixture({fetchImpl:async()=>json(body,status)});assert.equal(await f.transport.readObject(object),null);}
 for(const [status,body] of [[403,missing],[400,{...missing,statusCode:'403'}],[400,{...missing,error:'Unauthorized'}],[400,{...missing,message:'Bucket not found'}],[400,{...missing,detail:'unknown'}]]){
  const f=fixture({fetchImpl:async()=>json(body,status)});await assert.rejects(f.transport.readObject(object),reason('STORAGE_OBJECT_READ_HOLD'));
 }
});

test('typed duplicate HTTP 400 remains a hint; unknown write responses still hold',async()=>{
 const request=input({path:prefix+'/assets/example.media',bytes:Uint8Array.of(1),contentType:'audio/wav',upsert:false});
 const f=fixture({fetchImpl:async()=>json({statusCode:'409',code:'KeyAlreadyExists'},400)});
 assert.deepEqual(await f.transport.putObjectIfAbsent(request),{created:false,duplicate:true});
 const bad=fixture({fetchImpl:async()=>json({statusCode:'403',code:'KeyAlreadyExists'},400)});
 await assert.rejects(bad.transport.putObjectIfAbsent(request),reason('STORAGE_OBJECT_WRITE_HOLD'));
});
