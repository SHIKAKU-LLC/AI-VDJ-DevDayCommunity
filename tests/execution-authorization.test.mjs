import test from 'node:test';
import assert from 'node:assert/strict';
import {validateExecutionAuthorization,refreshExecutionEvidence} from '../cloud/worker/execution-authorization.mjs';
import {createOwnerOperatorFixture} from './owner-operator-fixture.mjs';
const scope={roomId:'synthetic-room',['sessionId']:'example-epoch',controlRevision:0,expiresAtMs:9000000};
const plan={...scope,planId:'synthetic-plan',phase:'STARTED',participants:2,maximumCents:100,infrastructureMaximumUsd:1.5,
 recovery:{unknownIntentReserveCents:4,totalGenerationReservationCents:104,thirdParticipantExcluded:true},
 operations:[1,2].map(i=>({operationId:'synthetic-operation-'+i}))};
const grant={kind:'room-budget-execution-consent-v1',roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:0,
 planId:plan.planId,approvedAtMs:1,expiresAtMs:null,revoked:false,operationIds:plan.operations.map(o=>o.operationId),
 generationMaximumCents:150,infrastructureMaximumCents:150,unknownReserveCents:4,totalReservationCents:104};
test('application consent does not age out, and cannot reset budget, replace operations, widen scope or revoke Stop',()=>{
 for(const clock of [1000,10**12])assert.deepEqual(validateExecutionAuthorization(grant,{plan,scope,now:()=>clock}),grant);
 for(const patch of [{expiresAtMs:1000000},{revoked:true},{generationMaximumCents:151},{unknownReserveCents:0},
 {totalReservationCents:100},{operationIds:['other-operation',grant.operationIds[1]]},{['sessionId']:'example-other-epoch'},
 {controlRevision:1},{planId:'other-plan'},{approvedAtMs:1001},{extra:true}])
  assert.throws(()=>validateExecutionAuthorization({...grant,...patch},{plan,scope,now:()=>1000}),/AUTHORIZATION_REQUIRED/);
});
test('refresh uses fresh bounded finance/media evidence and the same IDs, with no submit/begin/retry port',async()=>{
 const x=createOwnerOperatorFixture();const source=x.ports.trial;
 let inserted,connectionReads=0,quoteReads=0,signReads=0;
 const p={...plan,roomId:x.ports.roomId,['sessionId']:'22222222-2222-4222-a222-222222222222',
  connectionId:'existing-connection',assets:[],sourceSha256:'a'.repeat(64),operations:[1,2].map(i=>({operationId:'synthetic-operation-'+i,
   permitId:'permit-'+String(i).repeat(24),permit:{permitId:'permit-'+String(i).repeat(24),kind:'unified-intent-av-v1',
   maximumUsd:.5,counts:{intent:1,music:1,video:1}}}))};
 const fixtureSource=await source.readSource();const {cueDigest,cueSourceIdentity}=await import('../snapshot/app/runtime/intent-compiler.mjs');
 p.sourceSha256=cueDigest(cueSourceIdentity(fixtureSource));for(const o of p.operations)Object.assign(o.permit,{source:fixtureSource,sourceSha256:p.sourceSha256,connectionId:p.connectionId});
 const s={roomId:p.roomId,['sessionId']:p.sessionId,controlRevision:0,expiresAtMs:60000};
 p.executionAuthorization={...grant,...s,planId:p.planId};delete p.executionAuthorization.expiresAtMs;
 p.executionAuthorization.expiresAtMs=null;
 const trial={...source,quoteAndBalance:async i=>{quoteReads++;return source.quoteAndBalance(i);},
 signSource:async i=>{signReads++;return source.signSource(i);},insertPermits:async i=>{inserted=i.plan;},
 plans:{active:async()=>({stored:true})}};
 assert.deepEqual(await refreshExecutionEvidence({plan:p,scope:s,connections:{read:async()=>{connectionReads++;return {verified:true,connectionId:p.connectionId,expiresAtMs:50000};}},trial,now:()=>1000}),{stored:true});
 assert.equal(connectionReads,1);assert.equal(quoteReads,1);assert.equal(signReads,1);
 assert.equal(inserted.expiresAtMs,50000);assert.deepEqual(inserted.operations.map(o=>o.operationId),grant.operationIds);
 assert.equal(inserted.executionAuthorization.expiresAtMs,null);assert.equal(inserted.recovery.unknownIntentReserveCents,4);
 const valid=structuredClone(inserted),connection={read:async()=>({verified:true,connectionId:p.connectionId,expiresAtMs:50000})};
 const reused=await refreshExecutionEvidence({plan:valid,scope:s,connections:connection,trial,now:()=>1000,reuseCurrent:true});
 assert.deepEqual(reused,valid);assert.notEqual(reused,valid);
 assert.equal(quoteReads,1);assert.equal(signReads,1,'fresh recovery does not re-sign or replace a completed admission');
 // A stale member of the same two-operation plan cannot reuse its authority.
 valid.operations[1].permit.expiresAtMs=1000;
 await refreshExecutionEvidence({plan:valid,scope:s,connections:connection,trial,now:()=>1000,reuseCurrent:true});
 assert.equal(quoteReads,2);assert.equal(signReads,2);
});
