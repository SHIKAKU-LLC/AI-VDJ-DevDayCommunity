import {createHash} from 'node:crypto';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw Error('PLAYBACK_ASSET_SNAPSHOT_REQUIRED');};
// Immutable bytes only. This store grants no owner, room, graph, reservation or
// playback authority. Its callers still perform their fresh mutable checks.
// Generation/admission must retain the original physical store.
export function createPlaybackAssetSnapshots({assetStore,maximumBytes=128*1024*1024}={}){
 if(!['read','save','verifySaved'].every(key=>typeof assetStore?.[key]==='function')||
   !Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>128*1024*1024)fail();
 const values=new Map(),pending=new Map();let bytes=0,closed=false;
 const active=()=>{if(closed)fail();};
 const drop=id=>{const value=values.get(id);if(value){bytes-=value.byteLength;value.bytes.fill(0);values.delete(id);}};
 function copy(record){
  active();if(!(record?.bytes instanceof Uint8Array)||record.byteLength!==record.bytes.length||
    record.byteLength<1||record.byteLength>32*1024*1024||sha(record.bytes)!==record.sha256)fail();
  return structuredClone(record);
 }
 async function load(id,optional=false){
  active();if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))fail();if(values.has(id))return copy(values.get(id));
  if(pending.has(id)){const value=await pending.get(id);return value?copy(value):null;}
  const work=(async()=>{
   const value=await (optional?(assetStore.readOptional??assetStore.read):assetStore.read).call(assetStore,id);
   active();if(value==null&&optional)return null;
   const record=copy(value);if(record.assetId!==id)fail();
   const proof=await assetStore.verifySaved({binding:record.binding,asset:{assetId:id,sha256:record.sha256}});active();
   if(proof?.privateSaved!==true||proof.checksumVerified!==true||proof.assetId!==id||proof.sha256!==record.sha256||
     cueDigest(proof.binding)!==cueDigest(record.binding))fail();
   if(record.byteLength<=maximumBytes){
    while(values.size>=32||bytes+record.byteLength>maximumBytes)drop(values.keys().next().value);
    values.set(id,record);bytes+=record.byteLength;
   }
   return record;
  })();pending.set(id,work);
  try{const value=await work;return value?copy(value):null;}finally{pending.delete(id);}
 }
 return Object.freeze({read:id=>load(id),readOptional:id=>load(id,true),
  async verifySaved(input){const record=await load(input.asset.assetId);
   if(record.sha256!==input.asset.sha256||cueDigest(record.binding)!==cueDigest(input.binding))fail();
   return {privateSaved:true,checksumVerified:true,assetId:record.assetId,sha256:record.sha256,binding:structuredClone(record.binding)};},
  async save(input){active();drop(input.id);return assetStore.save(input);},
  close(){closed=true;for(const id of values.keys())drop(id);},
 });
}
