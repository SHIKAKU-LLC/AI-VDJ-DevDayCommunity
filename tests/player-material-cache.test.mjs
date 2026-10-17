import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionPlayerMaterial} from '../cloud/worker/player-material.mjs';
import {syntheticWave,fixtureSha} from './cloud-worker-fixture.mjs';
function fixture({atomic=false,cues=[]}={}){
 let now=1000,scopeReads=0,snapshotReads=0,assetReads=0,controlRevision=0,stopped=false,bytes=syntheticWave(24),changeOnRead=0;
 const sha=fixtureSha(bytes),binding={kind:'owner-supplied-bootstrap'};
 const scope=()=>({roomId:'room',sessionId:'example-epoch',controlRevision,expiresAtMs:60000});
 const material=createProductionPlayerMaterial({enabled:true,roomId:'room',now:()=>now,
 bootstrapAuthority:{readStartAuthority:async()=>({source:{audioAssetId:'seed',music:{clipId:'seed',sha256:sha,contextSha256:'f'.repeat(64)}}})},
 repositoryPorts:{readPlaybackSnapshot:atomic?async()=>{snapshotReads++;if(snapshotReads===changeOnRead)controlRevision++;
   return {scope:scope(),playback:{roomId:'room',stopped,currentCredit:null,cues,pending:false},runtime:{pending:null,acks:[]}};}:undefined,
 readScope:async()=>{scopeReads++;if(scopeReads===changeOnRead)controlRevision++;return scope();},
 readPlaybackState:async()=>({roomId:'room',stopped,currentCredit:null,cues,pending:null}),
 readRoomRuntime:async()=>({pending:null,acks:[]})},
 assetStore:{save:async()=>{throw Error('unexpected write');},read:async()=>{assetReads++;return {assetId:'seed',sha256:sha,byteLength:bytes.length,bytes:Uint8Array.from(bytes),binding};},
 verifySaved:async()=>({privateSaved:true,checksumVerified:true,assetId:'seed',sha256:sha,binding})}});
 return {material,scope,read:()=>{const {expiresAtMs,...identity}=scope();return material.readVerifiedMaterial({scope:identity,mode:'source'});},
 counts:()=>({scopeReads,snapshotReads,assetReads}),setStopped:v=>{stopped=v;},mutate:()=>{bytes[48]^=1;},
 changeDuringNextRead:()=>{changeOnRead=(atomic?snapshotReads:scopeReads)+2;},expire:()=>{now=60001;}};
}
test('observer reuses verified PCM but keeps private copies and fresh authority checks',async()=>{
 const f=fixture(),a=await f.read(),before=f.counts();a.pcm[0]=.9;
 const b=await f.read();assert.notEqual(b.pcm[0],.9);assert.equal(f.counts().assetReads,before.assetReads);
 assert.equal(f.counts().scopeReads,before.scopeReads+2);f.material.close();await assert.rejects(f.read(),/NOT_ACTIVATED/);
});
test('changed playback invalidates the loaded material and rechecks physical bytes',async()=>{
 const f=fixture();await f.read();f.mutate();f.setStopped(true);await assert.rejects(f.read(),/PHYSICAL_CHANGED/);f.material.close();
});
test('a cached read still rejects concurrent scope changes and expiry',async()=>{
 const f=fixture();await f.read();f.changeDuringNextRead();await assert.rejects(f.read(),/SCOPE_CHANGED/);f.material.close();
 const g=fixture();await g.read();g.expire();await assert.rejects(g.read(),/SCOPE_CHANGED/);g.material.close();
});
test('registry-owned initial snapshot reuses PCM without nested reads and changed state takes the verified path',async()=>{
 const f=fixture();await f.read();const {expiresAtMs,...scope}=f.scope();
 const input={scope,expiresAtMs,mode:'source',playback:{roomId:'room',stopped:false,currentCredit:null,cues:[],pending:null}};
 const before=f.counts(),first=await f.material.readObserverMaterial(input);first.pcm[0]=.9;
 assert.notEqual((await f.material.readObserverMaterial(input)).pcm[0],.9);assert.deepEqual(f.counts(),before);
 f.mutate();f.setStopped(true);await assert.rejects(f.material.readObserverMaterial({...input,playback:{...input.playback,stopped:true}}),/PHYSICAL_CHANGED/);
 f.material.close();
});

test('atomic material snapshots use two fresh reads and retain Stop, scope, expiry and physical validation',async()=>{
 const f=fixture({atomic:true});await f.read();assert.deepEqual(f.counts(),{scopeReads:0,snapshotReads:2,assetReads:1});
 await f.read();assert.deepEqual(f.counts(),{scopeReads:0,snapshotReads:4,assetReads:1});
 f.mutate();f.setStopped(true);await assert.rejects(f.read(),/PHYSICAL_CHANGED/);f.material.close();
 const g=fixture({atomic:true});await g.read();g.changeDuringNextRead();await assert.rejects(g.read(),/SCOPE_CHANGED/);g.material.close();
 const h=fixture({atomic:true});await h.read();h.expire();await assert.rejects(h.read(),/SCOPE_CHANGED/);h.material.close();
});

test('unplayed READY cues do not invalidate verified source PCM; Stop or changed playback uses fresh verification',async()=>{
 const cues=[{cueId:'ready-a',status:'READY'},{cueId:'ready-b',status:'READY'}],f=fixture({cues});await f.read();
 const {expiresAtMs,...scope}=f.scope(),input={scope,expiresAtMs,mode:'source',
  playback:{roomId:'room',stopped:false,currentCredit:null,cues,pending:null}};
 const before=f.counts(),first=await f.material.readObserverMaterial(input);first.pcm[0]=.9;
 assert.notEqual((await f.material.readObserverMaterial(input)).pcm[0],.9);assert.deepEqual(f.counts(),before);
 await f.material.readObserverMaterial({...input,playback:{...input.playback,pending:true}});
 assert.equal(f.counts().scopeReads,before.scopeReads+2,'a changed pending snapshot cannot use the source shortcut');
 f.mutate();f.setStopped(true);await assert.rejects(f.material.readObserverMaterial({...input,playback:{...input.playback,stopped:true}}),/PHYSICAL_CHANGED/);
 f.material.close();
});
test('synchronous source bytes use no IO and carry no Stop authority; pending/current/scope/expiry invalidate them',async()=>{
 const f=fixture();await f.read();const {expiresAtMs,...scope}=f.scope();
 const input={scope,expiresAtMs,mode:'source',playback:{roomId:'room',stopped:false,currentCredit:null,cues:[],pending:null}};
 const before=f.counts(),copy=f.material.readSourceSnapshot(input);copy.pcm[0]=.9;
 assert.notEqual(f.material.readSourceSnapshot({...input,playback:{...input.playback,stopped:true}}).pcm[0],.9);
 assert.deepEqual(f.counts(),before);
 for(const changed of [{...input,playback:{...input.playback,pending:true}},{...input,playback:{...input.playback,currentCredit:{actual:true}}},
  {...input,scope:{...scope,controlRevision:99}}])assert.equal(f.material.readSourceSnapshot(changed),null);
 f.expire();assert.equal(f.material.readSourceSnapshot(input),null);f.material.close();
});
