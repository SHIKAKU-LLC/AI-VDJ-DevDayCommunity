// Provider outpainting reconstructs the conditioning region. This contract
// records actual sample ranges; it never asserts bit-identical returned PCM.
const hash=v=>/^[a-f0-9]{64}$/.test(v??'');
const frame=v=>Number.isSafeInteger(v)&&v>=0;
export function validConditionedContinuation(p,{rawSha256,parentSha256,contextSha256,cueSha256}={}){
 return !!p&&p.kind==='measured-provider-conditioned-cue-v1'&&
  [p.rawSha256,p.parentSha256,p.contextSha256,p.cueSha256].every(hash)&&
  (!rawSha256||p.rawSha256===rawSha256)&&(!parentSha256||p.parentSha256===parentSha256)&&
  (!contextSha256||p.contextSha256===contextSha256)&&(!cueSha256||p.cueSha256===cueSha256)&&
  p.sampleRate===44100&&p.rawFrameCount===40*44100&&p.cueFrameCount===24*44100&&
  [p.rawStartFrame,p.rawEndFrame,p.contextOverlapFrames,p.newTimelineFrames].every(frame)&&
  p.rawEndFrame-p.rawStartFrame===p.cueFrameCount&&p.rawEndFrame<=p.rawFrameCount&&
  p.contextOverlapFrames===Math.max(0,16*44100-p.rawStartFrame)&&p.contextOverlapFrames<=4*44100&&
  p.newTimelineFrames===p.cueFrameCount-p.contextOverlapFrames&&p.newTimelineFrames>=20*44100&&
  Number.isFinite(p.conditioningCorrelation)&&p.conditioningCorrelation>=.9&&p.conditioningCorrelation<=1&&
  (p.contextOverlapFrames===0||Number.isFinite(p.overlapCorrelation)&&p.overlapCorrelation>=.9&&p.overlapCorrelation<=1)&&
  Number.isFinite(p.gainDb)&&p.gainDb<=0&&p.gainDb>=-30&&
  p.timeStretch===false&&p.pitchShift===false&&p.padding===false&&p.looping===false&&
  p.bitIdenticalPrefixClaimed===false&&p.clippingWaveformReconstructed===false;
}
