import {createRuntimeRequestVerifier} from './runtime-request-proof.mjs';
import {validateRuntimeCommand} from './runtime-query-contract.mjs';
import {createSupabaseStorageTransport} from '../worker/supabase-storage-transport.mjs';
import {PRIVATE_BUCKET_TARGET} from '../worker/storage-contract.mjs';
const JSON_LIMIT=262144,MEDIA_LIMIT=32*1024*1024;
const fail=()=>{throw Error('RUNTIME_BACKEND_HOLD');};
const output=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const generation=new Set(['permit','begin','read','stop','claim','submitted','unknown','complete','failed','held',
 'cueState','cuePublish','cueReserve','cueReservation','cueAck','cueStop','cueStart']);
async function bytes(request,limit){const reader=request.body?.getReader(),chunks=[];let size=0;
 try{if(reader)for(;;){const p=await reader.read();if(p.done)break;if((size+=p.value.length)>limit)fail();chunks.push(p.value);}
  const result=new Uint8Array(size);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}return result;
 }finally{await reader?.cancel().catch(()=>{});}}
async function jsonResponse(response,limit=1048576){if(!response||response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json')fail();
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(response,limit)));}
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
/** Optional Edge entry. Platform context never appears in the request/response.
 * Native requests need an explicitly pinned short-lived runtime key AND owner
 * proof. Owner/browser proof alone cannot reach private state/Storage mutation.
 */
