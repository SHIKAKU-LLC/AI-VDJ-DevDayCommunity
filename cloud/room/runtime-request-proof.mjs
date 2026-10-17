// Public-key request proof only. No platform key, DB password or bearer lease.
const encoder=new TextEncoder(),id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{20,100}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=()=>{throw Error('RUNTIME_AUTH_HOLD');};
const canonical=v=>JSON.stringify(Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])));
export async function digestRuntimeBytes(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');}
const b64=b=>btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function message({path,body,ownerCapability,contentType,objectPath=null,workerId,nonce,requestedAtMs,leaseExpiresAtMs}){
 if(!/^\/api\/rooms\/[a-f0-9-]{36}\/runtime\/(query|generation|room|storage\/(describe|get|put|sign))$/.test(path)||
  !(body instanceof Uint8Array)||!hash(ownerCapability)||!id(workerId)||!id(nonce)||!Number.isSafeInteger(requestedAtMs)||
  (path.endsWith('/storage/put')?typeof objectPath!=='string'||objectPath.length>255:objectPath!==null))fail();
 return {version:leaseExpiresAtMs===undefined?'vdj-runtime-proof-v1':'vdj-companion-proof-v1',...(leaseExpiresAtMs===undefined?{}:{leaseExpiresAtMs}),method:'POST',path,contentType,workerId,nonce,requestedAtMs,
  objectPath,bodySha256:await digestRuntimeBytes(body),ownerSha256:await digestRuntimeBytes(encoder.encode(ownerCapability))};
}
export async function createRuntimeRequestSigner({enabled=false,scope,now=Date.now,expiresAtMs,identity}={}){
 if(!enabled)return Object.freeze({registration:()=>null,sign:async()=>fail(),close(){}});
 const created=now(),expiry=Math.min(expiresAtMs??created+1800000,scope?.expiresAtMs??0);
 if(!Number.isSafeInteger(created)||!Number.isSafeInteger(expiry)||expiry<=created||expiry>created+(identity?14400000:1800000)||
  !/^[a-f0-9-]{36}$/.test(scope?.roomId??'')||!/^[a-f0-9-]{36}$/.test(scope?.sessionId??'')||
  !Number.isSafeInteger(scope?.controlRevision)||scope.controlRevision<0)fail();
 if(identity&&(typeof identity.sign!=='function'||!id(identity.workerId)||!identity.publicJwk||!hash(identity.publicKeySha256)))fail();
 let pair=identity?null:await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']),closed=false;
 const publicJwk=identity?identity.publicJwk:await crypto.subtle.exportKey('jwk',pair.publicKey),workerId=identity?.workerId??'runtime-'+crypto.randomUUID();
 const keySha=await digestRuntimeBytes(encoder.encode(canonical(publicJwk)));
 if(identity&&identity.publicKeySha256!==keySha||Object.hasOwn(publicJwk,'d'))fail();
 const registration={workerId,roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision,
  approvedAtMs:created,expiresAtMs:expiry,publicJwk,publicKeySha256:keySha};
 return Object.freeze({registration:()=>structuredClone({...registration,...(identity?{expiresAtMs:expiry}: {})}),async sign(input){
  if(closed||(!pair&&!identity)||now()<created||now()>=expiry||!input.path.startsWith('/api/rooms/'+scope.roomId+'/'))fail();
  const leaseExpiresAtMs=identity?Math.min(expiry,now()+1790000):undefined;
  const fields=await message({...input,workerId,nonce:'request-'+crypto.randomUUID(),requestedAtMs:now(),leaseExpiresAtMs});
  const signature=identity?await identity.sign(encoder.encode(canonical(fields))):await crypto.subtle.sign('Ed25519',pair.privateKey,encoder.encode(canonical(fields)));
  if(!(signature instanceof Uint8Array)&&!(signature instanceof ArrayBuffer))fail();
  if(closed||now()>=expiry)fail();
  return {...(identity?{'x-vdj-runtime-until':String(leaseExpiresAtMs)}:{}),'x-vdj-runtime-id':workerId,'x-vdj-runtime-nonce':fields.nonce,'x-vdj-runtime-at':String(fields.requestedAtMs),'x-vdj-runtime-proof':b64(new Uint8Array(signature))};
 },close(){closed=true;pair=null;}});
}
export function createRuntimeRequestVerifier({enabled=false,readApprovedWorker,readApprovedDevice,readScope,now=Date.now}={}){
 return async ({request,body,roomId})=>{
  if(!enabled||typeof readApprovedWorker!=='function'||request.method!=='POST'||request.headers.has('authorization')||
   request.headers.has('x-fal-key')||request.headers.has('apikey'))fail();
  const workerId=request.headers.get('x-vdj-runtime-id'),nonce=request.headers.get('x-vdj-runtime-nonce'),at=request.headers.get('x-vdj-runtime-at'),
   signature=request.headers.get('x-vdj-runtime-proof'),ownerCapability=request.headers.get('x-room-owner');
  if(!id(workerId)||!id(nonce)||!/^\d{1,16}$/.test(at??'')||!/^[A-Za-z0-9_-]{86}$/.test(signature??''))fail();
  const clock=now(),until=request.headers.get('x-vdj-runtime-until');
  let worker;
  if(until!==null){
   if(typeof readApprovedDevice!=='function'||typeof readScope!=='function'||!/^\d{1,16}$/.test(until))fail();
   const device=await readApprovedDevice(workerId);
   if(device?.approved!==true||device.revoked!==false||device.workerId!==workerId||
     !Array.isArray(device.roomIds)||!device.roomIds.includes(roomId)||!Number.isSafeInteger(device.approvedAtMs)||
     device.approvedAtMs>clock)fail();
   const scope=await readScope({roomId,ownerCapability});
   const leaseExpiresAtMs=Number(until);
   if(scope?.roomId!==roomId||!Number.isSafeInteger(scope.expiresAtMs)||leaseExpiresAtMs<=clock||
     leaseExpiresAtMs>Number(at)+1800000||leaseExpiresAtMs>scope.expiresAtMs)fail();
   worker={...device,...scope,expiresAtMs:leaseExpiresAtMs,approvedAtMs:clock};
  }else worker=await readApprovedWorker(workerId);
  const jwk=worker?.publicJwk;
  if(worker?.approved!==true||worker.workerId!==workerId||worker.roomId!==roomId||!Number.isSafeInteger(worker.approvedAtMs)||
   !Number.isSafeInteger(worker.expiresAtMs)||worker.approvedAtMs>clock||worker.expiresAtMs<=clock||worker.expiresAtMs>worker.approvedAtMs+1800000||
   jwk?.kty!=='OKP'||jwk.crv!=='Ed25519'||typeof jwk.x!=='string'||Object.hasOwn(jwk,'d')||
   worker.publicKeySha256!==await digestRuntimeBytes(encoder.encode(canonical(jwk)))||
   !Number.isSafeInteger(Number(at))||Number(at)>clock+1000||Number(at)<clock-8000)fail();
  const url=new URL(request.url);if(url.search||url.hash)fail();
  const fields=await message({path:url.pathname,body,ownerCapability,contentType:request.headers.get('content-type')??'',
   objectPath:request.headers.get('x-vdj-object-path'),workerId,nonce,requestedAtMs:Number(at),
   ...(until===null?{}:{leaseExpiresAtMs:Number(until)})});
  let valid=false;try{const publicKey=await crypto.subtle.importKey('jwk',jwk,'Ed25519',false,['verify']);
   valid=await crypto.subtle.verify('Ed25519',publicKey,unb64(signature),encoder.encode(canonical(fields)));}catch{}
  if(!valid)fail();
  return {...(until===null?{}:{registeredDevice:true}),workerId,roomId,['sessionId']:worker.sessionId,controlRevision:worker.controlRevision,expiresAtMs:worker.expiresAtMs,
   requestedAtMs:Number(at),nonceSha256:await digestRuntimeBytes(encoder.encode(canonical(fields)))};
 };
}
