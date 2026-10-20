// Read-only connection for the owner's temporary Mac host. This does not
// create permits, issue media URLs, accept QC, or enable provider work.
export function createHostSessionHandler({authorizeOwner,readRoom,origin='https://ai-vdj.vercel.app',now=Date.now}={}) {
  if(typeof authorizeOwner!=='function'||typeof readRoom!=='function')throw Error('HOST_SESSION_AUTH_REQUIRED');
  return async request=>{
    const path=new URL(request.url).pathname;
    const match=path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/host\/session$/i);
    if(!match)return null;
    const out=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':origin,Vary:'Origin',
      'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Room-Owner'}});
    if(request.headers.get('origin')!==origin)return out({error:'ORIGIN_DENIED'},403);
    if(request.method==='OPTIONS')return out({ok:true});
    if(request.method!=='POST')return out({error:'POST_REQUIRED'},405);
    const capability=request.headers.get('x-room-owner');
    if(!/^[a-f0-9]{64}$/.test(capability??'')||request.headers.has('authorization'))return out({error:'OWNER_DENIED'},403);
    if(request.headers.get('content-type')!=='application/json')return out({error:'JSON_REQUIRED'},415);
    const reader=request.body?.getReader();let length=0,text='';
    if(reader)while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
      if(length>256){await reader.cancel();return out({error:'BODY_TOO_LARGE'},413);}text+=new TextDecoder().decode(part.value);}
    try{
      const body=JSON.parse(text);
      if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length)return out({error:'BODY_INVALID'},400);
      // cueState verifies the owner proof before reading even an empty ledger.
      await authorizeOwner(match[1],capability);
      const state=await readRoom(match[1],capability);
      if(state?.roomId!==match[1]||state.closed||!state.sessionId||!Number.isSafeInteger(state.controlRevision))throw Error();
      const submissions=(state.submissions??[]).map(item=>({submissionId:item.submissionId,
        nickname:item.nickname,prompt:item.prompt,state:item.state}));
      return out(Object.fromEntries([['roomId',state.roomId],['sessionId',state.sessionId],
        ['controlRevision',state.controlRevision],['accepting',state.accepting===true],
        ['submissions',submissions],['checkedAtMs',now()],['generationEnabled',false]]));
    }catch{return out({error:'HOST_SESSION_DENIED'},403);}
  };
}
