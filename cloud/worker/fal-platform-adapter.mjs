import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {GENERATION_CONTRACT} from '../generation/dispatch.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../../integration/qc/visual-policy.mjs';
import {acceptsFundedBalance,validTopUpProtection} from '../generation/funded-balance.mjs';
import {adapterFail as fail,adapterGuard,OperatorAdapterHold} from './operator-adapter-error.mjs';
const endpoints=[GENERATION_CONTRACT.intent,GENERATION_CONTRACT.music,GENERATION_CONTRACT.video];
const keyValid=k=>typeof k==='string'&&k.length>=8&&k.length<=4096&&k.trim()===k&&!/[\r\n]/.test(k);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fields=s=>Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,s[k]]));
const same=(a,b)=>cueDigest(fields(a))===cueDigest(fields(b));
// Official authenticated, non-generation APIs. No key registry/environment or
// billing-permission upgrade. Request/response errors never include raw detail.
export function createFalPlatformAdapter({enabled=false,fetchImpl=globalThis.fetch,timeoutMs=8000,now=Date.now}={}){
 if(typeof enabled!=='boolean'||typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<5||timeoutMs>8000)fail('FAL_PLATFORM_CONFIGURATION_REQUIRED');
 let closed=false;const active=new Set();
 async function get(path,key){if(!enabled||closed)fail('FAL_PLATFORM_NOT_ACTIVATED');if(!keyValid(key))fail('FAL_PLATFORM_CREDENTIAL_REQUIRED');
  const controller=new AbortController();active.add(controller);let timer;const timeout=new Promise((_,reject)=>{
   controller.signal.addEventListener('abort',()=>reject(new OperatorAdapterHold(closed?'FAL_PLATFORM_CLOSED':'FAL_PLATFORM_TIMEOUT')),{once:true});
   timer=setTimeout(()=>controller.abort(),timeoutMs);});
  const work=(async()=>{let response,reader;try{
   const headers=new Headers([['authorization',['Key',key].join(' ')],['accept','application/json']]);
   response=await fetchImpl('https://api.fal.ai/v1/'+path,{method:'GET',headers,redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal});
   if(!(response instanceof Response)||response.redirected||response.url&&response.url!=='https://api.fal.ai/v1/'+path||response.status>=300&&response.status<400)fail('FAL_PLATFORM_RESPONSE_REQUIRED');
   if(response.status===403)fail('FAL_PLATFORM_PERMISSION_REQUIRED');if(response.status!==200)fail('FAL_PLATFORM_AUTH_OR_SERVICE_HOLD');
   if(response.headers.get('content-type')?.split(';')[0]!=='application/json'||!response.body?.getReader)fail('FAL_PLATFORM_RESPONSE_REQUIRED');
   const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>65536))fail('FAL_PLATFORM_BODY_LIMIT');
   reader=response.body.getReader();const parts=[];let size=0;for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>65536)fail('FAL_PLATFORM_BODY_LIMIT');parts.push(p.value);}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,size)));
  }finally{await reader?.cancel().catch(()=>{});response?.body?.cancel().catch(()=>{});}})();work.catch(()=>{});
  try{return await adapterGuard(()=>Promise.race([work,timeout]),'FAL_PLATFORM_HOLD');}
  finally{key='';clearTimeout(timer);controller.abort();active.delete(controller);}
 }
 async function prices(key){const p=await get('models/pricing?endpoint_id='+encodeURIComponent(endpoints.join(',')),key);
  if(!Array.isArray(p?.prices)||p.prices.length!==3||p.has_more!==false||p.next_cursor!==null)fail('FAL_PLATFORM_PRICING_REQUIRED');
  const result=endpoints.map(endpoint=>{const matches=p.prices.filter(x=>x.endpoint_id===endpoint),r=matches[0];
   if(matches.length!==1||r.currency!=='USD'||typeof r.unit!=='string'||!r.unit||r.unit.length>80||!Number.isFinite(r.unit_price)||r.unit_price<=0)fail('FAL_PLATFORM_PRICING_REQUIRED');
   return {endpointId:endpoint,unit:r.unit,unitPrice:r.unit_price,currency:'USD'};});return {prices:result,observedAtMs:now()};
 }
 return Object.freeze({prices,async verifyCredential(key){await prices(key);return {authenticated:true,observedAtMs:now(),generationInvoked:false};},
  async balance(key){const r=await get('account/billing?expand=credits',key);
   if(r?.credits?.currency!=='USD'||!Number.isFinite(r.credits.current_balance)||r.credits.current_balance<0)fail('FAL_PLATFORM_BALANCE_REQUIRED');
   return {usd:r.credits.current_balance,observedAtMs:now(),source:'fal-account-billing-api'};},
  capabilities:()=>({enabled:enabled&&!closed,balanceApi:true,autoTopUpApi:false,secretPersistence:false}),close(){closed=true;for(const c of active)c.abort();}});
}

