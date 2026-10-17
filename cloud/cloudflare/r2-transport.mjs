import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
const mimeTypes=['audio/wav','video/mp4','image/png','image/jpeg','application/json'];
const limit=32*1024*1024;
const fail=()=>{throw Error('R2_PRIVATE_STORAGE_HOLD');};
// Worker binding only: no public bucket URL, account key or S3 credential.
// Provider delivery must be mounted separately with bounded server grants.
export function createR2RoomTransport({bucket,roomId,privateBucketApproved=false}={}){
 if(!bucket?.get||!bucket?.put||!bucket?.head||privateBucketApproved!==true||typeof roomId!=='string')fail();
 const prefix='rooms/'+cueDigest(roomId);let closed=false;
 function check(input){
  if(closed||input?.signal?.aborted||input?.bucket!=='ai-vdj-private'||typeof input.path!=='string'||
   !input.path.startsWith(prefix+'/')||
   !/^(?:assets\/[A-Za-z0-9_-]{1,100}\.(?:media|json)|(?:sources|receipts|source-start-receipts)\/[A-Za-z0-9_-]{1,100}\.json)$/.test(input.path.slice(prefix.length+1)))fail();
 }
 return Object.freeze({
  async describeBucket(input){if(closed||input?.bucket!=='ai-vdj-private')fail();
   return {id:'ai-vdj-private',public:false,fileSizeLimit:limit,allowedMimeTypes:[...mimeTypes]};},
  async readObject(input){check(input);if(!Number.isSafeInteger(input.maximumBytes)||input.maximumBytes<1||input.maximumBytes>limit)fail();
   const value=await bucket.get(input.path);if(!value)return null;
   if(value.size<1||value.size>input.maximumBytes||!mimeTypes.includes(value.httpMetadata?.contentType)){await value.body?.cancel();fail();}
   if(input.signal?.aborted){await value.body?.cancel();fail();}
   return {body:value.body,contentType:value.httpMetadata.contentType,contentLength:value.size};},
  async putObjectIfAbsent(input){check(input);
   if(input.upsert!==false||!(input.bytes instanceof Uint8Array)||input.bytes.length<1||input.bytes.length>limit||!mimeTypes.includes(input.contentType))fail();
   const result=await bucket.put(input.path,input.bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:input.contentType}});
   return {created:result!==null};},
  async signObject(){throw Error('R2_PROVIDER_DELIVERY_NOT_CONNECTED');},
  close(){closed=true;},
 });
}
