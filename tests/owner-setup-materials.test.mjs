import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerSetupModel,createOwnerSetupCapabilityRefresh} from '../room-web/owner-setup-model.mjs';
import {createOwnerOperatorFixture} from './owner-operator-fixture.mjs';
import {fixtureSha,syntheticWave} from './cloud-worker-fixture.mjs';
import {mountOwnerSetup} from '../room-web/owner-setup.mjs';

const roomId='11111111-1111-4111-a111-111111111111';
const referenceBytes=Uint8Array.of(137,80,78,71,13,10,26,10);
const videoFile=()=>new File([Uint8Array.of(0,0,0,12,102,116,121,112,109,112,52,50)],'anonymous.mp4',{type:'video/mp4'});
const asset=(role,assetId,sha256,extra={})=>({role,assetId,sha256,byteLength:12,
 mimeType:{seed:'audio/wav',reference:'image/png','saved-video':'video/mp4'}[role],...extra});
const sourceAssets=()=>[asset('seed','accepted-seed','a'.repeat(64)),asset('reference','accepted-reference',fixtureSha(referenceBytes))];
function nativeFixture({assets=sourceAssets(),macRequired=true,serverManaged=false}={}){
 const calls=[],uploaded=new Map();let serial=0;
 const request=async(path,{method,body}={})=>{
  calls.push({path,method,body});
  if(path.endsWith('/status'))return {version:'owner-operator-v1',mode:'production',macRequired,serverManaged,
   available:{connection:true,media:true,trial:true},assets:structuredClone(assets),
   connection:{connectionId:'accepted-connection',verified:true,expiresAtMs:50000}};
  if(path.endsWith('/media/begin')){const uploadId='upload-'+(++serial);uploaded.set(uploadId,body);return {uploadId,chunkBytes:32768};}
  if(path.endsWith('/media/chunk'))return {receivedBytes:body.offset+Buffer.from(body.data,'base64').length};
  if(path.endsWith('/media/finish')){const descriptor=uploaded.get(body.uploadId),saved={...descriptor,assetId:'accepted-video-'+serial};
   assets=[...assets.filter(a=>a.role!==saved.role),saved];return {phase:'SAVED',asset:saved};}
  if(path.endsWith('/trial/prepare'))return {phase:'REVIEW',planId:'accepted-plan',participants:body.participants,
   maximumCents:body.maximumCents,infrastructureMaximumUsd:0};
  throw Error('UNEXPECTED_SYNTHETIC_REQUEST');
 };
 return {request,model:createOwnerSetupModel({request,roomId}),calls,setAssets:value=>{assets=value;}};
}

test('accepted native source plus one newly selected video uploads only that video and enables budget review',async()=>{
 const x=nativeFixture();await x.model.load();
 assert.equal(x.model.snapshot().macRequired,true);assert.equal(x.model.snapshot().assets.length,2);
 await assert.rejects(x.model.connect('example_forbidden_browser_connection'),/CONNECTION_MANAGED_AT_MAC/);
 assert.equal(x.calls.filter(c=>c.path.endsWith('/connection')).length,0);
 await x.model.select({role:'saved-video',file:videoFile()});
 const pending=x.model.snapshot();assert.equal(pending.selections.length,1);assert.equal(pending.assets.length,2);
 assert.equal(pending.selections[0].referenceSha256,pending.assets.find(a=>a.role==='reference').sha256);
 assert.equal(pending.selectionComplete,true);assert.equal(pending.assetsComplete,false);
 await assert.rejects(x.model.prepare(2),/TRIAL_REQUIRED/);
 await x.model.upload(true);
 assert.deepEqual(x.calls.filter(c=>c.path.endsWith('/media/begin')).map(c=>c.body.role),['saved-video']);
 const saved=x.model.snapshot();assert.equal(saved.assets.length,3);assert.equal(saved.assetsComplete,true);
 assert.equal(saved.selections.length,0);
 assert(saved.assets.some(a=>a.assetId==='accepted-seed'));assert(saved.assets.some(a=>a.assetId==='accepted-reference'));
 await x.model.prepare(2);
 const prepared=x.calls.find(c=>c.path.endsWith('/trial/prepare'));
 assert.deepEqual(prepared.body.assetIds,['accepted-seed','accepted-reference','accepted-video-1']);
 x.model.dispose();
});

