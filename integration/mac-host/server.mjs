import http from 'node:http';
import {createHash} from 'node:crypto';
import {createOwnerCloudConnection} from '../runtime/owner-cloud-connection.mjs';
import {readFile} from 'node:fs/promises';
import {createSessionGate} from './ephemeral-gate.mjs';
import {createLocalArtifactStore} from '../runtime/local-artifacts.mjs';
import {prepareBootstrap, saveBootstrap} from '../runtime/bootstrap.mjs';
import {inspectReferenceImage, macDialog} from './native.mjs';
import {macProductionRoute} from './edge-trial-composition.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
const exactOrigin = value => {
  const u = new URL(value);
  if (u.origin !== value || u.protocol !== 'https:' || u.username || u.password) throw Error('EXACT_HTTPS_ORIGIN_REQUIRED');
  return value;
};
const noCache = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'};
async function body(req, maximum) {
  const parts = []; let n = 0;
  for await (const chunk of req) { n += chunk.length; if (n > maximum) throw Error('BODY_LIMIT'); parts.push(chunk); }
  return Buffer.concat(parts);
}
async function jsonBody(req, keys) {
  if (req.headers['content-type'] !== 'application/json') throw Error('JSON_REQUIRED');
  const value = JSON.parse((await body(req, 4096)).toString());
  if (!only(value, keys)) throw Error('REQUEST_FIELDS_REFUSED');
  return value;
}