// Unit/configuration approvals are necessary: endpoint-level prices alone do
// not prove a model-specific token ceiling or resolution/length multiplier.
export function createFalQuoteAndBalance({enabled=false,platform,connections,readSafetyApproval,balanceMode='api',now=Date.now}={}){
 if(!['api','manual-attested'].includes(balanceMode))fail('FAL_QUOTE_CONFIGURATION_REQUIRED');
 const fresh=a=>Number.isSafeInteger(a)&&now()>=a&&now()-a<=3600000;
 return async input=>adapterGuard(async()=>{if(!enabled)fail('FAL_QUOTE_NOT_ACTIVATED');
  if(typeof connections?.withCredential!=='function'||typeof readSafetyApproval!=='function'||!platform?.prices||!platform?.balance)fail('FAL_QUOTE_PORTS_REQUIRED');
  if(cueDigest(input.models)!==cueDigest(GENERATION_CONTRACT)||![1,2,3,5].includes(input.participants))fail('FAL_QUOTE_MODELS_REQUIRED');
  const a=await readSafetyApproval({...fields(input),connectionId:input.connectionId});
  if(!a||!same(a,input)||a.connectionId!==input.connectionId||a.approved!==true||
   input.participants===5&&a.fivePersonMaximumCents!==250||
   input.participants===1&&a.singlePersonMaximumCents!==50||
   a.autoTopUp!==false&&!(a.autoTopUp===true&&validTopUpProtection(a.topUpProtection,{now,requiredUsd:input.participants*.5})&&
    (balanceMode==='api'||a.manualBalanceSource==='fal-dashboard-observation-v1'))||
   !fresh(a.observedAtMs)||!sha(a.evidenceSha256))fail('FAL_SAFETY_APPROVAL_REQUIRED');
  return connections.withCredential(input,async key=>{
   const p=await platform.prices(key),rates={};
   for(const channel of ['intent','music','video']){
    const r=p.prices.find(r=>r.endpointId===GENERATION_CONTRACT[channel]),bound=a.bounds?.[channel];
    if(!r||!bound||!Number.isFinite(bound.maximumUsd)||bound.maximumUsd<=0)fail('FAL_UNIT_APPROVAL_REQUIRED');
    if(channel==='intent'){
     if(bound.kind!=='reviewed-model-token-ceiling'||bound.model!=='google/gemini-2.5-flash-lite'||bound.maxOutputTokens!==800||bound.maxInputUtf8Bytes!==56192||bound.endpointUnit!==r.unit||bound.endpointUnitPrice!==r.unitPrice||
      !Number.isFinite(bound.inputUsdPerMillion)||bound.inputUsdPerMillion<=0||!Number.isFinite(bound.outputUsdPerMillion)||bound.outputUsdPerMillion<=0||
      (56192*bound.inputUsdPerMillion+800*bound.outputUsdPerMillion)/1000000>bound.maximumUsd)fail('FAL_INTENT_PRICE_APPROVAL_REQUIRED');
    }else{
     const expected=channel==='music'?{contextSeconds:16,tailSeconds:24}:{duration:5,resolution:'480P'};
     if(bound.kind!=='reviewed-billing-units'||cueDigest(bound.configuration)!==cueDigest(expected)||bound.unit!==r.unit||!Number.isFinite(bound.quantity)||bound.quantity<=0||r.unitPrice*bound.quantity>bound.maximumUsd)fail('FAL_UNIT_APPROVAL_REQUIRED');
    }rates[channel]=bound.maximumUsd;
   }
   let b;if(balanceMode==='api')b=await platform.balance(key);else{
    if(!Number.isFinite(a.manualBalanceUsd)||a.manualBalanceUsd<0)fail('FAL_MANUAL_BALANCE_REQUIRED');b={usd:a.manualBalanceUsd,observedAtMs:a.observedAtMs,source:'manual-account-attestation'};
   }
   if(!fresh(p.observedAtMs)||!fresh(b.observedAtMs))fail('FAL_QUOTE_STALE');
   const balance={usd:b.usd,autoTopUp:a.autoTopUp,observedAtMs:Math.min(b.observedAtMs,a.observedAtMs),source:b.source,
    ...(a.autoTopUp===true?{topUpProtection:structuredClone(a.topUpProtection)}:{})};
   if(!acceptsFundedBalance(balance,{now,requiredUsd:input.participants*.5}))fail('FAL_EXISTING_BALANCE_REQUIRED');
   return {quote:{verified:true,maximumUsd:rates,observedAtMs:Math.min(p.observedAtMs,a.observedAtMs),evidenceSha256:cueDigest({p,approval:a.evidenceSha256,bounds:a.bounds})},
    balance,
    ...(cueDigest(a.visualPolicy??null)===cueDigest(TECHNICAL_VISUAL_POLICY)?{visualPolicy:TECHNICAL_VISUAL_POLICY}:{})};
  });
 },'FAL_QUOTE_HOLD');
}
