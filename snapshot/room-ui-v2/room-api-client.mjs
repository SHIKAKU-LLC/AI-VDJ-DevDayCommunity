// Unmounted transport adapter for PARTICIPANT-ROOM-CONTRACT.md. request is injected.
// Tokens stay in closures and must never enter join URLs, UI snapshots or persistent storage.
export function createRoomApiClient({request,roomId,joinCode,ownerToken=null,enabled=false}={}){
 let participantToken=null,participantId=null;const base='/api/rooms/'+encodeURIComponent(roomId??'');
 const check=()=>{if(enabled!==true||typeof request!=='function'||!roomId)throw Error('ROOM_API_NOT_CONNECTED');};
 const call=(route,method='GET',body,owner=false)=>{check();const token=owner?ownerToken:participantToken;if(owner&&!token)throw Error('OWNER_AUTH_REQUIRED');const headers=new Headers();if(token)headers.set(owner?'X-Room-Owner':'Authorization',owner?token:'Bearer '+token);return request(route,{method,headers,...(body===undefined?{}:{body})});};
 return {
  joinInfo(){return call(base+'/join?code='+encodeURIComponent(joinCode??''));},
  async join(nickname){if(participantToken)throw Error('ALREADY_JOINED');const receipt=await call(base+'/participants','POST',{joinCode,nickname});if(!receipt.participantId||!receipt.participantToken)throw Error('JOIN_RECEIPT_INVALID');participantId=receipt.participantId;participantToken=receipt.participantToken;return {participantId};},
  readRoom(){return call(base,'GET',undefined,!!ownerToken);},
  submit({nonce,prompt,nickname}){if(!ownerToken&&!participantToken)throw Error('JOIN_REQUIRED');return call(base+'/submissions','POST',ownerToken?{nonce,prompt,nickname}:{nonce,prompt},!!ownerToken);},
  submission(id){return call(base+'/submissions/'+encodeURIComponent(id),'GET',undefined,!!ownerToken);},
  events(after=0){if(!Number.isSafeInteger(after)||after<0)throw Error('EVENT_CURSOR_INVALID');return call(base+'/events?after='+after,'GET',undefined,!!ownerToken);},
  operation(nonce){return call(base+'/operations/'+encodeURIComponent(nonce),'GET',undefined,!!ownerToken);},
  control(action,{nonce,expectedRevision}={}){const controls={ACCEPT_ON:{accepting:true},ACCEPT_OFF:{accepting:false},GENERATION_STOP:{generationPaused:true},GENERATION_RESUME:{generationPaused:false},AUTO_DJ_ON:{autoDJ:true},AUTO_DJ_OFF:{autoDJ:false}};if(!controls[action])throw Error('CONTROL_INVALID');return call(base+'/control','POST',{...controls[action],nonce,expectedRevision},true);},
  dispose(){participantToken=null;participantId=null;ownerToken=null;enabled=false;}
 };
}
