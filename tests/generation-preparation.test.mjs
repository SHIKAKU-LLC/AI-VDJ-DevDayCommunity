import test from 'node:test';
import assert from 'node:assert/strict';
import {createBootstrapPreparationReader} from '../cloud/worker/generation-preparation.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';

test('private physical admission survives finite audio ending but never Stop, owner denial, expiry or changed scope',async()=>{
 const roomId='11111111-1111-4111-a111-111111111111';let time=1000,stopped=false,denied=false,mutate=()=>{};
 const scope={roomId,sessionId:'example-epoch',controlRevision:0,expiresAtMs:100000};
 const source={music:{clipId:'example-seed',contextSha256:'a'.repeat(64),control:{version:1}},
  video:{motifSnapshotSha256:'b'.repeat(64),referenceSha256:'c'.repeat(64)},playback:{actual:false,revision:0}};
 const selected={...scope,kind:'server-selected-source-start-v1',mode:'bootstrap',serverQC:true,
  sourceSha256:cueDigest(cueSourceIdentity(source)),source};
 let physical=0;
 const read=createBootstrapPreparationReader({roomId,now:()=>time,readScope:async()=>{if(denied)throw Error('OWNER_DENIED');return {...scope};},
  readPlaybackState:async()=>({stopped}),readBootstrapAuthority:async()=>{physical++;mutate();return structuredClone(selected);}});
 time=75000;const prepared=await read({roomId});
 assert.equal(prepared.playback.actual,false);assert.equal(prepared.playback.phase,'PREPARING');assert.equal(prepared.playback.playedUntilFrame,0);
 assert.equal(physical,1);stopped=true;await assert.rejects(read({roomId}),/PREPARATION_HOLD/);assert.equal(physical,1);
 stopped=false;denied=true;await assert.rejects(read({roomId}),/OWNER_DENIED/);denied=false;
 mutate=()=>{scope.controlRevision++;};await assert.rejects(read({roomId}),/PREPARATION_HOLD/);
 mutate=()=>{};scope.controlRevision=0;time=100000;await assert.rejects(read({roomId}),/PREPARATION_HOLD/);
 await assert.rejects(read({roomId:'33333333-3333-4333-a333-333333333333'}),/PREPARATION_HOLD/);
});
