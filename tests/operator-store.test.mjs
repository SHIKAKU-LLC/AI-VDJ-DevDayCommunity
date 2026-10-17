import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createOperatorPlanStore,OPERATOR_PERMITS_SQL} from '../cloud/jobs/operator-store.mjs';
import {createProductionRepository} from '../cloud/jobs/production-repository.mjs';
const owner='a'.repeat(64),uid='11111111-1111-4111-a111-111111111111';
async function setup(t){const db=new PGlite();t.after(()=>db.close());await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/jobs/operator-state.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
 await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);const room=(await db.query("select public.vdj_room_request('create',null,null,$1::jsonb,$2) value",[JSON.stringify({ownerCapability:owner,joinCode:'c'.repeat(64)}),uid])).rows[0].value;
 const s=Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,room[k]]));
 const store=()=>createOperatorPlanStore({query:(q,v)=>db.query(q,v),withOwnerAuthorization:(scope,fn)=>fn({...scope,ownerCapability:owner})});
 const plan=(id,n=2,prior=null)=>({...s,planId:id,phase:'REVIEW',participants:n,priorPlanId:prior,maximumCents:n*50,sourceSha256:'d'.repeat(64),
 operations:(n===3?[3]:Array.from({length:n},(_,i)=>i+1)).map(i=>({operationId:'operation-'+i,permitId:'permit-'+i,participantId:'participant-'+i,submissionId:'submission-'+i,permit:{counts:{intent:1,music:1,video:1},maximumUsd:.5}}))});
 return {db,s,store,plan};}
