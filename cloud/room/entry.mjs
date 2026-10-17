// Supabase Edge entry. Platform values remain inside Supabase.
import {createRoomHandler} from './handler.mjs';
import {createOwnerLinkPlatform} from './owner-link-platform.mjs';
import {createHostSessionHandler} from '../generation/owner-connection.mjs';
import {createEdgeRuntimeBroker} from './runtime-broker.mjs';
import {RUNTIME_BROKER_CONFIGURATION as runtimeConfiguration} from './runtime-broker-config.mjs';
const projectURL=Deno.env.get('SUPABASE_URL');
const platformKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!projectURL||!platformKey)throw Error('PLATFORM_CONTEXT_REQUIRED');
const serverHeaders=new Headers({'Content-Type':'application/json'});
serverHeaders.set('apikey',platformKey);
serverHeaders.set('Authorization','Bearer '+platformKey);
const knownCodes=new Set(['ROOM_NOT_FOUND','OPERATION_NOT_FOUND','ROOM_EXPIRED','ACTOR_DENIED',
 'INVITE_DENIED','OWNER_DENIED','ACCEPTANCE_OFF','NONCE_CONFLICT','REVISION_CONFLICT',
 'ROOM_ALREADY_ACTIVE','RATE_LIMITED','PARTICIPANT_CAP','ROOM_OPERATION_CAP','SUBMISSION_CAP',
 'PROVIDER_NOT_CONNECTED','NICKNAME_INVALID','PROMPT_INVALID','NONCE_INVALID','CONTROL_INVALID',
 'CAPABILITY_INVALID','ROUTE_NOT_FOUND']);
async function rpc(args){
 const r=await fetch(projectURL+'/rest/v1/rpc/vdj_room_request',{
  method:'POST',headers:serverHeaders,body:JSON.stringify(args),signal:AbortSignal.timeout(8000)});
 const data=await r.json();if(!r.ok)throw Error(knownCodes.has(data?.message)?data.message:'ROOM_BACKEND_UNAVAILABLE');
 return data;
}
async function verifyOwner(bearer){
 const headers=new Headers(serverHeaders);headers.set('Authorization','Bearer '+bearer);
 const r=await fetch(projectURL+'/auth/v1/user',{headers,signal:AbortSignal.timeout(5000)});
 if(!r.ok)return null;const user=await r.json();
 // Auth service validates the session; SQL additionally requires the fixed UID allowlist.
 return typeof user.id==='string'&&user.email_confirmed_at?user.id:null;
}
const {requestLink,exchangeLink}=createOwnerLinkPlatform({projectURL,serverHeaders});
const roomHandler=createRoomHandler({rpc,verifyOwner,requestLink,exchangeLink});
const hostHandler=createHostSessionHandler({readRoom:(room_id,capability)=>rpc({op:'read',room_id,capability}),
 authorizeOwner:async(room_id,capability)=>{
  const r=await fetch(projectURL+'/rest/v1/rpc/vdj_generation_request',{method:'POST',headers:serverHeaders,
   body:JSON.stringify({op:'cueState',room_id,capability,payload:{}}),redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('OWNER_DENIED');
 }});
const runtimeBroker=createEdgeRuntimeBroker({enabled:runtimeConfiguration.enabled,projectURL,platformHeaders:serverHeaders,
 readApprovedWorker:async id=>runtimeConfiguration.approvedWorkers.find(worker=>worker.workerId===id)??null,
 readApprovedDevice:async id=>runtimeConfiguration.approvedDevices?.find(device=>device.workerId===id)??null});
Deno.serve(async request=>(await runtimeBroker.handleRequest(request))??(await hostHandler(request))??roomHandler(request));
