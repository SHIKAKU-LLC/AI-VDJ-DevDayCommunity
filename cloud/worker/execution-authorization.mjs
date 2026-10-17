import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {GENERATION_CONTRACT,validatePermit} from '../generation/dispatch.mjs';

const fail=()=>{throw Error('APPLICATION_EXECUTION_AUTHORIZATION_REQUIRED');};
const scopeKeys=['roomId','sessionId','controlRevision'];
// Application consent is durable. Authentication, signed media delivery, fresh
// prices/balance and the dispatch permit remain separately time bounded.
// This record cannot add operations or release an uncertain prior charge.
export function validateExecutionAuthorization(grant,{plan,scope,now=Date.now}={}){
 const keys=['kind',...scopeKeys,'planId','approvedAtMs','expiresAtMs','revoked','operationIds',
  'generationMaximumCents','infrastructureMaximumCents','unknownReserveCents','totalReservationCents'];
 if(!grant||Object.keys(grant).sort().join(',')!==keys.sort().join(',')||
  grant.kind!=='room-budget-execution-consent-v1'||grant.expiresAtMs!==null||grant.revoked!==false||
  !Number.isSafeInteger(grant.approvedAtMs)||grant.approvedAtMs>now()||grant.approvedAtMs<=0||
  scopeKeys.some(k=>grant[k]!==scope?.[k]||grant[k]!==plan?.[k])||grant.planId!==plan?.planId||
  plan.phase!=='STARTED'||plan.participants!==2||plan.maximumCents!==100||
  !Array.isArray(plan.operations)||plan.operations.length!==2||
  cueDigest(grant.operationIds)!==cueDigest(plan.operations.map(o=>o.operationId))||
  new Set(grant.operationIds).size!==2||grant.generationMaximumCents!==150||
  grant.infrastructureMaximumCents!==150||plan.infrastructureMaximumUsd>1.5||
  !Number.isSafeInteger(grant.unknownReserveCents)||grant.unknownReserveCents<0||
  grant.unknownReserveCents!==plan.recovery?.unknownIntentReserveCents||
  grant.totalReservationCents!==plan.maximumCents+grant.unknownReserveCents||
  grant.totalReservationCents!==plan.recovery?.totalGenerationReservationCents||
  grant.totalReservationCents>grant.generationMaximumCents||plan.recovery?.thirdParticipantExcluded!==true)fail();
 return structuredClone(grant);
}

export async function refreshExecutionEvidence({plan,scope,connections,trial,now=Date.now,reuseCurrent=false}={}){
 validateExecutionAuthorization(plan?.executionAuthorization,{plan,scope,now});
 const connection=await connections.read({...scope,connectionId:plan.connectionId});
 if(connection.verified!==true||connection.connectionId!==plan.connectionId||connection.expiresAtMs<=now())fail();
 // A process recovery does not require replacing still-valid immutable permits.
 // In particular, a completed Cue must retain its original admission binding.
 // Recheck the ordinary financial/source/delivery validator on every permit;
 // this neither rolls timestamps nor relaxes a failed/expired permit.
 if(reuseCurrent&&Number.isSafeInteger(plan.expiresAtMs)&&plan.expiresAtMs>now()&&
   plan.expiresAtMs<=scope.expiresAtMs&&plan.expiresAtMs<=connection.expiresAtMs){
  let valid=true;
  try{for(const o of plan.operations)validatePermit(o.permit,{now,mediaHost:trial.mediaHost});}catch{valid=false;}
  if(valid)return structuredClone(plan);
 }
 const evidence=await trial.quoteAndBalance({...scope,connectionId:plan.connectionId,participants:2,models:{...GENERATION_CONTRACT}});
 const expiresAtMs=Math.floor(Math.min(now()+3600000,scope.expiresAtMs,connection.expiresAtMs)/1000)*1000;
 if(expiresAtMs<=now())fail();
 const source=plan.operations[0].permit.source;
 const assets=await trial.signSource({...scope,source,assets:plan.assets,expiresAtMs});
 const refreshed={...structuredClone(plan),expiresAtMs,operations:plan.operations.map(o=>({...structuredClone(o),
  permit:{...structuredClone(o.permit),createdAtMs:now(),expiresAtMs,quote:evidence.quote,balance:evidence.balance,assets}}))};
 // Use the ordinary dispatch validator; this consent never bypasses its
 // fresh financial, immutable-source or private media URL checks.
 for(const o of refreshed.operations)validatePermit(o.permit,{now,mediaHost:trial.mediaHost});
 await trial.insertPermits({...scope,plan:refreshed});
 return trial.plans.active(scope);
}
