import {validatePlaybackCue, pcmSha256} from './playback/cue-contract.mjs';
import {projectCloudPlaybackCredit} from './cloud-output-credit.mjs';

const VERSION = 1, LIMIT = 256 * 1024, BYTE_LIMIT = 128 * 1024 * 1024;
// Initial private media preparation may take the native request's full bound.
// This reply timeout never extends a graph, observation, or playback lease.
const MAX_TIMEOUT_MS = 300000, RATE = 44100;
const id = value => Number.isSafeInteger(value) && value > 0;
const forbidden = /^(authorization|ownercapability|ownertoken|bearer|credentials?|apikey|headers?|cookies?|url|signedurl)$/i;
const failure = code => Object.assign(Error(code), {code});
const validTimeout = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
// Fixed wire vocabulary only. A generic HOLD/409 is never evidence of waiting.
// WAITING_FOR_GENERATION means the server authenticated an active, unexpired,
// non-stopped scope and found that generated material is still pending.
const safeReasons = new Set(['WAITING_FOR_GENERATION', 'OWNER_DENIED', 'OBSERVER_OWNER_DENIED',
  'OWNER_OR_ORIGIN_DENIED', 'ORIGIN_DENIED', 'OWNER_ONLY_WITHOUT_PROVIDER_KEY',
  'PLAYBACK_STOPPED', 'OBSERVER_STOPPED', 'TYPED_HOST_PLAYBACK_STOPPED',
  'SOURCE_OR_CONTROL_CHANGED', 'OBSERVER_SCOPE_CHANGED', 'BOOTSTRAP_AUTHORITY_SCOPE_CHANGED',
  'SOURCE_START_SCOPE_REQUIRED', 'OBSERVER_GRAPH_EXPIRED', 'ROOM_UNAVAILABLE',
  'SOURCE_STARTUP_HOLD', 'CUE_OPERATION_HOLD', 'OBSERVER_HOLD', 'TYPED_SOURCE_ACK_HOLD', 'PRODUCTION_HOST_HOLD']);
// Fixed output playback failure codes (names only, never values). A commit
// failure carries one across the channel so the owner screen names it.
const playbackReasons = new Set([
  'ACTUAL_AUDIO_CLOCK_REQUIRED', 'ACTUAL_AV_ACK_TIMEOUT', 'ACTUAL_CLIP_TIMELINE_CHANGED',
  'AUDIO_ENGINE_FAILURE', 'AV_ENDED_BEFORE_ACK', 'CLIP_TIMELINE_ACTIVATION_GATED', 'INVALID_RENDER_PCM',
  'OUTPUT_UNLOCK_REQUIRED', 'PLAYBACK_CANCELLED', 'PLAYBACK_COMMIT_BUSY', 'PLAYBACK_PREPARE_TIMEOUT',
  'PLAYED_PCM_SHA_MISMATCH', 'PREPARED_RENDER_CHANGED', 'QUEUED_RENDER_FRONTIER_CHANGED',
  'QUEUED_RENDER_PREFIX_CHANGED', 'RENDER_CUE_TAIL_GEOMETRY_REQUIRED', 'RENDER_PCM_SHA_MISMATCH',
  'RESOLVED_MEDIA_BINDING_REQUIRED', 'RESOLVED_VIDEO_BINDING_REQUIRED',
  'SINGLE_RUNNING_AUDIO_ENGINE_REQUIRED', 'SINGLE_RUNNING_WORKLET_REQUIRED', 'STALE_PLAYBACK_GUARD',
  'STALE_PLAYBACK_REVISION', 'VERIFIED_PREFIX_MISSING', 'VERIFIED_RENDER_GEOMETRY_REQUIRED',
  'VERIFIED_RENDER_REQUIRED', 'VIDEO_FRAME_OBSERVER_REQUIRED', 'VIDEO_PRELOAD_FAILED',
  'VIDEO_PRESENTATION_BINDING_REQUIRED', 'VIDEO_PRESENTATION_FAILED', 'VISUAL_SEGMENT_MISSED',
  'VISUAL_TIMELINE_EXHAUSTED', 'CLOUD_OUTPUT_COMMIT_INVALID']);
