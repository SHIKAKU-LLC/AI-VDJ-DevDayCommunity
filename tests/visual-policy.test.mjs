import test from 'node:test';
import assert from 'node:assert/strict';
import {TECHNICAL_VISUAL_POLICY,assessTechnicalVisual} from '../integration/qc/visual-policy.mjs';
const measured=()=>({decodedFrames:125,technicalStats:{method:'full-frame-luma-motion-v1',frames:125,
 nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.01,maximumLargeLumaTransitionsPerSecond:0}});
test('technical visual policy screens measured frames without claiming artistic review',()=>{
 assert.equal(assessTechnicalVisual(measured()).passed,true);assert.equal(TECHNICAL_VISUAL_POLICY.id,'prototype-visual-technical-v1');
});
test('missing, static, near-uniform and rapid-flash measurements stay HOLD',()=>{
 assert.equal(assessTechnicalVisual({}).passed,false);
 for(const [key,value]of [['meanMotion',0],['nearBlackFraction',1],['nearWhiteFraction',1],['maximumLargeLumaTransitionsPerSecond',3]]){
  const m=measured();m.technicalStats[key]=value;assert.equal(assessTechnicalVisual(m).passed,false);
 }
});
