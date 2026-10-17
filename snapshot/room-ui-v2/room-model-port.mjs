// Bridge the documented HTTP client to the UI state model. Not imported/mounted by the preview.
import {roomView} from './room-contract-view.mjs';
export function createRoomModelPort({client,owner=false}={}){
 let latest=null,joined=null;
 const record=raw=>{latest=raw;return roomView(raw);};
 const receipt=(raw,nonce)=>{if(raw.roomId!==latest?.roomId||(raw.sessionId!==undefined&&raw.sessionId!==latest.sessionId)||(raw.nonce!==undefined&&raw.nonce!==nonce))throw Error('REQUEST_RECEIPT_INVALID');return {roomId:raw.roomId,roomEpoch:latest.sessionId,nonce,requestId:raw.submissionId,participantId:raw.participantId,nickname:raw.nickname};};
 return {
  actor:owner?'owner':'participant',
  async readRoom(){if(!owner&&!joined){const info=await client.joinInfo();return record({...info,eventSeq:0,closed:false,submissions:[],cues:[]});}return record(await client.readRoom());},
  async submit(input){
   if(!latest)throw Error('ROOM_CONTEXT_REQUIRED');
   if(!owner&&!joined)joined=await client.join(input.nickname);
   const raw=await client.submit({nonce:input.nonce,prompt:input.prompt,nickname:input.nickname});
   if(raw.roomId!==latest.roomId||!raw.submissionId||raw.prompt!==input.prompt||(!owner&&raw.participantId!==joined.participantId))throw Error('SUBMISSION_RECEIPT_INVALID');
   return receipt(raw,input.nonce);
  },
  async readOperation(nonce){
   const operation=await client.operation(nonce);
   if(operation.nonce!==nonce||!operation.receipt)throw Error('REQUEST_RECEIPT_INVALID');
   if(operation.kind==='owner-control'){
    const raw=await client.readRoom(),r=operation.receipt;
    if(r.nonce!==nonce||raw.roomId!==latest?.roomId||raw.sessionId!==latest.sessionId||raw.controlRevision<r.controlRevision)throw Error('CONTROL_RECEIPT_INVALID');
    return {nonce,roomId:raw.roomId,roomEpoch:raw.sessionId,snapshot:record(raw)};
   }
   if(operation.kind!=='submission')throw Error('REQUEST_RECEIPT_INVALID');
   return receipt(operation.receipt,nonce);
  },
  async ownerControl({action,nonce,expectedRevision}){
   const r=await client.control(action,{nonce,expectedRevision}),operation=r.operation??r;
   if(operation.kind!=='owner-control'||operation.nonce!==nonce)throw Error('CONTROL_RECEIPT_INVALID');
   const raw=await client.readRoom();
   if(raw.roomId!==latest?.roomId||raw.sessionId!==latest.sessionId||raw.controlRevision<operation.controlRevision)throw Error('CONTROL_RECEIPT_INVALID');
   return {nonce,roomId:raw.roomId,roomEpoch:raw.sessionId,snapshot:record(raw)};
  },
  latest:()=>latest&&structuredClone(latest),
  dispose(){client.dispose();latest=joined=null;}
 };
}
