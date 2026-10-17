import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {GENERATION_CONTRACT} from '../../cloud/generation/dispatch.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../qc/visual-policy.mjs';
import {validTopUpProtection,acceptsFundedBalance} from '../../cloud/generation/funded-balance.mjs';
import {EDGE_TRIAL_ROOM_ID,EDGE_TRIAL_ROOM_EXPIRES_AT,EDGE_TRIAL_PROJECT_URL} from './edge-trial-launch.mjs';

const fail=()=>{throw Error('EDGE_TRIAL_OPERATIONAL_APPROVAL_REQUIRED');};
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const positive=v=>Number.isFinite(v)&&v>0&&v<=.5;
const unit=v=>typeof v==='string'&&v.length>=1&&v.length<=80&&v.trim()===v&&!/[\r\n\0]/.test(v);
const scopeKeys=['roomId','sessionId','controlRevision','connectionId'];
const contractHost=new URL(EDGE_TRIAL_PROJECT_URL).hostname;

// Execution consent may remain until revoked. It never replaces the separate
// finite native registration, fresh funding observation or generation permit.
export const isPersistentCompanionConsent=record=>record?.version==='owner-companion-operation-v1'&&
  record.executionConsent==='until-revoked'&&record.expiresAtMs===null;

// A dashboard balance observation is financial evidence, not a new execution
// consent. Only that observation may roll within the SAME finite native scope.
// Models, bounds, budgets, top-up policy, assets and the deadline stay pinned.
function approvalIdentity(approval,{companion}){
  const pinned=structuredClone(approval);delete pinned.evidenceSha256;
  if(companion&&pinned.balanceMode==='manual-attested'){
    delete pinned.observedAtMs;delete pinned.manualBalanceUsd;
    delete pinned.topUpProtection.observedAtMs;
    delete pinned.topUpProtection.evidenceSha256;
  }
  return cueDigest(pinned);
}

