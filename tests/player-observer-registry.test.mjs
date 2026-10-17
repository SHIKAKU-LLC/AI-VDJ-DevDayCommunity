import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createPlayerObserverStore,PLAYER_OBSERVER_SQL} from '../cloud/jobs/player-observer-store.mjs';
import {createPlayerObserverRegistry} from '../cloud/jobs/player-observer-registry.mjs';
import {createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {createBrowserPlayerObserver} from '../room-web/playback/player-observer.mjs';
import {createCloudPlaybackChannel} from '../room-web/cloud-output-bridge.mjs';
import {prepareCloudInitialAudio} from '../room-web/cloud-initial-audio.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const owner='a'.repeat(64),hash=n=>n.repeat(64),RATE=44100;
async function fixture(t,{onQuery=()=>{}}={}){
 const db=new PGlite();t.after(()=>db.close());await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql','cloud/jobs/player-observer-state.sql'])
   await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
 const uid='11111111-1111-4111-a111-111111111111';await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);
 const room=(await db.query("select public.vdj_room_request('create',null,null,$1::jsonb,$2) value",[JSON.stringify({ownerCapability:owner,joinCode:hash('c')}),uid])).rows[0].value;
 let now=Date.now(),credit=null,stopped=false,material={binding:{kind:'source',assetId:'bootstrap',sha256:hash('d'),contextSha256:hash('e'),playbackRevision:0},
   pcm:Float32Array.from({length:24*RATE*2},(_,i)=>Math.sin(i*.01)*.1),originFrame:0,queuedFrames:24*RATE,maximumDurationFrames:24*RATE};
 const ports=createExistingCloudRepositoryReadPorts({query:(sql,values)=>db.query(sql,values),hostGenerationRead:async()=>({roomId:room.roomId,cues:[],currentCredit:null,pending:false,stopped:false}),now:()=>now});
 const scope=await ports.readScope({roomId:room.roomId}),scoped={roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision};
 await db.query('insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document) values($1,$2,$3,$4,to_timestamp($5::double precision/1000),$6::jsonb)',
  ['synthetic-observer-permit',scope.roomId,scope.sessionId,scope.controlRevision,scope.expiresAtMs,'{}']);
 await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
  ['synthetic-observer-operation','synthetic-observer-permit',scope.roomId,JSON.stringify({roomRuntime:{currentCredit:null,stopped:false,acks:[],servedCounts:{}}})]);
 const store=createPlayerObserverStore({query:(sql,values)=>{onQuery(sql,values);return db.query(sql,values);},withOwnerAuthorization:async(s,call)=>call({...s,ownerCapability:owner})});
 let targetSequence=0;
 const options={enabled:true,roomId:room.roomId,origin:'https://vdj.example',store,now:()=>now,mintTarget:()=> ++targetSequence===1?'server-target':'server-target-'+targetSequence,
   readScope:ports.readScope,readPlaybackState:async()=>({roomId:room.roomId,currentCredit:credit,stopped,cues:credit?[{status:'PLAYING',cueId:credit.cueId,generationId:credit.generationId,playbackRevision:credit.playbackRevision,music:{asset:{assetId:material.binding.assetId,sha256:material.binding.sha256}}}]:[]}),
   authorizeOwner:async({ownerCapability})=>ownerCapability===owner,readVerifiedMaterial:async()=>material};
 const registry=createPlayerObserverRegistry(options),fresh={sampleRate:RATE,sourceCount:1,consumedFrames:0,receivedFrames:0,contextState:'running'};
 function observation(selection,{sequence=1,consumedFrames=512,start=0,video=null}={}){return {targetPlayerId:selection.targetPlayerId,graphEpoch:selection.graphEpoch,
   sequence,binding:{...material.binding},sampleRate:RATE,sourceCount:1,contextState:'running',consumedFrames,receivedFrames:material.queuedFrames,
   underrunFrames:0,stopped:false,windowStartFrame:start,windowPCM:Array.from(material.pcm.subarray(start*2,(start+256)*2)),video};}
 return {db,registry,options,fresh,scoped,store,scope,observation,getMaterial:()=>material,advance:n=>{now+=n;},setStopped:async(value=true)=>{stopped=value;await db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime,stopped}',$1::jsonb) where room_id=$2",[JSON.stringify(value),scope.roomId]);},
  async current(){material={...material,binding:{...material.binding,kind:'current',assetId:'generated',sha256:hash('f'),playbackRevision:1,cueId:'cue-current',generationId:'generation-current'},videoAssets:[{assetId:'video-current',sha256:hash('b')}]};
   credit={actual:true,actualPlayback:true,cueId:'cue-current',generationId:'generation-current',playbackRevision:1};
   await db.query("update vdj_internal.generation_operations set document=jsonb_set(jsonb_set(document,'{roomRuntime,currentCredit}',$1::jsonb),'{cue}',$2::jsonb) where room_id=$3",
    [JSON.stringify(credit),JSON.stringify({status:'PLAYING',cueId:credit.cueId,generationId:credit.generationId,playbackRevision:credit.playbackRevision,music:{asset:{assetId:material.binding.assetId,sha256:material.binding.sha256}}}),scope.roomId]);},
  disableOwner:()=>db.query('update vdj_internal.owners set enabled=false where uid=$1',[uid]),
  changeControl:()=>db.query('update vdj_internal.rooms set control_revision=control_revision+1 where id=$1',[room.roomId])};
}
test('prepared private SQL binds existing owner/epoch/control and persists source frontier across registry restart',async t=>{
 const x=await fixture(t),selection=await x.registry.register(x.fresh);assert.equal(selection.graphEpoch,1);assert.equal(selection.expiresAtMs-selection.selectedAtMs,30000);
 await x.registry.observe(x.observation(selection));const restarted=createPlayerObserverRegistry(x.options);
 const frontier=await restarted.readSourceFrontier(x.scoped);assert.equal(frontier.kind,'authenticated-source-frontier-v1');assert.equal(frontier.playedUntilFrame,512);assert.equal(frontier.participantCredit,false);
 assert.equal((await restarted.readGraphAuthority(x.scoped)).targetPlayerId,'server-target');
 await assert.rejects(x.registry.observe(x.observation(selection)),/FRONTIER_CHANGED/);
 await assert.rejects(x.registry.observe(x.observation(selection,{sequence:2,consumedFrames:20*RATE,start:19*RATE})),/FRAME_TIME_CHANGED_RATE/);
 const tampered=x.observation(selection,{sequence:2,consumedFrames:768,start:256});tampered.windowPCM[0]+=.01;
 await assert.rejects(x.registry.observe(tampered),/PHYSICAL_WINDOW_CHANGED/);x.advance(5001);
 await assert.rejects(restarted.readSourceFrontier(x.scoped),/FRESH_FRONTIER/);
});
test('slow preparation completes before the unchanged 30-second fresh graph lease begins',async t=>{
 const x=await fixture(t);
 const registry=createPlayerObserverRegistry({...x.options,
  readScope:async input=>{x.advance(11000);return x.options.readScope(input);},
  readPlaybackState:async input=>{x.advance(11000);return x.options.readPlaybackState(input);}});
 const graph=await registry.register(x.fresh);
 assert.equal(graph.expiresAtMs-graph.selectedAtMs,30000);
 assert.equal(graph.expiresAtMs-x.options.now(),30000);
 await x.setStopped();await assert.rejects(registry.readGraphAuthority(x.scoped),/STOPPED|EXPIRED|SCOPE/);
});
test('frame rate uses ingress time across slow physical validation, while freshness and acceleration bounds remain strict',async t=>{
 const x=await fixture(t);let delayed=false;
 const registry=createPlayerObserverRegistry({...x.options,readVerifiedMaterial:async()=>{
  if(delayed)x.advance(5000);return x.getMaterial();
 }});
 const graph=await registry.register(x.fresh);delayed=true;
 await registry.observe(x.observation(graph));delayed=false;
 // Those five seconds were spent checking the earlier window, while the
 // real graph continued. Comparing against its later validation time rejects
 // this legitimate next window as an impossible accelerated report.
 const next=await registry.observe(x.observation(graph,{sequence:2,consumedFrames:4*RATE,start:4*RATE-256}));
 assert.equal(next.accepted,true);
 await assert.rejects(registry.observe(x.observation(graph,{sequence:3,consumedFrames:20*RATE,start:20*RATE-256})),/FRAME_TIME_CHANGED_RATE/);
 x.advance(5001);await assert.rejects(registry.readSourceFrontier(x.scoped),/FRESH_FRONTIER/);
});
test('frontier uses a newer verified window arriving during physical I/O without extending its5s age limit',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh);
 await x.registry.observe(x.observation(graph));let updated=false;
 const registry=createPlayerObserverRegistry({...x.options,readVerifiedMaterial:async()=>{
  if(!updated){updated=true;x.advance(6000);await x.registry.observe(x.observation(graph,{sequence:2,consumedFrames:1024,start:256}));}
  return x.getMaterial();
 }});
 const frontier=await registry.readSourceFrontier(x.scoped);
 assert.equal(frontier.playedUntilFrame,1024);assert.equal(frontier.serverObservedAtMs,x.options.now());
 x.advance(5001);await assert.rejects(registry.readSourceFrontier(x.scoped),/FRESH_FRONTIER/);
});
test('Stop, graph replacement and control changes during physical I/O cannot refresh a frontier',async t=>{
 for(const change of [async x=>x.setStopped(),async x=>x.changeControl(),async x=>{
  await x.registry.stop({current:true});await x.registry.register(x.fresh);
 }]){
  const x=await fixture(t),graph=await x.registry.register(x.fresh);await x.registry.observe(x.observation(graph));let changed=false;
  const registry=createPlayerObserverRegistry({...x.options,readVerifiedMaterial:async()=>{
   if(!changed){changed=true;await change(x);}return x.getMaterial();
  }});
  await assert.rejects(registry.readSourceFrontier(x.scoped),/STOPPED|SCOPE_CHANGED|TARGET_CHANGED|FRESH_FRONTIER|STORE_HOLD/);
 }
});
test('explicit owner Stop resolves an expired lost-registration target without renewing its lease',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh);x.advance(31000);
 for(const body of [{current:false},{current:true,targetPlayerId:graph.targetPlayerId}])
  await assert.rejects(x.registry.stop(body),/TARGET_REQUIRED/);
 const receipt=await x.registry.stop({current:true});
 assert.equal(receipt.targetPlayerId,graph.targetPlayerId);assert.equal(receipt.graphEpoch,graph.graphEpoch);
 assert.equal(receipt.stopped,true);assert.deepEqual(await x.registry.stop({current:true}),receipt);
 const restarted=await x.registry.register(x.fresh);assert.equal(restarted.graphEpoch,2);
 assert.equal(restarted.priorStopReceiptSha256,receipt.receiptSha256);
});
test('actual MessagePorts/queue processor feed bounded owner HTTP ingress; observer trace preserves incoming cue ACK trace',async t=>{
 const x=await fixture(t),m=x.getMaterial(),pcmBytes=Buffer.from(m.pcm.buffer),header=Buffer.alloc(44);
 header.write('RIFF');header.writeUInt32LE(pcmBytes.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);
 header.writeUInt16LE(3,20);header.writeUInt16LE(2,22);header.writeUInt32LE(RATE,24);header.writeUInt32LE(RATE*8,28);
 header.writeUInt16LE(8,32);header.writeUInt16LE(32,34);header.write('data',36);header.writeUInt32LE(pcmBytes.length,40);
 const bytes=Buffer.concat([header,pcmBytes]);m.binding.sha256=sha(bytes);
 const enginePorts=new MessageChannel(),ownerPorts=new MessageChannel();let Processor;
 const sandbox={Float32Array,ArrayBuffer,sampleRate:RATE,currentTime:0,
   AudioWorkletProcessor:class{constructor(){this.port={postMessage:data=>enginePorts.port2.postMessage(data)};}},
   registerProcessor:(_name,p)=>{Processor=p;}};
 vm.runInNewContext(await readFile(new URL('../snapshot/app/room-worklet.mjs',import.meta.url),'utf8'),sandbox);
 const processor=new Processor();enginePorts.port2.addEventListener('message',e=>processor.message(e.data));enginePorts.port2.start();
 const engine=createWorkletPlaybackEngine({context:{sampleRate:RATE,state:'running'},node:{port:enginePorts.port1},readSourceCount:()=>1,
   stopAudio:async()=>{},loadVerifiedRender:async()=>{throw Error('not used');},allowInitialAudio:true,enableClipRelativeTimeline:true});
 const serverChannel=createCloudPlaybackChannel({port:ownerPorts.port1,handle:async(type,data)=>{
   assert.equal(type,'playerObserver');const response=await x.registry.handleRequest(new Request(`https://vdj.example/api/rooms/${x.scoped.roomId}/player/${data.command}`,
    {method:'POST',headers:{origin:'https://vdj.example','content-type':'application/json','x-room-owner':owner},body:JSON.stringify(data.body)}));
   assert.equal(response.status,200);return response.json();}});
 const outputChannel=createCloudPlaybackChannel({port:ownerPorts.port2,handle:async()=>{throw Error('unused');}});
 const observer=createBrowserPlayerObserver({enabled:true,intervalMs:1000,transport:(command,body)=>outputChannel.call('playerObserver',{command,body}),
   readEngine:engine.readObservationState,subscribe:engine.subscribe,requestWindow:engine.requestObservationWindow,readVideo:()=>null});
 t.after(()=>{observer.close();serverChannel.close();outputChannel.close();enginePorts.port1.close();enginePorts.port2.close();});
 const selection=await observer.register();const plan=await prepareCloudInitialAudio({bytes,descriptor:{assetId:m.binding.assetId,sha256:m.binding.sha256,
   byteLength:bytes.length,mimeType:'audio/wav',pcmSha256:sha(pcmBytes)},source:{actual:false,clipId:m.binding.assetId,sha256:m.binding.sha256,
   contextSha256:m.binding.contextSha256,playbackRevision:0,frameCount:24*RATE},mode:'bootstrap',graphEpoch:selection.graphEpoch});
 await engine.primeSeed(plan);await new Promise(r=>setTimeout(r,10));
 const pump=()=>{processor.process([],[ [new Float32Array(128),new Float32Array(128)] ]);sandbox.currentTime+=128/RATE;};
 for(let i=0;i<90;i++)pump();await new Promise(r=>setTimeout(r,10));
 const firstObservation=await observer.sample();
 assert.equal(firstObservation.accepted,true);assert.equal(firstObservation.sourceOnly,true);
 assert.equal((await x.registry.readSourceFrontier(x.scoped)).playedUntilFrame,11264);
 // A future cue trace remains independently active while observer telemetry is
 // captured from a different current window. Neither command edits audio.
 processor.message({type:'trace-frame',frame:13000});processor.message({type:'observe-frame',frame:0});
 for(let i=0;i<14;i++)pump();assert.equal(processor.traceFrame,null);assert.equal(processor.observerFrame,null);
 await observer.stop();await assert.rejects(x.registry.readSourceFrontier(x.scoped),/TARGET_CHANGED/);
});
test('CURRENT observer requires the actual bound video and does not reuse past credit as fresh frontier',async t=>{
 const x=await fixture(t),selection=await x.registry.register(x.fresh);await x.registry.observe(x.observation(selection));await x.current();
 await assert.rejects(x.registry.readCurrentFrontier(x.scoped),/FRESH_FRONTIER/);
 await assert.rejects(x.registry.observe(x.observation(selection,{sequence:2,consumedFrames:768,start:256})),/CURRENT_VIDEO/);
 const video={assetId:'video-current',sha256:hash('b'),presentedFrames:2,mediaTime:.02,width:1280,height:720,muted:true,volume:0};
 await x.registry.observe(x.observation(selection,{sequence:2,consumedFrames:768,start:256,video}));
 const frontier=await x.registry.readCurrentFrontier(x.scoped);assert.equal(frontier.cueId,'cue-current');assert.equal(frontier.playbackRevision,1);assert.equal(frontier.videoPresented,true);
 assert.equal((await x.registry.readSelectedTarget(x.scoped)).expiresAtMs,frontier.observedAtMs+5000);
 await assert.rejects(x.registry.observe(x.observation(selection,{sequence:3,consumedFrames:1024,start:512,video})),/VIDEO_FRONTIER_CHANGED/);
 const incoming={...video,assetId:'video-staging'};
 await assert.rejects(x.registry.observe(x.observation(selection,{sequence:3,consumedFrames:1024,start:512,video:incoming})),/CURRENT_VIDEO/);
});
test('CURRENT selection waits for a matching accepted PCM/video event; Stop cancels waiting without credit',async t=>{
 for(const stop of [false,true]){
  const x=await fixture(t),registry=x.registry,graph=await registry.register(x.fresh);
  await registry.observe(x.observation(graph));await x.current();
  let settled=false;const pending=registry.readCurrentFrontier(x.scoped);void pending.finally(()=>{settled=true;}).catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false);
  const video={assetId:'video-current',sha256:hash('b'),presentedFrames:2,mediaTime:.02,width:1280,height:720,muted:true,volume:0};
  if(stop){await registry.stop({current:true});await assert.rejects(pending,/TARGET_CHANGED|STOPPED/);}
  else{
   await assert.rejects(registry.observe(x.observation(graph,{sequence:2,consumedFrames:768,start:256,video:{...video,muted:false}})),/CURRENT_VIDEO/);
   assert.equal(settled,false,'a rejected observation cannot wake a frontier as valid');
   await registry.observe(x.observation(graph,{sequence:2,consumedFrames:768,start:256,video}));
   const result=await pending;assert.equal(result.playbackRevision,1);assert.equal(result.playedUntilFrame,768);assert.equal(result.videoPresented,true);
  }
 }
});
test('exact immutable CURRENT PCM uses one fresh authenticated read and rejects changed owner, Stop and scope',async t=>{
 let reads=0;const x=await fixture(t,{onQuery:()=>{reads++;}}),graph=await x.registry.register(x.fresh);
 await x.registry.observe(x.observation(graph));await x.current();
 const video={assetId:'video-current',sha256:hash('b'),presentedFrames:2,mediaTime:.02,width:1280,height:720,muted:true,volume:0};
 await x.registry.observe(x.observation(graph,{sequence:2,consumedFrames:768,start:256,video}));
 const registry=createPlayerObserverRegistry({...x.options,readVerifiedSourceSnapshot:input=>{
  assert.equal(input.mode,'current');assert.equal(input.playback.currentCredit.actual,true);assert(Object.hasOwn(input,'runtime'));
  return x.getMaterial();
 }});
 const before=reads,result=await registry.readCurrentFrontier(x.scoped);assert.equal(reads-before,1);assert.equal(result.playbackRevision,1);
 await x.setStopped();await assert.rejects(registry.readCurrentFrontier(x.scoped),/STOPPED|STORE_HOLD/);
 await x.setStopped(false);await x.disableOwner();await assert.rejects(registry.readCurrentFrontier(x.scoped),/STORE_HOLD|STOPPED/);
 const y=await fixture(t),g=await y.registry.register(y.fresh);await y.registry.observe(y.observation(g));await y.current();
 await y.changeControl();await assert.rejects(y.registry.readCurrentFrontier(y.scoped),/STORE_HOLD|STOPPED|SCOPE/);
});
test('browser collection waits for fresh CURRENT video callbacks and never observes the prepared incoming deck',async t=>{
 const x=await fixture(t);let listener,consumedFrames=0,receivedFrames=0;const m=x.getMaterial();
 let clip={clipId:m.binding.assetId,sha256:m.binding.sha256,playbackRevision:0,originFrame:0},currentVideo=null;
 const element=()=>({videoWidth:1280,videoHeight:720,muted:true,volume:0,requests:new Map(),sequence:0,
  requestVideoFrameCallback(fn){this.requests.set(++this.sequence,fn);return this.sequence;},cancelVideoFrameCallback(id){this.requests.delete(id);},
  present(frames){const callbacks=[...this.requests.values()];this.requests.clear();for(const callback of callbacks)callback(1,{presentedFrames:frames,mediaTime:.1});}});
 const current=element(),incoming=element();let layoutValid=true,layoutErrors=0;
 current.videoWidth=768;current.videoHeight=1152;
 const observer=createBrowserPlayerObserver({enabled:true,intervalMs:1000,readEngine:()=>({sampleRate:RATE,sourceCount:1,contextState:'running',
  consumedFrames,receivedFrames,underrunFrames:0,stopped:false,clip}),subscribe:fn=>{listener=fn;return()=>{};},requestWindow:()=>{},
  readVideo:()=>currentVideo,onError:()=>{layoutErrors++;},transport:async(command,body)=>{
   const result=await x.registry.handleRequest(new Request(`https://vdj.example/api/rooms/${x.scoped.roomId}/player/${command}`,
    {method:'POST',headers:{origin:'https://vdj.example','content-type':'application/json','x-room-owner':owner},body:JSON.stringify(body)}));
   assert.equal(result.status,200);return result.json();}});t.after(()=>observer.close());
 await observer.register();consumedFrames=512;receivedFrames=24*RATE;listener({playedWindow:{startFrame:0,pcm:m.pcm.slice(0,512).buffer}});await observer.sample();
 await x.current();const currentMaterial=x.getMaterial();consumedFrames=768;
 clip={clipId:currentMaterial.binding.assetId,sha256:currentMaterial.binding.sha256,playbackRevision:1,originFrame:0};
 currentVideo={element:current,assetId:'video-current',sha256:hash('b'),cueId:'cue-current',
  readPresentation:()=>layoutValid?{width:1280,height:720}:null};
 listener({observationWindow:{startFrame:256,pcm:m.pcm.slice(512,1024).buffer}});
 assert.equal(await observer.sample(),null,'native play/clock alone do not produce video evidence');
 assert.equal(incoming.requests.size,0,'prepared deck has no observer');current.present(1);
 assert.equal((await observer.sample()).accepted,true);assert.equal(incoming.requests.size,0);
 layoutValid=false;current.present(2);assert.equal(layoutErrors,1);
 assert.equal(await observer.sample(),null,'a changed canvas cannot reuse its earlier presented-frame evidence');
 observer.close(); // Same cleanup path used after an observation HOLD.
 await observer.stop(); await observer.stop();
 await assert.rejects(x.registry.readCurrentFrontier(x.scoped),/TARGET_CHANGED/);
 const saved=await x.store.read(x.scoped);assert.equal(saved.record.stopped,true);
});
test('Stop invalidates fresh frontier and restart requires its saved graph stop; CAS and enabled owner checks are atomic',async t=>{
 const x=await fixture(t),selection=await x.registry.register(x.fresh);await x.registry.observe(x.observation(selection));
 await x.setStopped();const receipt=await x.registry.stop({targetPlayerId:selection.targetPlayerId,graphEpoch:selection.graphEpoch});assert.equal(receipt.stopped,true);
 await assert.rejects(x.registry.readSourceFrontier(x.scoped),/STOPPED/);
 const restarted=await x.registry.register(x.fresh);assert.equal(restarted.graphEpoch,2);
 assert.notEqual(restarted.targetPlayerId,selection.targetPlayerId);assert.equal(restarted.priorStopReceiptSha256,receipt.receiptSha256);
 const prior=await x.registry.readPriorStopReceipt({...x.scoped,targetPlayerId:selection.targetPlayerId,graphEpoch:1});assert.equal(prior.receiptSha256,receipt.receiptSha256);
 await x.registry.observe(x.observation(restarted));assert.equal((await x.registry.readSourceFrontier(x.scoped)).graphEpoch,2);
 await assert.rejects(x.registry.readCurrentFrontier(x.scoped),/STOPPED/);
 const stale=await x.store.read(x.scoped);await assert.rejects(x.store.compareAndSwap(x.scoped,stale.version-1,stale.record),/STORE_HOLD/);
 await x.disableOwner();await assert.rejects(x.store.read(x.scoped),/STORE_HOLD/);
 const publicExecute=(await x.db.query("select has_function_privilege('anon','vdj_internal.player_observer_state(text,uuid,text,uuid,bigint,bigint,jsonb)','EXECUTE') as allowed")).rows[0].allowed;
 assert.equal(publicExecute,false);
});
test('HTTP owner/same-origin bounded JSON ingress; disabled/room epoch/control changes hold without accepting client authority',async t=>{
 const x=await fixture(t),url=`https://vdj.example/api/rooms/${x.scoped.roomId}/player/register`;
 const request=(body,origin='https://vdj.example')=>new Request(url,{method:'POST',headers:{origin,'x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await x.registry.handleRequest(request(x.fresh,'https://other.example'))).status,403);
 assert.equal((await x.registry.handleRequest(request({...x.fresh,targetPlayerId:'caller-picked'}))).status,409);
 assert.equal((await x.registry.handleRequest(request(x.fresh))).status,200);
 const disabled=createPlayerObserverRegistry({...x.options,enabled:false});await assert.rejects(disabled.register(x.fresh),/NOT_ACTIVATED/);
 // A known stale identity now fails at the fresh atomic SQL fence, before
 // an outer scope-discovery read can classify the control revision change.
 await x.changeControl();await assert.rejects(x.registry.readGraphAuthority(x.scoped),/TARGET_CHANGED|SCOPE_CHANGED|STORE_HOLD/);
 await assert.rejects(x.db.query(PLAYER_OBSERVER_SQL,['read',x.scoped.roomId,owner,x.scoped.sessionId,0,null,null]),/SCOPE_CHANGED/);
});
test('one lost registration reply reconciles the same anonymous graph nonce without POST replay or lease renewal',async t=>{
 const x=await fixture(t),commands=[];let nonce;
 const observer=createBrowserPlayerObserver({enabled:true,intervalMs:1000,readEngine:()=>x.fresh,
  subscribe:()=>()=>{},requestWindow:()=>{},readVideo:()=>null,transport:async(command,body)=>{
   commands.push(command);if(command==='register')nonce=body.registrationId;
   const response=await x.registry.handleRequest(new Request(`https://vdj.example/api/rooms/${x.scoped.roomId}/player/${command}`,
    {method:'POST',headers:{origin:'https://vdj.example','x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify(body)}));
   assert.equal(response.status,200);const result=await response.json();if(command==='register')throw Error('synthetic lost reply');return result;
  }});t.after(()=>observer.close());
 const selected=await observer.register();assert.deepEqual(commands,['register','binding']);assert.equal(selected.graphEpoch,1);
 const graph=await x.registry.readGraphAuthority(x.scoped);assert.equal(selected.expiresAtMs,graph.expiresAtMs);
 x.advance(10);const duplicate=await x.registry.register({...x.fresh,registrationId:nonce});assert.equal(duplicate.duplicate,true);
 assert.equal(duplicate.expiresAtMs,graph.expiresAtMs);await observer.stop();
});
test('explicit sampling avoids initial ACK contention and refreshes a window that aged during binding',async()=>{
 let listener,consumedFrames=90000;const calls=[],binding={kind:'source',assetId:'seed',sha256:hash('d'),contextSha256:hash('e'),playbackRevision:0};
 const observer=createBrowserPlayerObserver({enabled:true,autoSample:false,subscribe:fn=>{listener=fn;return()=>{};},readVideo:()=>null,
  readEngine:()=>({sampleRate:RATE,sourceCount:1,contextState:'running',consumedFrames,receivedFrames:24*RATE,
    underrunFrames:0,stopped:false,clip:{clipId:'seed',sha256:hash('d'),playbackRevision:0,originFrame:0}}),
  requestWindow:()=>listener({observationWindow:{startFrame:consumedFrames-256,pcm:new Float32Array(512).buffer}}),
  transport:async(command,body)=>{calls.push(command);
    if(command==='register')return {targetPlayerId:'target',graphEpoch:1};
    if(command==='binding'){consumedFrames=130000;return {targetPlayerId:'target',graphEpoch:1,binding,queuedFrames:24*RATE,originFrame:0,sequence:1};}
    assert.equal(command,'observe');assert.equal(body.windowStartFrame,129744);assert.equal(body.consumedFrames,130000);return {accepted:true};}});
 try{await observer.register();assert.deepEqual(calls,['register']);
  listener({observationWindow:{startFrame:0,pcm:new Float32Array(512).buffer}});
  assert.equal((await observer.sample()).accepted,true);assert.deepEqual(calls,['register','binding','observe']);
 }finally{observer.close();}
});
test('refreshed PCM waits for the later processor telemetry before submission',async()=>{
 let listener,consumedFrames=90000,observed=false;
 const binding={kind:'source',assetId:'seed',sha256:hash('d'),contextSha256:hash('e'),playbackRevision:0};
 const observer=createBrowserPlayerObserver({enabled:true,autoSample:false,subscribe:fn=>{listener=fn;return()=>{};},readVideo:()=>null,
  readEngine:()=>({sampleRate:RATE,sourceCount:1,contextState:'running',consumedFrames,receivedFrames:24*RATE,
   underrunFrames:0,stopped:false,clip:{clipId:'seed',sha256:hash('d'),playbackRevision:0,originFrame:0}}),
  requestWindow:()=>{listener({observationWindow:{startFrame:130128,pcm:new Float32Array(512).buffer}});
   setTimeout(()=>{consumedFrames=130512;listener({telemetry:{consumedFrames}});},20);},
  transport:async(command,body)=>{
   if(command==='register')return {targetPlayerId:'target',graphEpoch:1};
   if(command==='binding'){consumedFrames=130000;return {targetPlayerId:'target',graphEpoch:1,binding,queuedFrames:24*RATE,originFrame:0,sequence:1};}
   assert.equal(command,'observe');observed=true;assert.equal(body.windowStartFrame,130128);assert.equal(body.consumedFrames,130512);return {accepted:true};}});
 try{await observer.register();listener({observationWindow:{startFrame:0,pcm:new Float32Array(512).buffer}});
  assert.equal((await observer.sample()).accepted,true);assert.equal(observed,true);
 }finally{observer.close();}
});

test('unchanged initial source observes directly but server Stop and scope checks remain authoritative',async t=>{
 const x=await fixture(t),m=x.getMaterial(),commands=[];let listener;
 const engine={...x.fresh,underrunFrames:0,stopped:false,clip:null};
 const observer=createBrowserPlayerObserver({enabled:true,autoSample:false,readEngine:()=>engine,readVideo:()=>null,requestWindow(){},
  subscribe:fn=>{listener=fn;return()=>{};},transport:async(command,body)=>{
   commands.push(command);
   const response=await x.registry.handleRequest(new Request(`https://vdj.example/api/rooms/${x.scoped.roomId}/player/${command}`,
    {method:'POST',headers:{origin:'https://vdj.example','content-type':'application/json','x-room-owner':owner},body:JSON.stringify(body)}));
   if(!response.ok)throw Error((await response.json()).error);return response.json();}});
 t.after(()=>observer.close());const selected=await observer.register();
 Object.assign(engine,{consumedFrames:512,receivedFrames:24*RATE,clip:{clipId:m.binding.assetId,sha256:m.binding.sha256,playbackRevision:0,originFrame:0}});
 listener({playedWindow:{startFrame:0,pcm:m.pcm.slice(0,512).buffer}});
 assert.equal((await observer.sample()).accepted,true);assert.deepEqual(commands,['register','observe']);
 const state=await x.registry.readSourceStartState(x.scoped);assert.equal(state.graph.graphEpoch,selected.graphEpoch);
 assert.equal(state.scope.roomId,x.scoped.roomId);assert.equal(state.playback.currentCredit,null);
 await assert.rejects(x.registry.readSourceStartState({roomId:x.scoped.roomId,controlRevision:0}),/SCOPE_CHANGED/);
 await x.registry.stop({current:true});engine.consumedFrames=768;
 listener({observationWindow:{startFrame:256,pcm:m.pcm.slice(512,1024).buffer}});
 await assert.rejects(observer.sample(),/OBSERVER_HOLD/);
 await assert.rejects(x.registry.readSourceStartState(x.scoped),/TARGET_CHANGED/);
 assert.equal(commands.filter(c=>c==='binding').length,0);
});

test('atomic source snapshot preserves ordinary read shape and reads fresh Stop/scope without a cached authorization',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh);await x.registry.observe(x.observation(graph));
 const ordinary=await x.store.read(x.scoped),atomic=await x.store.readSourceState(x.scoped);
 assert.equal(Object.hasOwn(ordinary,'scope'),false);assert.equal(Object.hasOwn(ordinary,'playback'),false);
 assert.deepEqual(atomic.record,ordinary.record);assert.equal(atomic.scope.expiresAtMs,x.scope.expiresAtMs);
 assert.equal(atomic.playback.roomId,x.scoped.roomId);assert.equal(atomic.playback.currentCredit,null);assert.equal(atomic.playback.stopped,false);
 assert.deepEqual(atomic.playback.cues,[]);
 const snapshot=await x.store.readPlaybackSnapshot(x.scoped);assert.deepEqual(snapshot.scope,atomic.scope);
 assert.deepEqual(snapshot.playback,atomic.playback);assert.deepEqual(snapshot.runtime.acks,[]);
 let reads=0;
 const queryStore=createPlayerObserverStore({query:(sql,values)=>{reads++;return x.db.query(sql,values);},
  withOwnerAuthorization:async(s,call)=>call({...s,ownerCapability:owner})});
 const registry=createPlayerObserverRegistry({...x.options,store:queryStore,
  readScope:()=>{throw Error('unexpected separate scope read');},readPlaybackState:()=>{throw Error('unexpected separate playback read');}});
 await registry.readSourceStartState(x.scoped);assert.equal(reads,1,'one fresh authenticated SQL read replaces redundant round trips');
 await x.setStopped();await assert.rejects(registry.readSourceStartState(x.scoped),/STOPPED/);
 assert.equal((await x.store.readSourceState(x.scoped)).playback.stopped,true);
 await x.changeControl();await assert.rejects(registry.readSourceStartState(x.scoped),/STORE_HOLD/);
 const y=await fixture(t);await y.disableOwner();await assert.rejects(y.store.readSourceState(y.scoped),/STORE_HOLD/);
 const z=await fixture(t);await z.db.query("update vdj_internal.rooms set expires_at=clock_timestamp()-interval '1 second' where id=$1",[z.scoped.roomId]);
 await assert.rejects(z.store.readSourceState(z.scoped),/STORE_HOLD/);
 const denied=createPlayerObserverStore({query:(sql,values)=>x.db.query(sql,values),withOwnerAuthorization:async(s,call)=>call({...s,ownerCapability:hash('b')})});
 await assert.rejects(denied.readSourceState(x.scoped),/STORE_HOLD/);
});

test('a synchronous verified source snapshot needs one fresh SQL read and still rejects Stop, disabled owner and stale frames',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh);await x.registry.observe(x.observation(graph));let reads=0;
 const store=createPlayerObserverStore({query:(sql,values)=>{reads++;return x.db.query(sql,values);},
  withOwnerAuthorization:async(s,call)=>call({...s,ownerCapability:owner})});
 const registry=createPlayerObserverRegistry({...x.options,store,
  readVerifiedSourceSnapshot:()=>structuredClone(x.getMaterial()),readVerifiedMaterial:()=>{throw Error('unexpected material IO');}});
 assert.equal((await registry.readSourceFrontier(x.scoped)).playedUntilFrame,512);assert.equal(reads,1);
 x.advance(5001);await assert.rejects(registry.readSourceFrontier(x.scoped),/FRESH_FRONTIER/);
 await x.setStopped();await assert.rejects(registry.readSourceFrontier(x.scoped),/STOPPED/);
 const y=await fixture(t),g=await y.registry.register(y.fresh);await y.registry.observe(y.observation(g));await y.disableOwner();
 const denied=createPlayerObserverRegistry({...y.options,readVerifiedSourceSnapshot:()=>structuredClone(y.getMaterial())});
 await assert.rejects(denied.readSourceFrontier(y.scoped),/STORE_HOLD/);
});
test('one stale SQL reply reconciles a newer committed physical window without renewing its timestamp',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh);await x.registry.observe(x.observation(graph));let reads=0;
 const store=createPlayerObserverStore({query:async(sql,values)=>{
  const result=await x.db.query(sql,values);
  if(values[0]==='read'&&++reads===2){x.advance(6000);await x.registry.observe(x.observation(graph,{sequence:2,consumedFrames:1024,start:256}));}
  return result;
 },withOwnerAuthorization:async(s,call)=>call({...s,ownerCapability:owner})});
 const registry=createPlayerObserverRegistry({...x.options,store});
 const value=await registry.readSourceFrontier(x.scoped);assert.equal(reads,3);assert.equal(value.playedUntilFrame,1024);
 assert.equal(value.serverObservedAtMs,x.options.now());x.advance(5001);
 await assert.rejects(registry.readSourceFrontier(x.scoped),/FRESH_FRONTIER/);
 await x.setStopped();await assert.rejects(registry.readSourceFrontier(x.scoped),/STOPPED/);
});

test('stale source frontier awaits an existing physical observation commit and still rejects Stop',async t=>{
 for(const stop of [false,true]){
  const x=await fixture(t),graph=await x.registry.register(x.fresh);await x.registry.observe(x.observation(graph));
  let release,entered,once=true;const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
  const registry=createPlayerObserverRegistry({...x.options,readVerifiedMaterial:async()=>{
   if(once){once=false;entered();await gate;}return x.getMaterial();
  }});
  const pending=registry.observe(x.observation(graph,{sequence:2,consumedFrames:1024,start:256}));
  void pending.catch(()=>{});await ready;x.advance(6000);
  const frontier=registry.readSourceFrontier(x.scoped);
  const timer=setTimeout(async()=>{if(stop)await x.setStopped();release();},30);t.after(()=>clearTimeout(timer));
  if(stop){await assert.rejects(frontier,/STOPPED|SCOPE_CHANGED/);await assert.rejects(pending,/STOPPED|SCOPE_CHANGED|STORE_HOLD/);}
  else {const value=await frontier;await pending;assert.equal(value.playedUntilFrame,1024);assert.equal(value.serverObservedAtMs,x.options.now());
   x.advance(5001);await assert.rejects(registry.readSourceFrontier(x.scoped),/FRESH_FRONTIER/);}
 }
});

test('physical observations commit with one fresh read and one fenced SQL CAS; concurrent Stop cannot pass',async t=>{
 const x=await fixture(t);let calls=[];
 const store=createPlayerObserverStore({query:(sql,values)=>{calls.push(values[0]);return x.db.query(sql,values);},
  withOwnerAuthorization:async(s,call)=>call({...s,ownerCapability:owner})});
 const registry=createPlayerObserverRegistry({...x.options,store}),graph=await registry.register(x.fresh);calls=[];
 await registry.observe(x.observation(graph));assert.deepEqual(calls,['read','cas']);
 const saved=await store.read(x.scoped);assert.equal(Object.hasOwn(saved.record,'__observationFence'),false);
 const before=await store.readObservationState(x.scoped);await x.setStopped();
 await assert.rejects(store.compareAndSwapObserved(x.scoped,before.version,before.record,
  {scopeExpiresAtMs:before.scope.expiresAtMs,playback:before.playback,runtime:before.runtime}),/STORE_HOLD/);
});
test('large retained receipts and pending Cue fence do not enlarge the saved observation limit',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh);
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime,acks}',$1::jsonb) where room_id=$2",
  [JSON.stringify([{syntheticReceipt:'x'.repeat(70000)}]),x.scoped.roomId]);
 await x.registry.observe(x.observation(graph));
 const snapshot=await x.store.readObservationState(x.scoped);
 assert(JSON.stringify(snapshot.runtime).length>65536);
 assert(JSON.stringify(snapshot.record).length<65536);
 assert.equal(Object.hasOwn(snapshot.record,'__observationFence'),false);
 const fence={scopeExpiresAtMs:snapshot.scope.expiresAtMs,playback:snapshot.playback,runtime:snapshot.runtime};
 await assert.rejects(x.store.compareAndSwapObserved(x.scoped,snapshot.version,{...snapshot.record,padding:'x'.repeat(65536)},fence),/STORE_HOLD/);
 const changed={...fence,runtime:{...snapshot.runtime,stopped:true}};
 await assert.rejects(x.store.compareAndSwapObserved(x.scoped,snapshot.version,snapshot.record,changed),/STORE_HOLD/);
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime,acks}',$1::jsonb) where room_id=$2",
  [JSON.stringify([{syntheticReceipt:'x'.repeat(262144)}]),x.scoped.roomId]);
 const tooLarge=await x.store.readObservationState(x.scoped);
 await assert.rejects(x.store.compareAndSwapObserved(x.scoped,tooLarge.version,tooLarge.record,
  {scopeExpiresAtMs:tooLarge.scope.expiresAtMs,playback:tooLarge.playback,runtime:tooLarge.runtime}),/STORE_HOLD/);
 await x.setStopped();await assert.rejects(x.registry.readSourceFrontier(x.scoped),/STOPPED|STORE_HOLD/);
});
test('a future reservation racing physical CAS revalidates the same ingress once; Stop cannot become a retry success',async t=>{
 for(const stopped of [false,true]){
  const x=await fixture(t),graph=await x.registry.register(x.fresh);let once=true,calls=[];const received=x.options.now();
  const store=createPlayerObserverStore({query:async(sql,values)=>{
   calls.push(values[0]);if(values[0]==='cas'&&once){once=false;x.advance(100);
    if(stopped)await x.setStopped();else await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime,pending}','{\"cue\":{\"cueId\":\"future-cue\"}}'::jsonb) where room_id=$1",[x.scoped.roomId]);}
   return x.db.query(sql,values);
  },withOwnerAuthorization:async(s,call)=>call({...s,ownerCapability:owner})});
  const registry=createPlayerObserverRegistry({...x.options,store});
  if(stopped)await assert.rejects(registry.observe(x.observation(graph)),/STOPPED|STORE_HOLD/);
  else {assert.equal((await registry.observe(x.observation(graph))).accepted,true);assert.deepEqual(calls,['read','cas','read','cas']);
   const saved=await x.store.read(x.scoped);assert.equal(saved.record.sequence,1);assert.equal(saved.record.observation.serverReceivedAtMs,received);}
 }
});
test('server-issued whole-state fingerprints keep a large retained ledger below the signed command limit',async t=>{
 const sent=[];const x=await fixture(t,{onQuery:(sql,values)=>{if(values[0]==='cas')sent.push(JSON.parse(values[6]));}});
 const graph=await x.registry.register(x.fresh);
 const history=[{syntheticReceipt:'x'.repeat(200000)}];
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime,acks}',$1::jsonb) where room_id=$2",[JSON.stringify(history),x.scoped.roomId]);
 assert.equal((await x.registry.observe(x.observation(graph))).accepted,true);
 const snapshot=await x.store.readObservationState(x.scoped),doc=sent.at(-1);
 assert.deepEqual(snapshot.runtime.acks,history);
 assert(Buffer.byteLength(JSON.stringify(doc))<4096);
 assert(Buffer.byteLength(JSON.stringify({statementId:'observer',args:['cas',x.scoped.sessionId,0,snapshot.version,doc]}))<131072);
 assert.deepEqual(doc.__observationFence,snapshot.stateFence);
 assert.equal(Object.hasOwn(doc.__observationFence,'runtime'),false);
 assert.equal(Object.hasOwn((await x.store.read(x.scoped)),'stateFence'),false);
 assert.equal(Object.hasOwn(snapshot.record,'__observationFence'),false);
 for(const patch of [{runtimeSha256:hash('0')},{playbackSha256:hash('0')},{runtime:{}},{scopeExpiresAtMs:snapshot.scope.expiresAtMs+1}])
  await assert.rejects(x.store.compareAndSwapObserved(x.scoped,snapshot.version,snapshot.record,{...snapshot.stateFence,...patch}),/STORE_HOLD/);
 for(const [key,value] of [['pending',{cue:{cueId:'future'}}],['currentCredit',{cueId:'new-credit'}],['acks',[{syntheticReceipt:'changed'}]],['stopped',true]]){
  const before=await x.store.readObservationState(x.scoped);
  await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,array['roomRuntime',$1],$2::jsonb) where room_id=$3",[key,JSON.stringify(value),x.scoped.roomId]);
  await assert.rejects(x.store.compareAndSwapObserved(x.scoped,before.version,before.record,before.stateFence),/STORE_HOLD/);
 }
});
test('a source with a reserved future render may still observe its installed24s prefix, but changed played bytes never pass',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh),m=x.getMaterial(),first=x.observation(graph);
 const old=m.pcm;m.pcm=new Float32Array(48*RATE*2);m.pcm.set(old);m.queuedFrames=48*RATE;m.maximumDurationFrames=180*RATE;m.acceptedPrefixFrames=24*RATE;m.installedPrefixPCM=old.slice();
 assert.equal(first.receivedFrames,24*RATE);assert.equal((await x.registry.observe(first)).accepted,true);
 x.advance(21000);const next=x.observation(graph,{sequence:2,consumedFrames:20*RATE+512,start:20*RATE});next.receivedFrames=24*RATE;
 m.pcm[20*RATE*2]+=.01;
 next.windowPCM=Array.from(old.subarray(20*RATE*2,(20*RATE+256)*2));
 const tampered=structuredClone(next);tampered.windowPCM[0]+=.02;
 await assert.rejects(x.registry.observe(tampered),/PHYSICAL_WINDOW_CHANGED/);
 assert.equal((await x.registry.observe(next)).accepted,true,'reserved render does not rewrite the installed seed tail');
 x.advance(1000);const installed=x.observation(graph,{sequence:3,consumedFrames:21*RATE+512,start:21*RATE});
 installed.windowPCM[0]+=.02;await assert.rejects(x.registry.observe(installed),/PHYSICAL_WINDOW_CHANGED/);
 const impossible=x.observation(graph,{sequence:2,consumedFrames:24*RATE,start:24*RATE-256});impossible.receivedFrames=24*RATE;
 await assert.rejects(x.registry.observe(impossible),/FRONTIER_CHANGED/);
});

