import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createPrivateMediaIngestion,createImmutableIngestionReceiptStore} from '../cloud/worker/private-ingestion.mjs';
import {createSyntheticCloudWorkerFixture} from './cloud-worker-fixture.mjs';
import {createCloudGenerationJobs} from '../cloud/jobs/generation-jobs.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import {createCueCoordinator} from '../cloud/generation/cue-coordinator.mjs';
import {createCueHandler} from '../cloud/generation/cue-http.mjs';
import {createCloudPlaybackAdapter,createCloudOwnerPlaybackController} from '../room-web/cloud-playback.mjs';
import {createAudioOutputLease} from '../room-web/playback/output-lease.mjs';
import {createVideoAdapter} from '../snapshot/ui/app/scene-video-adapter.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
const owner='a'.repeat(64),guest='b'.repeat(64),invite='c'.repeat(64),rate=44100;
const operationId='operation_'+ 'e'.repeat(24),permitId='permit_'+ 'p'.repeat(24);
const until=async fn=>{for(let i=0;i<5000;i++){if(await fn())return;await new Promise(r=>setTimeout(r,1));}assert.fail('fixture did not advance');};
class Video {
 constructor(){this.style={};this.videoWidth=160;this.videoHeight=90;this.readyState=3;this.currentTime=0;this.frames=new Map();this.next=0;}
  get currentSrc(){return this.src;}
 setAttribute(){} removeAttribute(k){if(k==='src')delete this.src;} addEventListener(){} removeEventListener(){} load(){} pause(){} remove(){}
 play(){return Promise.resolve();} requestVideoFrameCallback(fn){const n=++this.next;this.frames.set(n,fn);return n;}
 cancelVideoFrameCallback(n){this.frames.delete(n);} present(){for(const[n,fn]of this.frames){this.frames.delete(n);fn(0,{});}}
}
// All provider receipts, credentials, guests and media below are fabricated.
// Native QC is real; playback observations are simulated, never hardware claims.
test('synthetic durable generation -> native QC -> atomic reservation -> verified browser media -> actual-observation ACK reconciliation',
 {skip:!process.env.VDJ_QC_PYTHON},async t=>{
 const db=new PGlite();let fixture,ingestion,port,host,room;
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql'])
   await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
  const uid='11111111-1111-4111-a111-111111111111';await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);
  const roomCall=async(op,capability,payload={},verified=null)=>(await db.query('select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) r',
   [op,room?.roomId??null,capability,JSON.stringify(payload),verified])).rows[0].r;
  room=await roomCall('create',null,{ownerCapability:owner,joinCode:invite},uid);
  await roomCall('join',invite,{nickname:'fixture guest',participantCapability:guest});
  const submission=await roomCall('submit',guest,{nonce:'submit_'+ 's'.repeat(24),prompt:'静かな星空へ、光を広げて'});
  const repository={request:async(action,id,capability,payload)=>(await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) r',
   [action,id,capability,JSON.stringify(payload)])).rows[0].r};
  fixture=await createSyntheticCloudWorkerFixture({roomId:room.roomId,
   runtime:{python:process.env.VDJ_QC_PYTHON,ffmpeg:process.env.VDJ_QC_FFMPEG??'ffmpeg',ffprobe:process.env.VDJ_QC_FFPROBE??'ffprobe'},
   readOperation:input=>ingestion.readOperation(input)});
  const receipts=new Map();
  ingestion=createPrivateMediaIngestion({enabled:true,readOperation:async input=>({...await repository.request('read',input.roomId,owner,{operationId:input.operationId}),roomId:input.roomId}),
   assetStore:fixture.store,receiptStore:createImmutableIngestionReceiptStore({readRecord:async({id})=>receipts.get(id),
    putIfAbsent:async({id,record})=>{if(!receipts.has(id))receipts.set(id,record);}}),
   readSourceEvidence:fixture.readSourceEvidence,fetchImpl:fixture.fetchProviderFixture});
  const now=Date.now(),source=fixture.source;
  const permit={permitId,kind:GENERATION_CONTRACT.version,counts:GENERATION_CONTRACT.counts,createdAtMs:now,expiresAtMs:now+600000,
   maximumUsd:1,source,sourceSha256:cueDigest(cueSourceIdentity(source)),visualPolicy:TECHNICAL_VISUAL_POLICY,
   quote:{verified:true,evidenceSha256:'1'.repeat(64),observedAtMs:now,maximumUsd:{intent:.01,music:.1,video:.5}},
   balance:{usd:2,autoTopUp:false,observedAtMs:now},assets:{context:{url:'https://synthetic.supabase.co/private/context',private:true,
    checksumVerified:true,sha256:source.music.contextSha256,expiresAtMs:now+660000,serverAudioQC:true,providerOriginVerified:true},
    reference:{url:'https://synthetic.supabase.co/private/reference',private:true,checksumVerified:true,sha256:source.video.referenceSha256,expiresAtMs:now+660000}}};
  await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
   select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`,[permitId,room.roomId,JSON.stringify(permit)]);
  const posts=[],provider={async submit({model}){posts.push(model);return {request_id:'fixture-request-'+posts.length};},
   async status(){return {status:'COMPLETED'};},async result({model}){return {data:model===GENERATION_CONTRACT.intent?
    {output:JSON.stringify({needsClarification:false,question:'',interpretation:'静かに光を広げる',direction:'down',intensity:.5,
     visualOpenness:'increase',musicDevelopment:'Preserve pulse and reduce competing layers.',visualDevelopment:'Open geometry and preserve detail.'}),usage:{cost:.001}}:
    model===GENERATION_CONTRACT.music?{audio:{url:'https://v3.fal.media/fixture.wav'}}:{video:{url:'https://v3.fal.media/fixture.mp4'}}};}};
  const coordinator=createCueCoordinator({enabled:true,repository,inspectGeneration:fixture.worker.inspectGeneration,
   readCurrent:fixture.worker.readCurrent,inspectJoin:fixture.worker.inspectJoin});
  const options={enabled:true,repository,provider,mediaHost:'synthetic.supabase.co',coordinator,
   credentialForOperation:async()=> 'synthetic-only-credential',prepareMedia:ingestion.prepareMedia};
  let jobs=createCloudGenerationJobs(options),input={roomId:room.roomId,operationId,ownerCapability:owner};
  await jobs.start({...input,permitId,submissionId:submission.submissionId});await jobs.advance(input);
  assert.deepEqual(posts,[GENERATION_CONTRACT.intent]);
  jobs=createCloudGenerationJobs(options); // Process replacement, no Mac/browser dependency.
  await jobs.advance(input);assert.equal(posts.length,3);
  const ready=await jobs.advance(input);assert.equal(ready.state,'READY');assert.equal(ready.playerAcknowledged,false);
  assert.equal((await jobs.advance(input)).state,'READY');assert.equal(posts.length,3);
  const cues=createCueHandler({coordinator}),videos=[],listeners=new Set();let prepared,commits=0,lostAck=false;
  const request=async(path,opts)=>{const res=await cues(new Request('https://ai-vdj.vercel.app'+path,
   {...opts,headers:new Headers({...Object.fromEntries(opts.headers),'Content-Type':'application/json',Origin:'https://ai-vdj.vercel.app'}),body:JSON.stringify(opts.body)}));
   const data=await res.json();if(!res.ok)throw Error(data.error);
   if(path.endsWith('/ack')&&!lostAck){lostAck=true;throw Error('synthetic lost response');}return data;};
  port=createCloudPlaybackAdapter({enabled:true,fixtureMode:true,origin:'https://ai-vdj.vercel.app',
   lifecycle:{addEventListener(){},removeEventListener(){}},container:{append(){}},
   outputLease:createAudioOutputLease({locks:{request:async(name,options,callback)=>callback({name})}}),urlAPI:{createObjectURL(){return 'blob:synthetic';},revokeObjectURL(){}},
   resolveManifest:async payload=>{
    const state=await coordinator.execute({action:'state',...input}),cue=state.cues.find(c=>c.cueId===payload.cueId);
    const desc=await fixture.worker.describeRender({roomId:room.roomId,cue,plan:payload.plan,expectedRevision:1});
    const render=Object.fromEntries(['assetId','sha256','byteLength','mimeType','renderedFileSha256','renderedPcmSha256','sampleRate','startFrame','durationFrames','expectedPlayedWindowSha256'].map(k=>[k,desc[k]]));
    return {roomId:room.roomId,cueId:cue.cueId,generationId:cue.generationId,submissionId:cue.submissionId,
     controlVersion:cue.controlVersion,commonIntentSha256:cue.commonIntentSha256,audio:{...cue.music.asset,render},
     videos:await Promise.all(cue.video.clips.map(async c=>({assetId:c.assetId,sha256:c.sha256,
      byteLength:(await fixture.store.read(c.assetId)).byteLength,mimeType:'video/mp4',source:'provider-response-replay',requestId:(await repository.request('read',room.roomId,owner,{operationId})).stages.video.requestId})))};
   },request:async path=>{const id=path.split('/media/')[1].split('?')[0],record=await fixture.store.read(id);
    return new Response(record.bytes,{headers:{'Content-Type':Buffer.from(record.bytes).subarray(0,4).toString()==='RIFF'?'audio/wav':'video/mp4','Content-Length':String(record.byteLength)}});},
   createAudioEngine:({loadVerifiedRender})=>({context:{resume(){return Promise.resolve();}},readState:()=>({sourceCount:1,contextState:'running'}),
    prepare:loadVerifiedRender,async commit(p){prepared=p;commits++;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async stop(){}}),
   createVideoAdapter:opts=>createVideoAdapter({...opts,crossfadeMs:0,fetchImpl(){throw Error('network forbidden');}}),
   videoFactory:()=>{const video=new Video();videos.push(video);return video;}});
  await port.unlock();let playingResolve,hostState;const playing=new Promise(r=>playingResolve=r);
  host=createCloudOwnerPlaybackController({outputPort:{...port,async stop(reason){await port.stop(reason);return {stopped:true,graphStopConfirmed:true};}},request,roomId:room.roomId,ownerCapability:owner,
   lifecycle:{addEventListener(){},removeEventListener(){}},schedule:()=>null,cancel(){},onState:s=>{hostState=s;if(s.state==='PLAYING')playingResolve(s);}});
  await host.start();await until(()=>commits===1||port.read().phase==='HOLD'||hostState?.state==='HOLD');
  assert.equal(commits,1,JSON.stringify(hostState??port.read()));assert.equal((await coordinator.execute({action:'state',...input})).currentCredit,null);
  assert.equal((await jobs.read(input)).reservationAcknowledged,true);assert.equal((await jobs.read(input)).playerAcknowledged,false);
  for(const fn of listeners)fn({telemetry:{sampleRate:rate,consumedFrames:prepared.startFrame+256,underrunFrames:0,stopped:false}});
  assert.equal(port.read().audioStarted,false);
  for(const fn of listeners)fn({playedWindow:{startFrame:prepared.startFrame,pcm:prepared.pcm.slice(prepared.startFrame*2,(prepared.startFrame+256)*2).buffer}});
  await until(()=>videos.some(v=>v.frames.size));assert.equal((await coordinator.execute({action:'state',...input})).currentCredit,null);
  videos.forEach(v=>v.present());const accepted=await Promise.race([playing,new Promise((_,reject)=>setTimeout(()=>reject(Error('fixture ACK timeout')),3000))]);
  assert.equal(accepted.currentCredit.nickname,'fixture guest');assert.equal(lostAck,true);assert.equal(commits,1,'lost server reply never replays');
  assert.equal((await jobs.read(input)).playerAcknowledged,true);assert.equal((await coordinator.execute({action:'state',...input})).servedCounts[submission.participantId],1);
  await host.stop();assert.equal(port.read().phase,'STOPPED');
 }finally{await host?.dispose();await port?.dispose();await ingestion?.close();await fixture?.cleanup();await db.close();}
});
