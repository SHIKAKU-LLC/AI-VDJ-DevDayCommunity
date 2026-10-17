// Prototype technical screening, not an artistic judgment or health guarantee.
// These thresholds are code-owned; a participant request cannot change them.
export const TECHNICAL_VISUAL_POLICY = Object.freeze({id:'prototype-visual-technical-v1',
  maximumUniformFraction:.98,minimumMeanMotion:.0002,maximumLargeLumaTransitionsPerSecond:2});
export function assessTechnicalVisual(measurement) {
  const stats=measurement?.technicalStats,reasons=[];
  if(stats?.method!=='full-frame-luma-motion-v1'||stats.frames!==measurement?.decodedFrames||stats.frames<2||
    !['nearBlackFraction','nearWhiteFraction','meanMotion'].every(k=>Number.isFinite(stats?.[k])&&stats[k]>=0&&stats[k]<=1)||
    !Number.isSafeInteger(stats?.maximumLargeLumaTransitionsPerSecond)||stats.maximumLargeLumaTransitionsPerSecond<0)
    reasons.push('FULL_FRAME_TECHNICAL_MEASUREMENTS_REQUIRED');
  else {
    if(stats.nearBlackFraction>=TECHNICAL_VISUAL_POLICY.maximumUniformFraction||stats.nearWhiteFraction>=TECHNICAL_VISUAL_POLICY.maximumUniformFraction)
      reasons.push('UNIFORM_BLACK_OR_WHITE_VIDEO');
    if(stats.meanMotion<TECHNICAL_VISUAL_POLICY.minimumMeanMotion)reasons.push('STATIC_VIDEO_HOLD');
    if(stats.maximumLargeLumaTransitionsPerSecond>TECHNICAL_VISUAL_POLICY.maximumLargeLumaTransitionsPerSecond)
      reasons.push('RAPID_LUMA_TRANSITIONS_HOLD');
  }
  return{passed:reasons.length===0,reasons,policyId:TECHNICAL_VISUAL_POLICY.id};
}
