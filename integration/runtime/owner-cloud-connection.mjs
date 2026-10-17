// Owner capability remains in this native closure. No platform/provider key is
// read, no dynamic upstream URL is accepted, and no mutation route is exposed.
export function createOwnerCloudConnection({roomId,origin='https://ai-vdj.vercel.app',projectURL,fetchImpl=globalThis.fetch,signal,
 allowRuntimeOwnerContext=false,contextExpiresAtMs,companion=false,now=Date.now}={}){
  if(!/^[a-f0-9-]{36}$/i.test(roomId??'')||origin!=='https://ai-vdj.vercel.app')throw Error('EXISTING_ROOM_ORIGIN_REQUIRED');
  let endpoint=origin;
  if(projectURL!==undefined){
    let project;try{project=new URL(projectURL);}catch{throw Error('EXISTING_ROOM_PROJECT_REQUIRED');}
    if(project.origin!==projectURL||project.protocol!=='https:'||project.port||project.username||project.password||
      !/^[a-z0-9]+\.supabase\.co$/.test(project.hostname))throw Error('EXISTING_ROOM_PROJECT_REQUIRED');
    // Native callers already target this approved Edge for runtime requests.
    // Keep the same owner check and origin, without the extra frontend proxy.
    endpoint=projectURL+'/functions/v1/ai-vdj-room';
  }
  let owner='',closed=false,snapshot=null,revision=0;
  const createdAt=now();
  if(allowRuntimeOwnerContext&&(!Number.isSafeInteger(contextExpiresAtMs)||contextExpiresAtMs<=createdAt||contextExpiresAtMs>createdAt+(companion?14400000:1800000)))
    throw Error('OWNER_RUNTIME_BOUND_REQUIRED');
  async function refresh(){
    if(closed||signal?.aborted||!owner)throw Error('OWNER_CONNECTION_REQUIRED');
    const current=revision,headers=new Headers({'Content-Type':'application/json',Origin:origin});headers.set('X-Room-Owner',owner);
    const response=await fetchImpl(endpoint+'/api/rooms/'+roomId+'/host/session',{method:'POST',headers,body:'{}',
      redirect:'error',credentials:'omit',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('OWNER_CONNECTION_DENIED');
    const value=await response.json();
    if(closed||signal?.aborted||current!==revision)throw Error('OWNER_CONNECTION_ENDED');
    if(value?.roomId!==roomId||typeof value.sessionId!=='string'||!Array.isArray(value.submissions)||
      value.generationEnabled!==false)throw Error('OWNER_SNAPSHOT_REQUIRED');
    snapshot=value;return structuredClone(value);
  }
  return{
    async attachOwner({ownerCapability}){
      if(closed||signal?.aborted||! /^[a-f0-9]{64}$/.test(ownerCapability??''))throw Error('OWNER_CONNECTION_REQUIRED');
      if(owner===ownerCapability)return refresh();
      const previous=owner;owner=ownerCapability;revision++;
      try{return await refresh();}catch(error){owner=previous;revision++;throw error;}
    },
    readCloud:refresh,
    async withOwnerAuthorization(scope,invoke){
      if(!allowRuntimeOwnerContext||typeof invoke!=='function'||scope?.roomId!==roomId||closed||signal?.aborted||
        now()<createdAt||now()>=contextExpiresAtMs)throw Error('OWNER_RUNTIME_CONTEXT_REQUIRED');
      const current=revision;try{
        const fresh=await refresh();
        if((scope.sessionId!==undefined)!==(scope.controlRevision!==undefined)||
          scope.sessionId!==undefined&&(scope.sessionId!==fresh.sessionId||scope.controlRevision!==fresh.controlRevision)||
          Object.keys(scope).some(k=>!['roomId','sessionId','controlRevision'].includes(k))||now()>=contextExpiresAtMs)
          throw Error();
        const result=await invoke({roomId,['sessionId']:fresh.sessionId,controlRevision:fresh.controlRevision,ownerCapability:owner});
        if(closed||signal?.aborted||current!==revision||now()>=contextExpiresAtMs)throw Error();return result;
      }catch(error){throw new Error('OWNER_RUNTIME_CONTEXT_HOLD',{cause:error});}
    },
    status:()=>({connected:!!snapshot&&!closed&&!signal?.aborted,submissions:snapshot?.submissions.length??0,
      checkedAtMs:snapshot?.checkedAtMs??null,generationEnabled:false}),
    close(){closed=true;revision++;owner='';snapshot=null;},
  };
}
