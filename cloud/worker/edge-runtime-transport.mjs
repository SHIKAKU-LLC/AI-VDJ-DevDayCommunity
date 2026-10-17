import {DispatchError} from '../generation/dispatch.mjs';
import {compileRuntimeQuery} from '../room/runtime-query-contract.mjs';
import {PRIVATE_BUCKET_TARGET} from './storage-contract.mjs';
const fail=c=>{throw new DispatchError(c);},registered=new WeakSet();
export const isEdgeRuntimeTransport=v=>registered.has(v);
const jsonLimit=1048576,mediaLimit=32*1024*1024,encoder=new TextEncoder();
const same=(a,b)=>['roomId','sessionId','controlRevision'].every(k=>a?.[k]===b?.[k]);
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
async function boundedBytes(response,limit){const reader=response.body?.getReader();if(!reader||response.redirected)fail('RUNTIME_RESPONSE_HOLD');
 const chunks=[];let size=0;try{for(;;){const p=await reader.read();if(p.done)break;if((size+=p.value.length)>limit)fail('RUNTIME_RESPONSE_HOLD');chunks.push(p.value);}
  const result=new Uint8Array(size);let at=0;for(const c of chunks){result.set(c,at);at+=c.length;}return result;
 }finally{await reader.cancel().catch(()=>{});}}
/** Mac/native execution transport. Sends owner+runtime proof, never platform
 * credentials or SQL text. No DB pool, platform header callback or env discovery.
 */
