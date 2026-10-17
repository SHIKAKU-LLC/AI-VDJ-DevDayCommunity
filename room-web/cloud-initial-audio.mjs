import {pcmSha256} from './playback/cue-contract.mjs';
import {decodeCloudRender} from './cloud-playback-media.mjs';

const RATE=44100,SEED_FRAMES=24*RATE,WINDOW=256,MAX_FRAMES=180*RATE;
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const verified=new WeakSet();
const verifiedWaiting=new WeakSet();
const fail=code=>{throw Error(code);};

// Prepare privately delivered seed bytes before the output gesture. This is a
// finite source plan, never a generated Cue or a participant-credit ACK.
// Initial/restart plans exclude the measured continuation seam. Bootstrap uses
// only server-approved physical24s bytes and no assumed QC plan: it queues the
// whole source with a24s finite bound, then requires an actual source-only ACK.
export async function prepareCloudInitialAudio({bytes,descriptor,source,firstPlan,
 mode='initial',graphEpoch,previousGraphStopped=false}={}) {
 if(!['initial','restart','bootstrap'].includes(mode)||!Number.isSafeInteger(graphEpoch)||graphEpoch<1||
    source?.actual!==false||!id(source?.clipId)||!hash(source.sha256)||!hash(source.contextSha256)||
    !Number.isSafeInteger(source.playbackRevision)||source.playbackRevision<0||source.frameCount!==SEED_FRAMES||
    (mode==='restart'||mode==='bootstrap'&&graphEpoch>1)&&previousGraphStopped!==true)fail('FRESH_FINITE_SOURCE_REQUIRED');
 if(!(bytes instanceof Uint8Array)||descriptor?.assetId!==source.clipId||descriptor.sha256!==source.sha256||
    descriptor.mimeType!=='audio/wav'||descriptor.byteLength!==bytes.byteLength||bytes.byteLength>16*1024*1024||
    !hash(descriptor.pcmSha256)||await pcmSha256(bytes)!==source.sha256)fail('INITIAL_AUDIO_BYTES_REQUIRED');
 const t=firstPlan?.transition;
 if(mode==='bootstrap') {
  if(firstPlan!==undefined&&firstPlan!==null)fail('BOOTSTRAP_CANNOT_ASSUME_CONTINUATION_PLAN');
 } else if(firstPlan?.status!=='ELIGIBLE'||firstPlan.currentClipId!==source.clipId||firstPlan.currentSha256!==source.sha256||
    firstPlan.currentContextSha256!==source.contextSha256||firstPlan.currentPlaybackRevision!==source.playbackRevision||
    !hash(firstPlan.planSha256)||!hash(t?.renderedSha256)||!Number.isSafeInteger(t.editStartFrame)||
    t.editStartFrame<WINDOW||t.editStartFrame>SEED_FRAMES||
    // A measured cut ends at the seed's last frame; a measured crossfade ends
    // there too, its overlap centred overlapFrames/2 before (entry at half).
    !Number.isSafeInteger(t.overlapFrames??0)||(t.overlapFrames??0)%2||t.exitFrame+(t.overlapFrames??0)/2!==SEED_FRAMES||t.entryFrame!==(t.overlapFrames??0)/2)
  fail('INITIAL_MEASURED_CONTINUATION_PLAN_REQUIRED');
 const pcm=decodeCloudRender(bytes,{mimeType:'audio/wav',durationFrames:SEED_FRAMES});
 if(await pcmSha256(pcm)!==descriptor.pcmSha256)fail('INITIAL_AUDIO_PCM_SHA_MISMATCH');
 const prefixFrames=mode==='bootstrap'?SEED_FRAMES:t.editStartFrame;
 const prefix=pcm.slice(0,prefixFrames*2);
 const plan=Object.freeze({kind:'cloud-finite-source-start-v1',mode,graphEpoch,
  sourceClipId:source.clipId,sourceSha256:source.sha256,sourceContextSha256:source.contextSha256,
  sourcePlaybackRevision:source.playbackRevision,sampleRate:RATE,sourceFrames:SEED_FRAMES,
  queuedPrefixFrames:prefixFrames,maximumDurationFrames:MAX_FRAMES,
  finiteSourceDurationFrames:mode==='bootstrap'?SEED_FRAMES:MAX_FRAMES,
  queuedPrefixSha256:await pcmSha256(prefix),
  expectedProcessedWindowSha256:await pcmSha256(prefix.subarray(0,WINDOW*2)),
  continuationPlanSha256:firstPlan?.planSha256??null,continuationRenderSha256:t?.renderedSha256??null,
  participantCredit:false,timeStretch:false,pitchShift:false,loop:false,pcm:prefix});
 verified.add(plan);return plan;
}
export function isVerifiedCloudInitialAudio(plan){return verified.has(plan);}

