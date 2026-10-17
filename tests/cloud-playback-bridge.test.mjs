import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudPlaybackChannel, createCloudOutputBridge, createCloudMediaPreloadCache, cloudPlaybackCommitTimeoutMs, isCloudOutputWaitingError, classifyPlaybackFailure} from '../room-web/cloud-output-bridge.mjs';
import {pcmSha256} from '../room-web/playback/cue-contract.mjs';

const roomId = '11111111-1111-4111-8111-111111111111', hash = 'a'.repeat(64), intent = 'b'.repeat(64);
const bytes = new Uint8Array([1, 2, 3, 4]), sha = await pcmSha256(bytes);
const tick = () => new Promise(resolve => setImmediate(resolve));
test('preloaded bytes are bounded, hash-verified immutable copies; cancellation cannot populate a cleared cache',async()=>{
 const asset={assetId:'render-1',sha256:sha,byteLength:bytes.length,mimeType:'audio/wav'};let reads=0,release;
 const cache=createCloudMediaPreloadCache({origin:'https://vdj.example',roomId,request:async()=>{reads++;return new Response(bytes,{headers:{'content-type':'audio/wav'}});}});
 assert.deepEqual(await cache.warm([asset]),{prepared:true,assetCount:1});const copy=cache.read(asset);copy[0]=99;
 assert.deepEqual(cache.read(asset),bytes);assert.equal(cache.read({...asset,sha256:hash}),null);assert.equal(reads,1);
 await assert.rejects(cache.warm([{...asset,byteLength:129*1024*1024}]));assert.equal(reads,1);
 await assert.rejects(cache.warm([{...asset,sha256:hash}]),/ASSET_SHA/);assert.equal(cache.read(asset),null);
 const late=createCloudMediaPreloadCache({origin:'https://vdj.example',roomId,request:()=>new Promise(r=>{release=r;})});
 const pending=late.warm([asset]);late.clear();release(new Response(bytes,{headers:{'content-type':'audio/wav'}}));
 await assert.rejects(pending);assert.equal(late.read(asset),null);
});
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.fail('condition not reached'); }
function input(guard = async () => true) {
  const cue = {roomId, cueId: 'cue-1', generationId: 'gen-1', submissionId: 'submission-1', commonIntentSha256: intent,
    controlVersion: 1, atomicReady: true, status: 'READY'};
  for (const channel of ['music', 'video']) cue[channel] = {status: 'READY', qc: {passed: true}, durationSeconds: 24,
    asset: {assetId: channel + '-1', sha256: hash}, binding: {roomId, generationId: cue.generationId, submissionId: cue.submissionId,
      controlVersion: 1, commonIntentSha256: intent, channel}};
  cue.video.review = {accepted: true, ownerArtisticApproval: true, assetSha256: hash, commonIntentSha256: intent};
  cue.video.compositionQC = {passed: true}; cue.video.clips = [{assetId: 'clip-1', sha256: sha, durationSeconds: 24}];
  cue.video.timeline = {durationSeconds: 24, timeStretch: false, segments: [{assetId: 'clip-1', sha256: sha,
    startSeconds: 0, endSeconds: 24, sourceInSeconds: 0, sourceOutSeconds: 24, playbackRate: 1}]};
  return {roomId, cue, plan: {cueId: cue.cueId, transition: {renderedSha256: sha, exitFrame: 0}}, expectedRevision: 1, guard};
}
async function setup(t, options = {}) {
  const handlers = new Map(), requests = [], transferred = [], initializations = []; let outputChannel, commandCount = 0, sourceCount=0;
  const output = {closed: false, focus() {}, postMessage(message, origin, ports) {
    transferred.push({message, origin});
    outputChannel = createCloudPlaybackChannel({port: ports[0], timeoutMs: 1000, handle: async (type, data) => {
      if (type === 'init') { initializations.push(structuredClone(data)); await outputChannel.call('state', {phase: 'READY', cloudRole: 'output', playbackRevision: data.initialPlaybackRevision, sourceCount: 1}); return {ready: true}; }
      if (type === 'stop') return {stopped: true};
      if (type === 'startSource') {sourceCount++;return options.sourceStart();}
      if (type === 'commitResult') return options.commitResult ? options.commitResult(data) : Promise.reject(Error('unknown'));
      if (type === 'commit') {
        commandCount++;
        return options.commit ? options.commit(outputChannel, data) : {roomId, cueId: data.cue.cueId, clipId: data.cue.music.asset.assetId,
          playbackRevision: data.expectedRevision, audioTime: .01, actual: true, audioStarted: true, videoPresented: true};
      }
      throw Error('unknown');
    }});
  }};
  const window = {location: {origin: 'https://vdj.example'}, open(path, name) { assert.equal(path, '/cloud-output.html'); assert.equal(name, 'ai-vdj-cloud-output'); return output; },
    addEventListener(type, fn) { handlers.set(type, fn); }, removeEventListener(type) { handlers.delete(type); }};
  const manifest = {roomId, cueId: 'cue-1', generationId: 'gen-1', submissionId: 'submission-1', commonIntentSha256: intent, controlVersion: 1,
    audio: {assetId: 'music-1', sha256: hash, render: {assetId: 'render-1', sha256: sha, byteLength: 4, mimeType: 'audio/wav'}},
    videos: [{assetId: 'clip-1', sha256: sha, byteLength: 4, mimeType: 'video/mp4'}]};
  const bridge = createCloudOutputBridge({window, enabled: true, fixtureMode: true, timeoutMs: 1000,
    enablePlayerObserver:options.enablePlayerObserver??false,observerRoomId:roomId,
    enableClipRelativeTimeline: options.enableClipRelativeTimeline ?? false,
    resolveManifest: async () => manifest, request: async (path, requestOptions) => {
      requests.push({path, options: requestOptions});
      if(options.request)return options.request(path,requestOptions);
      return new Response(bytes, {headers: {'Content-Type': path.includes('render-1') ? 'audio/wav' : 'video/mp4'}});
    }});
  bridge.openOutput();
  const ready = {source: output, origin: 'https://vdj.example', data: {type: 'ai-vdj-cloud-output-ready', version: 1}};
  t.after(async () => { await bridge.dispose(); outputChannel?.close(); });
  return {bridge, output, requests, manifest, transferred, ready, initializations,
    connect() { handlers.get('message')(ready); }, emit(event) { handlers.get('message')(event); },
    channel: () => outputChannel, commands: () => commandCount,sourceCommands:()=>sourceCount};
}
test('waiting output reads only atomic both-QC readiness and explicit Stop reaches the existing global stop',async t=>{
 const cue=input().cue;
 const f=await setup(t,{enablePlayerObserver:true,request:async(path,options)=>{
  assert.equal(options.method,'POST');assert.equal(options.body,'{}');
  if(path.endsWith('/state'))return Response.json({roomId,stopped:false,cues:[cue,{...cue,atomicReady:false},
    {...cue,video:{qc:{passed:false}}},{...cue,status:'PLAYING'}]});
  assert.equal(path,`/api/rooms/${roomId}/cues/stop`);return Response.json({stopped:true,currentCredit:null});
 }});f.connect();await until(()=>f.channel());
 assert.deepEqual(await f.channel().call('sourceReady',{}),{stopped:false,readyCues:1});
 assert.deepEqual(await f.channel().call('sourceStop',{}),{stopped:true,currentCredit:null});
 await assert.rejects(f.channel().call('sourceReady',{roomId}),/CLOUD_OUTPUT_REQUEST_FAILED/);
 assert.equal(f.requests.length,2);
});

