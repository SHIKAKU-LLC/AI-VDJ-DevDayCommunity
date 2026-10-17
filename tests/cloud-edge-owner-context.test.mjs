import test from 'node:test';
import assert from 'node:assert/strict';
import {createMacCloudEdgeSession} from '../integration/mac-host/cloud-edge-runtime.mjs';

const roomId='11111111-1111-4111-a111-111111111111',example_epoch='22222222-2222-4222-a222-222222222222';
const owner='a'.repeat(64),scope={roomId,sessionId:example_epoch,controlRevision:0};
test('nested native reads reuse only their active owner callback and reauthorize the next request',async t=>{
 let reads=0,allowed=true,clock=1000;
 const session=createMacCloudEdgeSession({enabled:true,roomId,projectURL:'https://example.supabase.co',now:()=>clock,expiresAtMs:2000,
  fetchImpl:async()=>{reads++;return allowed?Response.json({...scope,submissions:[],generationEnabled:false}):Response.json({},{status:403});}});
 t.after(()=>session.close());await session.attachOwner({ownerCapability:owner});
 let detached,releaseLate;
 await session.withOwnerAuthorization({roomId},async a=>{
  await session.withOwnerAuthorization(scope,async b=>{assert.equal(a.ownerCapability,b.ownerCapability);});
  await assert.rejects(session.withOwnerAuthorization({...scope,controlRevision:1},()=>assert.fail('wrong scope')));
  // Async resources created here inherit this request but cannot use it later.
  detached=new Promise(resolve=>{releaseLate=resolve;}).then(()=>session.withOwnerAuthorization(scope,()=>assert.fail('completed context')));
  detached.catch(()=>{});
 });
 assert.equal(reads,2,'attach and one request, without repeated host/session reads');
 releaseLate();await assert.rejects(detached,/CONTEXT_HOLD/);assert.equal(reads,2);
 // A separate request always rechecks the backend owner.
 await session.withOwnerAuthorization(scope,()=>true);assert.equal(reads,3);
 allowed=false;await assert.rejects(session.withOwnerAuthorization(scope,()=>assert.fail('revoked owner')));
 allowed=true;clock=2000;await assert.rejects(session.withOwnerAuthorization(scope,()=>assert.fail('expired')));
});
test('parallel root requests have separate owner checks and closed sessions reject nested callbacks',async t=>{
 let reads=0;
 const session=createMacCloudEdgeSession({enabled:true,roomId,projectURL:'https://example.supabase.co',
  fetchImpl:async()=>{reads++;return Response.json({...scope,submissions:[],generationEnabled:false});}});
 t.after(()=>session.close());await session.attachOwner({ownerCapability:owner});
 let release;const barrier=new Promise(r=>{release=r;});
 const a=session.withOwnerAuthorization(scope,async()=>{await barrier;return session.withOwnerAuthorization(scope,()=>true);});
 const b=session.withOwnerAuthorization(scope,()=>true);await b;assert.equal(reads,3);release();await a;
 await assert.rejects(session.withOwnerAuthorization(scope,async()=>{await session.close();return session.withOwnerAuthorization(scope,()=>true);}));
});
test('approved background loop leaves completed request context and rechecks owner before work',async t=>{
 let reads=0,allowed=true,configuration;
 const session=createMacCloudEdgeSession({enabled:true,roomId,projectURL:'https://example.supabase.co',now:()=>1000,expiresAtMs:2000,
  createNativeHost:c=>{configuration=c;return {start:async()=>{},close:async()=>{}};},
  fetchImpl:async url=>{
   if(url.endsWith('/host/session')){reads++;return allowed?Response.json({...scope,submissions:[],generationEnabled:false}):Response.json({},{status:403});}
   if(url.endsWith('/runtime/scope'))return Response.json({...scope,expiresAtMs:2000});
   if(url.endsWith('/runtime/query'))return Response.json({rows:[{...scope,expiresAtMs:2000,ownerEnabled:true}]});
   assert.fail('unexpected synthetic route');
  }});
 t.after(()=>session.close());await session.attachOwner({ownerCapability:owner});await session.prepareRegistration();
 await session.activateNative({approved:true,configuration:{bootstrapConfiguration:{},credentialForOperation:()=>assert.fail('no provider')}});
 let release,work;
 await session.withOwnerAuthorization(scope,async()=>{
  configuration.runBackground(()=>{work=new Promise(r=>{release=r;}).then(()=>configuration.withOwnerAuthorization(scope,()=>true));work.catch(()=>{});});
 });
 const before=reads;release();assert.equal(await work,true);assert.equal(reads,before+1);
 allowed=false;await assert.rejects(configuration.runBackground(()=>configuration.withOwnerAuthorization(scope,()=>assert.fail('revoked owner'))));
 await session.close();await assert.rejects(configuration.runBackground(()=>configuration.withOwnerAuthorization(scope,()=>assert.fail('closed session'))));
});
