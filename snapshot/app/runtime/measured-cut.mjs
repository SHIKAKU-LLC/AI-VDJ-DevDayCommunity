// An objective, pair-specific nonoverlap edit. It does not claim a beat grid,
// harmonic blend or native parent relationship. All PCM gates still apply.
export const MEASURED_CUT_POLICY='objective-nonoverlap-no-musical-grid-claim-v1';
export function measuredCutContract(q){
 return q?.type==='measured-nonoverlap-cut'&&q.measuredCutPolicy===MEASURED_CUT_POLICY&&
  q.entryFrame===0&&q.exitFrame===q.currentFrameCount&&q.overlapFrames===0&&q.eqCurves===null&&
  q.relativeIncomingGainDb===0&&Number.isSafeInteger(q.seamDeclickFrames)&&q.seamDeclickFrames>0&&
  q.seamDeclickFrames<=882&&q.seamDeclickFrames%2===0&&q.nativeContinuationVerified===false&&
  q.beatGridVerified===false&&q.downbeatVerified===false&&q.phraseVerified===false&&
  q.timeStretch===false&&q.pitchShift===false;
}

// An objective, pair-specific overlap crossfade that ends exactly at the
// current Cue's last frame and starts the incoming Cue at frame 0. Low
// frequencies swap owners once (single bass owner); highs follow an
// equal-power curve. Like the cut, it claims no beat grid, harmonic blend or
// native parent relationship, and every rendered-PCM gate still applies.
// Generated Cues usually fade out over their last second, which a cut at
// the final frame cannot pass (level step); the overlap carries through it.
export const MEASURED_CROSSFADE_POLICY='objective-overlap-crossfade-no-musical-grid-claim-v1';
export const MEASURED_CROSSFADE_FRAMES=3*44100;
export function measuredCrossfadeContract(q){
 const n=q?.overlapFrames;
 return q?.type==='measured-overlap-crossfade'&&q.measuredCrossfadePolicy===MEASURED_CROSSFADE_POLICY&&
  Number.isSafeInteger(n)&&n>=2*44100&&n<=4*44100&&n%2===0&&
  q.entryFrame===n/2&&q.exitFrame===q.currentFrameCount-n/2&&Array.isArray(q.eqCurves)&&q.eqCurves.length===5&&
  q.relativeIncomingGainDb===0&&(q.seamDeclickFrames??0)===0&&q.nativeContinuationVerified===false&&
  q.beatGridVerified===false&&q.downbeatVerified===false&&q.phraseVerified===false&&
  q.timeStretch===false&&q.pitchShift===false;
}
// Either objective, pair-specific measured join.
export const measuredJoinContract=q=>measuredCutContract(q)||measuredCrossfadeContract(q);
