import fs from 'node:fs/promises';
import path from 'node:path';
import {decodeSavedWave,savedContextSha} from './saved-room-media.mjs';
import {renderSpec,transitionDigest} from './dj-transition-selector.mjs';
import {verifyReviewedWindow,reviewDigest} from './reviewed-transition.mjs';

export async function loadReviewedRoomMedia({directory}) {
 const catalog=JSON.parse(await fs.readFile(path.join(directory,'catalog.json'),'utf8'));
 if(catalog.method!=='user-reviewed-independent-cache-v1'||catalog.actualAPIRequests!==0
  ||catalog.generalIndependentMixingVerified!==false||catalog.incomingNames?.length!==3||catalog.pairs?.length!==2)
  throw Error('REVIEWED_CATALOG_REQUIRED');
 const read=async file=>{
  if(typeof file!=='string'||!/^[a-zA-Z0-9-]+\.wav$/.test(file))throw Error('REVIEWED_FILE_REFUSED');
  return decodeSavedWave(await fs.readFile(path.join(directory,file)));
 };
 const sources=new Map();
 for(const [name,s] of Object.entries(catalog.sources)){
  const a=await read(s.file);
  if(a.frames!==24*44100||a.sha256!==s.profile?.assetSha256||s.profile.frameCount!==a.frames||s.profile.method!=='pcm-endpoint-profile-v1')throw Error('REVIEWED_SOURCE_CHANGED');
  sources.set(name,{...a,name,profile:s.profile,contextSha256:savedContextSha(a),provenance:s.provenance});
 }
 const current=sources.get('current'),incoming=catalog.incomingNames.map(n=>sources.get(n));
 if(!current||incoming.some(a=>!a)||new Set([current,...incoming].map(a=>a.sha256)).size!==4)throw Error('REVIEWED_SOURCE_SET_REQUIRED');
 const receipts=[],renders=new Map();
 for(const p of catalog.pairs){
  const audio=await read(p.file),reviewSnippet=await read(p.snippetFile),receipt=p.receipt,b=sources.get(p.incoming);
  if(audio.sha256!==receipt.renderedSha256||audio.frames!==receipt.renderedFrameCount||receipt.renderSpecSha256!==transitionDigest(renderSpec(receipt))
   ||receipt.renderQC?.passed!==true||reviewDigest(receipt.reviewedTransition.feedback)!==reviewDigest(catalog.feedback)
   ||!verifyReviewedWindow({current,incoming:b,record:{audio,reviewSnippet,receipt}}).valid)throw Error('REVIEWED_RENDER_BINDING_REQUIRED');
  receipts.push(receipt);renders.set(audio.sha256,{audio,reviewSnippet,receipt,incoming:b,name:p.incoming,variantLabel:p.variantLabel});
 }
 const fallbackAudio=await read(catalog.fallback.file),f=catalog.fallback.receipt;
 if(fallbackAudio.sha256!==f.renderedSha256||fallbackAudio.frames!==48*44100||f.currentSha256!==current.sha256||f.incomingSha256!==current.sha256||f.renderQC?.passed!==true)throw Error('REVIEWED_FALLBACK_QC_REQUIRED');
 return {current,incoming,receipts,renders,fallbackAudio,feedback:catalog.feedback,
  loadReceipts:async({current:c,candidate})=>receipts.filter(r=>r.currentSha256===c.sha256&&r.incomingSha256===candidate.music.asset.sha256).map(r=>({...structuredClone(r),currentPlaybackRevision:c.playbackRevision}))};
}
