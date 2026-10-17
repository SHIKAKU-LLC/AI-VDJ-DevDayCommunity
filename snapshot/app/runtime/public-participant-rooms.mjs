import {createParticipantRoomStore} from './participant-room-store.mjs';
import {createCollectParticipantRooms} from './collect-participant-rooms.mjs';
import {createParticipantRoomRoutes} from './participant-room-routes.mjs';
import {RoomError} from './participant-rooms.mjs';

// Staged public mount: credentials, authentication, DB migration and deployment
// belong to the host. This module never creates resources or enables generation.
export function createPublicParticipantRooms({repository,authenticateOwner,origin,publicBaseUrl,target='public',clientIdentity}={}){
  if(target!=='public'&&target!=='local')throw new RoomError('ROOM_TARGET_REQUIRED',503);
  if(target==='public'&&repository?.kind!=='postgres')throw new RoomError('PUBLIC_DURABLE_POSTGRES_REQUIRED',503);
  const base=new URL(publicBaseUrl);
  if(target==='public'&&base.protocol!=='https:')throw new RoomError('PUBLIC_ROOM_HTTPS_REQUIRED',503);
  if(typeof authenticateOwner!=='function')throw new RoomError('TRUSTED_OWNER_AUTH_REQUIRED',503);
  const store=createParticipantRoomStore({repository});
  const service=createCollectParticipantRooms({store,publicBaseUrl});
  return {service,store,handle:createParticipantRoomRoutes({service,authenticateOwner,origin,clientIdentity}),close:()=>service.close()};
}