test('registered scope identity avoids repeated discovery while every start read still authenticates live SQL authority',async t=>{
 const x=await fixture(t);let discovery=0;
 const registry=createPlayerObserverRegistry({...x.options,readScope:async input=>{discovery++;return x.options.readScope(input);}});
 await registry.register(x.fresh);const before=discovery;
 for(let n=0;n<3;n++)assert.equal((await registry.readSourceStartState({roomId:x.scoped.roomId})).scope.sessionId,x.scoped.sessionId);
 assert.equal(discovery,before,'known identity does not need another network discovery');
 await x.disableOwner();await assert.rejects(registry.readSourceStartState({roomId:x.scoped.roomId}),/OWNER|SCOPE|STORE/);
});

test('a lost post-ACK observation request is retried, but only a new processed window can advance sequence',async()=>{
 let receive,requests=0,sequence=0;const binding={kind:'source',assetId:'seed',sha256:hash('a'),playbackRevision:0};
 const state={sampleRate:RATE,sourceCount:1,contextState:'running',consumedFrames:512,receivedFrames:24*RATE,underrunFrames:0,stopped:false,
  clip:{clipId:'seed',sha256:hash('a'),playbackRevision:0,originFrame:0}};
 const observer=createBrowserPlayerObserver({enabled:true,autoSample:false,readEngine:()=>state,readVideo:()=>null,
  subscribe:fn=>{receive=fn;return()=>{};},requestWindow:()=>{requests++;},transport:async(command,proof)=>{
   if(command==='register')return{binding,targetPlayerId:'target',graphEpoch:1,finiteDurationFrames:24*RATE};
   assert.equal(command,'observe');assert.equal(proof.sequence,sequence+1);sequence++;return{accepted:true,sequence};
  }});
 await observer.register();receive({playedWindow:{startFrame:0,pcm:new Float32Array(512).buffer}});
 assert.equal((await observer.sample()).accepted,true);assert.equal(requests,1);
 assert.equal(await observer.sample(),null);assert.equal(sequence,1);assert.equal(requests,2,'retry a lost request without claiming any observation');
 state.consumedFrames=1024;receive({observationWindow:{startFrame:768,pcm:new Float32Array(512).buffer}});
 assert.equal((await observer.sample()).accepted,true);assert.equal(sequence,2);observer.close();
});

