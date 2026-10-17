// One PKCE attempt per tab. Only the public state/challenge are sent with email;
// verifier and short bearer stay in closures, never URLs or persistent storage.
export function createOwnerLinkFlow({request,onStatus=()=>{},channel=name=>new BroadcastChannel(name),
 now=()=>Date.now(),schedule=(fn,ms)=>setTimeout(fn,ms),cancelTimer=id=>clearTimeout(id),cryptoAPI=crypto}){
 let phase='IDLE',pending=null,bearer=null,expiresAt=0,bus=null,timer=null,epoch=0,disposed=false;
 const emit=()=>onStatus({phase});
 const close=()=>{cancelTimer(timer);timer=null;bus?.close();bus=null;pending=null;};
 const fail=p=>{epoch++;close();bearer=null;expiresAt=0;phase=p;emit();};
 const random=()=>Array.from(cryptoAPI.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
 async function begin(email){
  if(disposed||['REQUESTING','WAITING','UNKNOWN','EXCHANGING','SIGNED_IN'].includes(phase))return false;
  if(typeof email!=='string'||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())||email.length>254){phase='INVALID';emit();return false;}
  const attempt=++epoch;phase='REQUESTING';emit();
  const state=random(),verifier=random();
  const bytes=await cryptoAPI.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  const challenge=btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  if(disposed||attempt!==epoch)return false;
  pending={state,verifier,email:email.trim().toLowerCase(),deadline:now()+600000};
  bus=channel('ai-vdj-owner-'+state);
  bus.onmessage=async event=>{
   const data=event.data;
   if(disposed||attempt!==epoch||!pending||!['REQUESTING','WAITING','UNKNOWN'].includes(phase))return;
   if(data?.type!=='owner-link'||data.state!==pending.state||! /^[A-Za-z0-9_-]{20,200}$/.test(data.code??''))return;
   if(now()>=pending.deadline){fail('EXPIRED');return;}
   phase='EXCHANGING';emit();const local=pending;
   try{
    const session=await request('/api/owner/exchange-link',{method:'POST',body:{email:local.email,code:data.code,verifier:local.verifier}});
    if(disposed||attempt!==epoch)return;
    if(typeof session.bearer!=='string'||!session.bearer||!Number.isFinite(session.expiresAt)||session.expiresAt*1000<=now())throw Error('OWNER_DENIED');
    bus.postMessage({type:'owner-link-result',state:local.state,ok:true});close();
    bearer=session.bearer;expiresAt=session.expiresAt*1000;phase='SIGNED_IN';
    timer=schedule(()=>fail('EXPIRED'),expiresAt-now());emit();
   }catch{
    if(disposed||attempt!==epoch)return;
    bus?.postMessage({type:'owner-link-result',state:local.state,ok:false});fail('FAILED');
   }
  };
  timer=schedule(()=>fail('EXPIRED'),600000);
  try{
   await request('/api/owner/request-link',{method:'POST',body:{email:pending.email,state,challenge}});
   if(disposed||attempt!==epoch)return false;
   if(phase==='REQUESTING'){phase='WAITING';emit();}return true;
  }catch(e){if(!disposed&&attempt===epoch&&phase==='REQUESTING'){
   if(e?.definitive)fail('FAILED');else{phase='UNKNOWN';emit();}
  }return false;}
 }
 return {begin,read:()=>({phase}),getBearer:()=>{
  if(disposed)return null;if(bearer&&now()>=expiresAt){fail('EXPIRED');return null;}return bearer;
 },cancel:()=>{if(!disposed)fail('IDLE');},dispose:()=>{disposed=true;fail('CLOSED');}};
}

export function readOwnerReturn(href,origin){
 const url=new URL(href);
 if(url.origin!==origin||url.pathname!=='/room/auth-return'||url.hash)return null;
 const state=url.searchParams.get('state'),code=url.searchParams.get('code');
 if(url.searchParams.getAll('state').length!==1||url.searchParams.getAll('code').length!==1||Array.from(url.searchParams.keys()).some(k=>!['state','code'].includes(k)))return null;
 return /^[a-f0-9]{64}$/.test(state??'')&&/^[A-Za-z0-9_-]{20,200}$/.test(code??'')?{type:'owner-link',state,code}:null;
}
