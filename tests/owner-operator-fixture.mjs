import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOwnerOperator} from '../cloud/worker/owner-operator.mjs';
import {createOwnerSetupModel} from '../room-web/owner-setup-model.mjs';
import {syntheticWave,fixtureSha} from './cloud-worker-fixture.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
const roomId='11111111-1111-4111-a111-111111111111',owner='a'.repeat(64),origin='https://vdj.example';
const scope={roomId,['sessionId']:'22222222-2222-4222-a222-222222222222',controlRevision:0,ownerEnabled:true,expiresAtMs:60000};
const scoped=Object.fromEntries(['roomId','sessionId','controlRevision'].map(k=>[k,scope[k]]));
const digest=b=>createHash('sha256').update(b).digest('hex');
export function createOwnerOperatorFixture({enabled=true,infrastructure=true,ambiguous=false,fivePerson=false,serverManaged=false,reserveBudget,submissionCount=3,balanceUsd=2}={}){
 const uploads=new Map(),assets=new Map(),plans=new Map(),connections=new Map(),calls=[],begun=[],inserted=[];let serial=0,completedParticipants=0,connectionCalls=0,admitted=0;
 const source={music:{clipId:'synthetic-seed',sha256:'d'.repeat(64),contextSeconds:16,contextSha256:'d'.repeat(64),contextVerified:true,ready:true,
  control:{version:1,energy:.4,tension:.3,density:.3,brightness:.45}},video:{motifId:'synthetic-motif',motifSnapshotSha256:'e'.repeat(64),referenceSha256:'f'.repeat(64)},quality:{fixedBpm:145,tempoConfidence:'assumed'},playback:{phase:'PLAYING',revision:0,actual:true,playedUntilFrame:512}};
 const ports={enabled,mode:'fixture',origin,roomId,serverManaged,authorizeOwner:async i=>i.ownerCapability===owner,readScope:async()=>({...scope}),now:()=>1000,
 mintId:()=>('synthetic-'+(++serial)).padEnd(25,'x'),approvals:{connection:true,media:true,trial:true},
 connections:{connect:async input=>{connectionCalls++;assert.equal(input.credential,'example_fixture_connection');const connectionId='connection-'+(++serial),c={...scoped,connectionId,verified:true,expiresAtMs:50000};connections.set(connectionId,c);return c;},readActive:async()=>[...connections.values()].at(-1)??null,read:async i=>connections.get(i.connectionId)},
 media:{begin:async i=>{const uploadId='upload-'+(++serial);uploads.set(uploadId,{...i,bytes:[],length:0});return {uploadId,chunkBytes:32768};},
 append:async i=>{const u=uploads.get(i.uploadId);assert.equal(u.length,i.offset);u.bytes.push(i.bytes);u.length+=i.bytes.length;return {receivedBytes:u.length};},
 finish:async i=>{const u=uploads.get(i.uploadId),b=Buffer.concat(u.bytes);assert.equal(digest(b),u.selection.sha256);assert.equal(b.length,u.selection.byteLength);
 const a={...scoped,...u.selection,assetId:'asset-'+(++serial),privateSaved:true,checksumVerified:true,serverQC:true};assets.set(a.assetId,a);uploads.delete(i.uploadId);return a;},read:async i=>assets.get(i.assetId)},
 trial:{mediaHost:'media.example.invalid',reserveBudget,infrastructure:{verified:infrastructure,maximumUsd:0},...(fivePerson?{maximumParticipants:5,maximumCents:250}:{}),
 plans:{active:async()=>[...plans.values()].at(-1)??null,save:async p=>{if(admitted&&!(admitted===2&&p.participants===3))throw Object.assign(Error('OPERATOR_EXISTING_TRIAL'),{code:'OPERATOR_EXISTING_TRIAL'});plans.set(p.planId,structuredClone(p));},read:async i=>structuredClone(plans.get(i.planId)),
 claim:async i=>{const p=plans.get(i.planId);if(p.phase!=='REVIEW'||admitted&&!(admitted===2&&p.participants===3))return false;admitted=p.participants;p.phase='CLAIMED';return true;},record:async i=>{plans.get(i.planId).phase=i.phase;}},
 readSubmissions:async()=>Array.from({length:submissionCount},(_,i)=>({participantId:'synthetic-person-'+(i+1),submissionId:'synthetic-submission-'+(i+1)})),readSource:async()=>structuredClone(source),
 quoteAndBalance:async()=>({quote:{verified:true,evidenceSha256:'1'.repeat(64),observedAtMs:1000,maximumUsd:{intent:.01,music:.05,video:.4}},balance:{usd:balanceUsd,autoTopUp:false,observedAtMs:1000},visualPolicy:TECHNICAL_VISUAL_POLICY}),
 signSource:async i=>({context:{url:'https://media.example.invalid/private/context',private:true,checksumVerified:true,sha256:source.music.contextSha256,expiresAtMs:i.expiresAtMs,serverAudioQC:true,providerOriginVerified:true},
 reference:{url:'https://media.example.invalid/private/reference',private:true,checksumVerified:true,sha256:source.video.referenceSha256,expiresAtMs:i.expiresAtMs}}),
 insertPermits:async i=>inserted.push(...i.plan.operations.map(o=>o.permit)),beginOperation:async i=>{begun.push(i);if(ambiguous)throw Error('synthetic ambiguous response');},readProgress:async()=>({completedParticipants})}};
 const server=createOwnerOperator(ports);
 const request=async(path,options={})=>{calls.push({path,method:options.method});const r=await server.handleRequest(new Request(origin+path,{method:options.method??'GET',
 headers:{origin,'x-room-owner':owner,...(options.body!==undefined?{'content-type':'application/json'}:{})},...(options.body!==undefined?{body:JSON.stringify(options.body)}:{})}));
 const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{code:value.error});return value;};
 const model=createOwnerSetupModel({request,roomId,mintId:()=>('local-'+(++serial)).padEnd(25,'x')});
 return {ports,server,request,model,calls,begun,inserted,plans,assets,connectionCalls:()=>connectionCalls,setCompleted:n=>completedParticipants=n};
}
