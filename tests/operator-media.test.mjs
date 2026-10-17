import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperatorMedia} from '../cloud/worker/operator-media.mjs';
import {syntheticWave,fixtureSha} from './cloud-worker-fixture.mjs';
const scope={roomId:'11111111-1111-4111-a111-111111111111',['sessionId']:'22222222-2222-4222-a222-222222222222',controlRevision:0,expiresAtMs:60000,ownerEnabled:true};
function fixture(overrides={}){const records=new Map();let reads=0,inspections=0;
 const assetStore={save:async({id,bytes,contentType,binding,provenance})=>{const value={assetId:id,bytes:Uint8Array.from(bytes),sha256:fixtureSha(bytes),byteLength:bytes.length,contentType,binding,provenance};
 if(records.has(id))assert.deepEqual(records.get(id),value);else records.set(id,value);},
 readOptional:async id=>records.get(id)??null,
 read:async id=>{reads++;const r=records.get(id);if(!r)throw Error('absent');return r;},verifySaved:async({asset})=>{const r=records.get(asset.assetId);assert.equal(fixtureSha(r.bytes),asset.sha256);return {...asset,binding:r.binding,privateSaved:true,checksumVerified:true};}};
 const create=()=>createOperatorMedia({enabled:true,assetStore,readScope:async()=>scope,now:()=>1000,
 inspectAudio:async bytes=>{inspections++;return {method:'pcm-endpoint-profile-v1',assetSha256:fixtureSha(bytes),frameCount:24*44100,channels:2,sampleRate:44100,nonfiniteSamples:0,clippedFraction:0,loudness:{truePeakDbtp:-10},activity:{effectiveSilence:false,maxQuietRunSeconds:0}};},
 inspectReference:async bytes=>({sha256:fixtureSha(bytes),fullyDecoded:true,width:2,height:2}),
 inspectVideo:async()=>assert.fail('unapproved saved bytes never reach native video'),verifySavedVideo:async()=>null,...overrides});
 return {create,assetStore,records,reads:()=>reads,inspections:()=>inspections};}
async function upload(media,bytes,role='seed',sha=fixtureSha(bytes)){const u=await media.begin({...scope,selection:{role,mimeType:role==='seed'?'audio/wav':'video/mp4',byteLength:bytes.length,sha256:sha,referenceSha256:'f'.repeat(64)}});
 for(let offset=0;offset<bytes.length;offset+=32768)await media.append({...scope,uploadId:u.uploadId,offset,bytes:bytes.subarray(offset,offset+32768)});
 return media.finish({...scope,uploadId:u.uploadId});}
test('actual hash/format checks, physical immutable saves and sealed selection metadata survive fresh upload factory',async()=>{
 const x=fixture(),first=x.create(),bytes=syntheticWave(24),a=await upload(first,bytes);assert.equal(x.inspections(),1);assert.equal(x.records.size,3);
 first.close();const restored=x.create(),r=await restored.read({...scope,assetId:a.assetId});assert.equal(r.sha256,fixtureSha(bytes));assert.equal(r.byteLength,bytes.length);
 restored.close();
});
test('wrong bytes/offset, wrong seed duration and unapproved video fail before accepted asset writes',async()=>{
 const x=fixture(),m=x.create(),bytes=syntheticWave(24);await assert.rejects(upload(m,bytes,'seed','a'.repeat(64)),/CHECKSUM_CHANGED/);assert.equal(x.records.size,0);
 await assert.rejects(upload(m,syntheticWave(1)),/SEED_QC_REQUIRED/);assert.equal(x.records.size,0);
 await assert.rejects(upload(m,Uint8Array.of(1,2,3),'saved-video'),/SAVED_VIDEO_PROVENANCE_REQUIRED/);assert.equal(x.records.size,0);m.close();
});

test('status uses scoped verified metadata while admission still detects altered physical bytes',async()=>{
 const x=fixture(),m=x.create(),a=await upload(m,syntheticWave(24)),before=x.reads();
 assert.equal((await m.listSelectedForStatus(scope))[0].assetId,a.assetId);assert.equal(x.reads(),before);
 await assert.rejects(m.listSelectedForStatus({...scope,controlRevision:1}),/SCOPE_CHANGED/);
 x.records.get(a.assetId).bytes[48]^=1;
 await assert.rejects(m.read({...scope,assetId:a.assetId}));m.close();
});

// Lost HTTP replies must not force another upload of an accepted saved video.
test('saved video selection survives a new factory and still verifies physical bytes',async()=>{
 const bytes=Uint8Array.from({length:48},(_,i)=>i),digest=fixtureSha(bytes);
 const x=fixture({ownerBootstrapVideoApproved:true,inspectVideo:async({inputDigest})=>({rawSha256:digest,inputDigest,
  fullyDecoded:true,durationSeconds:24,decodedFrames:2,width:16,height:9,
  technicalStats:{method:'full-frame-luma-motion-v1',frames:2,nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.1,maximumLargeLumaTransitionsPerSecond:0}})});
 const first=x.create(),u=await first.begin({...scope,selection:{role:'saved-video',mimeType:'video/mp4',byteLength:bytes.length,sha256:digest,referenceSha256:'f'.repeat(64),consent:true}});
 await first.append({...scope,uploadId:u.uploadId,offset:0,bytes});
 const saved=await first.finish({...scope,uploadId:u.uploadId});first.close();
 const restored=x.create(),selected=await restored.listSelected(scope);
 assert.equal(selected.length,1);assert.equal(selected[0].assetId,saved.assetId);assert.equal(selected[0].referenceSha256,'f'.repeat(64));
 x.records.get(saved.assetId).bytes[0]^=1;await assert.rejects(restored.read({...scope,assetId:saved.assetId}));restored.close();
});

