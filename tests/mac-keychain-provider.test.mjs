import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopedKeychainProvider,createKeychainOperatorCustodian,APPROVED_KEYCHAIN_ITEM} from '../integration/mac-host/keychain-provider.mjs';
import {createFalPlatformAdapter} from '../cloud/worker/fal-platform-adapter.mjs';
import {createOperatorConnections} from '../cloud/worker/operator-connections.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
const scope={roomId:'11111111-1111-4111-a111-111111111111',['sessionId']:'22222222-2222-4222-a222-222222222222',controlRevision:0,expiresAtMs:50000};
const approval=()=>({...scope,...APPROVED_KEYCHAIN_ITEM,approved:true,approvedAtMs:1000,process:'ai-vdj-native-node',recipient:'fal-fixed-generation-and-platform'});
test('exact Keychain adapter is default-off and denied scope/item/recipient never invokes even a synthetic reader',async()=>{
 let reads=0;const readItem=async()=>{reads++;return Buffer.from('example_fixture_credential\n');};
 const off=createScopedKeychainProvider({readItem});await assert.rejects(off.withCredential(scope,()=>true));assert.equal(reads,0);
 for(const patch of [{service:'other-item'},{account:'other-account'},{recipient:'another-provider'},{process:'browser'},
  {controlRevision:1},{expiresAtMs:1000},{expiresAtMs:1801001}]){
  const p=createScopedKeychainProvider({enabled:true,approval:{...approval(),...patch},readScope:async()=>scope,readItem,now:()=>1000});
  await assert.rejects(p.withCredential(scope,()=>true));p.close();assert.equal(reads,0);
 }
});
test('internal synthetic callback has no cache/persistence, clears byte buffers and sanitizes provider/read failures',async()=>{
 let reads=0,last;const p=createScopedKeychainProvider({enabled:true,approval:approval(),readScope:async()=>scope,now:()=>1000,
  readItem:async()=>{reads++;return last=Buffer.from('example_fixture_credential\n');}});
 assert.equal(await p.withCredential(scope,key=>key.length),26);assert(last.every(v=>v===0));
 await assert.rejects(p.withCredential(scope,key=>{throw Error(key);}),e=>e.message==='KEYCHAIN_PROVIDER_HOLD');assert(last.every(v=>v===0));assert.equal(reads,2);
 p.close();await assert.rejects(p.withCredential(scope,()=>true));assert.equal(reads,2);
});
test('timeout and close abort reads; a late synthetic reader cannot invoke a provider or retain its buffer',async()=>{
 let release,invoked=0;const p=createScopedKeychainProvider({enabled:true,approval:approval(),readScope:async()=>scope,now:()=>1000,timeoutMs:5,
  readItem:()=>new Promise(resolve=>{release=resolve;})});
 await assert.rejects(p.withCredential(scope,()=>{invoked++;}));const bytes=Buffer.from('example_fixture_credential');release(bytes);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(invoked,0);assert(bytes.every(v=>v===0));p.close();
});
test('approved synthetic Keychain mode auto-verifies opaque connection metadata without manual entry or secret storage',async()=>{
 let reads=0;const keychain=createScopedKeychainProvider({enabled:true,approval:approval(),readScope:async()=>scope,now:()=>1000,
  readItem:async()=>{reads++;return Buffer.from('example_fixture_credential');}});
 const platform=createFalPlatformAdapter({enabled:true,now:()=>1000,fetchImpl:async(url,init)=>{
  assert.equal(new URL(url).origin,'https://api.fal.ai');assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).get('authorization'),'Key example_fixture_credential');
  return Response.json({prices:Object.values(GENERATION_CONTRACT).filter(v=>typeof v==='string'&&v!==GENERATION_CONTRACT.version).map(endpoint_id=>({endpoint_id,unit:'synthetic-unit',unit_price:.1,currency:'USD'})),has_more:false,next_cursor:null});}});
 const custodian=createKeychainOperatorCustodian({enabled:true,keychain,platform,readScope:async()=>scope,expiresAtMs:50000,now:()=>1000});
 const connections=createOperatorConnections({enabled:true,platform,custodian,readScope:async()=>scope,readConnectionBinding:async()=>{},now:()=>1000});
 const c=await connections.readActive(scope);assert.equal(c.verified,true);assert(!JSON.stringify(c).includes('example_fixture_credential'));assert.equal(reads,1);
 assert.equal((await connections.readActive(scope)).connectionId,c.connectionId);assert.equal(reads,1);
 assert.equal(await connections.withCredential({...scope,connectionId:c.connectionId},key=>key.length),26);assert.equal(reads,2);
 await assert.rejects(connections.connect({...scope,credential:'example_manual_placeholder'}));
 connections.close();custodian.close();platform.close();
});

test('multi-request verification envelope does not extend the native Keychain read deadline',async()=>{
 let readDeadline;
 const p=createScopedKeychainProvider({enabled:true,approval:approval(),readScope:async()=>scope,now:()=>1000,
  readItem:async({timeoutMs})=>{readDeadline=timeoutMs;return Buffer.from('example_fixture_credential');}});
 assert.equal(await p.withCredential(scope,()=>true),true);assert.equal(readDeadline,8000);p.close();
 assert.throws(()=>createScopedKeychainProvider({timeoutMs:30001}));
});
