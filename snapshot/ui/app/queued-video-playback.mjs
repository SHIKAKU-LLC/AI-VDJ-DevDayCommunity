import {validateMotifSnapshot,motifMatches} from '/src/motif-contract.mjs';
// Caller owns audio. Control provenance and player revision remain separate.
export function createQueuedVideoPlayback({adapter,onEvent=()=>{},motifSnapshot=null,initialPlaybackRevision=0}={}) {
  let highestVersion=-1,lastMusicEventId=-1,adopted=null,pending=null,revision=initialPlaybackRevision,epoch=0,closed=false;
  if(!Number.isSafeInteger(initialPlaybackRevision)||initialPlaybackRevision<0)throw Error('INVALID_PLAYBACK_REVISION');
  const selectedMotif=motifSnapshot?validateMotifSnapshot(motifSnapshot):null;const seen=new Map();
  const matches=(m,e)=>m.version===e?.version&&m.musicRef?.jobId===e.requestId&&m.musicRef?.assetId===e.clipId&&motifMatches(m.motifSnapshot,e.motifSnapshot);
  async function stage(m){
    if(closed||pending?.jobId===m.jobId)return false;
    const token=++epoch;pending={jobId:m.jobId,version:m.version,musicRef:m.musicRef,motifSnapshot:m.motifSnapshot,ready:false,beatRequested:false,playbackRevision:++revision};
    const candidate=pending;
    const ready=await adapter.stage({version:m.version,playbackRevision:revision,assetId:m.asset.assetId,jobId:m.jobId,url:m.asset.url,durationSeconds:m.asset.durationSeconds,source:m.provenance.source,requestId:m.provenance.requestId,pulseMode:m.asset.pulseMode,...(m.motifSnapshot?{motifSnapshot:m.motifSnapshot}:{})});
    if(closed||token!==epoch)return false;
    candidate.ready=ready;onEvent({jobId:m.jobId,version:m.version,playbackRevision:candidate.playbackRevision,phase:ready?'PLAYER_READY':'PLAYER_REJECTED',...(m.motifSnapshot?{motifSnapshot:m.motifSnapshot}:{})});return ready;
  }
  return Object.freeze({
    async accept(manifest){
      const m=structuredClone(manifest);
      if(closed||m?.status!=='READY'||m.qc?.passed!==true||!m.asset||!m.musicRef||!Number.isSafeInteger(m.version)||m.version<highestVersion||seen.has(m.jobId))return false;
      if(selectedMotif&&!motifMatches(m.motifSnapshot,selectedMotif))return false;
      if(m.motifSnapshot)validateMotifSnapshot(m.motifSnapshot);
      if(!['raw','baked','off'].includes(m.asset.pulseMode)||!['fal','fake'].includes(m.provenance?.source))throw new Error('INVALID_READY_MANIFEST');
      highestVersion=m.version;seen.set(m.jobId,m);
      if(matches(m,adopted)||!pending) return stage(m);
      return true;
    },
    onMusicEvent(event){
      if(closed||event?.type!=='commit'||!Number.isSafeInteger(event.eventId)||event.eventId<=lastMusicEventId||!Number.isFinite(event.playAt)||!Number.isSafeInteger(event.version)||event.version<(adopted?.version??-1))return false;
      if(selectedMotif&&!motifMatches(event.motifSnapshot,selectedMotif))return false;
      if(event.motifSnapshot)validateMotifSnapshot(event.motifSnapshot);
      lastMusicEventId=event.eventId;adopted=structuredClone(event);
      const m=[...seen.values()].find(m=>matches(m,event));if(m&&pending?.jobId!==m.jobId)void stage(m);
      return true;
    },
    onAudioBeat(beat){if(!closed&&pending?.ready&&matches({version:pending.version,musicRef:pending.musicRef,motifSnapshot:pending.motifSnapshot},adopted)&&beat.timeMs>=adopted.playAt*1000){if(!pending.beatRequested){pending.beatRequested=true;onEvent({phase:'VIDEO_BEAT_GATE',jobId:pending.jobId,version:pending.version,playbackRevision:pending.playbackRevision,beatIndex:beat.index,beatAtSeconds:beat.timeMs/1000,musicCommitAt:adopted.playAt,...(pending.motifSnapshot?{motifSnapshot:pending.motifSnapshot}:{})});}adapter.onBeat(beat);}},
    dispose(){closed=true;epoch++;seen.clear();pending=null;},
    getState:()=>({highestVersion,adopted,pending:pending?structuredClone(pending):null,received:seen.size,lastPlaybackRevision:revision,commitClock:'caller-owned-audio',generationReadyIsMusicCommit:false}),
  });
}
