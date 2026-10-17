import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMacPreflight} from '../room-web/mac-owner-bridge.mjs';

function fixture(t,{fetchImpl,permission='granted'}={}){
 const previous=globalThis.document,fields=new Map(),events=new Map(),calls=[],timers=[];
 const field=k=>{if(!fields.has(k))fields.set(k,{disabled:false,textContent:''});return fields.get(k);};
 const panel={innerHTML:'',querySelector:field,remove(){}};
 globalThis.document={createElement:()=>panel};t.after(()=>{globalThis.document=previous;});
 const handle=mountMacPreflight({container:{prepend(){}},
  lifecycle:{addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k)},
  schedule:cb=>timers.push(cb),cancel(){},readPermission:async()=>permission,
  fetchImpl:async(url,options)=>{calls.push({url,options});return fetchImpl?fetchImpl(url,options):new Response('{"code":"LOCAL_STATUS_ONLY"}',{status:403});}});
 t.after(()=>handle.dispose());
 return {button:field('[name=preflight]'),status:field('[data-preflight-result]'),panel,calls,events,timers};
}
test('anonymous preflight is inert until click and sends only a code-free exact-origin request',async t=>{
 const f=fixture(t);assert.equal(f.calls.length,0);await f.button.onclick();
 const {url,options}=f.calls[0];assert.equal(url,'http://127.0.0.1:54414/api/status');
 assert.equal(options.body,'{}');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
 assert.deepEqual(Object.keys(options.headers),['Content-Type']);
 assert.match(f.status.textContent,/通信を確認しました/);assert.match(f.status.textContent,/本人ログイン/);
});
test('double click and late response after pagehide cannot repeat or show stale success',async t=>{
 let resolve;const reply=new Promise(r=>resolve=r);const f=fixture(t,{fetchImpl:()=>reply});
 const pending=f.button.onclick();await f.button.onclick();assert.equal(f.calls.length,1);
 f.events.get('pagehide')();resolve(new Response('{"code":"LOCAL_STATUS_ONLY"}',{status:403}));await pending;
 assert.equal(f.button.disabled,true);assert(!f.status.textContent.includes('通信を確認しました'));
});
test('granted permission plus timeout is not called successful or blamed on login/code',async t=>{
 const f=fixture(t,{fetchImpl:(_,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('synthetic timeout'))))});
 const pending=f.button.onclick();f.timers[0]();await pending;
 assert.match(f.status.textContent,/許可は有効ですが、Macから応答が届きません/);
 assert.match(f.status.textContent,/ログインやコード入力を始めず/);assert.equal(f.button.disabled,false);
});
test('ungranted permission asks for the human permission step',async t=>{
 const f=fixture(t,{permission:'prompt',fetchImpl:async()=>{throw new TypeError('synthetic');}});await f.button.onclick();
 assert.match(f.status.textContent,/許可が未確認/);
});
test('malformed response is distinct from a missing permission',async t=>{
 const g=fixture(t,{permission:'granted',fetchImpl:async()=>new Response('{"code":"unexpected"}',{status:200})});await g.button.onclick();
 assert.match(g.status.textContent,/応答は届きましたが/);assert(!g.status.textContent.includes('許可が未確認'));
});
