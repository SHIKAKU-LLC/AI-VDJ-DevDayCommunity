import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionVisualPlan} from '../cloud/worker/visual-plan.mjs';
import {createSyntheticPrivateStore,fixtureSha} from './cloud-worker-fixture.mjs';
import {TECHNICAL_VISUAL_POLICY} from '../integration/qc/visual-policy.mjs';
import {operationBinding} from '../cloud/generation/cue-contract.mjs';
import {cueDigest} from '../snapshot/app/runtime/intent-compiler.mjs';
const h='a'.repeat(64),roomId='synthetic-room',operationId='synthetic-operation',permitId='synthetic-permit';
async function fixture(){const store=createSyntheticPrivateStore();
 const newBytes=Buffer.from('synthetic fresh clip'),savedBytes=Buffer.from('synthetic accepted prior clip');
 const o={roomId,operationId,submissionId:'submission',dispatchAllowed:true,stopped:false,
  permit:{permitId,source:{video:{referenceSha256:h}},visualPolicy:TECHNICAL_VISUAL_POLICY},
  plan:{status:'COMPILED',commonIntentSha256:h,common:{control:{version:1}}},
  stages:{video:{state:'COMPLETE',requestId:'provider-video',result:{assetId:'new-video',sha256:fixtureSha(newBytes),resultSha256:h}}}};
 const binding=operationBinding(roomId,o,'video'),original={...binding,generationId:'prior-generation'};
 await store.save({id:'new-video',bytes:newBytes,contentType:'video/mp4',binding,
  provenance:{kind:'provider',sourceSha256:h,requestId:'provider-video',resultSha256:h}});
 await store.save({id:'saved-video',bytes:savedBytes,contentType:'video/mp4',binding:original,
  provenance:{kind:'provider',sourceSha256:h,requestId:'prior-provider',resultSha256:h}});
 let duration=5,inspections=0;
 const inspectVideo=async({bytes,inputDigest})=>{inspections++;const seconds=fixtureSha(bytes)===fixtureSha(newBytes)?duration:19;
  return {inputDigest,rawSha256:fixtureSha(bytes),fullyDecoded:true,decodedFrames:seconds*4,
   durationSeconds:seconds,width:160,height:90,technicalStats:{method:'full-frame-luma-motion-v1',frames:seconds*4,
    nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.01,maximumLargeLumaTransitionsPerSecond:0}};};
 const factory=extra=>createProductionVisualPlan({enabled:true,readOperation:async()=>structuredClone(o),assetStore:store,inspectVideo,...extra});
 const input=()=>({roomId,operation:structuredClone(o),binding,newClip:{clipId:'fresh-clip',bytes:newBytes,
  sha256:fixtureSha(newBytes),provenance:{receiptId:'private-provenance-handle'}}});
 return {store,o,factory,input,savedBytes,newBytes,setDuration:n=>duration=n,inspections:()=>inspections};}

test('production native-duration path requires 24 seconds of nonrepeating material; default 5s cannot loop',async()=>{
 const x=await fixture(),plan=x.factory();await assert.rejects(plan.readVisualPlan(x.input()),/MATERIAL_INSUFFICIENT/);
 assert.equal([...x.store.records.keys()].filter(k=>k.startsWith('visual-plan')).length,0);
 x.setDuration(24);const result=await plan.readVisualPlan(x.input());assert.equal(result.manifest.segments.length,1);
 assert.equal(result.manifest.segments[0].outSeconds,24);assert.equal(result.manifest.clips[0].durationSeconds,24);
 const restarted=x.factory();assert.deepEqual((await restarted.readVisualPlan(x.input())).manifest,result.manifest);
});

test('accepted private edit joins actual provider clip and physical saved clip, persists immutable plan without URLs',async()=>{
 const x=await fixture(),plan=x.factory();await plan.saveAcceptedEdit({roomId,operationId,
  clips:[{assetId:'saved-video',sha256:fixtureSha(x.savedBytes),inSeconds:0,outSeconds:19}]});
 const result=await plan.readVisualPlan(x.input());assert.equal(result.manifest.durationSeconds,24);
 assert.deepEqual(result.manifest.segments.map(s=>[s.clipId,s.startSeconds,s.endSeconds,s.inSeconds,s.outSeconds]),
  [['fresh-clip',0,5,0,5],['saved-video',5,24,0,19]]);
 assert.equal(result.clips[1].provenance.kind,'saved');assert.equal(result.clips[1].provenance.assetId,'saved-video');
 const saved=await plan.readSavedRecord('saved-video');assert.equal(saved.generationId,'prior-generation');assert.equal(saved.referenceSha256,h);
 const persisted=[...x.store.records.values()].find(r=>r.assetId.startsWith('visual-plan-'));
 const record=JSON.parse(Buffer.from(persisted.bytes).toString());assert.equal(record.sourceIntervalsReplayed,false);
 assert.equal(record.continuousNewGeneration,false);assert(!persisted.bytes.toString().includes('receiptId'));
 assert(x.inspections()>=3,'plan/persistence never skips physical verification');
});

