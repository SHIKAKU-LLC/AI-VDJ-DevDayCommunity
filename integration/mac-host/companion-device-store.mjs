import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {digestRuntimeBytes} from '../../cloud/room/runtime-request-proof.mjs';
export const COMPANION_KEYCHAIN_ITEM=Object.freeze({service:'AI VDJ Companion Registration',account:'owner-companion-v1'});
const fail=()=>{throw Error('COMPANION_REGISTRATION_HOLD');};
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const canonical=v=>JSON.stringify(Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])));
// No IO on construction. Only public registration metadata and signatures
// leave the helper; the Ed25519 value stays in the existing macOS Keychain.
export function createMacCompanionDeviceStore({enabled=false,helperPath,helperSha256,invoke,signal}={}){
  let closed=false;const pending=new Set();
  async function native(action,input){
    if(!enabled||closed||signal?.aborted)fail();
    if(invoke)return invoke(action,input); // synthetic/native dependency only
    if(process.platform!=='darwin'||!path.isAbsolute(helperPath??'')||!/^[a-f0-9]{64}$/.test(helperSha256??''))fail();
    let file;
    try{file=await open(helperPath,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await file.stat();
      if(!stat.isFile()||stat.size>10*1024*1024||stat.mode&0o022||!(stat.mode&0o111))fail();
      if(await digestRuntimeBytes(new Uint8Array(await file.readFile()))!==helperSha256)fail();
    }catch{fail();}finally{await file?.close();}
    if(closed||signal?.aborted)fail();
    return new Promise((resolve,reject)=>{
      const child=spawn(helperPath,[action],{stdio:['pipe','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}});
      pending.add(child);const chunks=[];let length=0,done=false;
      const finish=ok=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(child);
        if(!ok)child.kill('SIGTERM');const bytes=Buffer.concat(chunks,length);for(const c of chunks)c.fill(0);
        try{if(!ok||closed||signal?.aborted)fail();resolve(JSON.parse(bytes.toString('utf8')));}catch{reject(Error('COMPANION_REGISTRATION_HOLD'));}
        finally{bytes.fill(0);}};
      const abort=()=>finish(false),timer=setTimeout(abort,10000);signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{if(done){chunk.fill(0);return;}length+=chunk.length;if(length>8192){chunk.fill(0);finish(false);}else chunks.push(chunk);});
      child.on('error',abort);child.stdin.on('error',abort);child.on('close',code=>finish(code===0));
      child.stdin.end(JSON.stringify(input));if(signal?.aborted)abort();
    });
  }
  async function checked(value,roomId){
    if(value?.registered===false&&Object.keys(value).length===1)return null;
    if(!value||Object.keys(value).sort().join(',')!=='approved,approvedAtMs,publicJwk,revoked,roomIds,workerId'||
      value.approved!==true||value.revoked!==false||!/^device-[a-f0-9-]{36}$/.test(value.workerId)||
      !Number.isSafeInteger(value.approvedAtMs)||!Array.isArray(value.roomIds)||value.roomIds.length<1||value.roomIds.length>8||
      value.roomIds.some(v=>!uuid(v))||!value.roomIds.includes(roomId)||new Set(value.roomIds).size!==value.roomIds.length)fail();
    const jwk=value.publicJwk;
    if(Object.keys(jwk??{}).sort().join(',')!=='alg,crv,ext,key_ops,kty,x'||jwk.alg!=='Ed25519'||jwk.crv!=='Ed25519'||
      jwk.kty!=='OKP'||jwk.ext!==true||JSON.stringify(jwk.key_ops)!=='["verify"]'||!/^[A-Za-z0-9_-]{43}$/.test(jwk.x??''))fail();
    return {...structuredClone(value),publicKeySha256:await digestRuntimeBytes(new TextEncoder().encode(canonical(jwk)))};
  }
  const read=async roomId=>{if(!uuid(roomId))fail();return checked(await native('read',{roomId}),roomId);};
  return Object.freeze({read,
    async save(roomId){if(!uuid(roomId))fail();return checked(await native('enroll',{roomId}),roomId);},
    async remove(roomId){if(!uuid(roomId))fail();const r=await native('remove',{roomId});if(r?.removed!==true||Object.keys(r).length!==1)fail();},
    async identity(roomId){const record=await read(roomId);if(!record)fail();
      return Object.freeze({...record,async sign(payload){
        if(!(payload instanceof Uint8Array)||payload.length>2048)fail();
        const result=await native('sign',{roomId,payload:Buffer.from(payload).toString('base64')});
        if(Object.keys(result??{}).join(',')!=='signature'||!/^[A-Za-z0-9_-]{86}$/.test(result.signature??''))fail();
        return new Uint8Array(Buffer.from(result.signature,'base64url'));
      }});},
    close(){closed=true;for(const child of pending)child.kill('SIGTERM');},
  });
}
