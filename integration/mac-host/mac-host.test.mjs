import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createMacHost} from './server.mjs';
import {createSessionGate} from './ephemeral-gate.mjs';
import {createOwnerCredentialAccess} from './native.mjs';
import {createMacConnection} from './client.mjs';
import {createOwnerCloudConnection} from '../runtime/owner-cloud-connection.mjs';

const cloud = 'https://room.example';
async function setup(t, options = {}) {
  const pairs = [], artifacts = new Map(); let closed = 0, calls = 0;
  let nativeContext;
  const host = await createMacHost({roomId: 'room', cloudOrigin: cloud,
    confirm: async () => true, showPairing: async p => { pairs.push(p); },
    createRuntime: async context => { nativeContext = context; return {
      async readRender(input) { calls++; if (options.renderWait) await options.renderWait;
        return {pcm: new Float32Array(1024), sampleRate: 44100, startFrame: 0, durationFrames: 512,
          expectedPlayedWindowSha256: 'a'.repeat(64), renderedPcmSha256: 'b'.repeat(64), renderedFileSha256: 'c'.repeat(64)}; },
      close() { closed++; },
    }; }, ...options});
  const {origin} = await host.listen();
  t.after(() => host.close());
  await host.beginSession();
  const req = (path, data = {}, {from = origin, session, headers = {}, method = 'POST', raw} = {}) =>
    fetch(origin + path, {method, headers: {Origin: from, 'Content-Type': raw ? 'application/octet-stream' : 'application/json',
      ...(session ? {'X-VDJ-Session': session} : {}), ...headers}, ...(method === 'GET' ? {} : {body: raw ?? JSON.stringify(data)})});
  const r = await req('/api/pair', {code: pairs[0].code});
  const {session} = await r.json(); assert.equal(r.status, 200);
  return {host, origin, pairs, req, session, native: () => nativeContext, closed: () => closed, calls: () => calls, artifacts};
}

test('one-time origin-bound pairing expires and invalidates all credentials', () => {
  let time = 0, expired = 0;
  const gate = createSessionGate({origins: [cloud], now: () => time, lifetimeMs: 1000, onExpire: () => expired++});
  const {code} = gate.issue(cloud);
  assert.throws(() => gate.exchange('https://evil.example', code));
  const {session} = gate.exchange(cloud, code);
  assert.throws(() => gate.exchange(cloud, code));
  assert.equal(gate.verify(cloud, session), true);
  assert.equal(gate.verify('https://evil.example', session), false);
  time = 1000; assert.equal(gate.verify(cloud, session), false); assert.equal(expired, 1);
});

test('local server requires exact Host, Origin, session and uses no credential in URLs', async t => {
  const h = await setup(t);
  assert.equal((await h.req('/api/state', {}, {session: h.session})).status, 200);
  assert.equal((await h.req('/api/state')).status, 401);
  assert.equal((await h.req('/api/state', {}, {session: h.session, from: 'null'})).status, 403);
  assert.equal((await h.req('/api/state', {}, {session: h.session, from: 'https://evil.example'})).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const r = http.request(h.origin + '/api/state', {method: 'POST', headers: {Host: 'evil.example', Origin: h.origin, 'X-VDJ-Session': h.session, 'Content-Type': 'application/json'}}, res => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject); r.end('{}');
  });
  assert.equal(badHost, 403);
  assert.equal((await h.req('/api/state?session=' + h.session, {}, {session: h.session})).status, 404);
  assert.equal((await h.req('/api/state', {}, {session: h.session, headers: {'X-Forwarded-Host': 'evil.example'}})).status, 403);
});

test('cloud pairing is separate, bound to origin, and cannot bootstrap', async t => {
  const h = await setup(t); await h.host.pairCloud();
  const code = h.pairs[1].code;
  assert.equal((await h.req('/api/pair', {code})).status, 403);
  const r = await h.req('/api/pair', {code}, {from: cloud}); const {session} = await r.json();
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), cloud);
  assert.equal((await h.req('/api/state', {}, {from: cloud, session})).status, 200);
  assert.equal((await h.req('/api/state', {}, {session})).status, 401);
  assert.equal((await h.req('/api/bootstrap/prepare', {}, {from: cloud, session})).status, 400);
});

