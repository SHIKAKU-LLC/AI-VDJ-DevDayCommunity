export {OPERATOR_STATE_SQL} from './repository-statements.mjs';
import {OPERATOR_STATE_SQL} from './repository-statements.mjs';
export {OPERATOR_PERMITS_SQL} from './repository-statements.mjs';
import {OPERATOR_PERMITS_SQL} from './repository-statements.mjs';
const fail=c=>{throw Object.assign(Error(c),{code:c});};
const scope=s=>Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,s[k]]));
export function createOperatorPlanStore({query,withOwnerAuthorization}={}){
 if(typeof query!=='function'||typeof withOwnerAuthorization!=='function')fail('OPERATOR_STORE_REQUIRED');
 async function request(s,action,version=null,record=null){return withOwnerAuthorization(scope(s),async context=>{
 const r=await query(OPERATOR_STATE_SQL,[action,s.roomId,context.ownerCapability,s.sessionId,s.controlRevision,version,record?JSON.stringify(record):null]);
 if(r?.rows?.length!==1||!Number.isSafeInteger(r.rows[0].value?.version))fail('OPERATOR_STORE_HOLD');return r.rows[0].value;});}
 async function read(s){const value=await request(s,'read');return {...value,record:value.record??{...scope(s),plans:{},active:null}};}
 async function change(s,transform){const previous=await read(s),record=transform(structuredClone(previous.record));
 if(Buffer.byteLength(JSON.stringify(record))>65536||/https?:\/\/|"(?:credential|authorization|password|apiKey|ownerCapability)"\s*:/i.test(JSON.stringify(record)))fail('OPERATOR_SAFE_STATE_REQUIRED');
 await request(s,'cas',previous.version,record);return record;}
 return Object.freeze({durable:true,
 async save(plan){await change(plan,r=>{
 if(r.active&&r.active.phase!=='REVIEW'&&!(plan.participants===3&&r.active.participants===2&&r.active.phase==='STARTED'&&r.active.planId===plan.priorPlanId))fail('OPERATOR_EXISTING_TRIAL');
 const selected=plan.operations.map(o=>o.participantId);if(new Set(selected).size!==selected.length)fail('OPERATOR_TRIAL_REQUIRED');
 if(plan.participants===3){const prior=r.plans[plan.priorPlanId];if(!prior||prior.phase!=='STARTED'||prior.participants!==2||plan.maximumCents!==150||plan.operations.length!==1||prior.operations.some(o=>selected.includes(o.participantId)))fail('OPERATOR_TWO_PERSON_FIRST');}
 else if(![1,2,5].includes(plan.participants)||plan.priorPlanId!==null||plan.operations.length!==plan.participants||plan.maximumCents!==plan.participants*50)fail('OPERATOR_TRIAL_REQUIRED');
 if(r.active?.phase==='REVIEW')delete r.plans[r.active.planId];r.plans[plan.planId]=structuredClone(plan);r.active={planId:plan.planId,participants:plan.participants,phase:'REVIEW'};return r;});},
 async read(s){const r=(await read(s)).record,p=r.plans[s.planId];if(!p)fail('OPERATOR_PLAN_CHANGED');return structuredClone(p);},
 async active(s){const r=(await read(s)).record;return r.active?structuredClone(r.plans[r.active.planId]):null;},
 async claim(s){try{await change(s,r=>{const p=r.plans[s.planId];if(!p||p.phase!=='REVIEW'||r.active?.planId!==s.planId)fail('OPERATOR_PLAN_ALREADY_CLAIMED');
 p.phase='CLAIMED';r.active.phase='CLAIMED';return r;});return true;}catch(e){if(e.code==='OPERATOR_PLAN_ALREADY_CLAIMED')return false;throw e;}},
 async record(s){await change(s,r=>{const p=r.plans[s.planId];if(!p||p.phase!=='CLAIMED'||!['STARTED','UNKNOWN'].includes(s.phase))fail('OPERATOR_PLAN_CHANGED');p.phase=s.phase;r.active.phase=s.phase;return r;});},
 async insertPermits({plan,...s}){return withOwnerAuthorization(scope(s),async context=>{
 const r=await query(OPERATOR_PERMITS_SQL,[s.roomId,context.ownerCapability,s.sessionId,s.controlRevision,plan.planId,JSON.stringify(plan)]);
 if(r?.rows?.length!==1||r.rows[0].value?.inserted!==plan.operations.length)fail('OPERATOR_STORE_HOLD');return r.rows[0].value;});}
 });
}