test('clip timeline selection stays off unless the owner facade receives the explicit trusted host feature', async t => {
  const disabled = await setup(t); disabled.connect(); await until(() => disabled.bridge.read().phase === 'READY');
  assert.equal('enableClipRelativeTimeline' in disabled.initializations[0], false);
  const enabled = await setup(t, {enableClipRelativeTimeline: true}); enabled.connect(); await until(() => enabled.bridge.read().phase === 'READY');
  assert.equal(enabled.initializations[0].enableClipRelativeTimeline, true);
  assert.deepEqual(Object.keys(enabled.initializations[0]).sort(), ['enabled', 'fixtureMode', 'initialPlaybackRevision', 'enableClipRelativeTimeline'].sort());
});

test('wrong origin/opener cannot receive the scoped MessagePort; channel transfers no owner proof', async t => {
  const h = await setup(t);
  h.emit({...h.ready, origin: 'https://bad.example'}); h.emit({...h.ready, source: {}});
  assert.equal(h.transferred.length, 0); h.connect(); await until(() => h.bridge.read().phase === 'READY');
  assert.deepEqual(h.transferred[0], {message: {type: 'ai-vdj-cloud-output-connect', version: 1}, origin: 'https://vdj.example'});
  await assert.rejects(h.bridge.unlock(), /OUTPUT_GESTURE_REQUIRED/);
});

