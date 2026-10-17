import {createProductionNativeHost} from '../worker/production-host.mjs';
import {createSupabaseStorageTransport} from '../worker/supabase-storage-transport.mjs';
import {createSupabasePrivateStore} from '../worker/supabase-private-store.mjs';
import {createFalPlatformAdapter} from '../worker/fal-platform-adapter.mjs';
import {createServerCredentialCustodian} from './key-custodian.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../../integration/qc/visual-policy.mjs';
import {createServerNativeLoader} from './native-limiter.mjs';

// Uses the same storage verification, provider adapters, PCM/DSP pipeline and
// playback observer as the Mac host. Only credential custody/HTTP entry differs.
export function createJudgeRoomFactory({configuration:c,createPool,withPlatformHeaders,readCredential,
 runtime,fetchImpl=fetch,now=Date.now}={}){
 const loadNative=createServerNativeLoader({expiresAtMs:c.expiresAtMs,now});
 const storage=roomId=>createSupabaseStorageTransport({enabled:true,roomId,projectUrl:c.projectURL,fetchImpl,now,
  readAuthHeaders:async input=>{let headers;await withPlatformHeaders(input,value=>{headers=new Headers(value);});return headers;}});
 const sourceTransport=storage(c.source.roomId);
 const source=createSupabasePrivateStore({enabled:true,roomId:c.source.roomId,transport:sourceTransport});
 let templatePromise;
 async function template(){return templatePromise??=(async()=>{
  const result={};for(const kind of ['audio','reference','video']){
   const asset=await source.assetStore.read(c.source[kind].assetId);
   if(asset.sha256!==c.source[kind].sha256)throw Error('JUDGE_SOURCE_CHANGED');result[kind]=asset;
  }return result;
 })().catch(error=>{templatePromise=undefined;throw error;});}
 return Object.freeze({async create({roomId,ownerCapability,reserveBudget}){
  let host;
  const platform=createFalPlatformAdapter({enabled:true,fetchImpl,now});
  const custodian=createServerCredentialCustodian({readCredential,platform,expiresAtMs:c.expiresAtMs,now,
   readScope:input=>host.io.repositoryPorts.readScope(input)});
  const owner=(scope,invoke)=>invoke({...scope,ownerCapability});
  const safety=async scope=>({approved:true,...scope,autoTopUp:c.autoTopUp,observedAtMs:c.billingObservedAtMs,
   evidenceSha256:c.billingEvidenceSha256,bounds:c.bounds,singlePersonMaximumCents:50,fivePersonMaximumCents:250,visualPolicy:TECHNICAL_VISUAL_POLICY,
   ...(c.autoTopUp?{topUpProtection:c.topUpProtection}:{})});
  const assets=await template(),targetTransport=storage(roomId);
  const target=createSupabasePrivateStore({enabled:true,roomId,transport:targetTransport});
  try{
   for(const name of ['audio','reference'])await target.assetStore.save({id:assets[name].assetId,bytes:assets[name].bytes,
    contentType:assets[name].contentType,binding:{kind:'owner-supplied-bootstrap'},
    provenance:{kind:'owner-supplied-bootstrap',actualGenerationThisRun:false}});
  }finally{target.close();targetTransport.close();}
  try{
   host=createProductionNativeHost({enabled:true,roomId,projectURL:c.projectURL,origin:c.origin,createPool,
    withPlatformHeaders,withOwnerAuthorization:owner,showMode:true,deferScheduler:true,serverManaged:true,runtime,loadNative,fetchImpl,now,
    bootstrapConfiguration:{audioAssetId:assets.audio.assetId,audioSha256:assets.audio.sha256,
     referenceAssetId:assets.reference.assetId,referenceSha256:assets.reference.sha256},
    operatorConfiguration:{enabled:true,approvals:{connection:true,media:true,trial:true},
     adapters:{enabled:true,custodian,balanceMode:'api',approvedVideoAssetIds:[],ownerBootstrapVideoApproved:true,readSafetyApproval:safety},
     trial:{mediaHost:new URL(c.projectURL).hostname,maximumParticipants:5,maximumCents:250,
      infrastructure:{verified:true,maximumUsd:Math.min(1.5,c.infrastructureMaximumUsd)},reserveBudget}}});
   await host.start();
   const call=async(action,body)=>{
    const response=await host.handleRequest(new Request(c.origin+'/api/rooms/'+roomId+'/operator/'+action,
     {method:body===undefined?'GET':'POST',headers:{origin:c.origin,'x-room-owner':ownerCapability,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}));
    if(!response.ok)throw Error('JUDGE_SOURCE_PREPARATION_HOLD');return response.json();
   };
   const status=await call('status');
   if(!status.assets?.some(a=>a.role==='saved-video')){
    const asset=assets.video,upload=await call('media/begin',{role:'saved-video',mimeType:asset.contentType,
     byteLength:asset.bytes.length,sha256:asset.sha256,referenceSha256:assets.reference.sha256,consent:true});
    for(let offset=0;offset<asset.bytes.length;offset+=32768)await call('media/chunk',{uploadId:upload.uploadId,offset,
     data:Buffer.from(asset.bytes.subarray(offset,offset+32768)).toString('base64')});
    await call('media/finish',{uploadId:upload.uploadId});
   }
   return {handleRequest:request=>host.handleRequest(request),async close(){await host.close();custodian.close();platform.close();}};
  }catch(error){await host?.close();custodian.close();platform.close();throw Error('JUDGE_RUNTIME_HOLD',{cause:error});}
 },close(){source.close();sourceTransport.close();}});
}
