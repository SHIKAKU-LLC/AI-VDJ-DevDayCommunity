// Browser playback boundary. No credentials, generation, native PCM API or upload.
const RATE = 44100;
const fail = code => { throw Error(code); };
const sha = async bytes => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');

export async function restorePublicInitialAudio({request, requestId, storageHosts, fetchImpl = globalThis.fetch, signal}) {
  const job = await request({operation:'job-read', requestId});
  const seed = job.initialSeed;
  if (job.state !== 'QC_READY' || !seed?.qc?.passed || seed.requestId !== requestId) fail('PUBLIC_INITIAL_QC_READY_REQUIRED');
  const grant = await request({operation:'save-grant', assetId:seed.rawAssetId});
  const url = new URL(grant.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !storageHosts?.includes(url.hostname)) fail('PRIVATE_GRANT_TARGET_REFUSED');
  if (grant.assetId !== seed.rawAssetId || grant.contentType !== 'audio/wav' || grant.sha256 !== seed.provenance?.rawSha256) fail('PUBLIC_INITIAL_GRANT_MISMATCH');
  const response = await fetchImpl(url.href, {credentials:'omit', redirect:'error', signal});
  if (!response.ok) fail('PUBLIC_INITIAL_DOWNLOAD_FAILED');
  const rawAudio = await response.arrayBuffer();
  if (rawAudio.byteLength > 8*1024*1024 || await sha(rawAudio) !== grant.sha256) fail('PUBLIC_INITIAL_SHA_MISMATCH');
  if (signal?.aborted) fail('PUBLIC_INITIAL_STOPPED');
  return {job, rawAudio};
}

