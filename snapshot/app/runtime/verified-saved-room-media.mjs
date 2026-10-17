import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {decodeSavedWave,savedContextSha} from './saved-room-media.mjs';
import {transitionDigest,renderSpec} from './dj-transition-selector.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),exec=promisify(execFile);

export async function loadVerifiedSavedRoomMedia({directory,videoPath}){
  const catalog=JSON.parse(await fs.readFile(path.join(directory,'catalog.json'),'utf8'));
  if(catalog.method!=='verified-saved-room-catalog-v1'||catalog.cueSeconds!==24||catalog.parts?.length!==2)throw Error('VERIFIED_SAVED_CATALOG_REQUIRED');
  const read=async name=>{
    if(typeof name!=='string'||!/^[a-z0-9-]+\.wav$/.test(name))throw Error('SAVED_CATALOG_FILE_REFUSED');
    return decodeSavedWave(await fs.readFile(path.join(directory,name)));
  };
  const origin=await read(catalog.sourceProvenance.originFile);
  if(origin.sha256!==catalog.sourceProvenance.originSha256||origin.frames!==catalog.sourceProvenance.originFrameCount)throw Error('SAVED_ORIGIN_CHANGED');
  const parts=[];
  for(const p of catalog.parts){
    const audio=await read(p.file),l=p.sourceLineage;
    if(audio.frames!==24*44100||p.profile?.assetSha256!==audio.sha256||p.profile.frameCount!==audio.frames||l.originSha256!==origin.sha256||l.originFrameCount!==origin.frames||l.endFrame-l.startFrame!==audio.frames||l.startFrame<0||l.endFrame>origin.frames)throw Error('SAVED_RANGE_BINDING_REQUIRED');
    const pcm=Buffer.from(audio.pcm.buffer),original=Buffer.from(origin.pcm.buffer, l.startFrame*8,audio.frames*8);
    if(!pcm.equals(original)||sha(pcm)!==l.pcmSha256||savedContextSha(audio)!==p.contextSha256)throw Error('SAVED_RANGE_SAMPLES_CHANGED');
    parts.push({...audio,profile:p.profile,contextSha256:p.contextSha256,sourceLineage:l});
  }
  const pair=await read(catalog.pair.file),r=catalog.pair.receipt;
  if(pair.sha256!==r.renderedSha256||pair.frames!==r.renderedFrameCount||r.renderSpecSha256!==transitionDigest(renderSpec(r))||r.currentSha256!==parts[0].sha256||r.incomingSha256!==parts[1].sha256||r.renderQC?.passed!==true||r.type!=='saved-contiguous'||parts[0].sourceLineage.endFrame!==parts[1].sourceLineage.startFrame||!Buffer.from(pair.pcm.buffer).equals(Buffer.concat(parts.map(p=>Buffer.from(p.pcm.buffer)))))throw Error('VERIFIED_CONTIGUOUS_RENDER_REQUIRED');
  const fallbackAudio=await read(catalog.fallback.file);if(fallbackAudio.sha256!==catalog.fallback.receipt.renderedSha256||catalog.fallback.receipt.renderQC?.passed!==true)throw Error('FALLBACK_RENDER_QC_REQUIRED');
  const videoBytes=await fs.readFile(videoPath),probe=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',videoPath],{maxBuffer:1024*1024})).stdout),stream=probe.streams.find(s=>s.codec_type==='video'),duration=Number(probe.format.duration);
  if(!stream||Math.abs(duration-24)>.1)throw Error('ACTUAL24_VIDEO_REQUIRED');
  await exec('ffmpeg',['-v','error','-i',videoPath,'-an','-f','null','-'],{maxBuffer:1024*1024});
  return {audio:parts[0],incomingAudio:parts[1],pairAudio:pair,pairReceipt:r,fallbackAudio,maxDurationSeconds:48,sourceProvenance:catalog.sourceProvenance,
    video:{path:videoPath,sha256:sha(videoBytes),durationSeconds:duration,source:'local-edit',sourceVersion:0,sourceRequestId:'existing-editorial-montage24',qc:{passed:true,scope:'actual-file-full-decode-SHA-duration',frameWidth:stream.width,frameHeight:stream.height},compositionQC:{passed:true,scope:'existing-editorial24s-not-new-provider-composition',newContinuityVerified:false}}};
}
