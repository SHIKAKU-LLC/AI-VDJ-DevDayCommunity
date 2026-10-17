import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createProviderResultReconciler} from '../cloud/worker/result-reconciliation.mjs';
import {createReadOnlyGenerationProvider} from '../cloud/generation/provider.mjs';
import {resolveOperatorConnectionBinding,resolveOperatorResultConnectionBinding} from '../cloud/worker/operator-connections.mjs';
import {GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import {cueDigest,cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
const key='example_ephemeral_reconciliation',owner='a'.repeat(64),roomId='11111111-1111-4111-a111-111111111111';
const hash=b=>createHash('sha256').update(b).digest('hex');
const semantic={needsClarification:false,question:'',interpretation:'穏やかに広がる',direction:'down',intensity:.5,
 visualOpenness:'increase',musicDevelopment:'Reduce competing layers gently.',visualDevelopment:'Open geometry and preserve detail.'};
function fixture(channels=['intent']){
 const scope={roomId,sessionId:'example_epoch',controlRevision:0,expiresAtMs:50000};
 const source={audioAssetId:'example_parent',contextAssetId:'example_context',referenceAssetId:'example_reference',
  music:{clipId:'example_parent',sha256:'c'.repeat(64),profile:{assetSha256:'c'.repeat(64)},contextSeconds:16,
   contextSha256:'d'.repeat(64),contextVerified:true,ready:true,control:{version:1,energy:.5,tension:.5,density:.5,brightness:.5}},
  video:{motifId:'example_motif',motifSnapshotSha256:'e'.repeat(64),referenceSha256:'f'.repeat(64)},
  quality:{fixedBpm:145},playback:{actual:true,phase:'PLAYING',revision:0,playedUntilFrame:256}};
 const operationId='operator_example_reconciliation';
 const permit={permitId:'permit_example_reconciliation',kind:GENERATION_CONTRACT.version,counts:GENERATION_CONTRACT.counts,
  connectionId:'connection_example',createdAtMs:1,expiresAtMs:1000,source,sourceSha256:cueDigest(cueSourceIdentity(source)),
  quote:{maximumUsd:{intent:.01,music:.1,video:.5}}};
 const op={operationId,submissionId:'submission_example',permit,prompt:'静かな星空',stopped:false,dispatchAllowed:false,
  keyProof:cueDigest({domain:'room-generation-key-v1',key,operationId}),
  stages:Object.fromEntries(channels.map(c=>[c,{state:'SUBMITTED',signature:cueDigest(c),requestId:'example_request_'+c}]))};
 const facts={scope,operation:op,permitScope:{...scope,permitId:permit.permitId,permitSha256:cueDigest(permit),revoked:false,expiresAtMs:1000},
  playback:{roomId,stopped:false},connectionId:permit.connectionId};
 const counts={credentials:0,status:0,result:0,media:0,qc:0},objects=new Map(),hooks={};
 const assetStore={readOptional:async id=>structuredClone(objects.get(id)??null),read:async id=>structuredClone(objects.get(id)),
  save:async ({id,bytes,...rest})=>{const record={assetId:id,bytes:Uint8Array.from(bytes),sha256:hash(bytes),byteLength:bytes.length,...rest};
   const prior=objects.get(id);if(prior)assert.deepEqual(prior,record);objects.set(id,record);return structuredClone(record);},
  verifySaved:async({asset})=>({privateSaved:true,checksumVerified:true,assetId:asset.assetId,sha256:asset.sha256})};
 const provider={status:async args=>{counts.status++;await hooks.status?.();return {status:'COMPLETED'};},
  result:async args=>{counts.result++;await hooks.result?.();return {data:args.stage==='intent'?{output:JSON.stringify(semantic),usage:{cost:.001}}:
   args.stage==='music'?{audio:{url:hooks.url??'https://v3.fal.media/example.wav'}}:{video:{url:hooks.url??'https://v3.fal.media/example.mp4'}}};}};
 const options={enabled:true,now:()=>10000,assetStore,provider,readFacts:async()=>{await hooks.facts?.();return structuredClone(facts);},
  withCredential:async(f,fn)=>{counts.credentials++;return fn(hooks.key??key);},
  fetchImpl:async(url,init)=>{counts.media++;assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
   await hooks.media?.();return new Response(Uint8Array.of(1,2,3),{headers:{'content-type':url.endsWith('.wav')?'audio/wav':'video/mp4'}});},
  inspectMedia:async args=>{counts.qc++;await hooks.qc?.();return {fullyDecoded:true,inputDigest:args.inputDigest};}};
 const reconciler=createProviderResultReconciler(options),input={roomId,operationId,ownerCapability:owner};
 return {facts,op,scope,counts,objects,hooks,options,reconciler,input};
}
test('expired financial permit retains known intent via GET-only private receipt without granting spend, ledger completion or Cue',async()=>{
 const x=fixture(),before=structuredClone(x.op),r=await x.reconciler.reconcile(x.input);
 assert.equal(r.state,'RECONCILED_RESULTS');assert.equal(r.spendingAuthorized,false);assert.equal(r.cueEligible,false);assert.equal(r.actualPlayback,false);
 assert.equal(r.results[0].state,'RESULT_SAVED');assert.deepEqual(x.op,before);assert.equal(x.counts.status,1);assert.equal(x.counts.result,1);
 const receipt=JSON.parse(new TextDecoder().decode([...x.objects.values()][0].bytes));
 assert.equal(receipt.plan.status,'COMPILED');assert.equal(receipt.plan.common.interpreterProvenance.providerRequestId,'example_request_intent');
 assert(!JSON.stringify(r).includes(key));assert(!JSON.stringify(r).includes('https://'));
});
test('overlapping receipts coalesce and later read physically verifies saved bytes without provider replay',async()=>{
 const x=fixture();let release;x.hooks.status=()=>new Promise(r=>{release=r;});
 const a=x.reconciler.reconcile(x.input),b=x.reconciler.reconcile(x.input);
 while(!release)await new Promise(r=>setImmediate(r));release();const [ra,rb]=await Promise.all([a,b]);
 assert.deepEqual(ra,rb);ra.results[0].state='changed';assert.notEqual(rb.results[0].state,'changed');
 await x.reconciler.reconcile(x.input);assert.equal(x.counts.status,1);assert.equal(x.counts.result,1);
 const saved=[...x.objects.values()][0];saved.bytes[0]^=1;
 await assert.rejects(x.reconciler.reconcile(x.input),/SAVED_BINDING_HOLD/);assert.equal(x.counts.result,1);
});
test('UNKNOWN, RESERVED, revoked, stopped, wrong scope/connection/source/credential fail before result retrieval',async()=>{
 const changes=[x=>x.op.stages.intent.state='UNKNOWN',x=>x.op.stages.intent.state='RESERVED',x=>delete x.op.stages.intent.requestId,
  x=>x.facts.permitScope.revoked=true,x=>x.op.stopped=true,x=>x.facts.playback.stopped=true,x=>x.facts.permitScope.controlRevision++,
  x=>x.facts.connectionId='other_connection',x=>x.op.permit.source.music.sha256='0'.repeat(64),x=>x.scope.expiresAtMs=9999];
 for(const change of changes){const x=fixture();change(x);await assert.rejects(x.reconciler.reconcile(x.input));
  assert.equal(x.counts.credentials,0);assert.equal(x.counts.status,0);assert.equal(x.objects.size,0);}
 const x=fixture();x.hooks.key='other_example_credential';await assert.rejects(x.reconciler.reconcile(x.input),/KEY_MISMATCH/);assert.equal(x.counts.status,0);
});
test('Stop between status/result prevents result GET; late Stop prevents saving without changing existing ledger',async()=>{
 const x=fixture();x.hooks.status=()=>{x.facts.playback.stopped=true;};await assert.rejects(x.reconciler.reconcile(x.input),/AUTHORITY_HOLD/);
 assert.equal(x.counts.result,0);assert.equal(x.objects.size,0);
 const y=fixture();y.hooks.result=()=>{y.facts.playback.stopped=true;};await assert.rejects(y.reconciler.reconcile(y.input),/AUTHORITY_HOLD/);
 assert.equal(y.objects.size,0);assert.equal(y.op.stages.intent.state,'SUBMITTED');
});
test('completed AV receipts save raw media and local QC separately; failed QC preserves downloaded result and cannot publish',async()=>{
 const x=fixture(['music','video']);x.hooks.qc=()=>{throw Error('EXAMPLE_QC_HOLD');};
 const r=await x.reconciler.reconcile(x.input);assert.equal(x.counts.media,2);assert.equal(x.counts.qc,2);
 assert(r.results.every(v=>v.state==='MEDIA_SAVED'&&v.localQCHold==='EXAMPLE_QC_HOLD'));assert.equal(x.objects.size,4);
 for(const record of x.objects.values())if(record.contentType==='application/json')assert(!new TextDecoder().decode(record.bytes).includes('https://'));
 delete x.hooks.qc;const next=await x.reconciler.reconcile(x.input);
 assert(next.results.every(v=>v.state==='LOCAL_QC_INSPECTED'));assert.equal(x.counts.media,2);assert.equal(x.counts.result,2);
 assert.equal(x.op.stages.music.state,'SUBMITTED');assert.equal(next.spendingAuthorized,false);
});
test('foreign media URL and late media Stop cannot create saved media; completed intent is never fetched again',async()=>{
 const x=fixture(['video']);x.hooks.url='https://example.invalid/private.mp4';await assert.rejects(x.reconciler.reconcile(x.input),/PROVIDER_MEDIA_REFUSED/);
 assert.equal(x.counts.media,0);assert.equal(x.objects.size,0);
 const y=fixture(['music']);y.hooks.media=()=>{y.facts.playback.stopped=true;};await assert.rejects(y.reconciler.reconcile(y.input),/AUTHORITY_HOLD/);
 assert.equal(y.objects.size,1);
 const z=fixture();z.op.stages.intent.state='COMPLETE';assert.equal((await z.reconciler.reconcile(z.input)).results[0].state,'LEDGER_COMPLETE');assert.equal(z.counts.credentials,0);
});
test('read-only provider has no submit port and rejects SDK POST/retry/foreign hosts before transport',async()=>{
 let method='POST',calls=0;
 const p=createReadOnlyGenerationProvider({fetchImpl:async()=>{calls++;return Response.json({});},
  createFalClient:({fetch,retry})=>{assert.equal(retry.maxRetries,0);return {queue:{
   status:async()=>fetch('https://queue.fal.run/example',{method}),
   result:async()=>{await fetch('https://queue.fal.run/example');return fetch('https://queue.fal.run/example');}}};}});
 assert.equal(p.submit,undefined);await assert.rejects(p.status({}),/READ_ONLY_REQUIRED/);assert.equal(calls,0);
 method='GET';await p.status({});assert.equal(calls,1);await assert.rejects(p.result({}),/TRANSPORT_REFUSED/);assert.equal(calls,2);
});
test('historical connection kind never satisfies dispatch and cannot move to another operation/scope',()=>{
 const x=fixture(),plan={...x.scope,phase:'STARTED',expiresAtMs:1000,connectionId:x.facts.connectionId,operations:[x.op]};
 const args={scope:x.scope,plan,operationId:x.op.operationId,now:()=>10000};
 assert.throws(()=>resolveOperatorConnectionBinding(args),/CONNECTION_CHANGED/);
 assert.equal(resolveOperatorResultConnectionBinding(args).kind,'operator-result-connection-binding-v1');
 assert.throws(()=>resolveOperatorResultConnectionBinding({...args,operationId:'other_operation'}),/RESULT_CONNECTION_CHANGED/);
 plan.controlRevision++;assert.throws(()=>resolveOperatorResultConnectionBinding(args),/RESULT_CONNECTION_CHANGED/);
});