test('bound media bytes and guard RPC reuse owner closure; final observed ACK is validated again', async t => {
  const guards = [];
  const h = await setup(t, {commit: async (channel, data) => {
    const op = {operationId: data.operationId};
    assert.equal((await channel.call('guard', {...op, phase: 'prepare'})).valid, true);
    const manifest = await channel.call('manifest', op);
    const asset = manifest.videos[0];
    const content = await channel.call('asset', {...op, assetId: asset.assetId, sha256: asset.sha256});
    assert.deepEqual(new Uint8Array(content), bytes);
    await assert.rejects(channel.call('asset', {...op, assetId: 'unreserved-asset', sha256: sha}));
    assert.equal((await channel.call('guard', {...op, phase: 'ack'})).valid, true);
    return {roomId, cueId: data.cue.cueId, clipId: data.cue.music.asset.assetId, playbackRevision: 1,
      audioTime: .01, actual: true, audioStarted: true, videoPresented: true};
  }});
  h.connect(); await until(() => h.bridge.read().phase === 'READY');
  const ack = await h.bridge.commitPlayback(input(async ({phase}) => { guards.push(phase); return true; }));
  assert.equal(ack.actual, true); assert.deepEqual(guards, ['prepare', 'ack', 'ack']);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].path, `/api/rooms/${roomId}/media/clip-1?sha256=${sha}`);
  assert.equal(h.requests[0].options.headers, undefined);
});

test('secrets, arbitrary URLs and callable data cannot cross the port', async t => {
  const h = await setup(t); h.connect(); await until(() => h.bridge.read().phase === 'READY');
  for (const [key, value] of [['ownerCapability', hash], ['url', 'https://bad.example'], ['note', 'https://bad.example'], ['handler', () => {}]]) {
    const i = input(); i.plan[key] = value; await assert.rejects(h.bridge.commitPlayback(i), /DATA_INVALID/);
  }
  assert.equal(h.commands(), 0);
});
test('preload finishes before commit, but cached bytes still require the exact live operation manifest and guards',async t=>{
 const guards=[];let manifestReads=0;
 const f=await setup(t,{enablePlayerObserver:true,request:async path=>path.endsWith('/playback/preload')?
  Response.json({roomId,assets:[{assetId:'clip-1',sha256:sha,byteLength:4,mimeType:'video/mp4'}]}):
  new Response(bytes,{headers:{'content-type':'video/mp4'}}),commit:async(channel,data)=>{
   const op={operationId:data.operationId};assert.equal((await channel.call('guard',{...op,phase:'prepare'})).valid,true);
   await assert.rejects(channel.call('asset',{...op,assetId:'clip-1',sha256:sha}));
   await channel.call('manifest',op);manifestReads++;
   assert.deepEqual(new Uint8Array(await channel.call('asset',{...op,assetId:'clip-1',sha256:sha})),bytes);
   assert.equal((await channel.call('guard',{...op,phase:'ack'})).valid,true);
   return {roomId,cueId:data.cue.cueId,clipId:data.cue.music.asset.assetId,playbackRevision:1,audioTime:.01,actual:true,audioStarted:true,videoPresented:true};
  }});f.connect();await until(()=>f.channel());
 assert.equal((await f.channel().call('preload',{})).prepared,true);
 const before=f.requests.length;await f.bridge.commitPlayback(input(async({phase})=>{guards.push(phase);return true;}));
 assert.equal(f.requests.length,before,'reserved byte delivery makes no extra HTTP media request');assert.equal(manifestReads,1);
 assert.deepEqual(guards,['prepare','ack','ack']);
});

