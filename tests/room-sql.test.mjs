import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createRoomHandler} from '../cloud/room/handler.mjs';
import {createRoomApiClient} from '../snapshot/room-ui-v3/room-api-client.mjs';
import {createRoomModelPort} from '../snapshot/room-ui-v3/room-model-port.mjs';
import {createRoomUIModel} from '../snapshot/room-ui-v3/room-ui-model.mjs';
const uid='11111111-1111-4111-a111-111111111111';
const other='22222222-2222-4222-a222-222222222222';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64);
const sql=await readFile(new URL('../cloud/room/schema.sql',import.meta.url),'utf8');
async function setup(){
 const db=new PGlite();
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 await db.exec(sql);await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);
 const rpc=async({op,room_id=null,capability=null,payload={},verified_uid=null})=>{
  const rows=await db.query('select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) as result',
   [op,room_id,capability,JSON.stringify(payload),verified_uid]);return rows.rows[0].result;
 };
 const r=await rpc({op:'create',verified_uid:uid,payload:{ownerCapability:a,joinCode:b}});
 const call=(op,capability=a,payload={})=>rpc({op,room_id:r.roomId,capability,payload});
 const join=async(cap,nickname)=>call('join',b,{nickname,participantCapability:cap});
 const submit=(cap,nonce='submit_'+'x'.repeat(24),prompt='夜の海',nickname='host')=>
  call('submit',cap,{nonce,prompt,...(cap===a?{nickname}:{})});
 return {db,r,rpc,call,join,submit};
}
test('DDL applies; browser roles cannot execute RPC or read internal tables',async()=>{
 const x=await setup();try{
  await x.db.exec('set role anon');
  await assert.rejects(x.db.query('select public.vdj_room_request($1)', ['read']),/permission denied/);
  await assert.rejects(x.db.query('select * from vdj_internal.rooms'),/permission denied/);
  await x.db.exec('reset role; set role service_role');
  assert.equal((await x.call('read')).roomId,x.r.roomId);
 }finally{await x.db.close();}
});
test('owner requires fixed allowlist; participant invitation never authorizes owner operations',async()=>{
 const x=await setup();try{
  await assert.rejects(x.rpc({op:'create',verified_uid:other,payload:{ownerCapability:c,joinCode:d}}),/OWNER_DENIED/);
  await assert.rejects(x.call('read',b),/ACTOR_DENIED/);
  const guest=await x.join(c,'guest');
  await assert.rejects(x.call('control',c,{nonce:'control_'+ 'x'.repeat(24),expectedRevision:1,accepting:false}),/OWNER_DENIED/);
  assert.ok(guest.participantId);await x.db.exec('update vdj_internal.owners set enabled=false');
  await assert.rejects(x.call('read'),/ACTOR_DENIED/);
 }finally{await x.db.close();}
});
test('participant reads isolate prompts, receipts, submissions and feed; raw proofs never returned',async()=>{
 const x=await setup();try{
  await x.join(c,'one');await x.join(d,'two');
  const one=await x.submit(c);await x.submit(d,'submit_'+ 'z'.repeat(24),'朝の森');
  const view=await x.call('read',c);assert.equal(view.submissions.length,1);assert.equal(view.submissions[0].prompt,'夜の海');
  const two=await x.call('read',d);assert.equal(two.submissions.length,1);
  await assert.rejects(x.call('submission',d,{submissionId:one.submissionId}),/OPERATION_NOT_FOUND/);
  await assert.rejects(x.call('operation',d,{nonce:one.nonce}),/OPERATION_NOT_FOUND/);
  assert.equal((await x.call('events',c)).snapshot.submissions.length,1);
  const raw=JSON.stringify(view);for(const secret of [a,b,c,d])assert.ok(!raw.includes(secret));
  assert.equal(view.currentCredit,null);assert.deepEqual(view.cues,[]);assert.equal(view.mode,'collect');
 }finally{await x.db.close();}
});
test('nonce duplicate returns exact receipt; conflicting payload and cross-instance replay are safe',async()=>{
 const x=await setup();try{
  await x.join(c,'one');const first=await x.submit(c);const second=await x.submit(c);
  assert.deepEqual(second,first);assert.deepEqual(await x.call('operation',c,{nonce:first.nonce}),{kind:'submission',nonce:first.nonce,receipt:first});
  await assert.rejects(x.submit(c,first.nonce,'別の内容'),/NONCE_CONFLICT/);
  assert.equal((await x.call('read')).submissions.length,1);
  // A fresh adapter closes over no room state. Receipts remain in PostgreSQL.
  const fresh=async args=>(await x.db.query('select public.vdj_room_request($1,$2,$3,$4::jsonb,null) as r',
   [args.op,x.r.roomId,c,JSON.stringify(args.payload)])).rows[0].r;
  assert.deepEqual(await fresh({op:'operation',payload:{nonce:first.nonce}}),{kind:'submission',nonce:first.nonce,receipt:first});
 }finally{await x.db.close();}
});
test('control CAS and nonce recovery; acceptance OFF preserves owner admission; generation fails closed',async()=>{
 const x=await setup();try{
  await x.join(c,'guest');const nonce='control_'+ 'x'.repeat(24);
  const body={nonce,expectedRevision:0,accepting:false};const receipt=await x.call('control',a,body);
  assert.deepEqual(await x.call('control',a,body),receipt);assert.equal(receipt.controlRevision,1);assert.equal((await x.call('read')).eventSeq,2);
  assert.deepEqual(await x.call('operation',a,{nonce}),{kind:'owner-control',nonce,receipt});
  await assert.rejects(x.submit(c),/ACCEPTANCE_OFF/);assert.ok((await x.submit(a)).submissionId);
  await assert.rejects(x.call('control',a,{nonce:'control_'+ 'y'.repeat(24),expectedRevision:0,accepting:true}),/REVISION_CONFLICT/);
  await assert.rejects(x.call('control',a,{nonce:'control_'+ 'z'.repeat(24),expectedRevision:1,generationPaused:false}),/PROVIDER_NOT_CONNECTED/);
 }finally{await x.db.close();}
});
test('durable rate and participant caps, input normalization and TTL apply without RAM state',async()=>{
 const x=await setup();try{
  await assert.rejects(x.join(c,'Ａ'),/NICKNAME_INVALID/);
  await x.join(c,'one');for(let i=0;i<6;i++)await x.submit(c,'submit_'+String(i).padStart(24,'0'));
  await assert.rejects(x.submit(c,'submit_'+ 'z'.repeat(24)),/RATE_LIMITED/);
  assert.ok((await x.submit(c,'submit_'+String(0).padStart(24,'0'))).submissionId);
  for(let i=0;i<4;i++)await x.join(String(i).repeat(64),'next');
  await assert.rejects(x.join(d,'six'),/PARTICIPANT_CAP/);
  await x.db.exec("update vdj_internal.rooms set expires_at=now()-interval '1 second'");
  await assert.rejects(x.call('read',c),/ROOM_EXPIRED/);
 }finally{await x.db.close();}
});
test('HTTP checks Auth, methods, body cap and origin; no error detail leak',async()=>{
 const x=await setup();try{
  const handler=createRoomHandler({rpc:x.rpc,verifyOwner:async()=>null});
  const req=(path,options={})=>handler(new Request('https://example.test'+path,options));
  for(const prefix of ['', '/ai-vdj-room', '/functions/v1/ai-vdj-room']){
   const capabilities=await req(prefix+'/api/room-capabilities');
   assert.equal(capabilities.status,200);
   assert.equal((await capabilities.json()).generation,false);
   assert.equal((await req(prefix+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
   const hostedRead=await req(prefix+'/api/rooms/'+x.r.roomId,{headers:{'X-Room-Owner':a}});
   assert.equal(hostedRead.status,200);
   assert.equal((await hostedRead.json()).roomId,x.r.roomId);
  }
  assert.equal((await req('/ai-vdj-room-extra/api/room-capabilities')).status,404);
  assert.equal((await req('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await req('/api/room-capabilities',{headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal((await req('/api/rooms/'+x.r.roomId,{method:'DELETE'})).status,404);
  assert.equal((await req('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(8193)})).status,413);
  const failing=createRoomHandler({rpc:async()=>{throw Error('sensitive database detail')},verifyOwner:async()=>uid});
  const headers=new Headers();headers.set('X-Room-Owner',a);
  const response=await failing(new Request('https://example.test/api/rooms/'+x.r.roomId,{headers}));
  assert.deepEqual(await response.json(),{error:'ROOM_BACKEND_UNAVAILABLE'});
 }finally{await x.db.close();}
});
test('v3 port recovers lost submission POST by authenticated nonce GET',async()=>{
 const x=await setup();try{
  let lose=true;const handler=createRoomHandler({rpc:x.rpc,verifyOwner:async()=>uid,random:()=>c});
  const request=async(path,options)=>{
   const headers=new Headers(options.headers);if(options.body)headers.set('Content-Type','application/json');
   const r=await handler(new Request('https://example.test'+path,{...options,headers,...(options.body?{body:JSON.stringify(options.body)}:{})}));
   const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error),{code:data.error,definitive:true});
   if(path.endsWith('/submissions')&&lose){lose=false;throw Error('response lost');}return data;
  };
  const client=createRoomApiClient({request,roomId:x.r.roomId,joinCode:b,enabled:true});
  const port=createRoomModelPort({client});await port.readRoom();
  const nonce='submit_'+ 'x'.repeat(24);
  await assert.rejects(port.submit({nonce,nickname:'guest',prompt:'夜の海'}),/response lost/);
  const receipt=await port.readOperation(nonce);assert.equal(receipt.nonce,nonce);assert.ok(receipt.requestId);
  assert.equal((await port.readRoom()).requests.length,1);port.dispose();
 }finally{await x.db.close();}
});
test('v3 owner control propagates nonce/revision and recovers control receipt',async()=>{
 const x=await setup();try{
  const handler=createRoomHandler({rpc:x.rpc,verifyOwner:async()=>uid});
  const request=async(path,options)=>{const headers=new Headers(options.headers);if(options.body)headers.set('Content-Type','application/json');
   const r=await handler(new Request('https://example.test'+path,{...options,headers,...(options.body?{body:JSON.stringify(options.body)}:{})}));
   const data=await r.json();if(!r.ok)throw Error(data.error);return data;
  };
  const port=createRoomModelPort({owner:true,client:createRoomApiClient({request,roomId:x.r.roomId,ownerToken:a,enabled:true})});
  await port.readRoom();const nonce='control_'+ 'x'.repeat(24);
  const result=await port.ownerControl({action:'ACCEPT_OFF',nonce,expectedRevision:0});
  assert.equal(result.snapshot.accepting,false);assert.equal(result.snapshot.revision,1);
  assert.deepEqual((await port.readOperation(nonce)).snapshot,result.snapshot);port.dispose();
 }finally{await x.db.close();}
});
test('owner UI model reconciles a lost control response through the durable receipt',async()=>{
 const x=await setup();try{
  let lose=true;const handler=createRoomHandler({rpc:x.rpc,verifyOwner:async()=>uid});
  const request=async(path,options)=>{const headers=new Headers(options.headers);if(options.body)headers.set('Content-Type','application/json');
   const response=await handler(new Request('https://example.test'+path,{...options,headers,...(options.body?{body:JSON.stringify(options.body)}:{})}));
   const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error),{definitive:true});
   if(path.endsWith('/control')&&lose){lose=false;throw Error('response lost');}return data;
  };
  const port=createRoomModelPort({owner:true,client:createRoomApiClient({request,roomId:x.r.roomId,ownerToken:a,enabled:true})});
  const model=createRoomUIModel({port,uuid:()=> 'x'.repeat(24)});await model.load();
  await assert.rejects(model.ownerControl('ACCEPT_OFF'),/response lost/);
  assert.equal(model.read().operation.state,'UNKNOWN');await model.reconcile();
  assert.equal(model.read().operation,null);assert.equal(model.read().error,null);
  assert.equal(model.read().room.accepting,false);assert.equal(model.read().room.revision,1);
  model.dispose();port.dispose();
 }finally{await x.db.close();}
});
test('owner OTP hooks allow only configured identity and bound verification; no refresh/profile response',async()=>{
 const x=await setup();try{
  const email='owner@example.test';const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email));
  const hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  await x.db.query('update vdj_internal.owners set email_proof=$1',[hash]);let sends=0,checks=0;
  const handler=createRoomHandler({rpc:x.rpc,verifyOwner:async value=>value==='synthetic-placeholder'?uid:null,
   requestOTP:async()=>{sends++;},verifyOTP:async()=>{checks++;return {bearer:'synthetic-placeholder',expiresAt:9999999999,extra:'must not return'};}});
  const request=async(path,body)=>handler(new Request('https://example.test/api/owner/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
  await request('request-otp',{email:'other@example.test'});assert.equal(sends,0);
  for(let i=0;i<3;i++)assert.deepEqual(await (await request('request-otp',{email})).json(),{accepted:true});
  assert.equal(sends,2);
  assert.equal((await request('verify-otp',{email:'other@example.test',otp:'000000'})).status,403);assert.equal(checks,0);
  const response=await request('verify-otp',{email,otp:'000000'});
  assert.deepEqual(await response.json(),{bearer:'synthetic-placeholder',expiresAt:9999999999});
  for(let i=0;i<6;i++)await request('verify-otp',{email,otp:'000000'});assert.equal(checks,6);
 }finally{await x.db.close();}
});
test('authenticated owner recovery rotates owner and invite proofs, preserving guest admission data',async()=>{
 const x=await setup();try{
  await x.join(c,'guest');await x.submit(c);
  const ownerCap='3'.repeat(64),invitation='4'.repeat(64);
  await assert.rejects(x.rpc({op:'recoverOwner',verified_uid:other,payload:{ownerCapability:ownerCap,joinCode:invitation}}),/OWNER_DENIED/);
  const receipt=await x.rpc({op:'recoverOwner',verified_uid:uid,payload:{ownerCapability:ownerCap,joinCode:invitation}});
  assert.equal(receipt.roomId,x.r.roomId);assert.equal(receipt.submissions.length,1);assert.equal(receipt.controlRevision,0);
  await assert.rejects(x.call('read',a),/ACTOR_DENIED/);await assert.rejects(x.call('joinInfo',b),/INVITE_DENIED/);
  assert.equal((await x.call('read',c)).submissions.length,1);
  assert.equal((await x.call('read',ownerCap)).submissions.length,1);
 }finally{await x.db.close();}
});
test('new room retains expired room records while old access stays expired and new TTL stays four hours',async()=>{
 const x=await setup();try{
  await x.join(c,'guest');await x.submit(c);
  await x.db.query("update vdj_internal.rooms set expires_at=now()-interval '1 second' where id=$1",[x.r.roomId]);
  const before=(await x.db.query('select to_jsonb(r) as record from vdj_internal.rooms r where id=$1',[x.r.roomId])).rows[0].record;
  await assert.rejects(x.rpc({op:'recoverOwner',verified_uid:uid,payload:{ownerCapability:c,joinCode:d}}),/ROOM_NOT_FOUND/);
  const next=await x.rpc({op:'create',verified_uid:uid,payload:{ownerCapability:c,joinCode:d}});
  assert.notEqual(next.roomId,x.r.roomId);assert.deepEqual(next.submissions,[]);
  const after=(await x.db.query('select to_jsonb(r) as record from vdj_internal.rooms r where id=$1',[x.r.roomId])).rows[0].record;
  assert.deepEqual(after,before);assert.equal(after.participants.length,1);assert.equal(after.submissions.length,1);
  assert.equal((await x.db.query('select count(*)::int as n from vdj_internal.rooms')).rows[0].n,2);
  for(const [op,capability] of [['read',a],['read',c],['joinInfo',b]])await assert.rejects(x.call(op,capability),/ROOM_EXPIRED/);
  assert.equal((await x.db.query("select expires_at>now()+interval '3 hours 59 minutes' and expires_at<=now()+interval '4 hours' as ttl_unchanged from vdj_internal.rooms where id=$1",[next.roomId])).rows[0].ttl_unchanged,true);
  await assert.rejects(x.rpc({op:'create',verified_uid:uid,payload:{ownerCapability:a,joinCode:b}}),/ROOM_ALREADY_ACTIVE/);
  const recovered=await x.rpc({op:'recoverOwner',verified_uid:uid,payload:{ownerCapability:a,joinCode:b}});
  assert.equal(recovered.roomId,next.roomId);
  assert.deepEqual((await x.db.query('select to_jsonb(r) as record from vdj_internal.rooms r where id=$1',[x.r.roomId])).rows[0].record,before);
 }finally{await x.db.close();}
});