for (const reason of playbackReasons) safeReasons.add(reason);
// Owner-side preload/media failures answered to the output by fixed name, so
// a preparation HOLD names its cause (e.g. a preload over the byte budget).
const bridgeReasons = new Set(['CLOUD_OUTPUT_PRELOAD_INVALID', 'CLOUD_OUTPUT_MEDIA_CANCELLED', 'CLOUD_OUTPUT_ASSET_SIZE',
  'CLOUD_OUTPUT_ASSET_SHA', 'CLOUD_OUTPUT_ASSET_INVALID', 'CLOUD_OUTPUT_ASSET_RESPONSE_INVALID', 'CLOUD_BRIDGE_DATA_LIMIT',
  'CLOUD_BRIDGE_DATA_INVALID', 'PLAYER_OBSERVER_ASSET_INVALID', 'PLAYER_OBSERVER_COMMAND_INVALID', 'PLAYER_OBSERVER_NOT_ACTIVATED']);
for (const reason of bridgeReasons) safeReasons.add(reason);
export function classifyPlaybackFailure(error) {
  if (classifiedFailures.has(error)) return error;
  const code = error?.code ?? error?.message;
  return playbackReasons.has(code) ? wireFailure({reason: code}) : error;
}
const httpStatus = value => Number.isInteger(value) && value >= 400 && value <= 599;
const classifiedFailures = new WeakSet();
// Immutable media only; cache hits never authorize a Cue or replace a fresh
// manifest, reservation, physical frontier, owner/Stop or playback guard.
export function createCloudMediaPreloadCache({request,origin,roomId}={}){
  const values=new Map();let version=0;
  const clear=()=>{version++;for(const value of values.values())value.bytes.fill(0);values.clear();};
  const valid=a=>a&&Object.keys(a).every(k=>['assetId','sha256','byteLength','mimeType'].includes(k))&&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(a.assetId??'')&&/^[a-f0-9]{64}$/.test(a.sha256??'')&&
    Number.isSafeInteger(a.byteLength)&&a.byteLength>0&&a.byteLength<=32*1024*1024&&
    ['audio/wav','application/vnd.ai-vdj.pcm-f32le','video/mp4'].includes(a.mimeType);
  return {async warm(assets,signal){
    if(!Array.isArray(assets)||assets.length>32||assets.some(a=>!valid(a))||
      new Set(assets.map(a=>a.assetId)).size!==assets.length||assets.reduce((n,a)=>n+a.byteLength,0)>BYTE_LIMIT)
      throw failure('CLOUD_OUTPUT_PRELOAD_INVALID');
    clear();const token=version;
    try{for(const asset of assets){
      if(signal?.aborted||token!==version)throw failure('CLOUD_OUTPUT_MEDIA_CANCELLED');
      const response=await request(`/api/rooms/${roomId}/media/${asset.assetId}?sha256=${asset.sha256}`,
        {method:'GET',cache:'no-store',redirect:'error',signal});
      if(!response?.ok||response.redirected||response.url&&new URL(response.url).origin!==origin||
        response.headers?.get('content-type')?.split(';')[0].trim()!==asset.mimeType||!response.body?.getReader)
        throw failure('CLOUD_OUTPUT_ASSET_RESPONSE_INVALID');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        if(signal?.aborted||token!==version||size>asset.byteLength)throw failure('CLOUD_OUTPUT_ASSET_SIZE');chunks.push(part.value);}
        if(size!==asset.byteLength)throw failure('CLOUD_OUTPUT_ASSET_SIZE');
        const bytes=new Uint8Array(size);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.byteLength;}
        if(await pcmSha256(bytes)!==asset.sha256||signal?.aborted||token!==version)throw failure('CLOUD_OUTPUT_ASSET_SHA');
        values.set(asset.assetId,{...asset,bytes});
      }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    }}catch(error){if(token===version)clear();throw error;}
    return {prepared:true,assetCount:values.size};
  },read(asset){const saved=values.get(asset.assetId);return saved&&['sha256','byteLength','mimeType'].every(k=>saved[k]===asset[k])?saved.bytes.slice():null;},
  clear};
}
function safeFailure(value) {
  return {code: 'CLOUD_OUTPUT_REQUEST_FAILED', ...(httpStatus(value?.status) ? {status: value.status} : {}),
    ...(safeReasons.has(value?.reason) ? {reason: value.reason} : {})};
}
function wireFailure(value) {
  const error = Object.assign(failure('CLOUD_OUTPUT_REQUEST_FAILED'), safeFailure(value));
  classifiedFailures.add(error); return error;
}
export function isCloudOutputWaitingError(error) {
  return error?.code === 'CLOUD_OUTPUT_REQUEST_FAILED' && error.status === 409 && error.reason === 'WAITING_FOR_GENERATION';
}
async function responseFailure(response, signal) {
  let reason, reader;
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') ?? '')) throw Error();
    reader = response.body?.getReader(); if (!reader) throw Error();
    let size = 0, text = ''; const decoder = new TextDecoder('utf-8', {fatal: true});
    for (;;) {
      const part = await reader.read(); if (signal.aborted) throw Error();
      if (part.done) break;
      size += part.value.byteLength; if (size > 4096) throw Error();
      text += decoder.decode(part.value, {stream: true});
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    if (safeReasons.has(body?.error)) reason = body.error;
  } catch {} finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response.body?.cancel?.().catch(() => {});
  }
  return wireFailure({status: response.status, reason});
}
export function cloudPlaybackCommitTimeoutMs(plan, minimumMs = 15000) {
  const exit = plan?.transition?.exitFrame;
  if (!Number.isSafeInteger(exit) || exit < 0 || exit > RATE * 180 || !validTimeout(minimumMs))
    throw failure('CLOUD_OUTPUT_SCHEDULE_INVALID');
  // A finite scheduled cue may start later than a generic control/asset reply.
  // This worst-case browser bound cannot extend the server reservation/guard.
  // The output first spends up to 20s on media preparation, then waits for
  // the scheduled frame plus 8s for the actual AV ACK; never time out earlier.
  return Math.max(minimumMs, 20000 + Math.ceil(exit / RATE * 1000) + 8000);
}
const DISPLAY_TEXT_KEYS = new Set(['nickname', 'displayName', 'prompt']);
function safeData(value) {
  const json = JSON.stringify(value, (key, data) => {
    // Display text (a participant nickname or prompt) may look like a URL; it is
    // rendered as text, never loaded. Every other string still cannot be one.
    if (forbidden.test(key) || typeof data === 'string' && !DISPLAY_TEXT_KEYS.has(key) && /^(https?:|data:|blob:)/i.test(data) || typeof data === 'function') throw failure('CLOUD_BRIDGE_DATA_INVALID');
    return data;
  });
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > LIMIT) throw failure('CLOUD_BRIDGE_DATA_LIMIT');
  return JSON.parse(json);
}

