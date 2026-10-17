// Normalize the runtime's participant-rooms.mjs payload; do not import its Node-only code.
const names={QUEUED:'PENDING',INTERPRETING:'GENERATING',ATOMIC_READY:'GENERATING',PARTIAL_HOLD:'FAILED',UNRESOLVED_HOLD:'UNKNOWN',NEEDS_CLARIFICATION:'CLARIFY'};
export function roomView(raw){
 const requests=(raw.submissions??[]).map(s=>{const cue=(raw.cues??[]).find(c=>c.submissionId===s.submissionId);
  const channel=k=>{const result=cue?.[k],job=s.jobs?.find(j=>j.channel===k),b=result?.binding;
   const bound=!!cue&&b?.roomId===raw.roomId&&b?.submissionId===s.submissionId&&b?.generationId===cue.generationId&&b?.commonIntentSha256===cue.commonIntentSha256&&b?.controlVersion===cue.controlVersion&&b?.channel===k;
   return {status:result&&bound?'QC_READY':job?.state??'QUEUED',qcPassed:bound&&result.qc?.passed===true,durationSeconds:result?.durationSeconds,generationId:b?.generationId,controlVersion:b?.controlVersion,compositionQcPassed:result?.compositionQC?.passed===true};};
  return {requestId:s.submissionId,participantId:s.participantId,nickname:s.nickname,prompt:s.prompt,state:cue?.status==='PLAYING'?(raw.currentCredit?.cueId===cue.cueId&&raw.currentCredit?.actual===true?'PLAYING':'PLAYED'):names[s.state]??s.state,selectionState:['SELECTED','STAGING'].includes(cue?.status)?'RESERVED':null,cueId:cue?.cueId??null,generationId:s.generationId,controlVersion:s.controlVersion,atomicReady:cue?.atomicReady===true,mode:raw.mode,actualGenerationThisRun:cue?.actualGenerationThisRun===true,music:channel('music'),video:channel('video'),reason:s.reason??null,question:s.question??null};
 });
 return {roomId:raw.roomId,roomEpoch:raw.sessionId,revision:raw.eventSeq,controlRevision:raw.controlRevision,status:raw.closed?'ENDED':'OPEN',accepting:raw.accepting,generationPaused:raw.generationPaused,autoDJ:raw.autoDJ,requests,decision:raw.decision,supply:raw.supply,playbackAdapterAvailable:raw.playbackAdapterAvailable===true,mode:raw.mode};
}
export function actualCreditView(event,rawRoom){
 // This function takes only events read from the authenticated server feed, never a participant POST.
 if(event?.type!=='participantCredit'||event.mode!=='provider'||event.actual!==true||event.simulated===true||rawRoom?.mode!=='provider'||event.roomId!==rawRoom.roomId||rawRoom.currentCredit?.cueId!==event.cueId||rawRoom.currentCredit?.playbackRevision!==event.playbackRevision||rawRoom.currentCredit?.actual!==true)return null;
 const cue=rawRoom.cues?.find(c=>c.cueId===event.cueId),submission=rawRoom.submissions?.find(s=>s.submissionId===event.submissionId);
 if(!cue||!submission||cue.status!=='PLAYING'||cue.playbackRevision!==event.playbackRevision||cue.contribution?.participantId!==event.participantId||cue.generationId!==event.generationId||!Number.isFinite(event.audioTime))return null;
 return {type:'cue.playback.started',roomId:event.roomId,roomEpoch:rawRoom.sessionId,requestId:event.submissionId,cueId:event.cueId,generationId:event.generationId,controlVersion:cue.controlVersion,playbackRevision:event.playbackRevision,authoritative:true,audioCommitted:true,videoPresented:true};
}
