import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import {GENERATION_CONTRACT} from '../../cloud/generation/dispatch.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../qc/visual-policy.mjs';
import {EDGE_TRIAL_ROOM_ID,EDGE_TRIAL_ROOM_EXPIRES_AT,EDGE_TRIAL_PROJECT_URL} from './edge-trial-launch.mjs';
import {buildEdgeTrialOperatorConfiguration,readEdgeTrialConfiguration,
  readEdgeTrialOperationalApprovalFile,validateEdgeTrialOperationalApproval} from './edge-trial-operator-config.mjs';

const expiresAtMs=Date.parse(EDGE_TRIAL_ROOM_EXPIRES_AT),now=()=>expiresAtMs-10*60_000;
const scope={roomId:EDGE_TRIAL_ROOM_ID,['sessionId']:'22222222-2222-4222-a222-222222222222',
  controlRevision:0,connectionId:'connection-synthetic'};
const record=()=>({version:'ai-vdj-edge-operation-v1',...scope,expiresAtMs,approved:true,autoTopUp:false,
  observedAtMs:now(),mediaHost:new URL(EDGE_TRIAL_PROJECT_URL).hostname,
  generationContract:GENERATION_CONTRACT,budget:{twoPersonMaximumCents:100,thirdPersonCumulativeMaximumCents:150},
  infrastructure:{verified:true,maximumUsd:0,evidenceSha256:'a'.repeat(64)},
  approvedVideoAssetIds:['saved-video-1'],technicalVisualPolicyApproved:false,
  bounds:{intent:{kind:'reviewed-model-token-ceiling',model:'google/gemini-2.5-flash-lite',
    maxOutputTokens:800,maxInputUtf8Bytes:56192,endpointUnit:'dynamic_tokens',endpointUnitPrice:.1,
    inputUsdPerMillion:.1,outputUsdPerMillion:.4,maximumUsd:.01},
    music:{kind:'reviewed-billing-units',configuration:{contextSeconds:16,tailSeconds:24},
      unit:'audio',quantity:1,maximumUsd:.05},
    video:{kind:'reviewed-billing-units',configuration:{duration:5,resolution:'480P'},
      unit:'second',quantity:5,maximumUsd:.4}}});

test('five-person configuration requires a pinned USD 2.50 approval and funding buffer',async()=>{
 const approval={...record(),version:'owner-companion-operation-v1',
  budget:{...record().budget,fivePersonMaximumCents:250},autoTopUp:true,balanceMode:'manual-attested',
  manualBalanceUsd:13,manualBalanceSource:'fal-dashboard-observation-v1',
  topUpProtection:{kind:'existing-credit-only-v1',approved:true,thresholdUsd:10,topUpAmountUsd:50,
   maximumSpendUsd:2.5,observedAtMs:now(),evidenceSha256:'b'.repeat(64)}};
 const configured=await readEdgeTrialConfiguration({roomId:scope.roomId,expiresAtMs,now,companion:true,
  registration:{...scope,expiresAtMs},readOperationalApproval:async()=>approval});
 assert.equal(configured.operatorConfiguration.trial.maximumParticipants,5);
 assert.equal(configured.operatorConfiguration.trial.maximumCents,250);
 assert.equal((await configured.operatorConfiguration.adapters.readSafetyApproval(scope)).fivePersonMaximumCents,250);
 for(const changed of [
  {...approval,budget:{...approval.budget,fivePersonMaximumCents:251}},
  {...approval,manualBalanceUsd:12.5},
  {...approval,topUpProtection:{...approval.topUpProtection,maximumSpendUsd:1.5}},
 ])assert.throws(()=>validateEdgeTrialOperationalApproval(changed,{roomId:scope.roomId,expiresAtMs,scope,now,companion:true}),/APPROVAL_REQUIRED/);
});

