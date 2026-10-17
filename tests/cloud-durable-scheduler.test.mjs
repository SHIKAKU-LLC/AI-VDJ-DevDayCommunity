import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createDurableSchedulerRepository,createDurableCloudScheduler,DURABLE_SCHEDULER_SQL} from '../cloud/jobs/durable-scheduler.mjs';
const cap='a'.repeat(64),invite='b'.repeat(64),worker='worker-'.padEnd(30,'w'),worker2='worker-'.padEnd(30,'x');
const uid='11111111-1111-4111-a111-111111111111',opid='operation-'.padEnd(30,'a'),permit='permit-'.padEnd(30,'p');
async function fixture(t){const db=new PGlite();t.after(()=>db.close());
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const f of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql','cloud/jobs/durable-scheduler.sql'])
  await db.exec(await readFile(new URL('../'+f,import.meta.url),'utf8'));
 await db.query('insert into vdj_internal.owners(uid)values($1)',[uid]);
 const room=(await db.query('select public.vdj_room_request($1,null,null,$2::jsonb,$3) value',
  ['create',JSON.stringify({ownerCapability:cap,joinCode:invite}),uid])).rows[0].value;
 const r=(await db.query('select id,epoch,control_revision from vdj_internal.rooms where id=$1',[room.roomId])).rows[0];
 const s={roomId:r.id,['sessionId']:r.epoch,controlRevision:Number(r.control_revision)};
 await db.query('update vdj_internal.rooms set submissions=$2::jsonb where id=$1',[s.roomId,JSON.stringify([{submissionId:'guest-submission'}])]);
 await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
 values($1,$2,$3,$4,now()+interval '10 minutes',$5)`,[permit,s.roomId,s.sessionId,s.controlRevision,JSON.stringify({permitId:permit})]);
 const document={operationId:opid,submissionId:'guest-submission',permit:{permitId:permit},stopped:false,
 stages:{intent:{state:'SUBMITTED',requestId:'saved-request',signature:'c'.repeat(64)}}};
 await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document)values($1,$2,$3,$4)',
  [opid,permit,s.roomId,JSON.stringify(document)]);
 const repository=createDurableSchedulerRepository({enabled:true,query:(q,p)=>db.query(q,p)});
 const call=(action,p={},owner=cap)=>repository.request(action,{roomId:s.roomId,ownerCapability:owner,
  payload:{['sessionId']:s.sessionId,controlRevision:s.controlRevision,...p}});
 const claim=(w=worker)=>call('claim',{workerId:w,leaseMs:30000});
 const ref=c=>({workerId:c.workerId,operationId:c.operationId,fence:c.fence});
 const expire=()=>db.query(`update vdj_internal.generation_operations set document=jsonb_set(document,'{scheduler,leaseUntilMs}','0') where id=$1`,[opid]);
 return {db,s,repository,call,claim,ref,expire,document};}

test('actual private SQL persists fence/due state across new host, single holder and stale completion denied',async t=>{
 const x=await fixture(t),a=await x.claim();assert.equal(a.operationId,opid);assert.equal(a.fence,1);
 assert.equal(await x.claim(worker2),null);await x.call('assert',x.ref(a));
 const renewed=await x.call('renew',{...x.ref(a),leaseMs:1000});assert.equal(renewed.fence,1);
 await x.expire();await assert.rejects(x.call('renew',{...x.ref(a),leaseMs:1000}),/FENCE_HOLD/);
 const b=await x.claim(worker2);assert.equal(b.fence,2);
 await assert.rejects(x.call('finish',{...x.ref(a),outcome:'complete'}),/FENCE_HOLD/);
 await x.call('finish',{...x.ref(b),outcome:'retry'});assert.equal(await x.claim(),null);
 const ledger=(await x.db.query("select document->'scheduler' ledger from vdj_internal.generation_operations where id=$1",[opid])).rows[0].ledger;
 assert.equal(ledger.attempt,2);assert.equal(ledger.terminal,false);assert.equal(ledger.leaseUntilMs,0);
 const repo2=createDurableSchedulerRepository({enabled:true,query:(q,p)=>x.db.query(q,p)});
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{scheduler,dueAtMs}','0') where id=$1",[opid]);
 await assert.rejects(repo2.request('claim',{roomId:x.s.roomId,ownerCapability:cap,
 payload:{...x.s,workerId:worker,leaseMs:1000}}),/INPUT_REQUIRED/,'strict payload refuses extraneous room ID');
 const d=await x.claim();assert.equal(d.fence,3);assert.equal(d.attempt,3);
});

test('Stop, revoked/expired permits, owner/control changes, ambiguous stage and UNKNOWN cannot claim/renew',async t=>{
 const x=await fixture(t);await assert.rejects(x.claim('bad'),/INPUT_REQUIRED/);
 await assert.rejects(x.call('claim',{workerId:worker,leaseMs:30000},'d'.repeat(64)),/OWNER_HOLD/);
 const a=await x.claim();
 await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stopped}','true') where id=$1",[opid]);
 await assert.rejects(x.call('renew',{...x.ref(a),leaseMs:1000}),/OPERATION_HOLD/);await x.expire();assert.equal(await x.claim(),null);
 await x.db.query('update vdj_internal.generation_operations set document=$2 where id=$1',[opid,JSON.stringify({...x.document,
 stages:{intent:{state:'UNKNOWN',requestId:'saved-request',signature:'c'.repeat(64)}}})]);assert.equal(await x.claim(),null);
 await x.db.query('update vdj_internal.generation_operations set document=$2 where id=$1',[opid,JSON.stringify(x.document)]);
 await x.db.query('update vdj_internal.generation_permits set revoked=true where id=$1',[permit]);assert.equal(await x.claim(),null);
 await x.db.query("update vdj_internal.generation_permits set revoked=false,expires_at=now()-interval '1 second' where id=$1",[permit]);assert.equal(await x.claim(),null);
 await x.db.query('update vdj_internal.rooms set control_revision=control_revision+1 where id=$1',[x.s.roomId]);
 await assert.rejects(x.claim(),/SCOPE_HOLD/);
});

test('private invoker RPC adds no table or role grants and bounds lease at permit expiry',async t=>{
 const x=await fixture(t);
 const acl=(await x.db.query("select proacl::text acl,prosecdef from pg_proc where proname='vdj_scheduler_request'")).rows[0];
 assert.equal(acl.prosecdef,false);assert(!acl.acl.includes('service_role'));assert(!acl.acl.includes('anon'));
 await x.db.query("update vdj_internal.generation_permits set expires_at=now()+interval '2 seconds' where id=$1",[permit]);
 const a=await x.claim();assert(a.leaseUntilMs-Date.now()<2200);assert(a.leaseUntilMs>Date.now());
 await x.call('enqueue',{operationId:opid});assert.equal(await x.claim(worker2),null,'wake does not steal a live lease');
 const source=await readFile(new URL('../cloud/jobs/durable-scheduler.sql',import.meta.url),'utf8');
 assert(source.includes('for update skip locked'));assert(!/\bgrant\b/i.test(source.replace(/^--.*$/gm,'')));
});

test('runtime default-off has zero IO; finite claim enforces selected ID and heartbeat renews same fence',async t=>{
 const x=await fixture(t),readScope=async()=>({...x.s,expiresAtMs:Date.now()+60000}),withOwnerAuthorization=(s,fn)=>fn({...s,ownerCapability:cap});
 let executions=0,checks=0;
 const executeClaim=async ({scanIds,assertClaim,signal})=>{executions++;assert(!signal.aborted);await assertClaim();checks++;
 const page=await scanIds({...x.s,limit:1});assert.equal(page.candidates[0].operationId,opid);
 await assert.rejects(scanIds({...x.s,limit:2}),/INPUT_REQUIRED/);await new Promise(r=>setTimeout(r,240));
 await assertClaim();return {results:[{state:'PENDING',reason:null}]};};
 const options={repository:x.repository,readScope,withOwnerAuthorization,executeClaim,workerId:worker,leaseMs:1000,heartbeatMs:100};
 const off=createDurableCloudScheduler(options);assert.throws(()=>off.runOnce(x.s),/NOT_ACTIVATED/);assert.equal(executions,0);
 const scheduler=createDurableCloudScheduler({...options,enabled:true});t.after(()=>scheduler.close());
 const result=await scheduler.runOnce(x.s);assert.equal(result.outcome,'retry');assert.equal(executions,1);assert.equal(checks,1);
 assert.equal((await scheduler.runOnce(x.s)).status,'IDLE');assert(DURABLE_SCHEDULER_SQL.includes('vdj_internal.'));
});

test('late owner callbacks cannot perform an RPC and lease failure aborts execution context',async t=>{
 const x=await fixture(t);let retained,sql=0;
 const opts={enabled:true,repository:{request:async()=>{sql++;return null;}},readScope:async()=>({...x.s,expiresAtMs:Date.now()+60000}),
 withOwnerAuthorization:async(s,fn)=>{retained=()=>fn({...s,ownerCapability:cap});},executeClaim:async()=>{},workerId:worker};
 const scheduler=createDurableCloudScheduler(opts);await assert.rejects(scheduler.runOnce(x.s),/OWNER_HOLD/);
 assert.throws(retained,/OWNER_HOLD/);assert.equal(sql,0);await scheduler.close();
});

 test('lost renewal aborts old execution, forbids completion, and persistent finite attempt exhaustion holds',async t=>{
 const x=await fixture(t);let asserted=false;
 const scheduler=createDurableCloudScheduler({enabled:true,repository:x.repository,workerId:worker,leaseMs:1000,heartbeatMs:100,
 readScope:async()=>({...x.s,expiresAtMs:Date.now()+60000}),withOwnerAuthorization:(s,f)=>f({...s,ownerCapability:cap}),
 executeClaim:async({assertClaim,signal})=>{await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{stopped}','true') where id=$1",[opid]);
 await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));assert(signal.aborted);
 await assert.rejects(assertClaim(),/FENCE_HOLD/);asserted=true;return {state:'READY'};}});
 t.after(()=>scheduler.close());const outcome=await scheduler.runOnce(x.s);assert.equal(outcome.status,'HOLD');assert(asserted);
 const ledger=(await x.db.query("select document->'scheduler' ledger from vdj_internal.generation_operations where id=$1",[opid])).rows[0].ledger;
 assert.equal(ledger.fence,1);assert(ledger.leaseUntilMs>0,'lost holder cannot falsely complete');
 await x.db.query("update vdj_internal.generation_operations set document=$2 where id=$1",[opid,JSON.stringify({...x.document,
 scheduler:{attempt:64,fence:64,leaseUntilMs:0,dueAtMs:0,terminal:false}})]);assert.equal(await x.claim(),null);
 });

test('background job holds are observable with bounded codes and never expose adapter error text',async t=>{
 const x=await fixture(t),events=[];
 const make=reason=>createDurableCloudScheduler({enabled:true,repository:x.repository,workerId:worker,
  readScope:async()=>({...x.s,expiresAtMs:Date.now()+60000}),withOwnerAuthorization:(s,fn)=>fn({...s,ownerCapability:cap}),
  onDiagnostic:e=>events.push(e),executeClaim:async()=>({results:[{state:'HOLD',reason}]})});
 const scheduler=make('DISPATCH_AUTHORITY_SOURCE_CHANGED');t.after(()=>scheduler.close());
 assert.equal((await scheduler.runOnce(x.s)).outcome,'hold');
 assert.deepEqual(events,[{event:'SCHEDULER_JOB_HOLD',reason:opid+':DISPATCH_AUTHORITY_SOURCE_CHANGED'}]);
 await x.db.query('update vdj_internal.generation_operations set document=$2 where id=$1',[opid,JSON.stringify(x.document)]);
 const raw=make('untrusted adapter detail');t.after(()=>raw.close());assert.equal((await raw.runOnce(x.s)).outcome,'hold');
 assert.equal(events.at(-1).reason,opid+':EXECUTION_HOLD');
 // A caught transient recovery step (network/repository outage) is retried, not terminal.
 await x.db.query('update vdj_internal.generation_operations set document=$2 where id=$1',[opid,JSON.stringify(x.document)]);
 const transient=make('RECOVERY_EXECUTION_HOLD');t.after(()=>transient.close());
 const retried=await transient.runOnce(x.s);assert.equal(retried.outcome,'retry');assert.equal(retried.status,'WAIT');
});

test('idle claim polling backs off without caching authority; explicit enqueue wakes immediately and fresh scope still holds',async()=>{
 const s={roomId:uid,['sessionId']:uid,controlRevision:0};let control=0,reads=0,claims=0;
 const timers=new Set(),scheduleWake=(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer;},cancelWake=t=>timers.delete(t);
 const scheduler=createDurableCloudScheduler({enabled:true,workerId:worker,
  scheduleWake,cancelWake,readScope:async()=>{reads++;return {...s,controlRevision:control,expiresAtMs:Date.now()+60000};},
  withOwnerAuthorization:(scope,fn)=>fn({...scope,ownerCapability:cap}),
  repository:{request:async(action)=>{if(action==='claim')claims++;return action==='claim'?null:{enqueued:true};}},
  executeClaim:async()=>assert.fail('no eligible lease cannot execute')});
 const wake=async()=>{assert.equal(timers.size,1);const t=[...timers][0];timers.delete(t);await t.fn();};
 try{
  scheduler.start(s);assert.equal([...timers][0].ms,1000);await wake();
  assert.equal([...timers][0].ms,5000);assert.equal(claims,1);
  await scheduler.enqueue({...s,operationId:opid});assert.equal([...timers][0].ms,0);
  await wake();assert.equal(claims,2);assert.equal([...timers][0].ms,5000);
  const before=reads;control=1;await wake();assert(reads>before);assert.equal(claims,2,'fresh changed scope blocks even an idle claim');
  assert.equal([...timers][0].ms,5000);await scheduler.stop();assert.equal(timers.size,0);
 }finally{await scheduler.close();}
});
