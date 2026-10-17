import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOwnerOperator,countOperatorTrialCredits} from '../cloud/worker/owner-operator.mjs';
import {createOwnerSetupModel} from '../room-web/owner-setup-model.mjs';
import {createOwnerOperatorFixture as fixture} from './owner-operator-fixture.mjs';
import {syntheticWave,fixtureSha} from './cloud-worker-fixture.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
const roomId='11111111-1111-4111-a111-111111111111',owner='a'.repeat(64),origin='https://vdj.example';
const scope={roomId,['sessionId']:'22222222-2222-4222-a222-222222222222',controlRevision:0,ownerEnabled:true,expiresAtMs:60000};
test('third trial credits include its exact prior two and require matching playback plus ACK for each distinct participant',()=>{
 const operations=[1,2,3].map(i=>({operationId:'synthetic-operation-'+i,participantId:'synthetic-participant-'+i}));
 const priorPlan={...scope,planId:'synthetic-prior',phase:'STARTED',participants:2,operations:operations.slice(0,2)},plan={...scope,participants:3,priorPlanId:priorPlan.planId,operations:operations.slice(2)};
 const playback={cues:operations.map(o=>({...o,contribution:{participantId:o.participantId},status:'PLAYED',playbackRevision:1}))},runtime={acks:operations.map(o=>({reservation:{operationId:o.operationId,cue:{contribution:{participantId:o.participantId}}}}))};
 assert.equal(countOperatorTrialCredits({plan,priorPlan,playback,runtime}),3);
 assert.equal(countOperatorTrialCredits({plan,priorPlan,playback,runtime:{acks:runtime.acks.slice(0,2)}}),2);
 assert.equal(countOperatorTrialCredits({plan,priorPlan:{...priorPlan,controlRevision:1},playback,runtime}),0);
 assert.equal(countOperatorTrialCredits({plan,priorPlan,playback:{cues:playback.cues.map(c=>({...c,status:'READY'}))},runtime}),0);
});
const scoped=Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,scope[k]]));
const digest=b=>createHash('sha256').update(b).digest('hex');