test('refreshed finite evidence saves a separate immutable edit and plan under the same operation',async()=>{
 const x=await fixture(),plan=x.factory(),input={roomId,operationId,
  clips:[{assetId:'saved-video',sha256:fixtureSha(x.savedBytes),inSeconds:0,outSeconds:19}]};
 await plan.saveAcceptedEdit(input);const first=await plan.readVisualPlan(x.input());
 const originals=new Map([...x.store.records].filter(([key])=>/^visual-(edit|plan)-/.test(key)).map(([key,r])=>[key,Buffer.from(r.bytes)]));
 Object.assign(x.o.permit,{createdAtMs:2000,expiresAtMs:3000,quote:{observedAtMs:2000},balance:{observedAtMs:2000},assets:{}});
 await assert.rejects(plan.readVisualPlan(x.input()),/MATERIAL_INSUFFICIENT/);
 await plan.saveAcceptedEdit(input);assert.deepEqual((await plan.readVisualPlan(x.input())).manifest,first.manifest);
 assert.equal([...x.store.records.keys()].filter(key=>/^visual-(edit|plan)-/.test(key)).length,4);
 for(const [key,bytes] of originals)assert(x.store.records.get(key).bytes.equals(bytes));
});

test('edit rejects replay, unsaved or unrelated reference media; actual asset mutation holds',async()=>{
 const x=await fixture(),plan=x.factory(),c={assetId:'saved-video',sha256:fixtureSha(x.savedBytes),inSeconds:0,outSeconds:19};
 await assert.rejects(plan.saveAcceptedEdit({roomId,operationId,clips:[c,c]}),/NONREPEATING/);
 await assert.rejects(plan.saveAcceptedEdit({roomId,operationId,clips:[{...c,outSeconds:20}]}),/NONREPEATING/);
 x.store.records.get('saved-video').provenance.sourceSha256='b'.repeat(64);
 await assert.rejects(plan.saveAcceptedEdit({roomId,operationId,clips:[c]}),/SAVED_BINDING/);
 x.store.records.get('saved-video').provenance.sourceSha256=h;await plan.saveAcceptedEdit({roomId,operationId,clips:[c]});
 x.store.records.get('saved-video').bytes[0]^=1;await assert.rejects(plan.readVisualPlan(x.input()),/PHYSICAL_CHANGED/);
});

test('expired or changed authority, fake duration/checksum and exact unreviewed composition do not become accepted',async()=>{
 const x=await fixture();let p=x.factory({enabled:false});await assert.rejects(p.readVisualPlan(x.input()),/NOT_ACTIVATED/);
 assert.equal(x.inspections(),0);p=x.factory();x.o.stopped=true;await assert.rejects(p.readVisualPlan(x.input()),/OPERATION_REQUIRED/);x.o.stopped=false;
 const forged=x.input();forged.newClip.bytes=Buffer.from('forged');await assert.rejects(p.readVisualPlan(forged),/OPERATION_CHANGED/);
 const bad=x.factory({inspectVideo:async()=>({fullyDecoded:true,durationSeconds:24})});
 await assert.rejects(bad.readVisualPlan(x.input()),/NATIVE_DECODE/);
 x.o.permit.visualReviewMode='exact';x.setDuration(24);await assert.rejects(x.factory().readVisualPlan(x.input()),/EXACT_REVIEW/);
 p.close();await assert.rejects(p.readSavedRecord('saved-video'),/CLOSED/);
});

async function ownerFixture(){
 const x=await fixture(),scope={roomId,['sessionId']:'synthetic-session',controlRevision:0,expiresAtMs:2000000,ownerEnabled:true};
 const binding={kind:'owner-supplied-bootstrap-video',roomId,['sessionId']:scope.sessionId,controlRevision:0,
  expiresAtMs:scope.expiresAtMs,referenceSha256:h},admissionId='synthetic-admission';
 const sha256=fixtureSha(x.savedBytes),measurement={inputDigest:cueDigest({kind:'operator-upload-video-v1',sha256,referenceSha256:h}),
  rawSha256:sha256,fullyDecoded:true,decodedFrames:76,durationSeconds:19,width:160,height:90,
  technicalStats:{method:'full-frame-luma-motion-v1',frames:76,nearBlackFraction:0,nearWhiteFraction:0,meanMotion:.01,maximumLargeLumaTransitionsPerSecond:0}};
 const evidence={version:'owner-bootstrap-video-admission-v1',assetId:'saved-video',sha256,byteLength:x.savedBytes.length,
  referenceSha256:h,admissionId,ownerSelected:true,actualGenerationThisRun:false,binding,measurement};
 const encoded=Buffer.from(JSON.stringify(evidence)),admissionEvidenceSha256=fixtureSha(encoded);
 x.store.records.delete('saved-video');
 await x.store.save({id:'saved-video',bytes:x.savedBytes,contentType:'video/mp4',binding,
  provenance:{kind:binding.kind,actualGenerationThisRun:false,sourceSha256:h,rawSha256:sha256,admissionId,admissionEvidenceSha256}});
 await x.store.save({id:'admission-'+admissionId,bytes:encoded,contentType:'application/json',binding,
  provenance:{kind:'owner-bootstrap-video-admission'}});
 const plan=x.factory({readScope:async()=>scope,now:()=>1000000});
 return {...x,scope,binding,evidence,plan,c:{assetId:'saved-video',sha256,inSeconds:0,outSeconds:19}};
}