for(const count of [1,5])test(`${count}-person SQL admission freezes exact permits and rejects excess budgets or a second batch`,async t=>{
 const x=await setup(t),store=x.store(),expiresAtMs=Date.now()+300000;
 const plan={...x.plan('bounded-person-plan',count),connectionId:'synthetic-connection'};
 plan.operations=plan.operations.map((o,i)=>({...o,operationId:'operation-'+String(i).repeat(24),permitId:'permit-'+String(i).repeat(24),permit:{...o.permit,permitId:'permit-'+String(i).repeat(24),sourceSha256:plan.sourceSha256,
  source:{music:{clipId:'synthetic-source'}},connectionId:plan.connectionId,expiresAtMs}}));
 await assert.rejects(store.save({...plan,maximumCents:300}),/TRIAL_REQUIRED/);
 await assert.rejects(store.save({...plan,participants:6}),/TRIAL_REQUIRED/);
 await x.db.query('update vdj_internal.rooms set submissions=$2::jsonb where id=$1',[x.s.roomId,JSON.stringify(plan.operations.map(o=>({submissionId:o.submissionId,participantId:o.participantId})))]);
 await store.save(plan);assert.equal(await store.claim({...x.s,planId:plan.planId}),true);
 await assert.rejects(store.insertPermits({...x.s,plan:{...plan,operations:[...plan.operations,plan.operations[0]]}}),/PLAN_CHANGED/);
 assert.deepEqual(await store.insertPermits({...x.s,plan}),{inserted:count});
 assert.equal((await x.db.query('select count(*)::integer n from vdj_internal.generation_permits')).rows[0].n,count);
 await store.record({...x.s,planId:plan.planId,phase:'STARTED'});
 await assert.rejects(store.save({...plan,planId:'second-five-person-plan'}),/EXISTING_TRIAL/);
});
test('actual private SQL CAS persists one 2->3 admission across fresh factories and denies fourth/multiple first starts',async t=>{
 const x=await setup(t),a=x.store();await a.save(x.plan('plan-two'));const other=x.store();assert.equal((await other.active(x.s)).participants,2);
 const claims=await Promise.allSettled([a.claim({...x.s,planId:'plan-two'}),other.claim({...x.s,planId:'plan-two'})]);assert.equal(claims.filter(c=>c.status==='fulfilled'&&c.value===true).length,1);
 await a.record({...x.s,planId:'plan-two',phase:'STARTED'});await assert.rejects(other.save(x.plan('new-two')),/EXISTING_TRIAL/);
 await other.save(x.plan('plan-three',3,'plan-two'));assert.equal(await a.claim({...x.s,planId:'plan-three'}),true);await a.record({...x.s,planId:'plan-three',phase:'STARTED'});
 await assert.rejects(x.store().save(x.plan('fourth',3,'plan-two')),/EXISTING_TRIAL/);assert.equal((await x.store().active(x.s)).participants,3);
 const acl=(await x.db.query("select has_function_privilege('anon','vdj_internal.owner_operator_state(text,uuid,text,uuid,bigint,bigint,jsonb)','EXECUTE') value")).rows[0].value;assert.equal(acl,false);
});
test('private plan metadata rejects credentials and provider URLs before write, stale control cannot resume admission',async t=>{
 const x=await setup(t),store=x.store();await assert.rejects(store.save({...x.plan('unsafe'),endpoint:'https://example.invalid/opaque'}),/SAFE_STATE_REQUIRED/);
 await store.save(x.plan('safe'));await x.db.query('update vdj_internal.rooms set control_revision=control_revision+1 where id=$1',[x.s.roomId]);
 await assert.rejects(store.read({...x.s,planId:'safe'}),/SCOPE_CHANGED/);
});
test('claimed permits use the bounded production writer and reject changed participant, frozen source and stale stored scope',async t=>{
 const x=await setup(t),expiresAtMs=Date.now()+300000,plan={...x.plan('trial-'+ 't'.repeat(24)),connectionId:'connection-'+ 'c'.repeat(24)};
 plan.operations=plan.operations.map((o,i)=>({...o,operationId:'operation-'+String(i).repeat(24),permitId:'permit-'+String(i).repeat(24),
  permit:{...o.permit,permitId:'permit-'+String(i).repeat(24),sourceSha256:plan.sourceSha256,source:{music:{clipId:'synthetic-seed'}},connectionId:plan.connectionId,expiresAtMs}}));
 await x.db.query('update vdj_internal.rooms set submissions=$2::jsonb where id=$1',[x.s.roomId,JSON.stringify(plan.operations.map(o=>({submissionId:o.submissionId,participantId:o.participantId})))]);
 const statements=[],port=createProductionRepository({enabled:true,roomId:x.s.roomId,projectURL:'https://example.supabase.co',
 createPool:policy=>({options:policy,on(){},end:async()=>{},connect:async()=>({release(){},query:async q=>{statements.push(q.text);return x.db.query(q.text,q.values);}})})});t.after(()=>port.close());
 const store=createOperatorPlanStore({query:port.privateStateQuery,withOwnerAuthorization:(s,fn)=>fn({...s,ownerCapability:owner})});
 await store.save(plan);assert.equal(await store.claim({...x.s,planId:plan.planId}),true);
 const insert=p=>x.db.query(OPERATOR_PERMITS_SQL,[x.s.roomId,owner,x.s.sessionId,x.s.controlRevision,plan.planId,JSON.stringify(p)]);
 const changed=structuredClone(plan);changed.operations[0].participantId=plan.operations[1].participantId;
 await assert.rejects(insert(changed),/PLAN_CHANGED/);
 const source=structuredClone(plan);source.operations[0].permit.source.music.clipId='changed-seed';await assert.rejects(insert(source),/PLAN_CHANGED/);
 assert.equal((await x.db.query('select count(*)::integer n from vdj_internal.generation_permits')).rows[0].n,0);
 assert.deepEqual(await store.insertPermits({...x.s,plan}),{inserted:2});
 assert.equal((await x.db.query('select count(*)::integer n from vdj_internal.generation_permits')).rows[0].n,2);
 assert(statements.includes('BEGIN TRANSACTION READ WRITE'));assert(statements.includes(OPERATOR_PERMITS_SQL));
 await x.db.query('update vdj_internal.rooms set control_revision=control_revision+1 where id=$1',[x.s.roomId]);
 const fresh={...plan,controlRevision:x.s.controlRevision+1};
 await assert.rejects(x.db.query(OPERATOR_PERMITS_SQL,[x.s.roomId,owner,x.s.sessionId,fresh.controlRevision,plan.planId,JSON.stringify(fresh)]),/PLAN_CHANGED/);
 assert.equal((await x.db.query("select has_function_privilege('anon','vdj_internal.owner_operator_permits(uuid,text,uuid,bigint,text,jsonb)','EXECUTE') value")).rows[0].value,false);
});

