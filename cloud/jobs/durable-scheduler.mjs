import {DispatchError} from '../generation/dispatch.mjs';
const fail=code=>{throw new DispatchError(code);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{20,100}$/.test(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const scope=s=>({roomId:s.roomId,['sessionId']:s.sessionId,controlRevision:s.controlRevision});
const equal=(a,b)=>a?.roomId===b?.roomId&&Object.is(a?.sessionId,b?.sessionId)&&a?.controlRevision===b?.controlRevision;
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&[null,Object.prototype].includes(Object.getPrototypeOf(x));
export {DURABLE_SCHEDULER_SQL} from './repository-statements.mjs';
import {DURABLE_SCHEDULER_SQL} from './repository-statements.mjs';
const TRANSIENT_RECOVERY=new Set(['RECOVERY_EXECUTION_HOLD','RECOVERY_QUERY_HOLD']);
const actions=new Set(['enqueue','claim','assert','renew','finish']);
const known=new Set(['SCHEDULER_INPUT_REQUIRED','SCHEDULER_SCOPE_HOLD','SCHEDULER_OWNER_HOLD',
 'SCHEDULER_LEASE_HOLD','SCHEDULER_FENCE_HOLD','SCHEDULER_OPERATION_HOLD']);
const safe=e=>known.has(e?.message)?e.message:'SCHEDULER_EXECUTION_HOLD';
export function createDurableSchedulerRepository({enabled=false,query}={}) {
 if(typeof query!=='function'||typeof enabled!=='boolean')fail('SCHEDULER_PORTS_REQUIRED');
 return Object.freeze({async request(action,input){
  if(!enabled)fail('SCHEDULER_NOT_ACTIVATED');
  if(!actions.has(action)||!plain(input)||Object.keys(input).some(k=>!['roomId','ownerCapability','payload'].includes(k))||
   !uuid(input.roomId)||!/^[a-f0-9]{64}$/.test(input.ownerCapability??'')||!plain(input.payload))fail('SCHEDULER_INPUT_REQUIRED');
  const p=input.payload,allowed=['sessionId','controlRevision',...(action==='enqueue'?['operationId']:
   action==='claim'?['workerId','leaseMs']:['workerId','operationId','fence',...(action==='renew'?['leaseMs']:action==='finish'?['outcome']:[])])];
  if(Object.keys(p).some(k=>!allowed.includes(k))||Object.keys(p).length!==allowed.length||!uuid(p.sessionId)||!integer(p.controlRevision)||
   action!=='enqueue'&&!id(p.workerId)||action!=='claim'&&!id(p.operationId)||
   ['assert','renew','finish'].includes(action)&&(!integer(p.fence)||p.fence<1)||
   ['claim','renew'].includes(action)&&(!integer(p.leaseMs)||p.leaseMs<1000||p.leaseMs>30000)||
   action==='finish'&&!['retry','complete','hold'].includes(p.outcome))fail('SCHEDULER_INPUT_REQUIRED');
  try {
   const result=await query(DURABLE_SCHEDULER_SQL,[action,input.roomId,input.ownerCapability,JSON.stringify(p)]);
   if(result?.rows?.length!==1||!Object.hasOwn(result.rows[0],'value'))fail('SCHEDULER_INPUT_REQUIRED');
   return structuredClone(result.rows[0].value);
  } catch(e){throw new DispatchError(safe(e));}
 }});
}

/** Private bounded worker loop. Does not register a timer until explicit start().
 * Database time/fence governs authority; timer/abort alone never proves a lease.
 * executeClaim MUST bind assertClaim into its registered authorityGuard on each
 * dispatch/QC boundary. Root host composition provides that context binding.
 */
export function createDurableCloudScheduler({enabled=false,repository,readScope,withOwnerAuthorization,
 executeClaim,workerId,leaseMs=30000,heartbeatMs=5000,intervalMs=1000,idleIntervalMs=Math.max(5000,intervalMs),
 scheduleWake=setTimeout,cancelWake=clearTimeout,now=Date.now,onDiagnostic=()=>{}}={}) {
 if(!repository?.request||typeof readScope!=='function'||typeof withOwnerAuthorization!=='function'||
  typeof executeClaim!=='function'||!id(workerId)||!integer(leaseMs)||leaseMs<1000||leaseMs>30000||
  !integer(heartbeatMs)||heartbeatMs<100||heartbeatMs>=leaseMs/2||!integer(intervalMs)||intervalMs<100||intervalMs>30000||
  !integer(idleIntervalMs)||idleIntervalMs<intervalMs||idleIntervalMs>30000||typeof scheduleWake!=='function'||typeof cancelWake!=='function')
  fail('SCHEDULER_PORTS_REQUIRED');
 let closed=false,running=null,timer=null,loopScope=null;const controllers=new Set();
 const diagnose=(event,operationId,code)=>{try{onDiagnostic({event,reason:operationId+':'+(/^[A-Z][A-Z0-9_]{0,99}$/.test(code??'')?code:'EXECUTION_HOLD')});}catch{}};
 const active=()=>{if(enabled!==true)fail('SCHEDULER_NOT_ACTIVATED');if(closed)fail('SCHEDULER_CLOSED');};
 function validate(s){if(!plain(s)||Object.keys(s).length!==3||!uuid(s.roomId)||!uuid(s.sessionId)||!integer(s.controlRevision))fail('SCHEDULER_INPUT_REQUIRED');}
 async function facts(s){active();const fresh=await readScope({roomId:s.roomId});
  if(!equal(s,fresh)||fresh.closed||!Number.isSafeInteger(now())||fresh.expiresAtMs<=now())fail('SCHEDULER_SCOPE_HOLD');}
 async function owner(s,callback){
  let used=false,finished=false,pending,invalid=false;
  try {await withOwnerAuthorization(Object.freeze({...s}),ctx=>{
   if(used||finished){invalid=true;fail('SCHEDULER_OWNER_HOLD');}used=true;
   if(!plain(ctx)||!equal(ctx,s)||!/^[a-f0-9]{64}$/.test(ctx.ownerCapability??''))fail('SCHEDULER_OWNER_HOLD');
   pending=Promise.resolve().then(()=>{if(invalid||finished)fail('SCHEDULER_OWNER_HOLD');return callback(ctx.ownerCapability);});
   pending.catch(()=>{});return pending;
  });if(!used||!pending||invalid)fail('SCHEDULER_OWNER_HOLD');const value=await pending;
   if(invalid)fail('SCHEDULER_OWNER_HOLD');return value;
  }catch(e){invalid=true;if(pending)await pending.catch(()=>{});throw new DispatchError(safe(e));}
  finally{finished=true;}
 }
 async function request(s,action,p){await facts(s);return owner(s,ownerCapability=>repository.request(action,
  {roomId:s.roomId,ownerCapability,payload:{['sessionId']:s.sessionId,controlRevision:s.controlRevision,...p}}));}
 function verifyClaim(c,s){if(!plain(c)||Object.keys(c).length!==9||Object.keys(c).some(k=>!['roomId','sessionId','controlRevision','operationId','permitId','workerId','fence','attempt','leaseUntilMs'].includes(k))||!equal(c,s)||!id(c.operationId)||!id(c.permitId)||c.workerId!==workerId||
  !integer(c.fence)||c.fence<1||!integer(c.attempt)||c.attempt<1||!Number.isFinite(Number(c.leaseUntilMs))||Number(c.leaseUntilMs)<=now())fail('SCHEDULER_FENCE_HOLD');}
 async function work(s){
  const claim=await request(s,'claim',{workerId,leaseMs});if(claim===null)return {...s,status:'IDLE'};
  verifyClaim(claim,s);Object.freeze(claim);const controller=new AbortController();controllers.add(controller);
  let live=true,heartbeat=null,renewing=null;
  const base={workerId,operationId:claim.operationId,fence:claim.fence};
  const check=()=>{if(!live||controller.signal.aborted||closed)fail('SCHEDULER_FENCE_HOLD');};
  async function assertClaim(){check();const fresh=await request(s,'assert',base);check();verifyClaim(fresh,s);
   if(fresh.fence!==claim.fence||fresh.operationId!==claim.operationId)fail('SCHEDULER_FENCE_HOLD');return true;}
  const pulse=()=>{heartbeat=setTimeout(()=>{
   renewing=(async()=>{check();const renewed=await request(s,'renew',{...base,leaseMs});check();verifyClaim(renewed,s);
    if(renewed.fence!==claim.fence||renewed.operationId!==claim.operationId)fail('SCHEDULER_FENCE_HOLD');})()
    .then(()=>{if(live&&!controller.signal.aborted)pulse();},()=>controller.abort()).finally(()=>{renewing=null;});
  },heartbeatMs);};
  const scanIds=async input=>{await assertClaim();if(!equal(input,s)||input.limit!==1||input.afterOperationId!==undefined)fail('SCHEDULER_INPUT_REQUIRED');
   return {candidates:[{...s,operationId:claim.operationId,permitId:claim.permitId}],hasMore:false,nextCursor:null};};
  try {
   await assertClaim();pulse();const result=await executeClaim({claim,scanIds,assertClaim,signal:controller.signal});
   check();await assertClaim();
   const state=result?.results?.[0]?.state??result?.state,reason=result?.results?.[0]?.reason??null;
   if(reason)diagnose('SCHEDULER_JOB_HOLD',claim.operationId,reason);
   // A caught transient step (network/repository outage) is retried with the
   // ledger's backoff; only definitive operation/authority states are terminal.
   const transient=TRANSIENT_RECOVERY.has(reason);
   const outcome=['READY','PLAYING'].includes(state)?'complete':transient?'retry':reason||['HOLD','STOPPED','NEEDS_CLARIFICATION'].includes(state)?'hold':'retry';
   await request(s,'finish',{...base,outcome});return {...s,operationId:claim.operationId,status:outcome==='retry'?'WAIT':'DONE',outcome};
  }catch(e){controller.abort();diagnose('SCHEDULER_CLAIM_HOLD',claim.operationId,safe(e));return {...s,operationId:claim.operationId,status:'HOLD',reason:safe(e)};}
  finally{live=false;clearTimeout(heartbeat);controller.abort();await renewing?.catch(()=>{});controllers.delete(controller);}
 }
 function runOnce(s){active();validate(s);if(running)fail('SCHEDULER_BUSY');
  running=work(Object.freeze({...s})).finally(()=>{running=null;});return running;}
 function next(delay=intervalMs){if(!loopScope||closed)return;timer=scheduleWake(async()=>{timer=null;
  let wait=idleIntervalMs;
  try {const result=await runOnce(loopScope);if(!['IDLE','HOLD'].includes(result.status))wait=intervalMs;}
  catch{}finally{next(wait);}},delay);}
 return Object.freeze({runOnce,
  async enqueue(input){active();const {operationId,...s}=input??{};validate(s);if(!id(operationId))fail('SCHEDULER_INPUT_REQUIRED');
   const result=await request(s,'enqueue',{operationId});
   // An idle host spends no authority cache: the next wake checks afresh.
   // Explicit enqueue wakes it immediately, while active lease heartbeats and
   // every dispatch/Stop/fence check retain their existing cadence and guards.
   if(loopScope&&equal(loopScope,s)&&!running){cancelWake(timer);timer=null;next(0);}return result;},
  start(s){active();validate(s);if(loopScope)fail('SCHEDULER_BUSY');loopScope=Object.freeze({...s});next();},
  async stop(){loopScope=null;cancelWake(timer);timer=null;for(const c of controllers)c.abort();await running?.catch(()=>{});},
  async close(){closed=true;loopScope=null;cancelWake(timer);for(const c of controllers)c.abort();await running?.catch(()=>{});},
  capabilities:()=>({defaultActivation:false,durableScheduler:enabled&&!closed,createsOperations:false,createsPermits:false,
   newStageInitialSubmitUnderExistingPermit:true,repostsUnknownOrReserved:false,liveRuntimeVerified:false})});
}
