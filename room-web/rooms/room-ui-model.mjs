// UI-only proposed room contract v1. No HTTP, providers, key storage or media creation.
export const LIMITS=Object.freeze({nickname:40,prompt:2000});
const length=s=>Array.from(s).length;
export function participantInput(nickname,prompt){
 const n=String(nickname??'').normalize('NFKC').trim(),p=String(prompt??'').normalize('NFKC').trim();
 if(!n||length(n)>LIMITS.nickname||/[\u0000-\u001f\u007f]/u.test(n))throw Error('NICKNAME_INVALID');
 if(!p||length(p)>LIMITS.prompt||/[\u0000-\u001f\u007f]/u.test(p))throw Error('PROMPT_INVALID');
 return {nickname:n,prompt:p};
}
// Actor here describes the already injected port; backend authentication remains authoritative.
export function composerAvailability(state,{actor='participant',submitAvailable=true}={}){
 const paused=state.room?.generationPaused===true;
 const collect=state.room?.mode==='collect';
 const base={hold:paused||collect,label:actor==='owner'&&collect?'アイデアを受付（生成未接続）':actor==='owner'&&paused?'生成再開まで保留して受付':actor==='owner'?'次のセットを生成':'音楽＋映像のアイデアを送る'};
 let reason=null;
 if(!state.connected||(!state.room&&!(actor==='participant'&&state.joinInfo?.accepting===true))||!submitAvailable)reason='未接続';
 else if(state.room&&state.room.status!=='OPEN')reason='ルーム終了';
 else if(['SENDING','UNKNOWN','PENDING'].includes(state.operation?.state))reason=state.operation.state==='UNKNOWN'?'送信結果不明・再送せず確認':state.operation.state==='PENDING'&&collect?'受付済み・生成API未接続':state.operation.state==='PENDING'&&actor==='owner'&&paused?'受付済み・生成再開まで保留':'受付確認・準備待ち';
 else if(actor==='participant'&&(state.room??state.joinInfo).accepting!==true)reason='参加者受付OFF';
 return {...base,disabled:reason!==null,reason};
}
export function completeSet(r,{allowDesign=false}={}){return ((r?.mode==='provider'&&r.actualGenerationThisRun===true)||(allowDesign&&r?.mode==='design'))&& r?.state==='READY'&&typeof r.cueId==='string'&&r.cueId.length>0&&r.atomicReady===true&&['music','video'].every(k=>r[k]?.status==='QC_READY'&&r[k].qcPassed===true&&Number.isFinite(r[k].durationSeconds)&&Math.abs(r[k].durationSeconds-24)<=.15&&r[k].generationId===r.generationId&&r[k].controlVersion===r.controlVersion)&&r.video.compositionQcPassed===true;}
export function createRoomUIModel({port=null,onChange=()=>{},uuid=()=>crypto.randomUUID(),now=()=>Date.now(),designOnly=false}={}){
 const listeners=new Set(),seenJobStates=new Set();let room=null,joinInfo=null,requests=new Map(),participant=null,operation=null,error=null,overlay=null,task=null,epoch=0,lastPlaybackRevision=-1,disposed=false;
 const read=()=>({connected:!!port,actor:port?.actor??'participant',joinInfo:joinInfo&&structuredClone(joinInfo),room:room&&structuredClone(room),requests:[...requests.values()].map(v=>structuredClone(v)),participant:participant&&structuredClone(participant),operation:operation&&structuredClone(operation),error,overlay:overlay&&now()<overlay.until?structuredClone(overlay):null});
 const emit=()=>{if(!disposed){const value=read();onChange(value);for(const listener of listeners)listener(value);}};
 function snapshot(s){
  if(!s||!Number.isSafeInteger(s.revision)||s.revision<0||typeof s.roomId!=='string'||typeof s.roomEpoch!=='string')throw Error('ROOM_SNAPSHOT_INVALID');
  const jobChanged=s.mode==='cloud'&&/^[a-f0-9]{64}$/.test(s.jobStateSha256??'')&&s.jobStateSha256!==room?.jobStateSha256&&!seenJobStates.has(s.jobStateSha256);
  if(room&&room.roomId===s.roomId&&room.roomEpoch===s.roomEpoch&&(s.revision<room.revision||s.revision===room.revision&&!jobChanged||room.status==='ENDED'&&s.status!=='ENDED'||s.controlRevision<room.controlRevision))return false;
  if(room&&(s.roomId!==room.roomId||s.roomEpoch!==room.roomEpoch)){epoch++;participant=null;operation=null;overlay=null;lastPlaybackRevision=-1;seenJobStates.clear();}
  if(s.mode==='cloud'&&jobChanged){seenJobStates.add(s.jobStateSha256);if(seenJobStates.size>256)seenJobStates.delete(seenJobStates.values().next().value);}
  const previous=requests;room=structuredClone(s);requests=new Map((s.requests??[]).map(r=>{const prior=previous.get(r.requestId);return [r.requestId,prior?.state==='PLAYING'&&r.state==='READY'&&prior.cueId===r.cueId&&prior.generationId===r.generationId&&
  !(Object.hasOwn(s,'currentCredit')&&s.currentCredit?.cueId!==r.cueId)?{...structuredClone(r),state:'PLAYING',playbackRevision:prior.playbackRevision}:structuredClone(r)];}));if(room.status==='ENDED'||room.mode==='collect')overlay=null;const tracked=requests.get(operation?.requestId);if(tracked&&['READY','PLAYING','FAILED','CANCELLED','REJECTED'].includes(tracked.state))operation={...operation,state:tracked.state==='FAILED'?'FAILED':'COMPLETE'};error=null;emit();return true;
 }
 async function load(){if(!port?.readRoom){error='ROOM_API_NOT_CONNECTED';emit();return;}try{const value=await port.readRoom();if(value.joinRequired){joinInfo=value.joinInfo;emit();return;}if(joinInfo&&value.roomId!==joinInfo.roomId)throw Error('ROOM_CONTEXT_CHANGED');snapshot(value);if(operation?.stage==='JOINING'){participant=port.participantInfo?.()??participant;operation=null;emit();}}catch(e){error=e.code??e.message;if(error==='ROOM_EXPIRED'||e.status===410){if(room&&room.status!=='ENDED'){room.status='ENDED';epoch++;}if(joinInfo)joinInfo={...joinInfo,accepting:false};overlay=null;}emit();}}
 function submit(nickname,prompt){
  if(task)return task;
  const joining=!room&&joinInfo?.accepting===true&&typeof port?.joinParticipant==='function';
  if(!port?.submit||(!room&&!joining)||(room&&(room.status!=='OPEN'||(port.actor!=='owner'&&room.accepting!==true))))return Promise.reject(Error('ROOM_NOT_ACCEPTING'));
  if(operation?.state==='UNKNOWN'||operation?.state==='PENDING')return Promise.reject(Error('REQUEST_ALREADY_PENDING'));
  const input=participantInput(nickname,prompt),nonce='room_'+uuid(),token=epoch;
  error=null;operation={nonce,state:'SENDING',stage:joining?'JOINING':'SUBMITTING'};emit();
  task=(async()=>{try{
   if(joining){const result=await port.joinParticipant(input.nickname);if(token!==epoch||disposed)return;if(result.snapshot?.roomId!==joinInfo.roomId||!result.participant?.participantId)throw Error('JOIN_RECEIPT_INVALID');snapshot(result.snapshot);participant=result.participant;operation={nonce,state:'SENDING',stage:'SUBMITTING'};emit();}
   const identity={roomId:room.roomId,roomEpoch:room.roomEpoch};
   const receipt=await port.submit({...identity,...input,nonce,participantId:participant?.participantId??null});
   if(token!==epoch||disposed)return;
   if(receipt.roomId!==identity.roomId||receipt.roomEpoch!==identity.roomEpoch||receipt.nonce!==nonce||!receipt.requestId||!receipt.participantId)throw Error('REQUEST_RECEIPT_INVALID');
   participant={participantId:receipt.participantId,nickname:input.nickname};operation={nonce,state:'PENDING',requestId:receipt.requestId};emit();await load();return read();
  }catch(e){if(token===epoch&&!disposed){error=e.code??e.message;operation={nonce,state:e.definitive===true?'FAILED':'UNKNOWN',stage:operation?.stage};emit();}throw e;}finally{task=null;}})();return task;
 }
 async function reconcile(){
  if(!port?.readOperation||!operation||operation.state==='FAILED'||operation.stage==='JOINING')return load();const token=epoch,op={...operation};
  try{const r=await port.readOperation(op.nonce);if(token!==epoch||disposed)return;
   if(r.nonce!==op.nonce||r.roomId!==room.roomId||r.roomEpoch!==room.roomEpoch)throw Error('REQUEST_RECEIPT_INVALID');
   if(op.action){if(r.kind!=='owner-control'||!r.snapshot||r.controlRevision!==op.expectedRevision+1||(!Number.isSafeInteger(r.snapshot.controlRevision)||r.snapshot.controlRevision<r.controlRevision))throw Error('CONTROL_RECEIPT_INVALID');snapshot(r.snapshot);operation=null;}
   else{if(r.kind!=='submission'||!r.requestId||!r.participantId)throw Error('REQUEST_RECEIPT_INVALID');operation={...op,state:'PENDING',requestId:r.requestId};participant={participantId:r.participantId,nickname:r.nickname};if(r.snapshot)snapshot(r.snapshot);}
   error=null;emit();if(!r.snapshot)await load();
  }catch(e){error=e.code??e.message;emit();}
 }
 async function ownerControl(action){
  if(!port?.ownerControl||!room||room.status!=='OPEN'||!['ACCEPT_ON','ACCEPT_OFF','GENERATION_STOP','GENERATION_RESUME'].includes(action))throw Error('OWNER_CONTROL_NOT_CONNECTED');
  if(task||operation?.state==='UNKNOWN')throw Error('CONTROL_PENDING');
  if(room.mode==='collect'&&action==='GENERATION_RESUME')throw Error('COLLECT_ONLY_GENERATION_DISABLED');
  if(!Number.isSafeInteger(room.controlRevision)||room.controlRevision<0)throw Error('CONTROL_REVISION_UNAVAILABLE');
  const token=epoch,nonce='control_'+uuid(),expectedRevision=room.controlRevision;operation={nonce,state:'SENDING',action,expectedRevision};emit();
  task=(async()=>{try{const result=await port.ownerControl({roomId:room.roomId,roomEpoch:room.roomEpoch,expectedRevision,action,nonce});if(token!==epoch||disposed)return;
   if(result.kind!=='owner-control'||result.controlRevision!==expectedRevision+1||(!Number.isSafeInteger(result.snapshot?.controlRevision)||result.snapshot.controlRevision<result.controlRevision)||result.nonce!==nonce||result.snapshot?.roomId!==room.roomId||result.snapshot?.roomEpoch!==room.roomEpoch)throw Error('CONTROL_RECEIPT_INVALID');
   snapshot(result.snapshot);operation=null;emit();
  }catch(e){if(token===epoch&&!disposed){error=e.code??e.message;operation={nonce,state:e.definitive===true?'FAILED':'UNKNOWN',action,expectedRevision};emit();}throw e;}finally{task=null;}})();return task;
 }
 function started(event){
  if(!room||room.status==='ENDED'||room.mode==='collect'||event?.type!=='cue.playback.started'||event.roomId!==room.roomId||event.roomEpoch!==room.roomEpoch||event.authoritative!==true||event.audioCommitted!==true||event.videoPresented!==true||!Number.isSafeInteger(event.playbackRevision)||event.playbackRevision<=lastPlaybackRevision)return false;
  const r=requests.get(event.requestId);
  if(!r||!['READY','PLAYING'].includes(r.state)||!completeSet({...r,state:'READY'},{allowDesign:designOnly})||r.cueId!==event.cueId||r.generationId!==event.generationId||r.controlVersion!==event.controlVersion)return false;
  lastPlaybackRevision=event.playbackRevision;requests.set(r.requestId,{...r,state:'PLAYING',playbackRevision:event.playbackRevision});
  // Attribution comes from the acknowledged request, never untrusted event-provided HTML.
  overlay={nickname:r.nickname,requestId:r.requestId,cueId:r.cueId,playbackRevision:event.playbackRevision,until:now()+6000};emit();return true;
 }
 function playbackEnded(event){if(!room||event?.type!=='cue.playback.ended'||event.authoritative!==true||event.roomId!==room.roomId||event.roomEpoch!==room.roomEpoch||event.playbackRevision!==lastPlaybackRevision)return false;for(const[id,r]of requests)if(r.state==='PLAYING'&&r.playbackRevision===event.playbackRevision)requests.set(id,{...r,state:'PLAYED'});overlay=null;emit();return true;}
 return {subscribe(fn){listeners.add(fn);fn(read());return ()=>listeners.delete(fn);},read,load,submit,reconcile,ownerControl,snapshot,started,playbackEnded,dispose(){disposed=true;epoch++;overlay=null;listeners.clear();}};
}
