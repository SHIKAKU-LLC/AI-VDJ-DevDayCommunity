import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {syntheticWave} from './cloud-worker-fixture.mjs';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';
import {decodeCloudRender} from '../room-web/cloud-playback-media.mjs';
import {prepareCloudInitialAudio,prepareCloudWaitingAudio,createCloudSeedPlayback} from '../room-web/cloud-initial-audio.mjs';
import {createWorkletPlaybackEngine} from '../room-web/playback/worklet-engine.mjs';
import {createAudioOutputLease} from '../room-web/playback/output-lease.mjs';
import {createBrowserCommitPlayback} from '../room-web/playback/commit-playback.mjs';
const RATE=44100,worklet=await readFile(new URL('../snapshot/app/room-worklet.mjs',import.meta.url),'utf8');
async function inputs(extra={}){
 const bytes=new Uint8Array(syntheticWave(24)),sha256=await pcmSha256(bytes),pcm=decodeCloudRender(bytes,{mimeType:'audio/wav',durationFrames:24*RATE});
 const source={actual:false,clipId:'seed',sha256,contextSha256:'b'.repeat(64),playbackRevision:0,frameCount:24*RATE};
 const firstPlan={status:'ELIGIBLE',currentClipId:'seed',currentSha256:sha256,currentContextSha256:source.contextSha256,currentPlaybackRevision:0,
  planSha256:'c'.repeat(64),transition:{editStartFrame:24*RATE-442,exitFrame:24*RATE,entryFrame:0,renderedSha256:'d'.repeat(64)}};
 return {bytes,descriptor:{assetId:'seed',sha256,pcmSha256:await pcmSha256(pcm),byteLength:bytes.length,mimeType:'audio/wav'},source,firstPlan,mode:'initial',graphEpoch:1,...extra};
}
function harness(options={}){
 let Processor,state='suspended',stops=0,resumes=0,resolvePlaying;const listeners=new Set(),messages=[],events=[];
 const playing=new Promise(resolve=>{resolvePlaying=resolve;});
 const sandbox={Float32Array,ArrayBuffer,sampleRate:RATE,currentTime:0,AudioWorkletProcessor:class{constructor(){this.port={postMessage(data){events.push(data);for(const fn of listeners)fn({data});}};}},registerProcessor(name,C){Processor=C;}};
 vm.runInNewContext(worklet,sandbox);const processor=new Processor();
 const context={sampleRate:RATE,get state(){return state;},resume(){resumes++;state='running';return Promise.resolve();}};
 const port={start(){},addEventListener(type,fn){listeners.add(fn);},removeEventListener(type,fn){listeners.delete(fn);},postMessage(data){messages.push(data);processor.message(data);if(data.type==='play')resolvePlaying();}};
 const engine=createWorkletPlaybackEngine({context,node:{port},allowInitialAudio:options.allowed!==false,enableClipRelativeTimeline:options.clipRelative===true,loadVerifiedRender:async input=>input.render,readSourceCount:()=>1,
  stopAudio:async()=>{stops++;state='suspended';}});
 const lease=createAudioOutputLease({locks:{request:async(name,options,callback)=>callback({name})}});
 return {engine,lease,messages,events,processor,resumes:()=>resumes,stops:()=>stops,
  async waitForPlay(pending){
   // Await the actual queue command, not a count of event-loop turns. The source
   // operation's unchanged timeout/error remains the terminal failure signal.
   // A separate longer diagnostic bound also protects a broken fixture port.
   let timer;
   try{await Promise.race([playing,pending.then(()=>{throw Error('source ACK before processed samples');}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('seed play command missed diagnostic deadline')),10000);})]);}
   finally{clearTimeout(timer);}
  },
  pump(){const out=[new Float32Array(128),new Float32Array(128)];processor.process([], [out]);sandbox.currentTime+=128/RATE;return out;}};
}
test('initial/restart seed is measured immutable24s and excludes the seam edit region without retiming',async()=>{
 const input=await inputs(),plan=await prepareCloudInitialAudio(input);
 assert.equal(plan.queuedPrefixFrames,24*RATE-442);assert.equal(plan.pcm.length,plan.queuedPrefixFrames*2);
 assert.equal(plan.participantCredit,false);assert.equal(plan.loop,false);assert.equal(plan.timeStretch,false);
 assert.equal(await pcmSha256(plan.pcm),plan.queuedPrefixSha256);
 await assert.rejects(prepareCloudInitialAudio({...input,mode:'restart'}),/FRESH_FINITE/);
 assert.equal((await prepareCloudInitialAudio({...input,mode:'restart',graphEpoch:2,previousGraphStopped:true})).mode,'restart');
 for(const mutate of [i=>i.source.actual=true,i=>i.firstPlan.currentPlaybackRevision=1,i=>i.firstPlan.transition.editStartFrame=128,
  i=>i.bytes[44]^=1,i=>i.descriptor.pcmSha256='e'.repeat(64)]){
  const candidate=await inputs();mutate(candidate);await assert.rejects(prepareCloudInitialAudio(candidate));
 }
});
test('fresh restart adopts its acknowledged actual source revision after a previous participant credit',async t=>{
 const plan=await prepareCloudInitialAudio(await inputs({mode:'bootstrap',firstPlan:undefined,graphEpoch:2,previousGraphStopped:true}));
 const h=harness({clipRelative:true}),port=createBrowserCommitPlayback({audioEngine:h.engine,outputLease:h.lease,
  resolveMedia:async()=>{throw Error('unused');},createVideoAdapter:()=>{throw Error('unused');},initialPlaybackRevision:1});
 const seed=createCloudSeedPlayback({enabled:true,plan,audioEngine:h.engine,outputLease:h.lease,guard:async()=>true,
  markSourceStarted:async ack=>({accepted:true,graphEpoch:ack.graphEpoch,sourceSha256:ack.sourceSha256,sourcePlaybackRevision:ack.sourcePlaybackRevision})});
 t.after(async()=>{await seed.dispose();await port.dispose();});
 await port.unlock();assert.throws(()=>port.adoptInitialSourceRevision(plan),/ACTUAL_INITIAL_SOURCE_REVISION_REQUIRED/);
 const start=seed.start();await h.waitForPlay(start);for(let n=0;n<90;n++)h.pump();await start;
 assert.equal(port.read().playbackRevision,1);
 assert.throws(()=>port.adoptInitialSourceRevision({...plan}),/ACTUAL_INITIAL_SOURCE_REVISION_REQUIRED/);
 assert.equal(port.adoptInitialSourceRevision(plan).playbackRevision,0);
 seed.handoff({...port,role:'output'});assert.equal(port.read().phase,'READY');
 await port.stop();assert.throws(()=>port.adoptInitialSourceRevision(plan),/ACTUAL_INITIAL_SOURCE_REVISION_REQUIRED/);
});
test('seed gesture -> unchanged processor trace -> source-onlyACK -> same-graph generated suffix',async t=>{
 const input=await inputs(),plan=await prepareCloudInitialAudio(input),h=harness();let acknowledged;
 const seed=createCloudSeedPlayback({enabled:true,plan,audioEngine:h.engine,outputLease:h.lease,guard:async()=>true,
  markSourceStarted:async ack=>{acknowledged=ack;return {accepted:true,graphEpoch:ack.graphEpoch,sourceSha256:ack.sourceSha256,sourcePlaybackRevision:ack.sourcePlaybackRevision};}});
 t.after(async()=>{await seed.dispose();await h.engine.stop();});
 const pending=seed.start();pending.catch(()=>{});assert.equal(h.resumes(),1,'resume stays in the original gesture');await h.waitForPlay(pending);
 assert.equal(acknowledged,undefined);for(let n=0;n<90;n++)h.pump();const ack=await pending;
 assert.equal(ack.kind,'cloud-source-playback-started-v1');assert.equal(ack.participantCredit,false);assert.equal(ack.actual,true);
 assert.equal(ack.processedWindowSha256,plan.expectedProcessedWindowSha256);assert.equal(h.messages.find(x=>x.type==='chunk').startFrame,0);
 const leased=await h.lease.acquire();assert.equal(h.lease.isOwner(leased),true);
 seed.handoff({role:'output',read:()=>({phase:'READY',sourceCount:1})});
 const pcm=new Float32Array(48*RATE*2);pcm.set(plan.pcm);
 const render={pcm,sampleRate:RATE,startFrame:24*RATE,durationFrames:48*RATE};
 const prepared=await h.engine.prepare({plan:{transition:{editStartFrame:plan.queuedPrefixFrames}},render});
 await h.engine.commit(prepared);
 const replacement=h.messages.find(x=>x.type==='replace-future');
 assert.equal(replacement.startFrame,plan.queuedPrefixFrames);assert.equal(replacement.expectedReceived,plan.queuedPrefixFrames);
 await seed.dispose();assert.equal(h.stops(),0,'handed-off seed cannot stop the generated-cue graph');await h.engine.stop();leased.release();
});
test('corrupt prefix, priming an old graph and default activation all hold',async()=>{
 const plan=await prepareCloudInitialAudio(await inputs()),h=harness();await h.engine.context.resume();plan.pcm[0]+=.1;
 await assert.rejects(h.engine.primeSeed(plan),/PREFIX_CHANGED/);assert.equal(h.messages.length,0);await h.engine.stop();
 const fresh=await prepareCloudInitialAudio(await inputs()),off=harness({allowed:false});await off.engine.context.resume();
 await assert.rejects(off.engine.primeSeed(fresh),/FRESH_VERIFIED/);
 const seed=createCloudSeedPlayback({plan:fresh,audioEngine:off.engine,outputLease:off.lease,guard:async()=>true,markSourceStarted:async()=>({})});
 await assert.rejects(seed.start(),/NOT_ACTIVATED/);await seed.dispose();
 const used=harness();await used.engine.context.resume();await used.engine.primeSeed(fresh);
 await assert.rejects(used.engine.primeSeed(fresh),/FRESH_VERIFIED/);await used.engine.stop();
});
test('late guard/stop never marks actual source; restart must use a fresh graph and new epoch',async t=>{
 const plan=await prepareCloudInitialAudio(await inputs()),h=harness();let marks=0,valid=true;
 const seed=createCloudSeedPlayback({enabled:true,plan,audioEngine:h.engine,outputLease:h.lease,guard:async({phase})=>phase==='prepare'||valid,
  markSourceStarted:async()=>{marks++;return {};}});
 t.after(()=>seed.dispose());
 const pending=seed.start();pending.catch(()=>{});await h.waitForPlay(pending);valid=false;
 for(let n=0;n<90;n++)h.pump();await assert.rejects(pending);assert.equal(marks,0);assert.equal(h.stops(),1);
 const restart=await prepareCloudInitialAudio({...await inputs(),mode:'restart',graphEpoch:2,previousGraphStopped:true}),next=harness();
 const restarted=createCloudSeedPlayback({enabled:true,plan:restart,audioEngine:next.engine,outputLease:next.lease,guard:async()=>true,
  markSourceStarted:async ack=>({accepted:true,graphEpoch:1,sourceSha256:ack.sourceSha256,sourcePlaybackRevision:ack.sourcePlaybackRevision})});
 t.after(()=>restarted.dispose());
 const p=restarted.start();p.catch(()=>{});await next.waitForPlay(p);for(let n=0;n<90;n++)next.pump();await assert.rejects(p,/ACK_NOT_ACCEPTED/);
 await seed.dispose();await restarted.dispose();
});

