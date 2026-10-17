import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPlaybackAssetSnapshots} from '../cloud/worker/playback-asset-snapshots.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const records=new Map();let reads=0,proofs=0;
 const assetStore={async read(id){reads++;return structuredClone(records.get(id));},async readOptional(id){reads++;return structuredClone(records.get(id)??null);},
  async save(input){const record={assetId:input.id,bytes:new Uint8Array(input.bytes),sha256:sha(input.bytes),byteLength:input.bytes.length,binding:input.binding};records.set(input.id,record);return structuredClone(record);},
  async verifySaved(input){proofs++;const record=records.get(input.asset.assetId);return {privateSaved:true,checksumVerified:true,assetId:record.assetId,sha256:record.sha256,binding:record.binding};}};
 return {assetStore,records,counts:()=>({reads,proofs})};
}
test('playback snapshots physically verify once, share in-flight loads, and return isolated hash-checked copies',async()=>{
 const x=fixture();await x.assetStore.save({id:'example_audio',bytes:Uint8Array.of(1,2,3),binding:{kind:'synthetic'}});
 const store=createPlaybackAssetSnapshots({assetStore:x.assetStore});const [a,b]=await Promise.all([store.read('example_audio'),store.read('example_audio')]);
 assert.deepEqual(x.counts(),{reads:1,proofs:1});a.bytes.fill(9);b.binding.kind='changed';
 const c=await store.read('example_audio');assert.deepEqual([...c.bytes],[1,2,3]);assert.equal(c.binding.kind,'synthetic');
 await assert.rejects(store.verifySaved({asset:{assetId:c.assetId,sha256:'f'.repeat(64)},binding:c.binding}),/SNAPSHOT_REQUIRED/);
 assert.deepEqual(x.counts(),{reads:1,proofs:1});store.close();await assert.rejects(store.read(c.assetId),/SNAPSHOT_REQUIRED/);
});
test('bad physical bytes or save proof never become snapshots; absence is not cached and bounds evict safely',async()=>{
 const x=fixture(),store=createPlaybackAssetSnapshots({assetStore:x.assetStore,maximumBytes:3});
 assert.equal(await store.readOptional('example_missing'),null);
 await x.assetStore.save({id:'example_missing',bytes:Uint8Array.of(1,2,3),binding:{}});assert.ok(await store.read('example_missing'));
 await x.assetStore.save({id:'example_other',bytes:Uint8Array.of(4,5,6),binding:{}});await store.read('example_other');
 const before=x.counts().reads;await store.read('example_missing');assert.equal(x.counts().reads,before+1);
 await x.assetStore.save({id:'example_bad',bytes:Uint8Array.of(1),binding:{}});x.records.get('example_bad').bytes[0]=2;
 await assert.rejects(store.read('example_bad'),/SNAPSHOT_REQUIRED/);
 const broken=createPlaybackAssetSnapshots({assetStore:{...x.assetStore,verifySaved:async()=>({privateSaved:false})}});
 await assert.rejects(broken.read('example_missing'),/SNAPSHOT_REQUIRED/);store.close();broken.close();
});
test('a playback save invalidates its snapshot; original generation store still performs physical reads',async()=>{
 const x=fixture(),store=createPlaybackAssetSnapshots({assetStore:x.assetStore});
 await store.save({id:'example_render',bytes:Uint8Array.of(1),binding:{}});await store.read('example_render');
 await store.save({id:'example_render',bytes:Uint8Array.of(2),binding:{}});assert.deepEqual([...(await store.read('example_render')).bytes],[2]);
 const before=x.counts().reads;await x.assetStore.read('example_render');assert.equal(x.counts().reads,before+1);store.close();
});