test('stale final guard, wrong revision and partial start cannot produce accepted owner ACK', async t => {
  for (const mutation of [ack => { ack.videoPresented = false; }, ack => { ack.playbackRevision = 9; }, ack => { ack.cueId = 'other'; }]) {
    const h = await setup(t, {commit: async (channel, data) => {
      const ack = {roomId, cueId: 'cue-1', clipId: 'music-1', playbackRevision: 1, audioTime: .01, actual: true, audioStarted: true, videoPresented: true}; mutation(ack); return ack;
    }});
    h.connect(); await until(() => h.bridge.read().phase === 'READY');
    // Show mode: the bridge never stops the sounding output on a rejected ACK;
    // the cue host holds and retries, and the commit slot is free again.
    await assert.rejects(h.bridge.commitPlayback(input()), /ACK_INVALID/); assert.notEqual(h.bridge.read().phase, 'STOPPED');
    await assert.rejects(h.bridge.commitPlayback(input()), /ACK_INVALID/, 'a retry is not blocked as COMMIT_BUSY');
  }
});

test('Stop invalidates an in-flight ACK and a lost reply never replays the command', async t => {
  let release;
  const h = await setup(t, {commit: () => new Promise(resolve => { release = resolve; })});
  h.connect(); await until(() => h.bridge.read().phase === 'READY');
  const pending = h.bridge.commitPlayback(input()).catch(error => error);
  await until(() => h.commands() === 1); await h.bridge.stop();
  release({roomId, cueId: 'cue-1', clipId: 'music-1', playbackRevision: 1, audioTime: .01, actual: true, audioStarted: true, videoPresented: true});
  assert.match((await pending).message, /ACK_INVALID/); assert.equal(h.commands(), 1);
});

test('channel bounded timeout and close reject without fabricated success', async () => {
  const pair = new MessageChannel();
  const a = createCloudPlaybackChannel({port: pair.port1, handle: async () => ({}), timeoutMs: 15});
  await assert.rejects(a.call('never-replied'), /ACK_TIMEOUT/);
  const pending = a.call('another'); a.close(); await assert.rejects(pending, /CLOSED/); pair.port2.close();
});

test('scheduled finite commit gets its own bounded wait without loosening control timeouts', async () => {
  // Output preparation (20s) + scheduled frame + actual AV ACK (8s).
  assert.equal(cloudPlaybackCommitTimeoutMs({transition: {exitFrame: 24 * 44100}}), 52000);
  assert.equal(cloudPlaybackCommitTimeoutMs({transition: {exitFrame: 180 * 44100}}), 208000);
  assert.equal(cloudPlaybackCommitTimeoutMs({transition: {exitFrame: 0}}), 28000);
  const pair = new MessageChannel(), a = createCloudPlaybackChannel({port: pair.port1, handle: async () => ({}), timeoutMs: 10}),
    b = createCloudPlaybackChannel({port: pair.port2, handle: async type => { await new Promise(r => setTimeout(r, 25)); return {type}; }});
  assert.deepEqual(await a.call('commit', {}, {timeoutMs: 100}), {type: 'commit'});
  assert.deepEqual(await a.call('sourceStartup', {}, {timeoutMs: 300000}), {type: 'sourceStartup'});
  await assert.rejects(a.call('control'), /ACK_TIMEOUT/); a.close(); b.close();
});

