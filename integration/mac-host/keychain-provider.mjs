import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
export const APPROVED_KEYCHAIN_ITEM=Object.freeze({service:'fal.ai API (AI VDJ)',account:'hapx2yuki'});
const fail=()=>{throw Error('KEYCHAIN_PROVIDER_HOLD');};
const fields=s=>Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,s[k]]));
const same=(a,b)=>['roomId','sessionId','controlRevision'].every(k=>a?.[k]===b?.[k]);
// Not called on import/construction. stdout is consumed inside this native
// process only; stderr is suppressed, no shell, clipboard, log or key printout.
async function readExactItem({signal,timeoutMs=8000}){
 if(process.platform!=='darwin')fail();return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/security',['find-generic-password','-s',APPROVED_KEYCHAIN_ITEM.service,'-a',APPROVED_KEYCHAIN_ITEM.account,'-w'],
   {stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});
  const chunks=[];let size=0,finished=false;const abort=()=>finish(false),timer=setTimeout(abort,timeoutMs);
  function finish(ok){if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
   if(!ok)child.kill('SIGTERM');const bytes=Buffer.concat(chunks,size);for(const chunk of chunks)chunk.fill(0);
   if(ok)resolve(bytes);else{bytes.fill(0);reject(Error('KEYCHAIN_PROVIDER_HOLD'));}}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout.on('data',chunk=>{if(finished){chunk.fill(0);return;}size+=chunk.length;if(size>8192){chunk.fill(0);finish(false);}else chunks.push(chunk);});
  child.on('error',()=>finish(false));child.on('close',code=>finish(code===0&&size>0));
 });
}
/** Prepared exact-item internal use. Approval covers native process -> fal
 * only, current room scope and <=30min. No actual Keychain call in fixtures.
 */
export function createScopedKeychainProvider({enabled=false,approval,readScope,readItem=readExactItem,now=Date.now,timeoutMs=30000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<5||timeoutMs>30000)fail();
 let closed=false;const pending=new Set();async function scope(input){
  if(!enabled||closed||typeof readScope!=='function'||approval?.approved!==true||approval.service!==APPROVED_KEYCHAIN_ITEM.service||
   approval.account!==APPROVED_KEYCHAIN_ITEM.account||
   approval.policy!==undefined&&approval.policy!=='owner-companion-v1'||approval.process!=='ai-vdj-native-node'||approval.recipient!=='fal-fixed-generation-and-platform'||
   !Number.isSafeInteger(approval.approvedAtMs)||!Number.isSafeInteger(approval.expiresAtMs)||
   approval.expiresAtMs>approval.approvedAtMs+(approval.policy==='owner-companion-v1'?14400000:1800000)||now()<approval.approvedAtMs||now()>=approval.expiresAtMs||!same(approval,input))fail();
  const latest=await readScope({roomId:input.roomId});if(!same(latest,input)||latest.expiresAtMs<approval.expiresAtMs||latest.expiresAtMs<=now())fail();return latest;
 }
 return Object.freeze({async withCredential(input,invoke){let bytes,value,finished=false,phase='SCOPE';
  const controller=new AbortController();pending.add(controller);const abort=()=>controller.abort();input.signal?.addEventListener('abort',abort,{once:true});
  if(input.signal?.aborted)controller.abort();let timer;
  const stopped=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error()),{once:true});
   if(controller.signal.aborted)reject(Error());timer=setTimeout(abort,timeoutMs);});stopped.catch(()=>{});
  const check=()=>{if(finished||closed||controller.signal.aborted)fail();};
  try{const task=(async()=>{check();await scope(input);check();if(typeof invoke!=='function')fail();phase='READ';bytes=await readItem({signal:controller.signal,timeoutMs:Math.min(timeoutMs,8000)});
   if(finished||closed||controller.signal.aborted){bytes?.fill?.(0);fail();}
   if(!(bytes instanceof Uint8Array)||bytes.length>8192)fail();value=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\n$/,'');
   if(value.length<8||value.length>4096||value.trim()!==value||/[\r\n]/.test(value))fail();phase='VERIFY_SCOPE';await scope(input);check();
   phase='CALL';const result=await invoke(value);phase='FINAL_SCOPE';await scope(input);check();return result;
  })();task.catch(()=>{});return await Promise.race([task,stopped]);
  }catch(error){throw new Error('KEYCHAIN_PROVIDER_HOLD',{cause:new Error('KEYCHAIN_'+phase+'_HOLD',{cause:error})});}finally{finished=true;clearTimeout(timer);controller.abort();pending.delete(controller);input.signal?.removeEventListener('abort',abort);bytes?.fill?.(0);value=undefined;}},
 close(){closed=true;for(const c of pending)c.abort();},capabilities:()=>({enabled:enabled&&!closed,exactItem:APPROVED_KEYCHAIN_ITEM,
  secretCache:false,newSecretStorage:false,maximumSessionMs:1800000})});
}
// Integrates the existing connection/price/dispatcher ports without manual key
// re-entry. Caches verification metadata only; each use re-reads the exact item.
export function createKeychainOperatorCustodian({enabled=false,keychain,platform,readScope,expiresAtMs,runtimeExpiresAtMs,connectionId,now=Date.now}={}){
 if(runtimeExpiresAtMs!==undefined)expiresAtMs=Math.min(expiresAtMs,runtimeExpiresAtMs-30000);
 if(connectionId!==undefined&&!/^[A-Za-z0-9_-]{1,100}$/.test(connectionId))fail();
 let record=null,closed=false;
 async function scope(input){if(!enabled||closed)fail();const s=await readScope({roomId:input.roomId});
  if(!same(s,input)||now()>=expiresAtMs||expiresAtMs>s.expiresAtMs)fail();return s;}
 async function read(input){const s=await scope(input);if(!record||!same(record,s)||record.connectionId!==input.connectionId)fail();return {...record};}
 return Object.freeze({async accept(){fail();},read,
  async readActive(input){const s=await scope(input);if(record)return read({...input,connectionId:record.connectionId});
   const verified=await keychain.withCredential(input,key=>platform.verifyCredential(key));if(verified?.authenticated!==true)fail();await scope(input);
   record={...fields(s),connectionId:connectionId??'connection-'+randomUUID(),verified:true,expiresAtMs};return {...record};},
  async withCredential(input,invoke){await read(input);return keychain.withCredential(input,invoke);},
  close(){closed=true;record=null;keychain.close();},capabilities:()=>({enabled:enabled&&!closed,credentialCache:false})});
}
