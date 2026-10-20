import {createHash, randomUUID} from 'node:crypto';
import {DispatchError} from '../generation/dispatch.mjs';
import {cueDigest} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {isPlayerObserverSqlStore} from './player-observer-store.mjs';

const RATE = 44100, WINDOW = 256, MAX_FRAMES = 180 * RATE;
const fail = code => {throw new DispatchError(code);};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
const fields = value => ({roomId:value.roomId,['sessionId']:value.sessionId,controlRevision:value.controlRevision});
const same = (a,b) => ['roomId','sessionId','controlRevision'].every(k => a?.[k] === b?.[k]);
const pcmSha = pcm => createHash('sha256').update(new Uint8Array(pcm.buffer,pcm.byteOffset,pcm.byteLength)).digest('hex');
const seal = body => ({...body,receiptSha256:cueDigest(body)});
const bindingKeys = ['kind','assetId','sha256','contextSha256','playbackRevision','cueId','generationId'];
const referenceKeys=['roomId','sessionId','controlRevision','targetPlayerId','graphEpoch','cueId','generationId','assetId','sha256','playbackRevision',
  'sourceClipId','sourceSha256','sourceContextSha256','sourcePlaybackRevision','startMode','maximumDurationFrames','queuedPrefixFrames','queuedPrefixSha256',
  'processedWindowSha256','continuationPlanSha256','continuationRenderSha256'];

