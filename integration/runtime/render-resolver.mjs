import {createHash} from 'node:crypto';
import {decodeCompleteWave} from './bootstrap.mjs';
import {verifyRenderedRoomPlayback,pcmSha} from '../../snapshot/app/runtime/rendered-room-playback.mjs';

// Resolves actual private artifacts and verifies the exact saved render before
// the browser engine can queue it. No synthesis, padding or hidden fade.
export function createRenderResolver({readCurrent,readRender,readArtifact}={}){
  if(![readCurrent,readRender,readArtifact].every(f=>typeof f==='function'))throw Error('RENDER_RESOLVER_DEPENDENCIES_REQUIRED');
  return async({roomId,cue,plan,expectedRevision,signal})=>{
    if(signal?.aborted)throw Error('RENDER_RESOLUTION_STOPPED');
    const current=await readCurrent(roomId),record=await readRender({roomId,cue,plan});
    if(expectedRevision!==current.playbackRevision+1)throw Error('CURRENT_PLAYBACK_REVISION_REQUIRED');
    const parent=await readArtifact(current.clipId),incoming=await readArtifact(cue.music.asset.assetId),rendered=await readArtifact(record.assetId);
    const currentAudio=decodeCompleteWave(parent.bytes),incomingAudio=decodeCompleteWave(incoming.bytes),renderAudio=decodeCompleteWave(rendered.bytes);
    if(currentAudio.sha256!==current.sha256||incomingAudio.sha256!==cue.music.asset.sha256)throw Error('RENDER_SOURCE_HASH_MISMATCH');
    const verified=verifyRenderedRoomPlayback({current,candidate:cue,currentAudio,
      record:{audio:renderAudio,incoming:incomingAudio,receipt:record.receipt},plan,mode:'provider'});
    if(!verified.valid)throw Error(verified.reason);
    if(signal?.aborted)throw Error('RENDER_RESOLUTION_STOPPED');
    const pcm=renderAudio.pcm,startFrame=verified.geometry.startFrame,window=pcm.subarray(startFrame*2,(startFrame+256)*2);
    return{pcm,sampleRate:44100,startFrame,durationFrames:renderAudio.frames,
      expectedPlayedWindowSha256:createHash('sha256').update(Buffer.from(window.buffer,window.byteOffset,window.byteLength)).digest('hex'),
      renderedPcmSha256:pcmSha(pcm),renderedFileSha256:renderAudio.sha256};
  };
}