export function createPublicPlayback({decodeAudio, contextFactory = () => new AudioContext({sampleRate:RATE}), nodeFactory = ctx => new AudioWorkletNode(ctx, 'queue-audio', {outputChannelCount:[2]}), workletUrl = '/worklet.mjs', videoAdapterFactory, container, readOtherAudioActive = () => false, onState = () => {}, ackTimeoutMs = 8000, lifecycle = globalThis.window} = {}) {
  if (typeof decodeAudio !== 'function') fail('BROWSER_DECODER_REQUIRED');
  let ctx, node, gain, video, prepared, generation=0, startPromise, ackResolve, ackReject, ackTimer;
  let phase='IDLE', activeClip=null, requestedVideo=null, presentedVideo=null, cueIndex=0, volume=.55;
  const metrics={sourceCount:0, commits:[], presentations:[], errors:[]};
  let telemetry={consumedFrames:0, queuedFrames:0, underrunFrames:0, stopped:false};
  const read = () => ({phase, active:phase==='PLAYING', stopped:phase==='STOPPED', contextState:ctx?.state, audioTime:telemetry.consumedFrames/RATE, sourceCount:metrics.sourceCount, volume, activeClipId:activeClip, preparedClipId:prepared?.seed.clipId??null, videoReady:requestedVideo?.jobId??null, presentedVideoId:presentedVideo, telemetry:{...telemetry}, metrics:structuredClone(metrics)});
  const emit = () => { try { onState(read()); } catch {} };
  async function stop(reason='USER_STOP') {
    if (phase==='STOPPED') return;
    generation++; phase='STOPPED'; clearTimeout(ackTimer); ackReject?.(Error(reason)); ackResolve=ackReject=null;
    node?.port.postMessage({type:'stop'}); video?.dispose(); await ctx?.close(); emit();
  }
  async function prepareInitial({job, rawAudio}) {
    if (phase!=='IDLE' || readOtherAudioActive()) fail('PUBLIC_PREPARE_WHILE_ACTIVE_REFUSED');
    const seed=job?.initialSeed, token=++generation;
    if (job?.state!=='QC_READY' || !seed?.qc?.passed || seed.status!=='READY' || !seed.preparation?.decoded || !seed.preparation?.activityReady || seed.parentClipId!==null || seed.provenance?.continuation!==false || seed.requestId!==job.requestId || seed.controlVersion!==job.controlVersion || !(rawAudio instanceof ArrayBuffer) || rawAudio.byteLength>8*1024*1024) fail('PUBLIC_INITIAL_QC_READY_REQUIRED');
    if (await sha(rawAudio)!==seed.provenance.rawSha256) fail('PUBLIC_INITIAL_SHA_MISMATCH');
    const decoded=await decodeAudio(rawAudio.slice(0));
    if (token!==generation || phase==='STOPPED') fail('PUBLIC_PREPARE_STOPPED');
    if (decoded.sampleRate!==RATE || decoded.numberOfChannels!==2 || decoded.length<16*RATE || decoded.length>30*RATE || Math.abs(decoded.length/RATE-seed.durationSeconds)>1/RATE) fail('PUBLIC_INITIAL_PCM_FORMAT');
    const pcm=new Float32Array(decoded.length*2), left=decoded.getChannelData(0), right=decoded.getChannelData(1); let sum=0, nonSilent=0;
    for (let i=0;i<decoded.length;i++) { const a=left[i],b=right[i]; if (!Number.isFinite(a)||!Number.isFinite(b)||Math.abs(a)>1||Math.abs(b)>1) fail('PUBLIC_INITIAL_PCM_INVALID'); pcm[i*2]=a;pcm[i*2+1]=b;sum+=a*a+b*b;if(Math.max(Math.abs(a),Math.abs(b))>.001)nonSilent++; }
    if (Math.sqrt(sum/pcm.length)<.003 || nonSilent/decoded.length<.1) fail('PUBLIC_INITIAL_ACTIVITY_HOLD');
    prepared={seed:structuredClone(seed), pcm};phase='MUSIC_READY';emit();return read();
  }
  function start() {
    if (startPromise) return startPromise;
    if (phase!=='READY' || !requestedVideo || readOtherAudioActive()) return Promise.reject(Error('PUBLIC_START_READY_EXCLUSIVE_REQUIRED'));
    // Context/resume happen in the explicit user gesture, before asynchronous module loading.
    phase='STARTING'; const token=generation; ctx=contextFactory(); const resume=ctx.resume(); emit();
    startPromise=(async()=>{
      try {
        if(ctx.sampleRate!==RATE) fail('PUBLIC_AUDIO_SAMPLE_RATE_REQUIRED');
        await ctx.audioWorklet.addModule(workletUrl); await resume;
        if(token!==generation || phase==='STOPPED') fail('PUBLIC_START_STOPPED');
        if(readOtherAudioActive())fail('PUBLIC_START_READY_EXCLUSIVE_REQUIRED');
        node=nodeFactory(ctx);gain=ctx.createGain();gain.gain.value=volume;node.connect(gain);gain.connect(ctx.destination);metrics.sourceCount++;
        const ack=new Promise((resolve,reject)=>{ackResolve=resolve;ackReject=reject;ackTimer=setTimeout(()=>reject(Error('PUBLIC_AUDIO_ACK_TIMEOUT')),ackTimeoutMs);});
        node.port.onmessage=event=>{
          if (token!==generation || phase==='STOPPED') return;
          if(event.data.error){metrics.errors.push(event.data.error);void stop('PUBLIC_WORKLET_FAILURE');return;}
          const t=event.data.telemetry;if(!t)return;
          if(t.sampleRate!==RATE || !Number.isInteger(t.consumedFrames) || t.consumedFrames<telemetry.consumedFrames || t.consumedFrames>prepared.pcm.length/2) { metrics.errors.push('PUBLIC_AUDIO_TELEMETRY_INVALID');void stop('PUBLIC_WORKLET_FAILURE');return; }
          telemetry={...t};
          if(t.consumedFrames>0 && !t.stopped && ctx.state==='running' && phase==='STARTING') {phase='PLAYING';activeClip=prepared.seed.clipId;metrics.commits.push({type:'AUDIO_START_ACK',clipId:activeClip,controlVersion:prepared.seed.controlVersion,playbackRevision:1,audioTime:t.consumedFrames/RATE});clearTimeout(ackTimer);ackResolve?.(read());ackResolve=ackReject=null;}
          if(phase==='PLAYING' && requestedVideo)video?.onBeat({index:++cueIndex,timeMs:t.consumedFrames/RATE*1000});
          emit();if(t.stopped)void stop('PUBLIC_DURATION_END');
        };
        const block=prepared.pcm.slice();node.port.postMessage({type:'set-duration',frames:block.length/2});node.port.postMessage({type:'chunk',startFrame:0,pcm:block.buffer},[block.buffer]);node.port.postMessage({type:'play'});
        return await ack;
      } catch (error) {metrics.errors.push(error.message);await stop('PUBLIC_START_FAILURE');throw error;}
    })();return startPromise;
  }
  async function stageVideo(clip) {
    if (phase==='STOPPED' || !prepared || clip?.status!=='READY' || !clip.qc?.passed || !clip.review?.accepted || clip.musicClipId!==prepared.seed.clipId || clip.controlVersion!==prepared.seed.controlVersion || !Number.isSafeInteger(clip.playbackRevision) || clip.playbackRevision<1 || requestedVideo && clip.playbackRevision<=requestedVideo.playbackRevision) fail('PUBLIC_VIDEO_READY_BINDING_REQUIRED');
    if(typeof videoAdapterFactory!=='function')fail('PUBLIC_VIDEO_ADAPTER_REQUIRED');
    const token=generation;
    video??=videoAdapterFactory({container,onState:s=>{
      if(token!==generation || phase==='STOPPED')return;
      if(s.phase==='playing' && s.activeClip?.jobId && s.activeClip.jobId!==presentedVideo) {presentedVideo=s.activeClip.jobId;metrics.presentations.push({type:'VIDEO_PRESENTED',jobId:presentedVideo,controlVersion:s.activeVersion,playbackRevision:s.activeRevision,audioTime:telemetry.consumedFrames/RATE});}
      if(['failed','timeout'].includes(s.phase))metrics.errors.push('PUBLIC_VIDEO_'+s.phase.toUpperCase());emit();
    }});
    const accepted=await video.stage({...clip,version:clip.controlVersion,source:'fal',pulseMode:'raw'});
    if(token!==generation || phase==='STOPPED')return false;
    if(accepted){requestedVideo=structuredClone(clip);if(phase==='MUSIC_READY')phase='READY';if(phase==='PLAYING')video.onBeat({index:++cueIndex,timeMs:telemetry.consumedFrames/RATE*1000});emit();}return accepted;
  }
  const onHide=()=>void stop('PAGE_HIDE');lifecycle?.addEventListener?.('pagehide',onHide,{once:true});
  return {prepareInitial,start,stageVideo,stop,read,setVolume(value){if(!Number.isFinite(value)||value<0||value>1)fail('PUBLIC_VOLUME_RANGE');volume=value;if(gain)gain.gain.value=value;},frameSource(){const bounds=container?.getBoundingClientRect?.()??{width:1280,height:720};return {mode:'public-browser-playback',width:1280,height:720,mediaFit:'contain',viewportWidth:bounds.width,viewportHeight:bounds.height,audioTime:telemetry.consumedFrames/RATE,version:prepared?.seed.controlVersion,clear:phase!=='PLAYING',layers:(video?.getPlaybackState().decks??[]).filter(d=>d.visible&&d.element.readyState>=2).map(d=>({source:d.element,opacity:Number(d.element.style.opacity)||0,z:d.index,transform:[1,0,0,1,0,0]}))};},dispose:async()=>{lifecycle?.removeEventListener?.('pagehide',onHide);await stop('DISPOSE');}};
}
