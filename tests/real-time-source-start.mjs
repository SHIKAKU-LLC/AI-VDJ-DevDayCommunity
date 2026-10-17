import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {MessageChannel} from 'node:worker_threads';
import {createBrowserPlayerObserver} from '../room-web/playback/player-observer.mjs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {createCloudSeedPlayback,prepareCloudInitialAudio} from '../room-web/cloud-initial-audio.mjs';
import {createAudioOutputLease} from '../room-web/playback/output-lease.mjs';
import {createCloudPlaybackChannel} from '../room-web/cloud-output-bridge.mjs';

const RATE=44100,ORIGIN='https://ai-vdj.vercel.app',OWNER='a'.repeat(64);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Offline wall-clock exercise. The VM runs the shipped AudioWorklet code and
// real MessagePorts, while only network latency and browser hardware are modelled.
export async function exerciseRealTimeSource({host,roomId,bindingMs=0,observeMs=0,telemetryDelayMs=0,stopDuringAck=false}){
 const events=[],channels=[],timers=new Set(),requests=new Set(),lifecycle={lateAckAccepted:false};let processor,state='running',closed=false,pump,stopTimer,pendingAck;
 const started=performance.now(),record=(kind,detail={})=>events.push({kind,ms:Math.round(performance.now()-started),...detail});
 const request=(route,body={})=>{const work=(async()=>{
  const start=performance.now(),minimum=route==='player/binding'?bindingMs:route==='player/observe'?observeMs:0;
  if(minimum)await delay(minimum/2);
  const response=await host.handleRequest(new Request(`${ORIGIN}/api/rooms/${roomId}/${route}`,{method:'POST',
   headers:{origin:ORIGIN,'x-room-owner':OWNER,'content-type':'application/json'},body:JSON.stringify(body)}));
  const value=await response.json();
  if(minimum)await delay(Math.max(0,minimum-(performance.now()-start)));
  record(route,{status:response.status,code:value.error,sequence:value.sequence});
  if(!response.ok)throw Error(value.error??'HTTP_HOLD');return value;
 })();requests.add(work);void work.finally(()=>requests.delete(work)).catch(()=>{});return work;
 };
 const enginePorts=new MessageChannel(),ownerPorts=new MessageChannel();channels.push(enginePorts,ownerPorts);
 const sandbox={Float32Array,ArrayBuffer,sampleRate:RATE,currentTime:0,
  AudioWorkletProcessor:class{constructor(){this.port={postMessage:data=>{
   if(data.observationWindow)record('pcm-window',{frame:data.observationWindow.startFrame});
   if(data.telemetry)record('telemetry',{frame:data.telemetry.consumedFrames});
   if(data.telemetry&&telemetryDelayMs){const timer=setTimeout(()=>{timers.delete(timer);if(!closed)enginePorts.port2.postMessage(data);},telemetryDelayMs);timers.add(timer);}
   else enginePorts.port2.postMessage(data);
  }};}},registerProcessor:(_name,Constructor)=>{processor=new Constructor();}};
 vm.runInNewContext(await readFile(new URL('../snapshot/app/room-worklet.mjs',import.meta.url),'utf8'),sandbox);
 enginePorts.port2.addEventListener('message',event=>processor.message(event.data));enginePorts.port2.start();
 const context={sampleRate:RATE,get state(){return state;},async resume(){state='running';}};
 const engine=createWorkletPlaybackEngine({context,node:{port:enginePorts.port1},readSourceCount:()=>1,
  stopAudio:async()=>{state='suspended';},loadVerifiedRender:async()=>{throw Error('NO_GENERATED_RENDER');},
  allowInitialAudio:true,enableClipRelativeTimeline:true});
 const server=createCloudPlaybackChannel({port:ownerPorts.port1,handle:async(type,data)=>{
  assert.equal(type,'playerObserver');return request('player/'+data.command,data.body);}});
 const client=createCloudPlaybackChannel({port:ownerPorts.port2,handle:()=>{throw Error('NO_OWNER_COMMAND');}});
 let observer,seed;
 try{
  const startup=await request('source/startup');
  const asset=await host.handleRequest(new Request(`${ORIGIN}/api/rooms/${roomId}/media/${startup.descriptor.assetId}?sha256=${startup.descriptor.sha256}`,
   {headers:{origin:ORIGIN,'x-room-owner':OWNER}}));assert.equal(asset.status,200);
  observer=createBrowserPlayerObserver({enabled:true,autoSample:false,intervalMs:500,
   transport:(command,body)=>client.call('playerObserver',{command,body},command==='register'?{timeoutMs:300000}:{}),readEngine:engine.readObservationState,
   subscribe:engine.subscribe,requestWindow:engine.requestObservationWindow,readVideo:()=>null,
   onError:error=>{record('observer-hold',{code:error.message});observer.close();void seed?.stop('PLAYER_OBSERVER_HOLD');}});
  const selection=await observer.register();
  const plan=await prepareCloudInitialAudio({bytes:new Uint8Array(await asset.arrayBuffer()),descriptor:startup.descriptor,
   source:startup.source,mode:'bootstrap',graphEpoch:selection.graphEpoch,previousGraphStopped:selection.mode==='restart'});
  const locks={request:async(_name,_options,callback)=>callback({name:'offline-exclusive-audio'})};
  seed=createCloudSeedPlayback({enabled:true,plan,audioEngine:engine,outputLease:createAudioOutputLease({locks}),
   guard:async({phase})=>{if(phase==='ack')return true;const selected=await request('player/binding');return selected.graphEpoch===selection.graphEpoch&&selected.binding.sha256===plan.sourceSha256;},
   markSourceStarted:async ack=>{
    await observer.sample();observer.startSampling();record('ack-submit');
    if(stopDuringAck)stopTimer=setTimeout(()=>{record('explicit-stop');void seed.stop('USER_STOP');void observer.stop();},100);
    pendingAck=request('source/ack',{ack}).then(value=>{lifecycle.lateAckAccepted=value.accepted===true;return value;});
    return pendingAck;},onState:s=>record('source-state',{phase:s.phase,code:s.reason})});
  let nextFrame=0;const audioStart=performance.now();
  pump=setInterval(()=>{if(closed||state!=='running')return;
   if(processor.playing){if(!nextFrame)nextFrame=performance.now();
    const target=Math.floor((performance.now()-nextFrame)*RATE/1000);
    while(processor.consumed+128<=target&&processor.playing){processor.process([],[ [new Float32Array(128),new Float32Array(128)] ]);sandbox.currentTime+=128/RATE;}}
  },4);
  let accepted=false,error;
  try{await seed.start();accepted=true;}catch(e){error=e.message;}
  record('outcome',{accepted,code:error});
  return {accepted,error,lifecycle,events,telemetryEvents:events.filter(e=>e.kind==='telemetry').length,
   observations:events.filter(e=>e.kind==='player/observe'&&e.status===200).length,elapsedMs:Math.round(performance.now()-audioStart)};
 }catch(error){
  record('setup-or-transport-hold',{code:error.message});
  return {accepted:false,error:error.message,lifecycle,events,telemetryEvents:events.filter(e=>e.kind==='telemetry').length,
   observations:events.filter(e=>e.kind==='player/observe'&&e.status===200).length};
 }finally{
  closed=true;clearInterval(pump);clearTimeout(stopTimer);for(const timer of timers)clearTimeout(timer);
  await seed?.stop('LOCAL_SCENARIO_END').catch(()=>{});await observer?.stop().catch(()=>{});observer?.close();server.close();client.close();
  await pendingAck?.catch(()=>{});
  await Promise.allSettled([...requests]);
  for(const pair of channels){pair.port1.close();pair.port2.close();}
 }
}