// Physical render/seed material is server-selected and freshly verified by the
// native/private worker, never supplied by this HTTP caller. Observations prove
// an owner-bound browser graph's processed bytes; this is not hardware attestation.
export function createPlayerObserverRegistry({enabled=false,roomId,origin,store,readScope,readPlaybackState,
  authorizeOwner,readVerifiedMaterial,readVerifiedSourceSnapshot,now=Date.now,mintTarget=()=>randomUUID(),maximumAgeMs=5000,onHold=()=>{},onCollectionState=()=>{},showMode=false}={}) {
  if (!/^[a-f0-9-]{36}$/i.test(roomId??'') || new URL(origin).origin!==origin || new URL(origin).protocol!=='https:' ||
      !store?.read || !store?.compareAndSwap || ![readScope,readPlaybackState,authorizeOwner,readVerifiedMaterial,now,mintTarget].every(f=>typeof f==='function') ||
      readVerifiedSourceSnapshot!==undefined&&typeof readVerifiedSourceSnapshot!=='function'||
      typeof showMode!=='boolean'||!integer(maximumAgeMs) || maximumAgeMs<1 || maximumAgeMs>(showMode?30000:5000)) fail('OBSERVER_PORTS_REQUIRED');
  // Show mode trusts the owner's own output page as the playback clock. Ingress
  // spacing cannot measure playback speed across a serialized network path
  // (one delayed report followed by a prompt one looks "accelerated"), so the
  // rate gate is skipped. Owner auth, binding, sequence, window order and
  // exact PCM window checks still apply. A stale frontier stays safe because
  // the worklet atomically rejects any edit at or before its consumed frame.
  let closed=false,selectedScope=null;const pendingObservations=new Set(),frontierWaiters=new Set();
  function wakeFrontiers(input){for(const waiter of [...frontierWaiters]){
    if(!input||waiter.target===input.targetPlayerId&&waiter.epoch===input.graphEpoch&&waiter.binding===cueDigest(input.binding))waiter.finish();
  }}
  function awaitCurrentObservation(record,binding){
    let timer,finish;
    const waiter={target:record.graph.targetPlayerId,epoch:record.graph.graphEpoch,binding:cueDigest(binding)};
    const promise=new Promise(resolve=>{finish=()=>{clearTimeout(timer);frontierWaiters.delete(waiter);resolve();};});
    waiter.finish=finish;frontierWaiters.add(waiter);timer=setTimeout(finish,5000);
    return {promise,cancel:finish};
  }
  const clock=()=>{const n=now();if(!integer(n))fail('OBSERVER_CLOCK_REQUIRED');return n;};
  const active=()=>{if(enabled!==true||closed)fail('OBSERVER_NOT_ACTIVATED');};
  async function scope({allowStopped=false}={}) {
    active();const atomic=isPlayerObserverSqlStore(store),identity=atomic&&selectedScope?selectedScope:await readScope({roomId});
    const snapshot=atomic?await store.readSourceState(fields(identity)):null;
    const value=snapshot?.scope??identity;
    if(value?.roomId!==roomId||!id(value.sessionId)||!integer(value.controlRevision)||value.closed===true||
      !Number.isFinite(value.expiresAtMs)||value.expiresAtMs<=clock()) fail('OBSERVER_SCOPE_CHANGED');
    if(!same(value,identity)||identity.expiresAtMs!==undefined&&value.expiresAtMs!==identity.expiresAtMs)fail('OBSERVER_SCOPE_CHANGED');
    const playback=snapshot?.playback??await readPlaybackState(fields(value));
    if(playback?.roomId!==roomId||playback.stopped!==false&&!allowStopped)fail('OBSERVER_STOPPED');
    if(atomic)selectedScope=fields(value);
    return {value,playback,...(snapshot?{runtime:snapshot.runtime}:{})};
  }
  async function material(state) {
    const mode=state.playback.stopped===true||state.playback.currentCredit===null?'source':'current';
    return checkedMaterial(state,await readVerifiedMaterial({scope:fields(state.value),mode,playback:state.playback,expiresAtMs:state.value.expiresAtMs,
      ...(Object.hasOwn(state,'runtime')?{runtime:state.runtime}:{})}));
  }
  function checkedMaterial(state,m){
    const mode=state.playback.stopped===true||state.playback.currentCredit===null?'source':'current',b=m?.binding;
    if(!exact(b,bindingKeys)||b.kind!==mode||!id(b.assetId)||!hash(b.sha256)||!hash(b.contextSha256)||!integer(b.playbackRevision)||
       !(m.pcm instanceof Float32Array)||!integer(m.originFrame)||!integer(m.queuedFrames)||m.queuedFrames<WINDOW||m.queuedFrames>MAX_FRAMES||
       m.pcm.length!==m.queuedFrames*2||!integer(m.maximumDurationFrames)||m.maximumDurationFrames<m.queuedFrames||m.maximumDurationFrames>MAX_FRAMES||
       m.originFrame+24*RATE>m.maximumDurationFrames) fail('OBSERVER_PHYSICAL_MATERIAL_REQUIRED');
    for(const sample of m.pcm)if(!Number.isFinite(sample)||Math.abs(sample)>1)fail('OBSERVER_PHYSICAL_MATERIAL_REQUIRED');
    if(mode==='current') {
      const credit=state.playback.currentCredit, copies=(state.playback.cues??[]).filter(c=>c.cueId===credit?.cueId&&
        c.generationId===credit?.generationId&&c.status==='PLAYING'&&c.playbackRevision===credit?.playbackRevision),
        cue=copies.length===1?copies[0]:null;
      if(!id(b.cueId)||!id(b.generationId)||credit?.actual!==true||credit.actualPlayback!==true||credit.cueId!==b.cueId||
          credit.generationId!==b.generationId||credit.playbackRevision!==b.playbackRevision||cue?.status!=='PLAYING'||
          cue.music?.asset?.assetId!==b.assetId||cue.music.asset.sha256!==b.sha256||!Array.isArray(m.videoAssets)||!m.videoAssets.length||
          m.videoAssets.some(v=>!id(v.assetId)||!hash(v.sha256)))fail('OBSERVER_CURRENT_CHANGED');
    }
    return m;
  }
  async function stable(state) {
    const latest=await scope({allowStopped:state.playback.stopped===true});
    if(!same(latest.value,state.value)||latest.value.expiresAtMs!==state.value.expiresAtMs||latest.playback.stopped!==state.playback.stopped||
      cueDigest(latest.playback.currentCredit)!==cueDigest(state.playback.currentCredit))fail('OBSERVER_SCOPE_CHANGED');
  }
  function matchingStop(receipt,graph,state) {
    if(!receipt||!same(receipt,state.value)||receipt.kind!=='selected-player-graph-stopped-v1'||receipt.stopped!==true||
      !integer(receipt.serverStoppedAtMs)||receipt.serverStoppedAtMs>clock()||!hash(receipt.receiptSha256)||
      receipt.targetPlayerId!==graph.targetPlayerId||receipt.graphEpoch!==graph.graphEpoch)fail('OBSERVER_STOP_REQUIRED');
    const {receiptSha256,...body}=receipt;if(cueDigest(body)!==receiptSha256)fail('OBSERVER_STOP_REQUIRED');
  }
  function restartGate(state,record) {
    if(state.playback.stopped!==true)return;
    if(!record||record.stopped||record.graph.mode!=='restart'||record.graph.graphEpoch<2||record.binding.kind!=='source'||
      record.graph.previousGraphEpoch!==record.graph.graphEpoch-1||record.graph.priorStopReceiptSha256!==record.priorStopReceipt?.receiptSha256)
      fail('OBSERVER_STOPPED');
    matchingStop(record.priorStopReceipt,{targetPlayerId:record.graph.previousTargetPlayerId,graphEpoch:record.graph.previousGraphEpoch},state);
  }
  function checkedSaved(result,state) {
    if(!integer(result?.version))fail('OBSERVER_STORE_HOLD');
    const r=result.record,g=r?.graph,o=r?.observation;
    if(r!==null&&r!==undefined&&(!same(r,state.value)||r.kind!=='player-observer-registry-v1'||!same(g,state.value)||
      g.kind!=='selected-player-graph-v1'||!id(g.targetPlayerId)||!integer(g.graphEpoch)||g.graphEpoch<1||
      !integer(g.selectedAtMs)||!integer(g.expiresAtMs)||g.expiresAtMs<=g.selectedAtMs||g.expiresAtMs-g.selectedAtMs>30000||
      !integer(r.sequence)||typeof r.stopped!=='boolean'||!exact(r.binding,bindingKeys)||
      o!==null&&o!==undefined&&(!integer(o.serverObservedAtMs)||
        o.serverReceivedAtMs!==undefined&&(!integer(o.serverReceivedAtMs)||o.serverReceivedAtMs>o.serverObservedAtMs)||
        !integer(o.consumedFrames)||!integer(o.receivedFrames)||
        !integer(o.windowStartFrame)||!integer(o.playedUntilFrame)||!hash(o.processedWindowSha256)||!hash(o.initialWindowSha256))))fail('OBSERVER_STORE_HOLD');
    return result;
  }
  async function saved(state) {return checkedSaved(await store.read(fields(state.value)),state);}
  async function register(input) {
    active(); if(!exact(input,['sampleRate','sourceCount','consumedFrames','receivedFrames','contextState','registrationId'])||input.sampleRate!==RATE||
      input.registrationId!==undefined&&(!id(input.registrationId)||input.registrationId.length<20)||
      input.sourceCount!==1||input.consumedFrames!==0||input.receivedFrames!==0||!['running','suspended'].includes(input.contextState))fail('OBSERVER_FRESH_GRAPH_REQUIRED');
    const state=await scope({allowStopped:true}), m=await material(state), previous=await saved(state), old=previous.record;
    if(old&&!old.stopped) {
      if(input.registrationId&&old.registrationId===input.registrationId&&old.sequence===0&&clock()<old.graph.expiresAtMs&&
        cueDigest(old.binding)===cueDigest(m.binding)){restartGate(state,old);return {...old.graph,binding:{...old.binding},duplicate:true};}
      fail('OBSERVER_GRAPH_ALREADY_SELECTED');
    }
    if(state.playback.stopped===true&&!old?.stopped)fail('OBSERVER_STOPPED');
    if(old)matchingStop(old.stopReceipt,old.graph,state);
    if(m.binding.kind!=='source')fail('OBSERVER_INITIAL_SOURCE_REQUIRED');
    // Finish potentially slow material/scope checks before starting the fresh
    // graph lease. The SQL CAS rechecks owner, epoch and expiry atomically;
    // binding/observe still recheck Stop and the selected source before audio.
    await stable(state);
    const selectedAtMs=clock(), targetPlayerId=mintTarget(), graphEpoch=(old?.graph.graphEpoch??0)+1;
    if(!id(targetPlayerId)||old&&targetPlayerId===old.graph.targetPlayerId||!integer(graphEpoch)||graphEpoch<1)fail('OBSERVER_TARGET_REQUIRED');
    const graph={...fields(state.value),kind:'selected-player-graph-v1',targetPlayerId,graphEpoch,
      mode:old?'restart':'initial',phase:'SELECTED',freshGraph:true,sourceCount:1,receivedFramesBeforeStart:0,consumedFramesBeforeStart:0,
      selectedAtMs,expiresAtMs:Math.min(selectedAtMs+30000,Math.floor(state.value.expiresAtMs)),finiteDurationFrames:m.maximumDurationFrames,
      ...(old?{previousGraphEpoch:old.graph.graphEpoch,previousTargetPlayerId:old.graph.targetPlayerId,priorStopReceiptSha256:old.stopReceipt.receiptSha256}:{})};
    const record={...fields(state.value),kind:'player-observer-registry-v1',graph,binding:{...m.binding},registrationId:input.registrationId??null,sequence:0,observation:null,stopped:false,
      stopReceipt:null,priorStopReceipt:old?.stopReceipt??null};
    await store.compareAndSwap(fields(state.value),previous.version,record);selectedScope=fields(state.value);
    return {...graph,binding:{...m.binding}};
  }
  async function recordObservation(input,attempt=0,receivedAtMs) {
    active();const keys=['targetPlayerId','graphEpoch','sequence','binding','sampleRate','sourceCount','contextState','consumedFrames','receivedFrames',
      'underrunFrames','stopped','windowStartFrame','windowPCM','video'];
    if(!exact(input,keys)||!id(input.targetPlayerId)||!integer(input.graphEpoch)||!integer(input.sequence)||input.sequence<1||
      !exact(input.binding,bindingKeys)||input.sampleRate!==RATE||input.sourceCount!==1||input.contextState!=='running'||
      !integer(input.consumedFrames)||!integer(input.receivedFrames)||input.underrunFrames!==0||input.stopped!==false||!integer(input.windowStartFrame)||
      !Array.isArray(input.windowPCM)||input.windowPCM.length!==WINDOW*2||input.windowPCM.some(v=>!Number.isFinite(v)||Math.abs(v)>1))fail('OBSERVER_PCM_REQUIRED');
    // Frame rate is measured between ingress times. Validation may await SQL
    // or physical I/O while the browser keeps processing real audio frames.
    const serverReceivedAtMs=receivedAtMs??clock();
    const atomic=isPlayerObserverSqlStore(store)&&typeof store.compareAndSwapObserved==='function';
    const snapshot=atomic?await store.readObservationState(selectedScope??fields(await readScope({roomId}))):null;
    const state=snapshot?{value:snapshot.scope,playback:snapshot.playback,runtime:snapshot.runtime}:await scope({allowStopped:true});
    if(state.value.roomId!==roomId||!id(state.value.sessionId)||!integer(state.value.controlRevision)||
      state.value.closed===true||!Number.isFinite(state.value.expiresAtMs)||state.value.expiresAtMs<=clock())fail('OBSERVER_SCOPE_CHANGED');
    const m=await material(state),versioned=snapshot?checkedSaved(snapshot,state):await saved(state),record=versioned.record;
    if(atomic)selectedScope=fields(state.value);
    restartGate(state,record);
    if(!record||record.stopped||record.graph.targetPlayerId!==input.targetPlayerId||record.graph.graphEpoch!==input.graphEpoch||
       input.sequence!==record.sequence+1||cueDigest(input.binding)!==cueDigest(m.binding)||
       input.receivedFrames!==m.queuedFrames&&!(integer(m.acceptedPrefixFrames)&&input.receivedFrames===m.acceptedPrefixFrames)||
       input.consumedFrames<input.windowStartFrame+WINDOW||input.consumedFrames>=input.receivedFrames||input.windowStartFrame<m.originFrame||
       input.windowStartFrame+WINDOW>m.originFrame+24*RATE||record.observation&&input.consumedFrames<=record.observation.consumedFrames)
      fail('OBSERVER_FRONTIER_CHANGED');
    if(!record.observation&&clock()>record.graph.expiresAtMs)fail('OBSERVER_GRAPH_EXPIRED');
    const previous=record.observation,elapsed=serverReceivedAtMs-(previous?.serverReceivedAtMs??previous?.serverObservedAtMs??record.graph.selectedAtMs);
    const advanced=input.consumedFrames-(previous?.consumedFrames??0);
    // Finite server receipt bounds reject impossible accelerated/replayed frame
    // reports. The allowance covers the worklet's 250ms telemetry batching and
    // request jitter; wall time never creates a missing processed PCM window.
    if(elapsed<0)fail('OBSERVER_FRAME_TIME_CHANGED_CLOCK');
    if(!showMode&&advanced>Math.ceil((elapsed+1000)*RATE/1000))fail('OBSERVER_FRAME_TIME_CHANGED_RATE');
    if(previous&&input.windowStartFrame<=previous.windowStartFrame)fail('OBSERVER_FRAME_TIME_CHANGED_WINDOW_ORDER');
    if(previous&&input.windowStartFrame+WINDOW<input.consumedFrames-RATE)fail('OBSERVER_FRAME_TIME_CHANGED_WINDOW_STALE');
    if(!previous&&m.binding.kind==='source'&&input.windowStartFrame!==0)fail('OBSERVER_INITIAL_WINDOW_REQUIRED');
    const installedPrefix=input.receivedFrames!==m.queuedFrames&&
      input.receivedFrames===m.acceptedPrefixFrames;
    if(installedPrefix&&(m.acceptedPrefixFrames<m.originFrame+WINDOW||m.acceptedPrefixFrames>m.queuedFrames||
      !(m.installedPrefixPCM instanceof Float32Array)||m.installedPrefixPCM.length!==input.receivedFrames*2))
      fail('OBSERVER_PHYSICAL_MATERIAL_REQUIRED');
    const physical=(installedPrefix?m.installedPrefixPCM:m.pcm).subarray(input.windowStartFrame*2,(input.windowStartFrame+WINDOW)*2),observed=new Float32Array(input.windowPCM);
    for(let i=0;i<physical.length;i++)if(!Object.is(physical[i],observed[i]))fail('OBSERVER_PHYSICAL_WINDOW_CHANGED');
    const processedWindowSha256=pcmSha(physical),timestamp=clock();
    let video=null;
    if(m.binding.kind==='current') {
      const v=input.video;
      if(!exact(v,['assetId','sha256','presentedFrames','mediaTime','width','height','muted','volume'])||
        !m.videoAssets.some(a=>a.assetId===v.assetId&&a.sha256===v.sha256)||!integer(v.presentedFrames)||v.presentedFrames<1||
        !Number.isFinite(v.mediaTime)||v.mediaTime<0||!integer(v.width)||!integer(v.height)||v.width<1||v.height<1||
        Math.abs(v.width-v.height*16/9)>1||v.muted!==true||v.volume!==0)fail('OBSERVER_CURRENT_VIDEO_REQUIRED');
      const prior=record.observation?.video;
      if(cueDigest(record.binding)===cueDigest(m.binding)&&prior?.assetId===v.assetId&&v.presentedFrames<=prior.presentedFrames)fail('OBSERVER_VIDEO_FRONTIER_CHANGED');
      video={...v};
    } else if(input.video!==null)fail('OBSERVER_SOURCE_ONLY_REQUIRED');
    const observation={consumedFrames:input.consumedFrames,receivedFrames:input.receivedFrames,windowStartFrame:input.windowStartFrame,
      processedWindowSha256,serverReceivedAtMs,serverObservedAtMs:timestamp,video,playedUntilFrame:input.consumedFrames-m.originFrame,
      initialWindowSha256:record.observation?.initialWindowSha256??processedWindowSha256};
    const next={...record,binding:{...m.binding},sequence:input.sequence,observation};
    if(atomic){try{await store.compareAndSwapObserved(fields(state.value),versioned.version,next,
      snapshot.stateFence??{scopeExpiresAtMs:state.value.expiresAtMs,playback:state.playback,runtime:snapshot.runtime});}
      catch(error){
        // Reserving a future Cue may change the fenced state during physical
        // verification. Re-read and fully revalidate this SAME ingress once.
        // Stop/owner/scope/sequence changes still reject; ingress time is never
        // renewed and a committed unknown write cannot advance twice.
        if(attempt===0)return recordObservation(input,1,serverReceivedAtMs);throw error;
      }}
    else {await stable(state);await store.compareAndSwap(fields(state.value),versioned.version,next);await stable(state);}
    return {accepted:true,sequence:input.sequence,serverObservedAtMs:timestamp,sourceOnly:m.binding.kind==='source'};
  }
  function observeAtIngress(input,receivedAtMs){
    const pending=recordObservation(input,0,receivedAtMs);pendingObservations.add(pending);
    void pending.then(result=>{if(result.accepted&&result.sourceOnly===false)wakeFrontiers(input);},()=>{});
    void pending.finally(()=>pendingObservations.delete(pending)).catch(()=>{});return pending;
  }
  function observe(input){return observeAtIngress(input);}
  async function readRecord(input={}, {allowStoppedRestart=false}={}) {
    if(!exact(input,referenceKeys)||input.roomId!==roomId)fail('OBSERVER_SCOPE_CHANGED');
    const state=await scope({allowStopped:allowStoppedRestart}),versioned=await saved(state),record=versioned.record;
    restartGate(state,record);
    if(!record||record.stopped||input.sessionId!==undefined&&!same(input,state.value)||input.targetPlayerId!==undefined&&input.targetPlayerId!==record.graph.targetPlayerId||
       input.graphEpoch!==undefined&&input.graphEpoch!==record.graph.graphEpoch)fail('OBSERVER_TARGET_CHANGED');
    await stable(state);return {state,record};
  }
  async function sourceState(input){
    if(!exact(input,['roomId','sessionId','controlRevision'])||input.roomId!==roomId||
      (input.sessionId!==undefined)!==(input.controlRevision!==undefined))fail('OBSERVER_SCOPE_CHANGED');
    active();let state,record;
    if(isPlayerObserverSqlStore(store)&&typeof store.readSourceState==='function'){
      // Scope identity is not authority: the SQL read below authenticates this
      // owner/epoch/control and returns live expiry/Stop on EVERY invocation.
      const expected=input['sessionId']===undefined?(selectedScope??await readScope({roomId})):input;
      const snapshot=await store.readSourceState(fields(expected));
      const value=snapshot.scope,playback=snapshot.playback;
      if(value?.roomId!==roomId||!id(value.sessionId)||!integer(value.controlRevision)||value.closed===true||
        !Number.isFinite(value.expiresAtMs)||value.expiresAtMs<=clock())fail('OBSERVER_SCOPE_CHANGED');
      state={value,playback,runtime:snapshot.runtime};record=checkedSaved(snapshot,state).record;selectedScope=fields(value);
    }else{
      const checked=await readRecord(input,{allowStoppedRestart:true});state=checked.state;record=checked.record;
    }
    restartGate(state,record);
    if(input.sessionId!==undefined&&!same(input,state.value)||!record||record.stopped||record.binding.kind!=='source'||
      state.playback.currentCredit!==null)fail('OBSERVER_TARGET_CHANGED');
    // The final SQL store read atomically authenticates this owner, room epoch,
    // control and expiry. Callers re-read this state after durable receipt I/O.
    return {state,record};
  }
  async function currentState(input){
    active();
    if(!isPlayerObserverSqlStore(store))return readRecord(input);
    // The existing SQL read authenticates owner/scope/expiry and returns the
    // observation together with playback and its ACK lineage atomically.
    const expected=input['sessionId']===undefined?(selectedScope??await readScope({roomId})):input;
    const snapshot=await store.readObservationState(fields(expected)),state={value:snapshot.scope,playback:snapshot.playback,runtime:snapshot.runtime};
    active();
    if(state.value?.roomId!==roomId||!id(state.value.sessionId)||!integer(state.value.controlRevision)||
      state.value.closed===true||state.value.expiresAtMs<=clock()||!same(state.value,expected)||
      state.playback?.roomId!==roomId||state.playback.stopped!==false)fail('OBSERVER_STOPPED');
    const record=checkedSaved(snapshot,state).record;
    if(!record||record.stopped||input.sessionId!==undefined&&!same(input,state.value)||
      input.targetPlayerId!==undefined&&input.targetPlayerId!==record.graph.targetPlayerId||
      input.graphEpoch!==undefined&&input.graphEpoch!==record.graph.graphEpoch)fail('OBSERVER_TARGET_CHANGED');
    selectedScope=fields(state.value);return {state,record};
  }
  async function frontier(input,kind) {
    if(!exact(input,referenceKeys)||input.roomId!==roomId)fail('OBSERVER_SCOPE_CHANGED');
    const read=()=>kind==='source'?sourceState(fields(input)):currentState(input);
    const before=await read();
    const immutable=isPlayerObserverSqlStore(store)&&readVerifiedSourceSnapshot?.({scope:fields(before.state.value),
      mode:kind,playback:before.state.playback,expiresAtMs:before.state.value.expiresAtMs,
      ...(Object.hasOwn(before.state,'runtime')?{runtime:before.state.runtime}:{})});
    const m=immutable?checkedMaterial(before.state,immutable):await material(before.state);
    // Physical verification can outlive an observation while the actual player
    // continues sending newer verified windows. Read the authoritative frontier
    // after that I/O, retaining the same graph/scope/credit and every age bound.
    // An owner-authenticated atomic read followed ONLY by synchronous private
    // immutable PCM checks already supplies the live linearization point.
    // Keep the second fresh read whenever physical/network I/O was necessary.
    let latest=immutable?before:await read();
    // Only right after the switch: the persisted previous window (source or
    // prior Cue) must be younger than one Cue, otherwise a real CURRENT window
    // is required as before. A stale credit never mints an at-start frontier.
    if(showMode&&kind==='current'&&m.binding.kind==='current'&&latest.record.observation&&
      cueDigest(latest.record.binding)!==cueDigest(m.binding)&&
      clock()-latest.record.observation.serverObservedAtMs<=24000){
      // Show mode: the accepted actual AV ACK (current credit) proves this Cue
      // began sounding on this graph. Use it as an at-start frontier so the
      // next Cue is reserved without waiting for a delayed CURRENT window; the
      // worklet still atomically refuses an edit at or before its consumed frame.
      const {state,record}=latest,credit=state.playback.currentCredit;
      if(!same(state.value,before.state.value)||state.value.expiresAtMs!==before.state.value.expiresAtMs||state.playback.stopped!==false||
        cueDigest(credit)!==cueDigest(before.state.playback.currentCredit)||record.stopped||
        record.graph.targetPlayerId!==before.record.graph.targetPlayerId||record.graph.graphEpoch!==before.record.graph.graphEpoch)
        fail('OBSERVER_SCOPE_CHANGED');
      if(input.targetPlayerId!==undefined&&input.targetPlayerId!==record.graph.targetPlayerId||
        input.graphEpoch!==undefined&&input.graphEpoch!==record.graph.graphEpoch)fail('OBSERVER_TARGET_CHANGED');
      if(credit?.actual!==true||credit.actualPlayback!==true||credit.cueId!==m.binding.cueId||
        credit.generationId!==m.binding.generationId||credit.playbackRevision!==m.binding.playbackRevision)fail('OBSERVER_FRESH_FRONTIER_REQUIRED');
      const observedAtMs=clock();
      const body={...fields(state.value),targetPlayerId:record.graph.targetPlayerId,graphEpoch:record.graph.graphEpoch,
        playedUntilFrame:WINDOW,sampleRate:RATE,actual:true,audioStarted:true,kind:'authenticated-player-frontier-v1',
        cueId:m.binding.cueId,generationId:m.binding.generationId,assetId:m.binding.assetId,sha256:m.binding.sha256,
        playbackRevision:m.binding.playbackRevision,videoPresented:true,observedAtMs};
      return {...body,observationSha256:cueDigest({...body,sequence:record.sequence,acknowledgedStart:true,credit})};
    }
    if(kind==='current'&&m.binding.kind==='current'&&latest.record.sequence>0&&
      (!latest.record.observation||cueDigest(latest.record.binding)!==cueDigest(m.binding)||
        clock()-latest.record.observation.serverObservedAtMs>maximumAgeMs)){
      // The accepted Cue ACK can precede its next processed PCM/video window.
      // Wait for an actual matching ingress event, then re-read authority. This
      // never retries a POST, manufactures a timestamp or extends proof ages.
      const waiting=awaitCurrentObservation(latest.record,m.binding);
      try{
        latest=await read();
        if(!latest.record.observation||cueDigest(latest.record.binding)!==cueDigest(m.binding)||
          clock()-latest.record.observation.serverObservedAtMs>maximumAgeMs){
          await waiting.promise;latest=await read();
        }
      }finally{waiting.cancel();}
    }
    // A newer verified observation can commit while this read's network reply
    // is in flight. Reconcile one stale reply with one fresh authoritative read;
    // the observation timestamp and strict age bound remain unchanged.
    if(latest.record.observation&&clock()-latest.record.observation.serverObservedAtMs>maximumAgeMs){
      // An ingress already checking the next physical PCM window may not yet
      // have completed CAS. Wait only for existing work, never manufacture a
      // fresh timestamp or poll/replay an observation request.
      if(kind==='source'&&pendingObservations.size){
        let timer;try{await Promise.race([Promise.allSettled([...pendingObservations]),
          new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);}finally{clearTimeout(timer);}
      }
      latest=await read();
    }
    const {state,record}=latest,o=record.observation;
    if(!same(state.value,before.state.value)||state.value.expiresAtMs!==before.state.value.expiresAtMs||
      state.playback.stopped!==before.state.playback.stopped||
      cueDigest(state.playback.currentCredit)!==cueDigest(before.state.playback.currentCredit)||
      record.graph.targetPlayerId!==before.record.graph.targetPlayerId||record.graph.graphEpoch!==before.record.graph.graphEpoch)
      fail('OBSERVER_SCOPE_CHANGED');
    if(input.targetPlayerId!==undefined&&input.targetPlayerId!==record.graph.targetPlayerId||
      input.graphEpoch!==undefined&&input.graphEpoch!==record.graph.graphEpoch)fail('OBSERVER_TARGET_CHANGED');
    if(!o||clock()-o.serverObservedAtMs>maximumAgeMs||o.serverObservedAtMs>clock()||cueDigest(record.binding)!==cueDigest(m.binding)||
       m.binding.kind!==kind||o.playedUntilFrame<WINDOW||o.playedUntilFrame>=24*RATE)fail('OBSERVER_FRESH_FRONTIER_REQUIRED');
    if(kind!=='source'&&!immutable)await stable(state);
    if(clock()-o.serverObservedAtMs>maximumAgeMs||o.serverObservedAtMs>clock())fail('OBSERVER_FRESH_FRONTIER_REQUIRED');
    if(state.value.expiresAtMs<=clock())fail('OBSERVER_SCOPE_CHANGED');
    const common={...fields(state.value),targetPlayerId:record.graph.targetPlayerId,graphEpoch:record.graph.graphEpoch,
      playedUntilFrame:o.playedUntilFrame,sampleRate:RATE,actual:true,audioStarted:true};
    if(kind==='source')return {...common,kind:'authenticated-source-frontier-v1',sourceClipId:m.binding.assetId,sourceSha256:m.binding.sha256,
      sourceContextSha256:m.binding.contextSha256,sourcePlaybackRevision:m.binding.playbackRevision,processedWindowSha256:o.initialWindowSha256,
      receivedFrames:o.receivedFrames,sourceCount:1,underrunFrames:0,stopped:false,playbackStopped:state.playback.stopped,participantCredit:false,serverObservedAtMs:o.serverObservedAtMs};
    const body={...common,kind:'authenticated-player-frontier-v1',cueId:m.binding.cueId,generationId:m.binding.generationId,
      assetId:m.binding.assetId,sha256:m.binding.sha256,playbackRevision:m.binding.playbackRevision,videoPresented:true,observedAtMs:o.serverObservedAtMs};
    return {...body,observationSha256:cueDigest({...body,sequence:record.sequence,processedWindowSha256:o.processedWindowSha256,video:o.video})};
  }
  async function stop(input) {
    const current=exact(input,['current'])&&input.current===true;
    if(!current&&(!exact(input,['targetPlayerId','graphEpoch'])||!id(input.targetPlayerId)||!integer(input.graphEpoch)))fail('OBSERVER_TARGET_REQUIRED');
    const state=await scope({allowStopped:true}),versioned=await saved(state),record=versioned.record;
    if(!record&&current)return {stopped:true,noGraph:true};
    if(!record||!current&&(record.graph.targetPlayerId!==input.targetPlayerId||record.graph.graphEpoch!==input.graphEpoch))fail('OBSERVER_TARGET_CHANGED');
    if(record.stopped)return structuredClone(record.stopReceipt);
    const stopReceipt=seal({...fields(state.value),kind:'selected-player-graph-stopped-v1',targetPlayerId:record.graph.targetPlayerId,
      graphEpoch:record.graph.graphEpoch,stopped:true,serverStoppedAtMs:clock()});
    await store.compareAndSwap(fields(state.value),versioned.version,{...record,stopped:true,observation:null,stopReceipt});
    wakeFrontiers();
    return stopReceipt;
  }
  async function handleRequest(request) {
    const path=new URL(request.url).pathname;
    const match=path.match(/^\/api\/rooms\/([a-f0-9-]{36})\/player\/(register|binding|observe|stop)$/i);if(!match)return null;
    const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
    if(match[1]!==roomId||request.headers.get('origin')!==origin||!hash(request.headers.get('x-room-owner'))||
      request.headers.has('authorization')||request.headers.has('x-api-key')||request.headers.has('x-fal-key'))return reply({error:'OBSERVER_OWNER_DENIED'},403);
    if(request.method!=='POST')return reply({error:'POST_REQUIRED'},405);
    try {
      active();
      // Authorization SQL can take different amounts of time per request.
      // Capture our own HTTP ingress clock before that I/O; neither the client
      // nor a later verification/retry can move this physical rate baseline.
      const observationReceivedAtMs=match[2]==='observe'?clock():undefined;
      if(await authorizeOwner({roomId,ownerCapability:request.headers.get('x-room-owner')})!==true)fail('OBSERVER_OWNER_DENIED');
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply({error:'JSON_REQUIRED'},415);
      const reader=request.body?.getReader();let bytes=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
      if(reader)while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>32768){await reader.cancel();fail('OBSERVER_BODY_LIMIT');}text+=decoder.decode(part.value,{stream:true});}
      text+=decoder.decode();const body=JSON.parse(text);let result;
      if(match[2]==='register')result=await register(body);else if(match[2]==='binding') {
        if(!exact(body,['registrationId','collection']) )fail('OBSERVER_SCOPE_CHANGED');
        const c=body.collection;
        if(c!==undefined&&(!c||!exact(c,['receivedFrames','consumedFrames','windowStartFrame','originFrame','playbackRevision','videoReady'])||
          !['receivedFrames','consumedFrames','windowStartFrame','originFrame','playbackRevision'].every(k=>integer(c[k])&&c[k]<=MAX_FRAMES)||
          typeof c.videoReady!=='boolean'))fail('OBSERVER_PCM_REQUIRED');
        // One authenticated atomic snapshot carries the live scope, record and
        // playback. Do not repeat network reads while the finite Cue plays.
        const snapshot=isPlayerObserverSqlStore(store)?await store.readObservationState(selectedScope??fields(await readScope({roomId}))):null;
        const state=snapshot?{value:snapshot.scope,playback:snapshot.playback,runtime:snapshot.runtime}:await scope({allowStopped:true});
        if(state.value.roomId!==roomId||!id(state.value.sessionId)||!integer(state.value.controlRevision)||
          state.value.closed===true||!Number.isFinite(state.value.expiresAtMs)||state.value.expiresAtMs<=clock())fail('OBSERVER_SCOPE_CHANGED');
        const record=(snapshot?checkedSaved(snapshot,state):await saved(state)).record,m=await material(state);
        if(snapshot)selectedScope=fields(state.value);
        restartGate(state,record);
        if(!record||record.stopped||body.registrationId!==undefined&&(body.registrationId!==record.registrationId||record.sequence!==0||clock()>=record.graph.expiresAtMs))fail('OBSERVER_TARGET_CHANGED');
        result={targetPlayerId:record.graph.targetPlayerId,graphEpoch:record.graph.graphEpoch,mode:record.graph.mode,
          selectedAtMs:record.graph.selectedAtMs,expiresAtMs:record.graph.expiresAtMs,
          binding:{...m.binding},originFrame:m.originFrame,queuedFrames:m.queuedFrames,sequence:record.sequence,
          ...(integer(m.acceptedPrefixFrames)?{acceptedPrefixFrames:m.acceptedPrefixFrames}:{})};
        // Bounded anonymous counters are diagnostics only, never proof or input
        // to authorization, timing checks, queue edits, or participant credit.
        if(c)try{onCollectionState(`${m.binding.kind.toUpperCase()}_S${record.sequence}_R${c.receivedFrames}_Q${m.queuedFrames}_C${c.consumedFrames}_W${c.windowStartFrame}_O${c.originFrame}_E${m.originFrame}_P${c.playbackRevision}_V${+c.videoReady}`);}catch{}
      } else if(match[2]==='observe')result=await observeAtIngress(body,observationReceivedAtMs);else result=await stop(body);
      return reply(result);
    }catch(error){if(typeof onHold==='function'&&/^[A-Z0-9_]{1,80}$/.test(error?.code??''))try{onHold(error.code);}catch{}
      const code=['OBSERVER_NOT_ACTIVATED','OBSERVER_OWNER_DENIED','OBSERVER_BODY_LIMIT'].includes(error?.code)?error.code:'OBSERVER_HOLD';
      return reply({error:code},code==='OBSERVER_OWNER_DENIED'?403:code==='OBSERVER_BODY_LIMIT'?413:409);}
  }
  return Object.freeze({register,observe,stop,handleRequest,readGraphAuthority:async input=>(await readRecord(input,{allowStoppedRestart:true})).record.graph,
    readSourceStartState:async input=>{const {state,record}=await sourceState(input);return {scope:{...state.value},playback:structuredClone(state.playback),
      graph:structuredClone(record.graph),priorStopReceipt:structuredClone(record.priorStopReceipt)};},
    readPriorStopReceipt:async input=>{const state=await scope({allowStopped:true}),record=(await saved(state)).record;const receipt=[record?.stopReceipt,record?.priorStopReceipt]
      .find(r=>r?.targetPlayerId===input.targetPlayerId&&r.graphEpoch===input.graphEpoch&&same(r,input));if(!receipt)fail('OBSERVER_STOP_REQUIRED');return structuredClone(receipt);},
    readSourceFrontier:input=>frontier(input,'source'),readCurrentFrontier:input=>frontier(input,'current'),
    readSelectedTarget:async input=>{const f=await frontier(input,'current');return {...fields(f),kind:'selected-current-player-v1',targetPlayerId:f.targetPlayerId,
      cueId:f.cueId,generationId:f.generationId,playbackRevision:f.playbackRevision,expiresAtMs:f.observedAtMs+maximumAgeMs};},
    close(){closed=true;wakeFrontiers();},capabilities:()=>({sqlStateContract:isPlayerObserverSqlStore(store),durableStateVerified:false,
      hardwareAttestation:false,defaultActivation:false,liveVerified:false,showMode})});
}
