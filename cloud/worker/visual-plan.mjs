import {createHash} from 'node:crypto';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {operationBinding} from '../generation/cue-contract.mjs';
import {TECHNICAL_VISUAL_POLICY,assessTechnicalVisual} from '../../integration/qc/visual-policy.mjs';
import {DispatchError} from '../generation/dispatch.mjs';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>{throw new DispatchError(code);};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const bytes=v=>Buffer.from(JSON.stringify(canonical(v)));
const fingerprint=o=>cueDigest({operationId:o.operationId,submissionId:o.submissionId,permit:o.permit,plan:o.plan,
 video:{state:o.stages?.video?.state,requestId:o.stages?.video?.requestId,assetId:o.stages?.video?.result?.assetId,
 sha256:o.stages?.video?.result?.sha256,resultSha256:o.stages?.video?.result?.resultSha256}});
const reference=(roomId,o)=>({roomId,operationId:o.operationId,permitId:o.permit.permitId,
 referenceSha256:o.permit.source.video.referenceSha256,operationSha256:fingerprint(o)});
// Refreshed finite delivery/financial evidence changes the pinned operation.
// Keep the old immutable edit/plan and save a separately scoped record; never
// overwrite it or silently treat an older fingerprint as current authority.
const editId=(roomId,o)=>'visual-edit-'+cueDigest({roomId,operationId:o.operationId,permitId:o.permit.permitId,operationSha256:fingerprint(o)}).slice(0,48);
const planId=(roomId,o)=>'visual-plan-'+cueDigest({roomId,operationId:o.operationId,permitId:o.permit.permitId,operationSha256:fingerprint(o)}).slice(0,48);
/** Server-only accepted cut editor. It never loops, changes speed, starts a
 * provider request, or infers a saved clip selection from participant input.
 * saveAcceptedEdit is a privileged server action, not an owner HTTP JSON API.
 * Its private immutable record supplies the concrete accepted-edit input path.
 */