// This file is a reviewed native-only decision record. No key, URL, arbitrary
// model, payload, machine path or browser-supplied permission is admitted.
export function validateEdgeTrialOperationalApproval(record,{roomId=EDGE_TRIAL_ROOM_ID,expiresAtMs,scope,companion=false,projectURL=EDGE_TRIAL_PROJECT_URL,now=Date.now}={}){
  const fivePerson=Object.hasOwn(record?.budget??{},'fivePersonMaximumCents');
  const requiredUsd=fivePerson?2.5:1.5;
  const admissionKeys=[...(Object.hasOwn(record??{},'ownerBootstrapVideoApproved')?['ownerBootstrapVideoApproved']:[]),
    ...(Object.hasOwn(record??{},'topUpProtection')?['topUpProtection']:[]),
    ...(Object.hasOwn(record??{},'executionConsent')?['executionConsent']:[]),
    ...(Object.hasOwn(record??{},'balanceMode')?['balanceMode','manualBalanceUsd','manualBalanceSource']:[])];
  const persistent=companion&&isPersistentCompanionConsent(record);
  if(!exact(record,['version',...scopeKeys,'expiresAtMs','approved','autoTopUp','observedAtMs',
    'mediaHost','generationContract','budget','infrastructure','approvedVideoAssetIds','bounds',
    'technicalVisualPolicyApproved',...admissionKeys])||
    record.version!==(companion?'owner-companion-operation-v1':'ai-vdj-edge-operation-v1')||record.roomId!==roomId||
    !/^[a-f0-9-]{36}$/.test(record.sessionId)||!Number.isSafeInteger(record.controlRevision)||record.controlRevision<0||
    !id(record.connectionId)||record.approved!==true||record.autoTopUp!==false&&
      !(companion&&record.autoTopUp===true&&validTopUpProtection(record.topUpProtection,{now,requiredUsd}))||
    !Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now()||(companion?expiresAtMs>now()+14400000:expiresAtMs>Date.parse(EDGE_TRIAL_ROOM_EXPIRES_AT))||
    Object.hasOwn(record,'executionConsent')&&!persistent||
    !persistent&&(!Number.isSafeInteger(record.expiresAtMs)||record.expiresAtMs<=now()||record.expiresAtMs>expiresAtMs)||
    !Number.isSafeInteger(record.observedAtMs)||record.observedAtMs>now()||
    now()-record.observedAtMs>3600000||!persistent&&record.observedAtMs>=record.expiresAtMs||
    record.mediaHost!==new URL(projectURL).hostname||cueDigest(record.generationContract)!==cueDigest(GENERATION_CONTRACT)||
    typeof record.technicalVisualPolicyApproved!=='boolean'||
    Object.hasOwn(record,'ownerBootstrapVideoApproved')&&typeof record.ownerBootstrapVideoApproved!=='boolean'||
    !exact(record.budget,['twoPersonMaximumCents','thirdPersonCumulativeMaximumCents',...(fivePerson?['fivePersonMaximumCents']:[])])||
    record.budget.twoPersonMaximumCents!==100||record.budget.thirdPersonCumulativeMaximumCents!==150||
    fivePerson&&record.budget.fivePersonMaximumCents!==250||
    !exact(record.infrastructure,['verified','maximumUsd','evidenceSha256'])||
    record.infrastructure.verified!==true||!Number.isFinite(record.infrastructure.maximumUsd)||
    record.infrastructure.maximumUsd<0||record.infrastructure.maximumUsd>1.5||
    !hash(record.infrastructure.evidenceSha256)||!Array.isArray(record.approvedVideoAssetIds)||
    record.approvedVideoAssetIds.length===0&&record.ownerBootstrapVideoApproved!==true||
    record.approvedVideoAssetIds.length>8||
    record.approvedVideoAssetIds.some(v=>!id(v))||
    new Set(record.approvedVideoAssetIds).size!==record.approvedVideoAssetIds.length||
    !exact(record.bounds,['intent','music','video']))fail();
  if(scope&&(['roomId','sessionId','controlRevision'].some(key=>record[key]!==scope[key])||
    scope.connectionId!==undefined&&record.connectionId!==scope.connectionId))fail();
  if(Object.hasOwn(record,'balanceMode')&&(!companion||record.balanceMode!=='manual-attested'||
    record.manualBalanceSource!=='fal-dashboard-observation-v1'||record.autoTopUp!==true||
    !acceptsFundedBalance({usd:record.manualBalanceUsd,autoTopUp:true,topUpProtection:record.topUpProtection},{now,requiredUsd})))fail();
  const {intent,music,video}=record.bounds;
  if(!exact(intent,['kind','model','maxOutputTokens','maxInputUtf8Bytes','endpointUnit','endpointUnitPrice',
    'inputUsdPerMillion','outputUsdPerMillion','maximumUsd'])||
    intent.kind!=='reviewed-model-token-ceiling'||intent.model!=='google/gemini-2.5-flash-lite'||
    intent.maxOutputTokens!==800||intent.maxInputUtf8Bytes!==56192||
    !unit(intent.endpointUnit)||!Number.isFinite(intent.endpointUnitPrice)||intent.endpointUnitPrice<=0||
    !positive(intent.maximumUsd)||
    !Number.isFinite(intent.inputUsdPerMillion)||intent.inputUsdPerMillion<=0||intent.inputUsdPerMillion>100||
    !Number.isFinite(intent.outputUsdPerMillion)||intent.outputUsdPerMillion<=0||intent.outputUsdPerMillion>100||
    (56192*intent.inputUsdPerMillion+800*intent.outputUsdPerMillion)/1000000>intent.maximumUsd)fail();
  for(const [bound,configuration,maximumQuantity] of [
    [music,{contextSeconds:16,tailSeconds:24},24],
    [video,{duration:5,resolution:'480P'},5],
  ]){
    if(!exact(bound,['kind','configuration','unit','quantity','maximumUsd'])||
      bound.kind!=='reviewed-billing-units'||cueDigest(bound.configuration)!==cueDigest(configuration)||
      !unit(bound.unit)||
      !Number.isFinite(bound.quantity)||bound.quantity<=0||bound.quantity>maximumQuantity||
      !positive(bound.maximumUsd))fail();
  }
  if(intent.maximumUsd+music.maximumUsd+video.maximumUsd>.5+Number.EPSILON)fail();
  return Object.freeze({...structuredClone(record),evidenceSha256:cueDigest(record)});
}

export async function readEdgeTrialOperationalApprovalFile({file,roomId=EDGE_TRIAL_ROOM_ID,expiresAtMs,scope,companion=false,projectURL=EDGE_TRIAL_PROJECT_URL,now=Date.now}={}){
  let handle;
  try{
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size<2||stat.size>8192||(stat.mode&0o777)!==0o600||
      typeof process.getuid==='function'&&stat.uid!==process.getuid())fail();
    const record=JSON.parse(await handle.readFile({encoding:'utf8'}));
    // Return only reviewed metadata; no bytes are copied into a browser reply.
    validateEdgeTrialOperationalApproval(record,{roomId,expiresAtMs,scope,companion,projectURL,now});
    return record;
  }catch{fail();}finally{await handle?.close();}
}

