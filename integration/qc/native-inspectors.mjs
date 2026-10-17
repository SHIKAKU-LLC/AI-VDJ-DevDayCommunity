// Node-only staging/worker adapter. The portable validator imports none of this.
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sha256} from './portable-qc.mjs';
const run=promisify(execFile);
export function createNativeInspectors({python='python3',dspModule,ffmpeg='ffmpeg',ffprobe='ffprobe',timeoutMs=120000}={}) {
 const worker=fileURLToPath(new URL('./native-worker.py',import.meta.url));
 async function inspect(channel,input) {
  if(channel!=='video'&&!dspModule)throw Error('TRUSTED_DSP_MODULE_REQUIRED');
  const dir=await mkdtemp(path.join(tmpdir(),'vdj-portable-qc-'));
  try {
   const request={channel,inputDigest:input.inputDigest,layout:input.layout,playbackRevision:input.playbackRevision,
     artifactEncoding:'stable-peak-timestamp-v2'};
   const initial={bytes:new Uint8Array(input.bytes),...(channel!=='video'?{sourceBytes:new Uint8Array(input.sourceBytes),...(channel==='music'?{contextBytes:new Uint8Array(input.contextBytes)}:{})}:{})};
   await writeFile(path.join(dir,channel==='video'?'input.mp4':'input.wav'),initial.bytes,{mode:0o600});
   if(channel!=='video'){await writeFile(path.join(dir,'parent.wav'),initial.sourceBytes,{mode:0o600});if(channel==='music')await writeFile(path.join(dir,'context.wav'),initial.contextBytes,{mode:0o600});}
   await writeFile(path.join(dir,'request.json'),JSON.stringify(request),{mode:0o600});
   let stdout;
   try {({stdout}=await run(python,[worker,'--directory',dir,'--ffmpeg',ffmpeg,'--ffprobe',ffprobe,...(dspModule?['--dsp',dspModule]:[])],{timeout:timeoutMs,maxBuffer:2*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));}
   catch{throw Error('NATIVE_DECODE_OR_MEASUREMENT_FAILED');}
   const m=JSON.parse(stdout);
   if(m.workerSha256!==await sha256(await readFile(worker)))throw Error('WORKER_CHANGED');
   if(channel==='music'){
    if(!['input.wav','cue.wav'].includes(m.cueFile)||m.dspSha256!==await sha256(await readFile(dspModule)))throw Error('DSP_OR_CUE_CHANGED');
    m.cueBytes=new Uint8Array(await readFile(path.join(dir,m.cueFile)));delete m.cueFile;
    m.renderBytes=new Uint8Array(await readFile(path.join(dir,'transition.wav')));
   }
   if(channel==='join'){if(m.dspSha256!==await sha256(await readFile(dspModule)))throw Error('DSP_CHANGED');m.renderBytes=new Uint8Array(await readFile(path.join(dir,'transition.wav')));}
   return m;
  } finally {await rm(dir,{recursive:true,force:true});}
 }
 return {inspectAudio:input=>inspect('music',input),inspectVideo:input=>inspect('video',input),inspectJoin:input=>inspect('join',input)};
}
