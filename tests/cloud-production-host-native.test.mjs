import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MessageChannel} from 'node:worker_threads';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createProductionNativeHost} from '../cloud/worker/production-host.mjs';
import {PRIVATE_BUCKET_TARGET} from '../cloud/worker/supabase-private-store.mjs';
import {syntheticWave,fixtureSha,syntheticReference} from './cloud-worker-fixture.mjs';
import {createCloudPlaybackChannel} from '../room-web/cloud-output-bridge.mjs';
import {createBrowserPlayerObserver} from '../room-web/playback/player-observer.mjs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {prepareCloudInitialAudio} from '../room-web/cloud-initial-audio.mjs';
import {GENERATION_CONTRACT,generationIdentity} from '../cloud/generation/dispatch.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {operationBinding} from '../cloud/generation/cue-contract.mjs';
import {verifyClipRelativeRender} from '../room-web/playback/clip-timeline.mjs';
import {createProductionPlayerMaterial} from '../cloud/worker/player-material.mjs';
import {createOperatorSourceSigner} from '../cloud/worker/operator-source-adapters.mjs';
import {validatePermit} from '../cloud/generation/dispatch.mjs';
import {createOperatorPlanStore,OPERATOR_STATE_SQL} from '../cloud/jobs/operator-store.mjs';
import {exerciseRealTimeSource} from './real-time-source-start.mjs';
import {decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
const run=promisify(execFile);

const RATE=44100,OWNER='a'.repeat(64),ORIGIN='https://ai-vdj.vercel.app',PROJECT='https://example.supabase.co';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
// This test executes the production factory and actual native CPU inspectors.
// PostgreSQL, REST, owner proof and browser hardware are synthetic/offline.
// Provider SDK, provider network, paid generation and ambient credentials are forbidden.
test(process.env.VDJ_REALISTIC_INITIAL_ACK==='1'?'real-time initial audio, observer and ACK through the production native factory':
 'production native factory restores bootstrap/restart and generated CURRENT through leased QC, durable records and HTTP manifest/observer',
 {skip:!process.env.VDJ_QC_PYTHON,timeout:process.env.VDJ_REALISTIC_INITIAL_ACK==='1'?180000:120000},async t=>{
 const db=new PGlite(),objects=new Map(),calls=[],sql=[],graphs=[],providerAssets=new Map(),rpcErrors=[],httpErrors=[],diagnostics=[];let host,restored,pools=0,providerCalls=0,directory;
 let clock=Date.now()-35000;const fakeVideo={assetId:null,sha256:null,presentedFrames:1,mediaTime:0,width:1280,height:720,muted:true,volume:0};
 let realTime=false,latencyMs=0,ioQueue=Promise.resolve(),rejectPostObservationProjection=false,observationCasCommitted=false;
 const remoteTurn=()=>{if(!latencyMs)return Promise.resolve();const pending=ioQueue.then(()=>new Promise(r=>setTimeout(r,latencyMs)));ioQueue=pending;return pending;};
 // PGlite is one connection: isolate complete transaction lifetimes when the
 // realistic browser observer and ACK run concurrently, like separate PG clients.
 let databaseGate=Promise.resolve();
 const acquireDatabase=async()=>{const prior=databaseGate;let unlock;const held=new Promise(r=>{unlock=r;});databaseGate=prior.then(()=>held);await prior;return unlock;};
 t.after(async()=>{if(httpErrors.length)t.diagnostic(JSON.stringify({httpErrors,rpcErrors}));for(const graph of graphs)await graph.close();await restored?.close();await host?.close();await db.close();if(directory)await rm(directory,{recursive:true,force:true});});
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql',
   'cloud/jobs/player-observer-state.sql','cloud/jobs/durable-scheduler.sql','cloud/jobs/operator-state.sql'])
   {const source=await readFile(new URL('../'+file,import.meta.url),'utf8');
    // Only this offline receipt clock follows the deliberately skewed VM.
    // Room/reservation PostgreSQL clocks remain real; standalone journal tests
    // exercise the unmodified production clock and its expiry/freshness gates.
    await db.exec(file.endsWith('player-observer-state.sql')?source.replace('clock_ms:=extract(epoch from clock_timestamp())*1000;',
      "clock_ms:=current_setting('vdj.synthetic_receipt_clock_ms')::double precision;"):source);}
 const uid='11111111-1111-4111-a111-111111111111';await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);
 const room=(await db.query("select public.vdj_room_request('create',null,null,$1::jsonb,$2) value",
  [JSON.stringify({ownerCapability:OWNER,joinCode:'c'.repeat(64)}),uid])).rows[0].value;
 const fetchImpl=async(url,options)=>{
  const parsed=new URL(url);
  if(parsed.origin==='https://v3.fal.media'){
   const asset=providerAssets.get(parsed.pathname);assert(asset,'only explicitly fabricated provider GET bytes');
   assert.equal(options.method,'GET');return new Response(asset.bytes,{headers:{'content-type':asset.mime,'content-length':String(asset.bytes.length)}});
  }
  assert.equal(parsed.origin,PROJECT,'no external/provider transport');const path=parsed.pathname;
  await remoteTurn();
  calls.push({path,method:options.method});
  if(path==='/rest/v1/rpc/vdj_generation_request'){
   if(rejectPostObservationProjection&&observationCasCommitted)throw Error('SYNTHETIC_POST_OBSERVATION_PROJECTION_FAILED');
   assert.equal(options.method,'POST');assert.equal(options.headers.get('content-profile'),'public');const body=JSON.parse(options.body);
   const unlock=realTime?await acquireDatabase():()=>{};
   try {const result=await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
     [body.op,body.room_id,body.capability,JSON.stringify(body.payload)]);return Response.json(result.rows[0].value);}
   catch(error){rpcErrors.push({op:body.op,code:error.message});return Response.json({message:error.message},{status:400});}
   finally{unlock();}
  }
  if(path==='/storage/v1/bucket/'+PRIVATE_BUCKET_TARGET)return Response.json({id:PRIVATE_BUCKET_TARGET,public:false,
   file_size_limit:32*1024*1024,allowed_mime_types:['audio/wav','video/mp4','image/png','image/jpeg','application/json']});
  const get='/storage/v1/object/authenticated/'+PRIVATE_BUCKET_TARGET+'/',put='/storage/v1/object/'+PRIVATE_BUCKET_TARGET+'/';
  if(options.method==='GET'&&path.startsWith(get)){
   const object=objects.get(path.slice(get.length));return object?new Response(object.bytes.slice(),{headers:{'content-type':object.mime,
    'content-length':String(object.bytes.length)}}):Response.json({code:'NoSuchKey'},{status:404});
  }
  if(options.method==='POST'&&path.startsWith(put)){
   assert.equal(options.headers.get('x-upsert'),'false');const key=path.slice(put.length);
   if(objects.has(key))return Response.json({code:'KeyAlreadyExists'},{status:409});
   objects.set(key,{bytes:Uint8Array.from(options.body),mime:options.headers.get('content-type')});return Response.json({Key:PRIVATE_BUCKET_TARGET+'/'+key});
  }
  assert.fail('unexpected synthetic production route');
 };
 const createPool=policy=>{pools++;return {options:policy,on(){},async end(){},async connect(){const unlock=realTime?await acquireDatabase():()=>{};return {release:destroy=>{
  // Destroying a real pg client rolls back its failed transaction. PGlite has
  // one physical connection, so finish that rollback before releasing its gate.
  if(destroy&&realTime)void db.exec('ROLLBACK').finally(unlock);else unlock();},
  async query({text,values}){sql.push(text);if(/^select/i.test(text.trim()))await remoteTurn();
   if(text.includes('vdj_internal.player_observer_state')&&values?.[0]==='sourceReceiptPut')
    await db.query("select set_config('vdj.synthetic_receipt_clock_ms',$1,false)",[String(realTime?Date.now():clock)]);
   const result=await db.query(text,values);
   if(rejectPostObservationProjection&&text.includes('vdj_internal.player_observer_state')&&values?.[0]==='cas')observationCasCommitted=true;
   return result;}};}};};
 const bytes=syntheticWave(24),reference=syntheticReference();
 const options={enabled:true,roomId:room.roomId,projectURL:PROJECT,origin:ORIGIN,createPool,fetchImpl,now:()=>realTime?Date.now():clock,
  onDiagnostic:event=>diagnostics.push(event),
  withPlatformHeaders:async(_scope,invoke)=>invoke(new Headers({authorization:'example_synthetic_placeholder',apikey:'example_synthetic_placeholder'})),
  withOwnerAuthorization:async(scope,invoke)=>invoke({...scope,ownerCapability:OWNER}),
  credentialForOperation:()=>{providerCalls++;assert.fail('no provider credentials required by startup');},
  loadSDK:()=>{providerCalls++;assert.fail('no provider SDK calls');},
  runtime:{python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'},
  // This harness shares one physical PGlite connection without a lock unless
  // realTime; concurrent background pair preparation would interleave its own
  // transactions with the leased job's. Its module/worker paths are covered by
  // pair-preparation and cloud-worker-native tests.
  preparePairsAhead:false,
  bootstrapConfiguration:{},operatorConfiguration:{enabled:true,ownerBootstrapVideoApproved:true,
   approvals:{media:true},verifySavedVideo:async()=>null}};
 host=createProductionNativeHost(options);
 assert.equal(objects.size,0);assert.equal((await db.query('select count(*) n from vdj_internal.generation_operations')).rows[0].n,0);
 const scope=await host.io.repositoryPorts.readScope({roomId:room.roomId});
 const post=async(path,body={},target=host)=>{
  const response=await target.handleRequest(new Request(ORIGIN+`/api/rooms/${room.roomId}/`+path,{method:'POST',
   headers:{origin:ORIGIN,'x-room-owner':OWNER,'content-type':'application/json'},body:JSON.stringify(body)}));
  const value=await response.json();if(response.status!==200)httpErrors.push({path,status:response.status,error:value.error});assert.equal(response.status,200,JSON.stringify({path,value}));return value;
 };
 async function upload(role,asset,mimeType,referenceSha256=null){
  const {uploadId}=await post('operator/media/begin',{role,mimeType,byteLength:asset.length,sha256:fixtureSha(asset),referenceSha256,consent:true});
  for(let offset=0;offset<asset.length;offset+=32768)await post('operator/media/chunk',{uploadId,offset,data:Buffer.from(asset.subarray(offset,offset+32768)).toString('base64')});
  return (await post('operator/media/finish',{uploadId})).asset;
 }
 const [seedSelection,referenceSelection]=[await upload('seed',bytes,'audio/wav'),await upload('reference',reference,'image/png')];
 assert.equal(host.bootstrapReady,true);
 const admitted=await host.bootstrap.readAdmittedAuthority(scope);
 assert.equal(admitted.source.music.sha256,fixtureSha(bytes));
 await assert.rejects(host.bootstrap.readAdmittedAuthority({...scope,controlRevision:scope.controlRevision+1}),/SCOPE_CHANGED/);
 await assert.rejects(host.bootstrap.readAdmittedAuthority({...scope,expiresAtMs:scope.expiresAtMs+1}),/SCOPE_CHANGED/);
 if(process.env.VDJ_REALISTIC_INITIAL_ACK==='1'){
  // The delayed happy path deliberately requires ACK success. Keep this replay
  // failing while the production freshness/latency gap remains unresolved.
  realTime=true;
  for(const scenario of [
   {name:'real-worklet-normal-order',bindingMs:0,observeMs:0,telemetryDelayMs:0,latency:0,accepted:true},
   {name:'recorded-round-trips-delayed-telemetry',bindingMs:3900,observeMs:4900,telemetryDelayMs:80,latency:110,accepted:true},
   {name:'stop-during-ack',bindingMs:500,observeMs:500,telemetryDelayMs:80,latency:40,stopDuringAck:true,accepted:false}
  ].filter(s=>!process.env.VDJ_REALISTIC_CASE||s.name===process.env.VDJ_REALISTIC_CASE)){
   latencyMs=scenario.latency;
   const result=await exerciseRealTimeSource({host,roomId:room.roomId,...scenario});
   t.diagnostic(JSON.stringify({scenario:scenario.name,...result,events:result.events.filter(e=>e.kind!=='telemetry'),diagnostics}));
   assert.equal(result.accepted,scenario.accepted,scenario.name);
   if(scenario.stopDuringAck)assert.equal(result.lifecycle.lateAckAccepted,false,'stopped graph cannot accept a late source ACK');
   if(scenario.accepted)assert(result.observations>=1);
   assert.equal(providerCalls,0);
   const release=await acquireDatabase();
   try{assert.equal((await db.query('select count(*) n from vdj_internal.generation_operations')).rows[0].n,0);}finally{release();}
  }
  return;
 }
 async function startGraph(target){
  let Processor,state='running';const enginePorts=new MessageChannel(),ownerPorts=new MessageChannel();
  const sandbox={Float32Array,ArrayBuffer,sampleRate:RATE,currentTime:0,
   AudioWorkletProcessor:class{constructor(){this.port={postMessage:data=>enginePorts.port2.postMessage(data)};}},
   registerProcessor:(_name,p)=>{Processor=p;}};
  vm.runInNewContext(await readFile(new URL('../snapshot/app/room-worklet.mjs',import.meta.url),'utf8'),sandbox);
  const processor=new Processor();enginePorts.port2.addEventListener('message',event=>processor.message(event.data));enginePorts.port2.start();
  const engine=createWorkletPlaybackEngine({context:{sampleRate:RATE,get state(){return state;}},node:{port:enginePorts.port1},readSourceCount:()=>1,
   stopAudio:async()=>{state='suspended';},loadVerifiedRender:async input=>{assert(input.render,'exact native render supplied by this offline test');return input.render;},
   allowInitialAudio:true,enableClipRelativeTimeline:true});
  const server=createCloudPlaybackChannel({port:ownerPorts.port1,handle:async(type,data)=>{
   assert.equal(type,'playerObserver');return post('player/'+data.command,data.body,target);}});
  const client=createCloudPlaybackChannel({port:ownerPorts.port2,handle:()=>assert.fail('no output commands in this test')});
  const observer=createBrowserPlayerObserver({enabled:true,intervalMs:1000,transport:(command,body)=>client.call('playerObserver',{command,body}),
   readEngine:engine.readObservationState,subscribe:engine.subscribe,requestWindow:engine.requestObservationWindow,readVideo:()=>null});
  let closed=false;const graph={observer,engine,async close(){if(closed)return;closed=true;observer.close();server.close();client.close();enginePorts.port1.close();enginePorts.port2.close();}};graphs.push(graph);
  const selected=await observer.register(),startup=await post('source/startup',{},target);
  const response=await target.handleRequest(new Request(ORIGIN+`/api/rooms/${room.roomId}/media/${startup.descriptor.assetId}?sha256=${startup.descriptor.sha256}`,
   {headers:{origin:ORIGIN,'x-room-owner':OWNER}}));assert.equal(response.status,200);
  const asset=new Uint8Array(await response.arrayBuffer());assert.equal(fixtureSha(asset),startup.descriptor.sha256);
  const plan=await prepareCloudInitialAudio({bytes:asset,descriptor:startup.descriptor,source:startup.source,mode:'bootstrap',
   graphEpoch:selected.graphEpoch,previousGraphStopped:selected.mode==='restart'});
  await engine.primeSeed(plan);for(let i=0;i<5;i++)await turn();
  for(let i=0;i<90;i++){processor.process([],[ [new Float32Array(128),new Float32Array(128)] ]);sandbox.currentTime+=128/RATE;}
  for(let i=0;i<5;i++)await turn();const observed=await observer.sample();assert.equal(observed.accepted,true);
  const ack={kind:'cloud-source-playback-started-v1',graphEpoch:selected.graphEpoch,sourceClipId:plan.sourceClipId,
   sourceSha256:plan.sourceSha256,sourceContextSha256:plan.sourceContextSha256,sourcePlaybackRevision:plan.sourcePlaybackRevision,
   sampleRate:RATE,playedUntilFrame:engine.readObservationState().consumedFrames,processedWindowSha256:plan.expectedProcessedWindowSha256,
   actual:true,audioStarted:true,participantCredit:false};
  const receipt=await post('source/ack',{ack},target);assert.equal(receipt.sourceOnly,true);assert.equal(receipt.participantCredit,false);
  await engine.recordActualSource({plan,ack});return {...graph,selected,receipt,ack,processor,
    async pump(blocks){for(let i=0;i<blocks;i++){processor.process([],[ [new Float32Array(128),new Float32Array(128)] ]);sandbox.currentTime+=128/RATE;}for(let i=0;i<5;i++)await turn();},
    pauseObserver(){observer.close();}};
 }
 const first=await startGraph(host);assert.equal(first.selected.graphEpoch,1);
 assert.equal(calls.filter(c=>c.path.includes('/source-start-receipts/')).length,0,
  'the running finite source does not wait for Storage receipt reads or writes');
 const initial=await host.typedHost.readCurrentSource({roomId:room.roomId});assert.equal(initial.playback.actual,true);assert.equal(initial.playback.revision,0);
 assert.equal((await db.query('select count(*) n from vdj_internal.generation_operations')).rows[0].n,0,
  'uploaded source startup and genuine VM prefix ACK need no prior generation');
 // Later Stop/restart require an existing generation anchor. The fabricated
 // bookkeeping below is added only after the empty-room initial source ACK.
 const permitId='synthetic_anchor_permit_000000000000',operationId='synthetic_anchor_operation_00000000';
 await db.query('insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document) values($1,$2,$3,$4,to_timestamp($5::numeric/1000),$6::jsonb)',
  [permitId,scope.roomId,scope.sessionId,scope.controlRevision,scope.expiresAtMs,JSON.stringify({kind:'synthetic-anchor-only'})]);
 await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
  [operationId,permitId,scope.roomId,JSON.stringify({operationId,roomRuntime:{currentCredit:null,servedCounts:{},acks:[],stopped:false}})]);
 // Real native profile/private bootstrap record and observed VM source frontier;
 // only signed URL delivery is synthetic. No provider, credentials or live SQL.
 let sourceSigns=0;
 const sourceSigner=createOperatorSourceSigner({enabled:true,now:()=>clock,
  privateStore:{...host.io.privateStore,assetStore:{...host.io.privateStore.assetStore,
   sign:async ({assetId,sha256})=>{sourceSigns++;return {assetId,sha256,url:PROJECT+'/private/synthetic',private:true,checksumVerified:true,expiresAtMs:clock+60000};}}},
  readScope:host.io.repositoryPorts.readScope,readCurrentSource:host.typedHost.readCurrentSource,
  readBootstrapAuthority:host.bootstrap.readStartAuthority,bootstrapConfiguration:options.bootstrapConfiguration});
 const signed=await sourceSigner({...scope,source:initial,expiresAtMs:Math.floor((clock+50000)/1000)*1000});
 assert.equal(sourceSigns,2);assert.equal(signed.context.providerOriginVerified,false);
 const initialPermit={permitId:'synthetic_owner_permit_00000000000',kind:GENERATION_CONTRACT.version,createdAtMs:clock,expiresAtMs:Math.floor((clock+50000)/1000)*1000,
  maximumUsd:.5,counts:GENERATION_CONTRACT.counts,source:initial,sourceSha256:cueDigest(cueSourceIdentity(initial)),assets:signed,
  quote:{verified:true,evidenceSha256:'e'.repeat(64),observedAtMs:clock,maximumUsd:{intent:.01,music:.05,video:.4}},balance:{usd:2,autoTopUp:false,observedAtMs:clock}};
 assert.equal(validatePermit(initialPermit,{now:()=>clock,mediaHost:new URL(PROJECT).hostname}),initialPermit);
 const stop=await post('cues/stop');assert.equal(stop.stopped,true);await first.engine.stop();await first.observer.stop();await first.close();
 await assert.rejects(host.typedHost.readCurrentSource({roomId:room.roomId}),/STOPPED/);
 let restarted=await startGraph(host);assert.equal(restarted.selected.mode,'restart');assert.equal(restarted.selected.graphEpoch,2);
 assert.notEqual(restarted.selected.targetPlayerId,first.selected.targetPlayerId);
 await assert.rejects(host.typedHost.readCurrentSource({roomId:room.roomId}),/STOPPED/);
 const start=await post('cues/start');assert.equal(start.stopped,false);
 assert.equal((await host.typedHost.readCurrentSource({roomId:room.roomId})).playback.actual,true);
 restored=createProductionNativeHost(options);
 const recovered=await restored.typedHost.readCurrentSource({roomId:room.roomId});assert.equal(recovered.playback.actual,true);
 assert.equal(recovered.sourceStart.graphEpoch,2);assert.equal(recovered.music.sha256,fixtureSha(bytes));
 const playback=await restored.io.repositoryPorts.readPlaybackState({roomId:room.roomId});assert.equal(playback.stopped,false);
 assert.equal(playback.currentCredit,null);assert.deepEqual(playback.servedCounts,{});
 assert.equal(providerCalls,0);assert(pools>=2);assert(sql.some(s=>s==='BEGIN TRANSACTION READ WRITE'));
 assert(sql.some(s=>s.includes('vdj_internal.player_observer_state')));assert(calls.some(c=>c.path.endsWith('/vdj_generation_request')));
 assert.equal(restored.capabilities().actualApiVerified,false);assert.equal(restored.capabilities().liveAVVerified,false);
 // Continue through the real production jobs/native/coordinator, using only
 // fabricated completed provider ledger rows and physical synthetic results.
 // The accepted visual edit covers 5 + 19 seconds without loops or new POSTs.
 await restored.close();restored=null;restarted.pauseObserver();
 directory=await mkdtemp(path.join(tmpdir(),'vdj-production-host-native-'));
 const encode=async(seconds,name)=>{const target=path.join(directory,name);await run(options.runtime.ffmpeg,
  ['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=4','-t',String(seconds),'-c:v','libx264','-pix_fmt','yuv420p','-an',target]);return readFile(target);};
 const [generatedVideo,priorVideo]=await Promise.all([encode(5,'generated.mp4'),encode(19,'prior.mp4')]);
 providerAssets.set('/synthetic-production.wav',{bytes:syntheticWave(40),mime:'audio/wav'});
 providerAssets.set('/synthetic-production.mp4',{bytes:generatedVideo,mime:'video/mp4'});
 const generatedOperation='synthetic_production_operation_11111111',generatedPermit='synthetic_production_permit_111111111';
 const submission=(await db.query("select public.vdj_room_request('submit',$1,$2,$3::jsonb,null) value",
  [room.roomId,OWNER,JSON.stringify({nonce:'synthetic_submission_nonce_1111111111',nickname:'合成確認',prompt:'静かな光を広げる'})])).rows[0].value;
 const source=await host.typedHost.readCurrentSource({roomId:room.roomId}),identity=generationIdentity(generatedOperation);
 const permit={permitId:generatedPermit,kind:GENERATION_CONTRACT.version,counts:GENERATION_CONTRACT.counts,createdAtMs:clock,expiresAtMs:clock+600000,
  connectionId:'synthetic-reviewed-connection',maximumUsd:.5,source,sourceSha256:cueDigest(cueSourceIdentity(source)),visualPolicy:TECHNICAL_VISUAL_POLICY,
  quote:{verified:true,evidenceSha256:'1'.repeat(64),observedAtMs:clock,maximumUsd:{intent:.01,music:.05,video:.4}},
  balance:{usd:2,autoTopUp:false,observedAtMs:clock},assets:{context:{url:PROJECT+'/private/context',private:true,checksumVerified:true,
   sha256:source.music.contextSha256,expiresAtMs:clock+660000,serverAudioQC:true,providerOriginVerified:true},
   reference:{url:PROJECT+'/private/reference',private:true,checksumVerified:true,sha256:source.video.referenceSha256,expiresAtMs:clock+660000}}};
 const op={roomId:room.roomId,operationId:generatedOperation,submissionId:submission.submissionId,stopped:false,permit,
  plan:{status:'COMPILED',commonIntentSha256:'f'.repeat(64),common:{cueId:identity.cueId,control:source.music.control}},
  stages:{intent:{state:'COMPLETE',signature:'a'.repeat(64),requestId:'synthetic-intent-complete',result:{synthetic:true}},
   music:{state:'COMPLETE',signature:'b'.repeat(64),requestId:'synthetic-music-complete',result:{url:'https://v3.fal.media/synthetic-production.wav',contentType:'audio/wav',providerObserved:true,resultSha256:'b'.repeat(64)}},
   video:{state:'COMPLETE',signature:'c'.repeat(64),requestId:'synthetic-video-complete',result:{url:'https://v3.fal.media/synthetic-production.mp4',contentType:'video/mp4',providerObserved:true,resultSha256:'d'.repeat(64)}}}};
 await db.query('insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document) values($1,$2,$3,$4,to_timestamp($5::numeric/1000),$6::jsonb)',
  [generatedPermit,scope.roomId,scope.sessionId,scope.controlRevision,permit.expiresAtMs,JSON.stringify(permit)]);
 await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
  [generatedOperation,generatedPermit,room.roomId,JSON.stringify(op)]);
 const videoSelection=await upload('saved-video',priorVideo,'video/mp4',source.video.referenceSha256);
 await assert.rejects(host.jobs.advance({roomId:room.roomId,operationId:generatedOperation,ownerCapability:OWNER}),/OPERATOR_PLAN_CHANGED/,
  'an uploaded clip alone cannot authorize an accepted edit for an unbound operation');
 const planStore=createOperatorPlanStore({query:host.io.repository.privateStateQuery,
  withOwnerAuthorization:async(scope,invoke)=>invoke({...scope,ownerCapability:OWNER})});
 const plan={...scope,planId:'synthetic-frozen-operator-plan',phase:'REVIEW',participants:2,priorPlanId:null,
  connectionId:'synthetic-reviewed-connection',assets:[seedSelection,referenceSelection,videoSelection],sourceSha256:cueDigest(cueSourceIdentity(source)),
  expiresAtMs:clock+600000,maximumCents:100,operations:[{operationId:generatedOperation,permitId:generatedPermit,
   submissionId:submission.submissionId,participantId:submission.participantId,
   permit:Object.fromEntries(Object.entries(permit).filter(([key])=>key!=='assets'))},
   {operationId:'synthetic-unused-operation',participantId:'synthetic-unused-participant'}]};
 // This is a fabricated reviewed/claimed plan for a completed provider ledger;
 // no production permit insertion, payment, provider request or key is used.
 await planStore.save(plan);await planStore.claim({...scope,planId:plan.planId});
 await planStore.record({...scope,planId:plan.planId,phase:'STARTED'});
 const stateArgs=['read',scope.roomId,OWNER,scope.sessionId,scope.controlRevision,null,null];
 const frozen=(await host.io.repository.privateStateQuery(OPERATOR_STATE_SQL,stateArgs)).rows[0].value,
  unrelated=structuredClone(frozen.record);
 unrelated.plans[plan.planId].operations[0].permitId='synthetic-unrelated-permit';
 await host.io.repository.privateStateQuery(OPERATOR_STATE_SQL,['cas',scope.roomId,OWNER,scope.sessionId,scope.controlRevision,
  frozen.version,JSON.stringify(unrelated)]);
 await assert.rejects(host.jobs.advance({roomId:room.roomId,operationId:generatedOperation,ownerCapability:OWNER}),/OPERATOR_PLAN_CHANGED/,
  'frozen plan must bind exact operation permit, not merely operation ID');
 const mismatched=(await host.io.repository.privateStateQuery(OPERATOR_STATE_SQL,stateArgs)).rows[0].value;
 await host.io.repository.privateStateQuery(OPERATOR_STATE_SQL,['cas',scope.roomId,OWNER,scope.sessionId,scope.controlRevision,
  mismatched.version,JSON.stringify(frozen.record)]);
 await host.close();host=createProductionNativeHost(options);
 const wake=await post('jobs/advance',{operationId:generatedOperation});assert.equal(wake.state,'WAIT_QC');
 const beforeLease=await host.io.repositoryPorts.readAuthoritativeOperation({roomId:room.roomId,operationId:generatedOperation});
 assert.equal(beforeLease.cue,undefined,'HTTP wake does not inspect/publish');
 const leased=await host.scheduler.runOnce({roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision});
 assert.equal(leased.status,'DONE',JSON.stringify(leased));assert.equal(leased.outcome,'complete');
 const result=await host.jobs.read({roomId:room.roomId,operationId:generatedOperation,ownerCapability:OWNER});
 assert.equal(result.state,'READY',JSON.stringify(result));
 const preload=await post('playback/preload');assert.equal(preload.roomId,room.roomId);assert.equal(preload.assets.length,4);
 assert.deepEqual(preload.assets.map(a=>a.mimeType).sort(),['audio/wav','audio/wav','video/mp4','video/mp4']);
 assert.equal(new Set(preload.assets.map(a=>a.assetId)).size,4,'original/endpoint renders and both video clips remain distinct');
 assert(preload.assets.some(a=>a.assetId.startsWith('pair-render-')),'measured endpoint bytes preload before finite audio');
 assert(preload.assets.every(a=>Object.keys(a).length===4&&a.byteLength>0&&['audio/wav','video/mp4'].includes(a.mimeType)));
 assert.equal((await host.io.repositoryPorts.readRoomRuntime(scope)).currentCredit,null,'static preload grants no actual credit');
 // A deliberately skewed synthetic CPU clock proves the actual PostgreSQL
 // expiry guard instead of letting a faster laptop hide it. Native QC pauses
 // this VM; it does not measure a continuously running browser or model speed.
 const expired=await host.handleRequest(new Request(ORIGIN+`/api/rooms/${room.roomId}/cues/reserve`,{method:'POST',
  headers:{origin:ORIGIN,'x-room-owner':OWNER,'content-type':'application/json'},body:'{}'}));
 assert.equal(expired.status,409);assert(rpcErrors.some(e=>e.op==='cueReserve'&&e.code==='BOUND_PLAYBACK_PLAN_REQUIRED'));
 // Start a fresh verified graph after offline CPU preparation. Do not enlarge
 // either the graph lease,24s source or30s playback reservation to pass CI.
 await post('cues/stop');await restarted.engine.stop();
 // This host was reconstructed during QC. Use the current fixed HTTP ingress,
 // not the old in-process fixture object captured by its closed MessagePort.
 await post('player/stop',{targetPlayerId:restarted.selected.targetPlayerId,graphEpoch:restarted.selected.graphEpoch});
 await restarted.close();
 clock=Date.now();restarted=await startGraph(host);assert.equal(restarted.selected.graphEpoch,3);
 await post('cues/start');restarted.pauseObserver();
 const reservation=await post('cues/reserve');assert.equal(reservation.cue.operationId,generatedOperation);
 assert.deepEqual(reservation.cue.video.timeline.segments.map(s=>[s.startSeconds,s.endSeconds]),[[0,5],[5,24]]);
 const cue=reservation.cue;
 let pendingClock=Date.now();
 const pendingMaterial=createProductionPlayerMaterial({enabled:true,roomId:room.roomId,bootstrapAuthority:host.bootstrap,now:()=>pendingClock,
  repositoryPorts:host.io.repositoryPorts,assetStore:host.io.privateStore.assetStore});t.after(()=>pendingMaterial.close());
 const pendingScope={roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision};
 const pendingPCM=await pendingMaterial.readVerifiedMaterial({scope:pendingScope,mode:'source'});
 assert.equal(pendingPCM.acceptedPrefixFrames,24*RATE);
 assert.deepEqual(pendingPCM.installedPrefixPCM,decodeCompleteWave(bytes).pcm,'pending render preserves the actual pre-install seed');
 const pendingInput={scope:pendingScope,mode:'source',expiresAtMs:scope.expiresAtMs,
  playback:await host.io.repositoryPorts.readPlaybackState(pendingScope),runtime:await host.io.repositoryPorts.readRoomRuntime(pendingScope)};
 const cachedPending=pendingMaterial.readSourceSnapshot(pendingInput);assert(cachedPending);
 const {readObserverMaterial}=pendingMaterial;
 assert.deepEqual((await readObserverMaterial(pendingInput)).installedPrefixPCM,pendingPCM.installedPrefixPCM,
  'the unbound observer port reuses exact snapshot bytes after its own atomic read');
 cachedPending.installedPrefixPCM[0]=.9;
 assert.notEqual(pendingMaterial.readSourceSnapshot(pendingInput).installedPrefixPCM[0],.9);
 assert.equal(pendingMaterial.readSourceSnapshot({...pendingInput,runtime:{...pendingInput.runtime,pending:null}}),null);
 assert.equal(pendingMaterial.readSourceSnapshot({...pendingInput,playback:{...pendingInput.playback,stopped:true}}),null);
 pendingClock=pendingInput.runtime.pending.expiresAtMs;
 assert.equal(pendingMaterial.readSourceSnapshot(pendingInput),null,'expired reservation cannot reuse immutable pending bytes');
 const manifest=await post('cloud/media/resolve',{roomId:room.roomId,cueId:cue.cueId,generationId:cue.generationId,submissionId:cue.submissionId,
  controlVersion:cue.controlVersion,commonIntentSha256:cue.commonIntentSha256,music:cue.music.asset,
  videos:cue.video.clips.map(({assetId,sha256})=>({assetId,sha256})),plan:reservation.plan});
 assert.equal(manifest.audio.render.timelineSpace,'clip-relative-v1');
 const supplied=manifest.videos.find(v=>v.assetId===videoSelection.assetId),generated=manifest.videos.find(v=>v.assetId!==videoSelection.assetId);
 assert.equal(supplied.source,'owner-supplied-bootstrap-video');assert.equal(supplied.requestId,undefined);
 assert.deepEqual(Object.keys(supplied).sort(),['admissionEvidenceSha256','admissionId','assetId','byteLength','mimeType','sha256','source']);
 assert.equal(generated.source,'provider-response-replay');assert.equal(generated.requestId,'synthetic-video-complete');
 const nativeRender=await host.worker.resolveRender({roomId:room.roomId,cue:reservation.cue,plan:reservation.plan,expectedRevision:reservation.expectedRevision});
 const render=await verifyClipRelativeRender({...nativeRender,timelineSpace:'clip-relative-v1'});
 // Bind actual engine preparation to the same verified native render. The
 // engine instance keeps its seed/clip binding; no second graph is created.
 const input={roomId:room.roomId,cue:reservation.cue,plan:reservation.plan,expectedRevision:reservation.expectedRevision};
 const raw=restarted.engine;
 let measuredWindow=null;const unsubscribeWindow=raw.subscribe(event=>{
   if(event.playedWindow?.pcm instanceof ArrayBuffer)measuredWindow={startFrame:event.playedWindow.startFrame,pcm:new Float32Array(event.playedWindow.pcm.slice(0))};
 });t.after(unsubscribeWindow);
 const prepared=await raw.prepare({...input,render});
 const mapped=await raw.mapVerifiedRender(prepared);await raw.commit(mapped);for(let i=0;i<5;i++)await turn();
 clock+=24000;await restarted.pump(Math.ceil((mapped.startFrame+12000-restarted.processor.consumed)/128));
 const ack={roomId:room.roomId,cueId:reservation.cue.cueId,clipId:reservation.cue.music.asset.assetId,playbackRevision:reservation.expectedRevision,
  audioTime:restarted.processor.consumed/RATE,actual:true,audioStarted:true,videoPresented:true};
 await raw.recordActualCue({prepared:mapped,ack});const accepted=await post('cues/ack',{reservationId:reservation.reservationId,ack});assert.equal(accepted.accepted,true);
 const material=createProductionPlayerMaterial({enabled:true,roomId:room.roomId,bootstrapAuthority:host.bootstrap,
  repositoryPorts:host.io.repositoryPorts,assetStore:host.io.privateStore.assetStore});
 const currentMaterial=await material.readVerifiedMaterial({scope:{roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision},mode:'current'});
 assert.equal(currentMaterial.binding.assetId,reservation.cue.music.asset.assetId);assert.equal(currentMaterial.originFrame,mapped.startFrame);
 const currentIdentity={roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision};
 const currentInput={scope:currentIdentity,
  expiresAtMs:scope.expiresAtMs,mode:'current',playback:await host.io.repositoryPorts.readPlaybackState(currentIdentity),
  runtime:await host.io.repositoryPorts.readRoomRuntime(currentIdentity)};
 const immutableCurrent=material.readSourceSnapshot(currentInput);assert(immutableCurrent);
 immutableCurrent.pcm[0]=.9;assert.notEqual(material.readSourceSnapshot(currentInput).pcm[0],.9);
 for(const changed of [{...currentInput,playback:{...currentInput.playback,stopped:true}},
  {...currentInput,playback:{...currentInput.playback,currentCredit:null}},
  {...currentInput,runtime:{...currentInput.runtime,acks:[]}},
  {...currentInput,scope:{...currentInput.scope,controlRevision:scope.controlRevision+1}}])
  assert.equal(material.readSourceSnapshot(changed),null,'changed live authority cannot reuse a current PCM cache hit');
 const record=(await host.io.repository.privateStateQuery('select vdj_internal.player_observer_state($1,$2,$3,$4,$5,$6,$7::jsonb) as value',
  ['read',scope.roomId,OWNER,scope.sessionId,scope.controlRevision,null,null])).rows[0].value.record;
 const video=reservation.cue.video.clips[0],consumed=raw.readObservationState().consumedFrames;
 // A committed observation must reach its browser even if unrelated source
 // preparation/projection would fail afterwards. Preload already prepared the
 // immutable generated context; live CURRENT readers still check fresh proof.
 rejectPostObservationProjection=true;
 const observed=await post('player/observe',{targetPlayerId:restarted.selected.targetPlayerId,graphEpoch:restarted.selected.graphEpoch,sequence:record.sequence+1,
  binding:currentMaterial.binding,sampleRate:RATE,sourceCount:1,contextState:'running',consumedFrames:consumed,receivedFrames:currentMaterial.queuedFrames,
  underrunFrames:0,stopped:false,windowStartFrame:measuredWindow.startFrame,windowPCM:Array.from(measuredWindow.pcm),
  video:{...fakeVideo,assetId:video.assetId,sha256:video.sha256}});assert.equal(observed.accepted,true);
 assert.equal(observationCasCommitted,true);rejectPostObservationProjection=false;
 const actualCurrent=await host.typedHost.readCurrentSource({roomId:room.roomId});assert.equal(actualCurrent.playback.revision,1);
 assert.equal(actualCurrent.music.clipId,reservation.cue.music.asset.assetId);assert.equal(actualCurrent.playback.actual,true);
 restored=createProductionNativeHost(options);const restoredCurrent=await restored.typedHost.readCurrentSource({roomId:room.roomId});
 assert.equal(restoredCurrent.music.sha256,actualCurrent.music.sha256);assert.equal(restoredCurrent.playback.revision,1);assert.equal(providerCalls,0);
});
