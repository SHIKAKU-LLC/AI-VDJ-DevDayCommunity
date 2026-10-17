// Runtime-neutral admission checks. Native decode/DSP and trust are injected;
// no fetch, provider calls, credentials, browser globals or storage side effects.
import {TECHNICAL_VISUAL_POLICY,assessTechnicalVisual} from './visual-policy.mjs';
import {validConditionedContinuation} from './conditioned-continuation.mjs';
export const QC_VERSION = 'portable-media-qc-v1';
export const LIMITS = Object.freeze({cueSeconds:24, durationTolerance:.15, sampleRate:44100, channels:2,
  truePeakDbtp:-.3, sourceClippedFraction:.001, sourceQuietRun:.5, sourceSilenceDbfs:-45,
  renderQuietRun:.15, renderMinimumDbfs:-45, levelStepDb:6, seamJump:.15, lowBandLiftDb:3});
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const finite = Number.isFinite;
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
export async function digest(value) {return sha256(new TextEncoder().encode(JSON.stringify(canonical(value))));}
export async function sha256(bytes) {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
}
export function validBinding(b,channel) {
  return b && ['roomId','submissionId','generationId'].every(k=>id(b[k])) && hash(b.commonIntentSha256)
    && integer(b.controlVersion) && b.controlVersion>0 && b.channel===channel;
}
const only = (v,keys) => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k=>keys.includes(k));
const equal = (a,b) => JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const bindingKeys = b => b && Object.fromEntries(['roomId','submissionId','generationId','commonIntentSha256','controlVersion','channel'].map(k=>[k,b[k]]));
function copyBytes(v) {
  if (!(v instanceof Uint8Array) || !v.byteLength || v.byteLength>64*1024*1024) throw Error('BOUNDED_AUTHORIZED_BYTES_REQUIRED');
  return new Uint8Array(v); // isolate caller mutation while async inspectors run
}
const fresh = (m,input) => m?.method===QC_VERSION && m.inputDigest===input;
function sourceMetrics(p) {
  const reasons=[];
  if(p?.method!=='pcm-endpoint-profile-v1'||p.sampleRate!==44100||p.channels!==2||!integer(p.frameCount)||p.frameCount<1
    ||!finite(p.rmsDbfs)||p.rmsDbfs<LIMITS.sourceSilenceDbfs||!finite(p.clippedFraction)||p.clippedFraction<0||p.clippedFraction>LIMITS.sourceClippedFraction
    ||p.nonfiniteSamples!==0||!finite(p.activity?.maxQuietRunSeconds)||p.activity.maxQuietRunSeconds<0
    ||p.activity.maxQuietRunSeconds>LIMITS.sourceQuietRun||p.activity.effectiveSilence!==false
    ||!finite(p.loudness?.truePeakDbtp)||p.loudness.truePeakDbtp>LIMITS.truePeakDbtp
    ||!finite(p.loudness?.integratedLufs)||!finite(p.loudness?.loudnessRangeLu)) reasons.push('SOURCE_AUDIO_QC_FAILED');
  for(const w of [p?.head,p?.tail]) if(!finite(w?.rmsDbfs)||!Array.isArray(w?.bandFractions)||w.bandFractions.length!==3
    ||w.bandFractions.some(x=>!finite(x)||x<0||x>1)||Math.abs(w.bandFractions.reduce((a,b)=>a+b,0)-1)>.02) reasons.push('ENDPOINT_PROFILE_REQUIRED');
  return reasons;
}
function renderMetrics(r) {
 const m=r?.renderMetrics;
 return r?.method==='rendered-transition-qc-v1' && r.renderQC?.passed===true && r.passed===true
  && r.timeStretch===false&&r.pitchShift===false&&m&&finite(m.truePeakDbtp)&&m.truePeakDbtp<=LIMITS.truePeakDbtp
  &&m.clippedFraction===0&&m.nonfiniteSamples===0&&m.bassDoubleOwnershipFrames===0
  &&finite(m.maxQuietRunSeconds)&&m.maxQuietRunSeconds>=0&&m.maxQuietRunSeconds<=LIMITS.renderQuietRun
  &&finite(m.minimumWindowDbfs)&&m.minimumWindowDbfs>=LIMITS.renderMinimumDbfs
  &&finite(m.maxLevelStepDb)&&m.maxLevelStepDb>=0&&m.maxLevelStepDb<=LIMITS.levelStepDb
  &&finite(m.seamJump)&&m.seamJump>=0&&m.seamJump<=LIMITS.seamJump
  &&finite(m.overlapLowBandLiftDb)&&m.overlapLowBandLiftDb<=LIMITS.lowBandLiftDb
  &&finite(m.integratedLufs)&&finite(m.loudnessRangeLu);
}
function result(binding,assetId,reasons,extra={},synthetic=false,generated=true) {
 const passed=reasons.length===0;
 return {binding:bindingKeys(binding),status:passed?(synthetic?'SYNTHETIC_QC_READY':generated?'QC_READY':'SAVED_QC_READY'):'HOLD',
  asset:{assetId,sha256:null},durationSeconds:null,...extra,
  qc:{passed,reasons:[...new Set(reasons)],scope:QC_VERSION},fixtureBinding:synthetic,
  actualGenerationThisRun:passed&&!synthetic&&generated};
}
// Callbacks must be server-owned. Hashes bind evidence; they do not authenticate
// an untrusted JSON receipt, prove provider origin or replace owner review.
export function createPortableQC({inspectAudio,inspectVideo,verifyProvenance,verifyReview,verifyCurrentSource,visualPolicy=null}={}) {
 if(visualPolicy!==null&&!equal(visualPolicy,TECHNICAL_VISUAL_POLICY))throw Error('UNKNOWN_VISUAL_POLICY');
 async function origin(provenance,request,reasons,allowSaved=false) {
  let proof;try{proof=await verifyProvenance?.(provenance,structuredClone(request));}catch{ /* fail closed */ }
  if(!proof || !(allowSaved?['provider','synthetic','saved','owner-supplied-bootstrap-video']:['provider','synthetic']).includes(proof.kind) || proof.verified!==true
    ||!equal(proof.binding,request.binding)||proof.rawSha256!==request.rawSha256||proof.byteLength!==request.byteLength
    ||proof.sourceSha256!==request.sourceSha256
    ||(proof.kind==='owner-supplied-bootstrap-video'?(!id(proof.admissionId)||!hash(proof.admissionEvidenceSha256)||
      !hash(proof.originalBindingSha256)||proof.actualGenerationThisRun!==false||proof.originalGenerationId!==undefined||
      ['requestId','operationId','resultSha256','modelId'].some(k=>proof[k]!==undefined)):
      proof.kind==='saved'?(!id(proof.originalGenerationId)||!hash(proof.originalBindingSha256)):
      (!id(proof.requestId)||!id(proof.operationId)||!hash(proof.resultSha256)
       ||proof.modelId!==(request.binding?.channel==='music'?'fal-ai/stable-audio-3/medium/audio-outpainting':'minimax/h3-max/image-to-video')))) reasons.push('TRUSTED_BYTE_ORIGIN_REQUIRED');
  return proof;
 }
 async function current(source,reasons) {
  let ok=false;try{ok=await verifyCurrentSource?.(structuredClone(source));}catch{}
  if(ok!==true) reasons.push('CURRENT_SOURCE_CHANGED_OR_UNVERIFIED');
 }
 function binding(input,channel,reasons) {
  if(!validBinding(input.binding,channel)||!validBinding(input.expectedBinding,channel)
    ||!equal(bindingKeys(input.binding),bindingKeys(input.expectedBinding))) reasons.push('SAME_GENERATION_BINDING_REQUIRED');
  if(!id(input.assetId))reasons.push('ASSIGNED_ASSET_ID_REQUIRED');
 }
 return {
  async audio(input={}) {
   input=structuredClone(input);
   const reasons=[];binding(input,'music',reasons);let bytes,source,context;
   try{bytes=copyBytes(input.bytes);source=copyBytes(input.source?.bytes);context=copyBytes(input.source?.contextBytes);}catch(e){return {media:result(input.binding,input.assetId,[...reasons,e.message]),cueBytes:null};}
   const b=bindingKeys(input.binding),rawSha256=await sha256(bytes),parentSha256=await sha256(source),contextSha256=await sha256(context);
   const parent={clipId:input.source.clipId,sha256:parentSha256,contextSha256,playbackRevision:input.source.playbackRevision};
   if(!id(parent.clipId)||!integer(parent.playbackRevision)||parentSha256!==input.source.sha256||contextSha256!==input.source.contextSha256
      ||!equal(parent,input.expectedSource)) reasons.push('CURRENT_PARENT_CONTEXT_BINDING_REQUIRED');
   if(rawSha256!==input.sha256) reasons.push('ACTUAL_BYTE_HASH_MISMATCH');
   const proof=await origin(input.provenance,{binding:b,rawSha256,byteLength:bytes.length,sourceSha256:contextSha256},reasons);
   await current(parent,reasons);
   const layout=input.layout??'tail-only';
   if(!['tail-only','context-plus-tail'].includes(layout)) reasons.push('EXPLICIT_AUDIO_LAYOUT_REQUIRED');
   const request={binding:b,rawSha256,parentSha256,contextSha256,layout,playbackRevision:parent.playbackRevision};
   const inputDigest=await digest(request);let m;
   if(!reasons.length)try{m=await inspectAudio?.({bytes,sourceBytes:source,contextBytes:context,inputDigest,layout,playbackRevision:parent.playbackRevision});}catch{reasons.push('AUDIO_DECODE_OR_DSP_FAILED');}
   if(!fresh(m,inputDigest)||m.rawSha256!==rawSha256||m.parentSha256!==parentSha256||m.contextSha256!==contextSha256) reasons.push('FRESH_BOUND_AUDIO_MEASUREMENT_REQUIRED');
   let cueBytes,assetSha;
   if(m)try{cueBytes=copyBytes(m.cueBytes);assetSha=await sha256(cueBytes);}catch{reasons.push('ACTUAL_CUE_BYTES_REQUIRED');}
   const p=m?.profile,r=m?.transition;
   if(m){reasons.push(...sourceMetrics(p));
    if(!hash(assetSha)||p?.assetSha256!==assetSha||m.cueSha256!==assetSha||p?.frameCount!==24*44100) reasons.push('ACTUAL_24_SECOND_TAIL_REQUIRED');
    const conditioned=proof?.kind==='provider'&&layout==='context-plus-tail'&&validConditionedContinuation(m.conditionedContinuation,{rawSha256,parentSha256,contextSha256,cueSha256:assetSha});
    if(m.contextMatchesCurrentTail!==true||m.contextFrameCount!==16*44100||(!conditioned&&m.contextPrefixMatches!==true)) reasons.push('EXACT_PARENT_CONTEXT_PCM_REQUIRED');
    const spec={type:r?.type,entryFrame:r?.entryFrame,exitFrame:r?.exitFrame,overlapFrames:r?.overlapFrames,sampleRate:r?.sampleRate,relativeIncomingGainDb:r?.relativeIncomingGainDb,eqCurves:r?.eqCurves??null};
    const overlap=conditioned?m.conditionedContinuation.contextOverlapFrames:0;
    const lineage=conditioned?r.nativeContinuationVerified===false&&r.conditionedContinuationSha256===await digest(m.conditionedContinuation)&&
      r.type===(overlap?'conditioned-context-overlap':'conditioned-continuation'):
      r.nativeContinuationVerified===true&&r.type==='native-continuation';
    if(!renderMetrics(r)||!lineage||r.currentSha256!==parentSha256||r.incomingSha256!==assetSha||r.parentSha256!==parentSha256
      ||r.contextSha256!==contextSha256||r.currentPlaybackRevision!==parent.playbackRevision
      ||r.contextAnchorFrame!==m.parentFrameCount||r.currentFrameCount!==m.parentFrameCount||r.incomingFrameCount!==24*44100
      ||r.entryFrame!==overlap/2||r.exitFrame!==m.parentFrameCount-overlap/2||r.overlapFrames!==overlap
      ||(r.seamDeclickFrames??0)!==0||r.relativeIncomingGainDb!==0||r.sampleRate!==44100||(!overlap&&r.eqCurves!==null)
      ||r.renderedFrameCount!==m.parentFrameCount+24*44100-overlap||r.renderSpecSha256!==await digest(spec)||!hash(r.renderedSha256)) reasons.push('BOUND_NATIVE_TRANSITION_QC_REQUIRED');
   }
   await current(parent,reasons);
   const out=result(b,input.assetId,reasons,{asset:{assetId:input.assetId,sha256:assetSha??null},durationSeconds:p?.frameCount/44100||null,
     parentClipId:parent.clipId,contextSha256,contextVerified:!reasons.length,continuationVerified:!reasons.length,
     profile:p??null,transitionEvidence:r??null,...(m?.conditionedContinuation?{conditionedContinuation:structuredClone(m.conditionedContinuation)}:{}),rawSha256,measurementDigest:inputDigest,provenanceKind:proof?.kind??'unverified',providerReceipt:proof?.kind==='provider'?{requestId:proof.requestId,resultSha256:proof.resultSha256,operationId:proof.operationId}:null},proof?.kind==='synthetic',proof?.kind==='provider');
   // Raw/cue bytes stay outside JSON and must be saved by the integration owner.
   return {media:out,cueBytes:out.qc.passed?cueBytes:null,renderBytes:out.qc.passed?m?.renderBytes??null:null};
  },
  async video(input={}) {
   input=structuredClone(input);
   const reasons=[];binding(input,'video',reasons);const b=bindingKeys(input.binding);
   // Approved manifest is preserved, never expanded/reordered by this adapter.
   const manifest=structuredClone(input.manifest),referenceSha256=input.referenceSha256;
   if(!Array.isArray(input.clips)) {input.clips=[];reasons.push('ACTUAL_VIDEO_CLIPS_REQUIRED');}
   if(!hash(referenceSha256)||manifest?.version!=='accepted-video-timeline-v1'||manifest.durationSeconds!==24
     ||manifest.width!==1280||manifest.height!==720||manifest.fit!=='contain'||manifest.muted!==true||!Array.isArray(manifest.segments)||!manifest.segments.length
     ||manifest.segments.length>128||!Array.isArray(manifest.clips)||!manifest.clips.length||manifest.clips.length>32) reasons.push('ACCEPTED_24_SECOND_TIMELINE_REQUIRED');
   const manifestShape=only(manifest,['version','durationSeconds','width','height','fit','muted','clips','segments'])
     &&Array.isArray(manifest.clips)&&manifest.clips.every(c=>only(c,['clipId','sha256','durationSeconds']))
     &&Array.isArray(manifest.segments)&&manifest.segments.every(s=>only(s,['clipId','startSeconds','endSeconds','inSeconds','outSeconds','overlapSeconds','transition']));
   if(!manifestShape)reasons.push('CANONICAL_TIMELINE_SCHEMA_REQUIRED');
   const manifestSha256=await digest(manifest??null),clips=[],seen=new Set();
   let synthetic=false;let generated=false;let providerReceipt=null;
   for(const c of (Array.isArray(manifest?.clips)?manifest.clips.slice(0,32):[])) {
    if(!id(c.clipId)||seen.has(c.clipId)||!hash(c.sha256)) {reasons.push('UNIQUE_CLIP_IDENTITY_REQUIRED');continue;}seen.add(c.clipId);
    let bytes;try{bytes=copyBytes(input.clips?.find(x=>x.clipId===c.clipId)?.bytes);}catch{reasons.push('ACTUAL_VIDEO_CLIP_BYTES_REQUIRED');continue;}
    const actualSha=await sha256(bytes);if(actualSha!==c.sha256)reasons.push('ACTUAL_VIDEO_BYTE_HASH_MISMATCH');
    const proof=await origin(input.clips.find(x=>x.clipId===c.clipId)?.provenance,{binding:b,rawSha256:actualSha,byteLength:bytes.length,sourceSha256:referenceSha256},reasons,true);
    if(proof?.kind==='provider'){generated=true;providerReceipt??={requestId:proof.requestId,resultSha256:proof.resultSha256,operationId:proof.operationId};}
    synthetic ||= proof?.kind==='synthetic';
    const request={binding:b,rawSha256:actualSha,referenceSha256,manifestSha256},inputDigest=await digest(request);let m;
    try{m=await inspectVideo?.({bytes,inputDigest});}catch{reasons.push('VIDEO_DECODE_FAILED');}
    if(!fresh(m,inputDigest)||m.rawSha256!==actualSha||m.fullyDecoded!==true||!integer(m.decodedFrames)||m.decodedFrames<1
      ||!finite(m.durationSeconds)||m.durationSeconds<=0||!integer(m.width)||!integer(m.height)||m.width<1||m.height<1)reasons.push('FRESH_FULL_VIDEO_DECODE_REQUIRED');
    if(m&&(!finite(c.durationSeconds)||Math.abs(m.durationSeconds-c.durationSeconds)>.1))reasons.push('CLIP_DURATION_MISMATCH');
    clips.push({...c,measurement:m??null,provenanceKind:proof?.kind??'unverified',originalGenerationId:proof?.originalGenerationId??null,
     ...(proof?.kind==='owner-supplied-bootstrap-video'?{ownerAdmission:{admissionId:proof.admissionId,
      admissionEvidenceSha256:proof.admissionEvidenceSha256,originalBindingSha256:proof.originalBindingSha256,
      actualGenerationThisRun:false}}:{}),
     providerReceipt:proof?.kind==='provider'?{requestId:proof.requestId,resultSha256:proof.resultSha256,operationId:proof.operationId}:null});
   }
   let end=0,previousStart=0,previousPreviousEnd=0;
   for(const [i,s] of ((Array.isArray(manifest?.segments)?manifest.segments.slice(0,128):[])).entries()) {
    const c=clips.find(c=>c.clipId===s.clipId),overlap=s.overlapSeconds??0;
    if(!c||![s.startSeconds,s.endSeconds,s.inSeconds,s.outSeconds,overlap].every(finite)||s.inSeconds<0||s.outSeconds<=s.inSeconds
      ||s.outSeconds>(c?.measurement?.durationSeconds??0)+1e-6||s.startSeconds<0||s.endSeconds<=s.startSeconds||s.endSeconds>24+1e-6
      ||Math.abs((s.endSeconds-s.startSeconds)-(s.outSeconds-s.inSeconds))>1e-6||overlap<0||overlap>=s.endSeconds-s.startSeconds
      ||(i===0?(s.startSeconds!==0||overlap!==0):Math.abs(s.startSeconds-(end-overlap))>1e-6)
      ||i>0&&(s.startSeconds<previousStart||s.startSeconds<previousPreviousEnd-1e-6)
      ||!['cut','crossfade'].includes(s.transition)||s.transition==='cut'&&overlap!==0||s.transition==='crossfade'&&overlap<=0)
       reasons.push('INCOMPLETE_OR_INVALID_VISUAL_TIMELINE');
    previousPreviousEnd=end;previousStart=s.startSeconds;end=s.endSeconds;
   }
   if(Math.abs(end-24)>1e-6)reasons.push('FINISHED_CUE_NOT_24_SECONDS');
   const used=new Set((Array.isArray(manifest?.segments)?manifest.segments:[]).map(s=>s.clipId));
   if(clips.some(c=>!used.has(c.clipId)))reasons.push('UNUSED_VISUAL_CLIP');
   const reviewRequest={binding:b,manifestSha256,referenceSha256,clipSha256s:clips.map(c=>c.sha256)};let accepted;
   if(visualPolicy){
    for(const clip of clips)reasons.push(...assessTechnicalVisual(clip.measurement).reasons);
    accepted={...reviewRequest,accepted:reasons.length===0,ownerArtisticApproval:false,kind:'technical-qc',
      reviewId:'technical-'+manifestSha256.slice(0,24),policySha256:await digest(visualPolicy)};
   }else try{accepted=await verifyReview?.(input.review,structuredClone(reviewRequest));}catch{}
   if(accepted?.accepted!==true||(!visualPolicy&&accepted.ownerArtisticApproval!==true)||!id(accepted.reviewId)||!equal(accepted.binding,b)||accepted.manifestSha256!==manifestSha256
     ||accepted.referenceSha256!==referenceSha256||!equal(accepted.clipSha256s,reviewRequest.clipSha256s)) reasons.push(visualPolicy?'TECHNICAL_VISUAL_QC_REQUIRED':'EXACT_OWNER_COMPOSITION_REVIEW_REQUIRED');
   return result(b,input.assetId,reasons,{asset:{assetId:input.assetId,sha256:manifestSha256,mute:true,pulseMode:'raw',kind:'approved-timeline-manifest'},
     durationSeconds:manifest?.durationSeconds??null,compositionQC:{passed:reasons.length===0,scope:visualPolicy?'technical-policy-24s-clip-loop-timeline':'reviewed-24s-clip-loop-timeline',manifestSha256,
       timeline:manifestShape?manifest:null,clips,reviewId:accepted?.reviewId??null,approval:accepted??null,
       visualPolicySha256:accepted?.policySha256??null,continuousNewGeneration:false},referenceSha256,providerReceipt},synthetic,generated);
  }
 };
}
export function validateCueSet(music,video,expected) {
 const reasons=[];
 for(const [channel,m] of [['music',music],['video',video]]) {
  if(!m||!validBinding(m.binding,channel)||!equal({...m.binding,channel:'music'},{...expected,channel:'music'}))reasons.push('SAME_SET_REQUIRED');
  if(m?.status!=='QC_READY'||m.qc?.passed!==true||m.actualGenerationThisRun!==true||m.fixtureBinding===true||!hash(m.asset?.sha256)
    ||!finite(m.durationSeconds)||Math.abs(m.durationSeconds-24)>.15)reasons.push('REAL_COMPLETED_CUE_REQUIRED');
 }
 if(video?.compositionQC?.passed!==true||music?.contextVerified!==true||music?.continuationVerified!==true)reasons.push('AV_QC_REQUIRED');
 return {status:reasons.length?'HOLD':'ATOMIC_READY',reasons:[...new Set(reasons)],actualGenerationThisRun:!reasons.length,actualPlayback:false};
}