test('preflight is exact, limited and does not enable wildcard origins', async t => {
  const h = await setup(t);
  const r = await h.req('/api/render', {}, {method: 'OPTIONS', from: cloud,
    headers: {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-vdj-session'}});
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), cloud);
  assert.equal((await h.req('/api/render', {}, {method: 'OPTIONS', from: cloud,
    headers: {'Access-Control-Request-Method': 'PUT'}})).status, 403);
});

test('code-free receive/reply diagnostics work after session expiry and expose no credentials',async t=>{
 const events=[];const h=await setup(t,{onDiagnostic:e=>events.push(e)});await h.host.stop();
 const preflight=await h.req('/api/status',{}, {method:'OPTIONS',from:cloud,
  headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
 assert.equal(preflight.status,204);
 const reply=await h.req('/api/status',{}, {from:cloud});assert.equal(reply.status,403);
 assert.deepEqual(await reply.json(),{code:'LOCAL_STATUS_ONLY'});
 assert(events.some(e=>e.event==='STATUS_PREFLIGHT_RECEIVED'));
 assert(events.some(e=>e.event==='STATUS_PROBE_RECEIVED'));
 assert.deepEqual(events.filter(e=>e.event==='STATUS_REPLY_FINISHED').map(e=>e.reason),['204','403']);
 const serialized=JSON.stringify(events);assert(!serialized.includes(h.session));
 for(const p of h.pairs)assert(!serialized.includes(p.code));
});

test('render uses authoritative ID resolution; browser plan and QC are rejected', async t => {
  const h = await setup(t);
  const input = {roomId: 'room', cueId: 'cue', expectedRevision: 1};
  const r = await h.req('/api/render', input, {session: h.session});
  assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, 4096);
  assert.equal((await h.req('/api/render', {...input, qc: {passed: true}}, {session: h.session})).status, 400);
  assert.equal((await h.req('/api/render', {...input, roomId: 'other'}, {session: h.session})).status, 400);
  assert.equal(h.calls(), 1);
});

test('Stop invalidates all sessions and removes private store', async t => {
  const h = await setup(t);
  await h.native().store.save({id: 'clip', bytes: Buffer.from('synthetic'), contentType: 'video/mp4', binding: {}});
  assert.equal((await h.req('/api/artifact', {roomId: 'room', assetId: 'clip'}, {session: h.session})).status, 200);
  assert.equal((await h.req('/api/stop', {}, {session: h.session})).status, 200);
  assert.equal((await h.req('/api/state', {}, {session: h.session})).status, 401);
  assert.equal(h.closed(), 1);
  await assert.rejects(h.native().store.read('clip'));
});

test('late render after Stop is not returned', async t => {
  let release; const renderWait = new Promise(r => { release = r; });
  const h = await setup(t, {renderWait});
  const request = h.req('/api/render', {roomId: 'room', cueId: 'cue', expectedRevision: 1}, {session: h.session});
  while (!h.calls()) await new Promise(r => setTimeout(r, 1));
  await h.host.stop(); release();
  const r = await request; assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), {code: 'MAC_HOST_REQUEST_HELD'});
});

test('old runtime cannot update a reopened session', async t => {
  const h = await setup(t), old = h.native();
  await h.host.beginSession();
  assert.throws(() => old.updateCurrent({music: {}}), /SESSION_ENDED/);
  assert.equal((await h.req('/api/state', {}, {session: h.session})).status, 401);
});

test('native and store exception details never enter HTTP response', async t => {
  const h = await setup(t);
  h.native().store.read = async () => { throw Error('private detail must stay native'); };
  const r = await h.req('/api/artifact', {roomId: 'room', assetId: 'clip'}, {session: h.session});
  assert.deepEqual(await r.json(), {code: 'MAC_HOST_REQUEST_HELD'});
});

test('temporary owner input never occurs on cancel and no Keychain reader is accepted', async () => {
  let reads = 0;
  const access = createOwnerCredentialAccess({confirm: async () => false, requestSessionCredential: async () => { reads++; }});
  await assert.rejects(access.withCredential(() => {}), /OWNER_CANCELLED/); assert.equal(reads, 0);
  const approved = createOwnerCredentialAccess({confirm: async () => true, requestSessionCredential: async () => { reads++; return 'synthetic'; }});
  assert.equal(await approved.withCredential(async key => key.length), 9); assert.equal(reads, 1);
});

test('browser transport verifies artifact bytes and forgets expired sessions', async t => {
  const h = await setup(t);
  await h.native().store.save({id: 'clip', bytes: Buffer.from('synthetic'), contentType: 'video/mp4', binding: {}});
  const transport = createMacConnection({origin: h.origin, session: h.session,
    fetchImpl: (url, options) => fetch(url, {...options, headers: {...options.headers, Origin: h.origin}})});
  assert.equal((await transport.readArtifact({roomId: 'room', assetId: 'clip'})).bytes.length, 9);
  await h.host.stop(); await assert.rejects(transport.state()); await assert.rejects(transport.state(), /LOCAL_SESSION_ENDED/);
});

