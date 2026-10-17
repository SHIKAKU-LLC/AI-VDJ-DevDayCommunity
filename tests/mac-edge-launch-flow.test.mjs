import {createMacCompanionRuntime} from '../integration/mac-host/companion-runtime.mjs';
import {digestRuntimeBytes} from '../cloud/room/runtime-request-proof.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createMacHost} from '../integration/mac-host/server.mjs';
import {createMacEdgeTrialRuntime} from '../integration/mac-host/edge-trial-composition.mjs';
import {createEdgeRuntimeBroker} from '../cloud/room/runtime-broker.mjs';
import {createProductionNativeHost} from '../cloud/worker/production-host.mjs';
import {createProductionPlayerMaterial} from '../cloud/worker/player-material.mjs';
import {createBootstrapInspector,decodeCompleteWave,prepareBootstrap} from '../integration/runtime/bootstrap.mjs';
import {syntheticWave,fixtureSha,syntheticReference} from './cloud-worker-fixture.mjs';
import {createNativeReferenceInspector} from '../cloud/worker/reference-inspector.mjs';
import {APPROVED_KEYCHAIN_ITEM} from '../integration/mac-host/keychain-provider.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import {createEdgeTrialNativeOrchestrator} from '../integration/mac-host/edge-trial-native-orchestrator.mjs';

// A complete transport fixture: actual loopback HTTP and Ed25519 signing,
// synthetic room rows/Storage/Fal responses, and no real provider work.
const roomId='11111111-1111-4111-a111-111111111111';
const example_epoch='22222222-2222-4222-a222-222222222222';
const foreignRoom='33333333-3333-4333-a333-333333333333';
const owner='a'.repeat(64),cloudOrigin='https://ai-vdj.vercel.app';
const projectURL='https://example.supabase.co';
const example_platform_value='example_platform_placeholder';
const fixtureCredential='example_fixture_credential';

