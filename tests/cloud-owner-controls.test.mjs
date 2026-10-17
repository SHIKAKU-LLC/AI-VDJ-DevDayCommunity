import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cloudReadiness,mountCloudOwnerControls} from '../room-web/cloud-owner-controls.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(capabilities,options={}){
 const fields=Object.fromEntries(['cloud-open-output','cloud-start','cloud-stop','cloud-status'].map(id=>[id,{disabled:false,textContent:''}]));
 let opens=0,starts=0,stops=0,state={phase:'IDLE',activationEnabled:true},onOutput;
 const controller={start:async()=>{starts++;await options.start?.();},stop:async()=>{stops++;if(options.stopFails?.())throw Error('OUTPUT_STOP_SERVER_CONFIRMATION_REQUIRED');state={...state,phase:'STOPPED',sourceStartAvailable:false};onOutput?.(state);},dispose:async()=>{}};
 const port={role:'output',read:()=>state,dispose:async()=>{}};
 const ui=mountCloudOwnerControls({root:{querySelector:s=>fields[s.slice(1)]},capabilities,
  openOutput:({onState})=>{opens++;onOutput=onState;if(options.blocked)throw Error('popup blocked');return port;},createController:()=>controller});
 return {fields,ui,opens:()=>opens,starts:()=>starts,stops:()=>stops,setState:(phase,extra={})=>{state={...state,phase,...extra};onOutput?.(state);}};
}
const capabilities={generation:true,autoDJ:true,cloud:{generationJobs:true,portableQC:true,browserPlayback:true}};
test('normal cloud readiness requires all trusted server activation flags; Mac has no prerequisite',()=>{
 for(const value of [{}, {generation:true,autoDJ:true}, {...capabilities,cloud:{...capabilities.cloud,portableQC:false}}, {...capabilities,generation:false}])
  assert.equal(cloudReadiness(value).ready,false);
 assert.equal(cloudReadiness(capabilities).ready,true);assert.equal(cloudReadiness(capabilities).macRequired,false);
 const x=fixture({});assert.equal(x.fields['cloud-open-output'].disabled,true);assert.match(x.fields['cloud-status'].textContent,/準備中/);
 x.fields['cloud-open-output'].onclick();assert.equal(x.opens(),0);void x.ui.dispose();
});
test('owner controls wait for output gesture and invalidate server after output stop without recursion',async()=>{
 const x=fixture(capabilities);x.fields['cloud-open-output'].onclick();assert.equal(x.opens(),1,'open happens in original gesture');await tick();
 assert.equal(x.fields['cloud-start'].disabled,true);x.setState('READY');assert.equal(x.fields['cloud-start'].disabled,false);
 x.fields['cloud-start'].onclick();await tick();assert.equal(x.starts(),1);
 x.setState('STOPPED');await tick();assert.equal(x.stops(),1);assert.equal(x.fields['cloud-start'].disabled,true);
 await x.ui.dispose();assert.equal(x.fields['cloud-open-output'].onclick,null);
});
test('blocked popup leaves a concrete retry explanation',()=>{
 const x=fixture(capabilities,{blocked:true});x.fields['cloud-open-output'].onclick();
 assert.match(x.fields['cloud-status'].textContent,/ポップアップ/);assert.equal(x.fields['cloud-open-output'].disabled,false);void x.ui.dispose();
});
test('public entry provides browser room creation without Mac or credential setup',async()=>{
 const host=await readFile(new URL('../room-web/room-host.mjs',import.meta.url),'utf8'),html=await readFile(new URL('../room-web/room-entry.html',import.meta.url),'utf8');
 assert.doesNotMatch(host,/mountMacPreflight|mountMacCompanionBridge|createProductionOwnerRouter/);
 assert.doesNotMatch(html,/id="optional-mac"|このMacの接続・停止・復旧|type="password"/);
 assert.match(html,/id="create-room"/);assert.match(host,/request\('\/api\/judge\/rooms'/);
 assert.match(host,/value\.serverManaged!==true\|\|value\.mode!=='judge-cloud'/);
 assert.match(html,/id="cloud-open-output"/);assert.match(html,/id="qr-slot"/);
});

test('verified setup refresh can enable the existing output gesture without rebuilding its controls',async()=>{
 const x=fixture({});assert.equal(x.fields['cloud-open-output'].disabled,true);x.ui.setCapabilities(capabilities);assert.equal(x.fields['cloud-open-output'].disabled,false);x.fields['cloud-open-output'].onclick();await tick();assert.equal(x.opens(),1);await x.ui.dispose();
});


test('owner may request Start during authorized preparation and Stop stays available while it waits',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});const x=fixture(capabilities,{start:()=>pending});
 x.fields['cloud-open-output'].onclick();await tick();
 x.setState('PREPARING');assert.equal(x.fields['cloud-start'].disabled,true);
 x.setState('PREPARING',{sourceStartAvailable:true});assert.equal(x.fields['cloud-start'].disabled,false);
 x.fields['cloud-start'].onclick();await tick();assert.equal(x.starts(),1);
 assert.equal(x.fields['cloud-start'].disabled,true);assert.equal(x.fields['cloud-stop'].disabled,false);
 x.fields['cloud-stop'].onclick();await tick();assert.equal(x.stops(),1);
 release();await tick();assert.equal(x.starts(),1);assert.equal(x.fields['cloud-start'].disabled,true);
 await x.ui.dispose();
});

