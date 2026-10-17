import {createOwnerSetupModel} from '../room-web/owner-setup-model.mjs';
import {createEdgeRuntimeBroker} from '../cloud/room/runtime-broker.mjs';
import {cueDigest} from '../snapshot/app/runtime/intent-compiler.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createMacCompanionDeviceStore} from '../integration/mac-host/companion-device-store.mjs';
import {createRuntimeRequestSigner,createRuntimeRequestVerifier} from '../cloud/room/runtime-request-proof.mjs';
import {createMacCompanionRuntime} from '../integration/mac-host/companion-runtime.mjs';
import {parseCompanionConfiguration,COMPANION_PROJECT_URL,COMPANION_ORIGIN} from '../integration/mac-host/companion-config.mjs';
const roomId='11111111-1111-4111-a111-111111111111',example_epoch='22222222-2222-4222-a222-222222222222',owner='a'.repeat(64);
async function deviceFixture(){
  const pair=await crypto.subtle.generateKey('Ed25519',false,['sign','verify']),publicJwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
  let saved=null;const calls=[];
  const invoke=async(action,input)=>{calls.push(action);
    if(action==='read')return saved?structuredClone(saved):{registered:false};
    if(action==='enroll')return saved={workerId:'device-33333333-3333-4333-a333-333333333333',roomIds:[input.roomId],
      approvedAtMs:Date.now(),approved:true,revoked:false,publicJwk};
    if(action==='remove'){saved=null;return {removed:true};}
    assert(saved?.roomIds.includes(input.roomId));
    return {signature:Buffer.from(await crypto.subtle.sign('Ed25519',pair.privateKey,Buffer.from(input.payload,'base64'))).toString('base64url')};};
  return {invoke,calls};
}
test('native device identity restores across adapter/process instances; no IO by default and unregister removes signing',async()=>{
  const f=await deviceFixture(),off=createMacCompanionDeviceStore({invoke:f.invoke});
  await assert.rejects(off.read(roomId));assert.equal(f.calls.length,0);
  const first=createMacCompanionDeviceStore({enabled:true,invoke:f.invoke});assert.equal(await first.read(roomId),null);
  const enrolled=await first.save(roomId);first.close();
  const next=createMacCompanionDeviceStore({enabled:true,invoke:f.invoke}),identity=await next.identity(roomId);
  assert.equal(identity.workerId,enrolled.workerId);assert.equal(identity.publicKeySha256,enrolled.publicKeySha256);
  assert(!JSON.stringify(await next.read(roomId)).includes('private'));
  await next.remove(roomId);await assert.rejects(next.identity(roomId));next.close();
});
test('registered device renews signed <=30min leases beyond 30min; revoked device, edited lease and foreign room hold',async()=>{
  const f=await deviceFixture(),store=createMacCompanionDeviceStore({enabled:true,invoke:f.invoke});await store.save(roomId);
  const identity=await store.identity(roomId);let clock=Date.now(),revoked=false;
  const scope={roomId,sessionId:example_epoch,controlRevision:0,expiresAtMs:clock+3*3600000};
  const signer=await createRuntimeRequestSigner({enabled:true,scope,identity,expiresAtMs:scope.expiresAtMs,now:()=>clock});
  const verify=createRuntimeRequestVerifier({enabled:true,now:()=>clock,readApprovedWorker:async()=>null,
    readApprovedDevice:async()=>({...identity,sign:undefined,revoked}),readScope:async input=>{assert.equal(input.ownerCapability,owner);return scope;}});
  const path=`/api/rooms/${roomId}/runtime/query`,body=new TextEncoder().encode('{}');
  const request=async extra=>new Request(COMPANION_ORIGIN+path,{method:'POST',headers:{'content-type':'application/json','x-room-owner':owner,
    ...await signer.sign({path,body,ownerCapability:owner,contentType:'application/json'}),...extra},body});
  let verified=await verify({request:await request(),body,roomId});assert.equal(verified.registeredDevice,true);
  clock+=31*60000;verified=await verify({request:await request(),body,roomId});assert(verified.expiresAtMs<=clock+1800000);
  await assert.rejects(verify({request:await request({'x-vdj-runtime-until':String(clock+1800001)}),body,roomId}));
  await assert.rejects(verify({request:await request(),body,roomId:example_epoch}));revoked=true;
  await assert.rejects(verify({request:await request(),body,roomId}));signer.close();store.close();
});
test('prepared companion SQL renews only the same authenticated registered worker and keeps nonce replay fencing',async t=>{
  const db=new PGlite();t.after(()=>db.close());await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql',
    'cloud/jobs/player-observer-state.sql','cloud/jobs/durable-scheduler.sql','cloud/jobs/operator-state.sql','cloud/room/runtime-companion.sql'])
    await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
  await db.query('insert into vdj_internal.owners(uid)values($1)',[roomId]);
  const room=(await db.query("select public.vdj_room_request('create',null,null,$1::jsonb,$2) value",
    [JSON.stringify({ownerCapability:owner,joinCode:'b'.repeat(64)}),roomId])).rows[0].value;
  const example_scope=(await db.query("select public.vdj_runtime_request('scope',$1,$2,'{}','{}') value",[room.roomId,owner])).rows[0].value;
  const now=Date.now(),base={workerId:'device-33333333-3333-4333-a333-333333333333',roomId:example_scope.roomId,sessionId:example_scope.sessionId,
    controlRevision:example_scope.controlRevision,expiresAtMs:now+600000,requestedAtMs:now,nonceSha256:'a'.repeat(64),registeredDevice:true};
  const invoke=(runtime,capability=owner)=>db.query("select public.vdj_runtime_request('authorize',$1,$2,'{}',$3::jsonb)",
    [example_scope.roomId,capability,JSON.stringify(runtime)]);
  await db.exec('set role service_role');await invoke(base);
  const renewed={...base,expiresAtMs:now+900000,nonceSha256:'b'.repeat(64)};await invoke(renewed);
  await assert.rejects(invoke(renewed),/RUNTIME_REPLAY_HOLD/);
  await assert.rejects(invoke({...renewed,expiresAtMs:now+600000,nonceSha256:'c'.repeat(64)}),/RUNTIME_WORKER_HOLD/);
  await assert.rejects(invoke({...renewed,workerId:'device-44444444-4444-4444-a444-444444444444',nonceSha256:'c'.repeat(64)}),/RUNTIME_WORKER_HOLD/);
  await assert.rejects(invoke({...renewed,nonceSha256:'c'.repeat(64)},'c'.repeat(64)),/OWNER_DENIED/);
  await db.exec('reset role');
  const {registeredDevice,...legacy}=renewed;
  await assert.rejects(invoke({...legacy,expiresAtMs:now+1000000,nonceSha256:'c'.repeat(64)}),/RUNTIME_WORKER_HOLD/);
  const grants=(await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) a left join pg_roles r on r.oid=a.grantee where p.proname='vdj_runtime_request' and (a.grantee=0 or r.rolname in ('anon','authenticated'))")).rows[0];
  assert.equal(grants.n,0);
});
test('companion driver connects existing production routes but restoring registration never starts generation or player',async()=>{
  const f=await deviceFixture(),store=createMacCompanionDeviceStore({enabled:true,invoke:f.invoke});await store.save(roomId);
  const calls=[],now=Date.now(),scope={roomId,sessionId:example_epoch,controlRevision:0,expiresAtMs:now+3600000};let activated=false;
  const runtime=createMacCompanionRuntime({roomId,projectURL:COMPANION_PROJECT_URL,deviceStore:store,
    policy:{approved:true,roomId,providerUseApproved:false,mediaUploadApproved:false},readOperationalApproval:async()=>{throw Error('fixture missing');},
    fetchImpl:async url=>Response.json(url.endsWith('/host/session')?{...scope,submissions:[],generationEnabled:false}:scope),
    createRuntime:configuration=>{assert.equal(configuration.companion,true);assert.equal(configuration.expiresAtMs,scope.expiresAtMs);
      return {attachOwner:async()=>{},readCloud:async()=>scope,
        prepareRegistration:async()=>{calls.push('register');await configuration.writeRegistration({workerId:configuration.identity.workerId,
          publicKeySha256:configuration.identity.publicKeySha256,...scope});},
        activateNative:async()=>{calls.push('activate');activated=true;},
        status:()=>({connected:true,runtimeActivated:activated,generationEnabled:false,submissions:0,expiresAtMs:scope.expiresAtMs}),
        handleProductionRequest:async request=>{calls.push(new URL(request.url).pathname);return Response.json({fixture:true});},close:async()=>{}};}});
  await runtime.attachOwner({ownerCapability:owner});
  const activationDeadline=Date.now()+5000;
  while(!activated&&Date.now()<activationDeadline)await new Promise(r=>setTimeout(r,5));
  assert(activated,'asynchronous device registration must finish before asserting activation');
  assert.deepEqual(calls,['register','activate']);
  for(const suffix of ['source/startup','cues/state','jobs/read'])
    assert.equal((await runtime.handleProductionRequest(new Request(`${COMPANION_ORIGIN}/api/rooms/${roomId}/${suffix}`))).status,200);
  assert(!calls.some(x=>/operator\/trial\/start|jobs\/start|player\/register/.test(x)));
  await runtime.close();store.close();
});
test('native configuration cannot import a legacy trial approval or unknown project/room permission',()=>{
  const value={version:'owner-companion-v1',approved:true,roomId,projectURL:COMPANION_PROJECT_URL,cloudOrigin:COMPANION_ORIGIN,
    deviceRegistrationApproved:true,providerUseApproved:false,mediaUploadApproved:false,helperPath:'/tmp/companion-helper',
    helperSha256:'a'.repeat(64),registrationFile:'/tmp/companion-registration.json',operationalApprovalFile:'/tmp/companion-operation.json'};
  assert.equal(parseCompanionConfiguration(value).roomId,roomId);
  assert.equal(parseCompanionConfiguration({...value,implementationRoomNoExpiryApproved:true}).implementationRoomNoExpiryApproved,true);
  assert.throws(()=>parseCompanionConfiguration({...value,implementationRoomNoExpiryApproved:'true'}));
  for(const patch of [{version:'ai-vdj-edge-trial-v1'},{projectURL:'https://example.supabase.co'},{deviceRegistrationApproved:false},
    {providerUseApproved:'true'},{approved:false},{helperSha256:'x'}])assert.throws(()=>parseCompanionConfiguration({...value,...patch}));
});

