import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMacOwnerBridge,createOwnerProductionRouter} from '../room-web/mac-owner-bridge.mjs';

const roomId='71ae8719-2ceb-4308-a019-bbc9ff4b6f5d';
const cloudOrigin='https://ai-vdj.vercel.app';
const macOrigin='http://127.0.0.1:54414';
const owner='b'.repeat(64),session='s'.repeat(43),sha='a'.repeat(64);

function fixture(t){
 const previous=globalThis.document,fields=new Map(),events=new Map(),calls=[],states=[],timers=[];
 const field=name=>{if(!fields.has(name))fields.set(name,{value:'',textContent:'',disabled:false,hidden:false,
  setAttribute(){},removeAttribute(){}});return fields.get(name);};
 const panel={querySelector:field,remove(){}};
 globalThis.document={createElement:()=>panel};t.after(()=>{globalThis.document=previous;});
 let activated=false;
 const bridge=mountMacOwnerBridge({container:{prepend(){}},roomId,ownerCapability:owner,
  cloudOrigin,approvedOrigin:macOrigin,onState:value=>states.push(value),
  lifecycle:{addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)},
  schedule:fn=>{timers.push(fn);return timers.length;},cancel(){},
  fetchImpl:async(url,options)=>{calls.push({url,options});const path=new URL(url).pathname;
   if(path==='/api/status')return Response.json({code:'LOCAL_STATUS_ONLY'},{status:403});
   if(path==='/api/pair')return Response.json({session,expiresAt:Date.now()+60000});
   if(path==='/api/owner/connect')return Response.json({submissions:2,runtimeActivated:true});
   if(path==='/api/owner/state')return Response.json({submissions:2,runtimeActivated:activated});
   if(path.endsWith('/media/seed?sha256='+sha))throw Error('unexpected URL parse');
   if(path.endsWith('/media/seed'))return new Response(Uint8Array.of(1,2,3),{headers:{'Content-Type':'audio/wav'}});
   return Response.json({generation:true});
  }});
 t.after(()=>bridge.dispose());
 return {bridge,field,calls,states,events,timers,activate:()=>{activated=true;},
  async connect(){await field('[name=probe]').onclick();field('[name=ready]').onclick();
   field('[name=code]').value='one-time-code';field('[name=code]').oninput();await field('[name=connect]').onclick();},
  refresh:()=>field('[name=refresh]').onclick()};
}

test('native transport activates only after paired owner/state and never sends browser owner proof',async t=>{
 const f=fixture(t),cloudCalls=[];
 const router=createOwnerProductionRouter({bridge:()=>f.bridge,cloudFetch:async(path,options)=>{
  cloudCalls.push({path,options});return Response.json({cloud:true});}});
 assert.deepEqual(f.bridge.state(),{paired:false,attached:false,runtimeActivated:false,nativeReady:false});
 await assert.rejects(f.bridge.productionFetch(`/api/rooms/${roomId}/native/capabilities`),/MAC_NATIVE_SESSION_REQUIRED/);
 await f.connect();assert.equal(f.bridge.state().attached,true);assert.equal(f.bridge.state().nativeReady,false);
 await assert.rejects(Promise.resolve().then(()=>router.selectNative()),/MAC_NATIVE_SESSION_REQUIRED/);
 await router.fetch(`/api/rooms/${roomId}/operator/status`,{method:'GET'});assert.equal(cloudCalls.length,1);
 f.activate();await f.refresh();assert.equal(f.bridge.state().nativeReady,true);
 assert(f.states.every(state=>!JSON.stringify(state).includes(owner)&&!JSON.stringify(state).includes(session)));
 router.selectNative();
 const path=`/api/rooms/${roomId}/media/seed?sha256=${sha}`;
 const media=await router.fetch(path,{method:'GET',headers:{'X-Room-Owner':owner}});
 assert.equal(media.url,cloudOrigin+path);assert.equal(media.headers.get('content-type'),'audio/wav');
 assert.deepEqual([...new Uint8Array(await media.arrayBuffer())],[1,2,3]);
 const transmitted=f.calls.at(-1);assert.equal(transmitted.url,macOrigin+path);
 const headers=new Headers(transmitted.options.headers);
 assert.equal(headers.get('X-VDJ-Session'),session);assert.equal(headers.has('X-Room-Owner'),false);
 assert.equal(transmitted.options.credentials,'omit');assert.equal(transmitted.options.redirect,'error');
 assert.equal(cloudCalls.length,1);assert(f.calls.every(call=>!call.url.includes(owner)&&!call.url.includes(session)));
 await assert.rejects(router.fetch(`/api/rooms/${roomId}/operator/trial/start`,{method:'POST',
  headers:{Authorization:'example_forbidden_bearer'},body:'{}'}),/MAC_NATIVE_HEADERS_REFUSED/);
 const beforeCredential=f.calls.length;
 await assert.rejects(router.fetch(`/api/rooms/${roomId}/operator/connection`,{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:'example_provider_value'})}),/MAC_NATIVE_CREDENTIAL_INPUT_REFUSED/);
 assert.equal(f.calls.length,beforeCredential);
 const late=await router.fetch(path,{method:'GET'});
 f.timers[0]();assert.equal(f.bridge.state().nativeReady,false);
 await assert.rejects(late.arrayBuffer(),/MAC_NATIVE_SESSION_REQUIRED/);
 assert.throws(()=>router.fetch(`/api/rooms/${roomId}/operator/trial/start`,{method:'POST',body:'{}'}),/MAC_NATIVE_SESSION_REQUIRED/);
 assert.equal(cloudCalls.length,1);router.close();
});

test('native request keeps exact POST body and rejects foreign or credential-bearing paths',async t=>{
 const f=fixture(t);await f.connect();f.activate();await f.refresh();
 const path=`/api/rooms/${roomId}/native/capabilities`;
 const status=await f.bridge.productionFetch(path,{method:'GET'});
 assert.equal(status.url,cloudOrigin+path);assert.equal((await status.json()).generation,true);
 const body=JSON.stringify({planId:'plan-one',consent:true});
 await f.bridge.productionFetch(`/api/rooms/${roomId}/operator/trial/start`,{method:'POST',
  headers:{'Content-Type':'application/json','X-Room-Owner':owner},body});
 assert.equal(f.calls.at(-1).options.body,body);
 assert.equal(new Headers(f.calls.at(-1).options.headers).get('content-type'),'application/json');
 await assert.rejects(f.bridge.productionFetch('https://evil.example/api/rooms/'+roomId+'/operator/status'),/MAC_NATIVE_ROUTE_REQUIRED/);
 await assert.rejects(f.bridge.productionFetch(`/api/rooms/${roomId}/operator/status?ownerCapability=${owner}`),/MAC_NATIVE_ROUTE_REQUIRED/);
 assert(f.calls.every(call=>!call.url.includes(owner)));
});
