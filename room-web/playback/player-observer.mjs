// Output-side collection from the sole connected engine. Credentials remain
// in the owner's request closure; only anonymous measurements cross its port.
const frame=n=>Number.isSafeInteger(n)&&n>=0;
const fail=code=>{throw Error(code);};
export function createBrowserPlayerObserver({enabled=false,transport,readEngine,subscribe,requestWindow,readVideo,
  onError=()=>{},onDiagnostics=()=>{},intervalMs=500,autoSample=true}={}) {
  if(![transport,readEngine,subscribe,requestWindow,readVideo].every(f=>typeof f==='function')||!frame(intervalMs)||intervalMs<250||intervalMs>1000||typeof autoSample!=='boolean')
    fail('PLAYER_OBSERVER_PORTS_REQUIRED');
  let closed=false,selected=null,window=null,pending=null,timer=null,videoRequest=null,video=null,lastVideo=null,stopPromise=null,windowWaiter=null,acceptedSequence=0;
  const registrationId=enabled?globalThis.crypto.randomUUID():null;
  let collectionStage='IDLE',lastError=null;
  const diagnostics=()=>{const s=readEngine();return {stage:collectionStage,acceptedSequence,hasWindow:!!window,
    consumedFrames:s.consumedFrames,receivedFrames:s.receivedFrames,contextState:s.contextState,sourceCount:s.sourceCount,
    windowStartFrame:window?.startFrame??null,hasVideo:!!lastVideo,closed,lastError};};
  const stage=value=>{collectionStage=value;try{onDiagnostics(diagnostics());}catch{}};
  const valid=()=>{if(!enabled||closed)fail('PLAYER_OBSERVER_NOT_ACTIVATED');};
  const unsubscribe=enabled?subscribe(event=>{
    const w=event?.observationWindow??event?.playedWindow;
    if(w?.pcm instanceof ArrayBuffer&&w.pcm.byteLength===256*8&&frame(w.startFrame)){
      window={startFrame:w.startFrame,pcm:new Float32Array(w.pcm.slice(0))};
    }
    // The processor emits PCM before its next quarter-second telemetry report.
    // Wait for both messages before testing the refreshed window's frontier.
    if(windowWaiter&&window&&readEngine().consumedFrames>=window.startFrame+256)windowWaiter(window);
  }):()=>{};
  function cancelVideo(){if(videoRequest!==null&&video?.element?.cancelVideoFrameCallback)video.element.cancelVideoFrameCallback(videoRequest);videoRequest=null;}
  function watchVideo(){
    const current=readVideo();
    if(current?.element!==video?.element||current?.assetId!==video?.assetId||current?.cueId!==video?.cueId){cancelVideo();video=current;lastVideo=null;}
    if(!current?.element||videoRequest!==null)return;
    const binding=current;
    videoRequest=binding.element.requestVideoFrameCallback((_time,metadata)=>{
      videoRequest=null;const latest=readVideo();
      if(!closed&&latest?.element===binding.element&&latest.cueId===binding.cueId&&latest.assetId===binding.assetId){
        const e=binding.element;
        const presentation=typeof binding.readPresentation==='function'?binding.readPresentation():{width:e.videoWidth,height:e.videoHeight};
        if(!presentation){lastVideo=null;lastError='PLAYER_OBSERVER_VIDEO_LAYOUT_CHANGED';stage('VIDEO_LAYOUT_HOLD');onError(Error(lastError));return;}
        lastVideo={assetId:binding.assetId,sha256:binding.sha256,presentedFrames:metadata.presentedFrames,mediaTime:metadata.mediaTime,
          width:presentation.width,height:presentation.height,muted:e.muted,volume:e.volume};
        watchVideo();
      }
    });
  }
  async function register(){
    valid();if(selected)fail('PLAYER_OBSERVER_ALREADY_SELECTED');
    const s=readEngine();
    try {selected=await transport('register',{sampleRate:s.sampleRate,sourceCount:s.sourceCount,consumedFrames:s.consumedFrames,
      receivedFrames:s.receivedFrames,contextState:s.contextState,registrationId});}
    catch {valid();selected=await transport('binding',{registrationId});}
    valid();
    if(autoSample)startSampling();
    return structuredClone(selected);
  }
  async function collect(){
      valid();stage('COLLECT');if(!selected){stage('WAIT_SELECTION');return null;}
      watchVideo();
      // No server binding is useful before this graph has processed a window.
      // Do not queue empty polls ahead of the authenticated initial-start guard.
      const before=readEngine();
      // A lost one-shot processor request must not stall collection forever.
      // After the first accepted source window, ask again while waiting; only
      // an actual new PCM event can produce the next authenticated observation.
      if(!window&&acceptedSequence>0&&before.clip&&before.receivedFrames>=256)requestWindow();
      if(!window||!before.clip||before.receivedFrames<256||before.consumedFrames<window.startFrame+256){stage('WAIT_PCM');return null;}
      // The sole initial source was selected by register. Its observe ingress
      // independently checks the current server binding and CAS sequence, so
      // no extra binding round trip is needed for each unchanged finite source.
      const initial=selected.binding?.kind==='source'&&selected.finiteDurationFrames===24*44100&&
        before.receivedFrames===selected.finiteDurationFrames&&before.clip.originFrame===0&&
        before.clip.clipId===selected.binding.assetId&&before.clip.sha256===selected.binding.sha256&&
        before.clip.playbackRevision===selected.binding.playbackRevision;
      stage(initial?'SOURCE_BINDING':'BINDING');
      const server=initial?{...selected,sequence:acceptedSequence,queuedFrames:selected.finiteDurationFrames,originFrame:0}:
        await transport('binding',{collection:{receivedFrames:before.receivedFrames,consumedFrames:before.consumedFrames,
          windowStartFrame:window.startFrame,originFrame:before.clip.originFrame,playbackRevision:before.clip.playbackRevision,
          videoReady:!!lastVideo}});valid();let s=readEngine(),w=window;
      if(server.sequence>0&&w&&s.consumedFrames>w.startFrame+256+44100){
        stage('REFRESH_PCM');
        w=await new Promise(resolve=>{const finish=value=>{clearTimeout(deadline);windowWaiter=null;resolve(value);};
          const deadline=setTimeout(()=>finish(null),1000);windowWaiter=finish;window=null;requestWindow();});
        valid();s=readEngine();
      }
      const b=server.binding,clip=s.clip;
      if(server.targetPlayerId!==selected.targetPlayerId||server.graphEpoch!==selected.graphEpoch)fail('PLAYER_OBSERVER_TARGET_CHANGED');
      if(!w||!clip||s.receivedFrames!==server.queuedFrames&&s.receivedFrames!==server.acceptedPrefixFrames||clip.clipId!==b.assetId||clip.sha256!==b.sha256||clip.playbackRevision!==b.playbackRevision||
        clip.originFrame!==server.originFrame||s.consumedFrames<w.startFrame+256||w.startFrame<server.originFrame||
        b.kind==='current'&&(!lastVideo||readVideo()?.cueId!==b.cueId)){stage('WAIT_BINDING_OR_VIDEO');return null;}
      const proof={targetPlayerId:selected.targetPlayerId,graphEpoch:selected.graphEpoch,sequence:server.sequence+1,binding:b,
        sampleRate:s.sampleRate,sourceCount:s.sourceCount,contextState:s.contextState,consumedFrames:s.consumedFrames,
        receivedFrames:s.receivedFrames,underrunFrames:s.underrunFrames,stopped:s.stopped===true,
        windowStartFrame:w.startFrame,windowPCM:Array.from(w.pcm),video:b.kind==='current'?lastVideo:null};
      stage('OBSERVE');const result=await transport('observe',proof);valid();
      if(Number.isSafeInteger(result?.sequence))acceptedSequence=result.sequence;
      window=null;requestWindow();stage('ACCEPTED');return result;
  }
  function sample(){
    if(pending)return pending;
    pending=collect().catch(error=>{lastError=/^[A-Z0-9_]{1,80}$/.test(error?.message??'')?error.message:'PLAYER_OBSERVER_HOLD';stage('FAILED');throw error;}).finally(()=>{pending=null;});return pending;
  }
  function startSampling(){valid();if(timer!==null)return;timer=setInterval(()=>{
    if(!closed&&!pending)void sample().catch(()=>{if(!closed)onError(Error('PLAYER_OBSERVER_HOLD'));});
  },intervalMs);}
  return Object.freeze({register,sample,startSampling,readDiagnostics:diagnostics,async stop(){
    if(stopPromise)return stopPromise;
    closed=true;clearInterval(timer);windowWaiter?.(null);unsubscribe();cancelVideo();window=null;lastVideo=null;
    // Local error cleanup closes collection first. A later explicit Stop must
    // still record its graph stop, so the next graph can prove a valid restart.
    if(selected&&enabled)stopPromise=transport('stop',{targetPlayerId:selected.targetPlayerId,graphEpoch:selected.graphEpoch});
    return stopPromise;
  },close(){closed=true;clearInterval(timer);windowWaiter?.(null);unsubscribe();cancelVideo();window=null;lastVideo=null;}});
}
