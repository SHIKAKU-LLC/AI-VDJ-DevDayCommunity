// Authenticated HTTP-to-view bridge. No guessed nonce association and no automatic POST retry.
import {roomView} from './room-contract-view.mjs';
export function createRoomModelPort({client,owner=false}={}){
 let latest=null,joined=null;
 const record=raw=>{latest=raw;return roomView(raw);};
 function receipt(raw,nonce){
  if(!latest||raw?.roomId!==latest.roomId||!raw.submissionId||!raw.participantId||(!owner&&raw.participantId!==joined?.participantId))throw Error('SUBMISSION_RECEIPT_INVALID');
  return {kind:'submission',roomId:raw.roomId,roomEpoch:latest.sessionId,nonce,requestId:raw.submissionId,participantId:raw.participantId,nickname:raw.nickname};
 }
 function controlReceipt(raw,nonce){if(!owner||raw?.kind!=='owner-control'||raw.nonce!==nonce||!Number.isSafeInteger(raw.controlRevision)||raw.controlRevision<1)throw Error('CONTROL_RECEIPT_INVALID');return raw;}
 return {
  actor:owner?'owner':'participant',
  async readRoom(){if(!owner&&!joined){const info=await client.joinInfo();if(!info.sessionId)return {joinRequired:true,joinInfo:info};return record({...info,eventSeq:0,closed:false,submissions:[],cues:[]});}return record(await client.readRoom());},
  async joinParticipant(nickname){if(owner)throw Error('PARTICIPANT_PORT_REQUIRED');if(!joined)joined={...await client.join(nickname),nickname};const raw=await client.readRoom();if(typeof raw.sessionId!=='string'||!raw.sessionId||!raw.roomId)throw Error('ROOM_CONTEXT_REQUIRED');return {participant:joined,snapshot:record(raw)};},
  participantInfo:()=>joined&&structuredClone(joined),
  async submit(input){
   if(!latest)throw Error('ROOM_CONTEXT_REQUIRED');
   if(!owner&&!joined)joined=await client.join(input.nickname);
   const raw=await client.submit({nonce:input.nonce,prompt:input.prompt,nickname:input.nickname});
   if(raw.prompt!==input.prompt)throw Error('SUBMISSION_RECEIPT_INVALID');return receipt(raw,input.nonce);
  },
  async readOperation(nonce){
   const envelope=await client.operation(nonce);
   if(envelope.nonce!==nonce||!['submission','owner-control'].includes(envelope.kind))throw Error('OPERATION_RECEIPT_INVALID');
   const result=envelope.kind==='submission'?receipt(envelope.receipt,nonce):controlReceipt(envelope.receipt,nonce);
   const roomId=latest.roomId,epochId=latest.sessionId,raw=await client.readRoom();
   if(raw.roomId!==roomId||raw.sessionId!==epochId)throw Error('ROOM_CONTEXT_CHANGED');
   if(envelope.kind==='owner-control'&&(!Number.isSafeInteger(raw.controlRevision)||raw.controlRevision<result.controlRevision))throw Error('CONTROL_SNAPSHOT_STALE');
   const snapshot=record(raw);return {...result,kind:envelope.kind,nonce,roomId,roomEpoch:epochId,snapshot};
  },
  async ownerControl({action,nonce,expectedRevision}){
   if(!latest)throw Error('ROOM_CONTEXT_REQUIRED');const roomId=latest.roomId,epochId=latest.sessionId;
   const raw=await client.control(action,{nonce,expectedRevision}),ack=controlReceipt(raw.operation??raw,nonce);
   if((raw.roomId!==undefined&&raw.roomId!==roomId)||(raw.sessionId!==undefined&&raw.sessionId!==epochId)||ack.controlRevision!==expectedRevision+1)throw Error('CONTROL_RECEIPT_INVALID');
   const fresh=await client.readRoom();if(fresh.roomId!==roomId||fresh.sessionId!==epochId||(!Number.isSafeInteger(fresh.controlRevision)||fresh.controlRevision<ack.controlRevision))throw Error('CONTROL_SNAPSHOT_STALE');
   return {kind:'owner-control',nonce,controlRevision:ack.controlRevision,snapshot:record(fresh)};
  },
  latest:()=>latest&&structuredClone(latest),
  dispose(){client.dispose();latest=joined=null;}
 };
}
