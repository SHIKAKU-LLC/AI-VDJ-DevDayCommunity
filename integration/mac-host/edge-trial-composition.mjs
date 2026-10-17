import {createMacCloudEdgeSession} from './cloud-edge-runtime.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';

const fail=()=>{throw Error('MAC_EDGE_TRIAL_HOLD');};
const reply=(error,status=503)=>Response.json({error},{status,headers:{'cache-control':'no-store'}});
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const forbidden=['authorization','apikey','x-api-key','x-fal-key','x-room-owner','x-vdj-runtime','x-vdj-signature'];
export function macProductionRoute(path,roomId){
 if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//'))return null;
 let url;try{url=new URL(path,'https://ai-vdj.vercel.app');}catch{return null;}
 if(url.hash)return null;
 const match=url.pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})(?:\/(.*))?$/i);
 if(!match||match[1]!==roomId)return null;
 const suffix=match[2]??'';
 if(/^(?:cloud\/)?media\/[A-Za-z0-9_-]{1,100}$/.test(suffix)&&suffix!=='cloud/media/resolve')
  return /^\?sha256=[a-f0-9]{64}$/.test(url.search)?{method:'GET'}:null;
 if(url.search||path.includes('?'))return null;
 if(suffix===''||/^submissions\/[A-Za-z0-9_-]{1,100}$/.test(suffix)||suffix==='operator/status'||suffix==='native/capabilities')return {method:'GET'};
 if(/^(?:operator\/(?:connection|resume|media\/(?:begin|chunk|finish)|trial\/(?:prepare|start|status))|source\/(?:startup|ack)|player\/(?:register|binding|observe|stop|unload-stop)|cues\/(?:state|publish|reserve|ack|check|stop|start)|jobs\/(?:start|advance|read|stop|attachment)|cloud\/media\/resolve|playback\/preload)$/.test(suffix))return {method:'POST'};
 return null;
}

