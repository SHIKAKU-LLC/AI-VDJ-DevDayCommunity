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
 const base={hold:paused,label:actor==='owner'&&paused?'生成再開まで保留して受付':actor==='owner'?'次のセットを生成':'音楽＋映像のアイデアを送る'};
 let reason=null;
 if(!state.connected||!state.room||!submitAvailable)reason='未接続';
 else if(state.room.status!=='OPEN')reason='ルーム終了';
 else if(['SENDING','UNKNOWN','PENDING'].includes(state.operation?.state))reason=state.operation.state==='UNKNOWN'?'送信結果不明・再送せず確認':state.operation.state==='PENDING'&&actor==='owner'&&paused?'受付済み・生成再開まで保留':'受付確認・準備待ち';
 else if(actor==='participant'&&state.room.accepting!==true)reason='参加者受付OFF';
 return {...base,disabled:reason!==null,reason};
}
export function completeSet(r,{allowDesign=false}={}){return ((r?.mode==='provider'&&r.actualGenerationThisRun===true)||(allowDesign&&r?.mode==='design'))&& r?.state==='READY'&&typeof r.cueId==='string'&&r.cueId.length>0&&r.atomicReady===true&&['music','video'].every(k=>r[k]?.status==='QC_READY'&&r[k].qcPassed===true&&Number.isFinite(r[k].durationSeconds)&&Math.abs(r[k].durationSeconds-24)<=.15&&r[k].generationId===r.generationId&&r[k].controlVersion===r.controlVersion)&&r.video.compositionQcPassed===true;}
export function createRoomUIModel({port=null,onChange=()=>{},uuid=()=>crypto.randomUUID(),now=()=>Date.now(),designOnly=false}={}){
 const listeners=new Set();let room=null,requests=new Map(),participant=null,operation=null,error=null,overlay=null,task=null,epoch=0,lastPlaybackRevision=-1,disposed=false;
 const read=()=>({connected:!!port,actor:port?.actor??'participant',room:room&&structuredClone(room),requests:[...requests.values()].map(v=>structuredClone(v)),participant:participant&&structuredClone(participant),operation:operation&&structuredClone(operation),error,overlay:overlay&&now()<overlay.until?structuredClone(overlay):null});
 const emit=()=>{if(!disposed){const value=read();onChange(value);for(const listener of listeners)listener(value);}};
 function snapshot(s){
  if(!s||!Number.isSafeInteger(s.revision)||s.revision<0||typeof s.roomId!=='string'||typeof s.roomEpoch!=='string')throw Error('ROOM_SNAPSHOT_INVALID');
  if(room&&room.roomId===s.roomId&&room.roomEpoch===s.roomEpoch&&s.revision<=room.revision)return false;
  if(room&&(s.roomId!==room.roomId||s.roomEpoch!==room.roomEpoch)){epoch++;participant=null;operation=null;overlay=null;lastPlaybackRevision=-1;}
  const previous=requests;room=structuredClone(s);requests=new Map((s.requests??[]).map(r=>{const prior=previous.get(r.requestId);return [r.requestId,prior?.state==='PLAYING'&&r.state==='READY'&&prior.cueId===r.cueId&&prior.generationId===r.generationId?{...structuredClone(r),state:'PLAYING',playbackRevision:prior.playbackRevision}:structuredClone(r)];}));if(room.status==='ENDED')overlay=null;const tracked=requests.get(operation?.requestId);if(tracked&&['READY','PLAYING','FAILED','CANCELLED','REJECTED'].includes(tracked.state))operation={...operation,state:tracked.state==='FAILED'?'FAILED':'COMPLETE'};error=null;emit();return true;
 }
 async function load(){if(!port?.readRoom){error='ROOM_API_NOT_CONNECTED';emit();return;}try{snapshot(await port.readRoom());}catch(e){error=e.code??e.message;emit();}}
 function submit(nickname,prompt){
  if(task)return task;
  if(!port?.submit||!room||room.status!=='OPEN'||(port.actor!=='owner'&&room.accepting!==true))return Promise.reject(Error('ROOM_NOT_ACCEPTING'));
  if(operation?.state==='UNKNOWN'||operation?.state==='PENDING')return Promise.reject(Error('REQUEST_ALREADY_PENDING'));
  const input=participantInput(nickname,prompt),nonce='room_'+uuid(),token=epoch,identity={roomId:room.roomId,roomEpoch:room.roomEpoch};
  error=null;operation={nonce,state:'SENDING'};emit();
  task=(async()=>{try{
   const receipt=await port.submit({...identity,...input,nonce,participantId:participant?.participantId??null});
   if(token!==epoch||disposed)return;
   if(receipt.roomId!==identity.roomId||receipt.roomEpoch!==identity.roomEpoch||receipt.nonce!==nonce||!receipt.requestId||!receipt.participantId)throw Error('REQUEST_RECEIPT_INVALID');
   participant={participantId:receipt.participantId,nickname:input.nickname};operation={nonce,state:'PENDING',requestId:receipt.requestId};emit();await load();return read();
  }catch(e){if(token===epoch&&!disposed){error=e.code??e.message;operation={nonce,state:e.definitive===true?'FAILED':'UNKNOWN'};emit();}throw e;}finally{task=null;}})();return task;
 }
 async function reconcile(){
  if(!port?.readOperation||!operation)return load();
  const token=epoch;
  try{const r=await port.readOperation(operation.nonce);if(token!==epoch||disposed)return;
   if(r.nonce!==operation.nonce||r.roomId!==room.roomId||r.roomEpoch!==room.roomEpoch)throw Error('REQUEST_RECEIPT_INVALID');
   if(r.snapshot){snapshot(r.snapshot);operation=null;}else if(r.requestId){operation={...operation,state:'PENDING',requestId:r.requestId};if(r.participantId)participant={participantId:r.participantId,nickname:r.nickname};}error=null;emit();await load();
  }catch(e){error=e.code??e.message;emit();}
 }
 async function ownerControl(action){
  if(!port?.ownerControl||!room||!['ACCEPT_ON','ACCEPT_OFF','GENERATION_STOP','GENERATION_RESUME'].includes(action))throw Error('OWNER_CONTROL_NOT_CONNECTED');
  if(task||operation?.state==='UNKNOWN')throw Error('CONTROL_PENDING');
  const token=epoch,nonce='control_'+uuid();operation={nonce,state:'SENDING',action};emit();
  task=(async()=>{try{const result=await port.ownerControl({roomId:room.roomId,roomEpoch:room.roomEpoch,expectedRevision:room.controlRevision??room.revision,action,nonce});if(token!==epoch||disposed)return;
   if(result.nonce!==nonce||result.snapshot?.roomId!==room.roomId||result.snapshot?.roomEpoch!==room.roomEpoch)throw Error('CONTROL_RECEIPT_INVALID');
   snapshot(result.snapshot);operation=null;emit();
  }catch(e){if(token===epoch&&!disposed){error=e.code??e.message;operation={nonce,state:e.definitive===true?'FAILED':'UNKNOWN',action};emit();}throw e;}finally{task=null;}})();return task;
 }
 function started(event){
  if(!room||room.status==='ENDED'||event?.type!=='cue.playback.started'||event.roomId!==room.roomId||event.roomEpoch!==room.roomEpoch||event.authoritative!==true||event.audioCommitted!==true||event.videoPresented!==true||!Number.isSafeInteger(event.playbackRevision)||event.playbackRevision<=lastPlaybackRevision)return false;
  const r=requests.get(event.requestId);
  if(!r||!['READY','PLAYING'].includes(r.state)||!completeSet({...r,state:'READY'},{allowDesign:designOnly})||r.cueId!==event.cueId||r.generationId!==event.generationId||r.controlVersion!==event.controlVersion)return false;
  lastPlaybackRevision=event.playbackRevision;requests.set(r.requestId,{...r,state:'PLAYING',playbackRevision:event.playbackRevision});
  // Attribution comes from the acknowledged request, never untrusted event-provided HTML.
  overlay={nickname:r.nickname,requestId:r.requestId,cueId:r.cueId,playbackRevision:event.playbackRevision,until:now()+6000};emit();return true;
 }
 function playbackEnded(event){if(!room||event?.type!=='cue.playback.ended'||event.authoritative!==true||event.roomId!==room.roomId||event.roomEpoch!==room.roomEpoch||event.playbackRevision!==lastPlaybackRevision)return false;for(const[id,r]of requests)if(r.state==='PLAYING'&&r.playbackRevision===event.playbackRevision)requests.set(id,{...r,state:'PLAYED'});overlay=null;emit();return true;}
 return {subscribe(fn){listeners.add(fn);fn(read());return ()=>listeners.delete(fn);},read,load,submit,reconcile,ownerControl,snapshot,started,playbackEnded,dispose(){disposed=true;epoch++;overlay=null;listeners.clear();}};
}
