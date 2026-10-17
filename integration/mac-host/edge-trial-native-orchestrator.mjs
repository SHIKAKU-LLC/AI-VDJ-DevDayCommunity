import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {GENERATION_CONTRACT} from '../../cloud/generation/dispatch.mjs';

const fail=()=>{throw Error('EDGE_TRIAL_NATIVE_HOLD');};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const fresh=(value,now)=>Number.isSafeInteger(value)&&value<=now&&now-value<=3600000;

// Only the three fixed model prices and the authenticated API balance leave
// the provider metadata callback. This native file never contains a key.
export function publicProviderMetadata(value,{roomId,registration,expiresAtMs,now=Date.now}={}){
 const current=now();
 if(!registration||registration.roomId!==roomId||!Number.isSafeInteger(expiresAtMs)||current>=expiresAtMs||
  !id(value?.connectionId)||!Array.isArray(value.prices)||value.prices.length!==3||
  !fresh(value.observedAtMs,current)||
  !(value.balanceError===null&&fresh(value.balance?.observedAtMs,current)&&
     Number.isFinite(value.balance.usd)&&value.balance.usd>=0&&value.balance.source==='fal-account-billing-api'||
    value.balanceError==='FAL_BALANCE_HOLD'&&value.balance===null)||
  value.autoTopUpVerified!==false||value.generationInvoked!==false||
  !Number.isSafeInteger(value.expiresAtMs)||value.expiresAtMs<=current||value.expiresAtMs>expiresAtMs)fail();
 const endpoints=['intent','music','video'].map(key=>GENERATION_CONTRACT[key]);
 if(new Set(value.prices.map(price=>price.endpointId)).size!==3||
  value.prices.some(price=>!endpoints.includes(price.endpointId)||price.currency!=='USD'||
   typeof price.unit!=='string'||price.unit.length<1||price.unit.length>80||
   !Number.isFinite(price.unitPrice)||price.unitPrice<=0))fail();
 return Object.freeze({version:'ai-vdj-edge-provider-metadata-v1',roomId,['sessionId']:registration.sessionId,
  controlRevision:registration.controlRevision,connectionId:value.connectionId,
  expiresAtMs:Math.min(expiresAtMs,value.expiresAtMs),observedAtMs:value.observedAtMs,
  prices:endpoints.map(endpointId=>{const price=value.prices.find(item=>item.endpointId===endpointId);
   return {endpointId,unit:price.unit,unitPrice:price.unitPrice,currency:'USD'};}),
  balance:value.balanceError===null?{usd:value.balance.usd,observedAtMs:value.balance.observedAtMs,
   source:value.balance.source}:null,balanceError:value.balanceError,
  autoTopUpVerified:false,generationInvoked:false});
}

export function createPrivateMetadataWriter({activationFile}={}){
 if(typeof activationFile!=='string'||!activationFile.endsWith('.json'))fail();
 const file=activationFile.slice(0,-5)+'.provider-metadata.json';
 return async record=>{
  let handle;
  try{
   handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   await handle.writeFile(JSON.stringify(record)+'\n','utf8');await handle.sync();
  }catch{fail();}finally{await handle?.close();}
 };
}

// The browser can only attach the owner through an already paired session.
// After that event the reviewed manifest permits one native preparation.
// Later decisions are read from exact private files; no browser body, pairing
// code or local-session token enters this controller.
export function createEdgeTrialNativeOrchestrator({runtime,roomId,expiresAtMs,readActivation,
 readOperationalConfiguration,readCurrent,writeMetadata,now=Date.now,
 schedule=setTimeout,cancel=clearTimeout,pollMs=1000}={}){
 if(!runtime?.attachOwner||!runtime?.prepareRegistration||!runtime?.activateNative||
  typeof readActivation!=='function'||typeof readOperationalConfiguration!=='function'||
  typeof readCurrent!=='function'||typeof writeMetadata!=='function'||
  !Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now()||!Number.isSafeInteger(pollMs)||pollMs<100)fail();
 let closed=false,prepared=false,registration,preparePromise,checking=false,timer,stage='owner';
 let activated=false,activationAttempted=false,keychainApproved=false,metadataAttempted=false,metadataReady=false;
 let bootstrapAttempted=false,bootstrapReady=false,trialAttempted=false,trialReady=false,held=false;
 const live=()=>!closed&&!held&&now()<expiresAtMs;
 const wake=()=>{
  if(!live()||!prepared||timer!==undefined)return;
  timer=schedule(()=>{timer=undefined;void check().catch(()=>{held=true;});},
   Math.min(pollMs,Math.max(1,expiresAtMs-now())));
  timer?.unref?.();
 };
 const hasBootstrap=()=>{
  const source=readCurrent();
  return !!(source?.audioAssetId&&source?.referenceAssetId&&source?.playback?.phase==='IDLE'&&
   source.playback.revision===0&&source.playback.actual!==true);
 };
 async function check(){
  if(checking||!live()||!prepared)return;
  checking=true;
  try{
   if(!activated){
    let approval;
    try{approval=await readActivation(registration);}catch{return;}
    if(!live()||approval?.approved!==true||activationAttempted)return;
    activationAttempted=true;keychainApproved=!!approval.keychainApproval;stage='activation';
    await runtime.activateNative();if(!live())return;activated=true;
   }
   if(keychainApproved&&!metadataAttempted){
    stage='provider-metadata';
    metadataAttempted=true;
    const value=await runtime.readProviderMetadata();if(!live())return;
    const safe=publicProviderMetadata(value,{roomId,registration,expiresAtMs,now});
    await writeMetadata(safe);
    if(safe.balanceError){held=true;return;}
    if(!live())return;metadataReady=true;
   }
   if(runtime.status().nativeBootstrapReady===true)bootstrapReady=true;
   if(!bootstrapReady&&!bootstrapAttempted&&hasBootstrap()){
    stage='bootstrap';bootstrapAttempted=true;await runtime.prepareNativeBootstrap();if(!live())return;bootstrapReady=true;
    if(trialReady)stage='complete';
   }
   // Operator configuration enables verified material preparation. Requiring a
   // preexisting local bootstrap here would make an empty room impossible to
   // prepare; generation still requires native source QC and actual playback.
   if(keychainApproved&&metadataReady&&!trialAttempted){
    stage='operational-approval';
    try{await readOperationalConfiguration(registration);}catch{return;}
    if(!live())return;trialAttempted=true;stage='trial';
    await runtime.configureNativeTrial();if(!live())return;trialReady=true;stage='complete';
   }
  }catch{held=true;}
  // A reviewed operator may be configured before a later local seed upload.
  // Continue the bounded local-only bootstrap probe until that seed is ready.
  finally{checking=false;if(live()&&(!trialReady||!bootstrapReady))wake();}
 }
 return Object.freeze({...runtime,
  status(){return {...runtime.status(),nativeOrchestration:{
   state:closed?'closed':now()>=expiresAtMs?'expired':held?'hold':trialReady?'ready':'pending',
   stage:!keychainApproved&&activated&&bootstrapReady?'scoped-keychain-use':stage}};},
  async attachOwner(input){const value=await runtime.attachOwner(input);
   if(!live()||preparePromise)return value;
   stage='prepare';
   preparePromise=Promise.resolve().then(async()=>{
    registration=await runtime.prepareRegistration();if(!live())return;
    prepared=true;stage='activation';wake();
   }).catch(()=>{held=true;});
   return value;
  },
  async close(){closed=true;if(timer!==undefined)cancel(timer);
   const closing=runtime.close();await preparePromise?.catch(()=>{});await closing;},
 });
}
