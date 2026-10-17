import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionNativeHost} from '../cloud/worker/production-host.mjs';
import {createProductionRenderRecordStore} from '../cloud/worker/render-record-store.mjs';
import {EXISTING_REPOSITORY_SELECTS} from '../cloud/jobs/repository-read-ports.mjs';
import {PLAYER_OBSERVER_SQL} from '../cloud/jobs/player-observer-store.mjs';
import {DURABLE_SCHEDULER_SQL} from '../cloud/jobs/durable-scheduler.mjs';
import {OPERATOR_STATE_SQL} from '../cloud/jobs/operator-store.mjs';
import {PRIVATE_BUCKET_TARGET} from '../cloud/worker/supabase-private-store.mjs';
import {syntheticWave,fixtureSha} from './cloud-worker-fixture.mjs';
import {decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
const roomId='11111111-1111-4111-a111-111111111111',exampleEpoch='22222222-2222-4222-a222-222222222222';
const scope={roomId,['sessionId']:exampleEpoch,controlRevision:0},owner='a'.repeat(64),projectURL='https://example.supabase.co',origin='https://ai-vdj.vercel.app';
const bucket={id:PRIVATE_BUCKET_TARGET,public:false,file_size_limit:32*1024*1024,
 allowed_mime_types:['audio/wav','video/mp4','image/png','image/jpeg','application/json']};
const reference=Uint8Array.of(137,80,78,71,13,10,26,10),audio=syntheticWave(24);
function fixture(extra={}){
 const calls=[],sql=[],objects=new Map(),counts={pool:0,native:0,sdk:0,credentials:0,owner:0,platform:0,end:0},releases=[];
 const state={roomId,cues:[],pending:false,stopped:false,currentCredit:null};
 const room={...scope,eventSeq:0,closed:false,accepting:true,generationPaused:true,autoDJ:false,mode:'collect',cues:[],currentCredit:null,
 playbackAdapterAvailable:false,submissions:[]};
 const createPool=policy=>{counts.pool++;return {options:policy,on(){},end:async()=>{counts.end++;},connect:async()=>({
  release:destroy=>releases.push(destroy),query:async({text,values})=>{sql.push({text,values});
   if(text===EXISTING_REPOSITORY_SELECTS.scope)return {rows:[{...scope,expiresAtMs:60000,ownerEnabled:true}]};
   if(text===PLAYER_OBSERVER_SQL)return {rows:[{value:{version:0,record:null}}]};
   if(text===OPERATOR_STATE_SQL)return {rows:[{value:{version:0,record:extra.readOperatorRecord?.()??null}}]};
   if(text===DURABLE_SCHEDULER_SQL)return {rows:[{value:null}]};return extra.queryFixtureResponse?.(text,values)??{rows:[]};}})};};
 const fetchImpl=async(url,init={})=>{const path=new URL(url).pathname;
  if(new URL(url).origin==='https://api.fal.ai'&&extra.platformFixtureResponse)return extra.platformFixtureResponse(url,init);
  if(new URL(url).origin==='https://queue.fal.run'&&extra.providerFixtureResponse)return extra.providerFixtureResponse(url,init);
  calls.push({path,method:init.method,headers:new Headers(init.headers),body:typeof init.body==='string'?JSON.parse(init.body):init.body});
  assert.equal(init.redirect,'error');
  if(path==='/rest/v1/rpc/vdj_generation_request'){const body=JSON.parse(init.body);
   if(body.op!=='cueState'&&extra.generationFixtureResponse)return extra.generationFixtureResponse(body);
   assert.equal(body.op,'cueState');return Response.json(state);}
  if(path==='/rest/v1/rpc/vdj_room_request'){assert(['read','submission'].includes(JSON.parse(init.body).op));return Response.json(room);}
  if(path==='/storage/v1/bucket/'+PRIVATE_BUCKET_TARGET)return Response.json(bucket);
  const get='/storage/v1/object/authenticated/'+PRIVATE_BUCKET_TARGET+'/',put='/storage/v1/object/'+PRIVATE_BUCKET_TARGET+'/';
  if(init.method==='GET'&&path.startsWith(get)){const value=objects.get(path.slice(get.length));
   return value?new Response(Uint8Array.from(value.bytes),{headers:{'content-type':value.mime,'content-length':String(value.bytes.length)}}):
    Response.json({code:'NoSuchKey'},{status:404});}
  if(init.method==='POST'&&path.startsWith(put)){assert.equal(new Headers(init.headers).get('x-upsert'),'false');const key=path.slice(put.length);
   if(objects.has(key))return Response.json({code:'KeyAlreadyExists'},{status:409});
   objects.set(key,{bytes:Buffer.from(init.body),mime:new Headers(init.headers).get('content-type')});return Response.json({Key:PRIVATE_BUCKET_TARGET+'/'+key});}
  assert.fail('unapproved synthetic host route');};
 const options={enabled:true,roomId,projectURL,origin,now:()=>1000,createPool,fetchImpl,
  withPlatformHeaders:(_,fn)=>{counts.platform++;return fn(new Headers({authorization:'example_opaque_placeholder',apikey:'example_opaque_placeholder'}));},
  withOwnerAuthorization:(s,fn)=>{counts.owner++;return fn({...s,ownerCapability:owner});},
  credentialForOperation:()=>{counts.credentials++;assert.fail('metadata cannot load provider credentials');},
  loadSDK:()=>{counts.sdk++;assert.fail('metadata cannot load SDK');},
  loadNative:async()=>{counts.native++;return {close:async()=>{},native:{inspectAudio:async()=>assert.fail('no generation'),inspectVideo:async()=>assert.fail('no generation')},
   inspectReference:async bytes=>({sha256:fixtureSha(bytes),fullyDecoded:true,width:1,height:1}),
   inspectBootstrap:async bytes=>{const decoded=decodeCompleteWave(bytes);return {method:'pcm-endpoint-profile-v1',assetSha256:decoded.sha256,
    frameCount:decoded.frames,sampleRate:44100,channels:2,loudness:{truePeakDbtp:-10},nonfiniteSamples:0,clippedFraction:0,
    activity:{effectiveSilence:false,maxQuietRunSeconds:0}};}};},
  bootstrapConfiguration:{audioAssetId:'approved-audio',audioSha256:fixtureSha(audio),referenceAssetId:'approved-reference',referenceSha256:fixtureSha(reference)},...extra};
 const host=createProductionNativeHost(options);
 const request=(path,init={})=>new Request(origin+path,{headers:{origin,'x-room-owner':owner,...init.headers},...init});
 const startup=(body='{}',headers={})=>request(`/api/rooms/${roomId}/source/startup`,{method:'POST',headers:{origin,'x-room-owner':owner,'content-type':'application/json',...headers},body});
 return {host,calls,sql,counts,objects,releases,state,room,request,startup,configuration:options.bootstrapConfiguration};
}

test('operator uses the verified production scope projection for connection and explicit upload without provider credentials',async()=>{
 let connections=0;const x=fixture({bootstrapConfiguration:{},operatorConfiguration:{enabled:true,approvals:{connection:true,media:true},
  verifySavedVideo:async()=>null,connections:{connect:async input=>{connections++;return {...scope,connectionId:'synthetic-connection',verified:true,expiresAtMs:50000};},read:async()=>null}}});
 const post=(action,body)=>x.host.handleRequest(x.request(`/api/rooms/${roomId}/operator/`+action,{method:'POST',headers:{origin,'x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify(body)}));
 try{
  const response=await post('connection',{credential:'example_fixture_connection'});assert.equal(response.status,200);assert.equal((await response.json()).verified,true);assert.equal(connections,1);
  const upload=await post('media/begin',{role:'seed',mimeType:'audio/wav',byteLength:audio.length,sha256:fixtureSha(audio),referenceSha256:null,consent:true});
  assert.equal(upload.status,200);assert.equal((await upload.json()).chunkBytes,32768);
  assert.equal(x.counts.credentials,0);assert.equal(x.counts.sdk,0);assert.equal(x.counts.native,0);
 }finally{await x.host.close();}
});

async function uploadOwnerAsset(x,role,bytes,mimeType){
 const post=(action,body)=>x.host.handleRequest(x.request(`/api/rooms/${roomId}/operator/media/`+action,{method:'POST',
  headers:{origin,'x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify(body)}));
 const started=await post('begin',{role,mimeType,byteLength:bytes.length,sha256:fixtureSha(bytes),referenceSha256:null,consent:true});
 assert.equal(started.status,200);const {uploadId}=await started.json();
 for(let offset=0;offset<bytes.length;offset+=32768){const response=await post('chunk',{uploadId,offset,data:Buffer.from(bytes.subarray(offset,offset+32768)).toString('base64')});assert.equal(response.status,200);}
 return post('finish',{uploadId});
}
const sourceOperator={enabled:true,approvals:{media:true},verifySavedVideo:async()=>null};
test('empty current room accepts scoped upload pair before startup with no generation ledger or credentials',async()=>{
 const x=fixture({bootstrapConfiguration:{},operatorConfiguration:sourceOperator});try{
  assert.equal(x.objects.size,0);assert.equal((await x.host.handleRequest(x.startup())).status,409);
  const seed=await uploadOwnerAsset(x,'seed',audio,'audio/wav');assert.equal(seed.status,200);
  assert.equal((await x.host.handleRequest(x.startup())).status,409,'one asset cannot form source authority');
  const ref=await uploadOwnerAsset(x,'reference',reference,'image/png');assert.equal(ref.status,200,JSON.stringify(await ref.clone().json()));
  const result=await x.host.handleRequest(x.startup());assert.equal(result.status,200,JSON.stringify(await result.clone().json()));
  const body=await result.json();assert.equal(body.descriptor.sha256,fixtureSha(audio));assert.equal(body.source.actual,false);
  assert.equal(body.source.frameCount,24*44100);assert.equal(x.counts.sdk,0);assert.equal(x.counts.credentials,0);
  const selected=await (await x.host.handleRequest(x.request(`/api/rooms/${roomId}/operator/status`))).json();
  assert.equal(selected.assets.length,2);assert.deepEqual(new Set(selected.assets.map(a=>a.role)),new Set(['seed','reference']));
  const restored=createProductionNativeHost({enabled:true,roomId,projectURL,origin,now:()=>1000,
   createPool:policy=>({options:policy,on(){},end:async()=>{},connect:async()=>({release(){},query:async({text})=>
    text===EXISTING_REPOSITORY_SELECTS.scope?{rows:[{...scope,expiresAtMs:60000,ownerEnabled:true}]}:{rows:[]}})}),
   withOwnerAuthorization:(s,fn)=>fn({...s,ownerCapability:owner}),withPlatformHeaders:(_,fn)=>fn(new Headers({authorization:'example_fixture_value',apikey:'example_fixture_value'})),
   credentialForOperation:()=>assert.fail('no credentials'),bootstrapConfiguration:{},operatorConfiguration:sourceOperator,
   fetchImpl:async(url,init)=>{const path=new URL(url).pathname;
    if(path==='/rest/v1/rpc/vdj_generation_request')return Response.json(x.state);
    if(path==='/storage/v1/bucket/'+PRIVATE_BUCKET_TARGET)return Response.json(bucket);
    const prefix='/storage/v1/object/authenticated/'+PRIVATE_BUCKET_TARGET+'/';
    if(init.method==='GET'&&path.startsWith(prefix)){const value=x.objects.get(path.slice(prefix.length));
     return value?new Response(value.bytes,{headers:{'content-type':value.mime,'content-length':String(value.bytes.length)}}):Response.json({code:'NoSuchKey'},{status:404});}
    assert.fail('recovery must read existing immutable bytes only');},
   loadNative:()=>assert.fail('recovery must preserve native authority')});
  try{const recovered=await restored.handleRequest(x.startup());assert.equal(recovered.status,200,JSON.stringify(await recovered.clone().json()));
   assert.equal((await recovered.json()).descriptor.sha256,body.descriptor.sha256);}finally{await restored.close();}
 }finally{await x.host.close();}
});

test('existing native bootstrap is exposed as scoped selections and rejects different upload hashes before provider work',async()=>{
 const x=fixture({operatorConfiguration:sourceOperator});try{
  for(const [id,bytes,type] of [['approved-audio',audio,'audio/wav'],['approved-reference',reference,'image/png']])
   await x.host.io.privateStore.assetStore.save({id,bytes,contentType:type,binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'owner-supplied-bootstrap',actualGenerationThisRun:false}});
  assert.equal((await x.host.handleRequest(x.startup())).status,200);
  const selected=await (await x.host.handleRequest(x.request(`/api/rooms/${roomId}/operator/status`))).json();
  assert.deepEqual(new Set(selected.assets.map(a=>a.assetId)),new Set(['approved-audio','approved-reference']));
  const altered=Uint8Array.from(reference);altered[7]=11;
  assert.equal((await uploadOwnerAsset(x,'reference',altered,'image/png')).status,409);
  assert.equal((await x.host.handleRequest(x.startup())).status,200);
  assert.equal(x.configuration.referenceSha256,fixtureSha(reference));assert.equal(x.configuration.referenceAssetId,'approved-reference');
  assert.equal(x.counts.credentials,0);assert.equal(x.counts.sdk,0);
 }finally{await x.host.close();}
});

for(const fivePerson of [false,true])test(`provider configuration accepts explicit false owner-video approval with five-person mode ${fivePerson}`,async()=>{
 const connectionId='synthetic-existing-connection',custodian={accept:async()=>assert.fail('no new credential'),
  read:async()=>({...scope,connectionId,verified:true,expiresAtMs:50000}),withCredential:async()=>assert.fail('no provider access')};
 const x=fixture({operatorConfiguration:{enabled:true,adapters:{enabled:true,custodian},approvals:{connection:true}}});
 try{
  const next={enabled:true,adapters:{enabled:true,balanceMode:'api',approvedVideoAssetIds:['synthetic-provider-asset'],
   ownerBootstrapVideoApproved:false,readSafetyApproval:async()=>assert.fail('no quote required')},
   trial:{mediaHost:new URL(projectURL).hostname,infrastructure:{verified:true,maximumUsd:0},...(fivePerson?{maximumParticipants:5,maximumCents:250}:{})},approvals:{connection:true,media:true,trial:true}};
  if(fivePerson)await assert.rejects(x.host.configureApprovedOperator({connectionId,operatorConfiguration:{...next,trial:{...next.trial,maximumCents:300}}}),/APPROVED_OPERATOR_CONFIGURATION_REQUIRED/);
  const capability=await x.host.configureApprovedOperator({connectionId,operatorConfiguration:next});
  assert.equal(capability.available.media,true);assert.equal(x.counts.credentials,0);assert.equal(x.counts.sdk,0);assert.equal(x.counts.native,0);
  assert.deepEqual(capability.participants,fivePerson?[2,3,5]:[2,3]);
 }finally{await x.host.close();}
});

test('invalid upload requests cannot initialize or write pinned bootstrap selection',async()=>{
 const x=fixture({operatorConfiguration:sourceOperator});try{
  const body={role:'seed',mimeType:'audio/wav',byteLength:audio.length,sha256:fixtureSha(audio),referenceSha256:null,consent:true};
  const cases=[{headers:{origin:'https://example.invalid'}},{headers:{authorization:'example_forbidden'}},
   {headers:{'x-fal-key':'example_forbidden'}},{method:'GET'},{body:JSON.stringify({...body,consent:false})}];
  for(const change of cases){const method=change.method??'POST';
   const response=await x.host.handleRequest(x.request(`/api/rooms/${roomId}/operator/media/begin`,{method,
    headers:{origin,'x-room-owner':owner,'content-type':'application/json',...change.headers},
    ...(method==='POST'?{body:change.body??JSON.stringify(body)}:{})}));assert.notEqual(response.status,200);}
  assert.equal(x.counts.native,0);assert.equal(x.objects.size,0);assert.equal(x.counts.sdk,0);assert.equal(x.counts.credentials,0);
  assert(x.calls.every(c=>c.path==='/rest/v1/rpc/vdj_generation_request'));
 }finally{await x.host.close();}
});
test('concrete operator adapter config mounts without an ambient operation credential or bootstrap and verifies only pricing',async()=>{
 const connectionId='synthetic-connection';let registered=0,reads=0;
 const x=fixture({credentialForOperation:undefined,bootstrapConfiguration:undefined,operatorConfiguration:{enabled:true,approvals:{connection:true},
  adapters:{enabled:true,custodian:{accept:async()=>{registered++;return {...scope,connectionId,verified:true,expiresAtMs:50000};},read:async()=>({...scope,connectionId,verified:true,expiresAtMs:50000}),withCredential:async(_,fn)=>fn('example_fixture_credential')}}},
  platformFixtureResponse:async(url,init)=>{reads++;assert.equal(new URL(url).pathname,'/v1/models/pricing');assert.equal(init.method,'GET');
   return Response.json({prices:['openrouter/router','fal-ai/stable-audio-3/medium/audio-outpainting','minimax/h3-max/image-to-video'].map(endpoint_id=>({endpoint_id,unit:'fixture-unit',unit_price:.01,currency:'USD'})),has_more:false,next_cursor:null});}});
 try{const response=await x.host.handleRequest(x.request(`/api/rooms/${roomId}/operator/connection`,{method:'POST',headers:{origin,'x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify({credential:'example_fixture_credential'})}));
  assert.equal(response.status,200);assert.equal((await response.json()).connectionId,connectionId);assert.equal(registered,1);assert.equal(reads,1);assert.equal(x.counts.sdk,0);assert.equal(x.counts.native,0);
 }finally{await x.host.close();}
});

test('disabled production host is dormant across capability, startup, job/media and close paths',async()=>{
 const x=fixture({enabled:false});const capabilities=await (await x.host.handleRequest(x.request('/api/room-capabilities'))).json();
 assert.equal(capabilities.generation,false);assert.equal(capabilities.autoDJ,false);
 for(const path of [`/api/rooms/${roomId}/source/startup`,`/api/rooms/${roomId}/jobs/state`,`/api/rooms/${roomId}/cloud/media/not-present`])
  await x.host.handleRequest(x.request(path,{method:'POST',body:'{}',headers:{origin,'x-room-owner':owner,'content-type':'application/json'}}));
 await assert.rejects(x.host.start(),/NOT_ACTIVATED/);await x.host.close();
 assert.deepEqual(x.counts,{pool:0,native:0,sdk:0,credentials:0,owner:0,platform:0,end:0});assert.equal(x.calls.length,0);assert.equal(x.sql.length,0);
});

test('startup route fixes server asset selection and rejects caller authority, oversized JSON and foreign origin',async()=>{
 const x=fixture();try{
  for(const body of [JSON.stringify({audioAssetId:'caller-source'}),JSON.stringify({serverQC:true}),JSON.stringify({padding:'x'.repeat(4096)}),'[]']){
   const result=await x.host.handleRequest(x.startup(body));assert.equal(result.status,409);assert.equal((await result.json()).error,'SOURCE_STARTUP_HOLD');}
  for(const headers of [{origin:'https://example.invalid'},{authorization:'example_forbidden'},{'x-fal-key':'example_forbidden'}])
   assert.equal((await x.host.handleRequest(x.startup('{}',headers))).status,403);
  assert.equal(x.counts.native,0);assert.equal(x.objects.size,0);assert.equal(x.counts.sdk,0);assert.equal(x.counts.credentials,0);
  assert(x.calls.every(c=>c.path==='/rest/v1/rpc/vdj_generation_request'&&c.body.op==='cueState'));
 }finally{await x.host.close();}
});

test('fixed bootstrap prepares private physical assets through real REST transport once and returns descriptor without keys',async()=>{
 const x=fixture();try{
  for(const [id,bytes,type] of [['approved-audio',audio,'audio/wav'],['approved-reference',reference,'image/png']])
   await x.host.io.privateStore.assetStore.save({id,bytes,contentType:type,binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'owner-supplied-bootstrap'}});
  const result=await x.host.handleRequest(x.startup());assert.equal(result.status,200,JSON.stringify(await result.clone().json()));
  const body=await result.json();assert.equal(body.mode,'bootstrap');assert.equal(body.source.actual,false);assert.equal(body.source.frameCount,24*44100);
  assert.equal(body.descriptor.sha256,fixtureSha(audio));assert.equal(body.descriptor.mimeType,'audio/wav');assert.equal(x.counts.native,1);
  const writes=x.calls.filter(c=>c.method==='POST'&&c.path.startsWith('/storage/')).length;
  assert.equal((await x.host.handleRequest(x.startup())).status,200);assert.equal(x.counts.native,1);
  assert.equal(x.calls.filter(c=>c.method==='POST'&&c.path.startsWith('/storage/')).length,writes);
  assert.equal(x.counts.sdk,0);assert.equal(x.counts.credentials,0);assert(!/authorization|ownerCapability|apiKey|token|keyProof/.test(JSON.stringify(body)));
  x.configuration.motifId='changed-approved-motif';
  assert.equal((await x.host.handleRequest(x.startup())).status,409);
  assert.equal(x.calls.filter(c=>c.method==='POST'&&c.path.startsWith('/storage/')).length,writes);
  assert.equal(x.counts.native,1);
 }finally{await x.host.close();}
});

test('owner metadata GET uses actual read-only room/cue APIs and scope SELECT; never observes, claims or generates',async()=>{
 const x=fixture();try{const result=await x.host.handleRequest(x.request(`/api/rooms/${roomId}`));
  assert.equal(result.status,200,JSON.stringify(await result.clone().json()));const body=await result.json();assert.equal(body.roomId,roomId);
  assert(x.calls.some(c=>c.path==='/rest/v1/rpc/vdj_room_request'&&c.body.op==='read'));
  assert(x.calls.every(c=>['/rest/v1/rpc/vdj_room_request','/rest/v1/rpc/vdj_generation_request'].includes(c.path)));
  assert(!x.sql.some(q=>q.text==='BEGIN TRANSACTION READ WRITE'||q.text===PLAYER_OBSERVER_SQL||q.text===DURABLE_SCHEDULER_SQL));
  assert.equal(x.counts.native,0);assert.equal(x.counts.sdk,0);assert.equal(x.counts.credentials,0);assert.equal(x.objects.size,0);
 }finally{await x.host.close();}
});
test('overlapping owner display polls share one in-flight projection and completed reads are refreshed',async()=>{
 const x=fixture(),path=`/api/rooms/${roomId}`;
 try{
  await x.host.handleRequest(x.request(path));
  const singleReadCalls=x.calls.filter(c=>c.path==='/rest/v1/rpc/vdj_room_request').length;
  x.calls.length=0;
  const responses=await Promise.all([1,2,3].map(()=>x.host.handleRequest(x.request(path))));
  assert.deepEqual(responses.map(r=>r.status),[200,200,200]);
  assert.equal(x.calls.filter(c=>c.path==='/rest/v1/rpc/vdj_room_request').length,singleReadCalls);
  for(const response of responses)assert.equal((await response.json()).roomId,roomId);
  await x.host.handleRequest(x.request(path));
  assert.equal(x.calls.filter(c=>c.path==='/rest/v1/rpc/vdj_room_request').length,singleReadCalls*2);
 }finally{await x.host.close();}
});

test('prepared bootstrap playback reuses immutable bytes but preserves fresh scope, isolated copies and physical admission reads',async()=>{
 let clock=1000;const x=fixture({now:()=>clock});
 try{
  for(const [id,bytes,type] of [['approved-audio',audio,'audio/wav'],['approved-reference',reference,'image/png']])
   await x.host.io.privateStore.assetStore.save({id,bytes,contentType:type,binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'owner-supplied-bootstrap'}});
  await x.host.start();
  const reads=()=>x.calls.filter(c=>c.method==='GET'&&c.path.startsWith('/storage/')).length;
  const before=reads(),copy=await x.host.bootstrap.readPreparedAuthority(scope);
  copy.source.music.sha256='0'.repeat(64);
  assert.equal((await x.host.bootstrap.readPreparedAuthority(scope)).source.music.sha256,fixtureSha(audio));
  assert.equal((await x.host.bootstrap.startup()).descriptor.sha256,fixtureSha(audio));
  assert.equal(reads(),before,'runtime uses the already verified immutable snapshot');
  await x.host.bootstrap.readStartAuthority(scope);
  assert(reads()>before,'physical admission still rereads storage');
  await assert.rejects(x.host.bootstrap.readPreparedAuthority({...scope,controlRevision:1}),/SCOPE_CHANGED/);
  clock=60000;await assert.rejects(x.host.bootstrap.startup(),/ROOM_SCOPE_UNAVAILABLE/);
 }finally{await x.host.close();}
 await assert.rejects(x.host.bootstrap.readPreparedAuthority(scope),/NOT_ACTIVATED/);
});

test('compiled private SQL mapping uses bounded write transaction; arbitrary SQL and room-read mutations denied before IO',async()=>{
 const x=fixture();try{
  const repo=x.host.io.repository;
  await repo.privateStateQuery(PLAYER_OBSERVER_SQL,['read',roomId,owner,exampleEpoch,0,null,null]);
  await repo.privateStateQuery(DURABLE_SCHEDULER_SQL,['claim',roomId,owner,JSON.stringify({['sessionId']:exampleEpoch,controlRevision:0,workerId:'worker-'.padEnd(30,'x'),leaseMs:30000})]);
  assert.equal(x.sql.filter(q=>q.text==='BEGIN TRANSACTION READ WRITE').length,2);
  assert.equal(x.sql.filter(q=>q.text==='COMMIT').length,2);assert(x.releases.every(v=>v===false));
  const transient={...scope,__observationFence:{scopeExpiresAtMs:60000,playback:{synthetic:'x'.repeat(70000)},runtime:null}};
  await repo.privateStateQuery(PLAYER_OBSERVER_SQL,['cas',roomId,owner,exampleEpoch,0,0,JSON.stringify(transient)]);
  const before=x.sql.length;
  for(const [statement,params] of [['update vdj_internal.rooms set control_revision=5',[]],[DURABLE_SCHEDULER_SQL,['claim','33333333-3333-4333-a333-333333333333',owner,'{}']],
   [PLAYER_OBSERVER_SQL,['cas',roomId,owner,exampleEpoch,0,0,JSON.stringify({padding:'x'.repeat(65536)})]],
   [PLAYER_OBSERVER_SQL,['cas',roomId,owner,exampleEpoch,0,0,JSON.stringify({...transient,padding:'x'.repeat(65536)})]],
   [OPERATOR_STATE_SQL,['cas',roomId,owner,exampleEpoch,0,0,JSON.stringify(transient)]]])
   await assert.rejects(repo.privateStateQuery(statement,params),/STATE_QUERY_REQUIRED/);
  assert.equal(x.sql.length,before);
  for(const action of ['create','close','control','join','submit','ownerControl'])await assert.rejects(repo.roomRead(action,roomId,owner,{}),/RPC_SCOPE_REQUIRED/);
  assert.equal(x.calls.length,0);await repo.readRoom(roomId,owner);
  const call=x.calls.at(-1);assert.equal(call.path,'/rest/v1/rpc/vdj_room_request');
  assert.deepEqual(call.body,{op:'read',room_id:roomId,capability:owner,payload:{},verified_uid:null});
  assert.equal(call.headers.get('content-profile'),'public');
 }finally{await x.host.close();}
});

test('first private render-record save and reconstruction use real immutable REST metadata path',async()=>{
 const x=fixture();try{
  const store=createProductionRenderRecordStore({enabled:true,assetStore:x.host.io.privateStore.assetStore});
  const binding={roomId,submissionId:'guest',generationId:'generated',commonIntentSha256:'b'.repeat(64),controlVersion:1,channel:'music'};
  const input={roomId,operationId:'render-operation',cueId:'cue-id',binding,source:{audioAssetId:'seed',music:{clipId:'seed'},
   playback:{revision:0}},render:{assetId:'native-render',receipt:{renderedSha256:'c'.repeat(64)}},evidenceSha256:'d'.repeat(64)};
  const saved=await store.save(input);assert.equal(saved.operationId,input.operationId);
  const cue={cueId:input.cueId,operationId:input.operationId,music:{binding,parentClipId:'seed'},evidenceSha256:input.evidenceSha256};
  const read=await store.read({roomId,cue});assert.equal(cueDigest(read),cueDigest(saved));
  assert.equal(read.source.playback.actual,false);assert(x.calls.filter(c=>c.method==='POST').length>=2);
 }finally{await x.host.close();}
});

 test('optional private lookup treats only typed absence as missing; corruption cannot rebootstrap or replace render metadata',async()=>{
 const x=fixture();try{
  const assets=x.host.io.privateStore.assetStore;assert.equal(await assets.readOptional('absent-record'),null);
  const binding={kind:'owner-supplied-bootstrap'};
  await assets.save({id:'example-json',bytes:new TextEncoder().encode('{}'),contentType:'application/json',binding,provenance:binding});
  const key=[...x.objects.keys()].find(k=>k.endsWith('/example-json.json'));const prior=x.objects.get(key);
  const metadata=JSON.parse(prior.bytes.toString());metadata.recordSha256='f'.repeat(64);
  x.objects.set(key,{...prior,bytes:Buffer.from(JSON.stringify(metadata))});
  const writes=x.calls.filter(c=>c.method==='POST').length;await assert.rejects(assets.readOptional('example-json'),/RECORD_CHANGED/);
  assert.equal(x.calls.filter(c=>c.method==='POST').length,writes);assert.equal(x.counts.native,0);assert.equal(x.counts.sdk,0);
 }finally{await x.host.close();}
 });

test('persisted preparation plan resumes through the actual host source identity check without resubmitting intents',async()=>{
 let record=null,safety=0,background=0;const diagnostics=[];
 const x=fixture({deferScheduler:true,readOperatorRecord:()=>record,runBackground:fn=>{background++;return fn();},onDiagnostic:e=>diagnostics.push(e),
  operatorConfiguration:{enabled:true,approvals:{trial:true},adapters:{enabled:false,readSafetyApproval:async()=>{safety++;}}}});
 try{
  for(const [id,bytes,type] of [['approved-audio',audio,'audio/wav'],['approved-reference',reference,'image/png']])
   await x.host.io.privateStore.assetStore.save({id,bytes,contentType:type,binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'owner-supplied-bootstrap'}});
  const selected=await x.host.bootstrap.prepare(),source={...selected.source,playback:{actual:false,phase:'PREPARING',revision:0,playedUntilFrame:0}};
  const plan={...scope,planId:'trial-synthetic-resume',phase:'STARTED',participants:2,expiresAtMs:50000,maximumCents:100,
   connectionId:'synthetic-connection',sourceSha256:cueDigest(cueSourceIdentity(source)),operations:[{permit:{source}}]};
  record={...scope,plans:{[plan.planId]:plan},active:{planId:plan.planId,phase:'STARTED',participants:2}};
  const send=maximumCents=>x.host.handleRequest(x.request(`/api/rooms/${roomId}/operator/resume`,{method:'POST',
   headers:{origin,'x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify({planId:plan.planId,maximumCents,consent:true})}));
  const beforeScopes=x.sql.filter(q=>q.text===EXISTING_REPOSITORY_SELECTS.scope).length;
  const result=await send(100);assert.equal(result.status,200,JSON.stringify(await result.clone().json()));
  assert.equal(x.sql.filter(q=>q.text===EXISTING_REPOSITORY_SELECTS.scope).length-beforeScopes,7,'same resume path previously needed 13 scope reads');
  assert.equal((await result.json()).resumed,true);assert.equal(x.host.capabilities().executionPaused,false);
  assert.equal(x.host.capabilities().schedulerStarted,true);assert.equal(background,1);assert.equal(safety,1);
  assert.equal((await send(150)).status,409);assert.equal(background,1);assert.equal(safety,1);
  assert.equal(diagnostics.at(-1).reason,'input:OPERATOR_TRIAL_CONSENT_REQUIRED');
  assert.equal(x.counts.sdk,0);assert.equal(x.counts.credentials,0);
 }finally{await x.host.close();}
});

test('concurrent operator display reads share only in-flight work and subsequent reads remain fresh',async()=>{
 const x=fixture({bootstrapConfiguration:{},operatorConfiguration:{enabled:true,approvals:{}}}),path=`/api/rooms/${roomId}/operator/status`;
 try{
  assert.equal((await x.host.handleRequest(x.request(path))).status,200);const baseline=x.calls.length;
  x.calls.length=0;const views=await Promise.all([1,2,3].map(()=>x.host.handleRequest(x.request(path))));
  assert.deepEqual(views.map(x=>x.status),[200,200,200]);assert.equal(x.calls.length,baseline);
  assert.equal((await x.host.handleRequest(x.request(path))).status,200);assert.equal(x.calls.length,baseline*2);
 }finally{await x.host.close();}
});

test('explicit expired trial status captures only existing receipts through the actual host; periodic GET never calls provider',async()=>{
 let record,op,permit,credentialReads=0,providerReads=0;
 const connectionId='synthetic-reconciliation-connection',credential='example_existing_receipt_credential';
 const connections={connect:async()=>assert.fail('no new connection'),read:async()=>({...scope,connectionId,verified:true,expiresAtMs:50000}),
  forOperation:async()=>assert.fail('expired dispatch forbidden'),withCredential:async(s,fn)=>{credentialReads++;return fn(credential);}};
 const x=fixture({readOperatorRecord:()=>record,queryFixtureResponse:(text)=>text===EXISTING_REPOSITORY_SELECTS.permit?
  {rows:[{...scope,permitId:permit.permitId,revoked:false,expiresAtMs:500,permitDocument:permit}]}:{rows:[]},
  generationFixtureResponse:body=>{assert.equal(body.op,'read');assert.equal(body.payload.operationId,op.operationId);return Response.json(op);},
  providerFixtureResponse:async(url,init)=>{providerReads++;assert.equal(init.method,'GET');return Response.json(url.endsWith('/status')?{status:'COMPLETED'}:
   {output:JSON.stringify({needsClarification:false,question:'',interpretation:'広がる',direction:'down',intensity:.5,visualOpenness:'increase',
    musicDevelopment:'Reduce competing layers gently.',visualDevelopment:'Open geometry and preserve detail.'}),usage:{cost:.001}});},
  loadSDK:async()=>({createFalClient:({fetch})=>({queue:{status:async()=>{const r=await fetch('https://queue.fal.run/example/status',{method:'GET'});return r.json();},
   result:async()=>{const r=await fetch('https://queue.fal.run/example/result',{method:'GET'});return {data:await r.json()};}}})}),
  operatorConfiguration:{enabled:true,approvals:{connection:true,media:true,trial:true},connections,verifySavedVideo:async()=>null,
   trial:{quoteAndBalance:async()=>assert.fail('no financial quote'),signSource:async()=>assert.fail('no signing')}}});
 try{
  for(const [id,bytes,type] of [['approved-audio',audio,'audio/wav'],['approved-reference',reference,'image/png']])
   await x.host.io.privateStore.assetStore.save({id,bytes,contentType:type,binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'owner-supplied-bootstrap'}});
  const {source}=await x.host.bootstrap.prepare(),sourceSha256=cueDigest(cueSourceIdentity(source));
  permit={permitId:'permit_synthetic_existing_receipt',kind:GENERATION_CONTRACT.version,counts:GENERATION_CONTRACT.counts,connectionId,
   source,sourceSha256,expiresAtMs:500,quote:{maximumUsd:{intent:.01,music:.1,video:.5}}};
  const operationId='operator_synthetic_existing_receipt';op={operationId,submissionId:'synthetic_submission',prompt:'静かな星空',permit,stopped:false,dispatchAllowed:false,
   keyProof:cueDigest({domain:'room-generation-key-v1',key:credential,operationId}),stages:{intent:{state:'SUBMITTED',signature:'e'.repeat(64),requestId:'synthetic_existing_receipt'}}};
  const plan={...scope,planId:'trial-existing-receipt',phase:'STARTED',participants:2,expiresAtMs:500,connectionId,sourceSha256,assets:[],operations:[op]};
  record={...scope,plans:{[plan.planId]:plan},active:{planId:plan.planId,phase:'STARTED',participants:2}};
  const statusPath=`/api/rooms/${roomId}/operator/status`;
  assert.equal((await x.host.handleRequest(x.request(statusPath))).status,200);assert.equal(providerReads,0);
  const post=()=>x.host.handleRequest(x.request(`/api/rooms/${roomId}/operator/trial/status`,{method:'POST',headers:{origin,'x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify({planId:plan.planId})}));
  const response=await post();assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const result=await response.json();assert.equal(result.reconciliation[0].state,'RECONCILED_RESULTS',JSON.stringify(result));
  assert.equal(result.reconciliation[0].spendingAuthorized,false);assert.equal(providerReads,2);assert.equal(credentialReads,2);
  assert.equal(op.dispatchAllowed,false);assert.equal(op.stages.intent.state,'SUBMITTED');
  assert.equal((await post()).status,200);assert.equal(providerReads,2);assert.equal(x.state.cues.length,0);
  assert(x.calls.filter(c=>c.path==='/rest/v1/rpc/vdj_generation_request').every(c=>['read','cueState'].includes(c.body.op)));
 }finally{await x.host.close();}
});

test('pair renders persist separately from generation lineage and bind CURRENT identity/revision immutably',async()=>{
 const x=fixture();try{
  const store=createProductionRenderRecordStore({enabled:true,assetStore:x.host.io.privateStore.assetStore});
  const binding={roomId,submissionId:'synthetic-guest',generationId:'synthetic-generated',commonIntentSha256:'b'.repeat(64),controlVersion:1,channel:'music'};
  const input={roomId,operationId:'synthetic-render-operation',cueId:'synthetic-cue-id',binding,
   source:{audioAssetId:'seed',music:{clipId:'seed',sha256:'a'.repeat(64),contextSha256:'b'.repeat(64)},playback:{revision:0}},
   render:{assetId:'native-render',receipt:{renderedSha256:'c'.repeat(64)}},evidenceSha256:'d'.repeat(64)};
  const original=await store.save(input),cue={cueId:input.cueId,operationId:input.operationId,music:{binding,parentClipId:'seed'},evidenceSha256:input.evidenceSha256};
  const pairCurrent={clipId:'new-current',sha256:'e'.repeat(64),contextSha256:'f'.repeat(64),playbackRevision:1};
  const pair={...input,pairCurrent,source:{audioAssetId:'new-current',music:{clipId:pairCurrent.clipId,sha256:pairCurrent.sha256,
   contextSha256:pairCurrent.contextSha256},playback:{revision:1}},render:{assetId:'pair-render',receipt:{renderedSha256:'e'.repeat(64)}}};
  await store.save(pair);const rebuilt=createProductionRenderRecordStore({enabled:true,assetStore:x.host.io.privateStore.assetStore});
  assert.equal((await rebuilt.read({roomId,cue,pairCurrent})).render.assetId,'pair-render');
  assert.equal(cueDigest(await rebuilt.read({roomId,cue})),cueDigest(original));
  await assert.rejects(rebuilt.read({roomId,cue,pairCurrent:{...pairCurrent,playbackRevision:2}}),/CUE_CHANGED/);
  await assert.rejects(rebuilt.save({...pair,render:{assetId:'changed',receipt:{renderedSha256:'e'.repeat(64)}}}),/IMMUTABLE/);
 }finally{await x.host.close();}
});

test('unload Stop retires the graph first and never stops the room without a graph Stop receipt',async()=>{
 const x=fixture();
 const unload=(headers={})=>x.host.handleRequest(x.request(`/api/rooms/${roomId}/player/unload-stop`,
  {method:'POST',headers:{origin,'x-room-owner':owner,'content-type':'application/json',...headers},body:'{}'}));
 const denied=await unload({origin:'https://attacker.example'});assert.equal(denied.status,403);
 const reply=await unload();assert.equal(reply.status,200);
 assert.deepEqual(await reply.json(),{graphStopped:false,roomStopped:false},'no graph: the room is left unstopped');
 assert.equal(x.calls.some(c=>c.path==='/rest/v1/rpc/vdj_generation_request'&&c.body?.op==='cueStop'),false,'no bare room Stop');
});