// A transferred MessagePort is the only authority inside this channel. Both
// endpoints are installed after exact origin/opener validation; no storage,
// BroadcastChannel, bearer token or provider credential participates.
export function createCloudPlaybackChannel({port, handle, timeoutMs = 15000, onClose = () => {}} = {}) {
  if (!port?.postMessage || !port?.addEventListener || typeof handle !== 'function') throw failure('CLOUD_BRIDGE_PORT_REQUIRED');
  if (!validTimeout(timeoutMs)) throw failure('CLOUD_BRIDGE_TIMEOUT_INVALID');
  let closed = false, sequence = 0, incoming = 0;
  const pending = new Map(), active = new Map();
  function send(message, transfer = []) { if (closed) throw failure('CLOUD_BRIDGE_CLOSED'); port.postMessage(message, transfer); }
  const receive = async event => {
    const message = event.data;
    if (!message || message.v !== VERSION || !id(message.id) || !['request', 'reply', 'error'].includes(message.kind) ||
        Object.keys(message).some(k => !['v', 'id', 'kind', 'type', 'data'].includes(k))) return;
    if (message.kind !== 'request') {
      const task = pending.get(message.id); if (!task || task.type !== message.type) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.kind === 'error') {
        const data = message.data;
        const valid = data && typeof data === 'object' && !Array.isArray(data) && data.code === 'CLOUD_OUTPUT_REQUEST_FAILED' &&
          Object.keys(data).every(key => ['code', 'status', 'reason'].includes(key)) &&
          (data.status === undefined || httpStatus(data.status)) && (data.reason === undefined || safeReasons.has(data.reason));
        task.reject(wireFailure(valid ? data : {}));
      }
      else {
        try {
          if (message.data instanceof ArrayBuffer) {
            if (!['asset','sourceAsset'].includes(task.type) || message.data.byteLength > BYTE_LIMIT) throw failure('CLOUD_BRIDGE_DATA_INVALID');
            task.resolve(message.data);
          } else task.resolve(safeData(message.data));
        } catch (error) { task.reject(error); }
      }
      return;
    }
    if (message.id <= incoming || active.size >= 8 || typeof message.type !== 'string') return;
    incoming = message.id; const controller = new AbortController(); active.set(message.id, controller);
    try {
      const result = await handle(message.type, safeData(message.data), controller.signal);
      if (closed) return;
      if (result instanceof ArrayBuffer) {
        if (result.byteLength > BYTE_LIMIT) throw failure('CLOUD_BRIDGE_DATA_LIMIT');
        send({v: VERSION, id: message.id, kind: 'reply', type: message.type, data: result}, [result]);
      } else send({v: VERSION, id: message.id, kind: 'reply', type: message.type, data: safeData(result)});
    } catch (error) { if (!closed) send({v: VERSION, id: message.id, kind: 'error', type: message.type,
      data: safeFailure(classifiedFailures.has(error) ? error : bridgeReasons.has(error?.code) ? {reason: error.code} : null)}); }
    finally { active.delete(message.id); }
  };
  port.addEventListener('message', receive); port.start?.();
  return {
    call(type, data = {}, options = {}) {
      if (closed || pending.size >= 8) return Promise.reject(failure(closed ? 'CLOUD_BRIDGE_CLOSED' : 'CLOUD_BRIDGE_BUSY'));
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => k !== 'timeoutMs') ||
          !validTimeout(options.timeoutMs ?? timeoutMs)) return Promise.reject(failure('CLOUD_BRIDGE_TIMEOUT_INVALID'));
      const replyTimeoutMs = options.timeoutMs ?? timeoutMs;
      let clean; try { clean = safeData(data); } catch (error) { return Promise.reject(error); }
      const requestId = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(failure('CLOUD_OUTPUT_ACK_TIMEOUT')); }, replyTimeoutMs);
        pending.set(requestId, {resolve, reject, timer, type});
        try { send({v: VERSION, id: requestId, kind: 'request', type, data: clean}); }
        catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
      });
    },
    close() {
      if (closed) return; closed = true;
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(failure('CLOUD_BRIDGE_CLOSED')); }
      for (const controller of active.values()) controller.abort();
      active.clear(); pending.clear(); port.removeEventListener('message', receive); port.close?.(); onClose();
    },
  };
}