test('empty generated catalogue can use admitted owner video honestly while new clip remains a provider result',async()=>{
 const x=await ownerFixture();await x.plan.saveAcceptedEdit({roomId,operationId,clips:[x.c]});
 const result=await x.plan.readVisualPlan(x.input());
 assert.equal(result.manifest.durationSeconds,24);assert.equal(result.clips[1].provenance.kind,'owner-supplied-bootstrap-video');
 const record=await x.plan.readSavedRecord('saved-video',{binding:{roomId,channel:'video'},sourceSha256:h});
 assert.equal(record.actualGenerationThisRun,false);assert.equal(record.generationId,undefined);assert.equal(record.admissionId,'synthetic-admission');
 const edit=[...x.store.records.values()].find(r=>r.assetId.startsWith('visual-edit'));
 const saved=JSON.parse(edit.bytes).clips[0];assert.equal(saved.generationId,undefined);assert.equal(saved.origin.kind,'owner-supplied-bootstrap-video');
 x.store.records.get('new-video').provenance.kind='owner-supplied-bootstrap-video';
 await assert.rejects(x.plan.readVisualPlan(x.input()),/OWNER_ADMISSION|PROVIDER_CHANGED/);
});

test('owner admission holds on missing trusted scope, cross session/reference, expiry, forged generation or mutated evidence',async()=>{
 for(const mutate of [x=>delete x.store.records.get('saved-video').provenance.admissionEvidenceSha256,
  x=>Object.assign(x.scope,{['sessionId']:'synthetic-other-session'}),x=>x.scope.expiresAtMs=1000000,
  x=>x.store.records.get('saved-video').provenance.sourceSha256='b'.repeat(64),
  x=>x.store.records.get('saved-video').provenance.requestId='invented-provider-request',
  x=>x.store.records.get('admission-synthetic-admission').bytes[0]^=1]){
  const x=await ownerFixture();mutate(x);await assert.rejects(x.plan.saveAcceptedEdit({roomId,operationId,clips:[x.c]}));
 }
 const x=await ownerFixture();await assert.rejects(x.factory().saveAcceptedEdit({roomId,operationId,clips:[x.c]}),/OWNER_ADMISSION/);
 x.o.permit.expiresAtMs=x.scope.expiresAtMs+1;await assert.rejects(x.plan.saveAcceptedEdit({roomId,operationId,clips:[x.c]}),/OWNER_ADMISSION/);
});

test('owner scope changes during native re-decode hold the accepted edit',async()=>{
 const x=await ownerFixture(),plan=x.factory({readScope:async()=>x.scope,now:()=>1000000,inspectVideo:async({bytes,inputDigest})=>{
  x.scope.controlRevision++;return {...x.evidence.measurement,inputDigest,rawSha256:fixtureSha(bytes)};
 }});
 await assert.rejects(plan.saveAcceptedEdit({roomId,operationId,clips:[x.c]}),/OWNER_SCOPE/);
 assert.equal([...x.store.records.keys()].some(k=>k.startsWith('visual-edit')),false);
});
test('toEnd selects a saved clip through its measured end so a short provider clip still fills 24s',async()=>{
 const x=await fixture(),plan=x.factory();
 await assert.rejects(plan.saveAcceptedEdit({roomId,operationId,clips:[{assetId:'saved-video',sha256:fixtureSha(x.savedBytes),inSeconds:0,toEnd:true,outSeconds:19}]}),/ACCEPTED_EDIT_REQUIRED/);
 await plan.saveAcceptedEdit({roomId,operationId,clips:[{assetId:'saved-video',sha256:fixtureSha(x.savedBytes),inSeconds:0,toEnd:true}]});
 const result=await plan.readVisualPlan(x.input());assert.equal(result.manifest.durationSeconds,24);
 assert.equal(result.manifest.segments.at(-1).endSeconds,24);
});
