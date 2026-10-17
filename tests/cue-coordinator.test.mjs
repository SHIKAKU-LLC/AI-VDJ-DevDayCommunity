import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {renderSpec, transitionDigest} from '../snapshot/app/runtime/dj-transition-selector.mjs';
import {buildVerifiedCue, operationBinding} from '../cloud/generation/cue-contract.mjs';
import {createCueCoordinator} from '../cloud/generation/cue-coordinator.mjs';
import {createCueHandler} from '../cloud/generation/cue-http.mjs';
import {createOwnerCueHost} from '../room-web/owner-cue-host.mjs';
import {registrationEvidence} from '../integration/qc/registration-evidence.mjs';
import {validatePlaybackCue} from '../room-web/playback/cue-contract.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';

const owner='a'.repeat(64), guest='b'.repeat(64), invite='c'.repeat(64);
const h=n=>n.repeat(64);
const opId='operation_'+ 'x'.repeat(24), permitId='permit_'+ 'p'.repeat(24);
const measured=value=>({value,confidence:'measured',confidenceScore:.95});
function profile(sha256){return{method:'pcm-endpoint-profile-v1',assetSha256:sha256,sampleRate:44100,channels:2,
  frameCount:1058400,rmsDbfs:-18,head:{rmsDbfs:-18,bandFractions:[.4,.4,.2]},tail:{rmsDbfs:-18,bandFractions:[.4,.4,.2]},
  bpm:measured(140),key:measured('8A')};}
