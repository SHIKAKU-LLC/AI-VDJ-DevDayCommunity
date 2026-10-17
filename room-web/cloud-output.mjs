import {createCloudPlaybackAdapter, mountCloudPlaybackControls} from './cloud-playback.mjs';
import {createCloudPlaybackChannel, isCloudOutputWaitingError, classifyPlaybackFailure} from './cloud-output-bridge.mjs';
import {createVideoAdapter} from './scene-video-adapter.mjs';
import {createCloudCreditOverlay} from './cloud-output-credit.mjs';
import {createBrowserPlayerObserver} from './playback/player-observer.mjs';
import {prepareCloudInitialAudio,prepareCloudWaitingAudio} from './cloud-initial-audio.mjs';

// No URL parameter, fragment, auth input, token storage or direct media fetch.
if (location.search || location.hash) history.replaceState(null, '', '/cloud-output.html');
// Opened as a popup (window.opener) or embedded in the owner page (parent).
const embedded = !window.opener && window.parent !== window;
const status = document.getElementById('status'), openerWindow = window.opener ?? (embedded ? window.parent : null);
if (embedded) document.body.classList.add('embedded');
let channel = null, adapter = null, controls = null, activeOperation = null, closed = false, initialized = false, lastCommit = null;
let enabled = false, fixtureMode = false, enableClipRelativeTimeline = false, graph = null, rebuilding = null;
let initialPlaybackRevision = 0;
let enablePlayerObserver=false,observer=null;
let activationEpoch=0,playerRegistrationAttempted=false;
let stopping=null,stoppingExplicit=false;
let startupActivation=null,sourceStartResult=null;
let hasConfirmedGraphStop=false;
const diagnosticDetails=document.getElementById('observer-diagnostics'),diagnosticValue=document.getElementById('observer-diagnostics-value');
const renderObserverDiagnostics=value=>{if(diagnosticDetails?.open&&diagnosticValue)diagnosticValue.textContent=JSON.stringify(value);};
diagnosticDetails?.addEventListener?.('toggle',()=>renderObserverDiagnostics(observer?.readDiagnostics?.()??{stage:'IDLE'}));
let lastFailureCode=null;
const rememberFailure=(value,{startupCause=false}={})=>{
  // Seed disposal closes the shared context before its rejected start returns.
  // Preserve that original startup cause over the resulting generic clock stop.
  if(lastFailureCode&&!(startupCause&&lastFailureCode==='ACTUAL_AUDIO_CLOCK_REQUIRED'))return;
  // A wire failure's fixed reason names the cause better than its generic code.
  const code=value?.reason??value?.code??value?.message??value;
  lastFailureCode=typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code)?code:'PLAYBACK_HOLD';
};
const showStatus=message=>{status.textContent=message+(lastFailureCode?` (${lastFailureCode})`:'');};
const creditOverlay = createCloudCreditOverlay({element: document.getElementById('participant-credit'),
  readPlayback: () => adapter?.read() ?? {}, readBinding: () => activeOperation});