test('CURRENT may prove its installed prefix while a future Cue is prepared, without accepting changed played bytes',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh);await x.registry.observe(x.observation(graph));await x.current();
 const m=x.getMaterial(),old=m.pcm.slice();m.pcm=new Float32Array(48*RATE*2);m.pcm.set(old);m.queuedFrames=48*RATE;
 m.maximumDurationFrames=180*RATE;m.acceptedPrefixFrames=24*RATE;m.installedPrefixPCM=old;
 const video={assetId:'video-current',sha256:hash('b'),presentedFrames:2,mediaTime:.02,width:1280,height:720,muted:true,volume:0};
 const input=x.observation(graph,{sequence:2,consumedFrames:768,start:256,video});input.receivedFrames=24*RATE;
 m.pcm[512]+=.01;assert.equal((await x.registry.observe(input)).accepted,true,'the uninstalled future queue is not the sounding PCM');
 const wrong=x.observation(graph,{sequence:3,consumedFrames:1024,start:512,video:{...video,presentedFrames:3}});
 wrong.receivedFrames=24*RATE;wrong.windowPCM[0]+=.02;await assert.rejects(x.registry.observe(wrong),/PHYSICAL_WINDOW_CHANGED/);
 wrong.receivedFrames=12*RATE;await assert.rejects(x.registry.observe(wrong),/FRONTIER_CHANGED/);
});
test('browser CURRENT collection accepts only the server-bound installed prefix while preparing the future queue',async()=>{
 let receive,sequence=0,present;const video={videoWidth:1280,videoHeight:720,muted:true,volume:0,requestVideoFrameCallback(fn){present=fn;return 1;},cancelVideoFrameCallback(){}};
 const binding={kind:'current',assetId:'current-a',sha256:hash('a'),playbackRevision:1,cueId:'cue-a'};
 const observer=createBrowserPlayerObserver({enabled:true,autoSample:false,readEngine:()=>({sampleRate:RATE,sourceCount:1,contextState:'running',
  consumedFrames:512,receivedFrames:24*RATE,underrunFrames:0,stopped:false,clip:{clipId:'current-a',sha256:hash('a'),playbackRevision:1,originFrame:0}}),
  readVideo:()=>({element:video,assetId:'video-a',sha256:hash('b'),cueId:'cue-a'}),subscribe:fn=>{receive=fn;return()=>{};},requestWindow(){},
  transport:async(command,proof)=>{if(command==='register')return{targetPlayerId:'target',graphEpoch:1};
   if(command==='binding')return{targetPlayerId:'target',graphEpoch:1,binding,originFrame:0,queuedFrames:48*RATE,acceptedPrefixFrames:24*RATE,sequence};
   sequence++;return{accepted:true,sequence};}});
 // Video proof remains mandatory even for a server-bound prefix.
 await observer.register();receive({observationWindow:{startFrame:0,pcm:new Float32Array(512).buffer}});
 assert.equal(await observer.sample(),null);assert.equal(sequence,0);
 present(0,{presentedFrames:1,mediaTime:.01});
 assert.equal((await observer.sample()).accepted,true);assert.equal(sequence,1);observer.close();
});

