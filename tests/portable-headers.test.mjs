import test from 'node:test';
import assert from 'node:assert/strict';
import {createExplicitFalClient} from '../snapshot/app/runtime/fal-sdk.mjs';
import {createAuthenticatedByokTab} from '../snapshot/app/runtime/authenticated-tab.mjs';
test('storage request constructs a dynamic header from explicit test input and refuses retries',async()=>{
 let calls=0;const client=createExplicitFalClient({credentials:'synthetic-placeholder',fetchImpl:async(url,init)=>{calls++;assert.equal(init.headers.get('Authorization'),'Key synthetic-placeholder');assert.equal(init.headers.get('Content-Type'),'application/json');return{ok:true,json:async()=>({file_url:'https://fixture.fal.media/result',upload_url:'https://fixture.fal.media/upload'})};}});
 const input={file_name:'fixture.wav',content_type:'audio/wav',size:44};await client.storageInitiate(input);await assert.rejects(client.storageInitiate(input),e=>e.code==='SDK_RETRY_REFUSED');assert.equal(calls,1);
});
test('optional login header preserves request headers and forget disables access',async()=>{
 let calls=0;const tab=createAuthenticatedByokTab({credentials:'synthetic-placeholder',loginToken:'synthetic-token',origin:'https://studio.example.test',lifecycle:null,fetchImpl:async(url,init)=>{calls++;assert.equal(url,'/api/fal/proxy');assert.equal(init.headers.get('Authorization'),'Bearer synthetic-token');assert.equal(init.headers.get('Content-Type'),'application/json');return{ok:true,json:async()=>({ok:true})};}});
 await tab.metadata({operation:'jobs-list'});tab.forget();await assert.rejects(tab.metadata({operation:'jobs-list'}));assert.equal(calls,1);
});