test('invalid schedule and per-call timeout bounds fail before sending a command', async () => {
  for (const exitFrame of [undefined, -1, NaN, .5, 180 * 44100 + 1])
    assert.throws(() => cloudPlaybackCommitTimeoutMs({transition: {exitFrame}}), /SCHEDULE_INVALID/);
  const pair = new MessageChannel(), a = createCloudPlaybackChannel({port: pair.port1, handle: async () => ({})});
  for (const timeoutMs of [0, -1, NaN, Infinity, .5, 300001])
    await assert.rejects(a.call('commit', {}, {timeoutMs}), /TIMEOUT_INVALID/);
  a.close(); pair.port2.close();
});

test('HTTP status and fixed safe reasons survive both channel ends; only explicit 409 waiting is retryable',async t=>{
  const replies=[
    [409,'WAITING_FOR_GENERATION',true], [403,'WAITING_FOR_GENERATION',false], [503,'WAITING_FOR_GENERATION',false],
    [401,'OWNER_DENIED',false], [403,'OBSERVER_OWNER_DENIED',false], [409,'OWNER_DENIED',false],
    [409,'PLAYBACK_STOPPED',false], [409,'OBSERVER_GRAPH_EXPIRED',false], [409,'OBSERVER_SCOPE_CHANGED',false],
    [409,'SOURCE_STARTUP_HOLD',false], [409,'CUE_OPERATION_HOLD',false], [409,'unknown synthetic diagnostic',false],
  ];
  let response;
  const f=await setup(t,{enablePlayerObserver:true,request:async()=>response});f.connect();await until(()=>f.channel());
  for(const [status,reason,retry] of replies){
    response=Response.json({error:reason,detail:'excluded synthetic diagnostic',ownerCapability:hash},{status});
    await assert.rejects(f.channel().call('sourceReady',{}),error=>{
      assert.equal(error.code,'CLOUD_OUTPUT_REQUEST_FAILED');assert.equal(error.message,'CLOUD_OUTPUT_REQUEST_FAILED');
      assert.equal(error.status,status);assert.equal(error.reason,reason.startsWith('unknown')?undefined:reason);
      assert.equal(isCloudOutputWaitingError(error),retry);
      assert.equal(JSON.stringify(error).includes('excluded'),false);assert.equal(JSON.stringify(error).includes(hash),false);
      return true;
    });
  }
});

test('initial and reserved media authorization failures preserve safe status and reason without exposing media',async t=>{
  const f=await setup(t,{enablePlayerObserver:true,request:async path=>path.endsWith('/source/startup')?
    Response.json({descriptor:{assetId:'seed',sha256:sha,byteLength:4,mimeType:'audio/wav'}}):
    Response.json({error:'OWNER_DENIED',detail:'excluded synthetic diagnostic'},{status:403})});
  f.connect();await until(()=>f.channel());await f.channel().call('sourceStartup',{});
  await assert.rejects(f.channel().call('sourceAsset',{assetId:'seed',sha256:sha}),error=>{
    assert.equal(error.status,403);assert.equal(error.reason,'OWNER_DENIED');assert.equal(isCloudOutputWaitingError(error),false);return true;
  });
  const h=await setup(t,{request:async()=>Response.json({error:'OWNER_DENIED'},{status:401}),commit:async(channel,data)=>{
    const operationId=data.operationId,manifest=await channel.call('manifest',{operationId}),asset=manifest.videos[0];
    return channel.call('asset',{operationId,assetId:asset.assetId,sha256:asset.sha256});
  }});
  h.connect();await until(()=>h.bridge.read().phase==='READY');
  await assert.rejects(h.bridge.commitPlayback(input()),error=>{
    assert.equal(error.status,401);assert.equal(error.reason,'OWNER_DENIED');assert.equal(isCloudOutputWaitingError(error),false);return true;
  });assert.notEqual(h.bridge.read().phase,'STOPPED','a failed incoming Cue does not stop the sounding output');
});

