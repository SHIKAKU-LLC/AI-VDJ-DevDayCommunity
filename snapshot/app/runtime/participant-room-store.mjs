import {RoomError} from './participant-rooms.mjs';

// One authoritative aggregate per room. Each conditional SQL UPDATE is atomic:
// admissions, rates, operation receipts and event sequence commit together.
// Reducers must be synchronous and side-effect free; never dispatch providers here.
export function createParticipantRoomStore({repository,maxConflicts=16}={}){
  if(!repository?.get||!repository?.insert||!repository?.cas||repository.durable!==true)
    throw new RoomError('DURABLE_ROOM_REPOSITORY_REQUIRED',503);
  const partition='participant-room-aggregate-v1',key=id=>'participant-room:'+id;
  return {
    kind:repository.kind,durable:true,
    async insert(room){if(!await repository.insert(key(room.roomId),partition,'participant-room',room))throw new RoomError('ROOM_ID_CONFLICT');},
    async read(id){const room=await repository.get(key(id),partition);if(!room)throw new RoomError('ROOM_NOT_FOUND',404);return room;},
    async transact(id,reduce){
      for(let attempt=0;attempt<maxConflicts;attempt++){
        const previous=await this.read(id),next=structuredClone(previous),reply=reduce(next);
        if(reply&&typeof reply.then==='function')throw new RoomError('PURE_ROOM_REDUCER_REQUIRED',503);
        if(JSON.stringify(next)===JSON.stringify(previous))return reply;
        next.storeRevision=previous.storeRevision+1;
        if(await repository.cas(key(id),partition,previous,next))return reply;
      }
      throw new RoomError('ROOM_STORE_BUSY',409,1);
    }
  };
}
