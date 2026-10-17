import {decodeCompleteWave} from '../../integration/runtime/bootstrap.mjs';

// Local measurements are retained independently of financial authorization or
// Cue admission. Existing provenance/QC/selector gates still admit every Cue.
export function createReconciledMediaInspector({assetStore,native}={}){
 return async ({channel,bytes,operation,inputDigest})=>{
  if(channel==='video')return native.inspectVideo({bytes,inputDigest});
  const source=operation.permit.source;
  const [parent,context]=await Promise.all([assetStore.read(source.audioAssetId),assetStore.read(source.contextAssetId)]);
  if(parent.sha256!==source.music.sha256||context.sha256!==source.music.contextSha256)
   throw Error('RECONCILED_SOURCE_CHANGED');
  const decoded=decodeCompleteWave(bytes),seconds=decoded.frames/44100;
  if(seconds!==24&&seconds!==40)throw Error('RECONCILED_AUDIO_DURATION_HOLD');
  const measured=await native.inspectAudio({bytes,sourceBytes:parent.bytes,contextBytes:context.bytes,inputDigest,
   layout:seconds===40?'context-plus-tail':'tail-only',playbackRevision:source.playback.revision});
  // Byte artifacts remain local to the inspector. Only its measured JSON is
  // saved here; a later authorized pipeline must independently admit/render.
  const {cueBytes,renderBytes,...measurement}=measured;
  return measurement;
 };
}
