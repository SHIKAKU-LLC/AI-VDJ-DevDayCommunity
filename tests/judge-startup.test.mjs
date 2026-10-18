import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRoomController} from '../room-web/judge-controller.mjs';

function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; }
async function until(predicate) {
  for (let n=0; n<100; n++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.fail('Synthetic startup did not reach the expected state');
}
function fixture(t, {holdGeneration=false, failLibrary=false}={}) {
  t.mock.method(Math,'random',()=>0.99);
  const names=['window','document','location','history','sessionStorage','AudioContext','AudioWorkletNode','setInterval','clearInterval'];
  const originals=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  t.after(()=>{for(const [k,d] of originals) {if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}});
  const calls=[], timers=new Map(), sources=[], videos=[], generation=deferred(), media=new Map();
  const data=new Map();
  const presets=[1,2].map(n=>{
    const id=String(n).repeat(64);
    const asset=kind=>{const bytes=Uint8Array.of(n,kind==='audio'?1:2);
      media.set(id+'/'+kind,{bytes,...deferred()});
      return {byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),duration:12,...(kind==='video'?{width:854,height:480}:{})};};
    return {id:'preset:'+id,audio:asset('audio'),video:asset('video')};
  });
  const node=()=>({connect(){},disconnect(){},gain:{value:1,cancelAndHoldAtTime(){},linearRampToValueAtTime(){},setValueAtTime(){}}});
  let context;
  globalThis.AudioContext=class {
    state='suspended'; currentTime=0; sampleRate=44100; destination=node(); resumes=0;
    audioWorklet={addModule:async()=>{}};
    constructor(){context=this;}
    async suspend(){assert.fail('An already suspended context must not block preloading');}
    async resume(){this.resumes++;this.state='running';}
    createGain(){return node();}
    createChannelSplitter(){return node();}
    createAnalyser(){return {...node(),fftSize:2048,getFloatTimeDomainData(){}};}
    async decodeAudioData(){return {duration:12,numberOfChannels:2};}
    createBufferSource(){const source={...node(),start(){sources.push(source);},stop(){}};return source;}
  };
  globalThis.AudioWorkletNode=class {port={postMessage(){}};connect(){} };
  globalThis.window={addEventListener(){},open(){}};
  globalThis.location=new URL('https://test.example/room');
  globalThis.history={replaceState(){}};
  globalThis.sessionStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  globalThis.setInterval=(fn,ms)=>{const id=Symbol();timers.set(id,{fn,ms});return id;};
  globalThis.clearInterval=id=>timers.delete(id);
  const layer={append(v){videos.push(v);}};
  globalThis.document={addEventListener(){},createElement(tag){
    assert.equal(tag,'video');const handlers=new Map(),active=new Set();
    return {duration:12,videoWidth:854,videoHeight:480,currentTime:0,paused:true,
      addEventListener:(name,fn)=>handlers.set(name,fn),
      set src(_){queueMicrotask(()=>handlers.get('loadeddata')?.());},
      classList:{contains:k=>active.has(k),toggle(k,value){value?active.add(k):active.delete(k);}},
      async play(){this.paused=false;},pause(){this.paused=true;},removeAttribute(){},load(){},remove(){}};
  }};
  let libraryFails=failLibrary;
  t.mock.method(globalThis,'fetch',async(path,options={})=>{
    calls.push(String(path));
    if(path==='/api/room-capabilities')return Response.json({generation:true});
    if(path==='/api/judge/rooms')return Response.json({roomId:'synthetic-room',ownerToken:'synthetic',joinUrl:'https://test.example/join/synthetic'});
    if(path.endsWith('/preset-library'))return libraryFails?Response.json({error:'unavailable'},{status:503}):Response.json({presets});
    if(path.includes('/preset-media/')){const key=path.split('/preset-media/')[1];const part=media.get(key);await part.promise;return new Response(part.bytes);}
    if(path.endsWith('/generation')){if(holdGeneration)await generation.promise;return Response.json({jobs:[],playback:{queue:[],played:[],presetsPlayed:[],counts:{}}});}
    if(path.endsWith('/playback')){const input=JSON.parse(options.body);return Response.json(input.action==='claim'?{claim:{id:input.readyIds[0],until:Date.now()+30000}}:{});}
    return Response.json({accepting:true,controlRevision:1,submissions:[]});
  });
  const controller=createRoomController();
  const release=(index,kind)=>media.get(String(index).repeat(64)+'/'+kind).resolve();
  const releaseAll=()=>{for(const v of media.values())v.resolve();generation.resolve();};
  t.after(releaseAll);
  return {controller,calls,presets,release,releaseAll,generation,sources,videos,timers,
    get context(){return context;},set libraryFails(v){libraryFails=v;},
    async start(){await controller.start({stage:{},videos:layer,'vj-overlay':{getContext:()=>null}});}};
}

test('presets preload independently of generation and audio/video download concurrently',async t=>{
  const f=fixture(t,{holdGeneration:true});await f.start();
  const creating=f.controller.create();
  await until(()=>f.calls.filter(p=>p.includes('/preset-media/')).length===2);
  assert.deepEqual(f.calls.filter(p=>p.includes('/preset-media/')).map(p=>p.split('/').at(-1)).sort(),['audio','video']);
  assert.equal(f.controller.getSnapshot().ready,false);
  const playing=f.controller.play();
  await until(()=>f.context.resumes>0);
  assert.equal(f.controller.getSnapshot().playBusy,true);
  f.release(1,'audio');await new Promise(setImmediate);
  assert.equal(f.controller.getSnapshot().ready,false);
  f.release(1,'video');await playing;
  assert.equal(f.controller.getSnapshot().ready,true);
  assert.equal(f.controller.getSnapshot().running,true);
  assert.equal(f.sources.length,1,'the second preset must not delay the first');
  f.context.currentTime=1;
  [...f.timers.values()].find(v=>v.ms===25).fn();
  assert.equal(f.videos.filter(v=>!v.paused).length,1);
  f.releaseAll();await creating;f.controller.stop();
});

test('stop cancels an early play request and late media completion cannot start sound',async t=>{
  const f=fixture(t);await f.start();await f.controller.create();
  await until(()=>f.calls.some(p=>p.includes('/preset-media/')));
  const playing=f.controller.play();await until(()=>f.context.resumes>0);
  f.controller.stop();await playing;
  f.releaseAll();await until(()=>f.controller.getSnapshot().ready);
  assert.equal(f.controller.getSnapshot().running,false);
  assert.equal(f.controller.getSnapshot().playBusy,false);
  assert.equal(f.sources.length,0);
});

test('a failed preset request clears the busy state and a later play retries safely',async t=>{
  const f=fixture(t,{failLibrary:true});await f.start();await f.controller.create();
  await f.controller.play();
  assert.equal(f.controller.getSnapshot().playBusy,false);
  assert.match(f.controller.getSnapshot().error,/プリセットを取得できませんでした/);
  f.libraryFails=false;f.releaseAll();await f.controller.play();
  assert.equal(f.controller.getSnapshot().running,true);
  assert.equal(f.sources.length,1);f.controller.stop();
});
