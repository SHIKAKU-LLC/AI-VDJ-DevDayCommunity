// In-memory private object transport. Never calls Supabase or reads credentials.
import assert from 'node:assert/strict';
import {PRIVATE_BUCKET_TARGET} from '../cloud/worker/supabase-private-store.mjs';
export function syntheticStorageTransport() {
  const objects=new Map(),calls=[];
  const config={id:PRIVATE_BUCKET_TARGET,public:false,fileSizeLimit:32*1024*1024,
    allowedMimeTypes:['audio/wav','video/mp4','image/png','image/jpeg','application/json']};
  const transport={
    async describeBucket(input){calls.push({action:'describe',...input});return structuredClone(config);},
    async readObject({bucket,path,maximumBytes,signal}){
      calls.push({action:'read',bucket,path,maximumBytes});assert(signal instanceof AbortSignal);
      const object=objects.get(path);if(!object)return null;
      const bytes=Buffer.from(object.bytes);
      return {contentType:object.contentType,contentLength:bytes.length,
        body:new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=65536)controller.enqueue(bytes.subarray(i,i+65536));controller.close();}})};
    },
    async putObjectIfAbsent({bucket,path,bytes,contentType,upsert}){
      calls.push({action:'put',bucket,path,byteLength:bytes.length,contentType,upsert});assert.equal(upsert,false);
      if(!objects.has(path))objects.set(path,{bytes:Buffer.from(bytes),contentType});
    },
  };
  return {objects,calls,config,transport};
}
