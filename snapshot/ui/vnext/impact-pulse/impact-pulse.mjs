// Read-only visual consumer of a caller-owned audio clock. Never produces audio.
export const PROFILES=Object.freeze({
 A:Object.freeze({id:'A',attackSeconds:.045,releaseSeconds:.22,weakWeight:.60,strongWeight:.85,defaultZoomFraction:.035,defaultShakeFraction:0,defaultRotationDegrees:0}),
 B:Object.freeze({id:'B',attackSeconds:.030,releaseSeconds:.34,weakWeight:.30,strongWeight:1,defaultZoomFraction:.045,defaultShakeFraction:.012,defaultRotationDegrees:1}),
});
export function impactWave(delta,profile){
 if(!Number.isFinite(delta)||delta<0)return 0;
 if(delta<profile.attackSeconds)return Math.sin(delta/profile.attackSeconds*Math.PI/2)**2;
 const u=(delta-profile.attackSeconds)/profile.releaseSeconds;
 return u>=1-1e-12?0:(1-u)**2;
}
export function validateOnsets(timeline){
 if(timeline?.timingMode!=='MEASURED_OFFLINE_ONSETS'||timeline.beatGridVerified!==false||!Number.isFinite(timeline.durationSeconds)||!Array.isArray(timeline.events)||!/^[a-f0-9]{64}$/.test(timeline.sourceAudioSha256))throw Error('INVALID_MEASURED_ONSETS');
 let previous=-1;
 for(const e of timeline.events){if(!Number.isFinite(e.timeSeconds)||e.timeSeconds<0||e.timeSeconds<=previous||e.timeSeconds>=timeline.durationSeconds||typeof e.accent!=='boolean')throw Error('INVALID_ONSET_ORDER');previous=e.timeSeconds;}
 return timeline;
}
export function sampleImpact(timeline,time,profile){
 let value=0;
 for(const e of timeline.events){const delta=time-e.timeSeconds;if(delta<0)break;if(delta>profile.attackSeconds+profile.releaseSeconds)continue;value=Math.max(value,impactWave(delta,profile)*(e.accent?profile.strongWeight:profile.weakWeight));}
 return value; // Max-overlap: accents never add up to an uncontrolled large zoom.
}
export function sampleKick(timeline,time){
 let value=0,largest=0;
 for(const e of timeline.events){const delta=time-e.timeSeconds;if(delta<0)break;if(!e.accent||delta>.15)continue;const envelope=impactWave(delta,{attackSeconds:.015,releaseSeconds:.135});if(envelope>largest){largest=envelope;value=envelope*Math.cos(delta*Math.PI*2/.075)*(e.index%2?1:-1);}}
 return value;
}
export function createImpactPulse({adapter,readAudioTime,isAudioPlaying,timeline,readProfile=()=> 'A',readPulseStrength=()=>.6,readZoomFraction=()=>.035,readShakeFraction=()=>0,readRotationDegrees=()=>0,requestFrame=requestAnimationFrame,cancelFrame=cancelAnimationFrame}){
 validateOnsets(timeline);let running=false,disposed=false,handle=null,lastTime=null,lastEvent=-1,lastWall=null;const original=new Map();
 const metrics={source:'measured-fixed-audio-onsets',pulseProfile:'centered-asymmetric-impact-v1',profileId:'A',timingMode:timeline.timingMode,beatGridVerified:false,meterVerified:false,bpmOnlyUsedForPulse:false,measuredTimelineOfflineLookahead:true,sourceAudioSha256:timeline.sourceAudioSha256,translationApplied:false,rotationApplied:false,nonUniformScaleApplied:false,edgeOverlayPulseApplied:false,hardMaximumZoomFraction:.03,currentScale:1,maximumObservedScale:1,maximumScaleStep:0,pulseStrength:0,zoomFraction:0,frameUpdates:0,rawDeckTransforms:0,bakedDeckSuppressions:0,onsetNotifications:0,strongOnsetNotifications:0,beatNotifications:0,missedBeatBoundaries:0,missedOnsetNotifications:0,maximumOnsetDelaySeconds:0,maximumRafGapMs:0,clockResets:0,speakerToDisplaySyncMeasured:false};
 function remember(element){if(!original.has(element))original.set(element,{transform:element.style.transform??'',transformOrigin:element.style.transformOrigin??''});}
 function update(){
  if(disposed)return Object.freeze({...metrics});const time=readAudioTime(),playing=!!isAudioPlaying(),valid=Number.isFinite(time)&&time>=0;const wall=performance.now();if(lastWall!==null)metrics.maximumRafGapMs=Math.max(metrics.maximumRafGapMs,wall-lastWall);lastWall=wall;
  if(valid&&lastTime!==null&&time<lastTime-.1){lastEvent=-1;metrics.clockResets++;}
  const profile=PROFILES[readProfile()];if(!profile)throw Error('UNKNOWN_IMPACT_PROFILE');
  if(valid&&playing)for(let i=lastEvent+1;i<timeline.events.length&&timeline.events[i].timeSeconds<=time;i++){const e=timeline.events[i],late=time-e.timeSeconds;metrics.maximumOnsetDelaySeconds=Math.max(metrics.maximumOnsetDelaySeconds,late);if(late>.1)metrics.missedOnsetNotifications++;else{metrics.onsetNotifications++;if(e.accent)metrics.strongOnsetNotifications++;}lastEvent=i;}
  const rawStrength=readPulseStrength(),rawFraction=readZoomFraction(),strength=Number.isFinite(rawStrength)?Math.max(0,Math.min(1,rawStrength)):0,fraction=Number.isFinite(rawFraction)?Math.max(0,Math.min(.045,rawFraction)):0;
  const zoom=valid&&playing&&strength>0&&fraction>0?Math.min(.03,strength*fraction*sampleImpact(timeline,time,profile)):0;const previous=metrics.currentScale;
  const kick=valid&&playing&&strength>0&&profile.id==='B'?sampleKick(timeline,time):0,shake=Math.max(0,Math.min(.012,Number(readShakeFraction())||0))*strength*kick,rotation=Math.max(0,Math.min(1,Number(readRotationDegrees())||0))*strength*kick;
  metrics.translationApplied=metrics.translationApplied||shake!==0;metrics.rotationApplied=metrics.rotationApplied||rotation!==0;metrics.currentTranslateFraction=shake;metrics.currentRotationDegrees=rotation;metrics.maximumObservedTranslateFraction=Math.max(metrics.maximumObservedTranslateFraction??0,Math.abs(shake));metrics.maximumObservedRotationDegrees=Math.max(metrics.maximumObservedRotationDegrees??0,Math.abs(rotation));metrics.kickDurationSeconds=.15;metrics.fullFieldBrightnessModulation=false;metrics.accentMeaning='high measured onset energy; metrical strong beat unverified';
  metrics.currentScale=1+zoom;metrics.maximumObservedScale=Math.max(metrics.maximumObservedScale,1+zoom);metrics.maximumScaleStep=Math.max(metrics.maximumScaleStep,Math.abs(metrics.currentScale-previous));metrics.profileId=profile.id;metrics.attackSeconds=profile.attackSeconds;metrics.releaseSeconds=profile.releaseSeconds;metrics.pulseStrength=strength;metrics.zoomFraction=fraction;
  for(const deck of adapter.getPlaybackState().decks){const element=deck.element;remember(element);if(deck.clip?.pulseMode==='raw'&&(deck.visible||deck.role==='incoming')){element.style.transformOrigin='50% 50%';element.style.transform=shake!==0||rotation!==0?`translate(${(shake*100).toFixed(6)}%,0) rotate(${rotation.toFixed(6)}deg) scale(${(1+zoom).toFixed(6)})`:`scale(${(1+zoom).toFixed(6)})`;metrics.rawDeckTransforms++;}else{Object.assign(element.style,original.get(element));if(deck.clip?.pulseMode==='baked')metrics.bakedDeckSuppressions++;}}
  lastTime=valid?time:null;metrics.frameUpdates++;return Object.freeze({...metrics});
 }
 function frame(){handle=null;if(!running||disposed)return;try{update();}catch{}if(running&&!disposed)handle=requestFrame(frame);}
 function start(){if(disposed||running)return;running=true;handle=requestFrame(frame);}
 function stop(){running=false;if(handle!==null)cancelFrame(handle);handle=null;lastWall=null;}
 function dispose(){if(disposed)return;stop();disposed=true;for(const [element,style] of original)Object.assign(element.style,style);original.clear();}
 return Object.freeze({start,stop,dispose,update,getMetrics:()=>Object.freeze({...metrics})});
}
