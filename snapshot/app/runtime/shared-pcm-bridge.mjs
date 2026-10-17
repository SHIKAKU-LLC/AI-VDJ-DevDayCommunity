import {createHash} from 'node:crypto';
const frame=n=>Number.isSafeInteger(n)&&n>=0;
const hash=h=>/^[a-f0-9]{64}$/.test(h??'');
const pcmBytes=(a,start,frames)=>Buffer.from(a.pcm.buffer,a.pcm.byteOffset+start*8,frames*8);
const digest=b=>createHash('sha256').update(b).digest('hex');

// Narrow alternative to independent musical mixing: an unchanged branch switch
// INSIDE a directly verified common passage. No tempo/key/phrase is inferred.
export function sharedPCMContract(q) {
 const p=q?.sharedPCM;
 return q?.type==='shared-pcm-bridge'&&q.sampleRate===44100&&q.overlapFrames===0
  &&(q.seamDeclickFrames??0)===0&&q.relativeIncomingGainDb===0&&q.eqCurves===null
  &&p?.method==='exact-shared-stereo-pcm-v1'&&p.sampleFormat==='float32-le-stereo'
  &&p.currentSha256===q.currentSha256&&p.incomingSha256===q.incomingSha256
  &&q.currentSha256!==q.incomingSha256&&p.sampleRate===44100
  &&frame(p.currentStartFrame)&&frame(p.incomingStartFrame)&&frame(p.frameCount)
  &&p.frameCount>=4*44100&&hash(p.currentPcmSha256)&&p.currentPcmSha256===p.incomingPcmSha256
  &&frame(q.entryFrame)&&frame(q.exitFrame)
  &&q.exitFrame-p.currentStartFrame===q.entryFrame-p.incomingStartFrame
  &&q.exitFrame-p.currentStartFrame>=2*44100
  &&p.currentStartFrame+p.frameCount-q.exitFrame>=2*44100
  &&p.currentStartFrame+p.frameCount<=q.currentFrameCount
  &&p.incomingStartFrame+p.frameCount<=q.incomingFrameCount
  &&Number.isFinite(p.minimumWindowDbfs)&&p.minimumWindowDbfs>=-45
  &&p.exactSampleEquality===true&&p.channels===2;
}

export function verifySharedPCMBridge({current,incoming,receipt}) {
 if(!sharedPCMContract(receipt)||current?.sha256!==receipt.currentSha256||incoming?.sha256!==receipt.incomingSha256
  ||current?.rate!==44100||incoming?.rate!==44100||current.frames!==receipt.currentFrameCount||incoming.frames!==receipt.incomingFrameCount)
  return {valid:false,reason:'SHARED_PCM_CONTRACT_REQUIRED'};
 const p=receipt.sharedPCM;
 const a=pcmBytes(current,p.currentStartFrame,p.frameCount),b=pcmBytes(incoming,p.incomingStartFrame,p.frameCount);
 if(!a.equals(b)||digest(a)!==p.currentPcmSha256||digest(b)!==p.incomingPcmSha256)
  return {valid:false,reason:'SHARED_PCM_SAMPLES_CHANGED'};
 // Recompute activity: matching digital silence is not a musical bridge.
 let minimum=Infinity;
 for(let start=0;start<p.frameCount;start+=4410){
  const end=Math.min(start+4410,p.frameCount);let power=0;
  for(let i=start;i<end;i++)for(let c=0;c<2;c++)power+=current.pcm[(p.currentStartFrame+i)*2+c]**2;
  minimum=Math.min(minimum,10*Math.log10(Math.max(power/((end-start)*2),1e-30)));
 }
 if(minimum < -45||Math.abs(minimum-p.minimumWindowDbfs)>1e-5)return {valid:false,reason:'SHARED_PCM_ACTIVITY_REQUIRED'};
 return {valid:true,reason:'EXACT_SHARED_PCM_BRIDGE',minimumWindowDbfs:minimum,sharedSeconds:p.frameCount/44100};
}
