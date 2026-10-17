import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {mountCloudPlaybackControls,createCloudOwnerPlaybackController} from '../room-web/cloud-playback.mjs';
import {isCloudOutputWaitingError} from '../room-web/cloud-output-bridge.mjs';

const source = (await readFile(new URL('../room-web/cloud-output.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
async function until(check) {
  for (let n=0;n<1000;n++) { if(check())return; await tick(); }
  assert.fail('output fixture did not advance');
}
function element() {
  return {children:[],dataset:{},textContent:'',disabled:false,append(...children){this.children.push(...children);},
    setAttribute(){},remove(){this.removed=true;}};
}
const graphStopReceipt={kind:'selected-player-graph-stopped-v1',stopped:true,graphEpoch:1,targetPlayerId:'synthetic-target',receiptSha256:'a'.repeat(64)};
async function fixture(t, {ready=async()=>({stopped:false,readyCues:2}), serverStop=async()=>({stopped:true}),
  preload=async()=>({prepared:true}),
  startError=null,seedCleanupClockError=false,
  stopCurrent=null,
  autoStart=true,acknowledge=false,selectionMode=n=>n===1?'initial':'restart',startup=async()=>({waitForGeneration:true,
    descriptor:{assetId:'seed',sha256:'a'.repeat(64)},source:{}})}={}) {
  const elements=Object.fromEntries(['status','participant-credit','output','controls'].map(id=>[id,element()]));
  const document={getElementById:id=>elements[id],createElement:element}, listeners=new Map(), contexts=[], adapters=[], calls=[], reports=[], timers=[];
  let handle, registrations=0, starts=0, waiting=0, maximumConnected=0,observerError;
  class Context {
    constructor(){this.sampleRate=44100;this.state='suspended';this.audioWorklet={addModule:async()=>{}};contexts.push(this);}
    async suspend(){this.state='suspended';}
    async close(){this.state='closed';}
  }
  class Node {
    constructor(context){this.context=context;}
    connect(){this.context.connected=true;maximumConnected=Math.max(maximumConnected,contexts.filter(c=>c.connected).length);}
    disconnect(){this.context.connected=false;}
  }
  const channel={async call(type,data,options){
    calls.push({type,data,options});
    if(type==='state'){reports.push(data);return {};}
    if(type==='sourceStartup')return startup();
    if(type==='sourceAsset')return new ArrayBuffer(8);
    if(type==='preload')return preload();
    if(type==='sourceReady')return ready();
    if(type==='sourceStop')return serverStop();
    if(type==='sourceAck')return {accepted:true};
    if(type==='playerObserver')return data.command==='stop'?(stopCurrent?stopCurrent():registrations?graphStopReceipt:{stopped:true,noGraph:true}):{};
    throw Error('unexpected fixture call '+type);
  },close(){}};
  const sandbox={document,location:{search:'',hash:'',origin:'https://vdj.example',protocol:'https:'},history:{},
    window:{opener:{closed:false,postMessage(){}},addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener(){}},
    AudioContext:Context,AudioWorkletNode:Node,ArrayBuffer,Uint8Array,Response,URL,
    setInterval:()=>1,clearInterval(){},setTimeout:fn=>{timers.push(fn);return timers.length;},
    createCloudPlaybackChannel:options=>{handle=options.handle;return channel;},isCloudOutputWaitingError,
    createCloudCreditOverlay:()=>({observePlaybackState(){},clear(){},reset(){},dispose(){}}),
    createVideoAdapter(){},prepareCloudWaitingAudio:async()=>({}),prepareCloudInitialAudio:async()=>({}),
    mountCloudPlaybackControls:options=>mountCloudPlaybackControls({...options,document,onActivated(){
      const work=options.onActivated();
      if(autoStart)void handle('startSource',{}).catch(()=>{});
      return work;
    }}),
    createCloudPlaybackAdapter(options){
      let phase='IDLE', revision=options.initialPlaybackRevision;
      const emit=()=>options.onState(port.read());
      const port={role:'output',read:()=>({phase,activationEnabled:true,playbackRevision:revision}),
        unlock(){options.worklet.context.state='running';phase='READY';emit();return Promise.resolve();},
        async stop(){phase='STOPPED';emit();await options.worklet.stopAudio();},
        // Deliberately models no lease on IDLE: output must close it itself.
        async dispose(){if(phase!=='IDLE')await port.stop();},
        async startWaitingLoop(){waiting++;},async startInitialSource(_plan,input){starts++;if(startError){
          if(seedCleanupClockError)options.onState({...port.read(),phase:'HOLD',reason:'ACTUAL_AUDIO_CLOCK_REQUIRED'});
          throw startError;
        }if(acknowledge)await input.markSourceStarted({graphEpoch:1});
        return {kind:'cloud-source-playback-started-v1',actual:true,audioStarted:true,participantCredit:false,graphEpoch:registrations,sourceSha256:'a'.repeat(64),sampleRate:44100};},
        readObservationState(){return {};},subscribeObservation(){return ()=>{};},requestObservationWindow(){},readObservationVideo(){}};
      adapters.push(port);return port;
    },
    createBrowserPlayerObserver:options=>{observerError=options.onError;return {async register(){registrations++;return {graphEpoch:registrations,mode:selectionMode(registrations)};},
      close(){},async stop(){},async sample(){},startSampling(){}};}};
  vm.runInNewContext(source,sandbox,{filename:'cloud-output.mjs'});
  listeners.get('message')({source:sandbox.window.opener,origin:sandbox.location.origin,
    data:{type:'ai-vdj-cloud-output-connect',version:1},ports:[{}]});
  await handle('init',{enabled:true,fixtureMode:true,enablePlayerObserver:true,initialPlaybackRevision:7});
  const buttons=()=>elements.controls.children.findLast(c=>!c.removed).children;
  t.after(()=>listeners.get('pagehide')());
  return {handle,contexts,adapters,calls,reports,timers,buttons,elements,registrations:()=>registrations,starts:()=>starts,waiting:()=>waiting,
    failObserver:error=>observerError(error),
    maximumConnected:()=>maximumConnected,phase:()=>adapters.at(-1).read().phase};
}

test('waiting -> ready registers and starts once on the sole graph despite repeated activation',async t=>{
  const second=deferred();let polls=0;
  const h=await fixture(t,{ready:()=>++polls===1?Promise.resolve({stopped:false,readyCues:0}):second.promise});
  const click=h.buttons()[0].onclick;click();click();await until(()=>h.timers.length===1);
  assert.equal(h.waiting(),1);assert.equal(h.registrations(),0);
  await assert.rejects(h.handle('commit',{operationId:1}),/COMMIT_INVALID/);
  h.timers.shift()();await until(()=>polls===2);second.resolve({stopped:false,readyCues:2});
  await until(()=>h.starts()===1);click();await tick();
  assert.equal(h.registrations(),1);assert.equal(h.contexts.length,1);assert.equal(h.maximumConnected(),1);
  assert.equal(h.calls.filter(c=>c.type==='sourceStartup').length,1);
});
test('browser material preparation finishes before fresh graph and finite source; Stop cancels a late preparation',async t=>{
 for(const stop of [false,true]){
  const gate=deferred(),h=await fixture(t,{preload:()=>gate.promise});h.buttons()[0].onclick();
  await until(()=>h.calls.some(c=>c.type==='preload'));assert.equal(h.registrations(),0);assert.equal(h.starts(),0);
  if(stop)await h.handle('stop',{reason:'OWNER_STOP'});
  gate.resolve({prepared:true});await tick();await tick();
  if(stop){assert.equal(h.registrations(),0);assert.equal(h.starts(),0);}else await until(()=>h.starts()===1);
 }
});

test('temporary state failure silences output; explicit confirmed Stop mounts a fresh graph requiring a new gesture',async t=>{
  let fail=true,polls=0;const confirmation=deferred();
  const h=await fixture(t,{ready:async()=>{if(fail&&++polls>1)throw Error('CLOUD_OUTPUT_REQUEST_FAILED');return {stopped:false,readyCues:fail?0:2};},
    stopCurrent:()=>confirmation.promise});
  h.buttons()[0].onclick();await until(()=>h.timers.length===1);assert.equal(h.waiting(),1);h.timers.shift()();
  await until(()=>h.phase()==='STOPPED');await tick();
  assert.equal(h.contexts[0].state,'closed');assert.equal(h.buttons()[0].disabled,true);assert.equal(h.buttons()[1].disabled,false);
  // A separate explicit owner Stop may arrive concurrently with the local UI.
  // Both must share one server invalidation and one replacement graph.
  fail=false;
  h.buttons()[1].onclick();
  const two=h.handle('stop',{reason:'OWNER_STOP'});
  const graphStops=()=>h.calls.filter(c=>c.type==='playerObserver'&&c.data?.command==='stop').length;
  await until(()=>graphStops()>0);
  assert.equal(h.contexts.length,1);assert.equal(h.buttons()[1].disabled,true);
  // No graph was ever registered: the graph Stop confirms nothing to stop and
  // the room's cues are left unstopped, so the next Start can register.
  confirmation.resolve({stopped:true,noGraph:true});await two;
  assert.equal(graphStops(),1);assert.equal(h.calls.filter(c=>c.type==='sourceStop').length,0);
  assert.equal(h.contexts.length,2);assert.equal(h.maximumConnected(),1);
  assert.equal(h.phase(),'IDLE');assert.equal(h.starts(),0);assert.equal(h.registrations(),0);
  assert.equal(h.adapters[1].read().playbackRevision,7);
  h.buttons()[0].onclick();await until(()=>h.starts()===1);assert.equal(h.registrations(),1);
});

test('late ready after owner Stop cannot register or restart; stopped state requires explicit recovery',async t=>{
  const pending=deferred();let polls=0;
  const h=await fixture(t,{ready:()=>{polls++;return pending.promise;}});
  h.buttons()[0].onclick();await until(()=>polls===1);
  await h.handle('stop',{reason:'OWNER_STOP'});
  pending.resolve({stopped:false,readyCues:2});await tick();await tick();
  assert.equal(h.registrations(),0);assert.equal(h.starts(),0);assert.equal(h.phase(),'IDLE');
  assert.equal(h.maximumConnected(),1);assert.equal(h.buttons()[0].disabled,false);
});

test('failed server Stop never mounts or activates a replacement; retry can recover',async t=>{
  let denied=true;
  const h=await fixture(t,{ready:async()=>({stopped:true,readyCues:2}),serverStop:async()=>{if(denied)throw Error('OWNER_DENIED');return {};},
    stopCurrent:async()=>graphStopReceipt});
  h.buttons()[0].onclick();await until(()=>h.phase()==='STOPPED');await tick();
  await assert.rejects(h.handle('stop',{reason:'OWNER_STOP'}),/SERVER_CONFIRMATION_REQUIRED/);
  assert.equal(h.contexts.length,1);assert.equal(h.contexts[0].state,'closed');assert.equal(h.buttons()[1].disabled,false);
  assert.equal(h.starts(),0);assert.equal(h.registrations(),0);
  denied=false;await h.handle('stop',{reason:'OWNER_STOP'});assert.equal(h.phase(),'IDLE');assert.equal(h.contexts.length,2);
});

test('with no registered graph an explicit Stop leaves the room unstopped (no cue Stop without a graph receipt)',async t=>{
  const h=await fixture(t,{stopCurrent:async()=>({stopped:true,noGraph:true})});
  const result=await h.handle('stop',{reason:'CUE_HOST_START_FAILED'});
  assert.equal(result.stopped,true);assert.equal(result.graphStopConfirmed,false);assert.equal(result.noGraph,true);
  assert.equal(h.calls.filter(c=>c.type==='sourceStop').length,0,'a stopped room without a stopped graph could never restart');
  assert.equal(h.phase(),'IDLE');
});

test('Stop before first activation retires the unleased graph and concurrent stops build only once',async t=>{
  const h=await fixture(t);await Promise.all([h.handle('stop',{reason:'OWNER_STOP'}),h.handle('stop',{reason:'OWNER_STOP'})]);
  assert.equal(h.contexts.length,2);assert.equal(h.contexts[0].state,'closed');assert.equal(h.maximumConnected(),1);
  assert.equal(h.starts(),0);assert.equal(h.phase(),'IDLE');
});

test('owner Stop -> persistently stopped ledger -> fresh restart proof and new gesture restores only the source',async t=>{
  let stopped=false;
  const h=await fixture(t,{ready:async()=>({stopped,readyCues:2}),serverStop:async()=>{stopped=true;return {stopped:true};}});
  h.buttons()[0].onclick();await until(()=>h.starts()===1);
  await h.handle('stop',{reason:'OWNER_STOP'});
  assert.equal(h.starts(),1);assert.equal(h.registrations(),1);assert.equal(h.phase(),'IDLE');
  await h.handle('stop',{reason:'OWNER_STOP'});
  h.buttons()[0].onclick();await until(()=>h.starts()===2);
  assert.equal(stopped,true,'only the existing explicit owner start may reset the ledger');
  assert.equal(h.registrations(),2);assert.equal(h.waiting(),0);assert.equal(h.maximumConnected(),1);
});

test('stopped restart rejects an initial-mode proof and never ignores lack of a prior selected graph',async t=>{
  let stopped=false;
  const h=await fixture(t,{ready:async()=>({stopped,readyCues:2}),serverStop:async()=>{stopped=true;return {};},selectionMode:()=> 'initial'});
  h.buttons()[0].onclick();await until(()=>h.starts()===1);
  await h.handle('stop',{reason:'OWNER_STOP'});h.buttons()[0].onclick();await until(()=>h.phase()==='STOPPED');
  assert.equal(h.starts(),1);assert.equal(h.waiting(),0);assert.equal(h.contexts[1].state,'closed');
});

test('no source can play while the first authenticated state read is denied or reports an external Stop',async t=>{
  for(const ready of [async()=>({stopped:true,readyCues:2}),async()=>{throw Error('CLOUD_OUTPUT_REQUEST_FAILED');}]){
    const h=await fixture(t,{ready});
    h.buttons()[0].onclick();await until(()=>h.phase()==='STOPPED');
    assert.equal(h.starts(),0);assert.equal(h.waiting(),0);assert.equal(h.registrations(),0);
  }
});

const remoteFailure=(status,reason)=>Object.assign(Error('CLOUD_OUTPUT_REQUEST_FAILED'),{code:'CLOUD_OUTPUT_REQUEST_FAILED',status,reason});
test('explicit startup waiting rechecks without playing or registering until authenticated startup is ready',async t=>{
  let attempts=0;
  const h=await fixture(t,{startup:async()=>{
    if(++attempts<=2)throw remoteFailure(409,'WAITING_FOR_GENERATION');
    return {waitForGeneration:true,descriptor:{assetId:'seed',sha256:'a'.repeat(64)},source:{}};
  }});
  const activate=h.buttons()[0].onclick;activate();activate();
  await until(()=>h.timers.length===1);
  assert.equal(h.waiting(),0);assert.equal(h.registrations(),0);assert.equal(h.starts(),0);
  assert.equal(h.calls.some(c=>c.type==='sourceAsset'),false);
  h.timers.shift()();await until(()=>attempts===2&&h.timers.length===1);h.timers.shift()();
  await until(()=>h.starts()===1);
  assert.equal(h.registrations(),1);assert.equal(h.contexts.length,1);assert.equal(h.maximumConnected(),1);
});

test('authenticated state waiting409 -> ready preserves the sole waiting producer and starts source once',async t=>{
  let polls=0;
  const h=await fixture(t,{ready:async()=>{
    polls++;if(polls===2)throw remoteFailure(409,'WAITING_FOR_GENERATION');
    return {stopped:false,readyCues:polls===1?0:2};
  }});
  h.buttons()[0].onclick();await until(()=>h.timers.length===1);assert.equal(h.waiting(),1);h.timers.shift()();
  await until(()=>polls===2&&h.timers.length===1);
  assert.equal(h.contexts[0].state,'running');assert.equal(h.waiting(),1);assert.equal(h.registrations(),0);
  assert.equal(h.reports.at(-1).reason,'WAITING_FOR_GENERATION');h.timers.shift()();
  await until(()=>h.starts()===1);assert.equal(h.registrations(),1);assert.equal(h.waiting(),1);
  assert.equal(h.contexts.length,1);assert.equal(h.maximumConnected(),1);
});

test('auth, Stop, expiry, changed scope, generic409 and wrong-status waiting all silence without polling again',async t=>{
  for(const [status,reason] of [[401,'OWNER_DENIED'],[403,'OBSERVER_OWNER_DENIED'],[409,'OWNER_DENIED'],
    [409,'PLAYBACK_STOPPED'],[409,'OBSERVER_GRAPH_EXPIRED'],[409,'OBSERVER_SCOPE_CHANGED'],
    [409,'SOURCE_STARTUP_HOLD'],[409,'CUE_OPERATION_HOLD'],[409,undefined],[403,'WAITING_FOR_GENERATION'],[503,'WAITING_FOR_GENERATION']]){
    let polls=0;
    const h=await fixture(t,{ready:async()=>{
      if(++polls===1)return {stopped:false,readyCues:0};throw remoteFailure(status,reason);
    }});
    h.buttons()[0].onclick();await until(()=>h.timers.length===1);h.timers.shift()();
    await until(()=>h.phase()==='STOPPED');await tick();
    assert.equal(h.contexts[0].state,'closed');assert.equal(h.timers.length,0);assert.equal(polls,2);
    assert.equal(h.starts(),0);assert.equal(h.registrations(),0);assert.equal(h.buttons()[1].disabled,false);
  }
});

test('owner Stop during startup waiting cancels the scheduled retry and cannot restart on its late timer',async t=>{
  let attempts=0;
  const h=await fixture(t,{startup:async()=>{attempts++;throw remoteFailure(409,'WAITING_FOR_GENERATION');}});
  h.buttons()[0].onclick();await until(()=>h.timers.length===1);
  await h.handle('stop',{reason:'OWNER_STOP'});h.timers.shift()();await tick();await tick();
  assert.equal(attempts,1);assert.equal(h.waiting(),0);assert.equal(h.starts(),0);assert.equal(h.registrations(),0);
  assert.equal(h.phase(),'IDLE');assert.equal(h.maximumConnected(),1);
});

test('initial source ACK response uses its finite20s deadline instead of the shorter channel default',async t=>{
 const h=await fixture(t,{acknowledge:true});h.buttons()[0].onclick();await until(()=>h.calls.some(c=>c.type==='sourceAck'));
 const request=h.calls.find(c=>c.type==='sourceAck');assert.equal(request.options.timeoutMs,20000);
 assert.equal(h.calls.filter(c=>c.type==='sourceAck').length,1);assert.equal(h.registrations(),1);
});

test('a fresh output recovers a saved stopped graph only after explicit authenticated Stop and a new gesture',async t=>{
 const h=await fixture(t,{ready:async()=>({stopped:true,readyCues:2}),selectionMode:()=> 'restart',
  stopCurrent:async()=>({kind:'selected-player-graph-stopped-v1',stopped:true,graphEpoch:29,targetPlayerId:'saved-player',receiptSha256:'a'.repeat(64)})});
 await h.handle('stop',{reason:'OWNER_STOP'});assert.equal(h.registrations(),0);assert.equal(h.starts(),0);
 assert.equal(h.calls.filter(x=>x.type==='playerObserver'&&x.data.command==='stop').length,1);
 h.buttons()[0].onclick();await until(()=>h.starts()===1);assert.equal(h.registrations(),1);
});
test('a fresh output does not treat noGraph as a prior stopped graph',async t=>{
 const h=await fixture(t,{ready:async()=>({stopped:true,readyCues:2}),stopCurrent:async()=>({stopped:true,noGraph:true})});
 await h.handle('stop',{reason:'OWNER_STOP'});h.buttons()[0].onclick();await until(()=>h.phase()==='STOPPED');
 assert.equal(h.registrations(),0);assert.equal(h.starts(),0);
});

for(const [message,expected] of [['ACTUAL_SOURCE_TIMELINE_REQUIRED','ACTUAL_SOURCE_TIMELINE_REQUIRED'],
 ['https://private.invalid/secret?credential=private-value','PLAYBACK_HOLD']])test('normal recovery retains only bounded failure code: '+expected,async t=>{
 const h=await fixture(t,{startError:Error(message)});h.buttons()[0].onclick();
 await until(()=>h.starts()===1&&h.elements.status.textContent.includes(expected));
 await h.handle('stop',{reason:'OWNER_STOP'});
 assert.equal(h.phase(),'IDLE');assert(h.elements.status.textContent.includes(expected));
 assert(!h.elements.status.textContent.includes('private-value'));assert(!h.elements.status.textContent.includes('https://'));
});

test('startup failure survives the shared-context clock error emitted during seed disposal',async t=>{
 const h=await fixture(t,{startError:Error('INITIAL_AUDIO_ACK_TIMEOUT'),seedCleanupClockError:true});
 h.buttons()[0].onclick();await until(()=>h.elements.status.textContent.includes('INITIAL_AUDIO_ACK_TIMEOUT'));
 await h.handle('stop',{reason:'OWNER_STOP'});
 assert(h.elements.status.textContent.includes('INITIAL_AUDIO_ACK_TIMEOUT'));
 assert(!h.elements.status.textContent.includes('ACTUAL_AUDIO_CLOCK_REQUIRED'));
});
test('a rejected live observation keeps output playing and stays visible after owner Stop',async t=>{
 const h=await fixture(t);h.buttons()[0].onclick();await until(()=>h.starts()===1);
 const before=h.phase();h.failObserver(Error('PLAYER_OBSERVER_HOLD'));await tick();await tick();
 // Telemetry is not the playback clock: one rejected report never stops sound.
 assert.equal(h.phase(),before);assert.notEqual(h.phase(),'STOPPED');
 await h.handle('stop',{reason:'OWNER_STOP'});
 assert(h.elements.status.textContent.includes('PLAYER_OBSERVER_HOLD'));
});


test('permission and prepared media never start the finite source before one owner Start',async t=>{
 const h=await fixture(t,{autoStart:false});
 await assert.rejects(h.handle('startSource',{}),/SOURCE_START_INVALID/);
 h.buttons()[0].onclick();await until(()=>h.calls.some(c=>c.type==='preload'));
 await tick();await tick();
 assert.equal(h.registrations(),0);assert.equal(h.starts(),0);assert.equal(h.reports.at(-1).sourceStartAvailable,true);
 const first=h.handle('startSource',{}),duplicate=h.handle('startSource',{});
 const [a,b]=await Promise.all([first,duplicate]);assert.deepEqual(a,b);
 assert.equal(a.sourceOnly,true);assert.equal(a.actual,true);assert.equal(a.participantCredit,false);
 assert.equal(h.registrations(),1);assert.equal(h.starts(),1);
 assert.deepEqual(await h.handle('startSource',{}),a,'completed Start reconciles without a second queue');
 assert.equal(h.starts(),1);
});
test('one Start during pending preparation automatically starts once when it completes',async t=>{
 const gate=deferred(),h=await fixture(t,{autoStart:false,preload:()=>gate.promise});
 h.buttons()[0].onclick();await until(()=>h.calls.some(c=>c.type==='preload'));
 const started=h.handle('startSource',{});assert.equal(h.registrations(),0);assert.equal(h.starts(),0);
 gate.resolve({prepared:true});const ack=await started;
 assert.equal(ack.actual,true);assert.equal(h.registrations(),1);assert.equal(h.starts(),1);
});
test('Stop cancels a requested Start before late preparation can create a source or graph',async t=>{
 const gate=deferred(),h=await fixture(t,{autoStart:false,preload:()=>gate.promise});
 h.buttons()[0].onclick();await until(()=>h.calls.some(c=>c.type==='preload'));
 const rejected=assert.rejects(h.handle('startSource',{}),/CANCELLED/);
 await h.handle('stop',{reason:'OWNER_STOP'});await rejected;gate.resolve({prepared:true});await tick();await tick();
 assert.equal(h.starts(),0);assert.equal(h.registrations(),0);assert.equal(h.phase(),'IDLE');
});


test('one owner Start waits for preparation and source ACK, then starts Cue selection automatically',async t=>{
 const preparation=deferred(),h=await fixture(t,{autoStart:false,preload:()=>preparation.promise});
 h.buttons()[0].onclick();await until(()=>h.calls.some(c=>c.type==='preload'));
 const actions=[],timers=[];
 const owner=createCloudOwnerPlaybackController({roomId:'11111111-1111-4111-8111-111111111111',ownerCapability:'a'.repeat(64),
  outputPort:{role:'output',read:()=>h.reports.at(-1),startSource:()=>h.handle('startSource',{}),
   commitPlayback:()=>{throw Error('UNEXPECTED_UNRESERVED_COMMIT');},stop:()=>h.handle('stop',{reason:'OWNER_STOP'})},
  request:async path=>{const action=path.split('/').at(-1);actions.push(action);return action==='reserve'?{state:'HOLD'}:{};},
  lifecycle:{addEventListener(){},removeEventListener(){}},schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel(){}});
 const first=owner.start(),duplicate=owner.start();assert.equal(first,duplicate);
 await tick();assert.deepEqual(actions,[]);assert.equal(h.starts(),0);assert.equal(h.registrations(),0);
 preparation.resolve({prepared:true});await first;await until(()=>actions.includes('reserve'));
 assert.deepEqual(actions,['start','reserve']);assert.equal(h.starts(),1);assert.equal(h.registrations(),1);
 assert.equal(h.calls.filter(c=>c.type==='sourceStartup').length,1);
 await owner.stop();
});
test('開場 on a stopped room confirms the server graph Stop and restarts on the same gesture; no receipt still holds',async t=>{
  const receipt={kind:'selected-player-graph-stopped-v1',stopped:true,graphEpoch:62,targetPlayerId:'previous-target',receiptSha256:'b'.repeat(64)};
  const h=await fixture(t,{ready:async()=>({stopped:true,readyCues:2}),stopCurrent:async()=>receipt,selectionMode:()=>'restart'});
  h.buttons()[0].onclick();await until(()=>h.starts()===1);
  assert.equal(h.registrations(),1,'one restart registration');assert.equal(h.contexts.length,1,'no second graph or gesture');
  assert.equal(h.calls.filter(c=>c.type==='sourceStop').length,1);
  assert.equal(h.calls.filter(c=>c.type==='playerObserver'&&c.data.command==='stop').length,1);
  const held=await fixture(t,{ready:async()=>({stopped:true,readyCues:2}),stopCurrent:async()=>({stopped:true,noGraph:true})});
  held.buttons()[0].onclick();await until(()=>held.elements.status.textContent.includes('WAITING_GENERATION_STOPPED'));
  assert.equal(held.registrations(),0);assert.equal(held.starts(),0);
});
