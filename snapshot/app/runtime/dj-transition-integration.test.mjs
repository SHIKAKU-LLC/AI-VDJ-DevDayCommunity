import test from 'node:test';
import assert from 'node:assert/strict';
import {createParticipantRooms} from './participant-rooms.mjs';
import {evaluateTransition,selectBestTransition} from './dj-transition-selector.mjs';
import {createDJPorts} from './dj-transition-ports.mjs';
const h=s=>s.repeat(64);
const profile=sha=>({method:'pcm-endpoint-profile-v1',assetSha256:sha,sampleRate:44100,channels:2,rmsDbfs:-18,
  head:{rmsDbfs:-18,bandFractions:[.4,.4,.2]},tail:{rmsDbfs:-18,bandFractions:[.4,.4,.2]},
  bpm:{value:null,confidence:'unknown'},key:{value:null,confidence:'unknown'}});
const source=()=>({music:{clipId:'seed',sha256:h('a'),profile:profile(h('a')),ready:true,contextVerified:true,contextSeconds:16,
  contextSha256:h('b'),control:{version:1,world:'psytrance',prompt:'current',energy:.4,tension:.3,density:.3,brightness:.45}},
  video:{motifId:'eye-lattice',motifSnapshotSha256:h('c'),referenceSha256:h('d')},quality:{fixedBpm:145},playback:{phase:'RUNNING',revision:0}});
const media=(channel,s)=>({binding:s.binding,status:'QC_READY',qc:{passed:true},compositionQC:channel==='video'?{passed:true}:null,
  durationSeconds:24,asset:{assetId:s.binding.generationId+'-'+channel,sha256:h('e'),mute:channel==='video',pulseMode:'raw'},
  profile:channel==='music'?profile(h('e')):undefined,parentClipId:s.sourceSnapshot.music.clipId,contextSha256:s.sourceSnapshot.music.contextSha256,
  contextVerified:true,continuationVerified:false,fixtureBinding:true,actualGenerationThisRun:false});
async function enableDJ(svc,roomId,actor){const state=await svc.state(roomId,actor);return svc.control(roomId,actor,
  {autoDJ:true,...(Number.isInteger(state.controlRevision)?{nonce:'dj_control_nonce_'+String(state.controlRevision).padStart(8,'0'),expectedRevision:state.controlRevision}:{})});}

test('concurrent DJ ticks cause exactly one simulated backend commit under room lock',async()=>{
  let calls=0,release;const gate=new Promise(r=>release=r);
  const svc=createParticipantRooms({persist:async()=>{},readSource:source,generateMedia:async(c,s)=>media(c,s),
    evaluatePlan:evaluateTransition,selectPlan:selectBestTransition,
    commitPlayback:async({roomId,cue,expectedRevision})=>{calls++;await gate;return{roomId,cueId:cue.cueId,clipId:cue.music.asset.assetId,
      playbackRevision:expectedRevision,audioTime:1,actual:false,simulated:true};}});
  const r=await svc.create({ownerId:'owner',initialBufferCues:1}),actor={ownerToken:r.ownerToken};
  await svc.submit(r.roomId,actor,{nonce:'dj_concurrent_nonce_0001',prompt:'もっと会場を盛り上げたい'});await svc.drain();
  await enableDJ(svc,r.roomId,actor);await Promise.all(Array.from({length:8},()=>svc.djTick(r.roomId,actor)));
  assert.equal(calls,1);assert.equal((await svc.state(r.roomId,actor)).currentCredit,null);
  release();await svc.drain();assert.equal((await svc.state(r.roomId,actor)).currentCredit.playbackRevision,1);await svc.close();
});
test('source revision changes during inspectJoin prevent a stale backend commit',async()=>{
  let src=source(),calls=0;
  const svc=createParticipantRooms({persist:async()=>{},readSource:()=>src,generateMedia:async(c,s)=>media(c,s),
    evaluatePlan:evaluateTransition,selectPlan:selectBestTransition,
    inspectJoin:async()=>{src={...src,playback:{...src.playback,revision:src.playback.revision+1}};return null;},
    commitPlayback:async()=>{calls++;}});
  const r=await svc.create({ownerId:'owner',initialBufferCues:1}),actor={ownerToken:r.ownerToken};
  await svc.submit(r.roomId,actor,{nonce:'dj_stale_nonce_00000001',prompt:'もっと会場を盛り上げたい'});await svc.drain();
  await enableDJ(svc,r.roomId,actor);await svc.djTick(r.roomId,actor);await svc.drain();
  assert.equal(calls,0);assert.equal((await svc.state(r.roomId,actor)).currentCredit,null);
  assert.ok((await svc.events(r.roomId,actor)).events.some(e=>e.reason==='DJ_SOURCE_CHANGED_BEFORE_COMMIT'));await svc.close();
});
test('ports require trusted receipt arrays and retain hold evidence',async()=>{
  assert.throws(()=>createDJPorts({}),/TRUSTED/);
  const p=createDJPorts({loadReceipts:async()=>[{passed:false,currentSha256:h('a'),incomingSha256:h('e')}]});
  const receipt=await p.inspectJoin({roomId:'r',current:{sha256:h('a')},candidate:{music:{asset:{sha256:h('e')}}}});
  assert.equal(receipt.passed,false);
  const malformed=createDJPorts({loadReceipts:async()=>({passed:true})});await assert.rejects(malformed.inspectJoin({}),/ARRAY/);
});