test('accepted source replacements are refused while every accepted asset and review remains intact',async()=>{
 const base=sourceAssets(),x=nativeFixture({assets:[...base,asset('saved-video','accepted-video','b'.repeat(64),{referenceSha256:base[1].sha256})]});
 await x.model.load();await x.model.prepare(2);
 const original=x.model.snapshot();
 await assert.rejects(x.model.select({role:'reference',file:new File([Uint8Array.from([...referenceBytes,1])],'anonymous.png',{type:'image/png'})}),/SOURCE_FIXED/);
 const changed=x.model.snapshot();assert.deepEqual(changed.assets,original.assets);
 assert.deepEqual(changed.plan,original.plan);assert.equal(changed.selectionComplete,true);assert.equal(changed.assetsComplete,true);
 assert.equal(changed.selections.length,0);assert.equal(changed.nextAction.target,'media');
 await assert.rejects(x.model.select({role:'seed',file:new File([syntheticWave(24)],'anonymous.wav',{type:'audio/wav'})}),/SOURCE_FIXED/);
 assert.deepEqual(x.model.snapshot().assets,original.assets);assert.deepEqual(x.model.snapshot().plan,original.plan);
 assert.equal(x.calls.filter(c=>c.path.endsWith('/media/begin')).length,0);
 x.model.dispose();
});

test('replacing an unuploaded reference discards its pending video while preserving accepted seed',async()=>{
 const x=nativeFixture({assets:[sourceAssets()[0]]});await x.model.load();
 await x.model.select({role:'reference',file:new File([referenceBytes],'anonymous.png',{type:'image/png'})});
 await x.model.select({role:'saved-video',file:videoFile()});
 await x.model.select({role:'reference',file:new File([Uint8Array.from([...referenceBytes,2])],'anonymous.png',{type:'image/png'})});
 assert.deepEqual(x.model.snapshot().selections.map(s=>s.role),['reference']);
 assert.deepEqual(x.model.snapshot().assets.map(a=>a.role),['seed']);
 assert.equal(x.model.snapshot().selectionComplete,false);
 await x.model.select({role:'saved-video',file:videoFile()});
 assert.equal(x.model.snapshot().selectionComplete,true);await x.model.upload(true);
 assert.deepEqual(x.calls.filter(c=>c.path.endsWith('/media/begin')).map(c=>c.body.role),['reference','saved-video']);
 assert.equal(x.model.snapshot().assetsComplete,true);x.model.dispose();
});

test('explicit connection adapter remains available to the model and malformed material sets never enable review',async()=>{
 const x=createOwnerOperatorFixture();await x.model.load();assert.equal(x.model.snapshot().macRequired,false);
 await x.model.connect('example_fixture_connection');assert.equal(x.connectionCalls(),1);x.model.dispose();x.server.close();
 const base=sourceAssets(),bad=nativeFixture({assets:[...base,asset('saved-video','accepted-video','b'.repeat(64),{referenceSha256:'f'.repeat(64)})]});
 await bad.model.load();assert.equal(bad.model.snapshot().assetsComplete,false);
 await assert.rejects(bad.model.prepare(2),/TRIAL_REQUIRED/);bad.model.dispose();
 const duplicate=nativeFixture({assets:[base[0],{...base[0],assetId:'duplicate-seed'},base[1]]});
 await assert.rejects(duplicate.model.load(),/ASSET_REQUIRED/);duplicate.model.dispose();
});

