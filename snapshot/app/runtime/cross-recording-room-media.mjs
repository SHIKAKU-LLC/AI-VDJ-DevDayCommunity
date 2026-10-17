import fs from 'node:fs/promises';
import path from 'node:path';
import {decodeSavedWave} from './saved-room-media.mjs';
import {transitionDigest,renderSpec} from './dj-transition-selector.mjs';

// Local server-selected measurements only. Neither browser bodies nor model
// probabilities can upgrade these receipts to calibrated musical confidence.
export async function loadCrossRecordingRoomMedia({directory,currentSha256}) {
 const catalog=JSON.parse(await fs.readFile(path.join(directory,'evaluation.json'),'utf8'));
 if(catalog.method!=='saved-cross-recording-review-v1'||catalog.materialSet!=='rendered-stream'||catalog.musicalConfidencePromoted!==false||catalog.actualAPIRequests!==0)throw Error('CROSS_REVIEW_CATALOG_REQUIRED');
 const read=async file=>{
  if(typeof file!=='string'||!/^[a-zA-Z0-9-]+\.wav$/.test(file))throw Error('CROSS_REVIEW_FILE_REFUSED');
  return decodeSavedWave(await fs.readFile(path.join(directory,file)));
 };
 const sources=new Map();
 for(const name of ['current','music-B','variant-A','variant-C']) {
  const s=catalog.sources[name],a=await read(s?.file),p=s.profile;
  if(a.sha256!==p?.assetSha256||a.frames!==24*44100||p.frameCount!==a.frames||p.method!=='pcm-endpoint-profile-v1'||s.musicalQA?.key!=='unknown'||s.musicalQA?.beatConfidenceCalibrated!==false)throw Error('CROSS_REVIEW_SOURCE_BINDING_REQUIRED');
  sources.set(name,{...a,profile:p,provenance:{kind:'existing-saved-cross-recording',sourceOriginSha256:s.sourceOriginSha256,sourceStartSeconds:s.sourceStartSeconds,sourceEndSeconds:s.sourceEndSeconds,preparation:s.preparation,requestedIntentRendered:false,sharedConditioningContext:true}});
 }
 if(sources.get('current').sha256!==currentSha256)throw Error('CROSS_REVIEW_CURRENT_CHANGED');
 const incoming=['music-B','variant-A','variant-C'].map(name=>({name,...sources.get(name)}));
 if(new Set(incoming.map(a=>a.sha256)).size!==3)throw Error('THREE_DISTINCT_SAVED_RECORDINGS_REQUIRED');
 const receipts=[],renders=new Map();
 for(const pair of catalog.pairs) {
  const r=pair.receipt,a=await read(pair.file),b=sources.get(pair.incoming);
  if(!b||r.currentSha256!==currentSha256||r.incomingSha256!==b.sha256||r.renderedSha256!==a.sha256||r.renderedFrameCount!==a.frames||r.renderSpecSha256!==transitionDigest(renderSpec(r))||r.beatGridVerified!==false||r.phraseVerified!==false||r.nativeContinuationVerified!==false)throw Error('CROSS_REVIEW_RENDER_BINDING_REQUIRED');
  receipts.push(structuredClone(r));
  if(r.renderQC.passed===true)renders.set(a.sha256,{audio:a,receipt:structuredClone(r),incoming:b,name:pair.incoming,plannedBars:pair.plannedBars});
 }
 if(receipts.length!==18)throw Error('CROSS_REVIEW_PLAN_SET_REQUIRED');
 return {incoming,receipts,renders,loadReceipts:async({current,candidate})=>receipts.filter(r=>r.currentSha256===current.sha256&&r.incomingSha256===candidate.music.asset.sha256).map(r=>({...structuredClone(r),currentPlaybackRevision:current.playbackRevision}))};
}
