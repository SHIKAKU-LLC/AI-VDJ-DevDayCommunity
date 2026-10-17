import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createPlayerObserverStore,PLAYER_OBSERVER_SQL} from '../cloud/jobs/player-observer-store.mjs';
import {createPlayerObserverRegistry} from '../cloud/jobs/player-observer-registry.mjs';
import {createImmutableSourceStartReceiptStore} from '../cloud/jobs/source-start-receipts.mjs';
import {createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';
import {cueDigest} from '../snapshot/app/runtime/intent-compiler.mjs';
const owner='a'.repeat(64),RATE=44100,sha=pcm=>createHash('sha256').update(new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength)).digest('hex');
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['cloud/room/schema.sql','cloud/generation/schema.sql','cloud/generation/cue-operations.sql','cloud/jobs/player-observer-state.sql'])
  await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
 const uid='11111111-1111-4111-a111-111111111111';await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);
 const room=(await db.query("select public.vdj_room_request('create',null,null,$1::jsonb,$2) value",
  [JSON.stringify({ownerCapability:owner,joinCode:'b'.repeat(64)}),uid])).rows[0].value;
 const ports=createExistingCloudRepositoryReadPorts({query:(q,v)=>db.query(q,v),hostGenerationRead:async()=>({roomId:room.roomId,cues:[],currentCredit:null,pending:false,stopped:false})});
 const scope=await ports.readScope({roomId:room.roomId}),identity={roomId:scope.roomId,['sessionId']:scope.sessionId,controlRevision:scope.controlRevision};
 const store=createPlayerObserverStore({query:(q,v)=>db.query(q,v),withOwnerAuthorization:async(s,call)=>call({...s,ownerCapability:owner})});
 const pcm=Float32Array.from({length:24*RATE*2},(_,n)=>Math.sin(n*.01)*.1),binding={kind:'source',assetId:'synthetic-seed',sha256:'d'.repeat(64),contextSha256:'e'.repeat(64),playbackRevision:0};
 const registry=createPlayerObserverRegistry({enabled:true,roomId:room.roomId,origin:'https://vdj.example',store,
  readScope:ports.readScope,readPlaybackState:ports.readPlaybackState,authorizeOwner:async()=>true,
  readVerifiedMaterial:async()=>({binding,pcm,originFrame:0,queuedFrames:24*RATE,maximumDurationFrames:24*RATE})});
 const graph=await registry.register({sampleRate:RATE,sourceCount:1,consumedFrames:0,receivedFrames:0,contextState:'running'});
 await registry.observe({targetPlayerId:graph.targetPlayerId,graphEpoch:graph.graphEpoch,sequence:1,binding,sampleRate:RATE,sourceCount:1,
  contextState:'running',consumedFrames:512,receivedFrames:24*RATE,underrunFrames:0,stopped:false,windowStartFrame:0,windowPCM:Array.from(pcm.subarray(0,512)),video:null});
 const processed=sha(pcm.subarray(0,512)),ack={kind:'cloud-source-playback-started-v1',graphEpoch:graph.graphEpoch,
  sourceClipId:binding.assetId,sourceSha256:binding.sha256,sourceContextSha256:binding.contextSha256,sourcePlaybackRevision:0,
  sampleRate:RATE,playedUntilFrame:512,processedWindowSha256:processed,actual:true,audioStarted:true,participantCredit:false};
 const body={kind:'immutable-source-start-receipt-v1',...identity,targetPlayerId:graph.targetPlayerId,graphEpoch:graph.graphEpoch,
  sourceClipId:binding.assetId,sourceSha256:binding.sha256,sourceContextSha256:binding.contextSha256,sourcePlaybackRevision:0,
  startMode:'bootstrap',maximumDurationFrames:24*RATE,queuedPrefixFrames:24*RATE,queuedPrefixSha256:sha(pcm),processedWindowSha256:processed,
  continuationPlanSha256:null,continuationRenderSha256:null,authoritySha256:'f'.repeat(64),ackSha256:cueDigest(ack),ack,
  serverReceivedAtMs:Date.now(),actual:true,sourceOnly:true,participantCredit:false};
 const receipt={...body,receiptSha256:cueDigest(body)},key={...identity,targetPlayerId:graph.targetPlayerId,graphEpoch:graph.graphEpoch};
 const make=()=>createImmutableSourceStartReceiptStore({readRecord:({reference})=>store.readSourceStartReceipt(reference),
  putIfAbsent:({reference,record})=>store.putSourceStartReceipt(reference,record)});
 return {db,uid,scope:identity,store,registry,receipt,key,make};
}
test('durable source-only journal preserves immutable duplicate ACK and observer CAS, across fresh adapters without Storage',async t=>{
 const x=await fixture(t),before=await x.store.read(x.scope),saved=await x.make().saveImmutable(x.receipt);
 assert.equal(saved.duplicate,false);assert.deepEqual(await x.make().read(x.key),x.receipt);
 assert.equal((await x.make().saveImmutable(x.receipt)).duplicate,true);assert.deepEqual(await x.store.read(x.scope),before);
 const changed=structuredClone(x.receipt);changed.authoritySha256='0'.repeat(64);delete changed.receiptSha256;changed.receiptSha256=cueDigest(changed);
 await assert.rejects(x.make().saveImmutable(changed),/ACK_CONFLICT/);
 const row=(await x.db.query('select operations from vdj_internal.rooms where id=$1',[x.scope.roomId])).rows[0];
 assert.equal(Object.keys(row.operations.__source_start_receipts_v1.records).length,1);
 assert.deepEqual((await x.db.query("select has_function_privilege('anon',$1,'execute') a,has_function_privilege('authenticated',$1,'execute') u",
  ['vdj_internal.player_observer_state(text,uuid,text,uuid,bigint,bigint,jsonb)'])).rows[0],{a:false,u:false});
});
test('unmodified PostgreSQL clock, physical window, stopped graph and disabled owner reject new receipt writes',async t=>{
 for(const mutation of ['stale','future','stopped','owner','control','expired-graph','wrong-window']){
  const x=await fixture(t);
  if(mutation==='stale'||mutation==='future')await x.db.query("update vdj_internal.rooms set operations=jsonb_set(operations,'{__player_observer_v1,record,observation,serverObservedAtMs}',$1::jsonb) where id=$2",
   [JSON.stringify(Date.now()+(mutation==='stale'?-6000:6000)),x.scope.roomId]);
  if(mutation==='stopped')await x.registry.stop({current:true});
  if(mutation==='owner')await x.db.query('update vdj_internal.owners set enabled=false where uid=$1',[x.uid]);
  if(mutation==='control')await x.db.query('update vdj_internal.rooms set control_revision=control_revision+1 where id=$1',[x.scope.roomId]);
  if(mutation==='expired-graph')await x.db.query("update vdj_internal.rooms set operations=jsonb_set(operations,'{__player_observer_v1,record,graph,expiresAtMs}',$1::jsonb) where id=$2",
   [JSON.stringify(Date.now()-1),x.scope.roomId]);
  if(mutation==='wrong-window'){x.receipt.processedWindowSha256='0'.repeat(64);x.receipt.ack.processedWindowSha256='0'.repeat(64);
   x.receipt.ackSha256=cueDigest(x.receipt.ack);delete x.receipt.receiptSha256;x.receipt.receiptSha256=cueDigest(x.receipt);}
  await assert.rejects(x.make().saveImmutable(x.receipt),/STORE_HOLD/);
 }
});
test('atomic observed SQL save needs one mutation; an unknown reply reads the same key without replay',async t=>{
 for(const loseReply of [false,true]){
  const x=await fixture(t);let writes=0,reads=0;
  const store=createImmutableSourceStartReceiptStore({readRecord:async({reference})=>{reads++;return x.store.readSourceStartReceipt(reference);},
   putIfAbsent:()=>assert.fail('ordinary write must not run'),putObservedIfAbsent:async({reference,record})=>{
    writes++;const result=await x.store.putSourceStartReceipt(reference,record);
    if(loseReply)throw Error('synthetic lost committed SQL response');return result;}});
  const saved=await store.saveObservedImmutable(x.receipt);assert.deepEqual(saved.record,x.receipt);
  assert.equal(writes,1);assert.equal(reads,loseReply?1:0);
 }
});
