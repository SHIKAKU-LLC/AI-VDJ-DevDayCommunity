import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperatorMedia} from '../cloud/worker/operator-media.mjs';
import {createSupabasePrivateStore} from '../cloud/worker/supabase-private-store.mjs';
import {syntheticStorageTransport} from './cloud-worker-store-fixture.mjs';
import {fixtureSha,syntheticWave,syntheticReference} from './cloud-worker-fixture.mjs';
import {createPortableNativeRuntime} from '../cloud/worker/native-runtime.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),referenceSha256='f'.repeat(64);
const scope={roomId:'empty-owner-video-room',['sessionId']:'empty-owner-video-epoch',controlRevision:0,expiresAtMs:60000,ownerEnabled:true};
async function upload(media,bytes,{role='saved-video',mimeType='video/mp4',consent=true}={}){
 const u=await media.begin({...scope,selection:{role,mimeType,byteLength:bytes.length,sha256:fixtureSha(bytes),referenceSha256,consent}});
 for(let offset=0;offset<bytes.length;offset+=32768)await media.append({...scope,uploadId:u.uploadId,offset,bytes:bytes.subarray(offset,offset+32768)});
 return media.finish({...scope,uploadId:u.uploadId});
}
function fixture({approved=true,resolve=async()=>null,inspectVideo,inspectReference}={}){
 const storage=syntheticStorageTransport(),store=createSupabasePrivateStore({enabled:true,roomId:scope.roomId,transport:storage.transport});
 let current={...scope},inspections=0;
 const create=()=>createOperatorMedia({enabled:true,assetStore:store.assetStore,readScope:async()=>current,now:()=>1000,
  ownerBootstrapVideoApproved:approved,verifySavedVideo:resolve,inspectReference:inspectReference??(async bytes=>({sha256:fixtureSha(bytes),fullyDecoded:true,width:2,height:2})),inspectAudio:async bytes=>({assetSha256:fixtureSha(bytes),frameCount:24*44100,
   channels:2,sampleRate:44100,nonfiniteSamples:0,clippedFraction:0,loudness:{truePeakDbtp:-10},activity:{effectiveSilence:false,maxQuietRunSeconds:0}}),
  inspectVideo:async input=>{inspections++;return inspectVideo?inspectVideo(input):{rawSha256:fixtureSha(input.bytes),inputDigest:input.inputDigest,
   fullyDecoded:true,durationSeconds:19,decodedFrames:76,width:160,height:90,
   technicalStats:{method:'full-frame-luma-motion-v1',frames:76,nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.1,maximumLargeLumaTransitionsPerSecond:0}};}});
 return {storage,store,create,change:v=>{current={...current,...v};},inspections:()=>inspections};
}
test('empty private room admits explicitly selected owner video with immutable native evidence and honest origin',async t=>{
 const x=fixture(),media=x.create();t.after(()=>{media.close();x.store.close();});assert.equal(x.storage.objects.size,0);
 const bytes=Uint8Array.of(1,2,3),d=await upload(media,bytes),record=await x.store.assetStore.read(d.assetId);
 assert.equal(record.provenance.kind,'owner-supplied-bootstrap-video');assert.equal(record.provenance.actualGenerationThisRun,false);
 assert.equal(record.provenance.requestId,undefined);assert.equal(record.binding.generationId,undefined);
 const admission=await x.store.assetStore.read('admission-'+record.provenance.admissionId);
 assert.equal(admission.sha256,record.provenance.admissionEvidenceSha256);assert.equal(JSON.parse(new TextDecoder().decode(admission.bytes)).ownerSelected,true);
 media.close();const restored=x.create();t.after(()=>restored.close());assert.deepEqual(await restored.read({...scope,assetId:d.assetId}),d);
 x.change({controlRevision:1});await assert.rejects(restored.read({...scope,assetId:d.assetId}),/SCOPE_CHANGED/);
});
test('reviewed native policy and owner consent are both required; provider resolver errors never downgrade',async()=>{
 for(const [options,consent] of [[{approved:false},true],[{},false],[{resolve:async()=>{throw Error('PROVIDER_RECEIPT_CHANGED');}},true]]){
  const x=fixture(options),m=x.create();try{await assert.rejects(upload(m,Uint8Array.of(1,2),{consent}),/PROVENANCE_REQUIRED|PROVIDER_RECEIPT_CHANGED/);
   assert.equal(x.inspections(),0);assert.equal(x.storage.objects.size,0);}finally{m.close();x.store.close();}
 }
});
test('short/static/corrupt video and expired admission remain HOLD without a selected descriptor',async()=>{
 for(const edit of [m=>({...m,durationSeconds:18.9}),m=>({...m,fullyDecoded:false}),m=>({...m,technicalStats:{...m.technicalStats,meanMotion:0}})]){
  const x=fixture({inspectVideo:input=>edit({rawSha256:fixtureSha(input.bytes),inputDigest:input.inputDigest,fullyDecoded:true,durationSeconds:19,
   decodedFrames:76,width:160,height:90,technicalStats:{method:'full-frame-luma-motion-v1',frames:76,nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.1,maximumLargeLumaTransitionsPerSecond:0}})}),m=x.create();
  try{await assert.rejects(upload(m,Uint8Array.of(1,2)),/VIDEO_QC_REQUIRED/);assert.equal(x.storage.objects.size,0);}finally{m.close();x.store.close();}
 }
 const x=fixture(),m=x.create();try{const d=await upload(m,Uint8Array.of(1,2));x.change({expiresAtMs:1000});
  await assert.rejects(m.read({...scope,assetId:d.assetId}),/SCOPE_CHANGED/);}finally{m.close();x.store.close();}
});
test('immutable seed/reference selection survives restart and rejects source replacement',async t=>{
 const x=fixture(),m=x.create();t.after(()=>{m.close();x.store.close();});const seed=await upload(m,syntheticWave(24),{role:'seed',mimeType:'audio/wav'});
 const reference=await upload(m,Uint8Array.of(137,80,78,71,13,10,26,10),{role:'reference',mimeType:'image/png'});
 const restored=x.create();t.after(()=>restored.close());assert.deepEqual((await restored.listSelected(scope)).map(a=>a.assetId),[seed.assetId,reference.assetId]);
 await assert.rejects(upload(restored,Uint8Array.of(137,80,78,71,13,10,26,10,1),{role:'reference',mimeType:'image/png'}),/SOURCE_CHANGED/);
 assert.equal((await restored.listSelected(scope))[1].sha256,reference.sha256);
});
test('empty-room owner admission uses real native complete 19-second decode; static material is rejected',
 {skip:!process.env.VDJ_QC_PYTHON,timeout:120000},async t=>{
 const options={python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'},
  native=await createPortableNativeRuntime(options),dir=await mkdtemp(path.join(tmpdir(),'vdj-owner-admission-')),
  x=fixture({inspectVideo:native.native.inspectVideo,inspectReference:native.inspectReference}),m=x.create();
 t.after(async()=>{m.close();x.store.close();await native.close();await rm(dir,{recursive:true,force:true});});
 await assert.rejects(upload(m,Uint8Array.of(137,80,78,71,13,10,26,10),{role:'reference',mimeType:'image/png'}),/REFERENCE_NATIVE_DECODE_REQUIRED/);
 assert.equal((await m.listSelected(scope)).length,0,'broken image cannot freeze source selection');
 const reference=await upload(m,syntheticReference(),{role:'reference',mimeType:'image/png'});assert.equal(reference.sha256,fixtureSha(syntheticReference()));
 // Static first: once a video is selected, a different upload is rejected as
 // OPERATOR_SOURCE_CHANGED before QC, which would mask the QC failure checked here.
 for(const [name,source] of [['static','color=c=blue:size=160x90:rate=4'],['moving','testsrc2=size=160x90:rate=4']]){
  const file=path.join(dir,name+'.mp4');await run(options.ffmpeg,['-nostdin','-v','error','-f','lavfi','-i',source,'-t','19','-c:v','libx264','-pix_fmt','yuv420p','-an',file]);
  const bytes=await readFile(file);if(name==='static')await assert.rejects(upload(m,bytes),/VIDEO_QC_REQUIRED/);
  else{const d=await upload(m,bytes),record=await x.store.assetStore.read(d.assetId),admission=await x.store.assetStore.read('admission-'+record.provenance.admissionId),
   evidence=JSON.parse(new TextDecoder().decode(admission.bytes));assert.equal(evidence.measurement.decodedFrames,76);assert.equal(evidence.measurement.fullyDecoded,true);
   assert.equal(evidence.measurement.rawSha256,fixtureSha(bytes));assert.equal(record.provenance.actualGenerationThisRun,false);}
 }
});
test('staged upload cannot acquire a changed deadline at append or finish',async()=>{
 for(const phase of ['append','finish']){const x=fixture(),m=x.create();try{
  const bytes=Uint8Array.of(1,2),u=await m.begin({...scope,selection:{role:'saved-video',mimeType:'video/mp4',byteLength:bytes.length,sha256:fixtureSha(bytes),referenceSha256,consent:true}});
  if(phase==='finish')await m.append({...scope,uploadId:u.uploadId,offset:0,bytes});
  x.change({expiresAtMs:70000});const input=Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,scope[k]]));
  await assert.rejects(phase==='append'?m.append({...input,uploadId:u.uploadId,offset:0,bytes}):m.finish({...input,uploadId:u.uploadId}),/CHUNK_REQUIRED|UPLOAD_REQUIRED/);
  assert.equal(x.inspections(),0);assert.equal(x.storage.objects.size,0);
 }finally{m.close();x.store.close();}}
});