test('failure bodies are bounded JSON; malformed, oversized, redirected and cross-origin errors cannot assert waiting',async t=>{
  let response,cancelled=false;
  const f=await setup(t,{enablePlayerObserver:true,request:async()=>response});f.connect();await until(()=>f.channel());
  const variants=[
    ()=>new Response('not-json',{status:409,headers:{'content-type':'application/json'}}),
    ()=>new Response('{"error":"WAITING_FOR_GENERATION"}',{status:409,headers:{'content-type':'text/html'}}),
    ()=>Response.json({error:'WAITING_FOR_GENERATION',detail:'x'.repeat(4096)},{status:409}),
    ()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"error":"WAITING_FOR_GENERATION","padding":"'+'x'.repeat(4096)));},cancel(){cancelled=true;}}),
      {status:409,headers:{'content-type':'application/json'}}),
    ()=>Object.defineProperty(Response.json({error:'WAITING_FOR_GENERATION'},{status:409}),'redirected',{value:true}),
    ()=>Object.defineProperty(Response.json({error:'WAITING_FOR_GENERATION'},{status:409}),'url',{value:'https://other.example/failure'}),
  ];
  for(const make of variants){response=make();await assert.rejects(f.channel().call('sourceStartup',{}),error=>{
    assert.equal(error.reason,undefined);assert.equal(isCloudOutputWaitingError(error),false);return true;
  });}
  assert.equal(cancelled,true);
});

test('raw thrown errors never cross the channel, even if they carry status and reason lookalikes',async()=>{
  const pair=new MessageChannel();
  const a=createCloudPlaybackChannel({port:pair.port1,handle:async()=>({})});
  const b=createCloudPlaybackChannel({port:pair.port2,handle:async()=>{
    throw Object.assign(Error('excluded synthetic internal diagnostic'),{status:409,reason:'WAITING_FOR_GENERATION',ownerCapability:hash});
  }});
  try {await assert.rejects(a.call('sourceReady'),error=>{
    assert.equal(error.message,'CLOUD_OUTPUT_REQUEST_FAILED');assert.equal(error.status,undefined);
    assert.equal(error.reason,undefined);assert.equal(JSON.stringify(error).includes('excluded'),false);return true;
  });}finally{a.close();b.close();}
});

test('unknown or additional error-envelope fields cannot forge a waiting reply',async()=>{
  const pair=new MessageChannel();const a=createCloudPlaybackChannel({port:pair.port1,handle:async()=>({})});
  let data;
  pair.port2.addEventListener('message',event=>pair.port2.postMessage({...event.data,kind:'error',data}));pair.port2.start();
  try {for(const candidate of [{code:'CLOUD_OUTPUT_REQUEST_FAILED',status:409,reason:'WAITING_FOR_GENERATION',detail:'excluded'},
    {code:'CLOUD_OUTPUT_REQUEST_FAILED',status:409,reason:'UNKNOWN_WAITING'},
    {code:'CLOUD_OUTPUT_REQUEST_FAILED',status:'409',reason:'WAITING_FOR_GENERATION'}]){
    data=candidate;await assert.rejects(a.call('sourceReady'),error=>{
      assert.equal(error.status,undefined);assert.equal(error.reason,undefined);assert.equal(isCloudOutputWaitingError(error),false);return true;
    });
  }}finally{a.close();pair.port2.close();}
});