test('only an approved implementation room may outlive4h; native authentication remains bounded4h',async()=>{
 for(const approved of [false,true]){
  const f=await deviceFixture(),store=createMacCompanionDeviceStore({enabled:true,invoke:f.invoke});await store.save(roomId);
  const clock=Date.now(),scope={roomId,sessionId:example_epoch,controlRevision:0,expiresAtMs:253402300799000};let received=null;
  const runtime=createMacCompanionRuntime({roomId,projectURL:COMPANION_PROJECT_URL,deviceStore:store,now:()=>clock,
   policy:{approved:true,roomId,providerUseApproved:false,mediaUploadApproved:false,...(approved?{implementationRoomNoExpiryApproved:true}:{})},
   readOperationalApproval:async()=>{throw Error('not used');},fetchImpl:async url=>Response.json(url.endsWith('/host/session')?{...scope,submissions:[],generationEnabled:false}:scope),
   createRuntime:configuration=>{received=configuration.expiresAtMs;return {attachOwner:async()=>{},
    prepareRegistration:async()=>{throw Error('fixture stops before registration');},close:async()=>{}};}});
  await runtime.attachOwner({ownerCapability:owner});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(received,approved?clock+14400000:null);
  await runtime.close();store.close();
 }
});

test('registered source URL fits finite operation/real room rather than the transport lease; legacy and overbroad delivery hold',async()=>{
  const f=await deviceFixture(),store=createMacCompanionDeviceStore({enabled:true,invoke:f.invoke});await store.save(roomId);
  const identity=await store.identity(roomId),now=Date.now();let scope={roomId,['sessionId']:example_epoch,controlRevision:0,expiresAtMs:now+7200000},storageCalls=0;
  const deviceSigner=await createRuntimeRequestSigner({enabled:true,identity,scope,expiresAtMs:scope.expiresAtMs});
  const legacy=await createRuntimeRequestSigner({enabled:true,scope,expiresAtMs:now+600000});
  const broker=createEdgeRuntimeBroker({enabled:true,projectURL:COMPANION_PROJECT_URL,
    platformHeaders:new Headers({apikey:'example_platform_placeholder',authorization:'example_platform_placeholder'}),
    readApprovedWorker:async id=>id===legacy.registration().workerId?{...legacy.registration(),approved:true}:null,
    readApprovedDevice:async id=>id===identity.workerId?identity:null,
    fetchImpl:async(url,init)=>{
      const request=JSON.parse(init.body);
      if(url.endsWith('/rpc/vdj_runtime_request'))return Response.json(request.action==='scope'?scope:{authorized:true});
      assert(url.includes('/storage/v1/object/sign/ai-vdj-private/'));storageCalls++;
      const objectPath=new URL(url).pathname.split('/object/sign/')[1];
      const example_claims=Buffer.from(JSON.stringify({url:objectPath,exp:Math.floor(Date.now()/1000)+request.expiresIn})).toString('base64url');
      const example_token=['example_header',example_claims,'example_signature'].join('.');
      return Response.json({signedURL:'/object/sign/'+objectPath+'?token='+example_token});
    }});
  const sign=async(signer,expiresIn)=>{
    const path=`/api/rooms/${roomId}/runtime/storage/sign`,payload={path:'rooms/'+cueDigest(roomId)+'/assets/example_context.media',expiresIn},body=new TextEncoder().encode(JSON.stringify(payload));
    return broker.handleRequest(new Request(COMPANION_ORIGIN+path,{method:'POST',headers:{origin:COMPANION_ORIGIN,'content-type':'application/json','x-room-owner':owner,
      ...await signer.sign({path,body,ownerCapability:owner,contentType:'application/json'})},body}));
  };
  const response=await sign(deviceSigner,3600);assert.equal(response.status,200);assert((await response.json()).expiresAtMs>now+1800000);
  assert.equal((await sign(legacy,3600)).status,409);assert.equal((await sign(deviceSigner,3601)).status,409);
  scope={...scope,expiresAtMs:now+1800000};assert.equal((await sign(deviceSigner,3600)).status,409);assert.equal(storageCalls,1);
  broker.close();deviceSigner.close();legacy.close();store.close();
});