test('accepted source refreshes output capabilities before budget errors with busy, duplicate and stale mount guards',async()=>{
 let calls=0,current=true,finish;const source={assets:sourceAssets(),busy:false,error:null};
 const coordinator=createOwnerSetupCapabilityRefresh({isCurrent:()=>current,
  refresh:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
 coordinator.observe({...source,busy:true});coordinator.observe({assets:[],busy:false});assert.equal(calls,0);
 coordinator.observe(source);coordinator.observe(source);assert.equal(calls,1);
 const complete={...source,assets:[...source.assets,asset('saved-video','accepted-video','b'.repeat(64),{referenceSha256:source.assets[1].sha256})]};
 coordinator.observe(complete);assert.equal(calls,1);
 finish(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
 finish(true);await new Promise(resolve=>setImmediate(resolve));coordinator.observe(complete);assert.equal(calls,2);
 coordinator.observe({...complete,available:{media:true,trial:true}});assert.equal(calls,3);
 finish(true);await new Promise(resolve=>setImmediate(resolve));
 current=false;coordinator.observe({...complete,assets:sourceAssets()});assert.equal(calls,3);
});

test('a partial three-file upload keeps accepted source roles and retries only its pending video',async()=>{
 const x=createOwnerOperatorFixture(),begun=[];let failVideo=true,videoUpload;
 const request=async(path,options={})=>{
  if(path.endsWith('/media/begin')){
   begun.push(options.body.role);const value=await x.request(path,options);
   if(options.body.role==='saved-video')videoUpload=value.uploadId;return value;
  }
  if(path.endsWith('/media/finish')&&options.body.uploadId===videoUpload&&failVideo){
   failVideo=false;throw Object.assign(Error('OPERATOR_VIDEO_QC_HOLD'),{code:'OPERATOR_VIDEO_QC_HOLD'});
  }
  return x.request(path,options);
 };
 const model=createOwnerSetupModel({request,roomId});await model.load();await model.connect('example_fixture_connection');
 await model.select({role:'seed',file:new File([syntheticWave(24)],'anonymous.wav',{type:'audio/wav'})});
 await model.select({role:'reference',file:new File([referenceBytes],'anonymous.png',{type:'image/png'})});
 await model.select({role:'saved-video',file:videoFile()});
 await assert.rejects(model.upload(true),/VIDEO_QC_HOLD/);
 const partial=model.snapshot();assert.deepEqual(partial.assets.map(a=>a.role),['seed','reference']);
 assert.deepEqual(partial.selections.map(a=>a.role),['saved-video']);assert.equal(partial.selectionComplete,true);
 await model.upload(true);assert.deepEqual(begun,['seed','reference','saved-video','saved-video']);
 assert.equal(model.snapshot().assetsComplete,true);assert.equal(model.snapshot().selections.length,0);
 model.dispose();x.model.dispose();x.server.close();
});

test('setup removes credential inputs, preserves accepted materials and hides uploads for server-managed rooms',async()=>{
 const nodes=new Map(),node=selector=>{
  if(!nodes.has(selector))nodes.set(selector,{value:'',checked:false,disabled:false,textContent:'',hidden:false,
   querySelector:selector=>node(selector)});
  return nodes.get(selector);
 };
 const container={innerHTML:'',querySelector:node,replaceChildren(){}};
 const native=nativeFixture(),view=mountOwnerSetup({container,roomId,request:native.request});
 await new Promise(resolve=>setImmediate(resolve));
 assert.doesNotMatch(container.innerHTML,/data-connection(?:\s|=|>)|data-credential|type="password"/);
 assert.match(node('[data-connection-state]').textContent,/サーバーの生成準備/);
 assert.equal(node('[data-file="seed"]').disabled,true);assert.equal(node('[data-file="reference"]').disabled,true);
 assert.equal(node('[data-file="saved-video"]').disabled,false);
 assert.match(container.innerHTML,/保存映像が表示した参照画像に対応することも確認しました/);
 assert.equal(node('[data-upload]').disabled,true);
 await view.model.select({role:'saved-video',file:videoFile()});
 node('[data-media-consent]').checked=true;node('[data-media-consent]').onchange();
 assert.equal(node('[data-upload]').disabled,false);
 await view.model.upload(true);assert.equal(node('[data-upload]').disabled,true);
 assert.equal(node('[data-review]').disabled,false);
 view.dispose();native.model.dispose();
 const cloud=nativeFixture({macRequired:false,serverManaged:true}),cloudView=mountOwnerSetup({container,roomId,request:cloud.request});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cloudView.model.snapshot().serverManaged,true);
 assert.equal(node('[data-media]').hidden,true);
 assert.doesNotMatch(container.innerHTML,/data-connection(?:\s|=|>)|data-credential|type="password"/);
 assert.equal(cloud.calls.filter(c=>c.path.endsWith('/connection')).length,0);
 cloudView.dispose();cloud.model.dispose();
});

test('matching restored source discards pending copies and retains only the new video',async()=>{
 const x=nativeFixture({assets:[]}),wave=syntheticWave(24);await x.model.load();
 await x.model.select({role:'seed',file:new File([wave],'anonymous.wav',{type:'audio/wav'})});
 await x.model.select({role:'reference',file:new File([referenceBytes],'anonymous.png',{type:'image/png'})});
 await x.model.select({role:'saved-video',file:videoFile()});
 x.setAssets([asset('seed','restored-seed',fixtureSha(wave),{byteLength:wave.length}),
  asset('reference','restored-reference',fixtureSha(referenceBytes),{byteLength:referenceBytes.length})]);
 await x.model.load();assert.deepEqual(x.model.snapshot().selections.map(a=>a.role),['saved-video']);
 await x.model.upload(true);assert.deepEqual(x.calls.filter(c=>c.path.endsWith('/media/begin')).map(c=>c.body.role),['saved-video']);
 assert.equal(x.model.snapshot().assetsComplete,true);x.model.dispose();
});