export function buildEdgeTrialOperatorConfiguration({readOperationalApproval,roomId=EDGE_TRIAL_ROOM_ID,
  expiresAtMs,companion=false,projectURL=EDGE_TRIAL_PROJECT_URL,now=Date.now}={}){
  if(!companion&&roomId!==EDGE_TRIAL_ROOM_ID||!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now()||
    typeof readOperationalApproval!=='function')fail();
  return {
    enabled:true,
    adapters:{enabled:false,balanceMode:'api',approvedVideoAssetIds:[],async readSafetyApproval(scope){
      const record=await readOperationalApproval(scope);
      const approval=validateEdgeTrialOperationalApproval(record,{roomId,expiresAtMs,scope,companion,projectURL,now});
      return {...Object.fromEntries([...scopeKeys,'approved','autoTopUp','observedAtMs','evidenceSha256','bounds']
        .map(key=>[key,approval[key]])),
        ...(approval.autoTopUp===true?{topUpProtection:approval.topUpProtection}:{}),
        ...(approval.balanceMode==='manual-attested'?{manualBalanceUsd:approval.manualBalanceUsd,manualBalanceSource:approval.manualBalanceSource}:{}),
        ...(approval.budget.fivePersonMaximumCents===250?{fivePersonMaximumCents:250}:{}),
        ...(approval.technicalVisualPolicyApproved?{visualPolicy:TECHNICAL_VISUAL_POLICY}:{})};
    }},
    trial:{mediaHost:new URL(projectURL).hostname,infrastructure:{verified:false,maximumUsd:0}},
    approvals:{connection:false,media:true,trial:false},
  };
}

export async function readEdgeTrialConfiguration({readOperationalApproval,registration,roomId=EDGE_TRIAL_ROOM_ID,
  expiresAtMs,companion=false,projectURL=EDGE_TRIAL_PROJECT_URL,now=Date.now}={}){
  if(!registration||registration.roomId!==roomId||!/^[a-f0-9-]{36}$/.test(registration.sessionId)||
    !Number.isSafeInteger(registration.controlRevision)||!Number.isSafeInteger(registration.expiresAtMs)||
    registration.expiresAtMs<=now()||registration.expiresAtMs>expiresAtMs)fail();
  const record=await readOperationalApproval(registration);
  const deadline=Math.min(expiresAtMs,registration.expiresAtMs);
  const approved=validateEdgeTrialOperationalApproval(record,{roomId,expiresAtMs:deadline,scope:registration,companion,projectURL,now});
  const base=buildEdgeTrialOperatorConfiguration({readOperationalApproval,roomId,expiresAtMs:deadline,companion,projectURL,now});
  return Object.freeze({connectionId:approved.connectionId,operatorConfiguration:{...base,
    adapters:{...base.adapters,enabled:true,balanceMode:approved.balanceMode??'api',approvedVideoAssetIds:[...approved.approvedVideoAssetIds],
      ownerBootstrapVideoApproved:approved.ownerBootstrapVideoApproved===true,
      async readSafetyApproval(scope){
        const safety=await base.adapters.readSafetyApproval(scope);
        // Revalidate the complete private record before comparing the consent
        // identity. Freshness, adequate funds and private-file checks remain
        // mandatory; a stale/insufficient observation never extends authority.
        const latest=validateEdgeTrialOperationalApproval(await readOperationalApproval(scope),
          {roomId,expiresAtMs:deadline,scope,companion,projectURL,now});
        if(safety.evidenceSha256!==latest.evidenceSha256||
          companion&&approved.balanceMode==='manual-attested'&&
            (latest.observedAtMs<approved.observedAtMs||latest.topUpProtection.observedAtMs<approved.topUpProtection.observedAtMs)||
          approvalIdentity(latest,{companion})!==approvalIdentity(approved,{companion}))fail();
        return safety;
      }},
    trial:{mediaHost:new URL(projectURL).hostname,infrastructure:{verified:true,maximumUsd:approved.infrastructure.maximumUsd},
      ...(approved.budget.fivePersonMaximumCents===250?{maximumParticipants:5,maximumCents:250}:{})},
    approvals:{connection:true,media:true,trial:true}}});
}