test('durable consent refresh retains accepted IDs/fences and rejects UNKNOWN, Stop, budget or source changes',async t=>{
 const x=await setup(t),clock=Date.now(),store=x.store();
 const plan={...x.plan('trial-'+ 'r'.repeat(24)),phase:'STARTED',expiresAtMs:clock-1000,connectionId:'existing-connection',infrastructureMaximumUsd:1.5,
  recovery:{unknownIntentReserveCents:4,totalGenerationReservationCents:104,thirdParticipantExcluded:true}};
 plan.operations=plan.operations.map((o,i)=>({...o,operationId:'operation-'+String(i).repeat(24),permitId:'permit-'+String(i).repeat(24),
  permit:{...o.permit,permitId:'permit-'+String(i).repeat(24),sourceSha256:plan.sourceSha256,source:{music:{clipId:'unchanged-source'}},connectionId:plan.connectionId,createdAtMs:clock-60000,expiresAtMs:clock-1000}}));
 plan.executionAuthorization={kind:'room-budget-execution-consent-v1',...x.s,planId:plan.planId,expiresAtMs:null,revoked:false,
  approvedAtMs:clock-1000,generationMaximumCents:150,infrastructureMaximumCents:150,unknownReserveCents:4,totalReservationCents:104,operationIds:plan.operations.map(o=>o.operationId)};
 const record={...x.s,plans:{[plan.planId]:plan},active:{planId:plan.planId,phase:'STARTED',participants:2}};
 await x.db.query("update vdj_internal.rooms set operations=jsonb_set(operations,'{__owner_operator_v1}',$2::jsonb) where id=$1",[x.s.roomId,JSON.stringify({version:1,...x.s,record})]);
 const stages={intent:{state:'SUBMITTED',requestId:'known-existing-request',signature:'b'.repeat(64)}};
 for(const o of plan.operations){await x.db.query('insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document) values($1,$2,$3,0,to_timestamp($4),$5::jsonb)',[o.permitId,x.s.roomId,x.s.sessionId,(clock-1000)/1000,JSON.stringify(o.permit)]);
  await x.db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',[o.operationId,o.permitId,x.s.roomId,JSON.stringify({operationId:o.operationId,permit:o.permit,stages,stopped:false,scheduler:{terminal:true,fence:3,attempt:3,leaseUntilMs:0}})]);}
 const fresh={...structuredClone(plan),expiresAtMs:clock+300000};
 for(const o of fresh.operations)Object.assign(o.permit,{expiresAtMs:fresh.expiresAtMs,createdAtMs:clock,quote:{verified:true},balance:{usd:100},assets:{context:{url:'https://synthetic.invalid/private'}}});
 const send=p=>store.insertPermits({...x.s,plan:p});
 for(const mutate of [p=>p.maximumCents=150,p=>p.operations[0].permit.source.music.clipId='changed',p=>p.operations[0].operationId=p.operations[1].operationId,p=>p.executionAuthorization.unknownReserveCents=0]){
  const bad=structuredClone(fresh);mutate(bad);await assert.rejects(send(bad),/HOLD|CHANGED/);
 }
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stopped}','true'::jsonb) where id=$1",[plan.operations[0].operationId]);
 await assert.rejects(send(fresh),/CHANGED/);
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stopped}','false'::jsonb) where id=$1",[plan.operations[0].operationId]);
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stages,intent,state}','\"UNKNOWN\"'::jsonb) where id=$1",[plan.operations[0].operationId]);
 await assert.rejects(send(fresh),/CHANGED/);
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stages,intent,state}','\"SUBMITTED\"'::jsonb) where id=$1",[plan.operations[0].operationId]);
 assert.equal((await send(fresh)).inserted,2);
 const rows=(await x.db.query('select document from vdj_internal.generation_operations order by id')).rows;
 for(const {document:d} of rows){assert.deepEqual(d.stages,stages);assert.equal(d.scheduler.fence,3);assert.equal(d.scheduler.attempt,3);assert.equal(d.scheduler.terminal,false);assert.equal(d.permit.expiresAtMs,fresh.expiresAtMs);}

 // A completed immutable sibling does not block fresh evidence for the pending one.
 const doneId=plan.operations[1].operationId,donePermitId=plan.operations[1].permitId;
 const doneStages=Object.fromEntries(['intent','music','video'].map(k=>[k,{state:'COMPLETE',requestId:'known-'+k}]));
 const doneCue={status:'READY',atomicReady:true,operationId:doneId,roomId:x.s.roomId,submissionId:plan.operations[1].submissionId,
  cueId:'synthetic-completed-cue',commonIntentSha256:'e'.repeat(64),evidenceSha256:'f'.repeat(64),
  sourceSha256:plan.sourceSha256,generationId:'synthetic-generation',controlVersion:2,mode:'provider',actualGenerationThisRun:true};
 for(const channel of ['music','video'])doneCue[channel]={qc:{passed:true},actualGenerationThisRun:true,binding:{channel,
  ...Object.fromEntries(['roomId','submissionId','generationId','commonIntentSha256','controlVersion'].map(k=>[k,doneCue[k]]))}};
 await x.db.query("update vdj_internal.generation_operations set document=document || $2::jsonb where id=$1",[doneId,JSON.stringify({
  stages:doneStages,cue:doneCue,submissionId:doneCue.submissionId,plan:{commonIntentSha256:doneCue.commonIntentSha256,common:{cueId:doneCue.cueId}},scheduler:{terminal:true,fence:3,attempt:3,leaseUntilMs:0}})]);
 const beforeDone=(await x.db.query('select document from vdj_internal.generation_operations where id=$1',[doneId])).rows[0].document;
 const beforePermit=(await x.db.query('select document,expires_at from vdj_internal.generation_permits where id=$1',[donePermitId])).rows[0];
 const newer={...structuredClone(fresh),expiresAtMs:clock+600000};for(const o of newer.operations)o.permit.expiresAtMs=newer.expiresAtMs;
 assert.equal((await send(newer)).inserted,2);
 assert.deepEqual((await x.db.query('select document from vdj_internal.generation_operations where id=$1',[doneId])).rows[0].document,beforeDone);
 assert.deepEqual((await x.db.query('select document,expires_at from vdj_internal.generation_permits where id=$1',[donePermitId])).rows[0],beforePermit);
 assert.equal((await x.db.query('select document from vdj_internal.generation_operations where id=$1',[plan.operations[0].operationId])).rows[0].document.permit.expiresAtMs,newer.expiresAtMs);
 const afterPlan=await store.active(x.s);assert.equal(afterPlan.operations[1].permit.expiresAtMs,fresh.expiresAtMs);
 assert.equal(afterPlan.operations[0].permit.expiresAtMs,newer.expiresAtMs);
 for(const patch of [{atomicReady:false},{evidenceSha256:'invalid'},{operationId:'different'}, {music:{qc:{passed:false}}}]){
  await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{cue}',$2::jsonb) where id=$1",[doneId,JSON.stringify({...doneCue,...patch})]);
  await assert.rejects(send({...newer}),/COMPLETED_CUE_CHANGED/);
 }
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{cue}',$2::jsonb) where id=$1",[doneId,JSON.stringify(doneCue)]);
 const active=await store.active(x.s);assert.equal(active.executionAuthorization.expiresAtMs,null);assert.equal(active.executionAuthorization.unknownReserveCents,4);
 assert.equal(JSON.stringify(active).includes('https://'),false);
 assert.equal((await x.db.query("select has_function_privilege('anon','vdj_internal.owner_operator_permits(uuid,text,uuid,bigint,text,jsonb)','EXECUTE') value")).rows[0].value,false);
});