/** Owner-side selected-output facade. Open from a direct owner click; the
 * output will ask for its own audio gesture. All owner proofs stay in request's
 * closure, and only a reservation-bound anonymous manifest/bytes can cross.
 */
export function createCloudOutputBridge({window = globalThis.window, origin = window?.location?.origin,
  enabled = false, fixtureMode = false, enableClipRelativeTimeline = false, enablePlayerObserver=false, observerRoomId,
  resolveManifest, request, onState = () => {},
  MessageChannel = globalThis.MessageChannel, timeoutMs = 15000, embedIn = null} = {}) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin || !window?.open || !window?.addEventListener ||
      typeof MessageChannel !== 'function' || typeof enabled !== 'boolean' || typeof fixtureMode !== 'boolean' || typeof enableClipRelativeTimeline !== 'boolean' ||
      typeof enablePlayerObserver!=='boolean'||enablePlayerObserver&&(!/^[a-f0-9-]{36}$/i.test(observerRoomId??'')||typeof request!=='function')) throw failure('CLOUD_OUTPUT_ORIGIN_REQUIRED');
  let output = null, channel = null, closed = false, epoch = 0, operation = null;
  let startupDescriptor=null,sourceStarting=null;
  const preloaded=createCloudMediaPreloadCache({request,origin,roomId:observerRoomId});
  let state = {phase: 'MONITOR', activationEnabled: enabled, cloudRole: 'output', fixtureMode, playbackRevision: 0}, frame = null;
  const publish = value => { state = {...value, activationEnabled: enabled, cloudRole: 'output', fixtureMode}; try { onState({...state}); } catch {} };
  async function handle(type, data, signal) {
    if (type === 'state') {
      if (data.cloudRole !== 'output' || !['IDLE', 'GESTURE_REQUIRED', 'READY', 'PREPARING', 'STARTING', 'PLAYING', 'HOLD', 'STOPPED', 'MONITOR'].includes(data.phase)) throw failure('CLOUD_OUTPUT_STATE_INVALID');
      publish(data); return {accepted: true};
    }
    if(type==='preload'){
      if(!enabled||!enablePlayerObserver||closed||signal.aborted||Object.keys(data).length)throw failure('PLAYER_OBSERVER_NOT_ACTIVATED');
      const response=await request(`/api/rooms/${observerRoomId}/playback/preload`,{method:'POST',headers:{'content-type':'application/json'},
        body:'{}',cache:'no-store',redirect:'error',signal});
      if(!response?.ok||response.redirected||response.url&&new URL(response.url).origin!==origin)throw failure('CLOUD_OUTPUT_PRELOAD_INVALID');
      const reader=response.body?.getReader();if(!reader)throw failure('CLOUD_OUTPUT_PRELOAD_INVALID');
      const chunks=[];let length=0;
      try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
        if(length>32768||closed||signal.aborted)throw failure('CLOUD_OUTPUT_PRELOAD_INVALID');chunks.push(part.value);}
      }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      const bytes=new Uint8Array(length);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.byteLength;}
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      const value=safeData(JSON.parse(text));if(value.roomId!==observerRoomId||Object.keys(value).some(k=>!['roomId','assets'].includes(k)))
        throw failure('CLOUD_OUTPUT_PRELOAD_INVALID');
      return preloaded.warm(value.assets,signal);
    }
    if(['playerObserver','sourceStartup','sourceAsset','sourceAck','sourceReady','sourceStop'].includes(type)) {
      if(!enabled||!enablePlayerObserver||closed||signal.aborted)throw failure('PLAYER_OBSERVER_NOT_ACTIVATED');
      let path,body;
      if(type==='playerObserver'){
        if(Object.keys(data).some(k=>!['command','body'].includes(k))||!['register','binding','observe','stop'].includes(data.command))throw failure('PLAYER_OBSERVER_COMMAND_INVALID');
        path=`/api/rooms/${observerRoomId}/player/${data.command}`;body=data.body;
      } else if(type==='sourceStartup'){
        if(Object.keys(data).length)throw failure('PLAYER_OBSERVER_COMMAND_INVALID');
        path=`/api/rooms/${observerRoomId}/source/startup`;body={};
      } else if(type==='sourceReady'||type==='sourceStop'){
        if(Object.keys(data).length)throw failure('PLAYER_OBSERVER_COMMAND_INVALID');
        path=`/api/rooms/${observerRoomId}/cues/${type==='sourceReady'?'state':'stop'}`;body={};
      } else if(type==='sourceAck') {
        if(Object.keys(data).some(k=>k!=='ack'))throw failure('PLAYER_OBSERVER_COMMAND_INVALID');
        path=`/api/rooms/${observerRoomId}/source/ack`;body=data;
      } else {
        const descriptor=startupDescriptor;
        if(Object.keys(data).some(k=>!['assetId','sha256'].includes(k))||!descriptor||data.assetId!==descriptor.assetId||data.sha256!==descriptor.sha256)
          throw failure('PLAYER_OBSERVER_ASSET_INVALID');
        const response=await request(`/api/rooms/${observerRoomId}/media/${descriptor.assetId}?sha256=${descriptor.sha256}`,
          {method:'GET',cache:'no-store',redirect:'error',signal});
        if(response&&!response.redirected&&(!response.url||new URL(response.url).origin===origin)&&!response.ok)
          throw await responseFailure(response,signal);
        if(!response?.ok||response.redirected||response.url&&new URL(response.url).origin!==origin||
          response.headers.get('content-type')?.split(';')[0]!=='audio/wav')throw failure('PLAYER_OBSERVER_ASSET_INVALID');
        const reader=response.body?.getReader();if(!reader)throw failure('PLAYER_OBSERVER_ASSET_INVALID');
        const chunks=[];let length=0;
        try {while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
          if(length>descriptor.byteLength||signal.aborted||closed)throw failure('PLAYER_OBSERVER_ASSET_INVALID');chunks.push(part.value);}
          if(length!==descriptor.byteLength)throw failure('PLAYER_OBSERVER_ASSET_INVALID');
          const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
          if(await pcmSha256(bytes)!==descriptor.sha256||closed||signal.aborted)throw failure('PLAYER_OBSERVER_ASSET_INVALID');return bytes.buffer;
        }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      }
      const response=await request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store',redirect:'error',signal});
      if(response&&!response.redirected&&(!response.url||new URL(response.url).origin===origin)&&!response.ok)
        throw await responseFailure(response,signal);
      if(!response?.ok||response.redirected||response.url&&new URL(response.url).origin!==origin)throw failure('PLAYER_OBSERVER_HOLD');
      const reader=response.body?.getReader();if(!reader)throw failure('PLAYER_OBSERVER_HOLD');
      const chunks=[];let length=0;try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;
        if(length>(type==='sourceReady'?262144:32768)||closed||signal.aborted)throw failure('PLAYER_OBSERVER_HOLD');chunks.push(part.value);}
        const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
        const result=safeData(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
        if(type==='sourceReady'){
          if(typeof result.stopped!=='boolean'||!Array.isArray(result.cues))throw failure('PLAYER_OBSERVER_HOLD');
          return {stopped:result.stopped,readyCues:result.cues.filter(c=>c.status==='READY'&&c.atomicReady===true&&
            c.music?.qc?.passed===true&&c.video?.qc?.passed===true).length};
        }
        if(type==='sourceStartup'){
          const d=result.descriptor;
          if(!d||d.mimeType!=='audio/wav'||!/^[A-Za-z0-9_-]{1,100}$/.test(d.assetId??'')||!/^[a-f0-9]{64}$/.test(d.sha256??'')||
            !Number.isSafeInteger(d.byteLength)||d.byteLength<1||d.byteLength>16*1024*1024)throw failure('PLAYER_OBSERVER_ASSET_INVALID');
          startupDescriptor={...d};
        }
        return result;
      }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    }
    const op = operation;
    if (!op || op.token !== epoch || data.operationId !== op.operationId || signal.aborted) throw failure('CLOUD_OUTPUT_STALE_OPERATION');
    if (type === 'guard') {
      if (!['prepare', 'ack'].includes(data.phase) || Object.keys(data).some(k => !['operationId', 'phase'].includes(k))) throw failure('CLOUD_OUTPUT_GUARD_INVALID');
      const valid = await op.input.guard({phase: data.phase});
      return {valid: valid === true && operation === op && op.token === epoch && !signal.aborted};
    }
    if (type === 'manifest') {
      if (typeof resolveManifest !== 'function' || Object.keys(data).some(k => !['operationId'].includes(k))) throw failure('CLOUD_OUTPUT_MANIFEST_INVALID');
      const value = await resolveManifest({...op.input, signal});
      if (operation !== op || op.token !== epoch || signal.aborted) throw failure('CLOUD_OUTPUT_STALE_OPERATION');
      // Validate exact media/cue bindings in the output resolver; here limit
      // transferable values before allowing any bytes to be requested.
      const clean = safeData(value);
      if (clean.roomId !== op.input.roomId || clean.cueId !== op.input.cue.cueId || clean.generationId !== op.input.cue.generationId ||
          clean.audio?.assetId !== op.input.cue.music.asset.assetId || clean.audio?.sha256 !== op.input.cue.music.asset.sha256 ||
          !Array.isArray(clean.videos) || clean.videos.length !== op.input.cue.video.clips.length) throw failure('CLOUD_OUTPUT_MANIFEST_BINDING');
      const assets = [clean.audio.render, ...clean.videos];
      if (clean.audio.render?.sha256 !== op.input.plan.transition?.renderedSha256 ||
          clean.videos.some(asset => !op.input.cue.video.clips.some(clip => clip.assetId === asset.assetId && clip.sha256 === asset.sha256)))
        throw failure('CLOUD_OUTPUT_ASSET_NOT_RESERVED');
      for (const asset of assets) {
        if (!asset || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(asset.assetId ?? '') || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
            !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > BYTE_LIMIT ||
            !['audio/wav', 'application/vnd.ai-vdj.pcm-f32le', 'video/mp4'].includes(asset.mimeType)) throw failure('CLOUD_OUTPUT_ASSET_INVALID');
      }
      op.assets = assets; return clean;
    }
    if (type === 'asset') {
      if (typeof request !== 'function' || Object.keys(data).some(k => !['operationId', 'assetId', 'sha256'].includes(k))) throw failure('CLOUD_OUTPUT_ASSET_INVALID');
      const asset = op.assets?.find(a => a.assetId === data.assetId && a.sha256 === data.sha256);
      if (!asset) throw failure('CLOUD_OUTPUT_ASSET_NOT_RESERVED');
      const cached=preloaded.read(asset);
      if(cached){if(operation!==op||op.token!==epoch||closed||signal.aborted)throw failure('CLOUD_OUTPUT_STALE_OPERATION');return cached.buffer;}
      const response = await request(`/api/rooms/${op.input.roomId}/media/${asset.assetId}?sha256=${asset.sha256}`,
        {method: 'GET', cache: 'no-store', redirect: 'error', signal});
      if(response&&!response.redirected&&(!response.url||new URL(response.url).origin===origin)&&!response.ok)
        throw await responseFailure(response,signal);
      if (!response?.ok || response.redirected || response.url && new URL(response.url).origin !== origin ||
          response.headers?.get('content-type')?.split(';')[0].trim() !== asset.mimeType || !response.body?.getReader) throw failure('CLOUD_OUTPUT_ASSET_RESPONSE_INVALID');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (operation !== op || op.token !== epoch || signal.aborted) throw failure('CLOUD_OUTPUT_STALE_OPERATION');
          if (result.done) break;
          size += result.value.byteLength; if (size > asset.byteLength) throw failure('CLOUD_OUTPUT_ASSET_SIZE'); chunks.push(result.value);
        }
        if (size !== asset.byteLength) throw failure('CLOUD_OUTPUT_ASSET_SIZE');
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        if (await pcmSha256(bytes) !== asset.sha256 || operation !== op || op.token !== epoch) throw failure('CLOUD_OUTPUT_ASSET_SHA');
        return bytes.buffer;
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    }
    throw failure('CLOUD_OUTPUT_COMMAND_INVALID');
  }
  const ready = event => {
    if (closed || !output || event.source !== output || event.origin !== origin ||
        event.data?.type !== 'ai-vdj-cloud-output-ready' || event.data?.version !== VERSION ||
        Object.keys(event.data).some(k => !['type', 'version'].includes(k))) return;
    // The output announces ready once per document load. A fresh ready from
    // the same attached output means its document reloaded and the old port
    // is dead: drop that channel and any in-flight operation, then reconnect.
    if (channel) { channel.close(); channel = null; operation = null; epoch++; }
    const pair = new MessageChannel(); channel = createCloudPlaybackChannel({port: pair.port1, handle, timeoutMs});
    output.postMessage({type: 'ai-vdj-cloud-output-connect', version: VERSION}, origin, [pair.port2]);
    void channel.call('init', {enabled, fixtureMode, initialPlaybackRevision: state.playbackRevision ?? 0,
      ...(enableClipRelativeTimeline||enablePlayerObserver?{enableClipRelativeTimeline:true}:{}),
      ...(enablePlayerObserver?{enablePlayerObserver:true}:{})}).catch(() => publish({...state, phase: 'HOLD', reason: 'CLOUD_OUTPUT_INIT_FAILED'}));
  };
  window.addEventListener('message', ready);
  const hide = () => { void api.dispose(); };
  window.addEventListener('pagehide', hide, {once: true});
  const outputWatch = setInterval(() => {
    if (closed) { clearInterval(outputWatch); return; }
    if (output?.closed || frame && !frame.isConnected) {
      operation = null; epoch++; channel?.close(); channel = null; output = null;
      publish({...state, phase: 'STOPPED', reason: 'OUTPUT_CLOSED'});
    }
  }, 1000);
  const api = {
    role: 'output',
    openOutput() {
      if (closed) throw failure('CLOUD_BRIDGE_CLOSED');
      if (output && !output.closed && (!frame || frame.isConnected)) { output.focus?.(); return output; }
      channel?.close(); channel = null; operation = null; epoch++;
      if (embedIn) {
        // Single-screen show: the same-origin output document is embedded in
        // the owner page. Its own click still unlocks audio (autoplay policy).
        frame?.remove();
        frame = embedIn.ownerDocument.createElement('iframe');
        frame.src = '/cloud-output.html'; frame.title = '音声・映像出力'; frame.className = 'show-output-frame';
        frame.setAttribute('allow', 'autoplay; fullscreen');
        embedIn.replaceChildren(frame);
        output = frame.contentWindow;
        if (!output) throw failure('CLOUD_OUTPUT_EMBED_FAILED'); return output;
      }
      output = window.open('/cloud-output.html', 'ai-vdj-cloud-output');
      if (!output) throw failure('CLOUD_OUTPUT_POPUP_BLOCKED'); return output;
    },
    read: () => ({...state}),
    unlock() { return Promise.reject(failure('CLOUD_OUTPUT_GESTURE_REQUIRED')); },
    startSource(){
      if(!enablePlayerObserver)return Promise.resolve();
      if(sourceStarting)return sourceStarting;
      if(!enabled||closed||!channel||!['READY','PREPARING','PLAYING'].includes(state.phase)||
        state.phase==='PREPARING'&&state.sourceStartAvailable!==true)
        return Promise.reject(failure('CLOUD_OUTPUT_GESTURE_REQUIRED'));
      const token=epoch;
      const work=(async()=>{
        const ack=await channel.call('startSource',{}, {timeoutMs:300000});
        if(closed||token!==epoch||ack?.kind!=='cloud-source-playback-started-v1'||ack.sourceOnly!==true||ack.actual!==true||ack.audioStarted!==true||
          ack.participantCredit!==false||!Number.isSafeInteger(ack.graphEpoch)||ack.graphEpoch<1||
          !/^[a-f0-9]{64}$/.test(ack.sourceSha256??'')||ack.sampleRate!==RATE)
          throw failure('CLOUD_SOURCE_START_ACK_INVALID');
        return ack;
      })();
      sourceStarting=work;void work.finally(()=>{if(sourceStarting===work)sourceStarting=null;}).catch(()=>{});
      return work;
    },
    async commitPlayback(input) {
      if (!enabled || !channel || !['READY', 'PLAYING'].includes(state.phase)) throw failure('CLOUD_OUTPUT_UNLOCK_REQUIRED');
      validatePlaybackCue(input);
      if (typeof input.guard !== 'function' || operation && !operation.acked) throw failure('CLOUD_OUTPUT_COMMIT_BUSY');
      const clean = safeData({roomId: input.roomId, cue: input.cue, plan: input.plan, expectedRevision: input.expectedRevision});
      const op = {input, token: ++epoch, operationId: epoch, acked: false}; operation = op;
      try {
        const commitTimeoutMs = cloudPlaybackCommitTimeoutMs(input.plan, timeoutMs);
        let ack;
        try { ack = await channel.call('commit', {...clean, operationId: op.operationId}, {timeoutMs: commitTimeoutMs}); }
        catch (error) {
          // A late or lost reply may follow an applied audio edit. Ask the
          // output for this operation's own outcome; never re-send the commit.
          if (error?.message !== 'CLOUD_OUTPUT_ACK_TIMEOUT' || operation !== op || op.token !== epoch || !channel) throw error;
          try { ack = await channel.call('commitResult', {operationId: op.operationId}, {timeoutMs: commitTimeoutMs}); }
          catch { throw failure('CLOUD_OUTPUT_COMMIT_UNCERTAIN'); }
          if (ack?.committed === false) throw failure('CLOUD_OUTPUT_COMMIT_FAILED');
        }
        if (operation !== op || op.token !== epoch || await input.guard({phase: 'ack'}) !== true || operation !== op ||
            ack.roomId !== input.roomId || ack.cueId !== input.cue.cueId || ack.clipId !== input.cue.music.asset.assetId ||
            ack.playbackRevision !== input.expectedRevision || ack.actual !== true || ack.audioStarted !== true || ack.videoPresented !== true ||
            !Number.isFinite(ack.audioTime) || ack.audioTime < 0) throw failure('CLOUD_OUTPUT_ACK_INVALID');
        op.acked = true; return ack;
      } catch (error) {
        // A failure before the queue edit leaves the current Cue sounding; the
        // output itself stops when an edited Cue fails. Free the slot for a retry.
        if (operation === op) operation = null;
        throw error;
      }
    },
    async showCredit(authoritativeCredit) {
      const op = operation;
      if (!enabled || closed || !channel || !op?.acked || op.token !== epoch) throw failure('CLOUD_CREDIT_ACK_REQUIRED');
      const credit = projectCloudPlaybackCredit(authoritativeCredit, {operationId: op.operationId,
        roomId: op.input.roomId, cueId: op.input.cue.cueId, generationId: op.input.cue.generationId,
        expectedRevision: op.input.expectedRevision});
      if (op.creditSent) return {shown: false, duplicate: true};
      // A lost overlay reply cannot restart the six-second display.
      op.creditSent = true;
      let result;
      // A delivery that failed may be retried; the overlay itself deduplicates
      // a revision it already showed, so a retry never restarts the timer.
      try { result = await channel.call('credit', credit); } catch (error) { op.creditSent = false; throw error; }
      if (operation !== op || op.token !== epoch || !result || result.shown !== true ||
          result.cueId !== credit.cueId || result.playbackRevision !== credit.playbackRevision)
        throw failure('CLOUD_CREDIT_NOT_CONFIRMED');
      return result;
    },
    async stop(reason = 'OWNER_STOP') {
      startupDescriptor=null;sourceStarting=null;preloaded.clear();
      operation = null; epoch++;
      const result=channel?await channel.call('stop', {reason}):{stopped:false,graphStopConfirmed:false};
      publish({...state, phase: 'STOPPED', reason});
      return result;
    },
    async dispose() {
      if (closed) return;
      try { await api.stop('DISPOSE'); } catch {}
      closed = true; clearInterval(outputWatch); channel?.close(); operation = null; frame?.remove(); frame = null;
      window.removeEventListener('message', ready); window.removeEventListener('pagehide', hide);
    },
  };
  return api;
}
