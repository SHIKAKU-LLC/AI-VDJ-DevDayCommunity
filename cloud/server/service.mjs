const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const response=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
// Only the server may resolve secrets and instantiate CPU workers. Public
// requests retain the existing per-room owner/participant proof checks.
export function createJudgeCloudService({configuration:c,store,createRuntime,forwardRoom,now=Date.now}={}){
 const rooms=new Map();let closed=false;
 const live=()=>!closed&&now()<c.expiresAtMs;
 async function runtime(roomId,capability){
  await store.authorize(roomId,capability);
  if(!live())throw Error('JUDGE_CLOSED');
  let pending=rooms.get(roomId);
  if(!pending){
   if(rooms.size>=c.maximumResidentRooms)throw Error('JUDGE_CAPACITY');
   pending=Promise.resolve().then(()=>createRuntime({roomId,ownerCapability:capability,
    reserveBudget:({plan})=>store.reserve({roomId,capability,planId:plan.planId,cents:plan.operations.length*50})}));
   rooms.set(roomId,pending);
   pending.catch(()=>{if(rooms.get(roomId)===pending)rooms.delete(roomId);});
  }
  return pending;
 }
 return Object.freeze({async handleRequest(request){
  const url=new URL(request.url),path=url.pathname;
  if(path==='/healthz'&&request.method==='GET')return response({ready:live(),mode:'judge-cloud'},live()?200:410);
  if(!live())return response({error:'JUDGE_CLOSED'},410);
  const origin=request.headers.get('origin');
  if(origin&&origin!==c.origin)return response({error:'ORIGIN_DENIED'},403);
  if(!['GET','POST'].includes(request.method))return response({error:'METHOD_DENIED'},405);
  try{
   if(path==='/api/room-capabilities'&&request.method==='GET')return response({mode:'judge-cloud',durable:true,
    ownerLogin:'temporary-public',serverManaged:true,expiresAtMs:c.expiresAtMs,generation:true,autoDJ:true,
    cloud:{generationJobs:true,portableQC:true,browserPlayback:true,clipRelativeTimeline:true,playerObserver:true,macRequired:false}});
   if(path==='/api/judge/rooms'&&request.method==='POST'){
    if(origin!==c.origin||!request.headers.get('content-type')?.startsWith('application/json'))return response({error:'JUDGE_DENIED'},403);
    const text=await request.text();if(text.length>2048)return response({error:'BODY_TOO_LARGE'},413);
    const body=JSON.parse(text);
    if(!body||Object.keys(body).sort().join(',')!=='joinCode,nonce,ownerToken'||!uuid(body.nonce)||!sha(body.ownerToken)||!sha(body.joinCode))return response({error:'JUDGE_DENIED'},400);
    const receipt=await store.create(body);
    return response({...receipt,joinUrl:c.origin+'/join/'+receipt.roomId+'?code='+receipt.joinCode,serverManaged:true},201);
   }
   const match=path.match(/^\/api\/rooms\/([a-f0-9-]{36})(?:\/(.*))?$/i);
   if(!match)return response({error:'ROUTE_NOT_FOUND'},404);
   const capability=request.headers.get('x-room-owner');
   if(!capability)return forwardRoom(request);
   if(!sha(capability)||request.headers.has('authorization'))return response({error:'JUDGE_DENIED'},403);
   // These inputs belong exclusively to the deployment operator. Judges use
   // the fixed, verified source and never submit provider credentials/media.
   if(/^(?:operator\/connection|operator\/media\/)/.test(match[2]??''))return response({error:'JUDGE_MANAGED_SOURCE'},403);
   const host=await runtime(match[1],capability);
   if(!live())return response({error:'JUDGE_CLOSED'},410);
   const headers=new Headers(request.headers);headers.set('origin',c.origin);
   return host.handleRequest(new Request(request,{headers}));
  }catch(error){
   const code=['JUDGE_CLOSED','JUDGE_DENIED','JUDGE_CAPACITY','JUDGE_BUDGET'].includes(error?.message)?error.message:'JUDGE_BACKEND_HOLD';
   return response({error:code},code==='JUDGE_DENIED'?403:code==='JUDGE_CLOSED'?410:code==='JUDGE_CAPACITY'||code==='JUDGE_BUDGET'?429:503);
  }
 },async close(){closed=true;await Promise.allSettled([...rooms.values()].map(async p=>(await p).close()));rooms.clear();}});
}
