import {createHash} from 'node:crypto';
import {evaluateTransition,transitionDigest,validatePlanAtCommit} from './dj-transition-selector.mjs';
import {verifyReviewedWindow} from './reviewed-transition.mjs';
import {verifySharedPCMBridge} from './shared-pcm-bridge.mjs';
const uncertainty=new Set(['OLD_PARENT_OR_INDEPENDENT_UNKNOWN_TEMPO_KEY','TEMPO_HALF_DOUBLE_AMBIGUITY','CONFIDENT_BEAT_DOWNBEAT_PHRASE_QC_REQUIRED']);
export const pcmSha=pcm=>createHash('sha256').update(Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength)).digest('hex');
export const playbackCurrent=s=>({clipId:s.music.clipId,sha256:s.music.sha256,contextSha256:s.music.contextSha256,profile:s.music.profile,sourceLineage:s.music.sourceLineage,playbackRevision:s.playback.revision,playedUntilFrame:s.playback.playedUntilFrame});

// A manual audition proves playback feasibility; it never changes a HOLD plan
// into ELIGIBLE or awards participant credit. Existing musical QA gates remain.
export function verifyRenderedRoomPlayback({current,candidate,record,currentAudio,manualAudition=false,plan=null,mode='saved'}) {
 if(!['saved','provider'].includes(mode)||mode==='provider'&&manualAudition)return {valid:false,reason:'PLAYBACK_MODE_REQUIRED'};
 if(!record?.audio||!record.receipt||!record.incoming)return {valid:false,reason:'TRUSTED_RENDER_REQUIRED'};
 const pairQC={...record.receipt,currentPlaybackRevision:current.playbackRevision};
 const evaluated=evaluateTransition({current,candidate:{...candidate,status:'READY'},pairQC,mode,now:plan?.createdAtMs??Date.now()});
 if(manualAudition) {
  if(evaluated.status!=='HOLD'||!evaluated.reasons.length||evaluated.reasons.some(r=>!uncertainty.has(r)))return {valid:false,reason:'AUDITION_ONLY_MUSICAL_UNCERTAINTY_ALLOWED',reasons:evaluated.reasons};
 } else {
  if(!plan||!validatePlanAtCommit(plan,{current,candidate,reservedCueId:candidate.cueId}).valid||plan.planSha256!==evaluated.planSha256)return {valid:false,reason:'CURRENT_ELIGIBLE_RENDER_PLAN_REQUIRED'};
 }
 if(evaluated.transition.userReviewedJoinVerified){
  const check=verifyReviewedWindow({current:currentAudio,incoming:record.incoming,record});
  if(!check.valid)return check;
 }
 if(evaluated.transition.sharedPCMBridgeVerified){
  const check=verifySharedPCMBridge({current:currentAudio,incoming:record.incoming,receipt:pairQC});
  if(!check.valid)return check;
 }
 const t=evaluated.transition,a=record.audio,edit=t.editStartFrame,sourceOrigin=t.exitFrame-t.entryFrame;
 if(!t.renderVerified||a.sha256!==t.renderedSha256||a.frames!==pairQC.renderedFrameCount||pairQC.renderSpecSha256!==t.renderSpecSha256||record.incoming.sha256!==candidate.music.asset.sha256||currentAudio.sha256!==current.sha256||a.frames!==sourceOrigin+record.incoming.frames||edit<current.playedUntilFrame)return {valid:false,reason:'RENDER_PLAYBACK_GEOMETRY_OR_BINDING_REQUIRED'};
 // Already queued samples must be the unedited prefix of this exact render.
 if(!Buffer.from(a.pcm.buffer,a.pcm.byteOffset,edit*8).equals(Buffer.from(currentAudio.pcm.buffer,currentAudio.pcm.byteOffset,edit*8)))return {valid:false,reason:'QUEUED_RENDER_PREFIX_CHANGED'};
 const half=Math.max(t.overlapFrames,t.seamDeclickFrames??0)/2,incomingOnly=t.exitFrame+half;
 if(!Buffer.from(a.pcm.buffer,a.pcm.byteOffset+incomingOnly*8).equals(Buffer.from(record.incoming.pcm.buffer,record.incoming.pcm.byteOffset+(t.entryFrame+half)*8)))return {valid:false,reason:'INCOMING_RENDER_TAIL_CHANGED'};
 return {valid:true,reason:manualAudition?'MEASURED_RENDER_AUDITION_ONLY':'CURRENT_ELIGIBLE_RENDER_VERIFIED',plan:evaluated,geometry:{editStartFrame:edit,startFrame:t.exitFrame,incomingOnlyFrame:incomingOnly,currentSourceOriginFrame:sourceOrigin,durationFrames:a.frames},pcmSha256:pcmSha(a.pcm),planEvidenceSha256:transitionDigest(evaluated)};
}