export function createProductionVisualPlan({enabled=false,readOperation,assetStore,inspectVideo,verifyExactReview,readScope,now=Date.now}={}) {
 if(typeof readOperation!=='function'||!['read','save','verifySaved'].every(k=>typeof assetStore?.[k]==='function')||
  typeof inspectVideo!=='function')fail('VISUAL_PLAN_PORTS_REQUIRED');
 let closed=false;const active=()=>{if(!enabled)fail('VISUAL_PLAN_NOT_ACTIVATED');if(closed)fail('VISUAL_PLAN_CLOSED');};
 async function operation(roomId,operationId){active();if(!id(roomId)||!id(operationId))fail('VISUAL_PLAN_IDS_REQUIRED');
  const o=structuredClone(await readOperation({roomId,operationId}));active();
  if(o?.operationId!==operationId||o.roomId!==undefined&&o.roomId!==roomId||o.stopped||o.dispatchAllowed!==true||
   o.plan?.status!=='COMPILED'||!id(o.permit?.permitId)||o.stages?.video?.state!=='COMPLETE'||
   !id(o.stages.video.result?.assetId)||!sha(o.stages.video.result?.sha256)||!sha(o.stages.video.result?.resultSha256)||
   !sha(o.permit.source?.video?.referenceSha256))fail('VISUAL_PLAN_OPERATION_REQUIRED');
  if(o.permit.visualReviewMode!=='exact'&&cueDigest(o.permit.visualPolicy??null)!==cueDigest(TECHNICAL_VISUAL_POLICY))
   fail('VISUAL_PLAN_POLICY_REQUIRED');return o;
 }
 async function physical(assetId,expected){active();if(!id(assetId)||!sha(expected))fail('VISUAL_PLAN_ASSET_REQUIRED');
  const r=await assetStore.read(assetId),b=Buffer.from(r?.bytes??[]);active();
  if(r?.assetId!==assetId||r.sha256!==expected||hash(b)!==expected||r.byteLength!==b.length||!b.length||b.length>32*1024*1024)
   fail('VISUAL_PLAN_PHYSICAL_CHANGED');
  const proof=await assetStore.verifySaved({binding:r.binding,asset:{assetId,sha256:expected}});active();
  if(proof?.privateSaved!==true||proof.checksumVerified!==true||proof.sha256!==expected||proof.assetId!==assetId||
   cueDigest(proof.binding)!==cueDigest(r.binding))fail('VISUAL_PLAN_PRIVATE_PROOF_REQUIRED');return {...r,bytes:b};
 }
 async function ownerAdmission(r,referenceSha256,roomId,permitExpiresAtMs){
  const p=r.provenance,b=r.binding;
  if(typeof readScope!=='function'||p?.kind!=='owner-supplied-bootstrap-video'||p.actualGenerationThisRun!==false||
   p.sourceSha256!==referenceSha256||p.rawSha256!==r.sha256||!id(p.admissionId)||!sha(p.admissionEvidenceSha256)||
   ['requestId','generationId','resultSha256','modelId','operationId'].some(k=>p[k]!==undefined)||
   b?.kind!=='owner-supplied-bootstrap-video'||b.roomId!==roomId||!id(b.sessionId)||
   !Number.isSafeInteger(b.controlRevision)||b.controlRevision<0||b.referenceSha256!==referenceSha256||
   !Number.isSafeInteger(b.expiresAtMs)||b.expiresAtMs<=now()||
   permitExpiresAtMs!==undefined&&(!Number.isSafeInteger(permitExpiresAtMs)||permitExpiresAtMs>b.expiresAtMs))
   fail('VISUAL_PLAN_OWNER_ADMISSION_REQUIRED');
  const scope=await readScope({roomId});active();
  if(scope?.roomId!==roomId||scope.closed||scope.ownerEnabled!==true||
   ['sessionId','controlRevision','expiresAtMs'].some(k=>scope[k]!==b[k])||scope.expiresAtMs<=now())
   fail('VISUAL_PLAN_OWNER_SCOPE_CHANGED');
  const a=await physical('admission-'+p.admissionId,p.admissionEvidenceSha256);
  if(a.contentType!=='application/json'||a.bytes.length>64*1024||a.provenance?.kind!=='owner-bootstrap-video-admission'||
   cueDigest(a.binding)!==cueDigest(b))fail('VISUAL_PLAN_OWNER_ADMISSION_REQUIRED');
  let evidence;try{evidence=JSON.parse(a.bytes.toString('utf8'));}catch{fail('VISUAL_PLAN_OWNER_ADMISSION_REQUIRED');}
  const m=evidence?.measurement,expectedInput=cueDigest({kind:'operator-upload-video-v1',sha256:r.sha256,referenceSha256});
  if(evidence?.version!=='owner-bootstrap-video-admission-v1'||evidence.ownerSelected!==true||
   evidence.actualGenerationThisRun!==false||evidence.assetId!==r.assetId||evidence.sha256!==r.sha256||
   evidence.byteLength!==r.byteLength||evidence.referenceSha256!==referenceSha256||evidence.admissionId!==p.admissionId||
   cueDigest(evidence.binding)!==cueDigest(b)||m?.rawSha256!==r.sha256||m.inputDigest!==expectedInput||
   m.fullyDecoded!==true||!Number.isSafeInteger(m.decodedFrames)||m.decodedFrames<2||
   !Number.isFinite(m.durationSeconds)||m.durationSeconds<19||!assessTechnicalVisual(m).passed)
   fail('VISUAL_PLAN_OWNER_ADMISSION_REQUIRED');
  return {kind:p.kind,admissionId:p.admissionId,admissionEvidenceSha256:p.admissionEvidenceSha256,
   actualGenerationThisRun:false};
 }
 async function video(assetId,expected,o){const r=await physical(assetId,expected);let origin;
  if(r.contentType!=='video/mp4'||r.binding?.roomId!==o.roomId||r.provenance?.sourceSha256!==o.permit.source.video.referenceSha256)
   fail('VISUAL_PLAN_SAVED_BINDING_REQUIRED');
  if(r.provenance.kind==='owner-supplied-bootstrap-video')origin=await ownerAdmission(r,o.permit.source.video.referenceSha256,o.roomId,o.permit.expiresAtMs);
  else if(r.provenance.kind!=='provider'||!id(r.binding.generationId))fail('VISUAL_PLAN_SAVED_BINDING_REQUIRED');
  const inputDigest=cueDigest({kind:'production-visual-plan-measurement-v1',assetId,sha256:expected,
   operationSha256:fingerprint(o)}),m=await inspectVideo({bytes:r.bytes,inputDigest});active();
  if(m?.inputDigest!==inputDigest||m.rawSha256!==expected||m.fullyDecoded!==true||
   !Number.isSafeInteger(m.decodedFrames)||m.decodedFrames<2||!Number.isFinite(m.durationSeconds)||m.durationSeconds<=0||
   !Number.isSafeInteger(m.width)||m.width<1||!Number.isSafeInteger(m.height)||m.height<1)
   fail('VISUAL_PLAN_NATIVE_DECODE_REQUIRED');
  if(!assessTechnicalVisual(m).passed)fail('VISUAL_PLAN_TECHNICAL_HOLD');
  if(origin)await ownerAdmission(r,o.permit.source.video.referenceSha256,o.roomId,o.permit.expiresAtMs);
  return {record:r,measurement:m,origin:origin??{kind:'saved',generationId:r.binding.generationId}};
 }
 async function persist(assetId,o,record){const b=bytes(record);if(b.length>64*1024)fail('VISUAL_PLAN_RECORD_TOO_LARGE');
  await assetStore.save({id:assetId,bytes:b,contentType:'application/json',binding:operationBinding(o.roomId,o,'video'),
   provenance:{kind:'verified-visual-plan',operationId:o.operationId}});
  const saved=await physical(assetId,hash(b));if(!saved.bytes.equals(b))fail('VISUAL_PLAN_IMMUTABLE_REQUIRED');return structuredClone(record);
 }
 async function readJson(assetId,expectedBinding){const r=await (assetStore.readOptional??assetStore.read).call(assetStore,assetId);
  if(!r)return null;const checked=await physical(assetId,r.sha256);
  if(cueDigest(checked.binding)!==cueDigest(expectedBinding)||checked.contentType!=='application/json'||checked.bytes.length>64*1024)fail('VISUAL_PLAN_RECORD_REQUIRED');
  try{return JSON.parse(checked.bytes.toString('utf8'));}catch{fail('VISUAL_PLAN_RECORD_REQUIRED');}
 }
 async function saveAcceptedEdit({roomId,operationId,clips,review}={}){
  const o=await operation(roomId,operationId);o.roomId=roomId;
  if(!Array.isArray(clips)||clips.length>31||clips.some(c=>!c||Object.keys(c).some(k=>!['assetId','sha256','inSeconds','outSeconds','toEnd'].includes(k))||
   c.toEnd!==undefined&&(c.toEnd!==true||c.outSeconds!==undefined)))
   fail('VISUAL_PLAN_ACCEPTED_EDIT_REQUIRED');
  const selected=[];for(const raw of clips){const {record,measurement,origin}=await video(raw.assetId,raw.sha256,o);
   // toEnd selects through the clip's measured end; an explicit outSeconds
   // past that end is still rejected. readVisualPlan trims to 24s overall.
   const {toEnd,...c}=raw;if(toEnd)c.outSeconds=measurement.durationSeconds;
   if(!Number.isFinite(c.inSeconds)||!Number.isFinite(c.outSeconds)||c.inSeconds<0||c.outSeconds<=c.inSeconds||
    c.outSeconds>measurement.durationSeconds||record.assetId===o.stages.video.result.assetId||
    selected.some(x=>x.assetId===c.assetId||x.sha256===c.sha256&&Math.max(x.inSeconds,c.inSeconds)<Math.min(x.outSeconds,c.outSeconds)))
    fail('VISUAL_PLAN_NONREPEATING_EDIT_REQUIRED');
   selected.push({...c,durationSeconds:measurement.durationSeconds,...(origin.kind==='saved'?{generationId:origin.generationId}:{origin})});}
  const record={version:'accepted-private-visual-edit-v1',...reference(roomId,o),clips:selected,
   ...(o.permit.visualReviewMode==='exact'?{review}: {})};
  if(o.permit.visualReviewMode==='exact'&&(!review||typeof verifyExactReview!=='function'))fail('VISUAL_PLAN_EXACT_REVIEW_REQUIRED');
  if(fingerprint(await operation(roomId,operationId))!==fingerprint(o))fail('VISUAL_PLAN_OPERATION_CHANGED');
  return persist(editId(roomId,o),o,record);
 }
 async function readVisualPlan({roomId,operation:provided,binding,newClip}={}) {
  const o=await operation(roomId,provided?.operationId);o.roomId=roomId;
  if(fingerprint(o)!==fingerprint(provided)||cueDigest(binding)!==cueDigest(operationBinding(roomId,o,'video'))||
   !id(newClip?.clipId)||!(newClip.bytes instanceof Uint8Array)||newClip.sha256!==o.stages.video.result.sha256||
   hash(newClip.bytes)!==newClip.sha256)fail('VISUAL_PLAN_OPERATION_CHANGED');
  const generated=await video(o.stages.video.result.assetId,newClip.sha256,o);
  if(generated.record.provenance.kind!=='provider'||cueDigest(generated.record.binding)!==cueDigest(binding)||generated.record.provenance.requestId!==o.stages.video.requestId||
   generated.record.provenance.resultSha256!==o.stages.video.result.resultSha256||
   !generated.record.bytes.equals(Buffer.from(newClip.bytes)))fail('VISUAL_PLAN_PROVIDER_CHANGED');
  const edit=await readJson(editId(roomId,o),binding);
  if(edit&&(edit.version!=='accepted-private-visual-edit-v1'||cueDigest(reference(roomId,o))!==cueDigest(
   Object.fromEntries(Object.keys(reference(roomId,o)).map(k=>[k,edit[k]])))||!Array.isArray(edit.clips)||edit.clips.length>31))
   fail('VISUAL_PLAN_ACCEPTED_EDIT_CHANGED');
  const clips=[{...newClip,bytes:Buffer.from(newClip.bytes)}],descriptors=[],segments=[];
  let end=0;function append(clipId,sha256,durationSeconds,inSeconds,outSeconds){
   const length=Math.min(outSeconds-inSeconds,24-end);if(length<=0)return;
   descriptors.push({clipId,sha256,durationSeconds});segments.push({clipId,startSeconds:end,endSeconds:end+length,
    inSeconds,outSeconds:inSeconds+length,overlapSeconds:0,transition:'cut'});end+=length;
  }
  append(newClip.clipId,newClip.sha256,generated.measurement.durationSeconds,0,generated.measurement.durationSeconds);
  const ranges=new Map([[newClip.sha256,[[0,Math.min(24,generated.measurement.durationSeconds)]]]]);
  for(const c of edit?.clips??[]){if(end>=24)break;const {record,measurement,origin}=await video(c.assetId,c.sha256,o);
   if(c.durationSeconds!==measurement.durationSeconds||(origin.kind==='saved'?c.generationId!==origin.generationId:
    c.generationId!==undefined||cueDigest(c.origin)!==cueDigest(origin))||
    c.inSeconds<0||c.outSeconds>measurement.durationSeconds||c.outSeconds<=c.inSeconds||
    (ranges.get(c.sha256)??[]).some(([a,b])=>Math.max(a,c.inSeconds)<Math.min(b,c.outSeconds)))fail('VISUAL_PLAN_SAVED_CHANGED');
   const clipId=c.assetId;
   clips.push({clipId,bytes:record.bytes,sha256:c.sha256,provenance:{kind:origin.kind,assetId:c.assetId}});
   append(clipId,c.sha256,measurement.durationSeconds,c.inSeconds,c.outSeconds);
   ranges.set(c.sha256,[...(ranges.get(c.sha256)??[]),[c.inSeconds,c.outSeconds]]);
  }
  if(Math.abs(end-24)>1e-6)fail('VISUAL_CONTINUOUS_MATERIAL_INSUFFICIENT');
  const manifest={version:'accepted-video-timeline-v1',durationSeconds:24,width:1280,height:720,
   fit:'contain',muted:true,clips:descriptors,segments};
  if(o.permit.visualReviewMode==='exact'){
   const accepted=await verifyExactReview?.(edit?.review,{binding,manifestSha256:cueDigest(manifest),
    referenceSha256:o.permit.source.video.referenceSha256,clipSha256s:descriptors.map(c=>c.sha256)});
   if(accepted?.accepted!==true||accepted.ownerArtisticApproval!==true)fail('VISUAL_PLAN_EXACT_REVIEW_REQUIRED');
  }
  if(fingerprint(await operation(roomId,o.operationId))!==fingerprint(o))fail('VISUAL_PLAN_OPERATION_CHANGED');
  await persist(planId(roomId,o),o,{version:'production-nonrepeating-visual-plan-v1',...reference(roomId,o),
   manifest,manifestSha256:cueDigest(manifest),continuousNewGeneration:false,sourceIntervalsReplayed:false});
  return {manifest,clips,...(edit?.review?{review:edit.review}:{})};
 }
 return Object.freeze({readVisualPlan,saveAcceptedEdit,
  async readSavedRecord(assetId,request){active();const r=await assetStore.read(assetId);if(!r)return null;
   const checked=await physical(assetId,r.sha256);
   if(checked.provenance.kind==='owner-supplied-bootstrap-video'){
    if(request?.binding?.channel!=='video'||checked.contentType!=='video/mp4')fail('VISUAL_PLAN_OWNER_ADMISSION_REQUIRED');
    const origin=await ownerAdmission(checked,request.sourceSha256,request.binding.roomId);
    return {sha256:checked.sha256,byteLength:checked.byteLength,referenceSha256:checked.provenance.sourceSha256,
     binding:checked.binding,...origin};
   }
   if(checked.provenance.kind!=='provider')fail('VISUAL_PLAN_SAVED_BINDING_REQUIRED');
   return {sha256:checked.sha256,byteLength:checked.byteLength,
    referenceSha256:checked.provenance.sourceSha256,generationId:checked.binding.generationId,binding:checked.binding};},
  close(){closed=true;},capabilities:()=>({defaultActivation:false,productionVisualPlan:enabled&&!closed,
   loops:false,continuousNewGeneration:false,actualProviderMediaVerified:false})});
}
