import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createJudgeStore} from '../cloud/server/judge-store.mjs';
import {createJudgeCloudService} from '../cloud/server/service.mjs';
import {createServerCredentialCustodian} from '../cloud/server/key-custodian.mjs';
import {parseJudgeConfiguration} from '../cloud/server/config.mjs';
import {createServerNativeLoader} from '../cloud/server/native-limiter.mjs';
const a='a'.repeat(64),b='b'.repeat(64),d='d'.repeat(64);
const nonce='11111111-1111-4111-a111-111111111111',other='22222222-2222-4222-a222-222222222222';
const origin='https://ai-vdj.vercel.app';
test('all rooms share at most two native CPU tasks and queued work expires',async()=>{
 let active=0,peak=0,now=1;const releases=[];
 const task=async()=>{active++;peak=Math.max(active,peak);await new Promise(r=>releases.push(r));active--;return true;};
 const load=createServerNativeLoader({expiresAtMs:10,now:()=>now,createRuntime:async()=>({native:{inspectAudio:task},inspectBootstrap:task,inspectReference:task})});
 const [first,second]=await Promise.all([load({}),load({})]);
 const jobs=[first.native.inspectAudio(),second.native.inspectAudio(),first.inspectBootstrap()];
 const settled=Promise.allSettled(jobs);assert.equal(peak,2);now=10;
 releases.forEach(r=>r());const results=await settled;assert.equal(results[2].status,'rejected');
 assert.equal(peak,2);
});
async function database(maximumCents=250,maximumRooms=2){
 const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 await db.exec(await readFile(new URL('../cloud/room/schema.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../cloud/server/judge-state.sql',import.meta.url),'utf8'));
 await db.query("insert into vdj_internal.judge_events values('judge-test',true,now()+interval '1 hour',$1,$2)",[maximumRooms,maximumCents]);
 return {db,store:createJudgeStore({query:(...x)=>db.query(...x),eventId:'judge-test'})};
}
test('public judge creation is idempotent; an unrelated proof cannot recover or control it',async()=>{
 const {db,store}=await database();try{
  const first=await store.create({nonce,ownerToken:a,joinCode:b});
  assert.deepEqual(await store.create({nonce,ownerToken:a,joinCode:b}),first);
  await assert.rejects(store.create({nonce,ownerToken:d,joinCode:b}),/JUDGE_DENIED/);
  await assert.rejects(store.authorize(first.roomId,b),/JUDGE_DENIED/);
  assert.equal((await store.authorize(first.roomId,a)).roomId,first.roomId);
  const raw=await db.query('select owner_proof,join_proof from vdj_internal.rooms');
  assert.ok(!JSON.stringify(raw.rows).includes(a));assert.ok(!JSON.stringify(raw.rows).includes(b));
 }finally{await db.close();}
});
test('the global budget is durable across stores, reserves once, and rejects another room over cap',async()=>{
 const {db,store}=await database();try{
  const first=await store.create({nonce,ownerToken:a,joinCode:b});
  const second=await store.create({nonce:other,ownerToken:b,joinCode:d});
  const input={roomId:first.roomId,capability:a,planId:'plan-first',cents:250};
  await store.reserve(input);await store.reserve(input);
  const restarted=createJudgeStore({query:(...x)=>db.query(...x),eventId:'judge-test'});
  await restarted.reserve(input);
  await assert.rejects(restarted.reserve({roomId:second.roomId,capability:b,planId:'plan-second',cents:100}),/JUDGE_BUDGET/);
  await assert.rejects(restarted.reserve({...input,cents:100}),/JUDGE_DENIED/);
  assert.equal((await db.query('select sum(cents)::int as total from vdj_internal.judge_reservations')).rows[0].total,250);
 }finally{await db.close();}
});
test('room quota, per-room cap, deadline and immediate disable all fail closed',async()=>{
 const {db,store}=await database(1000,1);try{
  const r=await store.create({nonce,ownerToken:a,joinCode:b});
  await assert.rejects(store.create({nonce:other,ownerToken:b,joinCode:d}),/JUDGE_CAPACITY/);
  await store.reserve({roomId:r.roomId,capability:a,planId:'plan-a',cents:250});
  await assert.rejects(store.reserve({roomId:r.roomId,capability:a,planId:'plan-b',cents:50}),/JUDGE_BUDGET/);
  await db.exec('update vdj_internal.judge_events set enabled=false');
  await assert.rejects(store.authorize(r.roomId,a),/JUDGE_CLOSED/);
  await db.exec("update vdj_internal.judge_events set enabled=true,expires_at=now()-interval '1 second'");
  await assert.rejects(store.create({nonce,ownerToken:a,joinCode:b}),/JUDGE_CLOSED/);
 }finally{await db.close();}
});
test('browser roles cannot invoke judge admission or access its tables',async()=>{
 const {db}=await database();try{for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  await assert.rejects(db.query("select public.vdj_judge_request('create','judge-test')"),/permission denied/);
  await assert.rejects(db.query('select * from vdj_internal.judge_events'),/permission denied/);
  await db.exec('reset role');
 }}finally{await db.close();}
});
test('cloud HTTP uses a single initialized worker, keeps tenant proofs distinct and hides failures',async()=>{
 let now=1,created=0,closed=0,authorized=0;
 const configuration={origin,expiresAtMs:100,maximumResidentRooms:1};
 const store={authorize:async(_r,key)=>{authorized++;if(key!==a)throw Error('JUDGE_DENIED');},reserve:async()=>{}};
 const service=createJudgeCloudService({configuration,store,now:()=>now,
  forwardRoom:async()=>Response.json({guest:true}),createRuntime:async()=>{created++;return {
   handleRequest:async()=>Response.json({server:true}),close:async()=>{closed++;}};}});
 const request=key=>new Request(origin+'/api/rooms/'+nonce+'/native/capabilities',{headers:{'x-room-owner':key}});
 const results=await Promise.all([service.handleRequest(request(a)),service.handleRequest(request(a))]);
 assert.ok(results.every(r=>r.ok));assert.equal(created,1);assert.equal(authorized,2);
 assert.equal((await service.handleRequest(request(b))).status,403);assert.equal(created,1);
 const denied=await service.handleRequest(new Request(origin+'/api/rooms/'+nonce+'/operator/connection',
  {method:'POST',headers:{origin,'x-room-owner':a}}));assert.equal(denied.status,403);
 now=100;assert.equal((await service.handleRequest(request(a))).status,410);
 await service.close();assert.equal(closed,1);
});
test('server credential custody checks room revision and expiry; returned metadata contains no key',async()=>{
 let revision=0,now=1,reads=0;
 const {epoch:sessionId}={epoch:other};
 const scope=()=>({roomId:nonce,sessionId,controlRevision:revision,expiresAtMs:100});
 const custodian=createServerCredentialCustodian({readCredential:async()=>{reads++;return 'synthetic-test-secret';},
  readScope:async()=>scope(),platform:{verifyCredential:async()=>({authenticated:true})},expiresAtMs:50,now:()=>now});
 const record=await custodian.readActive(scope());assert.equal(reads,1);assert.ok(!JSON.stringify(record).includes('secret'));
 assert.equal(await custodian.withCredential(record,key=>key.length),21);
 revision++;await assert.rejects(custodian.withCredential(record,()=>1),/SERVER_CREDENTIAL_HOLD/);
 now=50;await assert.rejects(custodian.readActive(scope()),/SERVER_CREDENTIAL_HOLD/);custodian.close();
});
test('judge configuration rejects an unapproved deployment, foreign project, overspend and extended deadline',()=>{
 const source={roomId:nonce,...Object.fromEntries(['audio','reference','video'].map(k=>[k,{assetId:'synthetic-'+k,sha256:a}]))};
 const valid={version:'judge-cloud-v1',approved:true,eventId:'judge-test',origin,projectURL:'https://sbrghwehlkptbnbxhymu.supabase.co',
  expiresAtMs:1792335540000,maximumRooms:20,maximumResidentRooms:10,maximumCents:15000,autoTopUp:false,bounds:{},infrastructureMaximumUsd:20,source,
  billingObservedAtMs:1,billingEvidenceSha256:a};
 assert.equal(parseJudgeConfiguration(valid,{now:()=>1}).maximumCents,15000);
 for(const patch of [{approved:false},{projectURL:'https://foreign.example'},{maximumCents:50001},{expiresAtMs:1792335540001},{autoTopUp:true},{billingObservedAtMs:2}])
  assert.throws(()=>parseJudgeConfiguration({...valid,...patch},{now:()=>1}));
});
