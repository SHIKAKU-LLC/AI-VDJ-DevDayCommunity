import {createFalClient} from '@fal-ai/client';
import {ConnectionError,FAL_MODELS} from '../connection/fal-contract.mjs';
export const SDK_VERSION='1.10.1';
export const STORAGE_INIT_URL='https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
export function falMediaUrl(value){let u;try{u=new URL(value);}catch{throw new ConnectionError('MEDIA_URL_REQUIRED');}if(u.protocol!=='https:'||u.username||u.password||!/(^|\.)fal\.media$/.test(u.hostname))throw new ConnectionError('MEDIA_URL_NOT_ALLOWED');return u.href;}
// Queue SDK supplies its own retry policy. This gate permits one external request per client.
export function createExplicitFalClient({credentials,fetchImpl=globalThis.fetch,signal=null,beforeSend=()=>true}){
 if(typeof credentials!=='string'||!credentials.trim())throw new ConnectionError('USER_KEY_REQUIRED');let dispatched=false;
 const guardedFetch=async(url,init={})=>{if(!beforeSend())throw new ConnectionError('CALLER_DISCONNECTED_NO_POST');const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||!['queue.fal.run','rest.fal.ai'].includes(u.hostname))throw new ConnectionError('SDK_TARGET_REFUSED');if(dispatched)throw new ConnectionError('SDK_RETRY_REFUSED');dispatched=true;return fetchImpl(url,{...init,redirect:'error',signal:signal??AbortSignal.timeout(15000)});};
 const client=createFalClient({credentials,fetch:guardedFetch,retry:{maxRetries:0}});
 return {...client,async storageInitiate(input){
  if(!input||Object.keys(input).some(k=>!['file_name','content_type','size'].includes(k))||! /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.file_name??'')||!['audio/wav','image/png','image/jpeg'].includes(input.content_type)||!Number.isSafeInteger(input.size)||input.size<1||input.size>4*1024*1024)throw new ConnectionError('SMALL_FILE_METADATA_REQUIRED');
  const headers=new Headers({'Content-Type':'application/json'});headers.set('Authorization','Key '+credentials);const r=await guardedFetch(STORAGE_INIT_URL,{method:'POST',headers,body:JSON.stringify({file_name:input.file_name,content_type:input.content_type})});if(!r.ok)throw new ConnectionError('STORAGE_INIT_FAILED');const v=await r.json();return {file_url:falMediaUrl(v.file_url),upload_url:falMediaUrl(v.upload_url),headers:{'Content-Type':input.content_type},size:input.size};
 }};
}
export function assertQueueInput(modelId,input,{firstTrackAllowed=false,fileUrl=falMediaUrl,assertFile=()=>{throw new ConnectionError('OWNED_UPLOAD_REQUIRED');}}={}){
 if(!input||typeof input.prompt!=='string'||input.prompt.length<1||input.prompt.length>2000)throw new ConnectionError('PROMPT_REQUIRED');
 if(modelId===FAL_MODELS[0]){if(Object.keys(input).some(k=>!['prompt','audio_url','extend_seconds_before','extend_seconds_after','output_format','seed','enable_prompt_expansion'].includes(k))||input.extend_seconds_before!==0||input.extend_seconds_after!==24||input.output_format!=='wav'||input.enable_prompt_expansion!==false)throw new ConnectionError('EXACT_CONTINUATION_REQUIRED');assertFile(fileUrl(input.audio_url),'audio/wav');}
 else if(modelId===FAL_MODELS[1]){if(Object.keys(input).some(k=>!['prompt','image_url','duration','resolution','prompt_expansion_mode','seed'].includes(k))||input.duration!==5||input.resolution!=='480P'||input.prompt_expansion_mode!=='disabled')throw new ConnectionError('EXACT_VIDEO_REQUIRED');assertFile(fileUrl(input.image_url),'image');}
 else if(modelId===FAL_MODELS[2]){if(!firstTrackAllowed)throw new ConnectionError('FIRST_TRACK_NOT_AUTHORIZED');if(Object.keys(input).some(k=>!['prompt','duration','output_format','enable_prompt_expansion','enable_safety_checker','seed'].includes(k))||input.duration!==24||input.output_format!=='wav'||input.enable_prompt_expansion!==false||input.enable_safety_checker!==true)throw new ConnectionError('EXACT_INITIAL_TRACK_REQUIRED');}
 else throw new ConnectionError('TARGET_NOT_ALLOWED');
 if(input.seed!==undefined&&(!Number.isSafeInteger(input.seed)||input.seed<0||input.seed>=2**32))throw new ConnectionError('INVALID_SEED');
}
