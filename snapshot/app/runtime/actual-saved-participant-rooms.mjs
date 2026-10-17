import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createParticipantRooms,RoomError} from './participant-rooms.mjs';
import {createParticipantRoomRoutes} from './participant-room-routes.mjs';
import {loadVerifiedSavedRoomMedia} from './verified-saved-room-media.mjs';
import {evaluateTransition,selectBestTransition} from './dj-transition-selector.mjs';

import {loadCrossRecordingRoomMedia} from './cross-recording-room-media.mjs';
import {loadReviewedRoomMedia} from './reviewed-room-media.mjs';
import {loadSharedPCMRoomMedia} from './shared-pcm-room-media.mjs';
import {createDJPorts} from './dj-transition-ports.mjs';
import {savedContextSha} from './saved-room-media.mjs';
import {playbackCurrent,verifyRenderedRoomPlayback,pcmSha} from './rendered-room-playback.mjs';
const RATE=44100,CUE=24*RATE,sha=x=>createHash('sha256').update(x).digest('hex');

export async function createActualSavedParticipantRooms({out,root,otherAudioActive=()=>false,publicBaseUrl='http://127.0.0.1:8772',crossTrackReview=false,allowMeasuredAudition=false,sharedPCMBridge=false,reviewedConnection=false,resolveMotifSnapshot}){
  if(typeof resolveMotifSnapshot!=='function')throw Error('LOCAL_MOTIF_RESOLVER_REQUIRED');
  let media=await loadVerifiedSavedRoomMedia({directory:path.join(root,'app/connection/actual-room-20261013'),videoPath:path.join(root,'vnext/eye-montage-24/runtime/montage-raw-24.mp4')});
  if(reviewedConnection&&sharedPCMBridge)throw Error('EXCLUSIVE_SAVED_MODE_REQUIRED');
  const reviewed=reviewedConnection?await loadReviewedRoomMedia({directory:path.join(root,'app/connection/reviewed-join-20261013/media')}):null;
  const shared=sharedPCMBridge?await loadSharedPCMRoomMedia({directory:path.join(root,'app/connection/feature-planning-20261013/shared-media')}):null;
  if(shared||reviewed){const selected=reviewed??shared;media={...media,audio:selected.current,fallbackAudio:selected.fallbackAudio};}
  const cross=reviewed??shared??(crossTrackReview?await loadCrossRecordingRoomMedia({directory:path.join(root,'app/connection/cross-track-20261013/run-02'),currentSha256:media.audio.sha256}):null);
  const djPorts=cross?createDJPorts({mode:'saved',loadReceipts:cross.loadReceipts}):null,assignments=new Map();let nextRecording=0;
  const sources=new Map(),owners=new Map(),leases=new Map(),motif=resolveMotifSnapshot('eye-lattice');let activeHost=null;
  const directory=path.join(out,'participant-rooms');await fsp.mkdir(directory,{recursive:true,mode:0o700});
  const initialSource=()=>({music:{clipId:'saved-room-seed',sha256:media.audio.sha256,profile:media.audio.profile,sourceLineage:media.audio.sourceLineage,ready:true,contextVerified:true,contextSeconds:16,contextSha256:media.audio.contextSha256,control:{version:1,world:'psytrance-restrained',prompt:reviewed?'Existing prepared A; exact user-reviewed join only; no new generation':'Existing verified contiguous saved source; no new generation',energy:.4,tension:.3,density:.3,brightness:.45}},video:{motifId:'eye-lattice',motifSnapshotSha256:motif.snapshotSha256,referenceSha256:motif.reference.sha256,world:motif.world},quality:{fixedBpm:145,tempoConfidence:'assumed',keyConfidence:'unknown'},playback:{phase:'IDLE',revision:0,playedUntilFrame:0}});
  function readSource(id){const s=structuredClone(sources.get(id)??initialSource()),h=leases.get(id);if(h){s.playback.phase=h.phase==='STOPPED'?'STOPPED':h.phase==='RUNNING'?'RUNNING':'IDLE';s.playback.playedUntilFrame=Math.max(0,h.receivedFrames-h.currentStartFrame);const p=h.schedule;if(p&&h.receivedFrames>p.geometry.editStartFrame&&h.consumedFrames<p.geometry.incomingOnlyFrame){s.playback.phase='TRANSITIONING';s.playback.renderedSha256=p.record.audio.sha256;s.music.ready=false;s.music.contextVerified=false;}}return s;}
  const video=(id,h,assetId,revision)=>({url:`/api/rooms/${id}/host/video/${assetId}?lease=${h.leaseValue}`,version:0,originalSourceVersion:0,source:'local-edit',requestId:media.video.sourceRequestId,playbackRevision:revision,durationSeconds:24,pulseMode:'raw',assetId,jobId:assetId,sha256:media.video.sha256});
  function recordFor(plan){return cross?cross.renders.get(plan.transition.renderedSha256):{audio:media.pairAudio,receipt:media.pairReceipt,incoming:media.incomingAudio};}
  function queueRendered(h,{cue,plan,record,expectedRevision,guard,resolve=null,reject=null,manualAudition=false,nonce=null}){
    if(h.phase!=='RUNNING'||h.pending||h.schedule)throw new RoomError('ROOM_HOST_NOT_PLAYING');
    const proof=verifyRenderedRoomPlayback({current:playbackCurrent(readSource(h.roomId)),candidate:cue,record,currentAudio:media.audio,manualAudition,plan:manualAudition?null:plan});
    if(!proof.valid)throw new RoomError(proof.reason);
    const commandId='commit-'+randomUUID(),ackNonce=randomBytes(24).toString('base64url');
    h.pending={commandId,ackNonce,cue,plan,expectedRevision,guard,resolve,reject,record,manualAudition,nonce,geometry:proof.geometry,startFrame:null,videoReady:false};
    h.command={commandId,ackNonce,roomId:h.roomId,cueId:cue.cueId,generationId:cue.generationId,expectedRevision,controlVersion:cue.controlVersion,audioAssetSha256:cue.music.asset.sha256,renderedSha256:record.audio.sha256,renderedPcmSha256:proof.pcmSha256,videoAssetSha256:media.video.sha256,startFrame:null,editStartFrame:proof.geometry.editStartFrame,incomingOnlyFrame:proof.geometry.incomingOnlyFrame,durationFrames:proof.geometry.durationFrames,overlapFrames:plan.transition.overlapFrames,manualAudition,automaticDJEligible:!manualAudition,video:video(h.roomId,h,cue.video.asset.assetId,expectedRevision+1),musicalEvidenceScope:plan.evidenceScope??null,sourceMode:manualAudition?'manual-measured-render-audition':reviewed?'user-reviewed-independent-join':shared?'exact-shared-pcm-bridge':cross?'verified-cross-recording-render':'verified-contiguous-saved-media',actualGenerationThisRun:false};
    return h.command;
  }
  function adoptSource(h,p){
    const a=p.record.incoming,src=sources.get(h.roomId);
    src.music={...src.music,clipId:p.cue.music.asset.assetId,sha256:a.sha256,profile:a.profile,sourceLineage:a.sourceLineage,contextSha256:savedContextSha(a),control:{...src.music.control,version:p.cue.controlVersion}};
    src.playback.revision=p.expectedRevision;h.currentStartFrame=p.geometry.currentSourceOriginFrame;h.sourceAdopted=true;
  }
  async function commitPlayback({roomId,cue,plan,expectedRevision,guard}){
    const h=leases.get(roomId);
    if(!plan.offlineSaved||!plan.qualityReady||!plan.transition.renderVerified)throw new RoomError('ACTUAL_SAVED_RENDER_REQUIRED');
    if(!h||h.phase!=='RUNNING'||h.pending||h.schedule||!await guard())throw new RoomError('ROOM_HOST_NOT_PLAYING');
    let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});
    queueRendered(h,{cue,plan,record:recordFor(plan),expectedRevision,guard,resolve,reject});
    return promise;
  }
  const core=createParticipantRooms({mode:'fixture',supplyPolicy:{overlapSeconds:0},publicBaseUrl,
    persist:async r=>{const file=path.join(directory,r.roomId+'.json'),temp=file+'.'+randomUUID()+'.tmp';await fsp.writeFile(temp,JSON.stringify(r),{flag:'wx',mode:0o600});await fsp.rename(temp,file);},readSource,commitPlayback,
    evaluatePlan:djPorts?.evaluatePlan??(input=>evaluateTransition({...input,mode:'saved'})),selectPlan:selectBestTransition,
    inspectJoin:djPorts?.inspectJoin??(async({current,candidate})=>current.sha256===media.audio.sha256&&candidate.music.asset.sha256===media.incomingAudio.sha256?{...structuredClone(media.pairReceipt),currentPlaybackRevision:current.playbackRevision}:null),
    generateMedia:async(channel,s,{signal,guard})=>{
      if(signal.aborted||!guard())throw new RoomError('GENERATION_STOPPED');
      const audio=channel==='music';
      if(cross&&!assignments.has(s.binding.generationId))assignments.set(s.binding.generationId,cross.incoming[nextRecording++%cross.incoming.length]);
      const a=cross?assignments.get(s.binding.generationId):media.incomingAudio;
      if(cross&&audio&&(a.profile.activity.effectiveSilence||a.profile.activity.maxQuietRunSeconds>.15||a.profile.activity.minimumWindowDbfs < -45||a.profile.loudness.truePeakDbtp>-.3))throw new RoomError('CROSS_TRACK_SOURCE_QC_HOLD');
      if(cross)return {binding:s.binding,status:'QC_READY',durationSeconds:24,qc:audio?{passed:true,scope:'actual24s-saved-cross-recording-SHA-PCM-activity-loudness',truePeakDbtp:a.profile.loudness.truePeakDbtp}:media.video.qc,compositionQC:audio?null:media.video.compositionQC,asset:{assetId:s.binding.generationId+'-'+channel,sha256:audio?a.sha256:media.video.sha256,mute:!audio,pulseMode:'raw'},profile:audio?a.profile:undefined,parentClipId:null,contextSha256:null,contextVerified:false,savedContinuityVerified:false,continuationVerified:false,fixtureBinding:false,actualGenerationThisRun:false,originalProvenance:audio?a.provenance:{kind:'existing-editorial24s',requestedIntentRendered:false}};
      return{binding:s.binding,status:'QC_READY',durationSeconds:24,qc:audio?{passed:true,scope:'actual24s-saved-range-SHA-PCM-activity-loudness',truePeakDbtp:a.profile.loudness.truePeakDbtp}:media.video.qc,compositionQC:audio?null:media.video.compositionQC,asset:{assetId:s.binding.generationId+'-'+channel,sha256:audio?a.sha256:media.video.sha256,mute:!audio,pulseMode:'raw'},profile:audio?a.profile:undefined,sourceLineage:audio?a.sourceLineage:undefined,parentClipId:audio?s.sourceSnapshot.music.clipId:null,contextSha256:audio?s.sourceSnapshot.music.contextSha256:null,contextVerified:audio,savedContinuityVerified:audio,continuationVerified:false,fixtureBinding:false,actualGenerationThisRun:false,originalProvenance:{...media.sourceProvenance,requestedIntentRendered:false}};
    }});
  await core.ready;
  const service={...core,async state(...args){const s=await core.state(...args);if(shared||reviewed){const collection=reviewed??shared,r=collection.receipts[0],selected=s.decision?.plans?.find(p=>p.cueId===s.decision.selectedCueId&&p.status==='ELIGIBLE'),net=selected?.transition.netIncomingSeconds??Math.min(...collection.receipts.map(x=>(x.incomingFrameCount-x.entryFrame-x.overlapFrames/2)/RATE));s.supply={...s.supply,method:reviewed?'finite-user-reviewed-join-only':'finite-shared-branch-only',netSeconds:net,initialBufferSeconds:net*s.policy.initialBufferCues,discardedIncomingPrefixSeconds:r.entryFrame/RATE,bufferMeaning:'configured target; not actual available inventory',continuousPlaybackGuaranteed:false,requiredInitialCues:null,meaning:'Actual retained incoming duration, not a repeated24s extension; no ongoing generation guarantee'};}return s;},async create(input){const r=await core.create(input);sources.set(r.roomId,initialSource());owners.set(r.roomId,r.ownerToken);return r;}};
  const routes=createParticipantRoomRoutes({service,authenticateOwner:async()=>otherAudioActive()?null:'local-loopback-operator',origin:req=>'http://'+req.headers.host});
  const hostOf=(id,req,query=false)=>{const h=leases.get(id),leaseValue=query?new URL(req.url,'http://localhost').searchParams.get('lease'):req.headers['x-room-host'];if(!h||h.phase==='STOPPED'||typeof leaseValue!=='string'||sha(leaseValue)!==h.proof)throw new RoomError('ROOM_HOST_LEASE_REQUIRED',403);return h;};
  async function stopHost(h,reason){if(h.phase==='STOPPED')return;h.phase='STOPPED';h.schedule=null;if(h.pending){h.pending.reject?.(new RoomError('ROOM_HOST_STOPPED'));h.pending=null;}if(activeHost===h)activeHost=null;await service.playbackEnded(h.roomId,{ownerToken:owners.get(h.roomId)},reason).catch(()=>{});}
  const staticFiles=new Map([['/room-host.mjs','app/room-host.mjs'],['/room-harness.html','app/room-harness.html'],['/room-harness.mjs','app/room-harness.mjs'],['/room-worklet.mjs','app/room-worklet.mjs']]);
  async function handle(req,res){
    const url=new URL(req.url,'http://localhost'),route=url.pathname,json=(n,v)=>{if(!res.destroyed)res.writeHead(n,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(v));};
    if(staticFiles.has(route)){if(!['GET','HEAD'].includes(req.method)){json(405,{code:'READ_ONLY'});return true;}const file=path.join(root,staticFiles.get(route));res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':'text/javascript','Cache-Control':'no-store'});if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);return true;}
    const m=route.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,100})\/host\/(claim|command|video-ready|audio|tick|ack|stop|video|audition-options|audition|final-proof)(?:\/([A-Za-z0-9_-]{1,100}))?$/);
    if(!m)return routes(req,res);const[,id,op,assetId]=m;
    try{
      if(req.method==='POST'&&req.headers.origin!=='http://'+req.headers.host)throw new RoomError('ROOM_SAME_ORIGIN_REQUIRED',403);
      const body=async()=>{let text='',size=0;for await(const c of req){size+=c.length;if(size>16384)throw new RoomError('ROOM_BODY_LIMIT',413);text+=c;}let v;try{v=JSON.parse(text||'{}');}catch{throw new RoomError('ROOM_INVALID_JSON',400);}if(!v||typeof v!=='object'||Array.isArray(v))throw new RoomError('ROOM_INVALID_JSON',400);return v;};
      if(op==='video'&&['GET','HEAD'].includes(req.method)){
        const h=hostOf(id,req,true);if(assetId!=='seed-video'&&assetId!==h.command?.video.assetId&&assetId!==h.lastAck?.videoAssetId)throw new RoomError('ROOM_VIDEO_ASSET_REQUIRED',404);
        const size=fs.statSync(media.video.path).size;let a=0,b=size-1,status=200;
        if(req.headers.range){const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!range)throw new RoomError('INVALID_RANGE',416);a=Number(range[1]);b=range[2]?Math.min(b,Number(range[2])):b;if(a>b||a>=size)throw new RoomError('INVALID_RANGE',416);status=206;res.setHeader('Content-Range',`bytes ${a}-${b}/${size}`);}
        res.writeHead(status,{'Content-Type':'video/mp4','Cache-Control':'no-store','Accept-Ranges':'bytes','Content-Length':b-a+1});if(req.method==='HEAD')res.end();else fs.createReadStream(media.video.path,{start:a,end:b}).pipe(res);return true;
      }
      await service.state(id,{ownerToken:req.headers['x-room-owner']});
      if(op==='claim'&&req.method==='POST'){
        const b=await body();if(otherAudioActive()||activeHost&&activeHost.phase!=='STOPPED')throw new RoomError('ONE_AUDIO_HOST_REQUIRED');const requested=b.durationSeconds??48;if(!Number.isInteger(requested)||requested<24||requested>180)throw new RoomError('FINITE_ROOM_DURATION_REQUIRED',400);
        const leaseValue=randomBytes(32).toString('base64url'),h={roomId:id,leaseValue,proof:sha(leaseValue),phase:'PREPARING',createdAtMs:Date.now(),lastTickAtMs:Date.now(),receivedFrames:0,consumedFrames:0,currentStartFrame:0,durationFrames:Math.min(requested,48)*RATE,pending:null,schedule:null,command:null,lastAck:null,auditionOperations:new Map(),finalProof:null};leases.set(id,h);activeHost=h;
        json(200,{roomId:id,hostToken:leaseValue,sampleRate:RATE,durationFrames:h.durationFrames,requestedDurationSeconds:requested,boundedBySavedMaterial:true,initialClipId:'saved-room-seed',initialPlaybackRevision:0,initialVideo:video(id,h,'seed-video',1),workletUrl:'/room-worklet.mjs',audioOutputGain:1,requirePlayedWindow:true,requireFullRenderedProof:!!cross,measuredAuditionAvailable:!!cross&&allowMeasuredAudition,audioRoute:`/api/rooms/${id}/host/audio`,sourceMode:reviewed?'user-reviewed-independent-join':shared?'exact-shared-PCM-branch-switch':cross?allowMeasuredAudition?'manual-audition-automatic-DJ-HOLD':'cross-recording-review-with-safe-fallback':'verified-contiguous-saved-media',meaning:reviewed?'Automatic exact user-reviewed saved join; unknown global key/phrase retained':shared?'Automatic saved branch switch inside identical PCM; not independent-song mixing':cross?allowMeasuredAudition?'Finite owner audition of measured render; automatic DJ musical QA stays HOLD; no participant credit':'Distinct saved recordings evaluated; unverified musical QA stays HOLD; finite measured fallback only':'Actual saved24s+24s source-contiguous render; no new generation'});return true;
      }
      const h=hostOf(id,req);
      if(op==='audition-options'&&req.method==='GET'){
        const state=await service.state(id,{ownerToken:owners.get(id)}),current=playbackCurrent(readSource(id)),choices=[];
        if(cross&&allowMeasuredAudition&&h.phase==='RUNNING'&&!h.schedule&&!h.pending)for(const cue of state.cues.filter(c=>c.status==='READY'))for(const record of cross.renders.values()){
          if(record.incoming.sha256!==cue.music.asset.sha256)continue;
          const proof=verifyRenderedRoomPlayback({current,candidate:cue,record,currentAudio:media.audio,manualAudition:true});
          if(proof.valid)choices.push({cueId:cue.cueId,renderedSha256:record.audio.sha256,name:record.name,overlapSeconds:record.receipt.overlapFrames/RATE,durationSeconds:record.audio.frames/RATE,currentPlaybackRevision:current.playbackRevision,automaticDJEligible:false,heldReasons:proof.plan.reasons});
        }
        json(200,{available:!!cross&&allowMeasuredAudition,choices,automaticDJEligible:false});return true;
      }
      if(op==='audition'&&req.method==='POST'){
        const b=await body();if(!cross||!allowMeasuredAudition)throw new RoomError('MANUAL_MEASURED_AUDITION_DISABLED');
        if(Object.keys(b).some(k=>!['cueId','renderedSha256','currentPlaybackRevision','nonce'].includes(k))||! /^[A-Za-z0-9_-]{20,100}$/.test(b.nonce??''))throw new RoomError('AUDITION_REQUEST_REQUIRED',400);
        const signature=sha(JSON.stringify({cueId:b.cueId,renderedSha256:b.renderedSha256,currentPlaybackRevision:b.currentPlaybackRevision})),old=h.auditionOperations.get(b.nonce);
        if(old){if(old.signature!==signature)throw new RoomError('AUDITION_NONCE_CONFLICT');json(200,{...old.command,idempotent:true});return true;}
        if(h.phase!=='RUNNING'||h.pending||h.schedule)throw new RoomError('ROOM_HOST_NOT_PLAYING');
        const current=playbackCurrent(readSource(id));if(current.playbackRevision!==b.currentPlaybackRevision)throw new RoomError('AUDITION_SOURCE_REVISION_CHANGED');
        const state=await service.state(id,{ownerToken:owners.get(id)}),cue=state.cues.find(c=>c.cueId===b.cueId&&c.status==='READY'),record=cross.renders.get(b.renderedSha256);
        if(!cue||record?.incoming.sha256!==cue.music.asset.sha256)throw new RoomError('AUDITION_CUE_RENDER_BINDING_REQUIRED');
        const proof=verifyRenderedRoomPlayback({current,candidate:cue,record,currentAudio:media.audio,manualAudition:true});if(!proof.valid)throw new RoomError(proof.reason);
        const guard=async()=>h.phase==='RUNNING'&&(await service.state(id,{ownerToken:owners.get(id)})).cues.some(c=>c.cueId===cue.cueId&&c.status==='READY'&&c.music.asset.sha256===cue.music.asset.sha256)&&playbackCurrent(readSource(id)).playbackRevision===current.playbackRevision&&verifyRenderedRoomPlayback({current:playbackCurrent(readSource(id)),candidate:cue,record,currentAudio:media.audio,manualAudition:true}).valid;
        const duplicate=h.auditionOperations.get(b.nonce);if(duplicate){if(duplicate.signature!==signature)throw new RoomError('AUDITION_NONCE_CONFLICT');json(200,{...duplicate.command,idempotent:true});return true;}
        const command=queueRendered(h,{cue,plan:proof.plan,record,expectedRevision:current.playbackRevision+1,guard,manualAudition:true,nonce:b.nonce});h.auditionOperations.set(b.nonce,{signature,command:structuredClone(command)});json(200,command);return true;
      }
      if(op==='command'&&req.method==='GET'){const s=readSource(id);json(200,{command:h.pending?h.command:null,phase:h.phase,source:{phase:s.playback.phase,sha256:s.music.sha256,playbackRevision:s.playback.revision,ready:s.music.ready,contextVerified:s.music.contextVerified,renderedSha256:s.playback.renderedSha256??null},actualGenerationThisRun:false});return true;}
      if(op==='audio'&&req.method==='GET'){
        const start=Number(url.searchParams.get('startFrame')),frames=Number(url.searchParams.get('frames'));
        if(!Number.isInteger(start)||start!==h.receivedFrames||!Number.isInteger(frames)||frames<1||frames>3*RATE||start+frames>h.durationFrames||start-h.consumedFrames>6*RATE)throw new RoomError('ROOM_CONTIGUOUS_FINITE_PCM_REQUIRED');
        const source=h.schedule?h.schedule.record.audio:media.fallbackAudio,p=source.pcm.slice(start*2,(start+frames)*2);if(p.length!==frames*2)throw new RoomError('FINITE_SAVED_RENDER_EXHAUSTED');h.receivedFrames+=frames;
        res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Start-Frame':start,'X-Audio-Frames':frames,'X-PCM-Sha256':sha(Buffer.from(p.buffer))}).end(Buffer.from(p.buffer));return true;
      }
      if(req.method!=='POST')throw new RoomError('ROOM_METHOD_NOT_ALLOWED',405);const b=await body();
      if(op==='tick'){
        if(b.sourceCount!==1||b.contextState!=='running'||b.sampleRate!==RATE||!Number.isInteger(b.consumedFrames)||b.consumedFrames<h.consumedFrames||b.consumedFrames>h.receivedFrames||b.underrunFrames!==0||b.consumedFrames/RATE>(Date.now()-h.createdAtMs)/1000+3)throw new RoomError('ROOM_ACTUAL_WORKLET_CLOCK_REQUIRED');h.consumedFrames=b.consumedFrames;h.lastTickAtMs=Date.now();h.phase='RUNNING';if(h.schedule&&!h.sourceAdopted&&h.consumedFrames>=h.schedule.geometry.incomingOnlyFrame)adoptSource(h,h.schedule);json(200,{phase:h.phase,consumedFrames:h.consumedFrames});queueMicrotask(()=>void service.djTick(id,{ownerToken:owners.get(id)}).catch(()=>{}));return true;
      }
      if(op==='video-ready'){
        const p=h.pending;if(!p||b.commandId!==p.commandId||b.assetSha256!==media.video.sha256||b.decoded!==true||!await p.guard()||h.receivedFrames>p.geometry.editStartFrame-441)throw new RoomError('ROOM_VIDEO_READY_BINDING_REQUIRED');
        // Bind edit frontier, blend center, handoff and exact finite render end.
        const start=p.geometry.startFrame,end=p.geometry.durationFrames;if(start+256>=end||end>h.durationFrames)throw new RoomError('ROOM_FINITE_COMMIT_WINDOW_EXHAUSTED');
        p.startFrame=start;p.videoReady=true;h.durationFrames=end;h.schedule=p;h.command.startFrame=start;
        p.windowSha256=sha(Buffer.from(p.record.audio.pcm.buffer,p.record.audio.pcm.byteOffset+start*8,256*8));h.command.expectedPlayedWindowSha256=p.windowSha256;json(200,h.command);return true;
      }
      if(op==='ack'){
        if(h.lastAck?.commandId===b.commandId){json(200,{acknowledged:true,idempotent:true});return true;}
        const p=h.pending;
        if(!p||b.commandId!==p.commandId||b.ackNonce!==p.ackNonce||p.startFrame===null||!p.videoReady||h.phase!=='RUNNING'||h.consumedFrames<p.startFrame+256||b.playedWindowStartFrame!==p.startFrame||b.playedWindowSha256!==p.windowSha256||b.sourceCount!==1||b.audioStarted!==true||b.videoPresented!==true||b.videoAssetId!==p.cue.video.asset.assetId||b.videoPlaybackRevision!==p.expectedRevision+1||b.playbackRevision!==p.expectedRevision)throw new RoomError('ROOM_AUDIO_VIDEO_PLAYBACK_ACK_REQUIRED');
        if(!h.sourceAdopted&&h.consumedFrames>=p.geometry.incomingOnlyFrame)adoptSource(h,p);
        h.lastAck={commandId:p.commandId,startFrame:p.startFrame,videoAssetId:p.cue.video.asset.assetId,playedWindowSha256:p.windowSha256};h.pending=null;
        p.resolve?.({roomId:id,cueId:p.cue.cueId,clipId:p.cue.music.asset.assetId,playbackRevision:p.expectedRevision,audioTime:h.consumedFrames/RATE,actual:true,savedMaterial:true,audioStarted:true,videoPresented:true,simulated:false});
        json(200,{acknowledged:true,actualPlayback:true,manualAudition:p.manualAudition,automaticDJEligible:!p.manualAudition,...(p.manualAudition?{participantCreditAwarded:false}:{}),...(shared?{musicalEvidenceScope:'EXACT_SHARED_PASSAGE_NOT_INDEPENDENT_MIX',independentSongMixVerified:false}:{}),...(reviewed?{musicalEvidenceScope:'EXACT_USER_REVIEWED_TRANSITION',independentSongMixVerified:true,generalIndependentMixingVerified:false,reviewSourceMessageId:p.plan.reviewedTransition.feedback.sourceMessageId,reviewedVariant:p.plan.reviewedTransition.variantLabel}:{}),actualGenerationThisRun:false,playedWindowVerified:true,renderedSha256:p.record.audio.sha256});return true;
      }
      if(op==='final-proof'){
        const audio=h.schedule?.record.audio??media.fallbackAudio,expected=pcmSha(audio.pcm.subarray(0,h.durationFrames*2));
        if(!cross||h.phase!=='RUNNING'||b.frames!==h.durationFrames||h.receivedFrames!==h.durationFrames||b.sha256!==expected||b.sourceCount!==1||b.underrunFrames!==0||b.frames/RATE>(Date.now()-h.createdAtMs)/1000+3||h.schedule&&h.lastAck?.commandId!==h.schedule.commandId)throw new RoomError('FULL_PROCESSED_RENDER_PROOF_REQUIRED');
        const idempotent=!!h.finalProof;h.finalProof={frames:b.frames,sha256:b.sha256,renderedSha256:audio.sha256,manualAudition:h.schedule?.manualAudition??false};json(200,{...h.finalProof,fullProcessedRenderVerified:true,idempotent});return true;
      }
      if(op==='stop'){await stopHost(h,'OWNER_TRANSPORT_STOP');json(200,{phase:'STOPPED',currentCreditCleared:true});return true;}
      throw new RoomError('ROOM_HOST_ROUTE_REQUIRED',404);
    }catch(e){json(e instanceof RoomError?e.status:503,{code:e instanceof RoomError?e.code:'ROOM_HOST_HOLD',actualGenerationThisRun:false,actualAPIRequests:0});return true;}
  }
  const watchdog=setInterval(()=>{if(activeHost&&Date.now()-activeHost.lastTickAtMs>8000)void stopHost(activeHost,'HOST_CLOCK_DISCONNECTED');},1000);watchdog.unref();
  return {available:true,service,handle,media,hasHost:()=>!!activeHost&&activeHost.phase!=='STOPPED',async close(){clearInterval(watchdog);if(activeHost)await stopHost(activeHost,'SERVER_CLOSE');await service.close();}};
}
