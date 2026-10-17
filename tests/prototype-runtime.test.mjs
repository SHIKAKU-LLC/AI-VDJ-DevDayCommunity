import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareBootstrap,saveBootstrap,decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {createLocalArtifactStore} from '../integration/runtime/local-artifacts.mjs';
import {createOperationProvenance} from '../integration/runtime/provenance.mjs';
import {createPrivateMediaResolver} from '../room-web/private-media-resolver.mjs';
import {operationBinding} from '../cloud/generation/cue-contract.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function wave(){const frames=24*44100,b=Buffer.alloc(44+frames*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
 b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(176400,28);
 b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*4,40);
 for(let i=0;i<frames*2;i++)b.writeInt16LE(1000,44+i*2);return b;}
const image=Buffer.from([137,80,78,71,13,10,26,10]);
const inspect=async bytes=>({assetSha256:hash(bytes),frameCount:24*44100,sampleRate:44100,channels:2,
 loudness:{truePeakDbtp:-10},nonfiniteSamples:0,clippedFraction:0,activity:{effectiveSilence:false,maxQuietRunSeconds:0},key:{confidence:'unknown'}});
test('bootstrap derives exact16s context and retains owner-supplied provenance without claiming playback',async()=>{
 const result=await prepareBootstrap({audioBytes:wave(),referenceBytes:image,inspect});
 assert.equal(result.source.music.contextSha256,hash(result.contextBytes));assert.equal(result.contextBytes.length,2822444);
 assert.equal(result.source.playback.phase,'IDLE');assert.equal(result.provenance.actualGenerationThisRun,false);
 assert.equal(result.source.quality.tempoConfidence,'assumed');assert.equal(result.source.quality.keyConfidence,'unknown');
 const store=await createLocalArtifactStore();
 try{const source=await saveBootstrap({prepared:result,store});
  assert.equal((await store.read(source.audioAssetId)).sha256,source.music.sha256);
  assert.equal((await store.read(source.contextAssetId)).sha256,source.music.contextSha256);
  assert.equal((await store.read(source.referenceAssetId)).sha256,source.video.referenceSha256);
 }finally{await store.close();}
});
test('bootstrap rejects truncation, unverified profile and missing reference',async()=>{
 const b=wave();assert.throws(()=>decodeCompleteWave(b.subarray(0,b.length-1)),/COMPLETE_WAVE/);
 await assert.rejects(prepareBootstrap({audioBytes:b,referenceBytes:image,inspect:async()=>({})}),/BOOTSTRAP_AUDIO_QC/);
 await assert.rejects(prepareBootstrap({audioBytes:b,referenceBytes:Buffer.from('bad'),inspect}),/OWNER_IMAGE_REFERENCE/);
});
test('private local artifacts enforce immutable bytes, real checksum, quota and no repository directory',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vdj-artifact-test-'));
 const store=await createLocalArtifactStore({directory:dir,maximumBytes:6});const binding={roomId:'test'};
 try{
  const first=await store.save({id:'one',bytes:Buffer.from('abc'),contentType:'audio/wav',binding});
  assert.equal((await store.verifySaved({asset:first,binding})).checksumVerified,true);
  await assert.rejects(store.save({id:'one',bytes:Buffer.from('def'),contentType:'audio/wav',binding}),/IMMUTABLE/);
  await assert.rejects(store.save({id:'two',bytes:Buffer.from('four'),contentType:'audio/wav',binding}),/QUOTA/);
  await writeFile(path.join(dir,'one.blob'),'tampered');await assert.rejects(store.read('one'),/CHANGED/);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
 await assert.rejects(createLocalArtifactStore({directory:process.cwd()}),/OUTSIDE_GIT/);
});
test('trusted provenance comes from immutable operation and actual downloaded bytes, never caller flags',async()=>{
 const bytes=Buffer.from('synthetic provider bytes');let posts=0;
 const op={operationId:'operation',submissionId:'submission',plan:{commonIntentSha256:'a'.repeat(64),common:{control:{version:2}}},
  permit:{source:{music:{contextSha256:'b'.repeat(64)},video:{referenceSha256:'c'.repeat(64)}}},
  stages:{music:{state:'COMPLETE',requestId:'request',result:{url:'https://v3.fal.media/fixture.wav',resultSha256:'d'.repeat(64)}}}};
 const bridge=createOperationProvenance({readOperation:async()=>op,fetchImpl:async()=>{posts++;return new Response(bytes);}});
 const download=await bridge.download({roomId:'room',operationId:'operation',channel:'music'});
 const request={binding:operationBinding('room',op,'music'),rawSha256:hash(bytes),byteLength:bytes.length,sourceSha256:'b'.repeat(64)};
 assert.equal((await bridge.verifyProvenance(download.provenance,request)).requestId,'request');
 assert.equal(await bridge.verifyProvenance({verified:true},request),null);
 assert.equal(await bridge.verifyProvenance(download.provenance,{...request,rawSha256:'0'.repeat(64)}),null);
 op.stages.music.result.url='https://elsewhere.invalid/file';
 await assert.rejects(bridge.download({roomId:'room',operationId:'operation',channel:'music'}),/TARGET_REQUIRED/);assert.equal(posts,1);
 bridge.close();
});
test('owner video provenance requires trusted admission read and cannot be re-labelled as prior generation',async()=>{
 const sha256='a'.repeat(64),referenceSha256='b'.repeat(64),request={binding:{roomId:'room',channel:'video'},rawSha256:sha256,
  byteLength:10,sourceSha256:referenceSha256};let observed;
 const record={kind:'owner-supplied-bootstrap-video',sha256,byteLength:10,referenceSha256,actualGenerationThisRun:false,
  binding:{kind:'owner-supplied-bootstrap-video',roomId:'room'},admissionId:'owner-admission',admissionEvidenceSha256:'c'.repeat(64)};
 const bridge=createOperationProvenance({readOperation:async()=>{},readSavedRecord:async(id,r)=>{assert.equal(id,'owner-video');observed=r;return record;}});
 const proof=await bridge.verifyProvenance({kind:record.kind,assetId:'owner-video'},request);
 assert.deepEqual(observed,request);assert.equal(proof.kind,record.kind);assert.equal(proof.actualGenerationThisRun,false);
 assert.equal(proof.originalGenerationId,undefined);assert.equal(proof.requestId,undefined);
 assert.equal(await bridge.verifyProvenance({kind:'saved',assetId:'owner-video'},request),null);
 assert.equal(await bridge.verifyProvenance({kind:record.kind,assetId:'owner-video'},{...request,binding:{roomId:'other',channel:'video'}}),null);
 record.generationId='invented';assert.equal(await bridge.verifyProvenance({kind:record.kind,assetId:'owner-video'},request),null);
});
test('browser resolver verifies PCM/clip hashes, exposes only temporary Blob URLs and revokes on release',async()=>{
 const pcm=new Float32Array(512).fill(.1),clip=Buffer.from('synthetic mp4'),clipHash=hash(clip),pcmHash=hash(Buffer.from(pcm.buffer));
 const revoked=[];const render={pcm,sampleRate:44100,renderedFileSha256:'f'.repeat(64),renderedPcmSha256:pcmHash};
 const resolver=createPrivateMediaResolver({readRender:async()=>render,
  readArtifact:async()=>({bytes:clip,contentType:'video/mp4',provenance:{kind:'provider',requestId:'request'}}),
  urlAPI:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:u=>revoked.push(u)}});
 const media=await resolver.resolveMedia({roomId:'room',cue:{music:{asset:{assetId:'audio',sha256:'a'.repeat(64)}},
  video:{clips:[{assetId:'clip',sha256:clipHash}]}},plan:{transition:{renderedSha256:'f'.repeat(64)}}});
 assert.equal(media.videos[0].source,'fal');assert.equal(await resolver.loadVerifiedRender({media:media.audio}),render);
 media.release();assert.deepEqual(revoked,['blob:fixture']);await assert.rejects(resolver.loadVerifiedRender({media:media.audio}),/NOT_PREPARED/);
});
