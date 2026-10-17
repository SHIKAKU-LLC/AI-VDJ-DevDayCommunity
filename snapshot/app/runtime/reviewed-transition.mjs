import {createHash} from 'node:crypto';
const hash=s=>/^[a-f0-9]{64}$/.test(s??'');
const frame=n=>Number.isSafeInteger(n)&&n>=0;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const reviewDigest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const bytes=(a,start,count)=>Buffer.from(a.pcm.buffer,a.pcm.byteOffset+start*8,count*8);

// Trusted server curation only. This is a scoped human assessment, not inferred
// key, phrase annotation, model calibration or a general quality certificate.
export function reviewedTransitionContract(q) {
 const v=q?.reviewedTransition,f=v?.feedback;
 if(v?.method!=='exact-user-reviewed-join-v1'||f?.method!=='trusted-user-comparison-feedback-v1'
  ||f.status!=='accepted'||f.revoked!==false||f.scope!=='exact-presented-transition-windows'
  ||typeof f.sourceMessageId!=='string'||!/^Sentinel_[A-Za-z0-9_]+$/.test(f.sourceMessageId)
  ||typeof f.quote!=='string'||!f.quote.trim()||f.preferredLabel!==null
  ||!hash(f.comparisonSha256)||!Array.isArray(f.acceptedLabels)||!f.acceptedLabels.includes(v.variantLabel)
  ||!Array.isArray(f.approvals))return false;
 const {feedbackSha256,...feedbackBody}=f;
 const {receiptSha256,...body}=v;
 if(!hash(feedbackSha256)||reviewDigest(feedbackBody)!==feedbackSha256||!hash(receiptSha256)||reviewDigest(body)!==receiptSha256)return false;
 if(v.currentSha256!==q.currentSha256||v.incomingSha256!==q.incomingSha256||v.renderedSha256!==q.renderedSha256
  ||v.renderSpecSha256!==q.renderSpecSha256||v.currentSha256===v.incomingSha256)return false;
 const a=f.approvals.find(a=>a.variantLabel===v.variantLabel);
 if(!a||['currentSha256','incomingSha256','renderedSha256','renderSpecSha256','snippetSha256','snippetPcmSha256'].some(k=>!hash(a[k])||a[k]!==v[k])
  ||a.snippetStartFrame!==v.snippetStartFrame||a.snippetFrameCount!==v.snippetFrameCount
  ||typeof a.libraryFileId!=='string'||!a.libraryFileId.startsWith('libfile_'))return false;
 const half=Math.max(q.overlapFrames??0,q.seamDeclickFrames??0)/2;
 if(!frame(v.snippetStartFrame)||!frame(v.snippetFrameCount)||v.snippetFrameCount<8*44100
  ||v.snippetStartFrame>q.exitFrame-half-2*44100
  ||v.snippetStartFrame+v.snippetFrameCount<q.exitFrame+half+2*44100)return false;
 const p=v.phase;
 if(p?.method!=='cross-method-local-phase-v1'||p.currentSha256!==q.currentSha256||p.incomingSha256!==q.incomingSha256
  ||p.calibrated!==false||!Number.isFinite(p.periodSeconds)||p.periodSeconds<60/300||p.periodSeconds>60/40
  ||!Number.isFinite(p.longContextMaxErrorSeconds)||p.longContextMaxErrorSeconds<0||p.longContextMaxErrorSeconds>p.periodSeconds*.08
  ||!Array.isArray(p.checks))return false;
 for(const name of ['original','gain-minus6db','crop137ms','dp-full','dp-percussive']){
  const c=p.checks.find(c=>c.method===name);
  if(!c||c.fullWindowCovered!==true||!frame(c.currentBeatCount)||c.currentBeatCount<4
   ||!Number.isFinite(c.maximumRelativeErrorSeconds)||c.maximumRelativeErrorSeconds<0
   ||c.maximumRelativeErrorSeconds>p.periodSeconds*.08)return false;
 }
 return q.type==='bass-swap'&&q.overlapFrames>0&&(q.seamDeclickFrames??0)===0
  ||q.type==='reviewed-nonoverlap-cut'&&q.overlapFrames===0&&q.eqCurves===null&&q.relativeIncomingGainDb===0
   &&frame(q.seamDeclickFrames)&&q.seamDeclickFrames>0&&q.seamDeclickFrames%2===0&&q.seamDeclickFrames<=882;
}

export function verifyReviewedWindow({current,incoming,record}) {
 const q=record?.receipt,v=q?.reviewedTransition,s=record?.reviewSnippet,a=record?.audio;
 if(!reviewedTransitionContract(q)||current?.sha256!==q.currentSha256||incoming?.sha256!==q.incomingSha256
  ||!a||a.sha256!==q.renderedSha256||!s||s.sha256!==v.snippetSha256||s.frames!==v.snippetFrameCount
  ||a.frames<v.snippetStartFrame+v.snippetFrameCount)return {valid:false,reason:'EXACT_REVIEWED_WINDOW_REQUIRED'};
 const heard=bytes(s,0,s.frames),rendered=bytes(a,v.snippetStartFrame,v.snippetFrameCount);
 if(!heard.equals(rendered)||createHash('sha256').update(heard).digest('hex')!==v.snippetPcmSha256)
  return {valid:false,reason:'REVIEWED_SNIPPET_CHANGED'};
 return {valid:true,reason:'EXACT_USER_REVIEWED_TRANSITION',sourceMessageId:v.feedback.sourceMessageId,variantLabel:v.variantLabel};
}
