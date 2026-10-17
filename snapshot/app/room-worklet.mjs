// One producer of already-rendered PCM. Timeline bounds are enforced here as
// well as on the server; no second source, hidden pad or playback-rate change.
class QueueAudio extends AudioWorkletProcessor {
 constructor(){
  super();this.queue=[];this.offset=0;this.queued=0;this.received=0;this.playing=false;this.consumed=0;this.underruns=0;this.reportAt=0;this.duration=180*44100;this.ceiling=180*44100;this.traceFrame=null;this.trace=[];this.capture=null;this.observerFrame=null;this.observerTrace=[];
  this.waitingPCM=null;this.waitingOffset=0;this.waitingCycles=0;
  this.port.onmessage=e=>this.message(e.data);
 }
 error(error){this.port.postMessage({error});}
 message(m){
  if(m.type==='waiting-loop'){
   if(this.playing||this.received||this.consumed||this.waitingPCM||!(m.pcm instanceof ArrayBuffer)||m.pcm.byteLength!==24*44100*8)
    return this.error('INVALID_WAITING_LOOP');
   const pcm=new Float32Array(m.pcm);
   for(const v of pcm)if(!Number.isFinite(v)||Math.abs(v)>1)return this.error('INVALID_WAITING_LOOP');
   this.waitingPCM=pcm;this.waitingOffset=0;this.waitingCycles=0;return;
  }
  if(m.type==='end-waiting-loop'){this.waitingPCM=null;this.waitingOffset=0;return;}
  if(this.waitingPCM&&m.type!=='stop')return this.error('WAITING_LOOP_NOT_ACTUAL_SOURCE');
  // Independent from cue ACK trace-frame; CURRENT observations cannot overwrite
  // an incoming STAGING cue's scheduled proof window or change queued samples.
  if(m.type==='observe-frame'){
   if(!Number.isSafeInteger(m.frame)||m.frame<0)return;
   const next=Math.max(m.frame,this.consumed+128);if(next+256>this.duration)return;
   this.observerFrame=next;this.observerTrace=[];
  }
  if(m.type==='trace-frame'){
   if(!Number.isSafeInteger(m.frame)||m.frame<this.consumed||m.frame+256>this.duration)return this.error('INVALID_TRACE_FRAME');
   this.traceFrame=m.frame;this.trace=[];
  }
  if(m.type==='set-duration'){
   if(this.playing||this.consumed||!Number.isInteger(m.frames)||m.frames<1||m.frames>180*44100)return this.error('INVALID_FINITE_DURATION');
   this.duration=m.frames;this.ceiling=m.frames;
  }
  if(m.type==='bound-duration'){
   if(!Number.isSafeInteger(m.frames)||m.frames<=this.consumed||m.frames<this.received||m.frames>this.duration)return this.error('INVALID_RENDER_DURATION_BOUND');
   this.duration=m.frames;
  }
  if(m.type==='replace-future'){
   // Validate the whole transaction before changing any queued sample or bound.
   const frames=m.pcm instanceof ArrayBuffer?m.pcm.byteLength/8:0;
   if(!this.playing||!Number.isSafeInteger(m.startFrame)||!Number.isSafeInteger(m.expectedReceived)||
      m.expectedReceived!==this.received||m.startFrame>this.received||m.startFrame<this.consumed+256||
      !Number.isSafeInteger(m.frames)||m.frames<=this.received||m.frames>this.ceiling||
      !Number.isSafeInteger(frames)||frames<1||frames!==m.frames-m.startFrame)
    return this.error('INVALID_FUTURE_REPLACEMENT');
   const pcm=new Float32Array(m.pcm);
   for(const value of pcm)if(!Number.isFinite(value)||Math.abs(value)>1)return this.error('INVALID_REPLACEMENT_PCM');
   const keep=m.startFrame-this.consumed,prefix=new Float32Array(keep*2);
   let copied=0;
   for(let i=0;i<this.queue.length&&copied<keep;i++){
    const q=this.queue[i],from=i===0?this.offset:0,n=Math.min(q.length/2-from,keep-copied);
    prefix.set(q.subarray(from*2,(from+n)*2),copied*2);copied+=n;
   }
   if(copied!==keep)return this.error('INCOMPLETE_FUTURE_PREFIX');
   this.queue=keep?[prefix,pcm]:[pcm];this.offset=0;this.received=m.frames;
   this.queued=m.frames-this.consumed;this.duration=m.frames;
  }
  if(m.type==='trace-output'){
   if(this.playing||this.received||this.duration>48*44100)return this.error('INVALID_FULL_RENDER_TRACE');
   this.capture=new Float32Array(this.duration*2);
  }
  if(m.type==='chunk'){
   if(m.startFrame!==this.received||!(m.pcm instanceof ArrayBuffer)||m.pcm.byteLength%8)return this.error('NONCONTIGUOUS_PCM');
   const pcm=new Float32Array(m.pcm),frames=pcm.length/2;
   if(!frames||this.received+frames>this.duration)return this.error('PCM_EXCEEDS_FINITE_RENDER');
   this.queue.push(pcm);this.received+=frames;this.queued+=frames;
  }
  if(m.type==='play')this.playing=true;
  if(m.type==='stop'){this.waitingPCM=null;this.playing=false;this.queue=[];this.queued=0;this.capture=null;this.observerFrame=null;this.observerTrace=[];this.report(true);}
 }
 report(stopped=false){this.port.postMessage({telemetry:{consumedFrames:this.consumed,underrunFrames:this.underruns,queuedFrames:this.queued,receivedFrames:this.received,sampleRate,outputContextTime:currentTime+128/sampleRate,stopped}});}
 process(_,outputs){
  const out=outputs[0],n=out[0].length;
  if(this.waitingPCM){
   for(let i=0;i<n;i++){
    out[0][i]=this.waitingPCM[this.waitingOffset*2];out[1][i]=this.waitingPCM[this.waitingOffset*2+1];
    if(++this.waitingOffset===this.waitingPCM.length/2){this.waitingOffset=0;this.waitingCycles++;}
   }
   // No actual-source frame counter, proof window, observation or credit.
   return true;
  }
  if(!this.playing)return true;
  for(let i=0;i<n;i++){
   if(this.consumed>=this.duration){this.playing=false;break;}
   const p=this.queue[0];
   if(p){out[0][i]=p[this.offset*2];out[1][i]=p[this.offset*2+1];this.offset++;this.queued--;if(this.offset>=p.length/2){this.queue.shift();this.offset=0;}}
   else this.underruns++;
   if(this.capture){this.capture[this.consumed*2]=out[0][i];this.capture[this.consumed*2+1]=out[1][i];}
   if(this.traceFrame!==null&&this.consumed>=this.traceFrame&&this.consumed<this.traceFrame+256){this.trace.push(out[0][i],out[1][i]);if(this.trace.length===512){const window=new Float32Array(this.trace);this.port.postMessage({playedWindow:{startFrame:this.traceFrame,pcm:window.buffer}},[window.buffer]);this.traceFrame=null;this.trace=[];}}
   if(this.observerFrame!==null&&this.consumed>=this.observerFrame&&this.consumed<this.observerFrame+256){this.observerTrace.push(out[0][i],out[1][i]);if(this.observerTrace.length===512){const window=new Float32Array(this.observerTrace);this.port.postMessage({observationWindow:{startFrame:this.observerFrame,pcm:window.buffer}},[window.buffer]);this.observerFrame=null;this.observerTrace=[];}}
   this.consumed++;
  }
  if(this.consumed===this.duration)this.playing=false;
  if(!this.playing&&this.capture){const pcm=this.capture.slice(0,this.consumed*2);this.capture=null;this.port.postMessage({playedRender:{frames:this.consumed,pcm:pcm.buffer}},[pcm.buffer]);}
  if(this.reportAt===0||this.consumed-this.reportAt>=44100/4||!this.playing){this.reportAt=this.consumed;this.report(!this.playing);}
  return true;
 }
}
registerProcessor('queue-audio',QueueAudio);
