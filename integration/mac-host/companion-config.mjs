import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const COMPANION_PROJECT_URL='https://sbrghwehlkptbnbxhymu.supabase.co';
export const COMPANION_ORIGIN='https://ai-vdj.vercel.app';
const fail=()=>{throw Error('COMPANION_NATIVE_CONFIGURATION_REQUIRED');};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
export function privateCompanionPath(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value||value.includes('\0'))fail();
  const relative=path.relative(fileURLToPath(new URL('../..',import.meta.url)),value);
  if(!relative||relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))fail();return value;
}
export async function readPrivateCompanionJson(file){let handle;
  try{handle=await open(privateCompanionPath(file),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();
    if(!stat.isFile()||stat.size>8192||stat.size<2||(stat.mode&0o777)!==0o600||typeof process.getuid==='function'&&stat.uid!==process.getuid())fail();
    return JSON.parse(await handle.readFile('utf8'));
  }catch{fail();}finally{await handle?.close();}
}
export function parseCompanionConfiguration(value){
  const extra=Object.hasOwn(value??{},'implementationRoomNoExpiryApproved')?['implementationRoomNoExpiryApproved']:[];
  if(extra.length&&value.implementationRoomNoExpiryApproved!==true)fail();
  if(!exact(value,['version','approved','roomId','projectURL','cloudOrigin','deviceRegistrationApproved','providerUseApproved','mediaUploadApproved',...extra,
    'helperPath','helperSha256','registrationFile','operationalApprovalFile'])||value.version!=='owner-companion-v1'||value.approved!==true||
    !/^[a-f0-9-]{36}$/i.test(value.roomId??'')||value.projectURL!==COMPANION_PROJECT_URL||value.cloudOrigin!==COMPANION_ORIGIN||
    value.deviceRegistrationApproved!==true||typeof value.providerUseApproved!=='boolean'||typeof value.mediaUploadApproved!=='boolean'||!/^[a-f0-9]{64}$/.test(value.helperSha256??''))fail();
  for(const key of ['helperPath','registrationFile','operationalApprovalFile'])privateCompanionPath(value[key]);
  if(new Set([value.helperPath,value.registrationFile,value.operationalApprovalFile]).size!==3)fail();
  return Object.freeze(structuredClone(value));
}
export async function readCompanionConfiguration(file){return parseCompanionConfiguration(await readPrivateCompanionJson(file));}
