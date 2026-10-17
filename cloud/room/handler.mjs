// Portable HTTP boundary. Database RPC and Auth verification are injected;
// no provider, filesystem, Keychain, process queue, or media backend exists here.
export function createRoomHandler({rpc,verifyOwner,requestOTP=null,verifyOTP=null,requestLink=null,exchangeLink=null,origin='https://ai-vdj.vercel.app',random=()=>{
  const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}}){
 const codes={ROOM_NOT_FOUND:404,OPERATION_NOT_FOUND:404,ROOM_EXPIRED:410,ACTOR_DENIED:403,
  INVITE_DENIED:403,OWNER_DENIED:403,ACCEPTANCE_OFF:409,NONCE_CONFLICT:409,
  REVISION_CONFLICT:409,ROOM_ALREADY_ACTIVE:409,RATE_LIMITED:429,PARTICIPANT_CAP:429,
  ROOM_OPERATION_CAP:429,SUBMISSION_CAP:429,PROVIDER_NOT_CONNECTED:503,
  NICKNAME_INVALID:400,PROMPT_INVALID:400,NONCE_INVALID:400,CONTROL_INVALID:400,
  CAPABILITY_INVALID:400,ROUTE_NOT_FOUND:404};
 const text=(s,name,max)=>{if(typeof s!=='string')throw Error(name+'_INVALID');
  s=s.normalize('NFKC').trim();if(!s||Array.from(s).length>max||/[\u0000-\u001f\u007f]/u.test(s))throw Error(name+'_INVALID');return s;};
 const out=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{
  'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
  'Access-Control-Allow-Origin':origin,'Vary':'Origin','X-Content-Type-Options':'nosniff',
  'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization, X-Room-Owner'}});
 return async req=>{
  try{
   if(req.headers.get('origin')&&req.headers.get('origin')!==origin)return out({error:'ORIGIN_DENIED'},403);
   if(req.method==='OPTIONS')return out({ok:true});
   // Hosted Edge strips the gateway's /functions/v1 segment before invocation.
   // Accept its function-name prefix and the full gateway path used by direct tests.
   const url=new URL(req.url),path=url.pathname.replace(/^\/(?:functions\/v1\/)?ai-vdj-room(?=\/|$)/,'');
   if(path==='/api/room-capabilities'&&req.method==='GET')return out({mode:'collect',durable:true,
    cloud:{generationJobs:false,portableQC:false,browserPlayback:false,clipRelativeTimeline:false,transport:'same-origin',macRequired:false},
    generation:false,autoDJ:false,actualCredit:false,ownerLogin:requestLink&&exchangeLink?'email-link-pkce':null,reason:'PROVIDER_NOT_CONNECTED'});
   let body={};
   if(req.method==='POST'){
    if(!req.headers.get('content-type')?.startsWith('application/json'))return out({error:'JSON_REQUIRED'},415);
    const reader=req.body?.getReader();let bytes=0,chunks=[];
    if(reader)while(true){const x=await reader.read();if(x.done)break;bytes+=x.value.length;
      if(bytes>8192){await reader.cancel();return out({error:'BODY_TOO_LARGE'},413);}chunks.push(x.value);}
    const all=new Uint8Array(bytes);let offset=0;for(const x of chunks){all.set(x,offset);offset+=x.length;}
    try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{return out({error:'JSON_INVALID'},400);}
    if(!body||typeof body!=='object'||Array.isArray(body))return out({error:'JSON_INVALID'},400);
   }
   if(['/api/owner/request-link','/api/owner/exchange-link'].includes(path)&&req.method==='POST'){
    if(!requestLink||!exchangeLink)return out({error:'OWNER_LOGIN_NOT_CONFIGURED'},503);
    const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
    if(email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return out({error:'OWNER_LOGIN_INVALID'},400);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email));
    const emailProof=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(path==='/api/owner/request-link'){
     if(!/^[a-f0-9]{64}$/.test(body.state??'')||! /^[A-Za-z0-9_-]{43}$/.test(body.challenge??''))return out({error:'OWNER_LOGIN_INVALID'},400);
     if(await rpc({op:'otpPermit',payload:{emailProof}})===true){
      try{await requestLink(email,body.challenge,origin+'/room/auth-return?state='+body.state);}catch{/* Uniform receipt; delivery is not asserted. */}
     }
     return out({accepted:true});
    }
    if(!/^[A-Za-z0-9_-]{20,200}$/.test(body.code??'')||! /^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier??''))return out({error:'OWNER_LOGIN_INVALID'},400);
    if(await rpc({op:'otpVerifyPermit',payload:{emailProof}})!==true)return out({error:'OWNER_DENIED'},403);
    const session=await exchangeLink(body.code,body.verifier);
    if(!session?.bearer||!Number.isFinite(session.expiresAt)||session.expiresAt<=Date.now()/1000||await rpc({op:'ownerCheck',verified_uid:await verifyOwner(session.bearer)})!==true)return out({error:'OWNER_DENIED'},403);
    // Do not forward injected/provider fields (refresh credential, profile, metadata).
    return out({bearer:session.bearer,expiresAt:session.expiresAt});
   }
   if(['/api/owner/request-otp','/api/owner/verify-otp'].includes(path)&&req.method==='POST'){
    if(!requestOTP||!verifyOTP)return out({error:'OWNER_LOGIN_NOT_CONFIGURED'},503);
    const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
    if(email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return out({error:'OWNER_LOGIN_INVALID'},400);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email));
    const emailProof=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(path==='/api/owner/request-otp'){
     const permitted=await rpc({op:'otpPermit',payload:{emailProof}});
     if(permitted===true){try{await requestOTP(email);}catch{/* Same public receipt even if delivery fails. */}}
     // Uniform status/body; provider latency is not equalized here.
     return out({accepted:true});
    }
    if(path==='/api/owner/verify-otp'){
     if(typeof body.otp!=='string'||! /^\d{6,10}$/.test(body.otp))return out({error:'OWNER_LOGIN_INVALID'},400);
     if(await rpc({op:'otpVerifyPermit',payload:{emailProof}})!==true)return out({error:'OWNER_DENIED'},403);
     const session=await verifyOTP(email,body.otp);
     if(!session?.bearer||await rpc({op:'ownerCheck',verified_uid:await verifyOwner(session.bearer)})!==true)return out({error:'OWNER_DENIED'},403);
     return out({bearer:session.bearer,expiresAt:session.expiresAt});
    }
    return out({error:'ROUTE_NOT_FOUND'},404);
   }
   if((path==='/api/rooms'||path==='/api/owner/recover')&&req.method==='POST'){
    const bearer=req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if(!bearer)return out({error:'OWNER_DENIED'},403);
    const uid=await verifyOwner(bearer);if(!uid)return out({error:'OWNER_DENIED'},403);
    const receipt=await rpc({op:path==='/api/rooms'?'create':'recoverOwner',verified_uid:uid,payload:{ownerCapability:random(),joinCode:random()}});
    return out({...receipt,joinUrl:origin+'/join/'+receipt.roomId+'?code='+receipt.joinCode},201);
   }
   const match=path.match(/^\/api\/rooms\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/(.*))?$/i);
   if(!match)return out({error:'ROUTE_NOT_FOUND'},404);
   const room_id=match[1],tail=match[2]??'';
   const owner=req.headers.get('x-room-owner'),bearer=req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
   if(owner&&bearer)return out({error:'ACTOR_DENIED'},403);
   let capability=owner??bearer,op,payload={};
   if(tail==='join'&&req.method==='GET'){op='joinInfo';capability=url.searchParams.get('code');}
   else if(tail==='participants'&&req.method==='POST'){
    op='join';capability=body.joinCode;payload={nickname:text(body.nickname,'NICKNAME',40),participantCapability:random()};
   }else if(tail===''&&req.method==='GET'){op='read';}
   else if(tail==='submissions'&&req.method==='POST'){
    op='submit';payload={nonce:body.nonce,prompt:text(body.prompt,'PROMPT',2000)};
    if(owner)payload.nickname=text(body.nickname,'NICKNAME',40);
   }else if(tail.startsWith('submissions/')&&req.method==='GET'){
    op='submission';payload={submissionId:tail.slice('submissions/'.length)};
   }else if(tail.startsWith('operations/')&&req.method==='GET'){
    op='operation';payload={nonce:tail.slice('operations/'.length)};
   }else if(tail==='events'&&req.method==='GET'){
    if(!/^\d{1,15}$/.test(url.searchParams.get('after')??'0'))return out({error:'EVENT_CURSOR_INVALID'},400);
    op='events';
   }else if(tail==='control'&&req.method==='POST'){
    if(!owner)return out({error:'OWNER_DENIED'},403);
    op='control';payload={nonce:body.nonce,expectedRevision:body.expectedRevision};
    if(Object.keys(body).some(k=>!['nonce','expectedRevision','accepting','generationPaused','autoDJ'].includes(k)))throw Error('CONTROL_INVALID');
    for(const k of ['accepting','generationPaused','autoDJ'])if(k in body)payload[k]=body[k];
    if(!['accepting','generationPaused','autoDJ'].some(k=>k in body)||['accepting','generationPaused','autoDJ'].some(k=>k in body&&typeof body[k]!=='boolean'))throw Error('CONTROL_INVALID');
    if(!Number.isSafeInteger(payload.expectedRevision)||payload.expectedRevision<0)throw Error('CONTROL_INVALID');
   }else return out({error:'ROUTE_NOT_FOUND'},404);
   const data=await rpc({op,room_id,capability,payload});
   return out(data,op==='join'||op==='submit'?201:200);
  }catch(e){
   // Return an allowlisted code, never database/provider messages or credentials.
   const code=Object.keys(codes).find(k=>e?.message===k);
   return out({error:code??'ROOM_BACKEND_UNAVAILABLE'},code?codes[code]:503);
  }
 };
}
