import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMacOwnerBridge} from '../room-web/mac-owner-bridge.mjs';
function fixture(t,{pairError,attachFailures=0,networkError=false,version='2026-10-15-companion-3',attachReply,onAttach}={}) {
 const previous=globalThis.document,fields=new Map(),calls=[],events=new Map(),timers=[],owner='b'.repeat(64);let beforeAll=0;
 const field=s=>{if(!fields.has(s))fields.set(s,{value:'',textContent:'',disabled:false,hidden:false,attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];}});return fields.get(s);};
 const panel={innerHTML:'',querySelector:field,remove(){}};
 globalThis.document={createElement:()=>panel};t.after(()=>{globalThis.document=previous;});
 const bridge=mountMacOwnerBridge({container:{prepend(){beforeAll++;}},roomId:'synthetic-room',ownerCapability:owner,
  lifecycle:{addEventListener:(k,v)=>events.set(k,v),removeEventListener:k=>events.delete(k)},schedule:cb=>timers.push(cb),cancel(){},
  versionFetch:async()=>new Response(JSON.stringify({macConnectionGuide:version})),
  fetchImpl:async(url,options)=>{
   calls.push({url,options});if(networkError)throw new TypeError('synthetic-network');
   if(url.endsWith('/status'))return new Response(JSON.stringify({code:'LOCAL_STATUS_ONLY'}),{status:403});
   if(url.endsWith('/pair'))return new Response(JSON.stringify(pairError?{code:pairError}:{session:'s'.repeat(43),expiresAt:Date.now()+10000}),{status:pairError?403:200});
   if(url.endsWith('/owner/connect')&&attachReply){onAttach?.();return attachReply;}
   if(url.endsWith('/owner/connect')&&attachFailures-->0)return new Response('{}',{status:503});
   return new Response(JSON.stringify({submissions:2}));
  }});
 t.after(()=>bridge.dispose());
 return {field,calls,events,timers,owner,panel,beforeAll,bridge,
  async ready(){await field('[name=probe]').onclick();field('[name=ready]').onclick();field('[name=code]').value='synthetic-public-code';field('[name=code]').oninput();},
  async connect(){await this.ready();await field('[name=connect]').onclick();}};
}
test('guide is first, inert until explicit probe, and restricts address to approved port',async t=>{
 const f=fixture(t);assert.equal(f.beforeAll,1);assert.equal(f.calls.length,0);assert.equal(f.field('[name=connect]').disabled,true);
 f.field('[name=local]').value='http://127.0.0.1:4567';await f.field('[name=probe]').onclick();assert.equal(f.calls.length,0);
 assert.match(f.field('[data-result]').textContent,/54414/);
 f.field('[name=local]').value='http://127.0.0.1:54414/';await f.field('[name=probe]').onclick();
 assert.equal(f.field('[name=local]').value,'http://127.0.0.1:54414');assert.equal(f.calls.length,1);
 assert(!new Headers(f.calls[0].options.headers).has('X-VDJ-Session'));
 assert.equal(f.field('[data-section="2"]').hidden,false);assert.equal(f.field('[data-section="3"]').hidden,true);
});
test('probe then public code exchange and owner attach clear code without putting credentials in UI or URL',async t=>{
 const f=fixture(t);await f.connect();
 assert.deepEqual(f.calls.map(c=>new URL(c.url).pathname),['/api/status','/api/pair','/api/owner/connect']);
 assert.equal(JSON.parse(f.calls[2].options.body).ownerCapability,f.owner);assert.equal(f.field('[name=code]').value,'');
 assert(!f.field('[data-result]').textContent.includes(f.owner));assert(!f.field('[data-result]').textContent.includes('synthetic-public-code'));
 assert(!f.calls.some(c=>c.url.includes(f.owner)||c.url.includes('synthetic-public-code')));
 assert.match(f.field('[data-phase]').textContent,/接続済み/);assert.match(f.field('[data-result]').textContent,/生成・自動DJ・再生は未実行/);
 await f.field('[name=refresh]').onclick();assert.equal(f.calls.at(-1).url.endsWith('/owner/state'),true);
 f.events.get('pagehide')();assert(f.calls.at(-1).url.endsWith('/api/stop'));assert(!f.calls.at(-1).options.body.includes(f.owner));
});
for(const error of ['PAIRING_EXPIRED','PAIRING_ORIGIN_MISMATCH','PAIRING_USED'])test(`pair error ${error} identifies code type/expiry without automatic resends`,async t=>{
 const f=fixture(t,{pairError:error});await f.connect();assert.equal(f.calls.length,2);
 assert.equal(f.field('[name=code]').value,'');assert.equal(f.field('[name=refresh]').disabled,true);
 assert.match(f.field('[data-result]').textContent,/公開画面用コード/);assert(!f.field('[data-result]').textContent.includes('synthetic-public-code'));
});
test('owner attach retry preserves accepted Mac session in memory without exchanging the code again',async t=>{
 const f=fixture(t,{attachFailures:1});await f.connect();assert.match(f.field('[data-result]').textContent,/コードは確認済み/);
 assert.equal(f.field('[name=refresh]').disabled,false);await f.field('[name=refresh]').onclick();
 assert.equal(f.calls.filter(c=>c.url.endsWith('/pair')).length,1);assert.equal(f.calls.filter(c=>c.url.endsWith('/owner/connect')).length,2);
 assert.match(f.field('[data-phase]').textContent,/接続済み/);
});
test('network error does not blame code and CSP event identifies old-tab restriction',async t=>{
 const f=fixture(t,{networkError:true});await f.field('[name=probe]').onclick();
 assert.match(f.field('[data-result]').textContent,/コードが間違っているとは判断できません/);
 f.events.get('securitypolicyviolation')({effectiveDirective:'connect-src',blockedURI:'http://127.0.0.1:54414/api/status'});
 assert.match(f.field('[data-result]').textContent,/このタブの通信制限/);assert.equal(f.calls.length,1);
 f.events.get('securitypolicyviolation')({effectiveDirective:'connect-src',blockedURI:'http://127.0.0.1:54414'});
 assert.equal(f.field('[data-update-warning]').hidden,false);
 assert.equal(f.field('[name=probe]').disabled,true);assert.match(f.field('[data-next]').textContent,/新しい画面/);
});
test('session expiry and back-forward cache cannot retain stale connected UI',async t=>{
 const f=fixture(t);await f.connect();f.timers[0]();assert.equal(f.field('[name=refresh]').disabled,true);
 assert(!f.field('[data-phase]').textContent.includes('接続済み'));
 f.events.get('pagehide')();f.events.get('pageshow')({persisted:true});
 assert.equal(f.field('[name=probe]').disabled,true);assert.match(f.field('[data-result]').textContent,/古い接続済み表示は引き継ぎません/);
 assert.equal(f.field('[data-phase]').textContent,'接続終了');assert.equal(f.field('[name=check-version]').disabled,true);
});
test('ended Mac session points back to the local confirmation stage',async t=>{
 const f=fixture(t,{pairError:'PAIRING_SESSION_ENDED'});await f.connect();
 assert.equal(f.field('[data-section="3"]').hidden,true);
 assert.equal(f.field('[data-section="2"]').hidden,false);
 assert.match(f.field('[data-next]').textContent,/手順2/);
});
test('newer guide offers a new tab without exchanging code, sharing secrets or reloading',async t=>{
 const f=fixture(t,{version:'synthetic-newer-version'});await f.field('[name=check-version]').onclick();
 assert.equal(f.calls.length,0);assert.equal(f.field('[data-update-warning]').hidden,false);
 assert.match(f.field('[data-version-status]').textContent,/新しい接続画面/);
 assert.match(f.panel.innerHTML,/href="\/room\?macGuide=2026-10-15-companion-3" target="_blank" rel="noopener noreferrer"/);
 assert(!f.panel.innerHTML.includes(f.owner));assert(!/localStorage|sessionStorage/.test(f.panel.innerHTML));
});
test('matching guide hides the new-tab warning',async t=>{
 const f=fixture(t);await f.field('[name=check-version]').onclick();
 assert.equal(f.field('[data-update-warning]').hidden,true);assert.equal(f.calls.length,0);
});
test('late owner acknowledgment after session expiry cannot show a connected result',async t=>{
 let resolveReply,entered;const reply=new Promise(r=>resolveReply=r),ready=new Promise(r=>entered=r);
 const f=fixture(t,{attachReply:reply,onAttach:entered});await f.ready();const connecting=f.field('[name=connect]').onclick();
 await ready;f.timers[0]();resolveReply(new Response(JSON.stringify({submissions:2})));await connecting;
 assert(!f.field('[data-phase]').textContent.includes('接続済み'));assert.equal(f.field('[name=refresh]').disabled,true);
 assert.match(f.field('[data-next]').textContent,/手順2/);
});
test('the update checker uses the same Mac guide revision the page and the release advertise',async()=>{
 const {GUIDE_REVISION}=await import('../room-web/mac-owner-bridge.mjs'),{readFile}=await import('node:fs/promises');
 const html=await readFile(new URL('../room-web/room-entry.html',import.meta.url),'utf8');
 const builder=await readFile(new URL('../scripts/build_room_candidate.py',import.meta.url),'utf8');
 assert.equal(html.match(/name="vdj-mac-guide" content="([^"]+)"/)[1],GUIDE_REVISION);
 assert.equal(builder.match(/'macConnectionGuide': '([^']+)'/)[1],GUIDE_REVISION);
});
