import {validateCueSet,digest} from './portable-qc.mjs';
// Shape-only bridge to cloud/generation/cue-contract.mjs. The owner supplies
// private storage evidence; this module neither uploads nor registers a cue.
export async function registrationEvidence({music,video,expectedBinding,verifySaved}={}) {
 const set=validateCueSet(music,video,expectedBinding);
 if(set.status!=='ATOMIC_READY')return {...set,evidence:null};
 const manifest=video.compositionQC?.timeline;
 // Current coordinator accepts sequential segments. Never flatten an accepted
 // overlap, change its duration, or silently substitute a different schedule.
 if(manifest?.segments?.some(s=>s.overlapSeconds!==0||s.transition!=='cut'))
  return {status:'HOLD',reasons:['COORDINATOR_OVERLAP_CONTRACT_REQUIRED'],evidence:null};
 for(const media of [music,video]) {
  let proof;try{proof=await verifySaved?.({binding:media.binding,asset:media.asset});}catch{}
  if(proof?.privateSaved!==true||proof.checksumVerified!==true||await digest(proof.binding??null)!==await digest(media.binding)||proof.assetId!==media.asset.assetId||proof.sha256!==media.asset.sha256)
   return {status:'HOLD',reasons:['BOUND_PRIVATE_SAVE_REQUIRED'],evidence:null};
 }
 if(!music.providerReceipt||!video.providerReceipt)return {status:'HOLD',reasons:['PROVIDER_RESULT_RECEIPT_REQUIRED'],evidence:null};
 const approval=video.compositionQC?.approval??video.review;
 if(approval?.accepted!==true||(approval.ownerArtisticApproval!==true&&approval.kind!=='technical-qc'))
  return {status:'HOLD',reasons:['VISUAL_APPROVAL_POLICY_REQUIRED'],evidence:null};
 const clips=video.compositionQC.clips.map(c=>({assetId:c.clipId,sha256:c.sha256,durationSeconds:c.measurement.durationSeconds,
  qcPassed:true,approved:true,providerRequestId:c.providerReceipt?.requestId??null,providerResultSha256:c.providerReceipt?.resultSha256??null,
  provenanceKind:c.provenanceKind,originalGenerationId:c.originalGenerationId,
  ...(c.provenanceKind==='owner-supplied-bootstrap-video'?{ownerAdmission:structuredClone(c.ownerAdmission)}:{})}));
 const timeline={durationSeconds:24,timeStretch:false,approvedLoops:true,segments:manifest.segments.map(s=>({assetId:s.clipId,
  sha256:clips.find(c=>c.assetId===s.clipId).sha256,startSeconds:s.startSeconds,endSeconds:s.endSeconds,
  sourceInSeconds:s.inSeconds,sourceOutSeconds:s.outSeconds,playbackRate:1}))};
 const stored=m=>({...m,privateSaved:true,checksumVerified:true});
 return {status:'QC_READY',reasons:[],evidence:{mode:'provider',actualGenerationThisRun:true,music:stored(music),video:{...stored(video),
  timeline,clips,review:{accepted:true,ownerArtisticApproval:approval.ownerArtisticApproval===true,
   kind:approval.kind??'exact-owner-review',policySha256:approval.policySha256??null,reviewId:video.compositionQC.reviewId,
   assetSha256:video.asset.sha256,commonIntentSha256:video.binding.commonIntentSha256}}}};
}