test('startup bundle and HTML contain no session credential and no remote script', async t => {
  const h = await setup(t);
  const r = await fetch(h.origin); const page = await r.text();
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(page.includes(h.session), false); assert.equal(page.includes(h.pairs[0].code), false);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(h.origin + '/private')).status, 403);
});

test('native WAV bootstrap runs measured QC and private save through the local startup API', {skip:process.platform!=='darwin'}, async t => {
  const {deflateSync} = await import('node:zlib');
  const crc = bytes => { let value = -1; for (const b of bytes) { value ^= b; for (let i=0;i<8;i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); } return (value ^ -1) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); out.write(type,4); data.copy(out,8); out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2,4); header[8]=8; header[9]=2;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255,0,0,0,255,0,0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);
  const n = 24*44100, wav = Buffer.alloc(44+n*4); wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(2,22); wav.writeUInt32LE(44100,24);
  wav.writeUInt32LE(44100*4,28); wav.writeUInt16LE(4,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(n*4,40);
  for (let i=0;i<n;i++) { const v=Math.round(.1*Math.sin(i*2*Math.PI*220/44100)*32768); wav.writeInt16LE(v,44+i*4); wav.writeInt16LE(v,46+i*4); }
  const h=await setup(t);
  assert.equal((await h.req('/api/bootstrap/audio', null, {session:h.session,raw:wav})).status,200);
  assert.equal((await h.req('/api/bootstrap/reference', null, {session:h.session,raw:png})).status,200);
  const prepared=await h.req('/api/bootstrap/prepare',{}, {session:h.session});
  assert.equal(prepared.status,200); assert.equal((await prepared.json()).actualPlayback,false);
  const source=h.native().readCurrent();
  assert.equal(source.playback.phase,'IDLE'); assert.equal(source.music.contextSeconds,16);
  assert.equal(source.music.profile.frameCount,n); assert.equal(h.native().store.usage().assets,3);
});

test('missing Origin is rejected even when there is no configured cloud origin', async t => {
  const h=await setup(t,{cloudOrigin:undefined});
  const r=await fetch(h.origin+'/api/state',{method:'POST',headers:{'Content-Type':'application/json','X-VDJ-Session':h.session},body:'{}'});
  assert.equal(r.status,403);
});

test('forget during an in-flight private body prevents late media delivery', async () => {
  let release, started=false;
  const token='a'.repeat(43);
  const client=createMacConnection({origin:'http://127.0.0.1:5555',session:token,fetchImpl:async()=>({
    status:200,ok:true,headers:new Headers(),arrayBuffer:async()=>{started=true; await new Promise(r=>{release=r;});return new ArrayBuffer(0);},
  })});
  const result=client.readArtifact({roomId:'room',assetId:'clip'}).catch(e=>e);
  while(!started)await new Promise(r=>setTimeout(r,1));
  client.forget();release();assert.ok((await result) instanceof Error);
});

test('native runtime composes current-source adapter and refuses stale reservation before render', async () => {
  const {createMacPrototypeRuntime} = await import('./runtime.mjs');
  const controller = new AbortController(); let reservationReads = 0;
  const runtime = createMacPrototypeRuntime({roomId:'room',store:{save(){},read(){}},signal:controller.signal,
    readCurrent:async()=>({music:{clipId:'seed',sha256:'a'.repeat(64),contextSha256:'b'.repeat(64),profile:{}},playback:{actual:false,revision:0,playedUntilFrame:0}}),
    readOperation:async()=>{throw Error('not called');},readVisualPlan:async()=>{},
    readReservation:async()=>{reservationReads++;return {roomId:'room',cue:{cueId:'different'},expectedRevision:1,plan:{}};},
    isReservationCurrent:async()=>true,native:{inspectAudio(){},inspectVideo(){}},fetchImpl:async()=>{throw Error('network forbidden');}});
  assert.equal((await runtime.currentForSelector('room')).actual,false);
  await assert.rejects(runtime.readRender({roomId:'room',cueId:'cue',expectedRevision:1}),/CURRENT_RESERVATION_REQUIRED/);
  assert.equal(reservationReads,1);
  await runtime.close();assert.throws(()=>runtime.currentForSelector('room'),/MAC_SESSION_ENDED/);
});

test('cancelling a replacement session leaves the existing session valid', async t => {
  let confirmations=0;
  const h=await setup(t,{confirm:async()=>++confirmations===1});
  await assert.rejects(h.host.beginSession(),/OWNER_CANCELLED/);
  assert.equal((await h.req('/api/state',{}, {session:h.session})).status,200);
});