async function selections(x){
 await x.model.select({role:'seed',file:new File([syntheticWave(24)],'anonymous.wav',{type:'audio/wav'})});
 await x.model.select({role:'reference',file:new File([Uint8Array.of(137,80,78,71,13,10,26,10)],'anonymous.png',{type:'image/png'})});
 await x.model.select({role:'saved-video',file:new File([Uint8Array.of(0,0,0,12,102,116,121,112,109,112,52,50)],'anonymous.mp4',{type:'video/mp4'})});
}
test('one judge can generate one real pipeline operation; a denied global budget never inserts a permit',async()=>{
 for(const denied of [false,true]){
  let reservations=0;
  const x=fixture({serverManaged:true,submissionCount:1,reserveBudget:async()=>{reservations++;if(denied)throw Error('JUDGE_BUDGET');}});
  await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);await x.model.upload(true);
  await x.model.prepare(1);assert.equal(x.model.snapshot().plan.maximumCents,50);
  if(denied)await assert.rejects(x.model.start(true));else await x.model.start(true);
  assert.equal(reservations,1);assert.equal(x.inserted.length,denied?0:1);assert.equal(x.begun.length,denied?0:1);
  x.model.dispose();x.server.close();
 }
});
test('five-person approval admits exactly five unique cues once within the USD 2.50 cap',async()=>{
 const x=fixture({fivePerson:true,submissionCount:5,balanceUsd:3});
 await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);await x.model.upload(true);
 await x.model.prepare(5);const plan=x.model.snapshot().plan;
 assert.equal(plan.maximumCents,250);assert.equal(plan.newParticipants,5);assert.equal(x.begun.length,0);
 await x.model.start(true);assert.equal(x.begun.length,5);
 assert.equal(new Set(x.begun.map(o=>o.participantId)).size,5);
 assert(x.inserted.every(p=>p.maximumUsd===.5));
 await assert.rejects(x.model.start(true),/CONSENT_REQUIRED/);assert.equal(x.begun.length,5);
 x.model.dispose();x.server.close();
});
test('five cues require explicit approval, five submissions and a balance above the full cap',async()=>{
 for(const options of [{submissionCount:5,balanceUsd:3},{fivePerson:true,submissionCount:4,balanceUsd:3},{fivePerson:true,submissionCount:5,balanceUsd:2.5}]){
  const x=fixture(options);await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);await x.model.upload(true);
  await assert.rejects(x.model.prepare(5));assert.equal(x.begun.length,0);assert.equal(x.inserted.length,0);
  x.model.dispose();x.server.close();
 }
});
test('default-off reports one concrete setup step, rejects input before resolver access and never creates Mac prerequisite',async()=>{
 const x=fixture({enabled:false});await x.model.load();assert.equal(x.model.snapshot().available.connection,false);assert.equal(x.connectionCalls(),0);
 await assert.rejects(x.model.connect('example_fixture_connection'),/NOT_CONFIGURED/);assert.equal(x.connectionCalls(),0);
 assert.equal(x.server.capabilities().macRequired,false);assert.equal(x.server.capabilities().persistentCredentialStorage,false);x.model.dispose();
});
test('active trial status reuses exact admitted display descriptors without a second physical read',async()=>{
 const x=fixture();await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);
 await x.model.upload(true);await x.model.prepare(2);
 const descriptors=()=>[...x.assets.values()].map(a=>structuredClone(a));
 x.ports.media.listSelected=async()=>descriptors();x.ports.media.listSelectedForStatus=async()=>descriptors();
 const original=x.ports.media.read;let physical=0;x.ports.media.read=async input=>{physical++;return original(input);};
 const result=await x.request(`/api/rooms/${roomId}/operator/status`);
 assert.equal(result.assets.length,3);assert.equal(physical,0);
 const changed=x.ports.media.listSelectedForStatus;
 x.ports.media.listSelectedForStatus=async()=>{const ds=await changed();ds[0].byteLength++;return ds;};
 await x.request(`/api/rooms/${roomId}/operator/status`);assert.equal(physical,1,'mismatch falls back to physical admission descriptor');
 x.model.dispose();
});
test('owner input -> opaque verification -> explicit hash/size upload -> 2-person budget/start -> server-confirmed third person',async()=>{
 const x=fixture();await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);
 const s=x.model.snapshot();assert.equal(s.selections.length,3);assert(s.selections.every(a=>/^[a-f0-9]{64}$/.test(a.sha256)));assert(!JSON.stringify(s).includes('example_fixture_connection'));
 await assert.rejects(x.model.upload(false),/SELECTION_REQUIRED/);assert.equal(x.assets.size,0);await x.model.upload(true);assert.equal(x.assets.size,3);
 await assert.rejects(x.model.prepare(3),/TRIAL_REQUIRED/);await x.model.prepare(2);assert.equal(x.begun.length,0);assert.equal(x.model.snapshot().plan.maximumCents,100);
 x.model.changeParticipants();assert.equal(x.model.snapshot().plan,null);await assert.rejects(x.model.start(true),/CONSENT_REQUIRED/);await x.model.prepare(2);
 await assert.rejects(x.model.start(false),/CONSENT_REQUIRED/);assert.equal(x.begun.length,0);await x.model.start(true);assert.equal(x.begun.length,2);
 assert(x.inserted.every(p=>p.maximumUsd===.5&&p.counts.intent===1&&p.counts.music===1&&p.counts.video===1));
 x.setCompleted(2);await x.model.refresh();assert.equal(x.model.snapshot().trial.canAddThird,true);await x.model.prepare(3);
 assert.equal(x.model.snapshot().plan.newParticipants,1);await x.model.start(true);assert.equal(x.begun.length,3);assert.equal(new Set(x.begun.map(o=>o.participantId)).size,3);
 assert(!JSON.stringify(x.model.snapshot()).includes('example_fixture_connection'));x.model.dispose();x.server.close();
});
test('unknown start never replays paid admission; status-only reconciliation keeps the same plan',async()=>{
 const x=fixture({ambiguous:true});await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);await x.model.upload(true);await x.model.prepare(2);
 await assert.rejects(x.model.start(true),/START_UNKNOWN/);assert.equal(x.begun.length,1);await assert.rejects(x.model.start(true),/CONSENT_REQUIRED/);assert.equal(x.begun.length,1);
 await x.model.refresh();assert.equal(x.model.snapshot().trial.phase,'UNKNOWN');x.model.dispose();
});
test('definitive source-origin rejection stays a configuration HOLD before any permit or paid admission',async()=>{
 const x=fixture();await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);await x.model.upload(true);await x.model.prepare(2);
 x.ports.trial.signSource=async()=>{throw Object.assign(Error('OPERATOR_SOURCE_ORIGIN_REQUIRED'),{code:'OPERATOR_SOURCE_ORIGIN_REQUIRED'});};
 await assert.rejects(x.model.start(true),/SOURCE_ORIGIN_REQUIRED/);assert.equal(x.model.snapshot().plan.phase,'HOLD');assert.equal(x.begun.length,0);assert.equal(x.inserted.length,0);
 assert.equal(x.model.snapshot().nextAction.target,'source-origin');x.model.dispose();x.server.close();
});
test('infrastructure cap is an explicit verified gate; a quoted old3USD proposal never enables dispatch',async()=>{
 const x=fixture({infrastructure:false});await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);await x.model.upload(true);
 await assert.rejects(x.model.prepare(2),/INFRASTRUCTURE_REQUIRED/);assert.equal(x.begun.length,0);assert.equal(x.inserted.length,0);x.model.dispose();
});
test('a trial cannot consume the whole balance at review or after the balance changes before start',async()=>{
 const x=fixture();await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);await x.model.upload(true);
 const quote=x.ports.trial.quoteAndBalance;let usd=1;
 x.ports.trial.quoteAndBalance=async input=>{const evidence=await quote(input);return {...evidence,balance:{...evidence.balance,usd}};};
 await assert.rejects(x.model.prepare(2),/BALANCE_REQUIRED/);assert.equal(x.inserted.length,0);assert.equal(x.begun.length,0);
 usd=2;await x.model.prepare(2);usd=1;
 await assert.rejects(x.model.start(true),/BALANCE_REQUIRED/);assert.equal(x.inserted.length,0);assert.equal(x.begun.length,0);
 x.model.dispose();x.server.close();
});
test('HTTP preserves owner/origin/body/opaque-result boundaries and no browser quote can create a permit',async()=>{
 const x=fixture(),path=origin+`/api/rooms/${roomId}/operator/connection`;
 for(const headers of [{origin:'https://foreign.example','x-room-owner':owner},{origin,'x-room-owner':'b'.repeat(64)},
 {origin,'x-room-owner':owner,authorization:'example_forbidden'}])assert.equal((await x.server.handleRequest(new Request(path,{method:'POST',headers,body:'{}'}))).status,403);
 const r=await x.server.handleRequest(new Request(path,{method:'POST',headers:{origin,'x-room-owner':owner,'content-type':'application/json'},body:JSON.stringify({credential:'example_fixture_connection',verified:true})}));assert.equal(r.status,409);assert.equal(x.connectionCalls(),0);
 x.model.dispose();
});

test('fresh owner model restores opaque connection, accepted selection and same trial without asking for input or replaying start',async()=>{
 const x=fixture();await x.model.load();await x.model.connect('example_fixture_connection');await selections(x);await x.model.upload(true);await x.model.prepare(2);await x.model.start(true);x.model.dispose();
 const fresh=createOwnerSetupModel({request:x.request,roomId});await fresh.load();assert.equal(fresh.snapshot().connection.verified,true);assert.equal(fresh.snapshot().assets.length,3);assert.equal(fresh.snapshot().trial.phase,'STARTED');assert.equal(x.connectionCalls(),1);assert.equal(x.begun.length,2);fresh.dispose();
 const noActive=createOwnerOperator({...x.ports,connections:{...x.ports.connections,readActive:undefined}});
 const result=await noActive.handleRequest(new Request(origin+`/api/rooms/${roomId}/operator/status`,{headers:{origin,'x-room-owner':owner}}));
 const resumed=await result.json();assert.equal(result.status,200);assert.equal(resumed.connection.verified,true);assert.equal(resumed.trial.phase,'STARTED');assert.equal(x.connectionCalls(),1);noActive.close();
});
