import {randomUUID} from 'node:crypto';
const same=(a,b)=>['roomId','sessionId','controlRevision'].every(k=>a?.[k]===b?.[k]);
// The server's secret resolver is never reachable through HTTP. Each use is
// bounded to the current room revision and the independently approved deadline.
export function createServerCredentialCustodian({readCredential,readScope,platform,expiresAtMs,now=Date.now}={}){
 let closed=false,record=null;
 const fail=()=>{throw Error('SERVER_CREDENTIAL_HOLD');};
 async function current(input){if(closed||now()>=expiresAtMs)fail();const s=await readScope({roomId:input.roomId});
  if(!same(s,input)||s.expiresAtMs<=now())fail();return s;}
 async function use(input,invoke){await current(input);let value;
  try{value=await readCredential();if(typeof value!=='string'||value.length<8||value.length>4096||/[\r\n]/.test(value)||value.trim()!==value)fail();
   const result=await invoke(value);await current(input);return result;
  }catch{fail();}finally{value='';}}
 async function read(input){await current(input);if(!record||!same(record,input)||input.connectionId!==record.connectionId||record.expiresAtMs<=now())fail();return {...record};}
 return Object.freeze({async accept(){fail();},read,
  async readActive(input){const s=await current(input);if(record&&same(record,s))return read({...input,connectionId:record.connectionId});
   if((await use(input,key=>platform.verifyCredential(key)))?.authenticated!==true)fail();
   const {sessionId}=s;
   record={roomId:s.roomId,sessionId,controlRevision:s.controlRevision,connectionId:'server-'+randomUUID(),verified:true,expiresAtMs:Math.min(expiresAtMs,s.expiresAtMs)};
   return {...record};},
  async withCredential(input,invoke){await read(input);return use(input,invoke);},close(){closed=true;record=null;}});
}
