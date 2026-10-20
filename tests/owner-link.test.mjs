import test from 'node:test';import assert from 'node:assert/strict';
import {createOwnerLinkFlow,readOwnerReturn} from '../room-web/owner-link.mjs';
import {createRoomHandler} from '../cloud/room/handler.mjs';
import {readFile} from 'node:fs/promises';import vm from 'node:vm';
const state='a'.repeat(64),code='b'.repeat(32),verifier='c'.repeat(64),origin='https://ai-vdj.vercel.app';
function harness(request){let clock=1000,bus,scheduled=[],calls=[],states=[];const flow=createOwnerLinkFlow({request:async(...args)=>{calls.push(args);return request(...args);},now:()=>clock,onStatus:x=>states.push(x.phase),channel:name=>(bus={name,close(){this.closed=true;},postMessage(data){this.sent=data;}}),schedule:(fn,ms)=>{const timer={fn,ms};scheduled.push(timer);return timer;},cancelTimer:t=>{if(t)t.cancelled=true;}});return{flow,calls,states,get bus(){return bus;},get timers(){return scheduled;},advance:ms=>{clock+=ms;},callback:()=>bus.onmessage({data:{type:'owner-link',state:bus.name.slice('ai-vdj-owner-'.length),code}})};}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('PKCE start sends only state/challenge, double click does not send twice, callback exchanges once',async()=>{
 const h=harness(async path=>path.endsWith('request-link')?{accepted:true}:{bearer:'synthetic-short-bearer',expiresAt:100});
 await h.flow.begin('owner@example.test');assert.equal(h.flow.read().phase,'WAITING');
 assert.equal(await h.flow.begin('owner@example.test'),false);assert.equal(h.calls.length,1);
 const send=h.calls[0][1].body;assert.equal(send.state.length,64);assert.equal(send.challenge.length,43);assert.equal(send.verifier,undefined);
 const started=h.callback();const duplicate=h.callback();await Promise.all([started,duplicate]);
 assert.equal(h.calls.length,2);assert.equal(h.calls[1][1].body.verifier.length,64);
 assert.equal(h.flow.getBearer(),'synthetic-short-bearer');assert.equal(h.flow.read().phase,'SIGNED_IN');assert.equal(h.bus.closed,true);
 h.advance(100000);assert.equal(h.flow.getBearer(),null);assert.equal(h.flow.read().phase,'EXPIRED');
});
test('wrong state and malformed code never exchange; timeout expires the waiting attempt',async()=>{
 const h=harness(async()=>({accepted:true}));await h.flow.begin('owner@example.test');
 await h.bus.onmessage({data:{type:'owner-link',state,code}});
 await h.bus.onmessage({data:{type:'owner-link',state:h.bus.name.slice(13),code:'invalid'}});
 assert.equal(h.calls.length,1);h.timers[0].fn();assert.equal(h.flow.read().phase,'EXPIRED');assert.equal(h.flow.getBearer(),null);
});
test('lost send receipt retains the same verifier for email completion and never automatically resends',async()=>{
 const h=harness(async path=>{if(path.endsWith('request-link'))throw Error('response lost');return {bearer:'short',expiresAt:100};});
 await h.flow.begin('owner@example.test');assert.equal(h.flow.read().phase,'UNKNOWN');assert.equal(await h.flow.begin('owner@example.test'),false);
 await h.callback();assert.equal(h.flow.getBearer(),'short');assert.equal(h.calls.length,2);
});
test('cancel/dispose reject a late exchanged bearer; no back navigation restoration',async()=>{
 for(const action of ['cancel','dispose']){
  const hold=deferred(),h=harness(async path=>path.endsWith('request-link')?{accepted:true}:hold.promise);
  await h.flow.begin('owner@example.test');const pending=h.callback();h.flow[action]();hold.resolve({bearer:'late',expiresAt:100});await pending;
  assert.equal(h.flow.getBearer(),null);assert.equal(h.bus.closed,true);
  if(action==='dispose')assert.equal(await h.flow.begin('owner@example.test'),false);
 }
});
test('cancelling a pending request cannot re-enable a disposed or new attempt',async()=>{
 const hold=deferred(),h=harness(async()=>hold.promise);const sending=h.flow.begin('owner@example.test');
 await new Promise(r=>setImmediate(r));h.flow.dispose();hold.resolve({accepted:true});await sending;
 assert.equal(h.flow.read().phase,'CLOSED');assert.equal(h.flow.getBearer(),null);
});
test('expired/denied code is never retried or accepted; malformed session fails closed',async()=>{
 for(const answer of [null,{bearer:'expired',expiresAt:0},{bearer:'bad-expiry',expiresAt:Infinity}]){
  const h=harness(async path=>path.endsWith('request-link')?{accepted:true}:answer);
  await h.flow.begin('owner@example.test');await h.callback();assert.equal(h.flow.read().phase,'FAILED');assert.equal(h.flow.getBearer(),null);assert.equal(h.calls.length,2);
 }
});
test('callback accepts exact origin/path and one state/code, rejects implicit fragments, redirects, repeats and errors',()=>{
 const url=origin+'/room/auth-return?state='+state+'&code='+code;
 assert.deepEqual(readOwnerReturn(url,origin),{type:'owner-link',state,code});
 for(const bad of [url+'&state='+state,url+'&next=https://evil.test',url+'#access_token=example',url.replace(origin,'https://evil.test'),url.replace('/auth-return','/other'),origin+'/room/auth-return?error=expired',origin+'/room/auth-return'])assert.equal(readOwnerReturn(bad,origin),null);
});
test('actual callback script strips URL before broadcast, handles ACK and BFCache without leaking a code to DOM',async()=>{
 const source=(await readFile(new URL('../room-web/owner-return.mjs',import.meta.url),'utf8')).replace("import {readOwnerReturn} from './owner-link.mjs';",'');
 const node={textContent:''},events={},order=[];let bus,timer;
 const context={readOwnerReturn,location:{href:origin+'/room/auth-return?state='+state+'&code='+code,origin},history:{replaceState(_a,_b,path){order.push('clean');assert.equal(path,'/room/auth-return');}},document:{getElementById:()=>node},window:{addEventListener(name,fn){events[name]=fn;}},setTimeout:fn=>(timer=fn,1),clearTimeout(){},BroadcastChannel:class{constructor(name){assert.equal(name,'ai-vdj-owner-'+state);bus=this;}postMessage(data){order.push('broadcast');assert.equal(data.code,code);}close(){this.closed=true;}}};
 vm.runInNewContext(source,context);assert.deepEqual(order,['clean','broadcast']);
 bus.onmessage({data:{type:'owner-link-result',state,ok:true}});assert.ok(node.textContent.includes('ログインを確認しました'));assert.ok(!node.textContent.includes(code));assert.equal(bus.closed,true);
 events.pageshow({persisted:true});assert.ok(node.textContent.includes('終了'));timer();assert.ok(!node.textContent.includes(code));
});
test('callback directs the owner to the originating tab without a fresh unauthenticated navigation',async()=>{
 const html=await readFile(new URL('../room-web/owner-return.html',import.meta.url),'utf8');
 assert.match(html,/最初にログインを始めたAI VDJタブ/);
 assert.doesNotMatch(html,/<a\b[^>]*href=["']\/room(?:["'?/#])/i);
 assert.doesNotMatch(html,/<(?:form|input|button)\b/i);
});
test('HTTP uses bounded allowlist permits, never accepts caller redirect or forged UID, forwards only short session',async()=>{
 let sent=[],exchangeCalls=0;const uid='11111111-1111-4111-a111-111111111111';
 const handler=createRoomHandler({rpc:async args=>args.op==='ownerCheck'?args.verified_uid===uid:true,verifyOwner:async b=>b==='short'?uid:null,requestLink:async(...a)=>sent.push(a),exchangeLink:async()=>{exchangeCalls++;return {bearer:'short',expiresAt:Date.now()/1000+100,refresh_token:'example-hidden',user:{role:'owner'}};}});
 const req=(path,body)=>handler(new Request('https://example.test/api/owner/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 const response=await req('request-link',{email:'owner@example.test',state,challenge:'d'.repeat(43),redirect:'https://evil.test'});
 assert.equal(response.status,200);assert.equal(sent[0][2],origin+'/room/auth-return?state='+state);
 const session=await req('exchange-link',{email:'owner@example.test',code,verifier,verified_uid:uid});assert.equal(session.status,200);assert.deepEqual(Object.keys(await session.json()).sort(),['bearer','expiresAt']);
 assert.equal((await req('exchange-link',{email:'owner@example.test',code,verifier:'short'})).status,400);assert.equal(exchangeCalls,1);
});
test('unlisted email/delivery failure have same receipt; denied verification never calls provider exchange',async()=>{
 let calls=0;const handler=createRoomHandler({rpc:async args=>args.op==='otpPermit',verifyOwner:async()=>null,requestLink:async()=>{throw Error('delivery failed');},exchangeLink:async()=>{calls++;}});
 const post=(path,body)=>handler(new Request('https://example.test/api/owner/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 assert.deepEqual(await (await post('request-link',{email:'owner@example.test',state,challenge:'d'.repeat(43)})).json(),{accepted:true});
 assert.equal((await post('exchange-link',{email:'owner@example.test',code,verifier})).status,403);assert.equal(calls,0);
});