test('one source-start request awaits its actual non-credit ACK and cannot survive Stop',async t=>{
 const valid={kind:'cloud-source-playback-started-v1',sourceOnly:true,actual:true,audioStarted:true,participantCredit:false,
  graphEpoch:1,sourceSha256:hash,sampleRate:44100};
 for(const stop of [false,true]){
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await setup(t,{enablePlayerObserver:true,sourceStart:()=>gate});f.connect();await until(()=>f.bridge.read().phase==='READY');
  await f.channel().call('state',{phase:'PREPARING',cloudRole:'output',sourceStartAvailable:true});
  const first=f.bridge.startSource(),same=f.bridge.startSource();assert.equal(first,same);
  await until(()=>f.sourceCommands()===1);
  if(stop){const rejected=assert.rejects(first,/SOURCE_START_ACK_INVALID/);await f.bridge.stop();release(valid);await rejected;}
  else{release(valid);assert.deepEqual(await first,valid);}
  assert.equal(f.sourceCommands(),1);assert.equal(f.commands(),0);assert.equal(f.requests.length,0);
 }
});
test('a partial or credit-bearing source-start reply never opens owner Cue selection',async t=>{
 for(const patch of [{actual:false},{audioStarted:false},{participantCredit:true},{sourceOnly:false},{graphEpoch:0},{sampleRate:48000}]){
  const f=await setup(t,{enablePlayerObserver:true,sourceStart:async()=>({kind:'cloud-source-playback-started-v1',sourceOnly:true,actual:true,
   audioStarted:true,participantCredit:false,graphEpoch:1,sourceSha256:hash,sampleRate:44100,...patch})});
  f.connect();await until(()=>f.bridge.read().phase==='READY');
  await assert.rejects(f.bridge.startSource(),/SOURCE_START_ACK_INVALID/);assert.equal(f.commands(),0);
 }
});
test('single-screen show embeds the same-origin output frame instead of a popup and notices its removal', async t => {
  const handlers = new Map(), transferred = []; let outputChannel;
  const output = {closed: false, focus() {}, postMessage(message, origin, ports) {
    transferred.push({message, origin});
    outputChannel = createCloudPlaybackChannel({port: ports[0], timeoutMs: 1000, handle: async type => {
      if (type === 'init') { await outputChannel.call('state', {phase: 'IDLE', cloudRole: 'output', playbackRevision: 0}); return {ready: true}; }
      if (type === 'stop') return {stopped: true};
      throw Error('unknown');
    }});
  }};
  const frame = {attributes: {}, isConnected: false, contentWindow: output, setAttribute(k, v) { this.attributes[k] = v; },
    remove() { this.isConnected = false; }};
  const embedIn = {ownerDocument: {createElement(tag) { assert.equal(tag, 'iframe'); return frame; }},
    replaceChildren(child) { assert.equal(child, frame); frame.isConnected = true; }};
  const states = [];
  const window = {location: {origin: 'https://vdj.example'}, open() { assert.fail('no popup in the single-screen flow'); },
    addEventListener(type, fn) { handlers.set(type, fn); }, removeEventListener(type) { handlers.delete(type); }};
  const bridge = createCloudOutputBridge({window, enabled: true, fixtureMode: true, timeoutMs: 1000, embedIn,
    resolveManifest: async () => ({}), request: async () => new Response('{}'), onState: s => states.push(s)});
  t.after(async () => { await bridge.dispose(); outputChannel?.close(); });
  assert.equal(bridge.openOutput(), output);
  assert.equal(frame.src, '/cloud-output.html'); assert.equal(frame.attributes.allow, 'autoplay; fullscreen');
  assert.equal(bridge.openOutput(), output, 'an attached frame is reused, not recreated');
  handlers.get('message')({source: output, origin: 'https://vdj.example', data: {type: 'ai-vdj-cloud-output-ready', version: 1}});
  assert.equal(transferred.length, 1);
  await until(() => states.some(s => s.phase === 'IDLE'));
  frame.remove();
  for (let i = 0; i < 30 && bridge.read().phase !== 'STOPPED'; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(bridge.read().reason, 'OUTPUT_CLOSED');
});
test('a URL-looking participant nickname crosses the channel as display text; other URL strings stay rejected', async () => {
  const pair = new MessageChannel(), seen = [];
  const a = createCloudPlaybackChannel({port: pair.port1, timeoutMs: 1000, handle: async (type, data) => { seen.push(data); return {shown: true}; }});
  const b = createCloudPlaybackChannel({port: pair.port2, timeoutMs: 1000, handle: async () => ({})});
  try {
    assert.deepEqual(await b.call('credit', {nickname: 'https://alice', cueId: 'cue-1'}), {shown: true});
    assert.equal(seen[0].nickname, 'https://alice');
    await assert.rejects(b.call('credit', {nickname: 'ok', url: 'https://example.invalid/x'}), /CLOUD_BRIDGE_DATA_INVALID/);
  } finally { a.close(); b.close(); }
});

// A reply that arrives after the bridge timeout may follow an applied edit.
// The bridge asks the output for that operation's outcome and never re-commits.
for (const [name, outcome, expected] of [
  ['an applied commit is reconciled into its ACK', 'applied', null],
  ['a definite failure is retryable', 'failed', /COMMIT_FAILED/],
  ['an unknown outcome is uncertain', 'unknown', /COMMIT_UNCERTAIN/]])
test('lost commit reply: ' + name, async t => {
  const ack = {roomId, cueId: 'cue-1', clipId: 'music-1', playbackRevision: 1, audioTime: .01, actual: true, audioStarted: true, videoPresented: true};
  let asked = 0;
  const h = await setup(t, {commit: () => new Promise(() => {}), commitResult: async data => {
    asked++; assert.equal(Number.isSafeInteger(data.operationId), true);
    if (outcome === 'applied') return ack; if (outcome === 'failed') return {committed: false}; throw Error('CLOUD_OUTPUT_COMMIT_UNKNOWN');
  }});
  h.connect(); await until(() => h.bridge.read().phase === 'READY');
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = h.bridge.commitPlayback(input()).then(value => ({value}), error => ({error}));
  await until(() => h.commands() === 1); t.mock.timers.tick(cloudPlaybackCommitTimeoutMs(input().plan, 1000) + 1);
  await until(() => asked === 1); const result = await pending;
  if (expected) assert.match(result.error.message, expected); else assert.deepEqual(result.value, ack);
  assert.equal(h.commands(), 1, 'the commit is never re-sent');
});
test('an output commit failure crosses the channel with its fixed playback code only', async t => {
  const h = await setup(t, {commit: async () => { throw classifyPlaybackFailure(Error('QUEUED_RENDER_FRONTIER_CHANGED')); }});
  h.connect(); await until(() => h.bridge.read().phase === 'READY');
  const error = await h.bridge.commitPlayback(input()).catch(e => e);
  assert.equal(error.code, 'CLOUD_OUTPUT_REQUEST_FAILED'); assert.equal(error.reason, 'QUEUED_RENDER_FRONTIER_CHANGED');
  const other = classifyPlaybackFailure(Error('secret detail https://example.invalid'));
  assert.equal(other.reason, undefined, 'an unknown message is not classified');
});

test('a reloaded embedded output announces ready again and the bridge reconnects to it', async t => {
  const h = await setup(t); h.connect(); await until(() => h.bridge.read().phase === 'READY');
  const first = h.channel();
  h.connect(); await until(() => h.channel() !== first && h.initializations.length === 2);
  assert.equal(h.transferred.length, 2, 'a new port is handed to the reloaded document');
  await until(() => h.bridge.read().phase === 'READY');
  const ack = await h.bridge.commitPlayback(input());
  assert.equal(ack.cueId, 'cue-1', 'playback calls reach the reloaded output');
});

test('an owner-side bridge failure crosses the channel by its fixed name only', async () => {
  const pair = new MessageChannel();
  const owner = createCloudPlaybackChannel({port: pair.port1, timeoutMs: 1000, handle: async () => {
    throw Object.assign(Error('CLOUD_OUTPUT_PRELOAD_INVALID'), {code: 'CLOUD_OUTPUT_PRELOAD_INVALID'}); }});
  const output = createCloudPlaybackChannel({port: pair.port2, timeoutMs: 1000, handle: async () => ({})});
  const error = await output.call('preload', {}).catch(e => e);
  assert.equal(error.code, 'CLOUD_OUTPUT_REQUEST_FAILED'); assert.equal(error.reason, 'CLOUD_OUTPUT_PRELOAD_INVALID');
  owner.close(); output.close();
});