// Playback while generation/review is pending is explicitly uncredited. It
// cannot register a graph, supply observations or become an actual source ACK.
export async function prepareCloudWaitingAudio(input) {
 const finite=await prepareCloudInitialAudio({...input,mode:'bootstrap',graphEpoch:1,firstPlan:undefined});
 const plan=Object.freeze({kind:'cloud-approved-waiting-loop-v1',pcm:finite.pcm.slice(),
  frames:finite.sourceFrames,pcmSha256:finite.queuedPrefixSha256,participantCredit:false});
 verifiedWaiting.add(plan);return plan;
}
export const isVerifiedCloudWaitingAudio=plan=>verifiedWaiting.has(plan);

// Uses the SAME graph and lease as the generated-cue playback port. A fresh
// graph is mandatory on restart. The one audio gesture resumes synchronously.
export function createCloudSeedPlayback({enabled=false,plan,audioEngine,outputLease,
 guard,markSourceStarted,onState=()=>{},timeoutMs=20000}={}) {
 if(!isVerifiedCloudInitialAudio(plan)||!audioEngine?.context?.resume||!audioEngine.primeSeed||
    !audioEngine.subscribe||!outputLease?.acquire||!outputLease.isOwner||typeof guard!=='function'||
    typeof markSourceStarted!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<=0)
  fail('INITIAL_AUDIO_PORTS_REQUIRED');
 let epoch=0,active=null,lease=null,closed=false,phase='IDLE';
 const emit=(next,reason=null)=>{phase=next;try{onState({phase,reason,graphEpoch:plan.graphEpoch,participantCredit:false});}catch{}};
 async function stop(reason='SOURCE_STOP'){
  epoch++;const work=active;active=null;work?.abort.abort();clearTimeout(work?.timer);work?.unsubscribe?.();
  work?.reject(Error(reason));await audioEngine.stop();lease?.release();lease=null;emit('STOPPED',reason);
 }
 function start(){
  if(enabled!==true||closed)return Promise.reject(Error('INITIAL_AUDIO_NOT_ACTIVATED'));
  if(active||phase!=='IDLE')return Promise.reject(Error('FRESH_INITIAL_AUDIO_GESTURE_REQUIRED'));
  const token=++epoch,abort=new AbortController();let resumed;
  try{resumed=audioEngine.context.resume();}catch{return Promise.reject(Error('INITIAL_AUDIO_RESUME_FAILED'));}
  const resumeResult=Promise.resolve(resumed).then(()=>null,()=>Error('INITIAL_AUDIO_RESUME_FAILED'));
  const work={token,abort,window:null,telemetry:null,acknowledging:false};active=work;emit('STARTING');
  const valid=()=>active===work&&epoch===token&&!closed&&!abort.signal.aborted&&outputLease.isOwner(lease);
  const outcome=new Promise((resolve,reject)=>{work.resolve=resolve;work.reject=reject;});
  // Authenticated cloud preparation happens before the first queued sample.
  // Bound it independently; the finite audio ACK timer starts at primeSeed.
  work.timer=setTimeout(()=>{void stop('INITIAL_AUDIO_PREPARE_TIMEOUT').catch(()=>{});},300000);
  async function attempt(){
   if(!valid()||work.acknowledging||!work.window||!work.telemetry)return;
   const telemetry=work.telemetry;
   if(telemetry.sampleRate!==RATE||!Number.isSafeInteger(telemetry.consumedFrames)||telemetry.consumedFrames<0||
      telemetry.consumedFrames>plan.queuedPrefixFrames||telemetry.underrunFrames!==0||telemetry.stopped===true)
    return stop('INITIAL_AUDIO_TELEMETRY_INVALID');
   if(telemetry.consumedFrames<WINDOW)return;
   work.acknowledging=true;
   if(await pcmSha256(work.window)!==plan.expectedProcessedWindowSha256||!valid()||await guard({phase:'ack',plan})!==true||!valid())
    return stop('INITIAL_AUDIO_PROOF_OR_GUARD_CHANGED');
   const ack={kind:'cloud-source-playback-started-v1',graphEpoch:plan.graphEpoch,sourceClipId:plan.sourceClipId,
    sourceSha256:plan.sourceSha256,sourceContextSha256:plan.sourceContextSha256,
    sourcePlaybackRevision:plan.sourcePlaybackRevision,sampleRate:RATE,playedUntilFrame:telemetry.consumedFrames,
    processedWindowSha256:plan.expectedProcessedWindowSha256,actual:true,audioStarted:true,participantCredit:false};
   const receipt=await markSourceStarted(ack);
   if(!valid()||receipt?.accepted!==true||receipt.graphEpoch!==plan.graphEpoch||
      receipt.sourceSha256!==plan.sourceSha256||receipt.sourcePlaybackRevision!==plan.sourcePlaybackRevision)
    return stop('INITIAL_SOURCE_ACK_NOT_ACCEPTED');
   await audioEngine.recordActualSource?.({plan,ack});
   if(!valid())return stop('INITIAL_SOURCE_GRAPH_CHANGED');
   clearTimeout(work.timer);work.acked=true;emit('SOURCE_PLAYING');work.resolve(ack);
  }
  void (async()=>{
   const acquired=await outputLease.acquire();
   if(active!==work||epoch!==token||closed){acquired.release();throw Error('INITIAL_AUDIO_CANCELLED');}lease=acquired;
   const error=await resumeResult;if(error)throw error;
   if(!valid()||await guard({phase:'prepare',plan})!==true||!valid())throw Error('INITIAL_AUDIO_GUARD_CHANGED');
   work.unsubscribe=audioEngine.subscribe(event=>{
    if(!valid())return;
    if(event.error){void stop('INITIAL_WORKLET_ERROR').catch(()=>{});return;}
    if(event.telemetry){work.telemetry=event.telemetry;if(event.telemetry.underrunFrames>0||event.telemetry.stopped===true){void stop('INITIAL_AUDIO_ENDED_BEFORE_ACK').catch(()=>{});return;}}
    if(!work.acked&&event.playedWindow){const w=event.playedWindow;
     if(w.startFrame!==0||!(w.pcm instanceof ArrayBuffer)||w.pcm.byteLength!==WINDOW*8){void stop('INITIAL_AUDIO_WINDOW_INVALID').catch(()=>{});return;}
     work.window=w.pcm.slice(0);
    }
    if(!work.acked)void attempt().catch(()=>{void stop('INITIAL_SOURCE_ACK_UNKNOWN').catch(()=>{});});
   });
   if(!valid())throw Error('INITIAL_AUDIO_CANCELLED');
   // Hashing/copying the 24s seed stays under the preflight deadline. The
   // processed-audio ACK budget starts only once play has been issued.
   await audioEngine.primeSeed(plan);
   if(!valid())throw Error('INITIAL_AUDIO_CANCELLED');
   if(!work.acked){clearTimeout(work.timer);work.timer=setTimeout(()=>{void stop('INITIAL_AUDIO_ACK_TIMEOUT').catch(()=>{});},timeoutMs);}
  })().catch(()=>{if(active===work)void stop('INITIAL_AUDIO_START_HOLD').catch(()=>{});});
  return outcome;
 }
 return {start,stop,read:()=>({phase,graphEpoch:plan.graphEpoch,participantCredit:false}),
  handoff(outputPort){
   if(phase!=='SOURCE_PLAYING'||!active?.acked||outputPort?.role!=='output'||
      outputPort.read().phase!=='READY'||outputPort.read().sourceCount!==1||!outputLease.isOwner(lease))
    fail('INITIAL_AUDIO_HANDOFF_REQUIRED');
   active.unsubscribe?.();active=null;lease=null;emit('HANDED_OFF');
  },
  async dispose(){if(closed)return;closed=true;if(phase!=='HANDED_OFF')await stop('INITIAL_AUDIO_DISPOSE');}};
}
