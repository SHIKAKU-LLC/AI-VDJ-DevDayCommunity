import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createHostSessionHandler} from '../cloud/generation/owner-connection.mjs';
import {createOwnerCloudConnection} from '../integration/runtime/owner-cloud-connection.mjs';

const owner='a'.repeat(64),guest='b'.repeat(64),invite='c'.repeat(64),origin='https://ai-vdj.vercel.app';
test('real room/cue SQL authenticates only the owner before exposing the read-only Mac session',async()=>{
 const db=new PGlite();
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql'])
   await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
  const uid='11111111-1111-4111-a111-111111111111';await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);
  const rpc=async(op,roomId,capability,payload={},verified=null)=>(await db.query('select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) result',[op,roomId,capability,JSON.stringify(payload),verified])).rows[0].result;
  const room=await rpc('create',null,null,{ownerCapability:owner,joinCode:invite},uid);
  await rpc('join',room.roomId,invite,{nickname:'synthetic guest',participantCapability:guest});
  await rpc('submit',room.roomId,guest,{nonce:'synthetic_nonce_1234567890',prompt:'synthetic idea'});
  const handler=createHostSessionHandler({authorizeOwner:async(id,capability)=>db.query("select public.vdj_generation_request('cueState',$1,$2,'{}')",[id,capability]),readRoom:(id,cap)=>rpc('read',id,cap)});
  const request=(cap,from=origin,body='{}')=>handler(new Request(origin+'/api/rooms/'+room.roomId+'/host/session',{
   method:'POST',headers:{Origin:from,'Content-Type':'application/json','X-Room-Owner':cap},body}));
  assert.equal((await request(guest)).status,403);assert.equal((await request(owner,'https://evil.invalid')).status,403);
  assert.equal((await request(owner,origin,'{"url":"https://evil.invalid"}')).status,400);
  const result=await request(owner),data=await result.json();assert.equal(result.status,200);assert.equal(data.submissions.length,1);
  assert.equal(data.submissions[0].prompt,'synthetic idea');assert.equal(data.generationEnabled,false);
  assert(!JSON.stringify(data).includes(owner));assert(!JSON.stringify(data).includes(guest));
  const counts=(await db.query('select (select count(*) from vdj_internal.generation_permits) permits,(select count(*) from vdj_internal.generation_operations) operations')).rows[0];
  assert.deepEqual(counts,{permits:0,operations:0});
 }finally{await db.close();}
});
test('native cloud connection fixes upstream origin, omits credentials from URLs and rejects late reads after close',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111';let last,release;
 const connection=createOwnerCloudConnection({roomId,fetchImpl:async(url,options)=>{last={url,options};return new Response(JSON.stringify({roomId,sessionId:'example-epoch',submissions:[],generationEnabled:false}));}});
 await connection.attachOwner({ownerCapability:owner});assert.equal(connection.status().connected,true);
 assert.equal(last.options.headers.get('X-Room-Owner'),owner);assert(!last.url.includes(owner));
 connection.close();assert.equal(connection.status().connected,false);await assert.rejects(connection.readCloud(),/CONNECTION_REQUIRED/);
 assert.throws(()=>createOwnerCloudConnection({roomId,origin:'https://evil.invalid'}),/EXISTING_ROOM/);
 const late=createOwnerCloudConnection({roomId,fetchImpl:async()=>{await new Promise(r=>release=r);return new Response(JSON.stringify({roomId,sessionId:'example-epoch',submissions:[],generationEnabled:false}));}});
 const work=late.attachOwner({ownerCapability:owner});late.close();release();await assert.rejects(work,/CONNECTION_ENDED/);
});
test('native Edge owner checks use the approved project directly and retain fresh authorization',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111',projectURL='https://example.supabase.co';
 let calls=0,allowed=true;
 const connection=createOwnerCloudConnection({roomId,projectURL,allowRuntimeOwnerContext:true,
  contextExpiresAtMs:Date.now()+60000,fetchImpl:async(url,options)=>{
   calls++;assert.equal(url,projectURL+'/functions/v1/ai-vdj-room/api/rooms/'+roomId+'/host/session');
   assert.equal(options.headers.get('origin'),origin);assert.equal(options.headers.get('x-room-owner'),owner);
   assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
   return allowed?Response.json({roomId,sessionId:'example-epoch',controlRevision:0,submissions:[],generationEnabled:false}):new Response('{}',{status:403});
  }});
 await connection.attachOwner({ownerCapability:owner});
 assert.equal(await connection.withOwnerAuthorization({roomId,sessionId:'example-epoch',controlRevision:0},()=>true),true);
 allowed=false;await assert.rejects(connection.withOwnerAuthorization({roomId},()=>assert.fail('revoked owner must not execute')));
 assert.equal(calls,3);connection.close();
 for(const projectURL of ['https://evil.invalid','http://example.supabase.co','https://example.supabase.co/path',
  'https://example.supabase.co?other=1'])
  assert.throws(()=>createOwnerCloudConnection({roomId,projectURL}),/EXISTING_ROOM_PROJECT_REQUIRED/);
});