test('source preparation waits for its actual command across delayed scheduler turns',async t=>{
 const plan=await prepareCloudInitialAudio(await inputs()),h=harness();let release;
 const barrier=new Promise(resolve=>{release=resolve;});
 const engine={...h.engine,primeSeed:async p=>{await barrier;return h.engine.primeSeed(p);}};
 const seed=createCloudSeedPlayback({enabled:true,plan,audioEngine:engine,outputLease:h.lease,guard:async()=>true,
  markSourceStarted:async ack=>({accepted:true,graphEpoch:ack.graphEpoch,sourceSha256:ack.sourceSha256,sourcePlaybackRevision:ack.sourcePlaybackRevision})});
 t.after(()=>seed.dispose());const pending=seed.start();pending.catch(()=>{});
 const waiting=h.waitForPlay(pending);
 for(let i=0;i<500;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.messages.some(x=>x.type==='play'),false);release();await waiting;
 for(let i=0;i<90;i++)h.pump();assert.equal((await pending).actual,true);
});

test('cloud preflight has its own deadline and does not consume the processed audio ACK window',async t=>{
 const plan=await prepareCloudInitialAudio(await inputs()),h=harness();let release;
 const barrier=new Promise(resolve=>{release=resolve;});
 const seed=createCloudSeedPlayback({enabled:true,plan,audioEngine:h.engine,outputLease:h.lease,timeoutMs:40,
  guard:async({phase})=>{if(phase==='prepare')await barrier;return true;},
  markSourceStarted:async ack=>({accepted:true,graphEpoch:ack.graphEpoch,sourceSha256:ack.sourceSha256,sourcePlaybackRevision:ack.sourcePlaybackRevision})});
 t.after(()=>seed.dispose());const pending=seed.start();pending.catch(()=>{});
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(h.stops(),0);assert.equal(h.messages.some(x=>x.type==='play'),false);
 release();await h.waitForPlay(pending);for(let n=0;n<90;n++)h.pump();assert.equal((await pending).actual,true);
});


