import {createGenerationStore} from './generation-store.mjs';
import {boundedBytes} from './fal-provider.mjs';
const answer=(v,status=200)=>Response.json(v,{status,headers:{'cache-control':'no-store'}});
export async function soundtrackHttp(request,env) {
  const url=new URL(request.url), match=/^\/api\/rooms\/([a-f0-9-]{36})\/soundtrack$/.exec(url.pathname);
  if (!match) return null;
  if (env.INDEPENDENT_AUDIO!=='true') return answer({error:'SOUNDTRACK_DISABLED'},404);
  if (url.origin!==env.PUBLIC_ORIGIN || url.search || request.headers.has('origin') && request.headers.get('origin')!==env.PUBLIC_ORIGIN) return answer({error:'DENIED'},403);
  try {
    if (request.headers.has('authorization')) throw Error('ACTOR_DENIED');
    const roomId=match[1];
    await createGenerationStore({db:env.DB,eventId:env.EVENT_ID}).authorize(roomId,request.headers.get('x-room-owner'),true);
    let input={action:'view'};
    if (request.method!=='GET') {
      if(request.method!=='POST' || request.headers.get('origin')!==env.PUBLIC_ORIGIN || request.headers.get('content-type')!=='application/json')return answer({error:'DENIED'},403);
      input=JSON.parse(new TextDecoder().decode(await boundedBytes(new Response(request.body),1024)));
      const fields={start:['action','clientId','runId'],pulse:['action','clientId','runId'],stop:['action','clientId','runId'],played:['action','clientId','runId','id']};
      if(!fields[input.action] || Object.keys(input).some(k=>!fields[input.action].includes(k)) || !/^[a-f0-9-]{36}$/.test(input.clientId??'') || !/^[a-f0-9-]{36}$/.test(input.runId??'') || input.action==='played' && !/^[a-f0-9-]{36}$/.test(input.id??''))throw Error('PLAYBACK_INPUT_INVALID');
      // A second owner tab cannot start another paid music stream.
      if(input.action!=='stop')await env.AUDIENCE_ROOMS.getByName(roomId).playback(roomId,{action:'heartbeat',clientId:input.clientId});
    }
    return answer(await env.GENERATION.getByName(roomId+':soundtrack-v1').soundtrack(roomId,input));
  }catch(error){
    const code=['ACTOR_DENIED','ROOM_NOT_FOUND','PLAYBACK_IN_USE','PLAYBACK_INPUT_INVALID','PLAYBACK_CLIENT_INVALID','SOUNDTRACK_DISABLED'].includes(error.message)?error.message:'SOUNDTRACK_UNAVAILABLE';
    return answer({error:code},code==='ACTOR_DENIED'?403:code==='ROOM_NOT_FOUND'?404:409);
  }
}
