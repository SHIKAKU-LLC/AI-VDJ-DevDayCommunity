import test from 'node:test';
import assert from 'node:assert/strict';
import {createJudgeCloudService} from '../cloud/server/service.mjs';
import {createServerCredentialCustodian} from '../cloud/server/key-custodian.mjs';
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
