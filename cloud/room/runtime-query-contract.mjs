import {EXISTING_REPOSITORY_SELECTS as selects,RECOVERY_CANDIDATE_SELECT,PLAYER_OBSERVER_SQL,OPERATOR_STATE_SQL,OPERATOR_PERMITS_SQL,DURABLE_SCHEDULER_SQL} from '../jobs/repository-statements.mjs';

const fail=()=>{throw Error('RUNTIME_QUERY_REQUIRED');};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const json=(v,observerCas=false)=>{if(v===null)return null;let x;try{x=JSON.parse(v);}catch{fail();}
 const transient=observerCas&&object(x?.__observationFence),record=transient?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='__observationFence')):x;
 if(!object(x)||new TextEncoder().encode(v).length>(transient?131072:65536)||new TextEncoder().encode(JSON.stringify(record)).length>65536)fail();return x;};
export const RUNTIME_STATEMENTS=Object.freeze({...selects,candidates:RECOVERY_CANDIDATE_SELECT,
 observer:PLAYER_OBSERVER_SQL,operator:OPERATOR_STATE_SQL,permits:OPERATOR_PERMITS_SQL,scheduler:DURABLE_SCHEDULER_SQL});
const writes=new Set(['observer','operator','permits','scheduler']);
export function validateRuntimeCommand(command){
 if(!object(command)||Object.keys(command).length!==2||!Object.hasOwn(command,'statementId')||!Array.isArray(command.args))fail();
 const k=command.statementId,a=command.args;if(!Object.hasOwn(RUNTIME_STATEMENTS,k))fail();
 const size=new TextEncoder().encode(JSON.stringify(command)).length;if(size>131072)fail();
 if(['scope','runtime'].includes(k)){if(a.length)fail();}
 else if(k==='attachments'){if(a.length!==1||!Array.isArray(a[0])||a[0].length>100||a[0].some(x=>!id(x))||new Set(a[0]).size!==a[0].length)fail();}
 else if(['operation','permit'].includes(k)){if(a.length!==1||!id(a[0])||a[0].length<20)fail();}
 else if(k==='candidates'){if(a.length!==5||!uuid(a[0])||!integer(a[1])||!integer(a[2])||a[3]!==null&&!id(a[3])||!integer(a[4])||a[4]<1||a[4]>21)fail();}
 else if(['observer','operator'].includes(k)){
  const receipt=k==='observer'&&['sourceReceiptRead','sourceReceiptPut'].includes(a[0]);
  if(a.length!==5||!['read','cas'].includes(a[0])&&!receipt||!uuid(a[1])||!integer(a[2])||
   (receipt?a[3]!==null||!object(a[4]):a[0]==='read'?a[3]!==null||a[4]!==null:!integer(a[3])||!object(a[4])))fail();
  if(a[4]!==null)json(JSON.stringify(a[4]),k==='observer'&&a[0]==='cas');
 }else if(k==='permits'){if(a.length!==4||!uuid(a[0])||!integer(a[1])||!id(a[2])||a[2].length<20||!object(a[3]))fail();}
 else if(k==='scheduler'){
  if(a.length!==2||!['enqueue','claim','assert','renew','finish'].includes(a[0])||!object(a[1]))fail();
  const p=a[1],keys=['sessionId','controlRevision',...(a[0]==='enqueue'?['operationId']:a[0]==='claim'?['workerId','leaseMs']:
   ['workerId','operationId','fence',...(a[0]==='renew'?['leaseMs']:a[0]==='finish'?['outcome']:[])])];
  if(Object.keys(p).length!==keys.length||Object.keys(p).some(x=>!keys.includes(x))||!uuid(p.sessionId)||!integer(p.controlRevision)||
   a[0]!=='enqueue'&&(!id(p.workerId)||p.workerId.length<20)||a[0]!=='claim'&&(!id(p.operationId)||p.operationId.length<20)||
   ['assert','renew','finish'].includes(a[0])&&(!integer(p.fence)||p.fence<1)||
   ['claim','renew'].includes(a[0])&&(!integer(p.leaseMs)||p.leaseMs<1000||p.leaseMs>30000)||
   a[0]==='finish'&&!['retry','complete','hold'].includes(p.outcome))fail();
 }
 return structuredClone(command);
}
// Native SQL remains an internal constant. No SQL text or owner proof travels
// in JSON; the Edge receives a fixed operation ID and separately authenticated header.
export function compileRuntimeQuery({statement,values,roomId,ownerCapability,writable=false}){
 if(!uuid(roomId)||!Array.isArray(values))fail();const statementId=Object.keys(RUNTIME_STATEMENTS).find(k=>RUNTIME_STATEMENTS[k]===statement);
 if(!statementId||writes.has(statementId)!==writable)fail();let args;
 if(['scope','runtime'].includes(statementId)){if(values.length!==1||values[0]!==roomId)fail();args=[];}
 else if(statementId==='attachments'){if(values.length!==2||values[0]!==roomId)fail();args=[values[1]];}
 else if(['operation','permit'].includes(statementId)){if(values.length!==2||values[1]!==roomId)fail();args=[values[0]];}
 else if(statementId==='candidates'){if(values.length!==6||values[0]!==roomId)fail();args=values.slice(1);}
 else if(['observer','operator'].includes(statementId)){if(values.length!==7||values[1]!==roomId||values[2]!==ownerCapability)fail();args=[values[0],values[3],values[4],values[5],json(values[6],statementId==='observer'&&values[0]==='cas')];}
 else if(statementId==='permits'){if(values.length!==6||values[0]!==roomId||values[1]!==ownerCapability)fail();args=[values[2],values[3],values[4],json(values[5])];}
 else {if(values.length!==4||values[1]!==roomId||values[2]!==ownerCapability)fail();args=[values[0],json(values[3])];}
 return validateRuntimeCommand({statementId,args});
}
