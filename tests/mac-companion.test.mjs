import test from 'node:test';
import assert from 'node:assert/strict';
import {createMacHost} from '../integration/mac-host/server.mjs';
import {mountMacCompanionBridge} from '../room-web/mac-companion-bridge.mjs';
const roomId='11111111-1111-4111-a111-111111111111',owner='a'.repeat(64),cloudOrigin='https://ai-vdj.vercel.app';
async function nativeFixture(t,{consent=async()=>true,companionMode=true,authorize=async()=>{},runtimeState=()=>undefined}={}){
  let clock=Date.now();const calls={verify:0,confirm:0,create:0,close:0,codes:0},order=[];
  const host=await createMacHost({roomId,cloudOrigin,companionMode,now:()=>clock,lifetimeMs:1000,
    verifyOwner:async b=>{calls.verify++;order.push('verify');assert.equal(b.ownerCapability,owner);await authorize();},
    confirm:async()=>{calls.confirm++;order.push('confirm');return consent();},showPairing:async()=>{calls.codes++;},
    createStore:async()=>({close:async()=>{}}),
    createRuntime:async()=>{calls.create++;return {attachOwner:async b=>{assert.equal(b.ownerCapability,owner);},
      readCloud:async()=>{},status:()=>({connected:true,submissions:2,generationEnabled:false,
        ...(runtimeState()?{nativeOrchestration:{state:runtimeState()}}:{})}),close:async()=>{calls.close++;}};}});
  const {origin}=await host.listen();t.after(()=>host.close());
  const request=(path,body={},session,from=cloudOrigin)=>fetch(origin+path,{method:'POST',
    headers:{Origin:from,'Content-Type':'application/json',...(session?{'X-VDJ-Session':session}:{})},body:JSON.stringify(body)});
  const connect=async()=>request('/api/companion/connect',{roomId,ownerCapability:owner});
  return {host,origin,calls,order,request,connect,advance:()=>{clock+=1001;}};
}
test('native owner verification precedes consent; resume rotates credentials without codes or runtime restart',async t=>{
  const f=await nativeFixture(t),first=await f.connect();assert.equal(first.status,200);const a=await first.json();
  assert.deepEqual(f.order,['verify','confirm']);assert.equal(f.calls.codes,0);assert.equal(f.calls.create,1);
  const b=await (await f.connect()).json();assert.notEqual(a.session,b.session);assert.equal(f.calls.confirm,1);
  assert.equal((await f.request('/api/owner/state',{},a.session)).status,401);
  f.advance();assert.equal((await f.request('/api/owner/state',{},b.session)).status,401);
  assert.equal(f.calls.close,0,'auth expiry does not stop the running companion');
  const c=await (await f.connect()).json();assert.equal(f.calls.create,1);assert.equal(f.calls.confirm,1);
  assert.equal((await f.request('/api/stop',{},c.session)).status,200);assert.equal(f.calls.close,1);
  const d=await (await f.connect()).json();assert.equal(f.calls.create,2);assert.equal(f.calls.confirm,1,'stop preserves process-local consent');
  assert.equal((await f.request('/api/companion/unregister',{roomId,ownerCapability:owner})).status,200);
  assert.equal((await f.request('/api/owner/state',{},d.session)).status,401);
  assert.equal((await f.connect()).status,200);assert.equal(f.calls.confirm,2,'unregister requires fresh native consent');
});
test('wrong origin, unverified capability, injected approval and native cancellation cannot mint credentials',async t=>{
  let denied=true;const f=await nativeFixture(t,{authorize:async()=>{if(denied)throw Error('fixture denied');},consent:async()=>false});
  assert.equal((await f.request('/api/companion/connect',{roomId,ownerCapability:owner},undefined,f.origin)).status,403);
  assert.equal((await f.request('/api/companion/connect',{roomId,ownerCapability:owner,approved:true})).status,400);
  assert.equal(f.calls.verify,0);assert.equal((await f.connect()).status,403);assert.equal(f.calls.confirm,0);
  denied=false;assert.equal((await f.connect()).status,403);assert.equal(f.calls.create,0);assert.equal(f.calls.codes,0);
});
test('trial host refuses code-free companion path; concurrent native confirmations are serialized',async t=>{
  const trial=await nativeFixture(t,{companionMode:false});assert.equal((await trial.connect()).status,409);
  assert.equal(trial.calls.verify,0);
  let resolve,entered;const waiting=new Promise(r=>entered=r);
  const f=await nativeFixture(t,{consent:()=>{entered();return new Promise(r=>resolve=r);}});
  const pending=f.connect();await waiting;assert.equal((await f.connect()).status,409);
  resolve(true);assert.equal((await pending).status,200);assert.equal(f.calls.confirm,1);
  await assert.rejects(createMacHost({roomId,cloudOrigin,companionMode:true,enableProductionRoutes:true}),/COMPANION_COLLECT_ONLY/);
});
function uiFixture(t,{error,activated=false,readiness}={}){
  const previous=globalThis.document,fields=new Map(),events=new Map(),calls=[],timers=[];
  const field=s=>{if(!fields.has(s))fields.set(s,{textContent:'',disabled:false});return fields.get(s);};
  const panel={innerHTML:'',querySelector:field,remove(){}};globalThis.document={createElement:()=>panel};t.after(()=>{globalThis.document=previous;});
  const ui=mountMacCompanionBridge({container:{prepend(){}},roomId,ownerCapability:owner,cloudOrigin,
    cloudOrigin,lifecycle:{addEventListener:(e,f)=>events.set(e,f),removeEventListener:e=>events.delete(e)},
    schedule:f=>{timers.push(f);return timers.length;},cancel(){},fetchImpl:async(url,options)=>{
      calls.push({url,options});if(error==='offline')throw Error('fixture');
      if(error)return Response.json({code:error},{status:403});
      return Response.json({connected:true,generationEnabled:false,submissions:2,runtimeActivated:readiness?.activated??activated,
        ...(readiness?{nativeOrchestration:{state:readiness.state}}:{}),expiresAtMs:Date.now()+3600000,session:(calls.length%2?'s':'t').repeat(43),expiresAt:Date.now()+10000});}});
  t.after(()=>ui.dispose());return {ui,field,panel,calls,timers,events};
}
test('owner screen connects without URL/code fields; stop and unregister are separate; navigation only forgets credentials',async t=>{
  const f=uiFixture(t);assert.equal(f.calls.length,0);assert.doesNotMatch(f.panel.innerHTML,/type="(?:url|password)"/);
  await f.field('[name=connect]').onclick();assert.equal(f.ui.state().attached,true);assert.equal(f.ui.state().nativeReady,false);
  assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0].options.body).ownerCapability,owner);
  assert(!f.calls[0].url.includes(owner));assert(!f.field('[data-result]').textContent.includes(owner));
  await f.field('[name=stop]').onclick();assert.equal(f.field('[data-phase]').textContent,'停止済み');
  assert.equal(f.field('[name=unregister]').disabled,false);await f.field('[name=connect]').onclick();
  await f.field('[name=unregister]').onclick();assert.equal(f.field('[name=unregister]').disabled,true);
  await f.field('[name=connect]').onclick();const count=f.calls.length;f.events.get('pagehide')();
  assert.equal(f.calls.length,count,'closing a tab is not stop/unregister');assert.equal(f.ui.state().attached,false);
  await assert.rejects(f.ui.productionFetch(),/MAC_NATIVE_SESSION_REQUIRED/);
});
test('credential expiry and offline are distinguishable and recover on the same owner screen',async t=>{
  const f=uiFixture(t);await f.field('[name=connect]').onclick();f.timers[0]();
  assert.equal(f.field('[data-phase]').textContent,'接続認証の更新が必要');assert.equal(f.calls.length,1);
  await f.field('[name=connect]').onclick();assert.equal(f.ui.state().attached,true);
  const offline=uiFixture(t,{error:'offline'});await offline.field('[name=connect]').onclick();
  assert.equal(offline.field('[data-phase]').textContent,'Macと通信できません');
  const auth=uiFixture(t,{error:'OWNER_AUTH_REQUIRED'});await auth.field('[name=connect]').onclick();
  assert.equal(auth.field('[data-phase]').textContent,'owner認証を確認');
});