async function setup() {
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for(const path of ['../cloud/room/schema.sql','../cloud/generation/schema.sql','../cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL(path,import.meta.url),'utf8'));
  const uid='11111111-1111-4111-a111-111111111111';await db.query('insert into vdj_internal.owners(uid) values($1)',[uid]);
  let room=null;
  const roomCall=async(op,capability,payload={},verified_uid=null)=>(await db.query(
    'select public.vdj_room_request($1,$2,$3,$4::jsonb,$5) r',[op,room?.roomId??null,capability,JSON.stringify(payload),verified_uid])).rows[0].r;
  room=await roomCall('create',null,{ownerCapability:owner,joinCode:invite},uid);
  await roomCall('join',invite,{nickname:'synthetic guest',participantCapability:guest});
  const submission=await roomCall('submit',guest,{nonce:'submit_'+ 's'.repeat(24),prompt:'synthetic scene'});
  const source={music:{clipId:'current',contextSha256:h('d'),contextSeconds:16,contextVerified:true,ready:true,
    control:{version:1,energy:.5,tension:.5,density:.5,brightness:.5}},video:{motifId:'synthetic',
    motifSnapshotSha256:h('e'),referenceSha256:h('f')},quality:{fixedBpm:140}};
  const permit={source,sourceSha256:cueDigest(cueSourceIdentity(source))};
  await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
    select $1,id,epoch,control_revision,now()+interval '1 hour',$3::jsonb from vdj_internal.rooms where id=$2`,[permitId,room.roomId,JSON.stringify(permit)]);
  const op={operationId:opId,submissionId:submission.submissionId,prompt:submission.prompt,permit,stopped:false,
    plan:{status:'COMPILED',commonIntentSha256:h('2'),common:{cueId:'cue-'+opId,control:{version:2}}},
    stages:{music:{state:'COMPLETE',requestId:'music_request',result:{resultSha256:h('3')}},
      video:{state:'COMPLETE',requestId:'video_request',result:{resultSha256:h('4')}}}};
  await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',[opId,permitId,room.roomId,JSON.stringify(op)]);
  const music={binding:operationBinding(room.roomId,op,'music'),durationSeconds:24,asset:{assetId:'incoming',sha256:h('6')},
    providerReceipt:{requestId:'music_request',resultSha256:h('3')},qc:{passed:true,scope:'synthetic'},privateSaved:true,checksumVerified:true,
    parentClipId:'current',contextSha256:h('d'),contextVerified:true,continuationVerified:true,profile:profile(h('6'))};
  const video={binding:operationBinding(room.roomId,op,'video'),durationSeconds:24,asset:{assetId:'timeline',sha256:h('7')},
    providerReceipt:{requestId:'video_request',resultSha256:h('4')},qc:{passed:true,scope:'synthetic'},privateSaved:true,checksumVerified:true,
    compositionQC:{passed:true},review:{accepted:true,ownerArtisticApproval:true,assetSha256:h('7'),commonIntentSha256:h('2')},
    clips:[{assetId:'clip',sha256:h('8'),durationSeconds:5,qcPassed:true,approved:true,providerRequestId:'video_request',providerResultSha256:h('4')}],
    timeline:{durationSeconds:24,timeStretch:false,approvedLoops:true,segments:[0,5,10,15,20].map(start=>({assetId:'clip',sha256:h('8'),
      startSeconds:start,endSeconds:Math.min(start+5,24),sourceInSeconds:0,sourceOutSeconds:Math.min(5,24-start),playbackRate:1}))}};
  const evidence={actualGenerationThisRun:true,mode:'provider',music,video}; // Synthetic adapter receipt only; no live media claim.
  const current={actual:true,clipId:'current',sha256:h('5'),contextSha256:h('d'),profile:profile(h('5')),playbackRevision:0,playedUntilFrame:1000};
  const pair={method:'rendered-transition-qc-v1',timeStretch:false,pitchShift:false,passed:true,currentSha256:h('5'),incomingSha256:h('6'),
    currentPlaybackRevision:0,currentFrameCount:1058400,incomingFrameCount:1058400,sampleRate:44100,type:'native-continuation',
    entryFrame:0,exitFrame:1058400,overlapFrames:0,relativeIncomingGainDb:0,eqCurves:null,nativeContinuationVerified:true,
    parentSha256:h('5'),contextSha256:h('d'),contextAnchorFrame:1058400,bassCollisionManaged:true,loudnessVerified:true,
    renderedSha256:h('9'),renderedFrameCount:2116800,renderQC:{passed:true},renderMetrics:{truePeakDbtp:-1,clippedFraction:0,
      nonfiniteSamples:0,maxQuietRunSeconds:0,minimumWindowDbfs:-24,maxLevelStepDb:1,seamJump:.01,bassDoubleOwnershipFrames:0,
      overlapLowBandLiftDb:0,integratedLufs:-16,loudnessRangeLu:2}};
  pair.renderSpecSha256=transitionDigest(renderSpec(pair));
  const repository={request:async(action,roomId,capability,payload)=>(await db.query(
    'select public.vdj_generation_request($1,$2,$3,$4::jsonb) r',[action,roomId,capability,JSON.stringify(payload)])).rows[0].r};
  const coordinator=createCueCoordinator({enabled:true,repository,inspectGeneration:async()=>evidence,
    readCurrent:async()=>current,inspectJoin:async()=>pair});
  const execute=(action,extra={})=>coordinator.execute({action,roomId:room.roomId,ownerCapability:owner,...extra});
  return{db,room,roomCall,op,evidence,current,pair,repository,coordinator,execute};
}

test('same-set saved QC registers one immutable cue; five-second clip stays in full approved timeline',async()=>{
  const x=await setup();try{
    const bad=structuredClone(x.evidence);bad.video.durationSeconds=5;
    assert.throws(()=>buildVerifiedCue({roomId:x.room.roomId,operation:x.op,evidence:bad}),/BOUND_SAVED_AV_QC/);
    bad.video.durationSeconds=24;bad.video.timeline.approvedLoops=false;
    assert.throws(()=>buildVerifiedCue({roomId:x.room.roomId,operation:x.op,evidence:bad}),/TIMELINE_GAP/);
    const cue=await x.execute('publish',{operationId:opId});assert.equal(cue.video.timeline.durationSeconds,24);
    assert.equal(cue.video.clips[0].durationSeconds,5);assert.equal(cue.status,'READY');assert.equal(cue.playbackRevision,null);
    assert.equal(cue.contribution.nickname,'synthetic guest');
    const same=await x.execute('publish',{operationId:opId});assert.deepEqual(same,cue);
    assert.equal((await x.execute('state')).cues.length,1);
  }finally{await x.db.close();}
});
test('required publication authority cannot be absent or borrowed from another operation',async()=>{
  const x=await setup();let inspections=0;
  try{
    const options={enabled:true,requireAuthority:true,repository:x.repository,inspectGeneration:async()=>{inspections++;return x.evidence;}};
    const input={action:'publish',roomId:x.room.roomId,ownerCapability:owner,operationId:opId};
    await assert.rejects(createCueCoordinator(options).execute(input),/CUE_AUTHORITY_GUARD_REQUIRED/);
    const wrong=createCueCoordinator({...options,authorityGuard:{assert:async request=>({kind:'cloud-dispatch-authority-v1',
      roomId:request.roomId,operationId:'other-operation',phase:request.phase})}});
    await assert.rejects(wrong.execute(input),/CUE_AUTHORITY_HOLD/);
    assert.equal(inspections,0);assert.equal((await x.execute('state')).cues.length,0);
  }finally{await x.db.close();}
});
test('a source change or global Stop during QC prevents the guarded publication write',async()=>{
  for(const change of ['source','stop']){
    const x=await setup();const phases=[];
    try{
      const authorityGuard={assert:async input=>{
        phases.push(input.phase);
        const state=await x.repository.request('cueState',input.roomId,input.ownerCapability,{});
        if(state.stopped||x.current.sha256!==h('5'))throw Error('SYNTHETIC_SOURCE_OR_STOP_HOLD');
        return{kind:'cloud-dispatch-authority-v1',roomId:input.roomId,operationId:input.operationId,phase:input.phase};
      }};
      const coordinator=createCueCoordinator({enabled:true,requireAuthority:true,repository:x.repository,authorityGuard,
        inspectGeneration:async()=>{if(change==='stop')await x.execute('stop');else x.current.sha256=h('0');return x.evidence;}});
      await assert.rejects(coordinator.execute({action:'publish',roomId:x.room.roomId,ownerCapability:owner,operationId:opId}),/SOURCE_OR_STOP_HOLD/);
      assert.deepEqual(phases,['qc-before-inspect','qc-before-publish']);assert.equal((await x.execute('state')).cues.length,0);
    }finally{await x.db.close();}
  }
});
test('a Stop during the publication RPC suppresses a READY reply; the existing write is not claimed rolled back',async()=>{
  const x=await setup();const phases=[];
  try{
    const authorityGuard={assert:async input=>{
      phases.push(input.phase);const state=await x.repository.request('cueState',input.roomId,input.ownerCapability,{});
      if(state.stopped)throw Error('SYNTHETIC_SOURCE_OR_STOP_HOLD');
      return{kind:'cloud-dispatch-authority-v1',roomId:input.roomId,operationId:input.operationId,phase:input.phase};
    }};
    const repository={request:async(...args)=>{const result=await x.repository.request(...args);
      if(args[0]==='cuePublish')await x.execute('stop');return result;}};
    const coordinator=createCueCoordinator({enabled:true,requireAuthority:true,repository,authorityGuard,inspectGeneration:async()=>x.evidence});
    await assert.rejects(coordinator.execute({action:'publish',roomId:x.room.roomId,ownerCapability:owner,operationId:opId}),/SOURCE_OR_STOP_HOLD/);
    assert.deepEqual(phases,['qc-before-inspect','qc-before-publish','qc-after-publish']);
    const state=await x.execute('state');assert.equal(state.stopped,true);assert.equal(state.cues.length,1);assert.equal(state.currentCredit,null);
  }finally{await x.db.close();}
});
test('failed, mismatched or unreviewed evidence cannot create a cue',async()=>{
  const x=await setup();try{
    const partial=structuredClone(x.op);partial.stages.video.state='SUBMITTED';
    assert.throws(()=>buildVerifiedCue({roomId:x.room.roomId,operation:partial,evidence:x.evidence}),/COMPLETE_AV_REQUIRED/);
    for(const mutate of [e=>{e.music.qc.passed=false;},e=>{e.video.binding.submissionId='different';},
      e=>{e.video.review.accepted=false;},e=>{e.video.timeline.segments[1].startSeconds=6;},
      e=>{e.music.providerReceipt.resultSha256=h('0');}]){
      const e=structuredClone(x.evidence);mutate(e);
      assert.throws(()=>buildVerifiedCue({roomId:x.room.roomId,operation:x.op,evidence:e}));
    }
    assert.equal((await x.execute('state')).cues.length,0);
    await assert.rejects(x.coordinator.execute({action:'publish',roomId:x.room.roomId,ownerCapability:guest,operationId:opId}),/OWNER_DENIED/);
  }finally{await x.db.close();}
});
test('QC registration bridge and browser port agree on the immutable full-cue shape',async()=>{
  const x=await setup();try{
    // Test-only trusted receipts exercise interface composition; no provider was called.
    const music={...x.evidence.music,status:'QC_READY',actualGenerationThisRun:true};
    const original=x.evidence.video;
    const video={...original,status:'QC_READY',actualGenerationThisRun:true,compositionQC:{passed:true,reviewId:'synthetic-review',
      timeline:{segments:original.timeline.segments.map(s=>({clipId:s.assetId,startSeconds:s.startSeconds,endSeconds:s.endSeconds,
        inSeconds:s.sourceInSeconds,outSeconds:s.sourceOutSeconds,overlapSeconds:0,transition:'cut'}))},
      clips:original.clips.map(c=>({clipId:c.assetId,sha256:c.sha256,measurement:{durationSeconds:c.durationSeconds},
        providerReceipt:{requestId:c.providerRequestId,resultSha256:c.providerResultSha256}}))}};
    const bridged=await registrationEvidence({music,video,expectedBinding:music.binding,verifySaved:async({binding,asset})=>({
      privateSaved:true,checksumVerified:true,binding,assetId:asset.assetId,sha256:asset.sha256})});
    assert.equal(bridged.status,'QC_READY');
    const cue=buildVerifiedCue({roomId:x.room.roomId,operation:x.op,evidence:bridged.evidence});
    assert.equal(validatePlaybackCue({roomId:x.room.roomId,cue,plan:{cueId:cue.cueId},expectedRevision:1}),cue);
    assert.equal(cue.video.durationSeconds,24);assert.equal(cue.video.clips[0].durationSeconds,5);
  }finally{await x.db.close();}
});
test('only a frozen technical visual policy can replace per-material artistic approval',async()=>{
 const x=await setup();try{
  const evidence=structuredClone(x.evidence),policySha256=cueDigest(TECHNICAL_VISUAL_POLICY);
  evidence.video.review={...evidence.video.review,kind:'technical-qc',ownerArtisticApproval:false,policySha256};
  evidence.video.compositionQC={passed:true,visualPolicySha256:policySha256,approval:{kind:'technical-qc'},clips:[{
    measurement:{decodedFrames:100,technicalStats:{method:'full-frame-luma-motion-v1',frames:100,
      nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.01,maximumLargeLumaTransitionsPerSecond:0}}}]};
  assert.throws(()=>buildVerifiedCue({roomId:x.room.roomId,operation:x.op,evidence}),/TIMELINE_REVIEW/);
  x.op.permit.visualPolicy=TECHNICAL_VISUAL_POLICY;
  const cue=buildVerifiedCue({roomId:x.room.roomId,operation:x.op,evidence});
  assert.equal(cue.video.review.ownerArtisticApproval,false);
  assert.equal(validatePlaybackCue({roomId:x.room.roomId,cue,plan:{cueId:cue.cueId},expectedRevision:1}),cue);
 }finally{await x.db.close();}
});
test('reservation has no credit; only matching actual AV ACK credits once and survives response loss',async()=>{
  const x=await setup();try{
    await x.execute('publish',{operationId:opId});const r=await x.execute('reserve');
    assert.equal(r.cue.status,'SELECTED');assert.equal((await x.execute('state')).currentCredit,null);
    assert.equal((await x.execute('check',{reservationId:r.reservationId})).valid,true);
    const ack={roomId:x.room.roomId,cueId:r.cue.cueId,clipId:r.cue.music.asset.assetId,
      playbackRevision:r.expectedRevision,audioTime:1,actual:true,audioStarted:true,videoPresented:true};
    await assert.rejects(x.execute('ack',{reservationId:r.reservationId,ack:{...ack,videoPresented:false}}),/MATCHING_ACTUAL/);
    assert.equal((await x.execute('state')).currentCredit,null);
    const done=await x.execute('ack',{reservationId:r.reservationId,ack});assert.equal(done.currentCredit.nickname,'synthetic guest');
    const repeated=await x.execute('ack',{reservationId:r.reservationId,ack});assert.equal(repeated.duplicate,true);
    const state=await x.execute('state');assert.equal(state.cues[0].status,'PLAYING');
    assert.equal(Object.values(state.servedCounts)[0],1);
    await assert.rejects(x.execute('ack',{reservationId:r.reservationId,ack:{...ack,audioTime:2}}),/ACK_CONFLICT/);
    assert.equal((await x.execute('check',{reservationId:r.reservationId})).valid,false);
    // Stop returns the sounding Cue to READY for the next Start; its credit
    // history and served count stay, and the old reservation stays completed.
    await x.execute('stop');const stopped=await x.execute('state');
    assert.equal(stopped.cues[0].status,'READY');assert.equal(stopped.currentCredit,null);
    assert.equal(Object.values(stopped.servedCounts)[0],1);
    assert.equal((await x.execute('ack',{reservationId:r.reservationId,ack})).duplicate,true,'no second credit');
  }finally{await x.db.close();}
});
test('missing fresh observation waits before either selection write; an advanced plan is recalculated',async()=>{
 const x=await setup();try{
  await x.execute('publish',{operationId:opId});
  for(const at of [1,2]){
   let reads=0;const writes=[];
   const coordinator=createCueCoordinator({enabled:true,repository:{request:async(...args)=>{writes.push(args[0]);return x.repository.request(...args);}},
    readCurrent:async()=>{if(++reads===at)throw Object.assign(Error('OBSERVER_FRESH_FRONTIER_REQUIRED'),{code:'OBSERVER_FRESH_FRONTIER_REQUIRED'});return x.current;},
    inspectJoin:async()=>x.pair});
   assert.deepEqual(await coordinator.execute({action:'reserve',roomId:x.room.roomId,ownerCapability:owner}),{state:'HOLD',reason:'WAITING_FOR_PLAYBACK_OBSERVATION'});
   assert(!writes.includes('cueReserve'));assert.equal((await x.execute('state')).currentCredit,null);
  }
  let reads=0;const coordinator=createCueCoordinator({enabled:true,repository:x.repository,inspectJoin:async()=>x.pair,
   readCurrent:async()=>({...x.current,playedUntilFrame:++reads===1?0:1058401})});
  assert.deepEqual(await coordinator.execute({action:'reserve',roomId:x.room.roomId,ownerCapability:owner}),{state:'HOLD',reason:'RECOMPUTE_PLAYBACK_PLAN'});
  assert.equal((await x.execute('state')).cues[0].status,'READY');
  const reservation=await x.execute('reserve');assert.equal(reservation.expectedRevision,1);
 }finally{await x.db.close();}
});
test('observation waiting does not hide Stop, owner denial or physical proof failures',async()=>{
 for(const code of ['OBSERVER_STOPPED','OWNER_DENIED','OBSERVER_PHYSICAL_WINDOW_CHANGED']){
  const coordinator=createCueCoordinator({enabled:true,repository:{request:async()=>({cues:[]})},inspectJoin:async()=>{},
   readCurrent:async()=>{throw Object.assign(Error(code),{code});}});
  await assert.rejects(coordinator.execute({action:'reserve',roomId:'11111111-1111-4111-a111-111111111111',ownerCapability:owner}),new RegExp(code));
 }
});
test('room lock rejects a second reservation and stop makes late ACK ineligible',async()=>{
  const x=await setup();try{
    await x.execute('publish',{operationId:opId});
    const attempts=await Promise.allSettled([x.execute('reserve'),x.execute('reserve')]);
    assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
    const r=attempts.find(a=>a.status==='fulfilled').value;
    // An unacknowledged reserved Cue returns to READY on Stop (no credit was
    // earned); the old reservation can still never be acknowledged.
    await x.execute('stop');const state=await x.execute('state');assert.equal(state.currentCredit,null);assert.equal(state.cues[0].status,'READY');
    await assert.rejects(x.execute('ack',{reservationId:r.reservationId,ack:{}}),/PLAYBACK_RESERVATION/);
    await x.db.exec('set role anon');
    await assert.rejects(x.db.query("select public.vdj_generation_request('cueState',null,null,'{}')"),/permission denied/);
  }finally{await x.db.close();}
});
test('source frontier and room control changes invalidate a selected plan',async()=>{
  const x=await setup();try{
    await x.execute('publish',{operationId:opId});const r=await x.execute('reserve');
    x.current.playedUntilFrame=1058401;
    assert.equal((await x.execute('check',{reservationId:r.reservationId})).valid,false);
    assert.equal((await x.execute('check',{reservationId:r.reservationId,phase:'ack'})).valid,true);
    await x.roomCall('control',owner,{nonce:'control_'+ 'q'.repeat(24),expectedRevision:0,accepting:false});
    await assert.rejects(x.execute('check',{reservationId:r.reservationId}),/PLAYBACK_RESERVATION/);
    await assert.rejects(x.execute('check',{reservationId:r.reservationId,phase:'ack'}),/PLAYBACK_RESERVATION/);
    assert.equal((await x.execute('state')).currentCredit,null);
  }finally{await x.db.close();}
});
test('an expired reservation cannot award delayed playback credit',async()=>{
  const x=await setup();try{
    await x.execute('publish',{operationId:opId});const r=await x.execute('reserve');
    await x.db.query("update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime,pending,expiresAtMs}','0'::jsonb) where document ? 'roomRuntime'");
    const ack={roomId:x.room.roomId,cueId:r.cue.cueId,clipId:r.cue.music.asset.assetId,playbackRevision:r.expectedRevision,
      audioTime:1,actual:true,audioStarted:true,videoPresented:true};
    await assert.rejects(x.execute('ack',{reservationId:r.reservationId,ack}),/PLAYBACK_RESERVATION/);
    assert.equal((await x.execute('state')).currentCredit,null);
    // The expired reservation no longer blocks the next one: it is released
    // atomically (its Cue back to READY) and a fresh reservation succeeds.
    const next=await x.execute('reserve');assert.ok(next.reservationId);assert.notEqual(next.reservationId,r.reservationId);
    await assert.rejects(x.execute('ack',{reservationId:r.reservationId,ack}),/PLAYBACK_RESERVATION/,'the released reservation stays unacknowledgeable');
  }finally{await x.db.close();}
});
test('cue HTTP accepts no client QC, plan, credit or provider credential',async()=>{
  let count=0;const handler=createCueHandler({coordinator:{execute:async()=>{count++;return{ok:true};}}});
  const url='https://ai-vdj.vercel.app/api/rooms/11111111-1111-4111-a111-111111111111/cues/publish';
  const headers=new Headers({Origin:'https://ai-vdj.vercel.app','Content-Type':'application/json','X-Room-Owner':owner});
  assert.equal((await handler(new Request(url,{method:'POST',headers,body:JSON.stringify({cue:{atomicReady:true}})}))).status,400);
  headers.set('X-Fal-Key','synthetic-unused');
  assert.equal((await handler(new Request(url,{method:'POST',headers,body:'{}'}))).status,403);assert.equal(count,0);
});
test('host commits once, reconciles lost ACK by GET-equivalent state and never credits on reserve',async()=>{
  const states=[];let commits=0,acked=false,stops=0,activated=0,starts=0;
  const roomId='11111111-1111-4111-a111-111111111111';
  const r={reservationId:'reservation_'+ 'r'.repeat(24),roomId,cue:{cueId:'cue',music:{asset:{assetId:'audio'}}},plan:{},expectedRevision:1};
  const credit={cueId:'cue',playbackRevision:1,actual:true};
  const request=async(path,{headers,body})=>{assert.equal(headers.get('X-Room-Owner'),owner);assert.equal(headers.has('X-Fal-Key'),false);
    if(path.endsWith('/start')){starts++;return{};}if(path.endsWith('/reserve'))return r;
    if(path.endsWith('/check'))return{valid:true};if(path.endsWith('/ack')){acked=true;throw Error('lost response');}
    if(path.endsWith('/state'))return{currentCredit:acked?credit:null};return{};};
  const host=createOwnerCueHost({request,roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},
    activateAudio:()=>{activated++;},stopPlayback:()=>{stops++;return {stopped:true,graphStopConfirmed:true};},onState:s=>states.push(s),
    commitPlayback:async input=>{commits++;assert.equal(await input.guard(),true);return{roomId,cueId:'cue',clipId:'audio',
      playbackRevision:1,audioTime:1,actual:true,audioStarted:true,videoPresented:true};}});
  await Promise.all([host.start(),host.start()]);await host.once();
  assert.equal(commits,1);assert.equal(starts,1);assert.equal(activated,1);
  assert.equal(states[0].state,'STAGING');assert.equal(states.at(-1).state,'PLAYING');
  await host.dispose();assert.equal(stops,1);
});
test('host Stop during preparation prevents a late source ACK from restarting the coordinator',async()=>{
  const roomId='11111111-1111-4111-a111-111111111111';
  let release;const preparation=new Promise(resolve=>{release=resolve;}),actions=[];
  const host=createOwnerCueHost({roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},
    activateAudio:()=>preparation,stopPlayback:async()=>({stopped:true,graphStopConfirmed:true}),commitPlayback:()=>assert.fail('no reservation after Stop'),
    request:async path=>{actions.push(path.split('/').at(-1));return{};}});
  const starting=host.start();await host.stop();release();await starting;
  assert.deepEqual(actions,['stop']);
});
test('host stop invalidates a late successful ACK response',async()=>{
  let entered,finish;const ackEntered=new Promise(r=>{entered=r;}),pending=new Promise(r=>{finish=r;});const states=[];
  const roomId='11111111-1111-4111-a111-111111111111';
  const host=createOwnerCueHost({roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},onState:s=>states.push(s),stopPlayback:async()=>({stopped:true,graphStopConfirmed:true}),
    request:async path=>{if(path.endsWith('/reserve'))return{roomId,reservationId:'reservation_'+ 'z'.repeat(24),
      cue:{cueId:'cue',music:{asset:{assetId:'asset'}}},plan:{},expectedRevision:1};
      if(path.endsWith('/ack')){entered();return pending;}return{};},
    commitPlayback:async()=>({roomId,cueId:'cue',clipId:'asset',playbackRevision:1,audioTime:1,actual:true,audioStarted:true,videoPresented:true})});
  await host.start();const work=host.once();await ackEntered;await host.stop();
  finish({accepted:true,currentCredit:{cueId:'cue',playbackRevision:1,actual:true}});await work;
  assert.equal(states.some(s=>s.state==='PLAYING'),false);assert.equal(states.at(-1).state,'STOPPED');
});

test('prepare reservation and current reads overlap; reservation denial still fails closed',async()=>{
 let rejectReservation,sourceRead=false;
 const coordinator=createCueCoordinator({enabled:true,repository:{request:()=>new Promise((resolve,reject)=>{rejectReservation=reject;})},
  readCurrent:async()=>{sourceRead=true;return{actual:true,playbackRevision:0,playedUntilFrame:256};}});
 const outcome=coordinator.execute({action:'check',roomId:'synthetic',ownerCapability:owner,reservationId:'r'.repeat(24),phase:'prepare'}).catch(e=>e);
 await new Promise(r=>setImmediate(r));assert.equal(sourceRead,true);rejectReservation(Error('RESERVATION_DENIED'));
 assert.match((await outcome).message,/RESERVATION_DENIED/);
});
test('an ACK that cannot be confirmed before its reservation expires stops retrying and asks for Stop -> Start',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111',states=[],actions=[];let stops=0;
 const host=createOwnerCueHost({roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},retryDelayMs:1,
  onState:s=>states.push(s),stopPlayback:()=>{stops++;return {stopped:true,graphStopConfirmed:true};},
  request:async path=>{const action=path.split('/').at(-1);actions.push(action);
   if(action==='reserve')return{roomId,reservationId:'reservation_'+'e'.repeat(24),cue:{cueId:'cue',music:{asset:{assetId:'asset'}}},plan:{},
    expectedRevision:1,expiresAtMs:Date.now()-1};
   if(action==='ack')throw Error('PLAYBACK_RESERVATION_REQUIRED');if(action==='state')return{currentCredit:null};return{};},
  commitPlayback:async()=>({roomId,cueId:'cue',clipId:'asset',playbackRevision:1,audioTime:1,actual:true,audioStarted:true,videoPresented:true})});
 await host.start();await assert.rejects(host.once(),/RESERVATION_EXPIRED_STOP_START_REQUIRED/);
 assert.equal(states.at(-1).reason,'PLAYBACK_RESERVATION_EXPIRED_STOP_START_REQUIRED');
 await assert.rejects(host.once(),/CUE_HOST_NOT_RUNNING/,'no further ACK or reservation retries');
 assert.equal(actions.filter(a=>a==='ack').length,3);assert.equal(stops,0,'the sounding Cue is not stopped');
});
test('an unconfirmed server cue Stop is reported, not rendered as STOPPED',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111',states=[];let fail=true;
 const host=createOwnerCueHost({roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},onState:s=>states.push(s),
  stopPlayback:async()=>({stopped:true,graphStopConfirmed:true}),commitPlayback:()=>assert.fail('no commit'),
  request:async path=>{if(path.endsWith('/stop')&&fail)throw Error('NETWORK');return path.endsWith('/reserve')?{state:'HOLD'}:{};}});
 await host.start();await assert.rejects(host.stop(),/CUE_STOP_UNCONFIRMED/);
 assert.equal(states.at(-1).state,'HOLD');assert.equal(states.some(s=>s.state==='STOPPED'),false);
 fail=false;await host.stop();assert.equal(states.at(-1).state,'STOPPED','Stop can be retried');
});
test('an uncertain commit outcome is never retried as a second commit',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111',states=[];let commits=0;
 const host=createOwnerCueHost({roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},stopPlayback:async()=>({stopped:true,graphStopConfirmed:true}),onState:s=>states.push(s),
  request:async path=>path.endsWith('/reserve')?{roomId,reservationId:'reservation_'+'u'.repeat(24),cue:{cueId:'cue',music:{asset:{assetId:'asset'}}},
   plan:{},expectedRevision:1,expiresAtMs:Date.now()+30000}:{},
  commitPlayback:async()=>{commits++;throw Object.assign(Error('CLOUD_OUTPUT_COMMIT_UNCERTAIN'),{code:'CLOUD_OUTPUT_COMMIT_UNCERTAIN'});}});
 await host.start();for(let i=0;i<50&&states.at(-1)?.state!=='HOLD';i++)await new Promise(r=>setImmediate(r));
 assert.equal(states.at(-1).reason,'CLOUD_OUTPUT_COMMIT_UNCERTAIN');assert.equal(commits,1,'the pumped reservation is committed once');
});
test('a failed cue Start retires the source graph through the output, never a bare room Stop',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111',actions=[],reasons=[];
 const host=createOwnerCueHost({roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},
  stopPlayback:async reason=>{reasons.push(reason);},commitPlayback:()=>assert.fail('no commit'),
  request:async path=>{const action=path.split('/').at(-1);actions.push(action);if(action==='start')throw Error('LOST');return{};}});
 await assert.rejects(host.start(),/LOST/);
 assert.deepEqual(reasons,['CUE_HOST_START_FAILED']);assert.deepEqual(actions,['start'],'the output stops the room only with a graph Stop receipt');
});
test('show mode prepare check reads only the reservation, never the live frontier',async()=>{
 let reads=0;const now=Date.now();
 const reservation={completed:false,expiresAtMs:now+30000,plan:{},cue:{cueId:'cue'}};
 const coordinator=createCueCoordinator({enabled:true,showMode:true,now:()=>now,
  repository:{request:async action=>{assert.equal(action,'cueReservation');return reservation;}},
  readCurrent:async()=>{reads++;throw Error('LIVE_FRONTIER_NOT_REQUIRED');}});
 const check=()=>coordinator.execute({action:'check',roomId:'synthetic',ownerCapability:owner,reservationId:'r'.repeat(24),phase:'prepare'});
 assert.deepEqual(await check(),{valid:true});assert.equal(reads,0);
 reservation.expiresAtMs=now;assert.deepEqual(await check(),{valid:false},'an expired reservation is invalid');
 reservation.expiresAtMs=now+30000;reservation.completed=true;assert.deepEqual(await check(),{valid:false});
});
test('owner host re-checks the reservation at every guard, never retries a late edit, and names the output reason',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111',states=[],actions=[];let commits=0;
 const host=createOwnerCueHost({roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},stopPlayback:async()=>({stopped:true,graphStopConfirmed:true}),onState:s=>states.push(s),
  request:async path=>{const action=path.split('/').at(-1);actions.push(action);
   if(action==='reserve')return{roomId,reservationId:'reservation_'+'l'.repeat(24),cue:{cueId:'cue',music:{asset:{assetId:'asset'}}},
    plan:{},expectedRevision:1,expiresAtMs:Date.now()+30000};
   if(action==='check')return{valid:true};return{};},
  commitPlayback:async input=>{commits++;assert.equal(await input.guard(),true);assert.equal(await input.guard(),true);
   throw Object.assign(Error('CLOUD_OUTPUT_REQUEST_FAILED'),{code:'CLOUD_OUTPUT_REQUEST_FAILED',reason:'QUEUED_RENDER_FRONTIER_CHANGED'});}});
 await host.start();for(let i=0;i<50&&states.at(-1)?.state!=='HOLD';i++)await new Promise(r=>setImmediate(r));
 assert.equal(commits,1,'a late edit is not retried');assert.equal(actions.filter(a=>a==='check').length,2,'the final guard asks the server again');
 assert.equal(states.at(-1).reason,'CLOUD_OUTPUT_REQUEST_FAILED:QUEUED_RENDER_FRONTIER_CHANGED');
});
test('a Stop seen at the final pre-commit guard prevents the audio edit',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111';let checks=0,edited=false;
 const host=createOwnerCueHost({roomId,ownerCapability:owner,lifecycle:null,schedule:()=>1,cancel:()=>{},stopPlayback:async()=>({stopped:true,graphStopConfirmed:true}),
  request:async path=>{const action=path.split('/').at(-1);
   if(action==='reserve')return{roomId,reservationId:'reservation_'+'f'.repeat(24),cue:{cueId:'cue',music:{asset:{assetId:'asset'}}},
    plan:{},expectedRevision:1,expiresAtMs:Date.now()+30000};
   if(action==='check')return{valid:++checks===1};return{};},
  commitPlayback:async input=>{assert.equal(await input.guard(),true);if(await input.guard()!==true)throw Error('STALE_PLAYBACK_GUARD');edited=true;}});
 await host.start();for(let i=0;i<50&&checks<2;i++)await new Promise(r=>setImmediate(r));
 assert.equal(edited,false,'the second guard saw the stopped reservation');
});
// Production 2026-10-17: the B reservation threw after ~29s and left no timing
// at all. A failed reservation reports its stage durations and bounded code.
test('a failed reservation still reports its stage timing and bounded error code',async()=>{
 const timings=[];let clock=1000;
 const coordinator=createCueCoordinator({enabled:true,repository:{request:async()=>({cues:[]})},inspectJoin:async()=>{},now:()=>clock,
  onTiming:value=>timings.push(value),readCurrent:async()=>{clock+=29000;throw Object.assign(Error('OBSERVER_STOPPED'),{code:'OBSERVER_STOPPED'});}});
 await assert.rejects(coordinator.execute({action:'reserve',roomId:'11111111-1111-4111-a111-111111111111',ownerCapability:owner}),/OBSERVER_STOPPED/);
 assert.deepEqual(timings,['reserve:error=OBSERVER_STOPPED,total=29000']);
});
test('reservation timing names each pair inspection: count, unprepared misses and the slowest',async()=>{
 const x=await setup();try{
  await x.execute('publish',{operationId:opId});
  // The reservation SQL checks expiry against the database clock.
  const timings=[];let clock=Date.now();
  for(const [pair,expected] of [[null,/joins=700,n=1,miss=1,slowest=700/],[x.pair,/joins=700,n=1,miss=0,slowest=700/]]){
   clock=Date.now();const coordinator=createCueCoordinator({enabled:true,repository:x.repository,now:()=>clock,onTiming:value=>timings.push(value),
    readCurrent:async()=>x.current,inspectJoin:async()=>{clock+=700;return pair;}});
   await coordinator.execute({action:'reserve',roomId:x.room.roomId,ownerCapability:owner});
   assert.match(timings.at(-1),expected);
  }
  assert.match(timings[0],/^reserve:current=0,joins=700,n=1,miss=1,slowest=700,hold=0,total=700$/);
  assert.match(timings[1],/,write=0,at=0\.0s,/);
 }finally{await x.db.close();}
});
test('reservation binds the exact READY copy the plan was evaluated from, not an older copy sharing its cueId',async()=>{
 const source=await readFile(new URL('../cloud/generation/cue-coordinator.mjs',import.meta.url),'utf8');
 assert.match(source,/c\.generationId === plan\.generationId && c\.music\?\.asset\?\.sha256 === plan\.incomingSha256 && c\.controlVersion === plan\.controlVersion/);
 assert.match(source,/if \(copies\.length !== 1\) \{ mark\('hold'\); return \{state: 'HOLD', reason: 'RECOMPUTE_PLAYBACK_PLAN'\}; \}/);
});