export function createEdgeRuntimeBroker({enabled=false,projectURL,platformHeaders,readApprovedWorker,readApprovedDevice,
 fetchImpl=globalThis.fetch,now=Date.now,origin='https://ai-vdj.vercel.app'}={}){
 const verify=createRuntimeRequestVerifier({enabled,readApprovedWorker,readApprovedDevice,now,
  readScope:({roomId,ownerCapability})=>rpc('vdj_runtime_request',{action:'scope',requested_room:roomId,capability:ownerCapability,payload:{},runtime:{}})});let closed=false;
 async function rpc(name,args){
  if(closed||!enabled)fail();const url=new URL(projectURL);if(url.protocol!=='https:'||url.port||!/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)||url.origin!==projectURL)fail();
  const headers=new Headers(platformHeaders);if(!headers.get('apikey')||!headers.get('authorization'))fail();
  headers.set('content-type','application/json');headers.set('content-profile','public');headers.set('accept-profile','public');
  const response=await fetchImpl(projectURL+'/rest/v1/rpc/'+name,{method:'POST',headers,body:JSON.stringify(args),
   redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(8000)});
  const value=await jsonResponse(response);if(!response.ok)fail();return value;
 }
 const handler=async request=>{
  const path=new URL(request.url).pathname.replace(/^\/(?:functions\/v1\/)?ai-vdj-room(?=\/|$)/,'');
  const match=path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/runtime\/(scope|query|generation|room|storage\/(describe|get|put|sign))$/i);if(!match)return null;
  if(!enabled||closed)return output({error:'RUNTIME_NOT_ACTIVATED'},503);
  // Native-only response: no CORS/OPTIONS and no public browser entrypoint.
  if(request.method!=='POST'||request.headers.get('origin')!==origin||request.headers.has('sec-fetch-site')||new URL(request.url).search)return output({error:'RUNTIME_AUTH_HOLD'},403);
  const roomId=match[1],route=match[2];let storage;
  try{
   const raw=await bytes(request,route==='storage/put'?MEDIA_LIMIT:JSON_LIMIT);
   if(route==='scope'){
    if(request.headers.has('authorization')||request.headers.has('apikey')||request.headers.has('x-fal-key')||
     request.headers.get('content-type')!=='application/json'||new TextDecoder().decode(raw)!=='{}')fail();
    return output(await rpc('vdj_runtime_request',{action:'scope',requested_room:roomId,
     capability:request.headers.get('x-room-owner'),payload:{},runtime:{}}));
   }
   const normalized=new Request(origin+path,{method:'POST',headers:request.headers});
   const runtime=await verify({request:normalized,body:raw,roomId}),capability=request.headers.get('x-room-owner');
   let data;if(route!=='storage/put'){
    if(request.headers.get('content-type')!=='application/json')fail();data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));if(!plain(data))fail();
   }
   const args={requested_room:roomId,capability,runtime};
   const authorizeRuntime=payload=>rpc('vdj_runtime_request',{...args,action:'authorize',payload});
   if(route==='query')return output(await rpc('vdj_runtime_request',{...args,action:'query',payload:validateRuntimeCommand(data)}));
   if(route==='generation'||route==='room'){
    if(!exact(data,['op','payload'])||!plain(data.payload)||(route==='generation'?!generation.has(data.op):!['read','submission'].includes(data.op)))fail();
    await authorizeRuntime({});const value=await rpc(route==='generation'?'vdj_generation_request':'vdj_room_request',
     {op:data.op,room_id:roomId,capability,payload:data.payload,...(route==='room'?{verified_uid:null}:{})});
    if(now()>=runtime.expiresAtMs)fail();return output(value);
   }
   await authorizeRuntime({});
   storage=createSupabaseStorageTransport({enabled:true,roomId,projectUrl:projectURL,now,fetchImpl,
    readAuthHeaders:async()=>{if(now()>=runtime.expiresAtMs)fail();const value=new Headers(platformHeaders);
     return new Headers([['apikey',value.get('apikey')],['authorization',value.get('authorization')]]);}});
   const base={bucket:PRIVATE_BUCKET_TARGET,signal:AbortSignal.timeout(8000)};
   if(route==='storage/describe'){if(!exact(data,[]))fail();return output(await storage.describeBucket(base));}
   if(route==='storage/sign'){
    if(!exact(data,['path','expiresIn'])||!Number.isSafeInteger(data.expiresIn)||data.expiresIn<1||data.expiresIn>3600)fail();
    let deliveryDeadline=runtime.expiresAtMs;
    if(runtime.registeredDevice===true){
     const fresh=await rpc('vdj_runtime_request',{...args,action:'scope',payload:{},runtime:{}});
     if(fresh.roomId!==runtime.roomId||fresh.sessionId!==runtime.sessionId||fresh.controlRevision!==runtime.controlRevision||
       !Number.isSafeInteger(fresh.expiresAtMs))fail();
     deliveryDeadline=fresh.expiresAtMs;
    }
    // A reviewed registered device may issue a source delivery URL for the
    // finite operation (<=1h), inside the real room lifetime. The short request
    // lease remains independently checked; a legacy trial still cannot do this.
    if(now()+data.expiresIn*1000>deliveryDeadline)fail();
    return output(await storage.signObject({...base,...data}));
   }
   if(route==='storage/get'){
    if(!exact(data,['path','maximumBytes']))fail();const record=await storage.readObject({...base,...data});
    if(!record)return output({missing:true},404);
    // Keep Storage's authenticated bounded stream, close its transport at EOF.
    const reader=record.body.getReader(),selected=storage;storage=null;
    return new Response(new ReadableStream({async pull(controller){try{const p=await reader.read();if(now()>=runtime.expiresAtMs)fail();
      if(p.done){selected.close();controller.close();}else controller.enqueue(p.value);}catch{await reader.cancel().catch(()=>{});selected.close();controller.error(Error('RUNTIME_STREAM_HOLD'));}},
     async cancel(){await reader.cancel().catch(()=>{});selected.close();}}),{headers:{'content-type':record.contentType,'cache-control':'no-store','x-content-type-options':'nosniff'}});
   }
   const objectPath=request.headers.get('x-vdj-object-path');
   if(!objectPath||!raw.length)fail();
   return output(await storage.putObjectIfAbsent({...base,path:objectPath,bytes:raw,contentType:request.headers.get('content-type'),upsert:false}));
  }catch(error){const reason=/^[A-Z0-9_]{1,100}$/.test(error?.message??'')?error.message:'FAILED';console.warn('VDJ_RUNTIME_HOLD',route,reason);return output({error:'RUNTIME_BACKEND_HOLD'},409);}
  finally{storage?.close();}
 };
 return Object.freeze({handleRequest:handler,close(){closed=true;},capabilities:()=>({enabled:enabled&&!closed,defaultActivation:false,
  platformLeavesEdge:false,dbPasswordRequired:false,workerPublicKeyRequired:true,maximumSessionMs:1800000})});
}
