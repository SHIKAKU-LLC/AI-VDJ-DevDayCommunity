import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createEdgeRuntimeBroker} from '../cloud/room/runtime-broker.mjs';
import {createRuntimeRequestSigner} from '../cloud/room/runtime-request-proof.mjs';
import {createEdgeRuntimeTransport} from '../cloud/worker/edge-runtime-transport.mjs';
import {EXISTING_REPOSITORY_SELECTS,PLAYER_OBSERVER_SQL,OPERATOR_STATE_SQL,DURABLE_SCHEDULER_SQL} from '../cloud/jobs/repository-statements.mjs';
import {cueDigest} from '../snapshot/app/runtime/intent-compiler.mjs';
import {createOwnerCloudConnection} from '../integration/runtime/owner-cloud-connection.mjs';
import {createMacCloudEdgeSession} from '../integration/mac-host/cloud-edge-runtime.mjs';
import {createProductionNativeHost} from '../cloud/worker/production-host.mjs';
import {PRIVATE_BUCKET_TARGET} from '../cloud/worker/storage-contract.mjs';
import {createOperatorPlanStore} from '../cloud/jobs/operator-store.mjs';
import {APPROVED_KEYCHAIN_ITEM} from '../integration/mac-host/keychain-provider.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
const owner='a'.repeat(64),invite='b'.repeat(64),origin='https://ai-vdj.vercel.app',projectURL='https://example.supabase.co',platformValue='example_platform_placeholder';
test('default-off and pre-aborted Edge transports perform no owner, signer, network or platform access',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111',deny=()=>assert.fail('dormant dependency'),
  off=createEdgeRuntimeTransport({roomId,withOwnerAuthorization:deny,signer:new Proxy({},{get:deny}),fetchImpl:deny});
 await assert.rejects(off.repository.query(EXISTING_REPOSITORY_SELECTS.scope,[roomId]));off.close();
 const broker=createEdgeRuntimeBroker({readApprovedWorker:deny,platformHeaders:new Proxy({},{get:deny}),fetchImpl:deny});
 assert.equal((await broker.handleRequest(new Request(origin+'/api/rooms/'+roomId+'/runtime/query',{method:'POST'}))).status,503);broker.close();
 const scope={roomId,['sessionId']:'22222222-2222-4222-a222-222222222222',controlRevision:0,expiresAtMs:Date.now()+10000},
  signer=await createRuntimeRequestSigner({enabled:true,scope}),transport=createEdgeRuntimeTransport({enabled:true,roomId,signer,withOwnerAuthorization:deny,fetchImpl:deny});
 const abort=new AbortController();abort.abort();await assert.rejects(transport.storage.describeBucket({bucket:PRIVATE_BUCKET_TARGET,signal:abort.signal}));transport.close();signer.close();
});
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql',
  'cloud/jobs/player-observer-state.sql','cloud/jobs/durable-scheduler.sql','cloud/jobs/operator-state.sql','cloud/room/runtime-broker.sql'])
  await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
 const uid='11111111-1111-4111-a111-111111111111';await db.query('insert into vdj_internal.owners(uid)values($1)',[uid]);
 const room=(await db.query('select public.vdj_room_request($1,null,null,$2::jsonb,$3) value',
  ['create',JSON.stringify({ownerCapability:owner,joinCode:invite}),uid])).rows[0].value;
 const metadata=(await db.query('select id,epoch,control_revision,extract(epoch from expires_at)*1000 as expiry from vdj_internal.rooms where id=$1',[room.roomId])).rows[0];
 const scope={roomId:metadata.id,['sessionId']:metadata.epoch,controlRevision:Number(metadata.control_revision),expiresAtMs:Number(metadata.expiry)};
 const signer=await createRuntimeRequestSigner({enabled:true,scope}),registration={...signer.registration(),approved:true};
 let worker=registration;const platformCalls=[],nativeCalls=[],objects=new Map();
 const platformFetch=async(url,init)=>{
  const headers=new Headers(init.headers);assert.equal(headers.get('apikey'),platformValue);assert.equal(headers.get('authorization'),platformValue);
  assert.equal(init.redirect,'error');const path=new URL(url).pathname;platformCalls.push(path);
  if(path.startsWith('/rest/v1/rpc/')){const body=JSON.parse(init.body);let value;
   try{await db.exec('set role service_role;');
    if(path.endsWith('vdj_runtime_request'))value=(await db.query('select public.vdj_runtime_request($1,$2,$3,$4::jsonb,$5::jsonb) value',
     [body.action,body.requested_room,body.capability,JSON.stringify(body.payload),JSON.stringify(body.runtime)])).rows[0].value;
    else if(path.endsWith('vdj_generation_request'))value=(await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
     [body.op,body.room_id,body.capability,JSON.stringify(body.payload)])).rows[0].value;
    else value=(await db.query('select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) value',
     [body.op,body.room_id,body.capability,JSON.stringify(body.payload),null])).rows[0].value;
    return Response.json(value);
   }catch{return Response.json({message:'synthetic_sql_hold'},{status:409});}finally{await db.exec('reset role;');}
  }
  if(path==='/storage/v1/bucket/'+PRIVATE_BUCKET_TARGET)return Response.json({id:PRIVATE_BUCKET_TARGET,public:false,
   file_size_limit:32*1024*1024,allowed_mime_types:['audio/wav','video/mp4','image/png','image/jpeg','application/json']});
  const get='/storage/v1/object/authenticated/'+PRIVATE_BUCKET_TARGET+'/',put='/storage/v1/object/'+PRIVATE_BUCKET_TARGET+'/';
  if(path.startsWith(get)){const record=objects.get(path.slice(get.length));return record?new Response(record.bytes,{headers:{'content-type':record.contentType}}):Response.json({code:'NoSuchKey'},{status:404});}
  if(path.startsWith(put)){const key=path.slice(put.length);assert.equal(headers.get('x-upsert'),'false');
   if(objects.has(key))return Response.json({code:'KeyAlreadyExists'},{status:409});objects.set(key,{bytes:Uint8Array.from(init.body),contentType:headers.get('content-type')});
   return Response.json({Key:PRIVATE_BUCKET_TARGET+'/'+key});}
  assert.fail('no unapproved synthetic endpoint');
 };
 const broker=createEdgeRuntimeBroker({enabled:true,projectURL,platformHeaders:new Headers([['apikey',platformValue],['authorization',platformValue]]),
  readApprovedWorker:async id=>worker?.workerId===id?worker:null,fetchImpl:platformFetch});t.after(()=>{signer.close();broker.close();});
 const nativeFetch=async(url,init)=>{const headers=new Headers(init.headers);
  if(new URL(url).hostname==='api.fal.ai'){
   assert.equal(headers.get('authorization'),'Key example_fixture_credential');assert.equal(init.method,'GET');
   return Response.json({prices:['intent','music','video'].map(k=>({endpoint_id:GENERATION_CONTRACT[k],unit:'synthetic-unit',unit_price:.1,currency:'USD'})),has_more:false,next_cursor:null});
  }
  assert(![...headers.values()].includes(platformValue));
  assert(!headers.has('authorization'));assert(!headers.has('apikey'));nativeCalls.push({url,init});
  if(new URL(url).pathname.endsWith('/host/session'))return Response.json({...scope,submissions:[],generationEnabled:false});
  const response=await broker.handleRequest(new Request(url,init));assert(response);return response;};
 const ownerPort=(s,fn)=>fn({...s,ownerCapability:owner});
 const transport=createEdgeRuntimeTransport({enabled:true,roomId:scope.roomId,withOwnerAuthorization:ownerPort,signer,fetchImpl:nativeFetch});t.after(()=>transport.close());
 const request=async(route,data={},extra={})=>{const path='/api/rooms/'+scope.roomId+'/runtime/'+route,body=new TextEncoder().encode(JSON.stringify(data));
  const signed=await signer.sign({path,body,ownerCapability:owner,contentType:'application/json'});
  return new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json','x-room-owner':owner,...signed,...extra},body});};
 return {db,scope,signer,registration,broker,transport,platformCalls,nativeCalls,objects,nativeFetch,ownerPort,request,
  setWorker:w=>{worker=w;}};
}
test('Edge executes fixed scope/helper calls through actual SQL as service_role; native has no DB/platform credentials',async t=>{
 const f=await fixture(t),s=f.scope;
 assert.equal((await f.transport.repository.query(EXISTING_REPOSITORY_SELECTS.scope,[s.roomId])).rows[0].ownerEnabled,true);
 const args=['read',s.roomId,owner,s.sessionId,s.controlRevision,null,null];
 assert.equal((await f.transport.repository.privateStateQuery(PLAYER_OBSERVER_SQL,args)).rows[0].value.version,0);
 const receiptArgs=['sourceReceiptRead',s.roomId,owner,s.sessionId,s.controlRevision,null,JSON.stringify({targetPlayerId:'synthetic-target',graphEpoch:1})];
 assert.deepEqual((await f.transport.repository.privateStateQuery(PLAYER_OBSERVER_SQL,receiptArgs)).rows[0].value,{version:0,record:null});
 await assert.rejects(f.transport.repository.privateStateQuery(OPERATOR_STATE_SQL,receiptArgs),e=>e.message==='RUNTIME_REQUEST_HOLD'&&e.cause?.message==='RUNTIME_QUERY_REQUIRED',
  'receipt operations belong only to the fixed observer contract');
 await assert.rejects(f.transport.repository.privateStateQuery(PLAYER_OBSERVER_SQL,[...receiptArgs.slice(0,5),0,receiptArgs[6]]),e=>e.message==='RUNTIME_REQUEST_HOLD'&&e.cause?.message==='RUNTIME_QUERY_REQUIRED');
 const record={roomId:s.roomId,['sessionId']:s.sessionId,controlRevision:s.controlRevision,synthetic:true};
 assert.equal((await f.transport.repository.privateStateQuery(PLAYER_OBSERVER_SQL,['cas',s.roomId,owner,s.sessionId,0,0,JSON.stringify(record)])).rows[0].value.version,1);
 assert.deepEqual((await f.transport.repository.privateStateQuery(OPERATOR_STATE_SQL,args)).rows[0].value,{version:0,record:null});
 assert.equal((await f.transport.repository.privateStateQuery(DURABLE_SCHEDULER_SQL,['claim',s.roomId,owner,JSON.stringify({['sessionId']:s.sessionId,controlRevision:0,workerId:'worker-'.padEnd(30,'w'),leaseMs:30000})])).rows[0].value,null);
 const state=await f.transport.repository.request('cueState',s.roomId,owner,{});assert.equal(state.roomId,s.roomId);
 const room=await f.transport.repository.readRoom(s.roomId,owner);assert.equal(room.roomId,s.roomId);
 const host=createProductionNativeHost({enabled:true,roomId:s.roomId,projectURL,edgeTransport:f.transport,
  withOwnerAuthorization:f.ownerPort,bootstrapConfiguration:{},credentialForOperation:()=>assert.fail('no provider key'),fetchImpl:f.nativeFetch});
 const inspected=await host.io.inspectConfiguration();assert.equal(inspected.repositoryRead,true);assert.equal(inspected.privateBucketCompatible,true);await host.close();
 assert(f.nativeCalls.every(c=>!JSON.stringify(c.init.body).includes('vdj_internal.')));
});
test('actual signed Edge transport preserves a large transient observation fence within unchanged request and record bounds',async t=>{
 const f=await fixture(t),s=f.scope,runtime={currentCredit:null,stopped:false,acks:[{syntheticReceipt:'x'.repeat(70000)}],servedCounts:{}};
 await f.db.query('insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document) values($1,$2,$3,$4,to_timestamp($5::double precision/1000),$6::jsonb)',
  ['synthetic-large-fence-permit',s.roomId,s.sessionId,0,s.expiresAtMs,'{}']);
 await f.db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
  ['synthetic-large-fence-operation','synthetic-large-fence-permit',s.roomId,JSON.stringify({roomRuntime:runtime})]);
 const call=(action,version,record)=>f.transport.repository.privateStateQuery(PLAYER_OBSERVER_SQL,[action,s.roomId,owner,s.sessionId,0,version,record===null?null:JSON.stringify(record)]);
 const snap=(await call('read',null,null)).rows[0].value;
 const record={roomId:s.roomId,['sessionId']:s.sessionId,controlRevision:0,synthetic:true},fence={scopeExpiresAtMs:snap.scope.expiresAtMs,playback:snap.playback,runtime:snap.runtime};
 const result=(await call('cas',0,{...record,__observationFence:fence})).rows[0].value;
 assert.equal(result.version,1);assert.deepEqual(result.record,record);
 assert.equal((await call('read',null,null)).rows[0].value.runtime.acks[0].syntheticReceipt.length,70000);
 await assert.rejects(call('cas',1,{...record,__observationFence:{...fence,runtime:{...runtime,stopped:true}}}));
 const requests=f.nativeCalls.length;
 await assert.rejects(call('cas',1,{...record,padding:'x'.repeat(65536),__observationFence:fence}));
 await assert.rejects(call('cas',1,{...record,__observationFence:{...fence,padding:'x'.repeat(131072)}}));
 assert.equal(f.nativeCalls.length,requests,'oversized records/whole requests fail before network');
 await assert.rejects(f.transport.repository.privateStateQuery(OPERATOR_STATE_SQL,['cas',s.roomId,owner,s.sessionId,0,0,JSON.stringify({...record,__observationFence:fence})]));
});
test('owner proof alone, wrong public key, modified body and signed request replay cannot reach helper writes',async t=>{
 const f=await fixture(t),data={statementId:'observer',args:['cas',f.scope.sessionId,0,0,{...f.scope}]};
 const unsigned=new Request(origin+'/api/rooms/'+f.scope.roomId+'/runtime/query',{method:'POST',headers:{origin,'content-type':'application/json','x-room-owner':owner},body:JSON.stringify(data)});
 assert.equal((await f.broker.handleRequest(unsigned)).status,409);assert.equal(f.platformCalls.length,0);
 const req=await f.request('query',{statementId:'scope',args:[]}),saved=req.clone();
 assert.equal((await f.broker.handleRequest(req)).status,200);assert.equal((await f.broker.handleRequest(saved)).status,409);
 const changed=await f.request('query',{statementId:'scope',args:[]});
 assert.equal((await f.broker.handleRequest(new Request(changed.url,{method:'POST',headers:changed.headers,body:JSON.stringify(data)}))).status,409);
 const calls=f.platformCalls.length;f.setWorker({...f.registration,publicKeySha256:'f'.repeat(64)});
 assert.equal((await f.broker.handleRequest(await f.request('query',data))).status,409);assert.equal(f.platformCalls.length,calls);
 const version=(await f.db.query("select operations->'__player_observer_v1' from vdj_internal.rooms where id=$1",[f.scope.roomId])).rows[0];assert.equal(version['?column?']??null,null);
});
test('Edge operator CAS and finite permit insertion preserve claimed-plan binding and reject changed counts before insertion',async t=>{
 const f=await fixture(t),s=f.scope;
 const submissions=['a','b'].map(v=>({submissionId:'synthetic-submission-'+v,participantId:'synthetic-person-'+v}));
 await f.db.query('update vdj_internal.rooms set submissions=$2::jsonb where id=$1',[s.roomId,JSON.stringify(submissions)]);
 const connectionId='synthetic-connection',source={synthetic:'no-provider-generation'},sourceSha256='f'.repeat(64),expiry=Date.now()+60000;
 const operations=submissions.map((v,i)=>({operationId:('synthetic-operation-'+i).padEnd(30,'o'),permitId:('synthetic-permit-'+i).padEnd(30,'p'),...v,
  permit:{permitId:('synthetic-permit-'+i).padEnd(30,'p'),connectionId,source,sourceSha256,expiresAtMs:expiry,maximumUsd:.5,counts:{intent:1,music:1,video:1}}}));
 const plan={...s,planId:'synthetic-plan-'.padEnd(30,'p'),phase:'REVIEW',participants:2,maximumCents:100,priorPlanId:null,
  connectionId,sourceSha256,operations};
 const store=createOperatorPlanStore({query:f.transport.repository.privateStateQuery,withOwnerAuthorization:f.ownerPort});
 await store.save(plan);assert.equal((await store.active(s)).planId,plan.planId);assert.equal(await store.claim({...s,planId:plan.planId}),true);
 const bad=structuredClone(plan);bad.operations[0].permit.counts.video=2;
 await assert.rejects(store.insertPermits({...s,plan:bad}));assert.equal((await f.db.query('select count(*)::integer as n from vdj_internal.generation_permits')).rows[0].n,0);
 assert.equal((await store.insertPermits({...s,plan})).inserted,2);
 const metadata=await f.transport.repository.query(EXISTING_REPOSITORY_SELECTS.permit,[operations[0].permitId,s.roomId]);assert.equal(metadata.rows[0].permitId,operations[0].permitId);
 await assert.rejects(f.transport.repository.query('select arbitrary_call($1)',[s.roomId]));
});
test('native Storage proxy preserves immutable private room path/bytes and platform context stays in Edge',async t=>{
 const f=await fixture(t),signal=new AbortController().signal,path='rooms/'+cueDigest(f.scope.roomId)+'/assets/synthetic-media.media',bytes=Uint8Array.of(1,2,3);
 const input={bucket:PRIVATE_BUCKET_TARGET,path,bytes,contentType:'image/png',upsert:false,signal};
 assert.equal((await f.transport.storage.putObjectIfAbsent(input)).created,true);assert.equal((await f.transport.storage.putObjectIfAbsent(input)).duplicate,true);
 const read=await f.transport.storage.readObject({bucket:PRIVATE_BUCKET_TARGET,path,maximumBytes:3,signal});
 assert.deepEqual(new Uint8Array(await new Response(read.body).arrayBuffer()),bytes);
 assert.equal(await f.transport.storage.readObject({bucket:PRIVATE_BUCKET_TARGET,path:path.replace('synthetic-media','absent'),maximumBytes:3,signal}),null);
 await assert.rejects(f.transport.storage.putObjectIfAbsent({...input,path:'rooms/other/assets/synthetic-media.media'}));
 const recorded=f.nativeCalls.find(c=>c.url.endsWith('storage/put')),headers=new Headers(recorded.init.headers);headers.set('x-vdj-object-path',path.replace('synthetic-media','changed'));
 const count=f.objects.size;assert.equal((await f.broker.handleRequest(new Request(recorded.url,{...recorded.init,headers}))).status,409);assert.equal(f.objects.size,count);
});
test('SQL wrapper is invoker/empty-search-path/service-role only; TTL/scope/nonce failures preserve records',async t=>{
 const f=await fixture(t);
 const p=(await f.db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') as anon,has_function_privilege('authenticated',oid,'EXECUTE') as authenticated from pg_proc where proname='vdj_runtime_request'")).rows[0];
 assert.equal(p.prosecdef,false);assert.deepEqual(p.proconfig,['search_path=""']);assert.equal(p.anon,false);assert.equal(p.authenticated,false);
 const runtime={workerId:f.registration.workerId,roomId:f.scope.roomId,['sessionId']:f.scope.sessionId,controlRevision:0,expiresAtMs:f.registration.expiresAtMs,requestedAtMs:Date.now(),nonceSha256:'d'.repeat(64)};
 for(const patch of [{expiresAtMs:null},{expiresAtMs:Date.now()+1900000},{expiresAtMs:Date.now()-1},{controlRevision:1},{nonceSha256:'bad'}]){
  await assert.rejects(f.db.query('select public.vdj_runtime_request($1,$2,$3,$4::jsonb,$5::jsonb)',
   ['query',f.scope.roomId,owner,JSON.stringify({statementId:'scope',args:[]}),JSON.stringify({...runtime,...patch})]));
 }
 assert.equal((await f.db.query('select count(*)::integer as n from vdj_internal.generation_permits')).rows[0].n,0);
});
test('short Mac session prepares public registration first; unapproved worker activation and DB credential injection are rejected',async t=>{
 const f=await fixture(t),session=createMacCloudEdgeSession({enabled:true,roomId:f.scope.roomId,projectURL,fetchImpl:f.nativeFetch});t.after(()=>session.close());
 await session.attachOwner({ownerCapability:owner});const registration=await session.prepareRegistration();assert(registration.publicJwk);assert(!Object.hasOwn(registration.publicJwk,'d'));
 await assert.rejects(session.activateNative({approved:true,configuration:{bootstrapConfiguration:{},readConnection:()=>assert.fail('DB forbidden')}}));
 await assert.rejects(session.activateNative({approved:true,configuration:{bootstrapConfiguration:{},credentialForOperation:()=>assert.fail('no provider')}}));
 f.setWorker({...registration,approved:true});
 const host=await session.activateNative({approved:true,configuration:{bootstrapConfiguration:{},
  operatorConfiguration:{enabled:true},credentialForOperation:()=>assert.fail('no provider')}});
 assert.equal(host.capabilities().enabled,true);assert.equal(host.capabilities().actualApiVerified,false);
});
test('complete Edge/Mac assembly activates explicit synthetic Keychain custody with no manual entry or credential transfer to Edge',async t=>{
 const f=await fixture(t),session=createMacCloudEdgeSession({enabled:true,roomId:f.scope.roomId,projectURL,fetchImpl:f.nativeFetch});t.after(()=>session.close());
 await session.attachOwner({ownerCapability:owner});const registration=await session.prepareRegistration();f.setWorker({...registration,approved:true});
 let reads=0,buffer;
 const approval={...registration,...APPROVED_KEYCHAIN_ITEM,approved:true,process:'ai-vdj-native-node',recipient:'fal-fixed-generation-and-platform'};
 const host=await session.activateNative({approved:true,configuration:{},keychainApproval:approval,
  keychainReadItem:async()=>{reads++;return buffer=Buffer.from('example_fixture_credential');}});
 assert.equal(reads,0,'construction and worker registration never read even a fixture key');
 const response=await host.operator.handleRequest(new Request(origin+'/api/rooms/'+f.scope.roomId+'/operator/status',
  {headers:{origin,'x-room-owner':owner}}));assert.equal(response.status,200);const state=await response.json();
 assert.equal(state.connection.verified,true);assert.equal(reads,1);assert(buffer.every(v=>v===0));
 assert(state.connection.expiresAtMs<=registration.expiresAtMs-30000);assert(!JSON.stringify(state).includes('example_fixture_credential'));
 assert(f.nativeCalls.every(call=>!JSON.stringify(call.init.body).includes('example_fixture_credential')));
});
test('native approved operator reconfiguration preserves custody and rejects changed connection or active plan',async t=>{
 const f=await fixture(t),session=createMacCloudEdgeSession({enabled:true,roomId:f.scope.roomId,projectURL,fetchImpl:f.nativeFetch});t.after(()=>session.close());
 await session.attachOwner({ownerCapability:owner});const registration=await session.prepareRegistration();f.setWorker({...registration,approved:true});
 let reads=0;
 const approval={...registration,...APPROVED_KEYCHAIN_ITEM,approved:true,process:'ai-vdj-native-node',recipient:'fal-fixed-generation-and-platform'};
 const host=await session.activateNative({approved:true,configuration:{},keychainApproval:approval,
  keychainReadItem:async()=>{reads++;return Buffer.from('example_fixture_credential');}});
 const statusRequest=()=>new Request(origin+'/api/rooms/'+f.scope.roomId+'/operator/status',
  {headers:{origin,'x-room-owner':owner}});
 const initial=await (await host.operator.handleRequest(statusRequest())).json(),previous=host.operator;
 assert.equal(reads,1);
 const configured={enabled:true,adapters:{enabled:true,balanceMode:'api',approvedVideoAssetIds:['saved-video-1'],
  readSafetyApproval:async()=>({approved:true})},trial:{mediaHost:new URL(projectURL).hostname,
  infrastructure:{verified:true,maximumUsd:0}},approvals:{connection:true,media:true,trial:true}};
 await assert.rejects(host.configureApprovedOperator({connectionId:'different-connection',operatorConfiguration:configured}));
 assert.equal(host.operator,previous);
 const capabilities=await host.configureApprovedOperator({connectionId:initial.connection.connectionId,operatorConfiguration:configured});
 assert.notEqual(host.operator,previous);assert.deepEqual(capabilities.available,{connection:true,media:true,trial:true});
 assert.equal(reads,1,'configuration only reads verified metadata, not the Keychain item');
 const current=await (await host.operator.handleRequest(statusRequest())).json();
 assert.equal(current.connection.connectionId,initial.connection.connectionId);
 assert(!JSON.stringify(capabilities).includes('example_fixture_credential'));
 const store=createOperatorPlanStore({query:host.io.repository.privateStateQuery,withOwnerAuthorization:f.ownerPort});
 const operations=['a','b'].map(v=>({participantId:'person-'+v}));
 await store.save({...f.scope,planId:'synthetic-review-plan',participants:2,maximumCents:100,priorPlanId:null,operations});
 await assert.rejects(host.configureApprovedOperator({connectionId:initial.connection.connectionId,operatorConfiguration:configured}));
 assert.equal(host.operator.capabilities().available.trial,true);
});
test('owner callback is opt-in, scoped, expires and does not expose proof in status or snapshot',async()=>{
 let clock=1000,calls=0;const roomId='11111111-1111-4111-a111-111111111111',epoch='22222222-2222-4222-a222-222222222222';
 const fetchImpl=async()=>{calls++;return Response.json({roomId,['sessionId']:epoch,controlRevision:0,generationEnabled:false,submissions:[]});};
 const legacy=createOwnerCloudConnection({roomId,fetchImpl});await legacy.attachOwner({ownerCapability:owner});await assert.rejects(legacy.withOwnerAuthorization({roomId},()=>true));legacy.close();
 const connection=createOwnerCloudConnection({roomId,fetchImpl,allowRuntimeOwnerContext:true,contextExpiresAtMs:2000,now:()=>clock});
 await connection.attachOwner({ownerCapability:owner});assert.equal(await connection.withOwnerAuthorization({roomId,['sessionId']:epoch,controlRevision:0},c=>c.ownerCapability===owner),true);
 assert(!JSON.stringify(connection.status()).includes(owner));assert(!JSON.stringify(await connection.readCloud()).includes(owner));
 await assert.rejects(connection.withOwnerAuthorization({roomId,['sessionId']:epoch,controlRevision:1},()=>true));clock=2000;
 const before=calls;await assert.rejects(connection.withOwnerAuthorization({roomId},()=>true));assert.equal(calls,before);connection.close();
});

// A later rolling lease must not reach SQL before an earlier signed request.
test('native requests serialize before signing and do not retry failed requests',async()=>{
 const example_epoch='22222222-2222-4222-a222-222222222222';
 const scope={roomId:'11111111-1111-4111-a111-111111111111',sessionId:example_epoch,controlRevision:0,expiresAtMs:Date.now()+10000};
 const signer=await createRuntimeRequestSigner({enabled:true,scope});let first,entered,reads=0;const started=new Promise(r=>entered=r);
 const blocked=new Promise(r=>first=r);
 const transport=createEdgeRuntimeTransport({enabled:true,roomId:scope.roomId,signer,withOwnerAuthorization:(s,fn)=>fn({...s,ownerCapability:owner}),fetchImpl:async()=>{
  reads++;if(reads===1){entered();await blocked;return Response.json({},{status:409});}return Response.json({rows:[]});}});
 const a=transport.repository.query(EXISTING_REPOSITORY_SELECTS.scope,[scope.roomId]);const rejected=assert.rejects(a);
 await started;const b=transport.repository.query(EXISTING_REPOSITORY_SELECTS.scope,[scope.roomId]);await new Promise(r=>setImmediate(r));assert.equal(reads,1);
 first();await rejected;await b;assert.equal(reads,2);transport.close();signer.close();
});
