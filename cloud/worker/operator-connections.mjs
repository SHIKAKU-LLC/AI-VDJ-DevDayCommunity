import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {adapterFail as fail,adapterGuard} from './operator-adapter-error.mjs';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const fields=s=>Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,s[k]]));
const same=(a,b)=>cueDigest(fields(a))===cueDigest(fields(b));
const key=k=>typeof k==='string'&&k.length>=8&&k.length<=4096&&k.trim()===k&&!/[\r\n]/.test(k);
// Custodian is explicitly injected. No storage backend, secret relocation,
// enrollment, environment discovery or in-process key cache is selected here.
export function resolveOperatorConnectionBinding({scope,plan,priorPlan,operationId,now=Date.now}={}){
 const admitted=p=>p&&same(p,scope)&&['CLAIMED','STARTED','UNKNOWN'].includes(p.phase)&&p.expiresAtMs>now()&&Array.isArray(p.operations);
 if(!admitted(plan))fail('OPERATOR_OPERATION_CONNECTION_CHANGED');
 const plans=[plan];if(plan.participants===3&&plan.priorPlanId){if(!admitted(priorPlan)||priorPlan.planId!==plan.priorPlanId||priorPlan.participants!==2)fail('OPERATOR_OPERATION_CONNECTION_CHANGED');plans.push(priorPlan);}
 const matches=plans.flatMap(p=>p.operations.filter(o=>o.operationId===operationId).map(o=>({p,o})));
 if(matches.length!==1||!id(matches[0].p.connectionId)||matches[0].o.permit?.connectionId!==matches[0].p.connectionId)fail('OPERATOR_OPERATION_CONNECTION_CHANGED');
 return {...fields(scope),kind:'operator-plan-connection-binding-v1',operationId,connectionId:matches[0].p.connectionId};
}
// Historical receipt lookup is deliberately a different binding kind. It does
// not satisfy forOperation() or make an expired financial permit dispatchable.
export function resolveOperatorResultConnectionBinding({scope,plan,operationId}={}){
 if(!plan||!same(plan,scope)||!['CLAIMED','STARTED','UNKNOWN'].includes(plan.phase)||
  !Array.isArray(plan.operations))fail('OPERATOR_RESULT_CONNECTION_CHANGED');
 const matches=plan.operations.filter(o=>o.operationId===operationId);
 if(matches.length!==1||!id(plan.connectionId)||matches[0].permit?.connectionId!==plan.connectionId)
  fail('OPERATOR_RESULT_CONNECTION_CHANGED');
 return {...fields(scope),kind:'operator-result-connection-binding-v1',operationId,connectionId:plan.connectionId};
}
export function createOperatorConnections({enabled=false,platform,custodian,readScope,readConnectionBinding,now=Date.now,timeoutMs=8000}={}){
 if(typeof enabled!=='boolean'||!Number.isSafeInteger(timeoutMs)||timeoutMs<5||timeoutMs>8000)fail('OPERATOR_CONNECTION_CONFIGURATION_REQUIRED');
 let closed=false;
 const pending=new Set();
 async function bounded(fn){const c=new AbortController();pending.add(c);let timer;const expired=new Promise((_,reject)=>{
  c.signal.addEventListener('abort',()=>reject(Error()),{once:true});timer=setTimeout(()=>c.abort(),timeoutMs);});
  const task=Promise.resolve().then(()=>fn(c.signal));task.catch(()=>{});
  try{return await adapterGuard(()=>Promise.race([task,expired]),'OPERATOR_CREDENTIAL_CONTEXT_REQUIRED');}
  finally{clearTimeout(timer);c.abort();pending.delete(c);}}
 const active=()=>{if(!enabled||closed)fail('OPERATOR_CONNECTION_NOT_CONFIGURED');};
 async function scope(input){active();if(typeof readScope!=='function')fail('OPERATOR_CONNECTION_PORTS_REQUIRED');const s=await readScope({roomId:input.roomId});
  if(!same(s,input)||s.expiresAtMs<=now())fail('OPERATOR_SCOPE_CHANGED');return s;}
 function metadata(c,s){if(!c||!same(c,s)||!id(c.connectionId)||c.verified!==true||!Number.isSafeInteger(c.expiresAtMs)||c.expiresAtMs<=now()||c.expiresAtMs>s.expiresAtMs)fail('OPERATOR_CONNECTION_REQUIRED');
  return {...fields(s),connectionId:c.connectionId,verified:true,expiresAtMs:c.expiresAtMs};}
 async function read(input){const s=await scope(input);if(typeof custodian?.read!=='function')fail('OPERATOR_CONNECTION_PORTS_REQUIRED');const result=metadata(await bounded(signal=>custodian.read({...fields(s),connectionId:input.connectionId,signal})),s);await scope(input);return result;}
 async function withCredential(input,invoke){const c=await read(input);if(typeof custodian?.withCredential!=='function'||typeof invoke!=='function')fail('OPERATOR_CONNECTION_PORTS_REQUIRED');
  let calls=0,done=false,task,invalid=false;try{
   await bounded(signal=>custodian.withCredential({...c,signal},value=>{if(done||closed||signal.aborted||++calls!==1){invalid=true;fail('OPERATOR_CREDENTIAL_CONTEXT_REQUIRED');}if(!key(value))fail('OPERATOR_CREDENTIAL_CONTEXT_REQUIRED');
    task=Promise.resolve().then(()=>invoke(value,signal));task.catch(()=>{});return task;}));
   if(calls!==1||invalid||!task)fail('OPERATOR_CREDENTIAL_CONTEXT_REQUIRED');const result=await task;if(invalid)fail('OPERATOR_CREDENTIAL_CONTEXT_REQUIRED');await read(input);return result;
  }finally{done=true;}
 }
 const port={async connect(input){const s=await scope(input);if(!key(input.credential)||!platform?.verifyCredential||typeof custodian?.accept!=='function')fail('OPERATOR_CONNECTION_PORTS_REQUIRED');
  try{const verified=await platform.verifyCredential(input.credential);if(verified?.authenticated!==true)fail('OPERATOR_CONNECTION_REQUIRED');await scope(input);
   const c=metadata(await bounded(signal=>custodian.accept({...fields(s),credential:input.credential,expiresAtMs:s.expiresAtMs,verification:verified,signal})),s);await scope(input);return c;
  }finally{input.credential='';}},read,
  async readActive(input){const s=await scope(input);if(typeof custodian?.readActive!=='function')return null;const c=await bounded(signal=>custodian.readActive({...fields(s),signal}));await scope(input);return c?metadata(c,s):null;},withCredential,
  async forOperation(input){await scope(input);if(typeof readConnectionBinding!=='function')fail('OPERATOR_CONNECTION_PORTS_REQUIRED');
   const op=await readConnectionBinding({roomId:input.roomId,operationId:input.operationId});
   if(!same(op,input)||op?.kind!=='operator-plan-connection-binding-v1'||op.operationId!==input.operationId||op.connectionId!==input.connectionId)fail('OPERATOR_OPERATION_CONNECTION_CHANGED');
   return withCredential(input,value=>value);
  },close(){closed=true;for(const c of pending)c.abort();},capabilities:()=>({enabled:enabled&&!closed,ready:enabled&&!closed&&
    ['accept','read','withCredential'].every(k=>typeof custodian?.[k]==='function')&&typeof readScope==='function'&&typeof readConnectionBinding==='function',secretStorageSelected:false,credentialCache:false})};
 return Object.freeze({...port,...Object.fromEntries(['connect','read','readActive','withCredential','forOperation'].map(name=>[name,(...args)=>adapterGuard(()=>port[name](...args),'OPERATOR_CONNECTION_HOLD')]))});
}
