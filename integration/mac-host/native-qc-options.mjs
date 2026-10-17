// These executable paths come only from the native launch environment. They
// never come from a browser request, uploaded manifest or provider response.
export function readNativeQcOptions(env=process.env){
 const options={};
 for(const [variable,option] of [['VDJ_QC_PYTHON','python'],['VDJ_QC_DSP','dspModule'],
  ['VDJ_QC_FFMPEG','ffmpeg'],['VDJ_QC_FFPROBE','ffprobe']]){
  if(!Object.hasOwn(env,variable))continue;
  const value=env[variable];
  if(typeof value!=='string'||!value.length||value.includes('\0')||/[\r\n]/.test(value))
   throw Error('TRUSTED_RUNTIME_PATHS_REQUIRED');
  options[option]=value;
 }
 return Object.freeze(options);
}
import {createPortableNativeRuntime} from '../../cloud/worker/native-runtime.mjs';
import {prepareBootstrap} from '../runtime/bootstrap.mjs';


export function createLaunchBootstrapPreparer({options=readNativeQcOptions(),createRuntime=createPortableNativeRuntime}={}){
 let localQc,closing,closed=false;
 return Object.freeze({
  async prepare(input){
   if(closed)throw Error('NATIVE_BOOTSTRAP_CLOSED');
   localQc??=Promise.resolve().then(()=>createRuntime(options));
   const runtime=await localQc;
   if(closed)throw Error('NATIVE_BOOTSTRAP_CLOSED');
   return prepareBootstrap({...input,inspect:runtime.inspectBootstrap});
  },
  close(){closed=true;return closing??=Promise.resolve().then(async()=>{await (await localQc)?.close();});},
 });
}