test('native owner transport uses paired credential, preserves logical media URL and renews only authentication',async t=>{
 const f=uiFixture(t,{activated:true});await f.field('[name=connect]').onclick();assert.equal(f.ui.state().nativeReady,true);
 const path=`/api/rooms/${roomId}/source/startup`,reply=await f.ui.productionFetch(path,{method:'POST',body:'{}',headers:{'X-Room-Owner':owner}});
 assert.equal(reply.url,cloudOrigin+path);await reply.json();
 const headers=new Headers(f.calls.at(-1).options.headers);assert(headers.has('X-VDJ-Session'));assert(!headers.has('X-Room-Owner'));
 await assert.rejects(f.ui.productionFetch(path,{headers:{Authorization:'example_forbidden_value'}}));
 await f.ui.productionFetch(`/api/rooms/${roomId}`,{method:'GET'}).then(r=>r.json());
 f.timers[1]();await new Promise(r=>setImmediate(r));
 assert.equal(f.calls.at(-1).url.endsWith('/api/companion/connect'),true);assert.equal(f.ui.state().nativeReady,true);
 assert.equal(f.calls.some(c=>c.url.endsWith('/jobs/start')||c.url.endsWith('/operator/trial/start')),false);
});
test('one connection is reused through preparation and readiness; only a confirmed error offers reconnect',async t=>{
 const readiness={state:'pending',activated:false},f=uiFixture(t,{readiness});
 await f.field('[name=connect]').onclick();
 assert.equal(f.field('[name=connect]').disabled,true);assert.match(f.field('[data-phase]').textContent,/素材を準備中/);
 assert.match(f.field('[data-result]').textContent,/再接続は不要/);assert.equal(f.ui.state().nativeReady,false);
 await f.field('[name=connect]').onclick();await f.field('[name=connect]').onclick();
 assert.equal(f.calls.filter(c=>c.url.endsWith('/api/companion/connect')).length,1);
 readiness.state='ready';readiness.activated=true;await f.field('[name=refresh]').onclick();
 assert.equal(f.ui.state().nativeReady,true);assert.equal(f.field('[name=connect]').disabled,true);
 await f.field('[name=connect]').onclick();assert.equal(f.calls.filter(c=>c.url.endsWith('/api/companion/connect')).length,1);
 readiness.state='hold';readiness.activated=false;await f.field('[name=refresh]').onclick();
 assert.equal(f.ui.state().nativeReady,false);assert.equal(f.field('[name=connect]').disabled,false);
 assert.match(f.field('[data-phase]').textContent,/準備エラー/);
 assert(f.calls.filter(c=>!c.url.endsWith('/api/companion/connect')).every(c=>c.url.endsWith('/api/owner/state')));
});
test('a reconnect after the native runtime deadline recycles the expired runtime',async t=>{
  let state='ready';const f=await nativeFixture(t,{runtimeState:()=>state});
  assert.equal((await f.connect()).status,200);assert.equal(f.calls.create,1);
  assert.equal((await f.connect()).status,200);assert.equal(f.calls.create,1,'a live runtime is reused');
  state='expired';
  assert.equal((await f.connect()).status,200);
  assert.equal(f.calls.close,1,'the expired runtime is closed');assert.equal(f.calls.create,2,'a fresh runtime replaces it');
  assert.equal(f.calls.confirm,1,'process-local consent is kept');
});
