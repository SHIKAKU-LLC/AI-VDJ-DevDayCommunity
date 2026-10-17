import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
// Original image bytes are privately staged and fully decoded by the same
// trusted native tools. A signature alone cannot freeze a broken reference.
export function createNativeReferenceInspector({ffmpeg='ffmpeg',ffprobe='ffprobe',timeoutMs=120000}={}){
 return async bytes=>{
  if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>4*1024*1024)throw Error('REFERENCE_NATIVE_DECODE_REQUIRED');
  const copy=Buffer.from(bytes),directory=await mkdtemp(path.join(tmpdir(),'vdj-reference-qc-'));
  try{
   const file=path.join(directory,'reference');await writeFile(file,copy,{mode:0o600});
   const {stdout}=await run(ffprobe,['-v','error','-show_entries','stream=codec_name,codec_type,width,height','-of','json',file],{timeout:timeoutMs,maxBuffer:65536});
   const streams=JSON.parse(stdout).streams;
   if(!Array.isArray(streams)||streams.length!==1||streams[0].codec_type!=='video'||!['png','mjpeg'].includes(streams[0].codec_name))throw Error('REFERENCE_NATIVE_DECODE_REQUIRED');
   const {width,height}=streams[0];if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192||width*height>32*1024*1024)throw Error('REFERENCE_NATIVE_DECODE_REQUIRED');
   await run(ffmpeg,['-nostdin','-v','error','-xerror','-err_detect','explode','-i',file,'-map','0:v:0','-f','null','-'],{timeout:timeoutMs,maxBuffer:65536});
   return {sha256:createHash('sha256').update(copy).digest('hex'),fullyDecoded:true,width,height};
  }catch{throw Error('REFERENCE_NATIVE_DECODE_REQUIRED');}
  finally{await rm(directory,{recursive:true,force:true});}
 };
}
