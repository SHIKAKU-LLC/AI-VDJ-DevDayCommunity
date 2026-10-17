import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerCueHost} from '../room-web/owner-cue-host.mjs';

const roomId='11111111-1111-4111-a111-111111111111';
function fixture(result){
 const calls=[],states=[];
 const host=createOwnerCueHost({roomId,ownerCapability:'a'.repeat(64),lifecycle:null,
  commitPlayback:async()=>{},stopPlayback:async()=>result,onState:s=>states.push(s),
  request:async path=>{calls.push(path);return {stopped:true};}});
 return {host,calls,states};
}
test('disposing before a graph exists never stops the room cues',async()=>{
 const x=fixture({stopped:true,graphStopConfirmed:false,noGraph:true});
 await x.host.dispose();assert.deepEqual(x.calls,[]);
});
test('unconfirmed output Stop holds without sending a room cue Stop',async()=>{
 const x=fixture({stopped:true});
 await assert.rejects(x.host.stop(),/CUE_STOP_UNCONFIRMED/);assert.deepEqual(x.calls,[]);
});
test('confirmed output graph Stop permits the room cue Stop',async()=>{
 const x=fixture({stopped:true,graphStopConfirmed:true,noGraph:false});
 await x.host.stop();assert.equal(x.calls.length,1);assert(x.calls[0].endsWith('/cues/stop'));
});