test('cloud-paired owner connects the native reader; local callers cannot inject the owner proof',async t=>{
 const roomId='11111111-1111-4111-a111-111111111111',owner='a'.repeat(64);
 const h=await setup(t,{roomId,createRuntime:({signal})=>createOwnerCloudConnection({roomId,signal,fetchImpl:async(url,options)=>{
  assert.equal(new URL(url).origin,'https://ai-vdj.vercel.app');assert.equal(options.headers.get('X-Room-Owner'),owner);
  return new Response(JSON.stringify({roomId,sessionId:'example-epoch',generationEnabled:false,submissions:[{submissionId:'synthetic'}]}));
 }})});
 assert.equal((await h.req('/api/owner/connect',{roomId,ownerCapability:owner},{session:h.session})).status,400);
 await h.host.pairCloud();const r=await h.req('/api/pair',{code:h.pairs[1].code},{from:cloud});const {session}=await r.json();
 const connected=await h.req('/api/owner/connect',{roomId,ownerCapability:owner},{from:cloud,session});
 assert.deepEqual(await connected.json(),{connected:true,submissions:1,checkedAtMs:null,generationEnabled:false});
 const state=await h.req('/api/owner/state',{}, {session:h.session});assert.equal((await state.json()).submissions,1);
 await h.host.stop();assert.equal((await h.req('/api/owner/state',{}, {session:h.session})).status,401);
});

test('pairing diagnostics distinguish wrong origin, expired and used without returning the code',async t=>{
 let time=0;const events=[];const h=await setup(t,{now:()=>time,onDiagnostic:e=>events.push(e)});
 await h.host.pairCloud();
 const wrong=await h.req('/api/pair',{code:h.pairs[1].code});
 assert.deepEqual(await wrong.json(),{code:'PAIRING_ORIGIN_MISMATCH'});
 const used=await h.req('/api/pair',{code:h.pairs[0].code});
 assert.deepEqual(await used.json(),{code:'PAIRING_USED'});
 time=121000;const expired=await h.req('/api/pair',{code:h.pairs[1].code},{from:cloud});
 assert.deepEqual(await expired.json(),{code:'PAIRING_EXPIRED'});
 const state=await (await h.req('/api/status')).json();assert.equal(state.listening,true);
 assert.equal(state.lastPairingReason,'PAIRING_EXPIRED');assert.equal(state.localPaired,true);
 assert(events.some(e=>e.reason==='PAIRING_EXPIRED'));
 for(const p of h.pairs)assert(!JSON.stringify(events).includes(p.code));
});

test('cancelling cloud code does not end a valid local session',async t=>{
 let count=0;const h=await setup(t,{confirm:async()=>++count===1});
 await assert.rejects(h.host.pairCloud(),/OWNER_CANCELLED/);
 assert.equal((await h.req('/api/state',{}, {session:h.session})).status,200);
});

test('surrounding whitespace is accepted without weakening one-time origin binding',()=>{
 const gate=createSessionGate({origins:[cloud]});const p=gate.issue(cloud);
 const result=gate.exchange(cloud,' \n'+p.code+'\n ');assert.equal(gate.verify(cloud,result.session),true);
 assert.throws(()=>gate.exchange(cloud,p.code),/PAIRING_USED/);
});

test('exact approved bootstrap loads only after confirmation and remains unplayed',async t=>{
 const bytes=Buffer.from('synthetic'),sha=createHash('sha256').update(bytes).digest('hex');let loads=0;
 const prepared={source:{music:{clipId:'seed',sha256:sha,contextSha256:sha},video:{referenceSha256:sha},playback:{phase:'IDLE',actual:false}},
  audioBytes:bytes,contextBytes:bytes,referenceBytes:bytes,referenceContentType:'image/png',provenance:{kind:'owner-supplied-bootstrap',actualGenerationThisRun:false}};
 const h=await setup(t,{loadBootstrap:async()=>{loads++;return prepared;}});
 assert.equal(loads,1);const state=await (await h.req('/api/state',{}, {session:h.session})).json();
 assert.equal(state.phase,'BOOTSTRAP_READY');assert.equal(state.actualPlayback,false);assert.equal(state.generationEnabled,false);
 assert.equal((await (await h.req('/api/status')).json()).bootstrapReady,true);
 await h.host.stop();assert.equal((await (await h.req('/api/status')).json()).bootstrapReady,false);
 const denied=await createMacHost({roomId:'denied',confirm:async()=>false,loadBootstrap:async()=>{loads++;return prepared;}});
 await denied.listen();await assert.rejects(denied.beginSession(),/OWNER_CANCELLED/);await denied.close();assert.equal(loads,1);
});