const report = value => {
  const state={...value,sourceStartAvailable:!!startupActivation&&!startupActivation.cancelled};
  creditOverlay.observePlaybackState(state);
  if(state.phase==='HOLD')rememberFailure(state.reason);
  showStatus(state.message ?? '出力状態を確認してください。'); status.dataset.phase = state.phase;
  controls?.refresh();
  if (channel) void channel.call('state', state).catch(() => { void shutdown(); });
};
async function makeGraph() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Context || typeof globalThis.AudioWorkletNode !== 'function') throw Error('CLOUD_AUDIO_WORKLET_UNAVAILABLE');
  const context = new Context({sampleRate: 44100});
  try {
    if (context.sampleRate !== 44100 || !context.audioWorklet) throw Error('CLOUD_AUDIO_RATE_UNSUPPORTED');
    await context.suspend();
    await context.audioWorklet.addModule('/room-worklet.mjs');
    if (closed) throw Error('CLOUD_OUTPUT_CLOSED');
    const node = new AudioWorkletNode(context, 'queue-audio', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]});
    let connected = true, stopTask = null; node.connect(context.destination);
    return {context, node, readSourceCount: () => connected ? 1 : 0,
      stopAudio() {
        return stopTask ??= (async () => { await context.suspend(); node.disconnect(); connected = false; await context.close(); })();
      }};
  } catch (error) { await context.close().catch(() => {}); throw error; }
}
function requestMedia(path, options) {
  if (!activeOperation || options.method !== 'GET') return Promise.reject(Error('CLOUD_OUTPUT_MEDIA_COMMAND_INVALID'));
  const target = new URL(path, location.origin), match = /^\/api\/rooms\/([a-f0-9-]{36})\/media\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/i.exec(target.pathname);
  if (!match || target.origin !== location.origin || match[1] !== activeOperation.roomId ||
      target.searchParams.size !== 1 || !/^[a-f0-9]{64}$/.test(target.searchParams.get('sha256') ?? ''))
    return Promise.reject(Error('CLOUD_OUTPUT_MEDIA_COMMAND_INVALID'));
  const asset = activeOperation.assets?.find(a => a.assetId === match[2] && a.sha256 === target.searchParams.get('sha256'));
  if (!asset) return Promise.reject(Error('CLOUD_OUTPUT_MEDIA_NOT_BOUND'));
  const operation = activeOperation;
  return channel.call('asset', {operationId: operation.operationId, assetId: asset.assetId, sha256: asset.sha256}).then(bytes => {
    if (activeOperation !== operation || options.signal?.aborted || !(bytes instanceof ArrayBuffer) || bytes.byteLength !== asset.byteLength)
      throw Error('CLOUD_OUTPUT_MEDIA_CANCELLED');
    return new Response(bytes, {headers: {'Content-Type': asset.mimeType, 'Content-Length': String(bytes.byteLength)}});
  });
}
async function resolveManifest() {
  const operation = activeOperation;
  if (!operation) throw Error('CLOUD_OUTPUT_RESERVATION_REQUIRED');
  const manifest = await channel.call('manifest', {operationId: operation.operationId});
  if (activeOperation !== operation) throw Error('CLOUD_OUTPUT_MEDIA_CANCELLED');
  operation.assets = [manifest.audio?.render, ...(manifest.videos ?? [])]; return manifest;
}
async function rebuild({restartConfirmed=false}={}) {
  if (rebuilding) return rebuilding;
  rebuilding = (async () => {
    creditOverlay.reset();
    controls?.dispose();
    // A terminal worklet is never resumed. Revision remains authoritative.
    const revision = adapter?.read().playbackRevision ?? initialPlaybackRevision;
    await adapter?.dispose();
    // An unactivated graph owns no output lease, so adapter.dispose alone may
    // leave its suspended context connected. Retire it before creating another.
    await graph?.stopAudio();
    await observer?.stop().catch(()=>{});observer=null;
    graph = await makeGraph();
    playerRegistrationAttempted=false;sourceStartResult=null;
    if (closed) { await graph.stopAudio(); return; }
    adapter = createCloudPlaybackAdapter({role: 'output', enabled, fixtureMode, enableClipRelativeTimeline,allowInitialAudio:enablePlayerObserver, request: requestMedia,
      origin: location.origin, resolveManifest, worklet: graph, initialPlaybackRevision: revision,
      createVideoAdapter: options => createVideoAdapter({...options, crossfadeMs: 0,
        fetchImpl() { throw Error('CLOUD_OUTPUT_PROVIDER_FETCH_FORBIDDEN'); }}),
      container: document.getElementById('output'), onState: report});
    controls = mountCloudPlaybackControls({container: document.getElementById('controls'), port: adapter,
      ...(embedded ? {activateLabel: '開場する'} : {}),
      async onActivated() {
        if(!enablePlayerObserver||closed)return;
        lastFailureCode=null;
        const activation=++activationEpoch;
        const activatedAdapter=adapter;
        let releaseStart,resolveStart,rejectStart;
        const startGate=new Promise(resolve=>{releaseStart=resolve;});
        const outcome=new Promise((resolve,reject)=>{resolveStart=resolve;rejectStart=reject;});
        // A Stop before a user starts must not create an unhandled rejection.
        void outcome.catch(()=>{});
        const startupToken={activation,adapter:activatedAdapter,requested:false,cancelled:false,outcome,
          request(){this.requested=true;releaseStart();return outcome;},
          cancel(){this.cancelled=true;releaseStart();rejectStart(Error('PLAYER_OBSERVER_CANCELLED'));}};
        startupActivation=startupToken;sourceStartResult=null;
        const activatedObserver=createBrowserPlayerObserver({enabled:true,autoSample:false,transport:(command,body)=>channel.call('playerObserver',{command,body},
          command==='register'?{timeoutMs:300000}:{}),
          readEngine:()=>activatedAdapter.readObservationState(),subscribe:listener=>activatedAdapter.subscribeObservation(listener),
          requestWindow:()=>activatedAdapter.requestObservationWindow(),readVideo:()=>activatedAdapter.readObservationVideo(),
          onDiagnostics:renderObserverDiagnostics,
          // Observations are telemetry for Cue selection, not the playback clock.
          // A rejected report keeps the sole graph playing and the next sample
          // retries; only owner Stop or an actual audio-engine failure stops.
          onError:error=>{rememberFailure(error);}});
        observer=activatedObserver;
        const current=()=>!closed&&activationEpoch===activation&&adapter===activatedAdapter&&observer===activatedObserver;
        const readWhenAvailable=async(type,options={})=>{
          for(;;){
            try {
              const result=await channel.call(type,{},options);
              if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
              return result;
            } catch(error) {
              if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
              if(!isCloudOutputWaitingError(error))throw error;
              report({...activatedAdapter.read(),phase:'PREPARING',reason:'WAITING_FOR_GENERATION',
                message:'音楽・映像の完成を待っています。'});
              await new Promise(resolve=>setTimeout(resolve,2000));
              if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
            }
          }
        };
        try {
        report({...activatedAdapter.read(),phase:'PREPARING',message:'出力の権限と初期音源を確認しています。'});
        const startup=await readWhenAvailable('sourceStartup',{timeoutMs:300000});
        if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
        const bytes=await channel.call('sourceAsset',{assetId:startup.descriptor.assetId,sha256:startup.descriptor.sha256},{timeoutMs:300000});
        if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
        if(startup.waitForGeneration===true){
          let waitingStarted=false;
          for(;;){
            const state=await readWhenAvailable('sourceReady');
            if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
            if(state.stopped){
              // Only a gesture on the replacement of a confirmed stopped graph
              // may ask the server for a restart proof. Registration/binding/ACK
              // still authenticate the epoch and its prior graph stop receipt.
              // The 開場 gesture on a stopped room confirms that Stop itself,
              // exactly as the output's explicit Stop does: the server's graph
              // Stop receipt (never a local flag) becomes the restart proof.
              if(!restartConfirmed&&enablePlayerObserver){
                const results=await Promise.allSettled([channel.call('sourceStop',{}),
                  channel.call('playerObserver',{command:'stop',body:{current:true}})]);
                if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
                const receipt=results[1].status==='fulfilled'?results[1].value:null;
                if(results.every(r=>r.status==='fulfilled')&&receipt?.kind==='selected-player-graph-stopped-v1'&&receipt.stopped===true&&
                  Number.isSafeInteger(receipt.graphEpoch)&&receipt.graphEpoch>0&&typeof receipt.targetPlayerId==='string'&&
                  /^[a-f0-9]{64}$/.test(receipt.receiptSha256??''))restartConfirmed=hasConfirmedGraphStop=true;
              }
              if(!restartConfirmed)throw Error('WAITING_GENERATION_STOPPED');
              break;
            }
            if(state.readyCues>=2)break;
            if(!waitingStarted&&startupToken.requested){
              const waiting=await prepareCloudWaitingAudio({bytes:new Uint8Array(bytes),descriptor:startup.descriptor,source:startup.source});
              if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
              await activatedAdapter.startWaitingLoop(waiting);waitingStarted=true;
              report({...activatedAdapter.read(),phase:'PREPARING',message:'承認済み音源をループ再生中です。2人分の音楽・映像の完成を待っています。'});
            }
            await new Promise(resolve=>setTimeout(resolve,2000));
            if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
          }
        }
        // Browser-owned immutable media bytes also finish loading BEFORE the
        // finite source starts. Later manifests/guards still authorize use.
        report({...activatedAdapter.read(),phase:'PREPARING',message:'完成済みの音楽と映像を読み込んでいます。'});
        await readWhenAvailable('preload',{timeoutMs:300000});
        if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
        // Permission/preparation may finish long before the user's Start.
        // No finite samples or short graph lease begin until that one request.
        report({...activatedAdapter.read(),phase:'READY',message:startupToken.requested?
          '準備ができました。演奏を開始します。':'準備ができました。owner画面で「演奏開始」を押してください。'});
        await startGate;
        if(!current()||startupToken.cancelled)throw Error('PLAYER_OBSERVER_CANCELLED');
        // Material fetches must finish before the short-lived fresh-graph proof.
        playerRegistrationAttempted=true;
        const selection=await activatedObserver.register();
        if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
        if(restartConfirmed&&selection.mode!=='restart')throw Error('PLAYER_OBSERVER_RESTART_PROOF_REQUIRED');
        const plan=await prepareCloudInitialAudio({bytes:new Uint8Array(bytes),descriptor:startup.descriptor,source:startup.source,
          mode:'bootstrap',graphEpoch:selection.graphEpoch,previousGraphStopped:selection.mode==='restart'});
        if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
        const sourceAck=await activatedAdapter.startInitialSource(plan,{guard:async({phase})=>{
          if(!current())return false;
          // The processed observation and source ACK each validate the current
          // server binding. Avoid a third network round trip before that proof.
          if(phase==='ack')return true;
          const selected=await channel.call('playerObserver',{command:'binding',body:{}}),b=selected.binding;
          return current()&&selected.targetPlayerId===selection.targetPlayerId&&selected.graphEpoch===selection.graphEpoch&&b.kind==='source'&&
            b.assetId===plan.sourceClipId&&b.sha256===plan.sourceSha256&&b.contextSha256===plan.sourceContextSha256&&b.playbackRevision===plan.sourcePlaybackRevision;
        },markSourceStarted:async ack=>{
          // A timer may already have saved this window. The server receipt
          // adapter rechecks its fresh matching frontier before accepting ACK.
          await activatedObserver.sample();if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
          // The first processed window must be committed before the ACK. Keep
          // later windows fresh while its authenticated server checks run.
          activatedObserver.startSampling();
          // Match the finite initial-audio ACK deadline; the channel default is shorter.
          const receipt=await channel.call('sourceAck',{ack},{timeoutMs:20000});
          return receipt;}});
        if(!current())throw Error('PLAYER_OBSERVER_CANCELLED');
        sourceStartResult={...sourceAck,sourceOnly:true};
        startupActivation=null;resolveStart(sourceStartResult);report(activatedAdapter.read());
        } catch(error) {
          rejectStart(error);
          if(!startupToken.cancelled)rememberFailure(error,{startupCause:true});
          activatedObserver.close();
          if(adapter===activatedAdapter&&activationEpoch===activation){
            activationEpoch++;await activatedAdapter.stop('INITIAL_SOURCE_HOLD');
          }
          throw error;
        } finally {
          if(startupActivation===startupToken)startupActivation=null;
        }
      },
      stopPlayback: reason => handle('stop', {reason}),
      onError: error => { rememberFailure(error);showStatus('音声・映像出力を保留しました。「停止」で状態を確認し、音声出力を有効にしてください。'); }});
    report(adapter.read());
  })().finally(() => { rebuilding = null; });
  return rebuilding;
}
async function shutdown() {
  if (closed) return; closed = true; startupActivation?.cancel();activationEpoch++;activeOperation = null;
  creditOverlay.dispose();
  if (channel) void channel.call('state', {...adapter?.read(), phase: 'STOPPED', cloudRole: 'output', reason: 'PAGE_HIDE'}).catch(() => {});
  controls?.dispose(); await adapter?.dispose().catch(() => {});
  await graph?.stopAudio().catch(()=>{});
  await observer?.stop().catch(()=>{});observer=null;
  channel?.close(); status.textContent = 'owner接続を終了しました。owner画面から出力を開き直してください。';
}
async function handle(type, data) {
  if (closed) throw Error('CLOUD_OUTPUT_CLOSED');
  if (type === 'init') {
    if (initialized || Object.keys(data).some(k => !['enabled', 'fixtureMode', 'initialPlaybackRevision', 'enableClipRelativeTimeline','enablePlayerObserver'].includes(k)) ||
        data.enableClipRelativeTimeline !== undefined && typeof data.enableClipRelativeTimeline !== 'boolean' ||
        data.enablePlayerObserver !== undefined && typeof data.enablePlayerObserver !== 'boolean' ||
        typeof data.enabled !== 'boolean' || typeof data.fixtureMode !== 'boolean' ||
        !Number.isSafeInteger(data.initialPlaybackRevision) || data.initialPlaybackRevision < 0) throw Error('CLOUD_OUTPUT_INIT_INVALID');
    initialized = true; enabled = data.enabled; fixtureMode = data.fixtureMode;
    enableClipRelativeTimeline = data.enableClipRelativeTimeline === true;
    enablePlayerObserver=data.enablePlayerObserver===true;
    initialPlaybackRevision = data.initialPlaybackRevision;
    if (enabled) await rebuild();
    else {
      adapter = createCloudPlaybackAdapter({role: 'output', enabled: false, onState: report});
      controls = mountCloudPlaybackControls({container: document.getElementById('controls'), port: adapter});
      status.textContent = 'クラウド音声・映像出力は、検証完了まで保留中です。';
    }
    return {initialized: true};
  }
  if (!initialized || !adapter) throw Error('CLOUD_OUTPUT_NOT_READY');
  if(type==='startSource'){
    if(!enabled||!enablePlayerObserver||stopping||rebuilding||Object.keys(data).length||
      !['READY','PLAYING'].includes(adapter.read().phase))throw Error('CLOUD_SOURCE_START_INVALID');
    if(sourceStartResult)return sourceStartResult;
    if(!startupActivation||startupActivation.adapter!==adapter||startupActivation.cancelled)
      throw Error('CLOUD_SOURCE_START_INVALID');
    return startupActivation.request();
  }
  if (type === 'commit') {
    if (stopping || rebuilding || startupActivation || !enabled || !Number.isSafeInteger(data.operationId) || data.operationId < 1 ||
        Object.keys(data).some(k => !['operationId', 'roomId', 'cue', 'plan', 'expectedRevision'].includes(k))) throw Error('CLOUD_OUTPUT_COMMIT_INVALID');
    const operation = {operationId: data.operationId, roomId: data.roomId, cueId: data.cue?.cueId,
      generationId: data.cue?.generationId, expectedRevision: data.expectedRevision}; activeOperation = operation;
    const result = adapter.commitPlayback({...data, guard: async ({phase}) => {
      if (activeOperation !== operation) return false;
      const result = await channel.call('guard', {operationId: operation.operationId, phase});
      return activeOperation === operation && result.valid === true;
    }}).catch(error => { throw classifyPlaybackFailure(error); });
    // A reply lost or late on the owner side is reconciled by this record;
    // the owner asks for the same operation's outcome instead of re-committing.
    lastCommit = {operationId: operation.operationId, result}; result.catch(() => {});
    return result;
  }
  if (type === 'commitResult') {
    if (!Number.isSafeInteger(data.operationId) || Object.keys(data).some(k => k !== 'operationId')) throw Error('CLOUD_OUTPUT_COMMIT_INVALID');
    if (lastCommit?.operationId !== data.operationId) throw Error('CLOUD_OUTPUT_COMMIT_UNKNOWN');
    // A definite failure is reported as such, so the owner may retry it.
    return lastCommit.result.catch(() => ({committed: false}));
  }
  if (type === 'stop') {
    const reason=typeof data.reason==='string'?data.reason:'OWNER_STOP';
    // A failed Start also retires the server graph, so the next Start can register.
    // Leaving or reloading the owner page also retires the server graph.
    const explicit=['OWNER_STOP','OUTPUT_STOP','CUE_HOST_START_FAILED','PAGE_HIDE','DISPOSE'].includes(reason);
    // An internal HOLD must not swallow a later explicit server Stop.
    if(stopping)return explicit&&!stoppingExplicit?stopping.then(()=>handle('stop',{reason})):stopping;
    startupActivation?.cancel();activationEpoch++;
    startupActivation=null;sourceStartResult=null;
    stoppingExplicit=explicit;
    stopping=(async()=>{
    // A concurrent init/rebuild must finish before its graph can be retired.
    await rebuilding;
    creditOverlay.reset();
    activeOperation = null; await adapter.stop(reason);
    // An explicit owner Stop must also recover a selected graph whose initial
    // registration reply was lost. No caller-supplied target or renewal occurs.
    let restartConfirmed=false;
    if(enablePlayerObserver&&explicit){
      // Prepared generation has no live-clock dependency. An explicit output
      // Stop must therefore invalidate its server authority as well.
      // Stop the server graph first. Only a real graph Stop receipt may be
      // followed by the room's cue Stop: with no graph (noGraph) the room is
      // left unstopped, because a stopped room without a stopped graph has no
      // receipt that could ever prove a restart, and every later Start would hold.
      let receipt;
      try{receipt=await channel.call('playerObserver',{command:'stop',body:{current:true}});}
      catch{await observer?.stop().catch(()=>{});observer=null;throw Error('OUTPUT_STOP_SERVER_CONFIRMATION_REQUIRED');}
      await observer?.stop().catch(()=>{});observer=null;
      // A newly opened output has no local registration history. Only the
      // authenticated server's existing graph Stop receipt can recover it.
      // noGraph is not proof; registration still verifies the actual lineage.
      if(receipt?.kind==='selected-player-graph-stopped-v1'&&receipt.stopped===true&&
        Number.isSafeInteger(receipt.graphEpoch)&&receipt.graphEpoch>0&&typeof receipt.targetPlayerId==='string'&&
        /^[a-f0-9]{64}$/.test(receipt.receiptSha256??''))restartConfirmed=true;
      if(restartConfirmed){
        try{await channel.call('sourceStop',{});}catch{throw Error('OUTPUT_STOP_SERVER_CONFIRMATION_REQUIRED');}
      }
      hasConfirmedGraphStop=restartConfirmed;
    }
    await observer?.stop().catch(()=>{});observer=null;
    if (enabled && !closed) await rebuild({restartConfirmed});
    return {stopped: true,graphStopConfirmed:restartConfirmed,noGraph:!restartConfirmed};
    })().finally(()=>{stopping=null;stoppingExplicit=false;});
    return stopping;
  }
  if (type === 'credit') return creditOverlay.show(data);
  throw Error('CLOUD_OUTPUT_COMMAND_INVALID');
}
const connect = event => {
  if (closed || channel || !openerWindow || event.source !== openerWindow || event.origin !== location.origin ||
      event.data?.type !== 'ai-vdj-cloud-output-connect' || event.data?.version !== 1 || event.ports?.length !== 1 ||
      Object.keys(event.data).some(k => !['type', 'version'].includes(k))) return;
  channel = createCloudPlaybackChannel({port: event.ports[0], handle, timeoutMs:180000, onClose: () => { void shutdown(); }});
  window.removeEventListener('message', connect);
};
window.addEventListener('message', connect);
window.addEventListener('pagehide', () => { void shutdown(); }, {once: true});
const ownerWatch = setInterval(() => { if (closed) clearInterval(ownerWatch); else if (!embedded && openerWindow?.closed) void shutdown(); }, 1000);
if (openerWindow && location.protocol === 'https:') openerWindow.postMessage({type: 'ai-vdj-cloud-output-ready', version: 1}, location.origin);
else status.textContent = 'owner画面の「出力を開く」から、この画面を開いてください。';
