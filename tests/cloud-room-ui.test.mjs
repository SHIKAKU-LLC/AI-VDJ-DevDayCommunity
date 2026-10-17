import test from 'node:test';
import assert from 'node:assert/strict';
import {roomView} from '../room-web/rooms/room-contract-view.mjs';
import {createRoomModelPort} from '../room-web/rooms/room-model-port.mjs';
import {createRoomUIModel,completeSet} from '../room-web/rooms/room-ui-model.mjs';
const roomId='11111111-1111-4111-a111-111111111111',hash=n=>n.repeat(64);
function raw(state='PENDING',digest='a'){
 const job={submissionId:'submission',operationId:'operation',generationId:'generation',cueId:'cue',controlVersion:2,
  commonIntentSha256:hash('e'),state,atomicReady:['READY','RESERVED','PLAYING'].includes(state),actualGenerationThisRun:true,
  channels:{},stages:{music:{state:state==='PARTIAL_READY'?'COMPLETE':'SUBMITTED'},video:{state:'SUBMITTED'}}};
 for(const k of ['music','video'])job.channels[k]={status:'QC_READY',qcPassed:true,durationSeconds:24,generationId:'generation',controlVersion:2,...(k==='video'?{compositionQcPassed:true}:{})};
 return{roomId,sessionId:'example_epoch',eventSeq:4,controlRevision:0,closed:false,mode:'cloud',jobStateSha256:hash(digest),accepting:true,
  generationPaused:true,autoDJ:false,submissions:[{roomId,sessionId:'example_epoch',submissionId:'submission',participantId:'participant',nickname:'synthetic guest',prompt:'synthetic idea',state,jobs:[job]}]};
}
test('same room eventSeq can advance cloud stages and verifiedREADY; replayed job digests cannot regress it',()=>{
 const model=createRoomUIModel();assert.equal(model.snapshot(roomView(raw())),true);assert.equal(model.read().requests[0].state,'PENDING');
 assert.equal(model.snapshot(roomView(raw('PARTIAL_READY','b'))),true);assert.equal(model.read().requests[0].state,'PARTIAL_READY');
 assert.equal(model.snapshot(roomView(raw('READY','c'))),true);assert.equal(completeSet(model.read().requests[0]),true);
 assert.equal(model.snapshot(roomView(raw('PARTIAL_READY','b'))),false);assert.equal(model.read().requests[0].state,'READY');
 assert.equal(model.snapshot(roomView({...raw('HOLD','d'),eventSeq:3})),false);
 model.dispose();
});
test('channelQC summary and matching authoritativecredit are mandatory; reserve never becomesNOW',()=>{
 let value=raw('RESERVED');let req=roomView(value).requests[0];assert.equal(req.state,'READY');assert.equal(req.selectionState,'RESERVED');
 value=raw('PLAYING');let job=value.submissions[0].jobs[0];job.actualPlayback=true;job.playerAcknowledged=true;job.playbackRevision=1;
 assert.equal(roomView(value).requests[0].state,'HOLD');
 value.currentCredit={roomId,submissionId:'submission',participantId:'participant',cueId:'cue',generationId:'generation',playbackRevision:1,actual:true,actualPlayback:true};
 assert.equal(roomView(value).requests[0].state,'PLAYING');
 value.currentCredit.cueId='other';assert.equal(roomView(value).requests[0].state,'HOLD');
 value=raw('READY');value.submissions[0].jobs[0].channels.video.durationSeconds=5;
 req=roomView(value).requests[0];assert.equal(req.state,'WAIT_REVIEW');assert.equal(completeSet(req),false);
 value.submissions[0].jobs[0].atomicReady=false;assert.equal(completeSet(roomView(value).requests[0]),false);
});
test('room proof reads are serialized so a slow older snapshot cannot arrive after newerjobstate',async()=>{
 let calls=0,release;const first=new Promise(r=>release=r);
 const client={async readRoom(){calls++;if(calls===1){await first;return raw();}return raw('READY','b');},dispose(){}};
 const port=createRoomModelPort({client,owner:true}),model=createRoomUIModel({port});
 const a=model.load(),b=model.load();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 release();await Promise.all([a,b]);assert.equal(calls,2);assert.equal(model.read().requests[0].state,'READY');model.dispose();port.dispose();
});
