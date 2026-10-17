import fs from 'node:fs/promises';
import path from 'node:path';
import {decodeSavedWave,savedContextSha} from './saved-room-media.mjs';
import {renderSpec,transitionDigest} from './dj-transition-selector.mjs';
import {verifySharedPCMBridge} from './shared-pcm-bridge.mjs';

// Explicit local opt-in. This loader is not reachable from the public runtime.
// Receipts come from private server files, then actual samples are revalidated.
export async function loadSharedPCMRoomMedia({directory}) {
 const catalog=JSON.parse(await fs.readFile(path.join(directory,'catalog.json'),'utf8'));
 if(catalog.method!=='shared-pcm-bridge-catalog-v1'||catalog.actualAPIRequests!==0||catalog.incomingNames?.length!==3||catalog.pairs?.length!==1)
  throw Error('SHARED_PCM_CATALOG_REQUIRED');
 const read=async file=>{
  if(typeof file!=='string'||!/^[a-zA-Z0-9-]+\.wav$/.test(file))throw Error('SHARED_PCM_FILE_REFUSED');
  return decodeSavedWave(await fs.readFile(path.join(directory,file)));
 };
 const sources=new Map();
 for(const [name,v] of Object.entries(catalog.sources)){
  const a=await read(v.file);
  if(a.frames!==24*44100||a.sha256!==v.profile?.assetSha256||v.profile.frameCount!==a.frames
   ||v.profile.method!=='pcm-endpoint-profile-v1')throw Error('SHARED_SOURCE_BINDING_REQUIRED');
  sources.set(name,{...a,name,profile:v.profile,contextSha256:savedContextSha(a),provenance:{
   kind:'saved-related-recording',preparation:v.preparation,sharedConditioningContext:true,requestedIntentRendered:false}});
 }
 const current=sources.get('current'),incoming=catalog.incomingNames.map(n=>sources.get(n));
 if(!current||incoming.some(x=>!x)||new Set([current,...incoming].map(x=>x.sha256)).size!==4)throw Error('DISTINCT_SHARED_RECORDINGS_REQUIRED');
 const renders=new Map(),receipts=[];
 for(const pair of catalog.pairs){
  const audio=await read(pair.file),receipt=pair.receipt,b=sources.get(pair.incoming);
  if(audio.sha256!==receipt.renderedSha256||audio.frames!==receipt.renderedFrameCount
   ||receipt.renderSpecSha256!==transitionDigest(renderSpec(receipt))||receipt.renderQC?.passed!==true
   ||!verifySharedPCMBridge({current,incoming:b,receipt}).valid)throw Error('EXACT_SHARED_RENDER_REQUIRED');
  receipts.push(receipt);renders.set(audio.sha256,{audio,receipt,incoming:b,name:pair.incoming});
 }
 const fallback=await read(catalog.fallback.file),r=catalog.fallback.receipt;
 if(fallback.sha256!==r.renderedSha256||fallback.frames!==48*44100||r.currentSha256!==current.sha256
  ||r.incomingSha256!==current.sha256||r.renderQC?.passed!==true||r.renderSpecSha256!==transitionDigest(renderSpec(r)))
  throw Error('SHARED_FALLBACK_QC_REQUIRED');
 return {current,fallbackAudio:fallback,incoming,receipts,renders,
  loadReceipts:async({current:c,candidate})=>receipts.filter(r=>r.currentSha256===c.sha256&&r.incomingSha256===candidate.music.asset.sha256)
   .map(r=>({...structuredClone(r),currentPlaybackRevision:c.playbackRevision}))};
}