test('approved waiting PCM repeats beyond24s without actual frames; same producer starts a fresh measured source and Stop silences it',async()=>{
 const input=await inputs(),waiting=await prepareCloudWaitingAudio(input),h=harness();
 await h.engine.context.resume();await h.engine.startWaitingLoop(waiting);
 const blocks=Math.ceil(3*24*RATE/128)+2;
 for(let b=0;b<blocks;b++){
  const output=h.pump(),frame=(b*128)%(24*RATE);
  assert.equal(output[0][0],waiting.pcm[frame*2]);
 }
 assert.equal(h.processor.waitingCycles,3);assert.equal(h.events.length,0);
 assert.equal(h.engine.readState().consumedFrames,0);assert.equal(h.engine.readState().receivedFrames,0);
 assert.equal(h.engine.readClipState(),null);
 const plan=await prepareCloudInitialAudio({...input,mode:'bootstrap',firstPlan:undefined});
 const seed=createCloudSeedPlayback({enabled:true,plan,audioEngine:h.engine,outputLease:h.lease,guard:async()=>true,
  markSourceStarted:async ack=>({accepted:true,graphEpoch:ack.graphEpoch,sourceSha256:ack.sourceSha256,sourcePlaybackRevision:ack.sourcePlaybackRevision})});
 const start=seed.start();await h.waitForPlay(start);for(let b=0;b<100;b++)h.pump();
 const ack=await start;assert.equal(ack.actual,true);assert.equal(ack.participantCredit,false);
 assert(ack.playedUntilFrame>=256);assert(ack.playedUntilFrame<24*RATE);assert.equal(h.processor.waitingPCM,null);
 assert.equal(h.messages.filter(m=>m.type==='end-waiting-loop').length,1);
 await seed.stop();assert(h.pump().every(channel=>channel.every(v=>v===0)));
});
test('waiting loop rejects altered or unverified PCM, cannot create observations, and explicit Stop clears it',async()=>{
 const input=await inputs(),waiting=await prepareCloudWaitingAudio(input),h=harness();await h.engine.context.resume();
 await assert.rejects(h.engine.startWaitingLoop({...waiting}),/FRESH_APPROVED/);
 waiting.pcm[0]=.99;await assert.rejects(h.engine.startWaitingLoop(waiting),/WAITING_LOOP_CHANGED/);
 const valid=await prepareCloudWaitingAudio(input);await h.engine.startWaitingLoop(valid);
 h.engine.requestObservationWindow();assert.equal(h.events.some(e=>e.observationWindow),false);
 await h.engine.stop();assert.equal(h.processor.waitingPCM,null);assert(h.pump().every(channel=>channel.every(v=>v===0)));
});