test('operator config stays dormant while reviewed safety callback enforces exact finite scope',async()=>{
  let approval=record();const readOperationalApproval=async()=>structuredClone(approval);
  const initial=buildEdgeTrialOperatorConfiguration({roomId:EDGE_TRIAL_ROOM_ID,expiresAtMs,now,readOperationalApproval});
  assert.equal(initial.approvals.trial,false);assert.equal(initial.trial.infrastructure.verified,false);
  assert.equal(initial.adapters.enabled,false);
  assert.deepEqual(initial.adapters.approvedVideoAssetIds,[]);
  assert.equal(initial.adapters.balanceMode,'api');
  const safety=await initial.adapters.readSafetyApproval(scope);
  assert.equal(safety.approved,true);assert.equal(safety.autoTopUp,false);
  assert.equal(safety.visualPolicy,undefined);
  approval={...approval,technicalVisualPolicyApproved:true};
  assert.deepEqual((await initial.adapters.readSafetyApproval(scope)).visualPolicy,TECHNICAL_VISUAL_POLICY);
  const configured=await readEdgeTrialConfiguration({roomId:EDGE_TRIAL_ROOM_ID,expiresAtMs,now,
    registration:{roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision,expiresAtMs},readOperationalApproval});
  assert.equal(configured.connectionId,scope.connectionId);
  assert.equal(configured.operatorConfiguration.approvals.trial,true);
  assert.equal(configured.operatorConfiguration.adapters.enabled,true);
  assert.deepEqual(configured.operatorConfiguration.adapters.approvedVideoAssetIds,['saved-video-1']);
  assert.equal(configured.operatorConfiguration.trial.infrastructure.maximumUsd,0);
  assert.equal(Object.hasOwn(configured.operatorConfiguration.trial,'maximumParticipants'),false);
  approval={...approval,technicalVisualPolicyApproved:false};
  await assert.rejects(configured.operatorConfiguration.adapters.readSafetyApproval(scope),
    /EDGE_TRIAL_OPERATIONAL_APPROVAL_REQUIRED/);
  for(const changed of [
    {...record(),autoTopUp:true},
    {...record(),mediaHost:'foreign.supabase.co'},
    {...record(),budget:{twoPersonMaximumCents:200,thirdPersonCumulativeMaximumCents:150}},
    {...record(),['sessionId']:'33333333-3333-4333-a333-333333333333'},
    {...record(),bounds:{...record().bounds,video:{...record().bounds.video,maximumUsd:.5}}},
    {...record(),credential:'forbidden'},
  ]) assert.throws(()=>validateEdgeTrialOperationalApproval(changed,{roomId:EDGE_TRIAL_ROOM_ID,
    expiresAtMs,scope,now}),/EDGE_TRIAL_OPERATIONAL_APPROVAL_REQUIRED/);
});

