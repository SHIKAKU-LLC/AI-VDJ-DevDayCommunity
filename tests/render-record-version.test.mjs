import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createProductionRenderRecordStore,renderRecordId} from '../cloud/worker/render-record-store.mjs';

test('stable derived render records coexist with immutable legacy records; published legacy cues still resolve',async()=>{
 const values=new Map(),sha=b=>createHash('sha256').update(b).digest('hex');
 const assets={async readOptional(id){return values.get(id)??null;},async read(id){return values.get(id);},
  async save({id,bytes,contentType,binding,provenance}){
   assert.equal(values.has(id),false,'an existing immutable record must never be replaced');
   values.set(id,{assetId:id,bytes:new Uint8Array(bytes),byteLength:bytes.length,sha256:sha(bytes),contentType,binding,provenance});
  },async verifySaved({asset,binding}){const r=values.get(asset.assetId);return {
   privateSaved:r?.sha256===asset.sha256,checksumVerified:r?.sha256===sha(r.bytes),assetId:r.assetId,sha256:r.sha256,binding};}};
 const store=createProductionRenderRecordStore({enabled:true,assetStore:assets});
 const binding={roomId:'synthetic-room',submissionId:'synthetic-post'},input={roomId:'synthetic-room',operationId:'synthetic-operation',
  cueId:'synthetic-cue',binding,source:{audioAssetId:'seed',music:{clipId:'seed'},playback:{revision:0}},
  render:{assetId:'render-legacy',receipt:{renderedSha256:'a'.repeat(64)}},evidenceSha256:'b'.repeat(64)};
 const legacy=await store.save(input),legacyKey=renderRecordId(input);
 const stable=await store.save({...input,render:{...input.render,assetId:'render-v2-example'},evidenceSha256:'c'.repeat(64)});
 assert.equal(values.size,2);assert.equal(legacy.artifactVersion,undefined);assert.equal(stable.artifactVersion,'stable-peak-timestamp-v2');
 assert.notEqual(legacyKey,renderRecordId(stable));
 const cue={cueId:input.cueId,operationId:input.operationId,evidenceSha256:input.evidenceSha256,
  music:{binding,parentClipId:'seed',asset:{assetId:'audio-legacy'}}};
 assert.deepEqual(await store.read({roomId:input.roomId,cue}),legacy);
 assert.deepEqual(await store.read({roomId:input.roomId,cue:{...cue,evidenceSha256:'c'.repeat(64),
  music:{...cue.music,asset:{assetId:'audio-v2-example'}}}}),stable);
 assert.deepEqual(await store.save(input),legacy);assert.equal(values.size,2);
});

test('records are scoped by operation; a replay can save under a reused cueId and legacy records still read',async()=>{
 const {legacyRenderRecordId}=await import('../cloud/worker/render-record-store.mjs');
 const values=new Map(),sha=b=>createHash('sha256').update(b).digest('hex');
 const assets={async readOptional(id){return values.get(id)??null;},async read(id){return values.get(id);},
  async save({id,bytes,contentType,binding,provenance}){
   assert.equal(values.has(id),false,'an existing immutable record must never be replaced');
   values.set(id,{assetId:id,bytes:new Uint8Array(bytes),byteLength:bytes.length,sha256:sha(bytes),contentType,binding,provenance});
  },async verifySaved({asset,binding}){const r=values.get(asset.assetId);return {
   privateSaved:r?.sha256===asset.sha256,checksumVerified:r?.sha256===sha(r.bytes),assetId:r.assetId,sha256:r.sha256,binding};}};
 const store=createProductionRenderRecordStore({enabled:true,assetStore:assets});
 const binding={roomId:'synthetic-room',submissionId:'synthetic-post'};
 const input=operationId=>({roomId:'synthetic-room',operationId,cueId:'synthetic-cue',binding,source:{audioAssetId:'seed',music:{clipId:'seed'},playback:{revision:0}},
  render:{assetId:'render-'+operationId,receipt:{renderedSha256:'a'.repeat(64)}},evidenceSha256:'b'.repeat(64)});
 const cue=operationId=>({cueId:'synthetic-cue',operationId,evidenceSha256:'b'.repeat(64),music:{binding,parentClipId:'seed',asset:{assetId:'audio-legacy'}}});
 const first=await store.save(input('operation-first'));
 const replay=await store.save(input('operation-replay'));
 assert.notEqual(renderRecordId(input('operation-first')),renderRecordId(input('operation-replay')),'a replayed operation gets its own record');
 assert.deepEqual(await store.read({roomId:'synthetic-room',cue:cue('operation-first')}),first);
 assert.deepEqual(await store.read({roomId:'synthetic-room',cue:cue('operation-replay')}),replay);
 // A record published before operation scoping is still read, and saving it again reuses it.
 const old=input('operation-old'),saved=await store.save(old);
 // Simulate storage written before operation scoping: the same record under its legacy ID.
 const scoped=values.get(renderRecordId(old));values.delete(renderRecordId(old));
 values.set(legacyRenderRecordId(old),{...scoped,assetId:legacyRenderRecordId(old)});
 assert.deepEqual(await store.read({roomId:'synthetic-room',cue:cue('operation-old')}),saved,'legacy ID is read');
 const before=values.size;assert.deepEqual(await store.save(old),saved);assert.equal(values.size,before,'identical legacy record is reused');
});