// The paired loopback listener is the only browser-facing surface. The owner
// proof and native approval/configuration stay inside this composition; callers
// cannot supply runtime permissions, platform credentials or a QC assertion.
export function createMacEdgeTrialRuntime({roomId,projectURL,enabled=false,expiresAtMs,signal,
 store,readCurrent,configuration={},companion=false,identity,readActivation,writeRegistration,keychainReadItem,readOperationalConfiguration,
 createNativeHost,createEdgeSession=createMacCloudEdgeSession,fetchImpl=globalThis.fetch,now=Date.now}={}){
 const created=now(),deadline=expiresAtMs??created+1800000;
 if(!uuid(roomId)||typeof enabled!=='boolean'||!Number.isSafeInteger(deadline)||deadline<=created||deadline>created+(companion?14400000:1800000)||
  typeof createEdgeSession!=='function')fail();
 let closed=signal?.aborted===true,preparing=false,activating=false,configuring=false,trialConfigured=false,nativeHost=null,bootstrapReady=false,closing;
 const bootstrapConfiguration=configuration.bootstrapConfiguration??{};
 const session=createEdgeSession({roomId,projectURL,enabled,expiresAtMs:deadline,signal,fetchImpl,now,companion,identity,
  ...(createNativeHost?{createNativeHost}:{})});
 const active=()=>{if(closed||signal?.aborted||now()>=deadline)fail();};
 const runtime=()=>{active();if(!enabled||!nativeHost)fail();return nativeHost;};
 const safeStatus=()=>{const alive=!closed&&!signal?.aborted&&now()<deadline,value=session.status(),sourceReady=bootstrapReady||nativeHost?.bootstrapReady===true;
  return {...value,connected:value.connected&&alive,runtimePrepared:alive&&!!session.registration(),runtimeActivated:alive&&!!nativeHost,
   nativeBootstrapReady:alive&&sourceReady,nativeTrialConfigured:alive&&trialConfigured,
   expiresAtMs:deadline,generationEnabled:alive&&trialConfigured&&sourceReady,actualProviderWorkVerified:false};};
 function close(){closed=true;return closing??=Promise.resolve().then(()=>session.close()).finally(()=>{nativeHost=null;bootstrapReady=false;});}
 const ended=()=>{void close().catch(()=>{});};signal?.addEventListener('abort',ended,{once:true});
 return Object.freeze({
  async attachOwner(input){active();await session.attachOwner(input);active();return safeStatus();},
  async readCloud(){active();const value=await session.readCloud();active();return value;},status:safeStatus,
  async prepareRegistration(){active();if(!enabled||preparing||session.registration()||typeof writeRegistration!=='function')fail();
   preparing=true;try{const registration=await session.prepareRegistration();active();await writeRegistration(registration);active();return structuredClone(registration);}
   catch{await close();fail();}finally{preparing=false;}},
  async activateNative(){active();const registration=session.registration();
   if(!enabled||!registration||activating||nativeHost||typeof readActivation!=='function')fail();
   activating=true;try{const approval=await readActivation(structuredClone(registration));active();
    if(approval?.approved!==true||cueDigest(approval.registration)!==cueDigest(registration)||
     Object.keys(approval).some(k=>!['approved','registration','keychainApproval'].includes(k)))fail();
    const operatorConfiguration={enabled:true,...configuration.operatorConfiguration,
     adapters:{enabled:false,...configuration.operatorConfiguration?.adapters},
     approvals:{connection:false,media:true,trial:false,...configuration.operatorConfiguration?.approvals}};
    nativeHost=await session.activateNative({approved:true,configuration:{...configuration,deferScheduler:companion,bootstrapConfiguration,operatorConfiguration,
     credentialForOperation:configuration.credentialForOperation??(async()=>{throw Error('PROVIDER_CUSTODY_REQUIRED');})},
     ...(approval.keychainApproval?{keychainApproval:approval.keychainApproval,keychainReadItem}:{})});
    active();return safeStatus();
   }catch{fail();}finally{activating=false;}},
  async prepareNativeBootstrap(){const host=runtime();if(!store?.read||typeof readCurrent!=='function'||bootstrapReady)fail();
   const source=await readCurrent();active();
   if(!source||source.playback?.actual===true||source.playback?.revision!==0||source.playback?.phase!=='IDLE')fail();
   const selections=[['audioAssetId',source.music?.sha256],['referenceAssetId',source.video?.referenceSha256]];
   for(const [field,hash] of selections){const item=await store.read(source[field]);active();
    if(item.sha256!==hash||item.provenance?.kind!=='owner-supplied-bootstrap'||
     item.binding?.kind!=='owner-supplied-bootstrap'||Object.keys(item.binding).length!==1)fail();
    await host.io.privateStore.assetStore.save({id:item.assetId,bytes:item.bytes,contentType:item.contentType,
     binding:{kind:'owner-supplied-bootstrap'},provenance:{kind:'owner-supplied-bootstrap',actualGenerationThisRun:false,
      rawSha256:source.music.sha256,referenceSha256:source.video.referenceSha256}});active();}
   const selected=await host.prepareApprovedBootstrap({audioAssetId:source.audioAssetId,audioSha256:source.music.sha256,
    referenceAssetId:source.referenceAssetId,referenceSha256:source.video.referenceSha256,
    motifId:source.video.motifId,fixedBpm:source.quality.fixedBpm,control:source.music.control});active();bootstrapReady=true;
   return {nativeBootstrapReady:true,sourceSha256:selected.sourceSha256,qcEvidenceSha256:selected.qcEvidenceSha256,actualPlayback:false};},
  async readProviderMetadata(){runtime();const value=await session.readProviderMetadata();active();return value;},
  async configureNativeTrial(){runtime();if(configuring||trialConfigured||typeof readOperationalConfiguration!=='function')fail();
   configuring=true;try{const configuration=await readOperationalConfiguration(structuredClone(session.registration()));active();
    if(!configuration||Object.keys(configuration).sort().join(',')!=='connectionId,operatorConfiguration')fail();
    const result=await session.configureApprovedOperator(configuration);active();trialConfigured=true;return result;
   }finally{configuring=false;}},
  async handleProductionRequest(request){
   const url=new URL(request.url),route=macProductionRoute(url.pathname+url.search,roomId);
   if(!route||request.method!==route.method)return reply('MAC_PRODUCTION_ROUTE_REQUIRED',404);
   if(forbidden.some(k=>request.headers.has(k)))return reply('MAC_PRODUCTION_AUTH_REFUSED',403);
   try{const host=runtime();return await session.withOwnerAuthorization({roomId},async context=>{
    active();const headers=new Headers({'origin':'https://ai-vdj.vercel.app'});
    if(request.headers.has('content-type'))headers.set('content-type',request.headers.get('content-type'));
    headers.set('x-room-owner',context.ownerCapability);
    const body=request.method==='POST'?new Uint8Array(await request.arrayBuffer()):undefined;
    if(body&&body.byteLength>32*1024*1024)fail();active();
    const path=url.pathname===`/api/rooms/${roomId}/native/capabilities`?'/api/room-capabilities':url.pathname+url.search;
    const result=await host.handleRequest(new Request('https://ai-vdj.vercel.app'+path,{method:route.method,headers,
     ...(body?{body}:{}),signal:request.signal}));active();return result;
   });}catch{return reply('MAC_PRODUCTION_HOLD',409);}
  },
  async close(){signal?.removeEventListener('abort',ended);await close();},
 });
}