test('binding collection counters are bounded diagnostics and cannot create a PCM observation or credit',async t=>{
 const x=await fixture(t),logs=[],registry=createPlayerObserverRegistry({...x.options,onCollectionState:value=>logs.push(value)});
 await registry.register(x.fresh);
 const send=body=>registry.handleRequest(new Request(`https://vdj.example/api/rooms/${x.scoped.roomId}/player/binding`,{
  method:'POST',headers:{origin:'https://vdj.example','x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify(body)}));
 const collection={receivedFrames:24*RATE,consumedFrames:512,windowStartFrame:0,originFrame:0,playbackRevision:0,videoReady:false};
 assert.equal((await send({collection})).status,200);assert.equal(logs.length,1);assert.match(logs[0],/^SOURCE_S0_R[0-9]+_Q[0-9]+_C512_W0_O0_E0_P0_V0$/);
 for(const value of [null,{...collection,consumedFrames:-1},{...collection,unexpected:true}])assert.equal((await send({collection:value})).status,409);
 const saved=await x.store.read(x.scoped);assert.equal(saved.record.sequence,0);assert.equal(saved.record.observation,null);
});
test('binding reads one live atomic snapshot and still rejects Stop, owner and control changes',async t=>{
 for(const change of [x=>x.registry.stop({current:true}),x=>x.disableOwner(),x=>x.changeControl()]){
  let reads=[];const x=await fixture(t,{onQuery:(sql,values)=>reads.push(values[0])});
  await x.registry.register(x.fresh);reads=[];
  const request=()=>x.registry.handleRequest(new Request(`https://vdj.example/api/rooms/${x.scoped.roomId}/player/binding`,
   {method:'POST',headers:{origin:'https://vdj.example','content-type':'application/json','x-room-owner':owner},body:'{}'}));
  assert.equal((await request()).status,200);assert.deepEqual(reads,['read']);
  await change(x);assert.equal((await request()).status,409);
 }
});
test('local collection diagnostics identify a pending reply without retrying or exposing media',async()=>{
 let receive,resolve,observes=0;const snapshots=[];
 const state={sampleRate:RATE,sourceCount:1,contextState:'running',consumedFrames:512,receivedFrames:24*RATE,
  underrunFrames:0,stopped:false,clip:{clipId:'seed',sha256:hash('a'),playbackRevision:0,originFrame:0}};
 const observer=createBrowserPlayerObserver({enabled:true,autoSample:false,readEngine:()=>state,readVideo:()=>null,
  subscribe:fn=>{receive=fn;return()=>{};},requestWindow(){},onDiagnostics:value=>snapshots.push(value),
  transport:async(command)=>{if(command==='register')return{binding:{kind:'source',assetId:'seed',sha256:hash('a'),playbackRevision:0},targetPlayerId:'target',graphEpoch:1,finiteDurationFrames:24*RATE};
   observes++;return new Promise(r=>{resolve=r;});}});
 await observer.register();receive({playedWindow:{startFrame:0,pcm:new Float32Array(512).buffer}});
 const first=observer.sample();await Promise.resolve();assert.equal(observer.readDiagnostics().stage,'OBSERVE');
 assert.equal(observer.sample(),first);assert.equal(observes,1);assert.equal(observer.readDiagnostics().acceptedSequence,0);
 assert.equal(/sha256|clipId|pcm|targetPlayerId|registrationId|url/i.test(JSON.stringify(snapshots)),false);
 resolve({accepted:true,sequence:1});await first;assert.equal(observer.readDiagnostics().stage,'ACCEPTED');
 assert.equal(observer.readDiagnostics().acceptedSequence,1);observer.close();
});
test('HTTP rate timing starts at ingress before variable owner authorization latency',async t=>{
 const x=await fixture(t),graph=await x.registry.register(x.fresh);let delay=4000;
 const registry=createPlayerObserverRegistry({...x.options,authorizeOwner:async()=>{x.advance(delay);return true;}});
 const send=proof=>registry.handleRequest(new Request(`https://vdj.example/api/rooms/${x.scoped.roomId}/player/observe`,
  {method:'POST',headers:{origin:'https://vdj.example','content-type':'application/json','x-room-owner':owner},body:JSON.stringify(proof)}));
 assert.equal((await send(x.observation(graph))).status,200);
 delay=0;x.advance(500);
 const next=await send(x.observation(graph,{sequence:2,consumedFrames:4*RATE+512,start:4*RATE}));
 assert.equal(next.status,200,'owner SQL latency is not a physical playback acceleration');
 const record=(await x.store.read(x.scoped)).record;
 assert.equal(record.observation.serverReceivedAtMs,x.options.now());
 assert.equal((await send(x.observation(graph,{sequence:3,consumedFrames:20*RATE,start:19*RATE}))).status,409,
  'unchanged wall-time rate bound still rejects accelerated frames');
});
// Minimal counterexample from the 2026-10-16 production stops: the first report
// is delayed in the serialized owner/Edge path, the next one arrives promptly.
// Ingress spacing (500ms) then looks shorter than the 4s actually played.
test('show mode accepts a delayed report followed by a prompt one; strict mode still rejects it as acceleration',async t=>{
 for(const showMode of [false,true]){
  const x=await fixture(t),registry=createPlayerObserverRegistry({...x.options,showMode,...(showMode?{maximumAgeMs:30000}:{})});
  const graph=await registry.register(x.fresh);
  x.advance(4000);await registry.observe(x.observation(graph));
  x.advance(500);
  const prompt=registry.observe(x.observation(graph,{sequence:2,consumedFrames:4*RATE+512,start:4*RATE}));
  if(!showMode){await assert.rejects(prompt,/FRAME_TIME_CHANGED_RATE/);continue;}
  assert.equal((await prompt).accepted,true);
  // A delayed frontier stays usable within the show bound; data checks remain.
  x.advance(10000);assert.equal((await registry.readSourceFrontier(x.scoped)).playedUntilFrame,4*RATE+512);
  const tampered=x.observation(graph,{sequence:3,consumedFrames:5*RATE,start:5*RATE-256});tampered.windowPCM[0]+=.01;
  await assert.rejects(registry.observe(tampered),/PHYSICAL_WINDOW_CHANGED/);
  await assert.rejects(registry.observe(x.observation(graph,{sequence:3,consumedFrames:5*RATE,start:4*RATE})),/WINDOW_ORDER/);
  x.advance(20001);await assert.rejects(registry.readSourceFrontier(x.scoped),/FRESH_FRONTIER/);
 }
});
test('show mode is explicit and its longer frontier age is not available to strict registries',async t=>{
 const x=await fixture(t);
 assert.throws(()=>createPlayerObserverRegistry({...x.options,maximumAgeMs:30000}),/OBSERVER_PORTS_REQUIRED/);
 assert.throws(()=>createPlayerObserverRegistry({...x.options,showMode:'yes'}),/OBSERVER_PORTS_REQUIRED/);
 assert.equal(createPlayerObserverRegistry(x.options).capabilities().showMode,false);
});
// Production graph 65: Cue A's first CURRENT window arrived 18s after its ACK,
// leaving too little of A to reserve and queue B. Show mode treats the ACK as
// an at-start frontier; a real CURRENT window still supersedes it.
test('show mode uses the accepted Cue ACK as an at-start CURRENT frontier; Stop and later windows still govern',async t=>{
 const x=await fixture(t),registry=createPlayerObserverRegistry({...x.options,showMode:true,maximumAgeMs:30000});
 const graph=await registry.register(x.fresh);await registry.observe(x.observation(graph));await x.current();
 const started=Date.now(),atStart=await registry.readCurrentFrontier(x.scoped);
 assert.ok(Date.now()-started<1000,'no wait for a CURRENT window');
 assert.equal(atStart.cueId,'cue-current');assert.equal(atStart.playbackRevision,1);assert.equal(atStart.playedUntilFrame,256);
 assert.equal((await registry.readSelectedTarget(x.scoped)).cueId,'cue-current');
 const video={assetId:'video-current',sha256:hash('b'),presentedFrames:2,mediaTime:.02,width:1280,height:720,muted:true,volume:0};
 await registry.observe(x.observation(graph,{sequence:2,consumedFrames:768,start:256,video}));
 assert.equal((await registry.readCurrentFrontier(x.scoped)).playedUntilFrame,768,'an actual window supersedes the ACK');
 await registry.stop({current:true});await assert.rejects(registry.readCurrentFrontier(x.scoped),/STOPPED|TARGET_CHANGED/);
});
test('show mode never mints an at-start frontier from a stale switch; a real CURRENT window is required',async t=>{
 const x=await fixture(t),registry=createPlayerObserverRegistry({...x.options,showMode:true,maximumAgeMs:30000});
 const graph=await registry.register(x.fresh);await registry.observe(x.observation(graph));await x.current();
 x.advance(24001);
 await assert.rejects(registry.readCurrentFrontier(x.scoped),/FRESH_FRONTIER/);
});
// Replayed operations share a cueId. Only the PLAYING copy at the credited
// revision is the observed current Cue; an older copy must not decide it.
for(const [name,extra,expected] of [
 ['an earlier READY replay is ignored',{status:'READY',music:{asset:{assetId:'stale-copy',sha256:hash('9')}}},null],
 ['two PLAYING copies are ambiguous',{status:'PLAYING',music:{asset:{assetId:'generated',sha256:hash('f')}}},/CURRENT_CHANGED/]])
test('CURRENT material binds the credited PLAYING copy sharing a cueId: '+name,async t=>{
 const x=await fixture(t),registry=createPlayerObserverRegistry({...x.options,showMode:true,maximumAgeMs:30000});
 const graph=await registry.register(x.fresh);await registry.observe(x.observation(graph));await x.current();
 await x.db.query('insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document) values($1,$2,$3,$4,to_timestamp($5::double precision/1000),$6::jsonb)',
  ['synthetic-observer-replay-permit',x.scope.roomId,x.scope.sessionId,x.scope.controlRevision,x.scope.expiresAtMs,'{}']);
 await x.db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
  ['synthetic-observer-replay','synthetic-observer-replay-permit',x.scope.roomId,JSON.stringify({cue:{cueId:'cue-current',generationId:'generation-current',playbackRevision:1,...extra}})]);
 if(expected)await assert.rejects(registry.readCurrentFrontier(x.scoped),expected);
 else assert.equal((await registry.readCurrentFrontier(x.scoped)).cueId,'cue-current');
});