test('reviewed operational record is read only from a private regular file',async t=>{
  const dir=await mkdtemp(path.join('/tmp','vdj-edge-operation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'operation.json');await writeFile(file,JSON.stringify(record()),{mode:0o600});
  assert.equal((await readEdgeTrialOperationalApprovalFile({file,roomId:EDGE_TRIAL_ROOM_ID,
    expiresAtMs,scope,now})).connectionId,scope.connectionId);
  await chmod(file,0o644);
  await assert.rejects(readEdgeTrialOperationalApprovalFile({file,roomId:EDGE_TRIAL_ROOM_ID,
    expiresAtMs,scope,now}),/EDGE_TRIAL_OPERATIONAL_APPROVAL_REQUIRED/);
});

test('an empty room admits owner video only through a reviewed pinned native policy',async()=>{
 const approval={...record(),approvedVideoAssetIds:[],ownerBootstrapVideoApproved:true};
 const configured=await readEdgeTrialConfiguration({roomId:scope.roomId,expiresAtMs,now,
  registration:{...scope,expiresAtMs},readOperationalApproval:async()=>approval});
 assert.deepEqual(configured.operatorConfiguration.adapters.approvedVideoAssetIds,[]);
 assert.equal(configured.operatorConfiguration.adapters.ownerBootstrapVideoApproved,true);
 assert.equal(configured.operatorConfiguration.approvals.trial,true);
 for(const changed of [
  {...record(),approvedVideoAssetIds:[]},
  {...approval,ownerBootstrapVideoApproved:false},
  {...approval,ownerBootstrapVideoApproved:'true'},
  {...approval,autoTopUp:true},
  {...approval,observedAtMs:now()-3600001},
  {...approval,expiresAtMs:now()},
  {...approval,controlRevision:scope.controlRevision+1},
  {...approval,infrastructure:{...approval.infrastructure,verified:false}},
  {...approval,budget:{...approval.budget,thirdPersonCumulativeMaximumCents:151}},
 ])assert.throws(()=>validateEdgeTrialOperationalApproval(changed,{roomId:scope.roomId,
  expiresAtMs,scope,now}),/EDGE_TRIAL_OPERATIONAL_APPROVAL_REQUIRED/);
 approval.ownerBootstrapVideoApproved=false;
 await assert.rejects(configured.operatorConfiguration.adapters.readSafetyApproval(scope),
  /EDGE_TRIAL_OPERATIONAL_APPROVAL_REQUIRED/);
});

test('only the companion profile accepts explicit funded ON policy; legacy approval stays unchanged',()=>{
 const topUpProtection={kind:'existing-credit-only-v1',approved:true,thresholdUsd:10,topUpAmountUsd:50,maximumSpendUsd:1.5,observedAtMs:now(),evidenceSha256:'a'.repeat(64)};
 const value={...record(),version:'owner-companion-operation-v1',autoTopUp:true,topUpProtection};
 assert.equal(validateEdgeTrialOperationalApproval(value,{roomId:scope.roomId,expiresAtMs,scope,now,companion:true}).autoTopUp,true);
 assert.throws(()=>validateEdgeTrialOperationalApproval({...value,version:'ai-vdj-edge-operation-v1'},{roomId:scope.roomId,expiresAtMs,scope,now}),/APPROVAL_REQUIRED/);
 assert.throws(()=>validateEdgeTrialOperationalApproval({...value,topUpProtection:{...topUpProtection,maximumSpendUsd:3}},{roomId:scope.roomId,expiresAtMs,scope,now,companion:true}),/APPROVAL_REQUIRED/);
});

test('a fresh dashboard observation must be explicitly selected and remain above the full run threshold',async()=>{
 const approval={...record(),version:'owner-companion-operation-v1',autoTopUp:true,balanceMode:'manual-attested',manualBalanceUsd:100,manualBalanceSource:'fal-dashboard-observation-v1',topUpProtection:{kind:'existing-credit-only-v1',approved:true,thresholdUsd:10,topUpAmountUsd:50,maximumSpendUsd:1.5,observedAtMs:now(),evidenceSha256:'b'.repeat(64)}};
 const configured=await readEdgeTrialConfiguration({roomId:scope.roomId,expiresAtMs,scope,now,companion:true,registration:{...scope,expiresAtMs},readOperationalApproval:async()=>approval});
 assert.equal(configured.operatorConfiguration.adapters.balanceMode,'manual-attested');
 assert.equal((await configured.operatorConfiguration.adapters.readSafetyApproval(scope)).manualBalanceUsd,100);
 for(const changed of [{...approval,manualBalanceUsd:11.5},{...approval,manualBalanceSource:'unverified'},{...approval,balanceMode:'api'}])assert.throws(()=>validateEdgeTrialOperationalApproval(changed,{roomId:scope.roomId,expiresAtMs,scope,now,companion:true}));
});

test('fresh financial observations roll without changing finite companion consent or policies',async()=>{
 let time=now();const clock=()=>time,deadline=time+2*3600000;
 let approval={...record(),expiresAtMs:deadline,version:'owner-companion-operation-v1',autoTopUp:true,
  balanceMode:'manual-attested',manualBalanceUsd:100,manualBalanceSource:'fal-dashboard-observation-v1',
  topUpProtection:{kind:'existing-credit-only-v1',approved:true,thresholdUsd:10,topUpAmountUsd:50,
   maximumSpendUsd:1.5,observedAtMs:time,evidenceSha256:'b'.repeat(64)}};
 const configured=await readEdgeTrialConfiguration({roomId:scope.roomId,expiresAtMs:deadline,now:clock,
  companion:true,registration:{...scope,expiresAtMs:deadline},readOperationalApproval:async()=>structuredClone(approval)});
 const first=await configured.operatorConfiguration.adapters.readSafetyApproval(scope);
 time+=3600001;
 await assert.rejects(configured.operatorConfiguration.adapters.readSafetyApproval(scope),/APPROVAL_REQUIRED/);
 approval={...approval,observedAtMs:time,manualBalanceUsd:99,
  topUpProtection:{...approval.topUpProtection,observedAtMs:time,evidenceSha256:'c'.repeat(64)}};
 const second=await configured.operatorConfiguration.adapters.readSafetyApproval(scope);
 assert.equal(second.manualBalanceUsd,99);assert.equal(second.observedAtMs,time);
 assert.notEqual(second.evidenceSha256,first.evidenceSha256);
 const fresh=structuredClone(approval);
 for(const mutation of [
  v=>v.manualBalanceUsd=11.5,
  v=>v.technicalVisualPolicyApproved=true,
  v=>v.approvedVideoAssetIds=['different-video'],
  v=>v.bounds.video.maximumUsd=.39,
  v=>v.topUpProtection.thresholdUsd=20,
  v=>v.topUpProtection.topUpAmountUsd=60,
  v=>v.infrastructure.maximumUsd=.1,
  v=>v.expiresAtMs=deadline-1,
  v=>v.connectionId='connection-other',
 ]){
  approval=structuredClone(fresh);mutation(approval);
  await assert.rejects(configured.operatorConfiguration.adapters.readSafetyApproval(scope),/APPROVAL_REQUIRED/);
 }
 approval=structuredClone(fresh);time=deadline;
 await assert.rejects(configured.operatorConfiguration.adapters.readSafetyApproval(scope),/APPROVAL_REQUIRED/);
});

test('explicit until-revoked companion consent still requires finite native authority and fresh funds',async()=>{
 let time=now();const clock=()=>time,deadline=time+2*3600000;
 let approval={...record(),version:'owner-companion-operation-v1',expiresAtMs:null,executionConsent:'until-revoked',
  autoTopUp:true,balanceMode:'manual-attested',manualBalanceUsd:100,manualBalanceSource:'fal-dashboard-observation-v1',
  topUpProtection:{kind:'existing-credit-only-v1',approved:true,thresholdUsd:10,topUpAmountUsd:50,
   maximumSpendUsd:1.5,observedAtMs:time,evidenceSha256:'b'.repeat(64)}};
 const options={roomId:scope.roomId,expiresAtMs:deadline,now:clock,scope,companion:true};
 const configured=await readEdgeTrialConfiguration({...options,registration:{...scope,expiresAtMs:deadline},
  readOperationalApproval:async()=>structuredClone(approval)});
 assert.equal((await configured.operatorConfiguration.adapters.readSafetyApproval(scope)).approved,true);
 for(const mutation of [v=>delete v.executionConsent,v=>v.executionConsent='forever',v=>v.expiresAtMs=deadline,
  v=>v.approved=false,v=>v.controlRevision++,v=>v.manualBalanceUsd=11.5]){
  const changed=structuredClone(approval);mutation(changed);
  assert.throws(()=>validateEdgeTrialOperationalApproval(changed,options),/APPROVAL_REQUIRED/);
 }
 assert.throws(()=>validateEdgeTrialOperationalApproval({...approval,version:'ai-vdj-edge-operation-v1'},
  {...options,companion:false}),/APPROVAL_REQUIRED/);
 time+=3600001;
 await assert.rejects(configured.operatorConfiguration.adapters.readSafetyApproval(scope),/APPROVAL_REQUIRED/);
 approval.observedAtMs=time;approval.topUpProtection.observedAtMs=time;
 assert.equal((await configured.operatorConfiguration.adapters.readSafetyApproval(scope)).approved,true);
 time=deadline;
 await assert.rejects(configured.operatorConfiguration.adapters.readSafetyApproval(scope),/APPROVAL_REQUIRED/);
 await assert.rejects(readEdgeTrialConfiguration({...options,registration:{...scope,expiresAtMs:deadline},
  readOperationalApproval:async()=>approval}),/APPROVAL_REQUIRED/);
});