export async function createMacHost({roomId, cloudOrigin, now = Date.now, lifetimeMs = 30 * 60_000, port=0,
  enableProductionRoutes=false,expiresAtMs,companionMode=false,companionRuntimeApproved=false,consentStore,
  verifyOwner=async ({ownerCapability})=>{
    const connection=createOwnerCloudConnection({roomId,origin:cloudOrigin});
    try{await connection.attachOwner({ownerCapability});}finally{connection.close();}
  },
  onDiagnostic=()=>{},
  confirm = macDialog, showPairing = ({code, origin}) => macDialog({message: `接続先: ${origin}\n一回限りの接続コード（2分以内）:\n${code}`, confirmLabel: '確認', cancel: false, copyText: code}),
  createRuntime, loadBootstrap, inspectImage = inspectReferenceImage, prepare = prepareBootstrap,
  createStore = createLocalArtifactStore} = {}) {
  if (!id(roomId)) throw Error('ROOM_ID_REQUIRED');
  if(!Number.isSafeInteger(port)||port!==0&&(port<1024||port>65535))throw Error('LOCAL_PORT_REQUIRED');
  if(typeof enableProductionRoutes!=='boolean'||enableProductionRoutes&&(!Number.isSafeInteger(lifetimeMs)||lifetimeMs<1000||lifetimeMs>1800000)||
    expiresAtMs!==undefined&&(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now()||expiresAtMs>now()+1800000))throw Error('BOUNDED_MAC_TRIAL_REQUIRED');
  if(typeof companionMode!=='boolean'||companionMode&&((enableProductionRoutes&&companionRuntimeApproved!==true)||expiresAtMs!==undefined))throw Error('COMPANION_COLLECT_ONLY');
  if (cloudOrigin) exactOrigin(cloudOrigin);
  let origin, gate, store, runtime, current, abort, timer, closing = Promise.resolve(), busy = false;
  let stagedAudio, stagedReference; let listening = false, beginning = false;
  let lastPairingReason=null,showingCloudCode=false,startSession;
  const diagnostic=(event,reason=null)=>{try{onDiagnostic({event,reason,timeMs:now()});}catch{}};
  const clearUploads = () => { stagedAudio?.fill(0); stagedReference?.fill(0); stagedAudio = stagedReference = undefined; };
  function runtimeEnded() {
    try { const state = runtime?.status?.()?.nativeOrchestration?.state; return state === 'expired' || state === 'closed'; }
    catch { return true; }
  }
  async function endSession() {
    diagnostic('SESSION_ENDED');
    gate?.close(); gate = null; abort?.abort(); clearTimeout(timer); clearUploads(); current = undefined;
    const oldRuntime = runtime, oldStore = store; runtime = store = null;
    closing = closing.catch(() => {}).then(async () => {
      try { await oldRuntime?.close?.(); } finally { await oldStore?.close(); }
    });
    return closing;
  }
  const server = http.createServer(async (req, res) => {
    // Diagnose only the code-free probe. Never record headers, bodies or codes.
    if(req.url==='/api/status'&&req.headers.origin===cloudOrigin&&['POST','OPTIONS'].includes(req.method)){
      diagnostic(req.method==='OPTIONS'?'STATUS_PREFLIGHT_RECEIVED':'STATUS_PROBE_RECEIVED');
      res.once('finish',()=>diagnostic('STATUS_REPLY_FINISHED',String(res.statusCode)));
    }
    const send = (status, value) => { if (!res.destroyed) res.writeHead(status, {...noCache, 'Content-Type': 'application/json'}).end(JSON.stringify(value)); };
    let caller, route;
    try {
      // Exact host blocks DNS rebinding; no proxy trust and no wildcard interface.
      if (!listening || req.headers.host !== new URL(origin).host || req.headers.forwarded || req.headers['x-forwarded-host'] ||
          !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(403, {code: 'LOCAL_HOST_REQUIRED'});
      route = req.url;
      if (req.method === 'GET' && ['/', '/client.mjs', '/startup.mjs', '/health.mjs', '/startup.css'].includes(route)) {
        const file = route === '/' ? 'startup.html' : route.slice(1);
        const bytes = await readFile(new URL(file, import.meta.url));
        res.writeHead(200, {...noCache, 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'", 'Cross-Origin-Resource-Policy': 'same-origin'}).end(bytes); return;
      }
      caller = req.headers.origin;
      const productionRoute=enableProductionRoutes?macProductionRoute(route,roomId):null;
      if (caller !== origin && (!cloudOrigin || caller !== cloudOrigin)) return send(403, {code: 'ORIGIN_REFUSED'});
      if (caller === cloudOrigin) {
        res.setHeader('Access-Control-Allow-Origin', caller); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'X-Asset-Id, X-Asset-Sha256, X-Asset-Type, X-Asset-Provenance, X-Render-Metadata');
      }
      if (req.method === 'OPTIONS') {
        const method=req.headers['access-control-request-method'];
        if (method !== 'POST'&&!(method==='GET'&&productionRoute?.method==='GET')) return send(403, {code: 'METHOD_REFUSED'});
        const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
        if (headers.some(h => !['content-type', 'x-vdj-session'].includes(h))) return send(403, {code: 'HEADERS_REFUSED'});
        res.setHeader('Access-Control-Allow-Methods', method); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-VDJ-Session');
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204, noCache).end(); return;
      }
      if (req.method !== 'POST'&&!(req.method==='GET'&&productionRoute?.method==='GET')) return send(405, {code: 'POST_REQUIRED'});
      if(route==='/api/status'){
        if(caller!==origin)return send(403,{code:'LOCAL_STATUS_ONLY'});
        await jsonBody(req,[]);const state=gate?.read();
        send(200,{listening,sessionActive:state?.active===true,localPaired:state?.pairedOrigins.includes(origin)===true,
          cloudPaired:state?.pairedOrigins.includes(cloudOrigin)===true,bootstrapReady:!!current,lastPairingReason,
          confirmationPending:beginning,cloudCodePending:showingCloudCode,companionMode});return;
      }
      if(route==='/api/start-session'){
        if(caller!==origin)return send(403,{code:'LOCAL_STATUS_ONLY'});
        await jsonBody(req,[]);if(beginning)return send(409,{code:'SESSION_START_IN_PROGRESS'});
        void startSession().catch(()=>diagnostic('SESSION_START_CANCELLED'));
        send(202,{confirmationRequested:true});return;
      }
      // This route is available only in the ordinary, unbilled companion.
      // Exact Origin is necessary but insufficient: native independently
      // verifies the room capability against the existing owner backend.
      if(route==='/api/companion/connect'){
        if(!companionMode)return send(409,{code:'COMPANION_UNAVAILABLE'});
        if(caller!==cloudOrigin)return send(403,{code:'CLOUD_OWNER_REQUIRED'});
        const b=await jsonBody(req,['roomId','ownerCapability']);
        if(b.roomId!==roomId||! /^[a-f0-9]{64}$/.test(b.ownerCapability??''))return send(403,{code:'OWNER_AUTH_REQUIRED'});
        if(beginning)return send(409,{code:'COMPANION_BUSY'});
        beginning=true;
        try{
          try{await verifyOwner({ownerCapability:b.ownerCapability});}catch{return send(403,{code:'OWNER_AUTH_REQUIRED'});}
          const fingerprint=createHash('sha256').update(b.ownerCapability).digest('hex');
          if(companionConsent!==fingerprint&&consentStore){
            const saved=await consentStore.read(roomId);if(saved?.roomIds?.includes(roomId))companionConsent=fingerprint;
          }
          if(companionConsent!==fingerprint){
            if(await confirm({message:`AI VDJのowner画面にこのMacを接続します。\n接続先: ${cloudOrigin}\nルーム: ${roomId}\n${consentStore?'このMacの署名登録をKeychainに保存します。':'キー使用は別操作です。'}\n生成・再生は別の開始操作です。`,confirmLabel:'このMacを接続'})!==true)
              return send(403,{code:'OWNER_CANCELLED'});
            if(res.destroyed)return;
            if(consentStore)await consentStore.save(roomId);
            companionConsent=fingerprint;
          }
          if(res.destroyed)return;
          // A runtime past its native deadline (or closed) can never serve
          // again; recycle it so the same owner's reconnect gets a fresh one.
          if(runtime&&(companionOwner!==fingerprint||runtimeEnded()))await endSession();
          if(!runtime)await initializeSession({confirmed:true,showCode:false});
          await runtime.attachOwner({ownerCapability:b.ownerCapability});
          if(res.destroyed)return;
          companionOwner=fingerprint;
          // Renew only the browser credential. The running companion and
          // verified local bootstrap survive credential expiry/navigation.
          gate?.close();clearTimeout(timer);
          gate=createSessionGate({origins:[cloudOrigin],now,lifetimeMs});
          const paired=gate.exchange(cloudOrigin,gate.issue(cloudOrigin).code);
          diagnostic('CLOUD_PAIRED');send(200,{...paired,...runtime.status()});
        }finally{beginning=false;}
        return;
      }
      if(route==='/api/companion/unregister'){
        if(!companionMode||caller!==cloudOrigin)return send(403,{code:'CLOUD_OWNER_REQUIRED'});
        const b=await jsonBody(req,['roomId','ownerCapability']);
        if(beginning)return send(409,{code:'COMPANION_BUSY'});
        if(b.roomId!==roomId||! /^[a-f0-9]{64}$/.test(b.ownerCapability??'')||
          createHash('sha256').update(b.ownerCapability).digest('hex')!==companionConsent)return send(403,{code:'OWNER_AUTH_REQUIRED'});
        beginning=true;try{
          try{await verifyOwner({ownerCapability:b.ownerCapability});}catch{return send(403,{code:'OWNER_AUTH_REQUIRED'});}
          if(consentStore)await consentStore.remove(roomId);
          companionConsent='';companionOwner='';await endSession();send(200,{phase:'UNREGISTERED'});
        }finally{beginning=false;}
        return;
      }
      if (route === '/api/pair') {
        const b = await jsonBody(req, ['code']);
        if(!gate)throw Error('PAIRING_UNAVAILABLE');
        const result = gate.exchange(caller, b.code);
        lastPairingReason=null;diagnostic(caller===origin?'LOCAL_PAIRED':'CLOUD_PAIRED');send(200,result);return;
      }
      if (!gate?.verify(caller, req.headers['x-vdj-session'])) return send(401, {code: 'SESSION_REQUIRED'});
      const activeGate = gate, activeStore = store, activeRuntime = runtime, signal = abort.signal;
      const valid = () => !signal.aborted && gate === activeGate && activeGate.read().active;
      if(enableProductionRoutes&&['/api/runtime/prepare','/api/runtime/activate','/api/runtime/bootstrap','/api/runtime/status','/api/runtime/provider-metadata','/api/runtime/trial'].includes(route)){
        if(caller!==origin)throw Error('LOCAL_RUNTIME_CONTROL_REQUIRED');
        await jsonBody(req,[]);
        const methods={'/api/runtime/prepare':'prepareRegistration','/api/runtime/activate':'activateNative',
          '/api/runtime/bootstrap':'prepareNativeBootstrap','/api/runtime/status':'status',
          '/api/runtime/provider-metadata':'readProviderMetadata','/api/runtime/trial':'configureNativeTrial'};
        const method=methods[route];if(typeof activeRuntime?.[method]!=='function')throw Error('EDGE_RUNTIME_CONFIGURATION_REQUIRED');
        const value=await activeRuntime[method]();if(!valid())throw Error('SESSION_ENDED');send(200,value);return;
      }
      if(productionRoute){
        if(req.method!==productionRoute.method)return send(405,{code:'PRODUCTION_METHOD_REQUIRED'});
        if(typeof activeRuntime?.handleProductionRequest!=='function'||
          ['authorization','apikey','x-api-key','x-fal-key','x-room-owner','x-vdj-runtime','x-vdj-signature'].some(k=>req.headers[k]!==undefined))throw Error('NATIVE_PRODUCTION_CONTEXT_REQUIRED');
        const data=req.method==='POST'?await body(req,32*1024*1024):undefined;
        if(!valid())throw Error('SESSION_ENDED');
        const headers=new Headers({'origin':cloudOrigin});if(req.headers['content-type'])headers.set('content-type',req.headers['content-type']);
        const upstream=await activeRuntime.handleProductionRequest(new Request(cloudOrigin+route,{method:req.method,headers,
          ...(data?{body:data}:{}),signal}));
        if(!(upstream instanceof Response)||!valid())throw Error('SESSION_ENDED');
        const reader=upstream.body?.getReader(),parts=[];let size=0;
        try{if(reader)for(;;){const part=await reader.read();if(!valid())throw Error('SESSION_ENDED');if(part.done)break;
          if((size+=part.value.byteLength)>32*1024*1024)throw Error('PRODUCTION_RESPONSE_LIMIT');parts.push(Buffer.from(part.value));}}
        finally{await reader?.cancel().catch(()=>{});}
        if(!valid())throw Error('SESSION_ENDED');
        const selected=Object.fromEntries(['content-type','x-asset-id','x-asset-sha256','x-asset-type','x-asset-provenance','x-render-metadata']
          .filter(k=>upstream.headers.has(k)).map(k=>[k,upstream.headers.get(k)]));
        if(!res.destroyed)res.writeHead(upstream.status,{...noCache,...selected}).end(Buffer.concat(parts,size));return;
      }
      if (route === '/api/state') {
        await jsonBody(req, []);
        send(200, {roomId, expiresAt: gate.read().expiresAt, phase: current?.playback?.actual === true ? 'PLAYING' : current ? 'BOOTSTRAP_READY' : 'SELECT_BOOTSTRAP',
          pipelineReady: !!runtime?.readRender, source: current ? {clipId: current.music.clipId, sha256: current.music.sha256,
            contextSha256: current.music.contextSha256, audioAssetId: current.audioAssetId, referenceAssetId: current.referenceAssetId} : null,
          actualPlayback: current?.playback?.actual === true, generationEnabled: false}); return;
      }
      if(route==='/api/owner/connect'){
        if(caller!==cloudOrigin||typeof activeRuntime?.attachOwner!=='function')throw Error('CLOUD_OWNER_REQUIRED');
        const b=await jsonBody(req,['roomId','ownerCapability']);
        if(b.roomId!==roomId)throw Error('ROOM_REQUIRED');
        await activeRuntime.attachOwner({ownerCapability:b.ownerCapability});
        if(!valid())throw Error('SESSION_ENDED');
        send(200,activeRuntime.status());return;
      }
      if(route==='/api/owner/state'){
        await jsonBody(req,[]);if(typeof activeRuntime?.readCloud!=='function')throw Error('CLOUD_OWNER_REQUIRED');
        await activeRuntime.readCloud();if(!valid())throw Error('SESSION_ENDED');
        send(200,activeRuntime.status());return;
      }
      if (route === '/api/stop') { await jsonBody(req, []); await endSession(); send(200, {phase: 'STOPPED'}); return; }
      if(route==='/api/pair-cloud'){
        if(caller!==origin)throw Error('LOCAL_PAIRING_CONTROL_ONLY');
        await jsonBody(req,[]);if(showingCloudCode)return send(409,{code:'CODE_DIALOG_IN_PROGRESS'});
        showingCloudCode=true;
        void issueCloudPairing().catch(()=>diagnostic('CLOUD_PAIRING_CANCELLED')).finally(()=>{showingCloudCode=false;});
        send(202,{confirmationRequested:true});return;
      }
      if (['/api/bootstrap/audio', '/api/bootstrap/reference', '/api/bootstrap/prepare'].includes(route)) {
        if (caller !== origin || busy || current) throw Error('LOCAL_BOOTSTRAP_ONLY');
        if (route !== '/api/bootstrap/prepare') {
          busy = true;
          try {
          if (req.headers['content-type'] !== 'application/octet-stream') throw Error('BYTES_REQUIRED');
          const audio = route.endsWith('/audio'); const bytes = await body(req, audio ? 32 * 1024 * 1024 : 4 * 1024 * 1024);
          if (!valid() || !bytes.length) throw Error('SESSION_ENDED');
          if (audio) { stagedAudio?.fill(0); stagedAudio = bytes; } else { stagedReference?.fill(0); stagedReference = bytes; }
          send(200, {received: true}); return;
          } finally { busy = false; }
        }
        await jsonBody(req, []); if (!stagedAudio || !stagedReference) throw Error('BOTH_BOOTSTRAP_FILES_REQUIRED');
        busy = true;
        try {
          if (await inspectImage(stagedReference) !== true) throw Error('IMAGE_DECODE_REQUIRED');
          const prepared = await prepare({audioBytes: stagedAudio, referenceBytes: stagedReference});
          if (!valid()) throw Error('SESSION_ENDED');
          const source = await saveBootstrap({prepared, store: activeStore});
          if (!valid()) throw Error('SESSION_ENDED');
          current = source; clearUploads(); send(200, {phase: 'BOOTSTRAP_READY', actualPlayback: false});
        } finally { busy = false; }
        return;
      }
      if (route === '/api/artifact') {
        const b = await jsonBody(req, ['roomId', 'assetId']);
        if (b.roomId !== roomId || !id(b.assetId)) throw Error('ROOM_ASSET_REQUIRED');
        const result = await activeStore.read(b.assetId);
        if (!valid()) throw Error('SESSION_ENDED');
        // Session is already owner-bound; only the current private store is reachable.
        res.writeHead(200, {...noCache, 'Content-Type': 'application/octet-stream', 'X-Asset-Id': result.assetId,
          'X-Asset-Sha256': result.sha256, 'X-Asset-Type': result.contentType,
          'X-Asset-Provenance': JSON.stringify(Object.fromEntries(['kind', 'requestId', 'resultSha256'].filter(k =>
            typeof result.provenance?.[k] === 'string' && result.provenance[k].length <= 128).map(k => [k, result.provenance[k]])))}).end(result.bytes); return;
      }
      if (route === '/api/render') {
        const b = await jsonBody(req, ['roomId', 'cueId', 'expectedRevision']);
        if (b.roomId !== roomId || !id(b.cueId) || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 1 || !activeRuntime?.readRender)
          throw Error('TRUSTED_RENDER_RUNTIME_REQUIRED');
        // The runtime resolves authoritative cue/plan by ID. Browser QC/plan fields are refused.
        const r = await activeRuntime.readRender({...b, signal});
        if (!valid()) throw Error('SESSION_ENDED');
        if (!(r?.pcm instanceof Float32Array) || r.pcm.byteLength > 64 * 1024 * 1024) throw Error('VERIFIED_PCM_REQUIRED');
        const metadata = Object.fromEntries(['sampleRate', 'startFrame', 'durationFrames', 'expectedPlayedWindowSha256', 'renderedPcmSha256', 'renderedFileSha256'].map(k => [k, r[k]]));
        res.writeHead(200, {...noCache, 'Content-Type': 'application/octet-stream', 'X-Render-Metadata': JSON.stringify(metadata)})
          .end(Buffer.from(r.pcm.buffer, r.pcm.byteOffset, r.pcm.byteLength)); return;
      }
      send(404, {code: 'ROUTE_REQUIRED'});
    } catch (error) {
      // Never serialize exception messages: native paths/provider errors may contain secrets.
      const pairingCodes=new Set(['PAIRING_UNAVAILABLE','PAIRING_SESSION_ENDED','PAIRING_INPUT_INVALID','PAIRING_LIMIT',
        'PAIRING_UNKNOWN','PAIRING_ORIGIN_MISMATCH','PAIRING_USED','PAIRING_EXPIRED']);
      const reason=route==='/api/pair'&&pairingCodes.has(error.message)?error.message:'MAC_HOST_REQUEST_HELD';
      if(route==='/api/pair'){lastPairingReason=reason;diagnostic('PAIRING_FAILED',reason);}
      send(route === '/api/pair' ? 403 : 400, {code:reason});
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 30;
  async function issueCloudPairing(){
    if(!cloudOrigin||!gate?.read().active)throw Error('CLOUD_PAIRING_UNAVAILABLE');
    const activeGate=gate;
    if(await confirm({message:`公開owner画面へ一時接続します: ${cloudOrigin}`,confirmLabel:'接続コードを表示'})!==true)throw Error('OWNER_CANCELLED');
    if(gate!==activeGate)throw Error('SESSION_ENDED');
    diagnostic('CLOUD_CODE_SHOWN');await showPairing({...activeGate.issue(cloudOrigin),origin:cloudOrigin});
  }
  // Bounded byte counters locate stalls before HTTP parsing without observing
  // request data. The default parser/error handling is deliberately retained.
  let observedConnections=0;
  server.on('connection',socket=>{
    if(observedConnections++>=16)return;
    diagnostic('CONNECTION_ACCEPTED');
    socket.once('close',()=>diagnostic('CONNECTION_CLOSED',`received=${socket.bytesRead};sent=${socket.bytesWritten}`));
  });
  let companionConsent='',companionOwner='';
  const controls={
    async listen() {
      if (listening) return {origin};
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      origin = `http://127.0.0.1:${server.address().port}`; listening = true; return {origin};
    },
    async beginSession() {
      if (!listening || beginning) throw Error('LOCAL_LISTENER_REQUIRED');
      const sessionDeadline=Math.min(now()+lifetimeMs,expiresAtMs??Infinity);
      if(sessionDeadline-now()<1000)throw Error('MAC_TRIAL_EXPIRED');
      beginning=true;try{return await initializeSession();}finally{beginning=false;}
    },
    pairCloud:issueCloudPairing,
    async close() { listening = false;companionConsent='';companionOwner='';await endSession(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
    stop: endSession,
  };
  async function initializeSession({confirmed=false,showCode=true}={}){
      const sessionDeadline=Math.min(now()+lifetimeMs,expiresAtMs??Infinity);
      if(sessionDeadline-now()<1000)throw Error('MAC_TRIAL_EXPIRED');
      let replaced = false;
      try {
        if (!confirmed && await confirm({message: 'このMac内だけの一時セッションを開始します。キー使用・生成・公開は別操作です。', confirmLabel: 'セッション開始'}) !== true)
          throw Error('OWNER_CANCELLED');
        await endSession(); replaced = true; abort = new AbortController();
        const activeAbort = abort;
        store = await createStore();
        runtime = await createRuntime?.({roomId, store, signal: activeAbort.signal,sessionExpiresAtMs:sessionDeadline, readCurrent: () => {
          if (activeAbort.signal.aborted) throw Error('SESSION_ENDED');
          return structuredClone(current);
        }, updateCurrent: source => {
          if (activeAbort.signal.aborted) throw Error('SESSION_ENDED');
          current = structuredClone(source);
        }});
        if (activeAbort.signal.aborted) throw Error('SESSION_ENDED');
        if(loadBootstrap){
          const prepared=await loadBootstrap();
          if(activeAbort.signal.aborted)throw Error('SESSION_ENDED');
          current=await saveBootstrap({prepared,store});
          if(activeAbort.signal.aborted)throw Error('SESSION_ENDED');
          diagnostic('APPROVED_BOOTSTRAP_READY');
        }
        const remaining=sessionDeadline-now();if(remaining<1000)throw Error('MAC_TRIAL_EXPIRED');
        gate = createSessionGate({origins: [origin, ...(cloudOrigin ? [cloudOrigin] : [])], now, lifetimeMs:remaining, onExpire: () => { if(!companionMode)void endSession().catch(() => {}); }});
        if(!companionMode){timer = setTimeout(() => { void endSession().catch(() => {}); }, remaining); timer.unref?.();}
        if(showCode){const pair = gate.issue(origin); diagnostic('LOCAL_CODE_SHOWN');await showPairing({...pair, origin});}
        if (!gate?.read().active) throw Error('SESSION_ENDED');
        return {origin, expiresAt: gate.read().expiresAt};
      } catch (error) { if (replaced) await endSession(); throw error; }
  }
  startSession=()=>controls.beginSession();
  return controls;
}