export function createEdgeRuntimeTransport({enabled=false,roomId,origin='https://ai-vdj.vercel.app',
 projectURL,withOwnerAuthorization,signer,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=8000}={}){
 if(typeof enabled!=='boolean'||!uuid(roomId)||origin!=='https://ai-vdj.vercel.app'||
  !Number.isSafeInteger(timeoutMs)||timeoutMs<5||timeoutMs>8000)fail('RUNTIME_TRANSPORT_CONFIGURATION_REQUIRED');
 let closed=false;const pending=new Set();let sequence=Promise.resolve();
 let endpoint=origin;
 if(projectURL!==undefined){const project=new URL(projectURL);if(project.origin!==projectURL||project.protocol!=='https:'||
  !/^[a-z0-9]+\.supabase\.co$/.test(project.hostname)||project.username||project.password||project.port)fail('RUNTIME_TRANSPORT_CONFIGURATION_REQUIRED');
  endpoint=projectURL+'/functions/v1/ai-vdj-room';}
 const active=()=>{if(!enabled||closed)fail('RUNTIME_TRANSPORT_NOT_ACTIVATED');};
 async function perform(route,payload,{binary=false,objectPath=null,contentType='application/json',signal}={}){
  active();if(typeof withOwnerAuthorization!=='function'||typeof signer?.sign!=='function')fail('RUNTIME_CONTEXT_REQUIRED');
  const registration=signer.registration();if(registration?.roomId!==roomId||registration.expiresAtMs<=now())fail('RUNTIME_CONTEXT_REQUIRED');
  const scope={roomId,['sessionId']:registration.sessionId,controlRevision:registration.controlRevision};
  const controller=new AbortController();pending.add(controller);const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)controller.abort();let timer,finished=false,used=false,task;
  const path='/api/rooms/'+roomId+'/runtime/'+route;
  const stopped=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new DispatchError('RUNTIME_REQUEST_HOLD')),{once:true});
   if(controller.signal.aborted)reject(new DispatchError('RUNTIME_REQUEST_HOLD'));
   timer=setTimeout(abort,timeoutMs);});stopped.catch(()=>{});
  const check=()=>{active();if(finished||controller.signal.aborted||now()>=registration.expiresAtMs)fail('RUNTIME_REQUEST_HOLD');};
  try{
   const wrapper=Promise.resolve().then(()=>{check();return withOwnerAuthorization(scope,context=>{
    check();if(used||!same(context,scope)||!/^[a-f0-9]{64}$/.test(context.ownerCapability??''))fail('RUNTIME_CONTEXT_REQUIRED');used=true;
    task=(async()=>{const value=typeof payload==='function'?payload(context):payload,
      bytes=binary?Uint8Array.from(value):encoder.encode(JSON.stringify(value));
     if(!bytes.length||bytes.length>(binary?mediaLimit:262144))fail('RUNTIME_REQUEST_HOLD');
     const proof=await signer.sign({path,body:bytes,ownerCapability:context.ownerCapability,contentType,objectPath});check();
     const headers=new Headers({origin,'content-type':contentType,'x-room-owner':context.ownerCapability,...proof});
     if(objectPath)headers.set('x-vdj-object-path',objectPath);
     const response=await fetchImpl(endpoint+path,{method:'POST',headers,body:bytes,redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal});check();
     const data=await boundedBytes(response,binary&&route==='storage/get'?mediaLimit:route==='storage/get'?mediaLimit:jsonLimit);check();
     const mime=response.headers.get('content-type')?.split(';')[0];
     if(route==='storage/get'&&response.status===200){if(!['audio/wav','video/mp4','image/png','image/jpeg','application/json'].includes(mime))fail('RUNTIME_RESPONSE_HOLD');
      return {bytes:data,contentType:mime};}
     if(mime!=='application/json')fail('RUNTIME_RESPONSE_HOLD');let result;
     try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{fail('RUNTIME_RESPONSE_HOLD');}
     if(route==='storage/get'&&response.status===404&&result?.missing===true)return null;
     if(!response.ok)fail('RUNTIME_HTTP_'+response.status+'_HOLD');return result;
    })();task.catch(()=>{});return task;
   });});wrapper.catch(()=>{});await Promise.race([wrapper,stopped]);
   if(!used||!task)fail('RUNTIME_CONTEXT_REQUIRED');const result=await Promise.race([task,stopped]);check();return result;
  }catch(error){const held=new DispatchError('RUNTIME_REQUEST_HOLD');held.cause=error;throw held;}
  finally{finished=true;clearTimeout(timer);controller.abort();pending.delete(controller);signal?.removeEventListener('abort',abort);}
 }
 // Registered-device leases advance monotonically in PostgreSQL. Preserve
 // request order so a slower earlier request cannot arrive after its renewal.
 // Failures are returned once; queue recovery never retries a mutation.
 function invoke(...args){const task=sequence.then(()=>perform(...args));sequence=task.catch(()=>{});return task;}
 const query=(statement,values,writable)=>invoke('query',context=>compileRuntimeQuery({statement,values,roomId,
  ownerCapability:context.ownerCapability,writable}));
 const rpc=(route,op,requestedRoom,capability,payload={})=>{
  if(requestedRoom!==roomId)fail('RUNTIME_SCOPE_REQUIRED');return invoke(route,context=>{
   if(capability!==context.ownerCapability)fail('RUNTIME_SCOPE_REQUIRED');return {op,payload};});};
 const close=()=>{closed=true;for(const controller of pending)controller.abort();};
 const repository=Object.freeze({query:(s,v)=>query(s,v,false),privateStateQuery:(s,v)=>query(s,v,true),
  request:(op,id,cap,payload)=>rpc('generation',op,id,cap,payload),readRoom:(id,cap)=>rpc('room','read',id,cap),
  roomRead:(op,id,cap,payload)=>rpc('room',op,id,cap,payload),close,
  capabilities:()=>({defaultActivation:false,transportConfigured:enabled&&!closed,dbPasswordRequired:false,platformCredentialRequired:false})});
 const valid=input=>{active();if(input?.bucket!==PRIVATE_BUCKET_TARGET||!(input.signal instanceof AbortSignal))fail('RUNTIME_STORAGE_SCOPE_REQUIRED');};
 const storage=Object.freeze({async describeBucket(input){valid(input);return invoke('storage/describe',{},input);},
  async readObject(input){valid(input);const record=await invoke('storage/get',{path:input.path,maximumBytes:input.maximumBytes},input);
   if(!record)return null;if(record.bytes.length>input.maximumBytes)fail('RUNTIME_RESPONSE_HOLD');return {contentType:record.contentType,contentLength:record.bytes.length,
    body:new ReadableStream({start(controller){controller.enqueue(record.bytes);controller.close();}})};},
  async putObjectIfAbsent(input){valid(input);if(input.upsert!==false||!(input.bytes instanceof Uint8Array))fail('RUNTIME_STORAGE_SCOPE_REQUIRED');
   return invoke('storage/put',input.bytes,{...input,binary:true,objectPath:input.path});},
  async signObject(input){valid(input);return invoke('storage/sign',{path:input.path,expiresIn:input.expiresIn},input);},close});
 const transport=Object.freeze({repository,storage,close,capabilities:()=>({enabled:enabled&&!closed,roomId,projectURL,maximumSessionMs:1800000,
  platformLeavesEdge:false,dbPasswordRequired:false,credentialsPersisted:false})});registered.add(transport);return transport;
}