test('owner confirms the persisted resume budget on the same screen; no new trial claim or expanded budget is sent',async()=>{
 const calls=[],plan={phase:'REVIEW',resume:true,planId:'trial-example-plan',participants:2,maximumCents:100};
 const model=createOwnerSetupModel({roomId,request:async(path,options)=>{
  calls.push({path,options});if(path.endsWith('/status'))return {version:'owner-operator-v1',mode:'production',macRequired:true,
   available:{connection:true,media:true,trial:true},resumePlan:plan};
  assert(path.endsWith('/operator/resume'));assert.deepEqual(options.body,{planId:plan.planId,maximumCents:100,consent:true});
  return {phase:'STARTED',planId:plan.planId,resumed:true};}});
 await model.load();await assert.rejects(model.start(false));assert.equal(calls.length,1);
 await model.start(true);assert.equal(calls.length,2);assert.equal(model.snapshot().plan.phase,'STARTED');model.dispose();
});

// Concurrent owner status requests must never race source QC with operational
// configuration, or erase a held initialization result.
for(const scenario of ['delayed','failed','late'])test(`companion source preparation ${scenario} remains serialized and fail-closed`,async()=>{
 const f=await deviceFixture(),store=createMacCompanionDeviceStore({enabled:true,invoke:f.invoke});await store.save(roomId);
 const scope={roomId,sessionId:example_epoch,controlRevision:0,expiresAtMs:Date.now()+3600000};
 let source=scenario==='late'?null:{audioAssetId:'example-source'},active=false,ready=false,prepares=0,configures=0,release,entered;
 const started=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
 const runtime=createMacCompanionRuntime({roomId,projectURL:COMPANION_PROJECT_URL,deviceStore:store,
  policy:{approved:true,roomId,providerUseApproved:scenario==='delayed',mediaUploadApproved:true},readCurrent:()=>source,
  readOperationalApproval:async()=>{throw Error('fixture pending');},
  fetchImpl:async url=>Response.json(url.endsWith('/host/session')?{...scope,submissions:[],generationEnabled:false}:scope),
  createRuntime:configuration=>({attachOwner:async()=>{},readCloud:async()=>scope,prepareRegistration:async()=>configuration.writeRegistration({...scope,workerId:configuration.identity.workerId}),
   readProviderMetadata:async()=>({connectionId:'example-connection',observedAtMs:Date.now(),expiresAtMs:scope.expiresAtMs,
    prices:['intent','music','video'].map(key=>({endpointId:GENERATION_CONTRACT[key],unit:'synthetic-unit',unitPrice:.1,currency:'USD'})),
    balance:{observedAtMs:Date.now(),usd:2,source:'fal-account-billing-api'},balanceError:null,autoTopUpVerified:false,generationInvoked:false}),
   activateNative:async()=>{active=true;},
   prepareNativeBootstrap:async()=>{prepares++;entered();if(scenario==='delayed')await blocked;
    if(scenario==='failed')throw Error('fixture QC held');ready=true;},
   configureNativeTrial:async()=>{configures++;},
   status:()=>({connected:true,runtimeActivated:active,nativeBootstrapReady:ready}),close:async()=>{}})});
 try{
  await runtime.attachOwner({ownerCapability:owner});
  if(scenario!=='late')await started;
  else{for(let n=0;n<20&&!active;n++)await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));source={audioAssetId:'example-source'};}
  if(scenario==='delayed'){
   await Promise.all([runtime.readCloud(),runtime.readCloud()]);assert.equal(prepares,1);assert.equal(configures,0);
   assert.equal(runtime.status().nativeOrchestration.stage,'bootstrap');assert.equal(runtime.status().runtimeActivated,false);
   assert.equal((await runtime.handleProductionRequest(new Request('https://example.invalid/'))).status,503);release();
  }
  await new Promise(r=>setImmediate(r));await runtime.readCloud();
  // Preparation starts asynchronously after the source becomes available. A
  // fixed number of scheduler turns is runner-speed dependent (CI 38866659935);
  // wait boundedly for it, still requiring exactly one serialized preparation.
  for(let n=0;n<200&&prepares===0;n++)await new Promise(r=>setTimeout(r,5));
  if(scenario==='late')await new Promise(r=>setTimeout(r,20));
  assert.equal(prepares,1);assert.equal(configures,scenario==='delayed'?1:0,'configuration follows source preparation and explicit provider permission');
  assert.equal(runtime.status().nativeBootstrapReady,scenario!=='failed');
  if(scenario==='failed')assert.equal(runtime.status().nativeOrchestration.state,'hold');
 }finally{release();await runtime.close();store.close();}
});