async function fixture(t,{enabled=true,approval=true,realNativeInspector=false,orchestrated=false,companion=false}={}){
 let clock=Date.now(),registered=null,approvedWorker=null,reads=0,secretBytes,nativeHost,metadata;
 const calls={native:[],edge:[],platform:[],client:[],confirm:0,schedulerStarts:0};
 const scope={roomId,['sessionId']:example_epoch,controlRevision:0,expiresAtMs:clock+(companion?120:20)*60_000};
 const bucket={id:'ai-vdj-private',public:false,file_size_limit:32*1024*1024,
  allowed_mime_types:['audio/wav','video/mp4','image/png','image/jpeg','application/json']};
 const playback={roomId,cues:[],pending:false,stopped:false,currentCredit:null};
 const room={...scope,closed:false,accepting:true,submissions:[],eventSeq:0};
 const objects=new Map();
 let observerVersion=0,observerRecord=null;
 const sourceStartReceipts=new Map();
 const wave=syntheticWave(24),reference=syntheticReference();
 // The local preparation uses a deterministic inspector fixture. The positive
 // production path runs the real Python bootstrap inspector over the same WAV.
 const inspectBootstrap=async bytes=>{
  const decoded=decodeCompleteWave(bytes);return {method:'pcm-endpoint-profile-v1',assetSha256:decoded.sha256,
   frameCount:decoded.frames,sampleRate:44100,channels:2,loudness:{truePeakDbtp:-10},nonfiniteSamples:0,
   clippedFraction:0,activity:{effectiveSilence:false,maxQuietRunSeconds:0}};
 };
 const localBootstrap=await prepareBootstrap({audioBytes:wave,referenceBytes:reference,inspect:inspectBootstrap});
 const platformFetch=async(url,init)=>{
  const u=new URL(url),headers=new Headers(init.headers),path=u.pathname;
  assert.equal(u.origin,projectURL);assert.equal(headers.get('apikey'),example_platform_value);
  assert.equal(headers.get('authorization'),example_platform_value);
  calls.platform.push({path,method:init.method});
  if(path==='/rest/v1/rpc/vdj_runtime_request'){
   const b=JSON.parse(init.body);
   assert.equal(b.requested_room,roomId);assert.equal(b.capability,owner);
   if(b.action==='scope')return Response.json(scope);
   if(b.action==='authorize')return Response.json({authorized:true});
   if(b.action==='query'){
    const k=b.payload.statementId;
    if(k==='scope')return Response.json({rows:[{...scope,ownerEnabled:true}]});
    if(k==='runtime')return Response.json({rows:[]});
    if(k==='observer'){
     const [action,,revision,version,record]=b.payload.args;
     assert.equal(revision,scope.controlRevision);
     if(action==='sourceReceiptRead'||action==='sourceReceiptPut'){
      const key=record.graphEpoch+':'+record.targetPlayerId,prior=sourceStartReceipts.get(key);
      if(action==='sourceReceiptPut'){
       if(prior&&(prior.ackSha256!==record.ackSha256||prior.authoritySha256!==record.authoritySha256))
        return Response.json({message:'synthetic_immutable_receipt_conflict'},{status:409});
       if(!prior)sourceStartReceipts.set(key,structuredClone(record));
      }
      return Response.json({rows:[{value:{version:sourceStartReceipts.size,record:sourceStartReceipts.get(key)??null,
       ...(action==='sourceReceiptPut'?{duplicate:prior!==undefined}:{})}}]});
     }
     if(action==='read')return Response.json({rows:[{value:{version:observerVersion,record:observerRecord,
      scope:structuredClone(scope),playback:structuredClone(playback),runtime:null}}]});
     if(action==='cas'&&version===observerVersion){observerRecord=record;observerVersion++;
      return Response.json({rows:[{value:{version:observerVersion,record:observerRecord}}]});}
     return Response.json({message:'synthetic_cas_conflict'},{status:409});
    }
    if(k==='operator')return Response.json({rows:[{value:{version:0,record:null}}]});
    if(k==='scheduler')return Response.json({rows:[{value:null}]});
    return Response.json({rows:[]});
   }
   return Response.json({message:'synthetic_rpc_hold'},{status:409});
  }
  if(path==='/rest/v1/rpc/vdj_generation_request'){
   const b=JSON.parse(init.body);assert.equal(b.room_id,roomId);assert.equal(b.capability,owner);
   return b.op==='cueState'?Response.json(playback):Response.json({message:'synthetic_generation_hold'},{status:409});
  }
  if(path==='/rest/v1/rpc/vdj_room_request'){
   const b=JSON.parse(init.body);assert.equal(b.room_id,roomId);assert.equal(b.capability,owner);
   return b.op==='read'?Response.json(room):Response.json({message:'synthetic_room_hold'},{status:409});
  }
  if(path==='/storage/v1/bucket/'+bucket.id)return Response.json(bucket);
  const get='/storage/v1/object/authenticated/'+bucket.id+'/',put='/storage/v1/object/'+bucket.id+'/';
  if(path.startsWith(get)){
   const item=objects.get(path.slice(get.length));
   return item?new Response(item.bytes,{headers:{'content-type':item.contentType}}):Response.json({code:'NoSuchKey'},{status:404});
  }
  if(path.startsWith(put)){
   const key=path.slice(put.length);
   if(objects.has(key))return Response.json({code:'KeyAlreadyExists'},{status:409});
   objects.set(key,{bytes:Uint8Array.from(init.body),contentType:headers.get('content-type')});
   return Response.json({Key:bucket.id+'/'+key});
  }
  assert.fail('unapproved platform fixture route: '+path);
 };
 const broker=createEdgeRuntimeBroker({enabled,projectURL,platformHeaders:new Headers({apikey:example_platform_value,authorization:example_platform_value}),
  readApprovedWorker:async id=>approvedWorker?.workerId===id?approvedWorker:null,
  readApprovedDevice:async id=>companion&&registered?.workerId===id?{...registered,approved:true,revoked:false,roomIds:[roomId]}:null,fetchImpl:platformFetch,now:()=>clock});
 t.after(()=>broker.close());
 const nativeFetch=async(url,init={})=>{
  const u=new URL(url),headers=new Headers(init.headers);
  assert(![...headers.values()].includes(example_platform_value));
  calls.native.push({path:u.pathname,headers,body:init.body});
  if([cloudOrigin,projectURL].includes(u.origin)&&u.pathname.endsWith('/host/session')){
   assert.equal(headers.get('x-room-owner'),owner);
   return Response.json({...scope,submissions:[],generationEnabled:false});
  }
  if(u.origin==='https://api.fal.ai'){
   assert.equal(headers.get('authorization'),'Key '+fixtureCredential);
   if(u.pathname==='/v1/account/billing')return Response.json({credits:{currency:'USD',current_balance:2}});
   assert.equal(u.pathname,'/v1/models/pricing');
   return Response.json({prices:['intent','music','video'].map(k=>({endpoint_id:GENERATION_CONTRACT[k],
    unit:'synthetic-unit',unit_price:.1,currency:'USD'})),has_more:false,next_cursor:null});
  }
  assert.equal(u.origin,projectURL);assert(!headers.has('apikey'));assert(!headers.has('authorization'));
  calls.edge.push({path:u.pathname,body:init.body});
  return broker.handleRequest(new Request(url,init));
 };
 const readActivation=async registration=>{
  assert.equal(registration.workerId,registered?.workerId);
  if(!approval)return {approved:false};
  return {approved:true,registration:structuredClone(registered),keychainApproval:{...registered,...APPROVED_KEYCHAIN_ITEM,
   approved:true,process:'ai-vdj-native-node',recipient:'fal-fixed-generation-and-platform'}};
 };
 const pairs=[];
 let identity;
 if(companion){const pair=await crypto.subtle.generateKey('Ed25519',false,['sign','verify']),publicJwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
  identity={workerId:'device-44444444-4444-4444-a444-444444444444',publicJwk,
   publicKeySha256:await digestRuntimeBytes(new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.keys(publicJwk).sort().map(k=>[k,publicJwk[k]]))))),
   sign:async bytes=>new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,bytes))};}
 const nativeConfiguration={bootstrapConfiguration:{},credentialForOperation:()=>assert.fail('provider operation forbidden'),
  loadNative:async()=>({close:async()=>{},native:{inspectAudio:async()=>assert.fail('no generated audio'),inspectVideo:async()=>assert.fail('no generated video')},
   inspectReference:realNativeInspector?createNativeReferenceInspector({ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'}):
    async bytes=>({sha256:fixtureSha(bytes),fullyDecoded:true,width:2,height:2}),
   inspectBootstrap:realNativeInspector?createBootstrapInspector({python:process.env.VDJ_QC_PYTHON??'python3',
    ...(process.env.VDJ_QC_DSP?{dspModule:process.env.VDJ_QC_DSP}:{})}):inspectBootstrap})};
 const createRuntime=options=>createMacEdgeTrialRuntime({...options,fetchImpl:nativeFetch,now:()=>clock,
  configuration:{...nativeConfiguration,...options.configuration,loadNative:nativeConfiguration.loadNative},
  keychainReadItem:async()=>{reads++;return secretBytes=Buffer.from(fixtureCredential);},
  createNativeHost:cfg=>{nativeHost=createProductionNativeHost(cfg);return {...nativeHost,
   start:async()=>{calls.schedulerStarts++;return nativeHost.start();}};}});
 const host=await createMacHost({roomId,cloudOrigin,enableProductionRoutes:true,now:()=>clock,
  ...(companion?{companionMode:true,companionRuntimeApproved:true,verifyOwner:async b=>{assert.equal(b.ownerCapability,owner);},
   consentStore:{read:async()=>({roomIds:[roomId]}),save:()=>assert.fail('restored device needs no reenroll'),remove:async()=>{}}}:
   {expiresAtMs:scope.expiresAtMs}),
  confirm:async()=>{calls.confirm++;return true;},showPairing:async p=>pairs.push(p),loadBootstrap:async()=>localBootstrap,
  createRuntime:context=>{
   if(companion)return createMacCompanionRuntime({...context,roomId,projectURL,configuration:nativeConfiguration,createRuntime,fetchImpl:nativeFetch,now:()=>clock,
    policy:{approved:true,roomId,providerUseApproved:true,mediaUploadApproved:true},deviceStore:{identity:async()=>identity},
    readOperationalApproval:async()=>{throw Error('SYNTHETIC_OPERATIONAL_APPROVAL_PENDING');},
    writeRegistration:async(_,r)=>{registered=structuredClone(r);},writeMetadata:async value=>{metadata=value;}});
   const runtime=createRuntime({...context,roomId,projectURL,enabled,expiresAtMs:context.sessionExpiresAtMs,readActivation,
    writeRegistration:async r=>{registered=structuredClone(r);}});
   return orchestrated?createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs:context.sessionExpiresAtMs,
    readActivation,readCurrent:context.readCurrent,writeMetadata:async value=>{metadata=value;},
    readOperationalConfiguration:async()=>{throw Error('SYNTHETIC_OPERATIONAL_APPROVAL_PENDING');},now:()=>clock,pollMs:100}):runtime;
  }});
 t.after(()=>host.close());
 const {origin}=await host.listen();if(!companion)await host.beginSession();
 const request=(path,data={},options={})=>{
  const {from=origin,session,method='POST',headers={}}=options;
  calls.client.push({path,method,from});
  return fetch(origin+path,{method,headers:{Origin:from,...(session?{'X-VDJ-Session':session}:{}),
   ...(method==='GET'?{}:{'Content-Type':'application/json'}),...headers},
   ...(method==='GET'?{}:{body:JSON.stringify(data)})});
 };
 const paired=companion?await request('/api/companion/connect',{roomId,ownerCapability:owner},{from:cloudOrigin}):await request('/api/pair',{code:pairs[0].code});assert.equal(paired.status,200);
 const local=(await paired.json()).session;
 return {host,origin,scope,room,pairs,request,local,calls,objects,
  wave,reference,nativeHost:()=>nativeHost,
  registered:()=>registered,metadata:()=>metadata,approve:()=>{approvedWorker={...registered,approved:true};},
  keyReads:()=>reads,secretBytes:()=>secretBytes,advance:ms=>{clock+=ms;}};
}