test('an unconfirmed Stop stays on hold with a retry message instead of reporting STOPPED',async()=>{
 let fail=true;const x=fixture(capabilities,{stopFails:()=>fail});x.fields['cloud-open-output'].onclick();await tick();
 x.setState('READY');x.fields['cloud-start'].onclick();await tick();
 x.fields['cloud-stop'].onclick();await tick();await tick();
 assert.equal(x.stops(),1);assert.match(x.fields['cloud-status'].textContent,/もう一度「演奏停止」/);
 assert.equal(x.fields['cloud-stop'].disabled,false,'Stop can be retried');
 fail=false;x.fields['cloud-stop'].onclick();await tick();await tick();
 assert.equal(x.stops(),2);assert.match(x.fields['cloud-status'].textContent,/停止しました/);
 await x.ui.dispose();
});
test('an output HOLD that stops the show names its cause on the owner screen',async()=>{
 const x=fixture(capabilities);x.fields['cloud-open-output'].onclick();await tick();x.setState('READY');
 x.fields['cloud-start'].onclick();await tick();x.setState('PLAYING');
 x.setState('HOLD',{reason:'ACTUAL_AUDIO_CLOCK_REQUIRED'});await tick();await tick();assert.equal(x.stops(),1);
 assert.match(x.fields['cloud-status'].textContent,/停止しました.*コード: OUTPUT_HOLD:ACTUAL_AUDIO_CLOCK_REQUIRED/);
 x.setState('READY',{reason:undefined});x.fields['cloud-start'].onclick();await tick();x.setState('PLAYING');
 x.fields['cloud-stop'].onclick();await tick();await tick();assert.doesNotMatch(x.fields['cloud-status'].textContent,/コード/,'an owner Stop shows no stale cause');
 await x.ui.dispose();
});
test('a failed Start stays HOLD with its reason until the owner retries Start or presses Stop',async()=>{
 let fail=true;const x=fixture(capabilities,{start:async()=>{if(fail)throw Error('CUE_HOST_START_FAILED');}});
 x.fields['cloud-open-output'].onclick();await tick();x.setState('READY');
 x.fields['cloud-start'].onclick();await tick();await tick();
 x.setState('PLAYING');x.setState('READY');
 assert.match(x.fields['cloud-status'].textContent,/確認しています.*コード: START_FAILED:CUE_HOST_START_FAILED/,'the output READY/PLAYING does not paint over the failed Start');
 assert.equal(x.fields['cloud-start'].disabled,false,'Start can be retried');
 fail=false;x.fields['cloud-start'].onclick();await tick();await tick();x.setState('PLAYING');
 assert.doesNotMatch(x.fields['cloud-status'].textContent,/START_FAILED/);
 await x.ui.dispose();
});
test('owner page retries credit delivery and stops server playback before disposing output',async()=>{
 const host=await readFile(new URL('../room-web/room-host.mjs',import.meta.url),'utf8');
 assert.match(host,/function deliverCredit\(credit\)/);assert.match(host,/showCredit\(credit\)\.catch\(\(\)=>\{if\(\+\+attempt<5/);
 assert.doesNotMatch(host,/showCredit\(state\.currentCredit\)\.catch\(\(\)=>\{\}\)/,'a failed delivery is not discarded');
 const hide=host.slice(host.lastIndexOf("window.addEventListener('pagehide'"));
 assert(hide.indexOf('cloudControls?.dispose()')<hide.indexOf('outputBridge?.dispose()'),'server Stop is requested before output disposal');
 assert.match(hide,/stopping\.finally\(\(\)=>\{ownerSetup\?\.dispose\(\);outputBridge\?\.dispose\(\)/);
 const output=await readFile(new URL('../room-web/cloud-output.mjs',import.meta.url),'utf8');
 assert.match(output,/\['OWNER_STOP','OUTPUT_STOP','CUE_HOST_START_FAILED','PAGE_HIDE','DISPOSE'\]/,'page teardown retires the server graph');
});
test('page close sends an unload-safe Stop directly to the server before ordinary disposal',async()=>{
 const host=await readFile(new URL('../room-web/room-host.mjs',import.meta.url),'utf8');
 const hide=host.slice(host.lastIndexOf("window.addEventListener('pagehide'"));
 const early=host.indexOf("window.addEventListener('pagehide',()=>{try{unloadStop?.();}catch{}},{capture:true,once:true});");
 assert(early>0&&early<host.indexOf('async function mount('),'the capture listener is registered before a room can mount');
 assert(!hide.includes('unloadStop'),'teardown no longer races the Stop');
 assert.match(host,/cloudControls\?\.started!==true\)return;/,'nothing is sent before a Start');
 assert.match(host,/\/player\/unload-stop`,\{method:'POST',headers,body:'\{\}',keepalive:true\}/,'one ordered server-side unload Stop');
 assert.doesNotMatch(host.slice(host.indexOf('unloadStop=()=>')),/\/cues\/stop`/,'no independent cue Stop at unload');
 assert.match(host,/keepalive:true/);
 assert.doesNotMatch(host,/mac-companion-bridge|mac-owner-bridge/,'the browser request does not depend on a local bridge');
});
test('Stop stays disabled until a Start, and after a confirmed Stop until the next Start',async()=>{
 const x=fixture(capabilities);x.fields['cloud-open-output'].onclick();await tick();x.setState('READY');
 assert.equal(x.fields['cloud-stop'].disabled,true,'no graph or reservation yet: a Stop would mark the room stopped');
 x.fields['cloud-stop'].onclick?.();await tick();assert.equal(x.stops(),0);
 x.fields['cloud-start'].onclick();await tick();assert.equal(x.fields['cloud-stop'].disabled,false);
 x.fields['cloud-stop'].onclick();await tick();await tick();assert.equal(x.stops(),1);
 assert.equal(x.fields['cloud-stop'].disabled,true,'stopped until the next Start');
 await x.ui.dispose();
});