// An immutable role selection is resolved before QC or any private save, so a
// rejected replacement or a retried identical upload leaves no orphaned object.
test('existing selection rejects a different upload and reuses an identical one without new private objects',async()=>{
 const x=fixture(),m=x.create(),bytes=syntheticWave(24),first=await upload(m,bytes);
 const saved=x.records.size,inspected=x.inspections(),other=Uint8Array.from(bytes);other[other.length-1]^=1;
 await assert.rejects(upload(m,other),/OPERATOR_SOURCE_CHANGED/);
 assert.equal(x.records.size,saved);assert.equal(x.inspections(),inspected);
 const again=await upload(m,bytes);assert.equal(again.assetId,first.assetId);
 assert.equal(x.records.size,saved);assert.equal(x.inspections(),inspected);m.close();
});
test('a different owner video for an existing selection saves neither bytes nor an admission record',async()=>{
 const bytes=Uint8Array.from({length:48},(_,i)=>i),other=Uint8Array.from({length:48},(_,i)=>i+1);
 const x=fixture({ownerBootstrapVideoApproved:true,inspectVideo:async({bytes:b,inputDigest})=>({rawSha256:fixtureSha(b),inputDigest,
  fullyDecoded:true,durationSeconds:24,decodedFrames:2,width:16,height:9,
  technicalStats:{method:'full-frame-luma-motion-v1',frames:2,nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.1,maximumLargeLumaTransitionsPerSecond:0}})});
 const m=x.create(),send=async b=>{const u=await m.begin({...scope,selection:{role:'saved-video',mimeType:'video/mp4',byteLength:b.length,
  sha256:fixtureSha(b),referenceSha256:'f'.repeat(64),consent:true}});await m.append({...scope,uploadId:u.uploadId,offset:0,bytes:b});
  return m.finish({...scope,uploadId:u.uploadId});};
 await send(bytes);const saved=x.records.size;
 await assert.rejects(send(other),/OPERATOR_SOURCE_CHANGED/);assert.equal(x.records.size,saved);m.close();
});
// A transient failure after bytes were saved must not orphan them on retry.
test('a retried upload after a transient save failure reuses the same private objects',async()=>{
 const x=fixture(),save=x.assetStore.save;let failed=false;
 x.assetStore.save=async input=>{if(!failed&&input.id.startsWith('operator-selection-')){failed=true;throw Error('transient');}return save(input);};
 const m=x.create(),bytes=syntheticWave(24);await assert.rejects(upload(m,bytes),/transient/);
 const partial=x.records.size,a=await upload(m,bytes);
 assert.equal(failed,true);assert.equal(x.records.size,partial+1,'only the missing index is added');
 const clean=fixture(),b=await upload(clean.create(),bytes);assert.equal(x.records.size,clean.records.size);assert.equal(a.assetId,b.assetId);m.close();
});
test('a retried owner video after a transient failure reuses its admission and bytes',async()=>{
 const bytes=Uint8Array.from({length:48},(_,i)=>i),digest=fixtureSha(bytes);
 const options={ownerBootstrapVideoApproved:true,inspectVideo:async({inputDigest})=>({rawSha256:digest,inputDigest,
  fullyDecoded:true,durationSeconds:24,decodedFrames:2,width:16,height:9,
  technicalStats:{method:'full-frame-luma-motion-v1',frames:2,nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.1,maximumLargeLumaTransitionsPerSecond:0}})};
 const send=async m=>{const u=await m.begin({...scope,selection:{role:'saved-video',mimeType:'video/mp4',byteLength:bytes.length,
  sha256:digest,referenceSha256:'f'.repeat(64),consent:true}});await m.append({...scope,uploadId:u.uploadId,offset:0,bytes});
  return m.finish({...scope,uploadId:u.uploadId});};
 const x=fixture(options),save=x.assetStore.save;let failed=false;
 x.assetStore.save=async input=>{if(!failed&&input.id.startsWith('selected-')){failed=true;throw Error('transient');}return save(input);};
 const m=x.create();await assert.rejects(send(m),/transient/);const selected=await send(m);
 const clean=fixture(options);await send(clean.create());
 assert.equal(x.records.size,clean.records.size,'no second admission record or asset');
 assert.equal((await x.create().read({...scope,assetId:selected.assetId})).sha256,digest);m.close();
});
test('concurrent different uploads for one unselected role persist only the winner',async()=>{
 const x=fixture(),m=x.create(),a=syntheticWave(24),b=Uint8Array.from(a);b[b.length-1]^=1;
 const results=await Promise.allSettled([upload(m,a),upload(m,b)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/OPERATOR_SOURCE_CHANGED/);
 const clean=fixture();await upload(clean.create(),a);assert.equal(x.records.size,clean.records.size,'no orphaned asset or metadata');m.close();
});