test('all-default-off listener stays paired but cannot prepare or access Edge, SQL, Storage, or Keychain',async t=>{
 const f=await fixture(t,{enabled:false});
 const r=await f.request('/api/runtime/prepare',{}, {session:f.local});
 assert.notEqual(r.status,200);
 assert.equal(f.registered(),null);assert.equal(f.keyReads(),0);
 assert.equal(f.calls.edge.length,0);assert.equal(f.calls.platform.length,0);
 assert.equal((await f.request('/api/state',{}, {session:f.local})).status,200);
});

test('loopback gate, one-time cloud pairing, pinned Ed25519 registration, and approved native owner routes',async t=>{
 const f=await fixture(t),{request,local,scope}=f;
 assert.equal((await request('/api/runtime/activate',{}, {session:local})).status!==200,true);
 assert.equal((await request('/api/rooms/'+roomId+'/operator/status',{}, {session:local,method:'GET'})).status!==200,true);
 assert.equal(f.calls.edge.length,0);assert.equal(f.keyReads(),0);
 await f.host.pairCloud();const cloudPair=await request('/api/pair',{code:f.pairs[1].code},{from:cloudOrigin});
 assert.equal(cloudPair.status,200);const cloud=(await cloudPair.json()).session;
 assert.equal((await request('/api/pair',{code:f.pairs[1].code},{from:cloudOrigin})).status,403);
 assert.equal((await request('/api/owner/connect',{roomId,ownerCapability:owner},{from:cloudOrigin,session:cloud})).status,200);
 for(const options of [{from:cloudOrigin,session:cloud},{session:local,from:'https://evil.example'},{}]){
  const result=await request('/api/runtime/prepare',{},options);
  assert.notEqual(result.status,200);
 }
 const prepared=await request('/api/runtime/prepare',{}, {session:local});
 assert.equal(prepared.status,200,JSON.stringify(await prepared.clone().json()));
 const registration=f.registered();assert(registration?.publicJwk);assert.equal(registration.roomId,roomId);
 assert.equal(registration.sessionId,example_epoch);assert.equal(registration.controlRevision,0);
 assert.equal(Object.hasOwn(registration.publicJwk,'d'),false);
 assert.equal(f.keyReads(),0);
 assert.equal((await request('/api/runtime/activate',{approved:true,ownerCapability:owner},{session:local})).status!==200,true);
 assert.equal((await request('/api/runtime/activate',{}, {session:local})).status!==200,true);
 f.approve();const activation=await request('/api/runtime/activate',{}, {session:local});
 assert.equal(activation.status,200,JSON.stringify(await activation.clone().json()));
 const status=await request('/api/rooms/'+roomId+'/operator/status',{}, {session:local,method:'GET'});
 assert.equal(status.status,200,JSON.stringify(await status.clone().json()));
 const state=await status.json();assert.equal(state.connection?.verified,true);
 assert.equal(f.keyReads(),1);assert(f.secretBytes().every(v=>v===0));
 const nativeCaps=await request('/api/rooms/'+roomId+'/native/capabilities',{}, {session:local,method:'GET'});
 assert.equal(nativeCaps.status,200);const capabilities=await nativeCaps.json();
 assert.equal(capabilities.cloud.durableScheduler,true);assert.equal(capabilities.actualProviderWorkVerified,false);
 assert.equal(f.calls.schedulerStarts,1);
 assert.equal(f.nativeHost().scheduler.capabilities().durableScheduler,true);
 const metadata=await request('/api/runtime/provider-metadata',{}, {session:local});
 assert.equal(metadata.status,200,JSON.stringify(await metadata.clone().json()));
 const observedMetadata=await metadata.json();assert.equal(observedMetadata.prices.length,3);
 assert.equal(observedMetadata.balance.usd,2);assert.equal(observedMetadata.generationInvoked,false);
 assert.equal((await request('/api/runtime/trial',{}, {session:local})).status,400);
 const spoofedHost=await new Promise((resolve,reject)=>{
  const req=http.request(f.origin+'/api/runtime/status',{method:'POST',headers:{Host:'evil.example',Origin:f.origin,
   'X-VDJ-Session':local,'Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});
  req.on('error',reject);req.end('{}');
 });
 assert.equal(spoofedHost,403);
 assert.equal((await request('/api/rooms/'+foreignRoom+'/operator/status',{}, {session:local,method:'GET'})).status!==200,true);
 assert.equal((await request('/api/rooms/'+roomId+'/operator/status',{}, {method:'GET'})).status,401);
 const cloudStatus=await request('/api/rooms/'+roomId+'/operator/status',{}, {session:cloud,from:cloudOrigin,method:'GET'});
 assert.equal(cloudStatus.status,200);
 assert.equal((await cloudStatus.json()).connection?.verified,true);
 const callerProof='b'.repeat(64);
 const beforeInjection=f.calls.native.length,edgeBeforeInjection=f.calls.edge.length;
 const callerAttempt=await request('/api/rooms/'+roomId+'/operator/status',{}, {session:local,method:'GET',
  headers:{'X-Room-Owner':callerProof}});
 assert.equal(callerAttempt.status,400);
 assert.equal(f.calls.native.length,beforeInjection);assert.equal(f.calls.edge.length,edgeBeforeInjection);
 assert(f.calls.native.filter(c=>c.path.includes('/runtime/')).every(c=>c.headers.get('x-room-owner')===owner));
 assert(f.calls.edge.some(c=>c.path.endsWith('/runtime/query')));
 assert(f.calls.platform.some(c=>c.path==='/rest/v1/rpc/vdj_runtime_request'));
 const leaked=JSON.stringify({state,registration,platform:f.calls.platform,edge:f.calls.edge.map(x=>x.path)});
 assert(!leaked.includes(owner));assert(!leaked.includes(fixtureCredential));assert(!leaked.includes(example_platform_value));
 assert(scope.expiresAtMs>=registration.expiresAtMs);
});

test('approved source startup, physical PCM observation and source-only ACK persist; Stop and expiry cut off work',
 {skip:process.platform!=='darwin'&&!process.env.VDJ_QC_PYTHON},async t=>{
 const f=await fixture(t,{realNativeInspector:true}),{request,local}=f;
 await f.host.pairCloud();const cloud=(await (await request('/api/pair',{code:f.pairs[1].code},{from:cloudOrigin})).json()).session;
 assert.equal((await request('/api/owner/connect',{roomId,ownerCapability:owner},{from:cloudOrigin,session:cloud})).status,200);
 assert.equal((await request('/api/runtime/prepare',{}, {session:local})).status,200);f.approve();
 assert.equal((await request('/api/runtime/activate',{}, {session:local})).status,200);
 const native=f.nativeHost();assert(native?.io?.privateStore?.assetStore);
 const imported=await request('/api/runtime/bootstrap',{}, {session:local});
 assert.equal(imported.status,200,JSON.stringify(await imported.clone().json()));
 const preloaded=await request('/api/rooms/'+roomId+'/playback/preload',{}, {session:local});
 assert.equal(preloaded.status,200);assert.deepEqual(await preloaded.json(),{roomId,assets:[]});
 assert.equal((await request('/api/rooms/'+roomId+'/playback/preload',{}, {session:local,method:'GET'})).status,405);
 const register=await request('/api/rooms/'+roomId+'/player/register',
  {sampleRate:44100,sourceCount:1,consumedFrames:0,receivedFrames:0,contextState:'running'}, {session:local});
 assert.equal(register.status,200,JSON.stringify(await register.clone().json()));
 const graph=await register.json();assert.equal(graph.graphEpoch,1);
 const source=await request('/api/rooms/'+roomId+'/source/startup',{}, {session:local});
 assert.equal(source.status,200,JSON.stringify(await source.clone().json()));
 const startup=await source.json();assert.equal(startup.mode,'bootstrap');assert.equal(startup.source.actual,false);
 assert.equal(startup.descriptor.sha256,fixtureSha(f.wave));
 const media=await request('/api/rooms/'+roomId+'/media/'+startup.descriptor.assetId+'?sha256='+startup.descriptor.sha256,
  {},{session:local,method:'GET'});
 assert.equal(media.status,200);assert.equal(fixtureSha(new Uint8Array(await media.arrayBuffer())),startup.descriptor.sha256);
 const material=createProductionPlayerMaterial({enabled:true,roomId,bootstrapAuthority:native.bootstrap,
  repositoryPorts:native.io.repositoryPorts,assetStore:native.io.privateStore.assetStore})
  .readVerifiedMaterial({scope:{roomId,['sessionId']:example_epoch,controlRevision:0},mode:'source'});
 const measured=await material;
 assert.equal(measured.binding.kind,'source');assert.equal(measured.queuedFrames,24*44100);
 const observed=await request('/api/rooms/'+roomId+'/player/observe',{
  targetPlayerId:graph.targetPlayerId,graphEpoch:graph.graphEpoch,sequence:1,binding:measured.binding,
  sampleRate:44100,sourceCount:1,contextState:'running',consumedFrames:1024,receivedFrames:measured.queuedFrames,
  underrunFrames:0,stopped:false,windowStartFrame:0,windowPCM:Array.from(measured.pcm.subarray(0,512)),video:null,
 },{session:local});
 assert.equal(observed.status,200,JSON.stringify(await observed.clone().json()));
 const window=measured.pcm.subarray(0,512),processedWindowSha256=createHash('sha256').update(
  new Uint8Array(window.buffer,window.byteOffset,window.byteLength)).digest('hex');
 const sourceAck={kind:'cloud-source-playback-started-v1',graphEpoch:graph.graphEpoch,sourceClipId:startup.source.clipId,
  sourceSha256:startup.source.sha256,sourceContextSha256:startup.source.contextSha256,
  sourcePlaybackRevision:startup.source.playbackRevision,sampleRate:44100,playedUntilFrame:1024,
  processedWindowSha256,actual:true,audioStarted:true,participantCredit:false};
 const bad=await request('/api/rooms/'+roomId+'/source/ack',{ack:{...sourceAck,processedWindowSha256:'0'.repeat(64)}},{session:local});
 assert.equal(bad.status,409);
 const sourceReceipt=await request('/api/rooms/'+roomId+'/source/ack',{ack:sourceAck},{session:local});
 assert.equal(sourceReceipt.status,200,JSON.stringify(await sourceReceipt.clone().json()));
 const receipt=await sourceReceipt.json();assert.equal(receipt.accepted,true);assert.equal(receipt.sourceOnly,true);
 assert.equal(receipt.participantCredit,false);assert.equal(receipt.duplicate,false);
 const repeat=await request('/api/rooms/'+roomId+'/source/ack',{ack:sourceAck},{session:local});
 assert.equal(repeat.status,200);assert.equal((await repeat.json()).duplicate,true);
 const current=await native.typedHost.readCurrentSource({roomId});
 assert.equal(current.playback.actual,true);assert.equal(current.sourceStart.receiptSha256,receipt.receiptSha256);
 const ack=await request('/api/rooms/'+roomId+'/cues/ack',{reservationId:'synthetic-reservation',ack:{}},{session:local});
 assert.equal(ack.status,409);assert.equal((await ack.json()).error!==undefined,true);
 assert(f.objects.size>=4);assert.equal(f.calls.native.some(c=>c.path.includes('/v1/models/')&&c.path!=='/v1/models/pricing'),false);
 const denied=await request('/api/rooms/'+roomId+'/source/startup',{serverQC:true},{session:local});
 assert.notEqual(denied.status,200);
 assert.equal((await request('/api/stop',{}, {session:local})).status,200);
 assert.equal((await request('/api/rooms/'+roomId+'/operator/status',{}, {session:local,method:'GET'})).status,401);
 assert.equal((await request('/api/runtime/activate',{}, {session:local})).status,401);
 const before=f.calls.edge.length;f.advance(21*60_000);
 assert.equal((await request('/api/runtime/prepare',{}, {session:local})).status,401);
 assert.equal(f.calls.edge.length,before);
});

test('approval cancellation and absolute expiry leave registration unable to read a key or reach Edge',async t=>{
 const f=await fixture(t,{approval:false});
 await f.host.pairCloud();const cloud=(await (await f.request('/api/pair',{code:f.pairs[1].code},{from:cloudOrigin})).json()).session;
 assert.equal((await f.request('/api/owner/connect',{roomId,ownerCapability:owner},{from:cloudOrigin,session:cloud})).status,200);
 assert.equal((await f.request('/api/runtime/prepare',{}, {session:f.local})).status,200);
 f.approve();const before=f.calls.edge.length;
 assert.equal((await f.request('/api/runtime/activate',{}, {session:f.local})).status,400);
 assert.equal(f.calls.edge.length,before);assert.equal(f.keyReads(),0);
 f.advance(20*60_000);
 assert.equal((await f.request('/api/runtime/status',{}, {session:f.local})).status,401);
 assert.equal((await f.request('/api/runtime/activate',{}, {session:f.local})).status,401);
 assert.equal(f.calls.edge.length,before);assert.equal(f.keyReads(),0);
});

test('paired owner attachment drives the native launcher controller without browser runtime-control calls',async t=>{
 const f=await fixture(t,{orchestrated:true});
 await f.host.pairCloud();const cloud=(await (await f.request('/api/pair',{code:f.pairs[1].code},
  {from:cloudOrigin})).json()).session;
 assert.equal((await f.request('/api/owner/connect',{roomId,ownerCapability:owner},
  {from:cloudOrigin,session:cloud})).status,200);
 const until=async predicate=>{const deadline=Date.now()+5000;
  while(!await predicate()){assert(Date.now()<deadline,'native orchestration fixture timeout');
   await new Promise(resolve=>setTimeout(resolve,25));}};
 await until(()=>f.registered());assert.equal(f.keyReads(),0);f.approve();
 await until(async()=>{const state=await (await f.request('/api/owner/state',{},
  {from:cloudOrigin,session:cloud})).json();return state.nativeBootstrapReady;});
 const response=await f.request('/api/owner/state',{}, {from:cloudOrigin,session:cloud});
 const state=await response.json();assert.equal(response.status,200);assert.equal(state.runtimeActivated,true);
 assert.equal(state.nativeBootstrapReady,true);assert.equal(state.nativeTrialConfigured,false);
 assert.equal(state.generationEnabled,false);
 assert.deepEqual(state.nativeOrchestration,{state:'pending',stage:'operational-approval'});
 assert.equal(f.calls.schedulerStarts,1);assert.equal(f.metadata().prices.length,3);
 assert.equal(f.metadata().balance.usd,2);assert.equal(f.metadata().generationInvoked,false);
 assert.equal(f.calls.client.some(c=>c.path.startsWith('/api/runtime/')),false);
 assert.equal((await f.request('/api/stop',{}, {session:f.local})).status,200);
 const before={reads:f.keyReads(),edge:f.calls.edge.length};
 await new Promise(resolve=>setTimeout(resolve,125));
 assert.deepEqual({reads:f.keyReads(),edge:f.calls.edge.length},before);
});

test('restored companion reaches actual native host/QC/source/AV ports beyond a 30min transport lease with generation still unstarted',
 {skip:process.platform!=='darwin'&&!process.env.VDJ_QC_PYTHON},async t=>{
 const f=await fixture(t,{companion:true,realNativeInspector:true}),options={from:cloudOrigin,session:f.local};
 // The real CPU inspector includes cold Python imports. Poll at a bounded
 // owner-like cadence instead of flooding the signed nonce window while QC runs.
 let state;const deadline=Date.now()+60000;
 do{state=await (await f.request('/api/owner/state',{},options)).json();
  if(!state.nativeBootstrapReady)await new Promise(r=>setTimeout(r,100));
  assert(Date.now()<deadline,JSON.stringify(state));
 }while(!state.nativeBootstrapReady);
 assert.equal(state.runtimeActivated,false,'owner generation controls wait for the pending operational approval');assert.equal(state.nativeTrialConfigured,false);
 assert.equal(f.nativeHost().capabilities().executionPaused,true);assert.equal(f.nativeHost().capabilities().schedulerStarted,false);
 assert.equal(f.calls.confirm,0);assert.equal(f.pairs.length,0);
 assert(f.metadata());assert.equal(f.metadata().generationInvoked,false);
 const caps=await f.request('/api/rooms/'+roomId+'/native/capabilities',{}, {...options,method:'GET'});
 assert.equal(caps.status,200);assert.equal((await caps.json()).cloud.durableScheduler,true);
 const source=await f.request('/api/rooms/'+roomId+'/source/startup',{},options);
 assert.equal(source.status,200,JSON.stringify(await source.clone().json()));const startup=await source.json();assert.equal(startup.source.actual,false);
 const register=await f.request('/api/rooms/'+roomId+'/player/register',{sampleRate:44100,sourceCount:1,consumedFrames:0,receivedFrames:0,contextState:'running'},options);
 assert.equal(register.status,200);const graph=await register.json();assert.equal(graph.graphEpoch,1);
 const native=f.nativeHost(),block=await createProductionPlayerMaterial({enabled:true,roomId,bootstrapAuthority:native.bootstrap,repositoryPorts:native.io.repositoryPorts,assetStore:native.io.privateStore.assetStore}).readVerifiedMaterial({scope:{roomId,sessionId:example_epoch,controlRevision:0},mode:'source'});
 const observed=await f.request('/api/rooms/'+roomId+'/player/observe',{targetPlayerId:graph.targetPlayerId,graphEpoch:graph.graphEpoch,sequence:1,binding:block.binding,sampleRate:44100,
  sourceCount:1,contextState:'running',consumedFrames:1024,receivedFrames:block.queuedFrames,underrunFrames:0,stopped:false,
  windowStartFrame:0,windowPCM:Array.from(block.pcm.subarray(0,512)),video:null},options);
 assert.equal(observed.status,200);
 const pcm=block.pcm.subarray(0,512),processedWindowSha256=createHash('sha256').update(new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength)).digest('hex');
 const ack=await f.request('/api/rooms/'+roomId+'/source/ack',{ack:{kind:'cloud-source-playback-started-v1',graphEpoch:graph.graphEpoch,
  sourceClipId:startup.source.clipId,sourceSha256:startup.source.sha256,sourceContextSha256:startup.source.contextSha256,
  sourcePlaybackRevision:startup.source.playbackRevision,sampleRate:44100,playedUntilFrame:1024,processedWindowSha256,
  actual:true,audioStarted:true,participantCredit:false}},options);
 assert.equal(ack.status,200);const receipt=await ack.json();assert.equal(receipt.sourceOnly,true);assert.equal(receipt.participantCredit,false);
 f.advance(31*60000);
 assert.equal((await f.request('/api/owner/state',{},options)).status,401,'old browser credential expires without ending native host');
 const resumed=await f.request('/api/companion/connect',{roomId,ownerCapability:owner},{from:cloudOrigin});assert.equal(resumed.status,200);
 const next={from:cloudOrigin,session:(await resumed.json()).session};assert.equal(f.nativeHost(),native);
 assert.equal((await f.request('/api/rooms/'+roomId+'/native/capabilities',{}, {...next,method:'GET'})).status,200);
 assert.equal(f.nativeHost().capabilities().executionPaused,true);assert.equal(f.nativeHost().capabilities().schedulerStarted,false);
 assert.equal((await f.request('/api/rooms/'+roomId+'/jobs/advance',{},next)).status,409);
 assert.equal(f.calls.schedulerStarts,1);assert.equal(f.calls.native.some(c=>c.path.includes('/v1/models/')&&c.path!=='/v1/models/pricing'),false);
 assert.equal(f.calls.client.some(c=>c.path.endsWith('/jobs/start')||c.path.endsWith('/operator/trial/start')),false);
});
