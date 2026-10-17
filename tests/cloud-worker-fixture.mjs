// Offline fixture utility for integrated queue/coordinator/player tests. It
// simulates an ingestion ledger; these bytes never establish a real generation.
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPortableCloudWorker} from '../cloud/worker/portable-worker.mjs';
import {operationBinding} from '../cloud/generation/cue-contract.mjs';
const run=promisify(execFile),rate=44100;
export const fixtureSha=bytes=>createHash('sha256').update(bytes).digest('hex');
// A complete synthetic 2x2 PNG encoded from FFmpeg testsrc2, with no private image.
export const syntheticReference=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEUlEQVR4nGNk+McABCwMYAAADCABBJGhTzIAAAAASUVORK5CYII=','base64');
export function syntheticWave(seconds) {
  const n=seconds*rate,b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*4,28);
  b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);
  for(let i=0;i<n;i++){const x=Math.round(.1*Math.sin(2*Math.PI*220*i/rate)*32768);b.writeInt16LE(x,44+i*4);b.writeInt16LE(x,46+i*4);}return b;
}
export function createSyntheticPrivateStore() {
  const records=new Map();
  return {records,async save({id,bytes,binding,provenance,contentType}){
    const previous=records.get(id),record={assetId:id,bytes:Buffer.from(bytes),sha256:fixtureSha(bytes),byteLength:bytes.length,
      binding:structuredClone(binding),provenance:structuredClone(provenance??{}),contentType};
    if(previous&&(previous.sha256!==record.sha256||JSON.stringify(previous.binding)!==JSON.stringify(record.binding)))throw Error('ASSET_IMMUTABLE');
    records.set(id,record);return structuredClone(record);
  },async read(id){return structuredClone(records.get(id));},async verifySaved({asset}){
    const record=records.get(asset.assetId);return {privateSaved:true,checksumVerified:record.sha256===asset.sha256,
      assetId:record.assetId,sha256:record.sha256,binding:record.binding};
  }};
}
export function syntheticVisualPlan({newClip}) {
  return {clips:[newClip],manifest:{version:'accepted-video-timeline-v1',durationSeconds:24,width:1280,height:720,
    fit:'contain',muted:true,clips:[{clipId:newClip.clipId,sha256:newClip.sha256,durationSeconds:5}],
    segments:[0,5,10,15,20].map(start=>({clipId:newClip.clipId,startSeconds:start,endSeconds:Math.min(24,start+5),
      inSeconds:0,outSeconds:Math.min(5,24-start),overlapSeconds:0,transition:'cut'}))}};
}
export async function createSyntheticCloudWorkerFixture({readOperation,readCurrent,readGenerationSource,persistRenderRecords=false,assetStore,runtime={},roomId='synthetic-room',
  videoFixture={width:160,height:90,fps:4}}={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'vdj-cloud-fixture-')),store=assetStore??createSyntheticPrivateStore();
  let worker,source,projectedOperation;
  try {
    const {width,height,fps}=videoFixture;
    if(![width,height,fps].every(Number.isSafeInteger)||width<2||width>1920||height<2||height>1080||width%2||height%2||fps<1||fps>30)
      throw Error('BOUNDED_SYNTHETIC_VIDEO_GEOMETRY_REQUIRED');
    const videoPath=path.join(directory,'synthetic.mp4'),audio=syntheticWave(40),seed=syntheticWave(24);
    await run(runtime.ffmpeg??'ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',`testsrc2=size=${width}x${height}:rate=${fps}`,'-t','5',
      '-c:v','libx264','-pix_fmt','yuv420p','-an',videoPath]);
    const video=await readFile(videoPath),reference=Buffer.from([137,80,78,71,13,10,26,10]);
    const bootstrap={kind:'owner-supplied-bootstrap'};
    await store.save({id:'seed-input',bytes:seed,contentType:'audio/wav',binding:bootstrap,provenance:bootstrap});
    await store.save({id:'reference-input',bytes:reference,contentType:'image/png',binding:bootstrap,provenance:bootstrap});
    worker=createPortableCloudWorker({enabled:true,assetStore:store,runtime,readVisualPlan:syntheticVisualPlan,persistRenderRecords,
      ...(readGenerationSource?{readGenerationSource}:{}),
      readOperation:readOperation??(async()=>projectedOperation),readCurrent:readCurrent??(async()=>source)});
    source=await worker.prepareBootstrap({audioAssetId:'seed-input',audioSha256:fixtureSha(seed),
      referenceAssetId:'reference-input',referenceSha256:fixtureSha(reference)});
    source.playback.actual=true;
    async function projectOperation(authoritative) {
      const op=structuredClone(authoritative);
      for(const [channel,bytes] of [['music',audio],['video',video]]) {
        const stage=op.stages[channel],assetId=channel+'-'+op.operationId;
        await store.save({id:assetId,bytes,binding:operationBinding(op.roomId??roomId,op,channel),
          contentType:channel==='music'?'audio/wav':'video/mp4',provenance:{kind:'provider',operationId:op.operationId,
            requestId:stage.requestId,resultSha256:stage.result.resultSha256,
            sourceSha256:channel==='music'?op.permit.source.music.contextSha256:op.permit.source.video.referenceSha256}});
        stage.result={...stage.result,assetId,sha256:fixtureSha(bytes)};
      }
      projectedOperation=op;return op;
    }
    // These two adapters replay fabricated bytes/proofs entirely in memory.
    // They allow integration tests to exercise the production ingestion code
    // without a provider request or treating fixtures as real paid generation.
    const readSourceEvidence=async()=>({kind:'verified-source-context-v1',roomId,originKind:'owner-supplied-bootstrap',
      parentAssetId:source.audioAssetId,parentSha256:source.music.sha256,contextAssetId:source.contextAssetId,
      contextSha256:source.music.contextSha256,referenceAssetId:source.referenceAssetId,
      referenceSha256:source.video.referenceSha256,contextSeconds:16,serverAudioQC:true});
    const fetchProviderFixture=async(url,init)=>{
      if(init?.redirect!=='error'||init?.credentials!=='omit')throw Error('FIXTURE_TRANSPORT_CONTRACT_REQUIRED');
      const music=new URL(url).pathname.endsWith('.wav'),bytes=music?audio:video;
      return new Response(bytes,{headers:{'Content-Type':music?'audio/wav':'video/mp4','Content-Length':String(bytes.length)}});
    };
    return {worker,source,store,projectOperation,readSourceEvidence,fetchProviderFixture,
      async cleanup(){await worker.close();await rm(directory,{recursive:true,force:true});}};
  } catch(error) {await worker?.close();await rm(directory,{recursive:true,force:true});throw error;}
}
