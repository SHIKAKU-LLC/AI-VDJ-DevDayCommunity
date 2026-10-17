import {createRoomApiClient} from './rooms/room-api-client.mjs';
import {createRoomModelPort} from './rooms/room-model-port.mjs';
import {createRoomUIModel} from './rooms/room-ui-model.mjs';
import {mountRoomComponents} from './rooms/room-components.mjs';
import qrcode from './qr-encoder.mjs';
import {mountCloudOwnerControls} from './cloud-owner-controls.mjs';
import {createCloudOutputBridge} from './cloud-output-bridge.mjs';
import {createCloudOwnerPlaybackController} from './cloud-playback.mjs';
import {mountOwnerSetup} from './owner-setup.mjs';
import {createOwnerSetupCapabilityRefresh} from './owner-setup-model.mjs';
const $=id=>document.getElementById(id),route=location.pathname;
const participant=route.startsWith('/join/'),roomId=participant?route.split('/')[2]:null;
// Invitation/legacy implicit returns never create a session. Owner capabilities
// are never accepted from URL fragments or query parameters.
if(!participant&&(location.hash||location.search))history.replaceState(null,'','/room');
const joinCode=new URL(location.href).searchParams.get('code');
let mountEpoch=0,model=null,port=null,components=null,ownerSetup=null,cloudControls=null,outputBridge=null,capabilities=null,interval=null,disposed=false;
const messages={OWNER_LOGIN_NOT_CONFIGURED:'owner認証はまだ設定されていません。',OWNER_DENIED:'ログインを確認してください。',ROOM_ALREADY_ACTIVE:'既存ルームに接続し直してください。',ROOM_NOT_FOUND:'接続できるルームがありません。',ACCEPTANCE_OFF:'参加受付はOFFです。',ROOM_EXPIRED:'ルームの受付時間を終了しました。',ROOM_BACKEND_UNAVAILABLE:'公開受付サーバーは未接続です。',PROVIDER_NOT_CONNECTED:'生成は未接続です。アイデアを保留しています。',RATE_LIMITED:'少し待ってから操作してください。'};
async function request(path,options={},fetcher=fetch){
 const headers=new Headers(options.headers);if(options.body!==undefined)headers.set('Content-Type','application/json');
 let response;try{response=await fetcher(path,{...options,headers,body:options.body===undefined?undefined:JSON.stringify(options.body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(options.timeoutMs===300000?300000:options.timeoutMs===125000?125000:10000)});}catch{throw Error('送信結果が不明です。同じ受付の状態を確認してください。');}
 let data;try{data=await response.json();}catch{throw Object.assign(Error('ROOM_BACKEND_UNAVAILABLE'),{definitive:response.status<500});}
 if(!response.ok)throw Object.assign(Error(data.error??'ROOM_BACKEND_UNAVAILABLE'),{status:response.status,code:data.error,definitive:response.status>=400&&response.status<500});
 if(disposed)throw Error('TAB_CLOSED');return data;
}
// The owner room session survives a reload of THIS tab only (sessionStorage is
// per tab and cleared when it closes). Nothing goes to persistent browser
// storage, cookies or URLs, and participants never store it.
const SESSION_KEY='ai-vdj-owner-room-v1';
const saveSession=raw=>{try{sessionStorage.setItem(SESSION_KEY,JSON.stringify(raw));}catch{}};
const loadSession=()=>{try{const raw=JSON.parse(sessionStorage.getItem(SESSION_KEY)??'null');
 return raw&&/^[a-f0-9-]{36}$/i.test(raw.roomId??'')&&/^[a-f0-9]{64}$/.test(raw.ownerToken??'')?raw:null;}catch{return null;}};
const clearSession=()=>{try{sessionStorage.removeItem(SESSION_KEY);}catch{}};
let fullscreenTried=false,unloadStop=null;
// Registered before any mount (and in the capture phase) so the unload-safe
// Stop is dispatched before the ordinary disposal chain; the request starts synchronously inside this handler.
window.addEventListener('pagehide',()=>{try{unloadStop?.();}catch{}},{capture:true,once:true});
const enterFullscreen=()=>{const stage=$('show-stage');if(!stage||stage.hidden||document.fullscreenElement)return;
 try{void stage.requestFullscreen?.().catch(()=>{});}catch{}};
function showError(e){$('login-status').textContent=messages[e.code??e.message]??'受付サーバーとの接続を確認してください。';}
function drawQR(raw){
 const url=new URL(raw.joinUrl);if(url.origin!==location.origin||url.pathname!=='/join/'+raw.roomId||url.searchParams.get('code')!==raw.joinCode||Array.from(url.searchParams.keys()).some(k=>k!=='code'))throw Error('JOIN_URL_INVALID');
 const qr=qrcode(0,'M');qr.addData(url.href,'Byte');qr.make();
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),size=qr.getModuleCount();
 svg.setAttribute('viewBox',`0 0 ${size+8} ${size+8}`);svg.setAttribute('width','100%');svg.setAttribute('height','100%');svg.setAttribute('role','img');svg.setAttribute('aria-label','このルームへの参加QR');
 const background=document.createElementNS(ns,'rect');background.setAttribute('width','100%');background.setAttribute('height','100%');background.setAttribute('fill','white');svg.append(background);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.isDark(y,x)){const cell=document.createElementNS(ns,'rect');cell.setAttribute('x',String(x+4));cell.setAttribute('y',String(y+4));cell.setAttribute('width','1');cell.setAttribute('height','1');cell.setAttribute('fill','black');svg.append(cell);}
 $('qr-slot').replaceChildren(svg);$('qr-slot').setAttribute('aria-label','このルームへの参加QR');
 $('show-qr').replaceChildren(svg.cloneNode(true));$('show-join-url').textContent=url.host+url.pathname.replace(/^(\/join\/.{8}).*$/,'$1…');
 const link=document.createElement('a');link.href=url.href;link.textContent=url.href;$('join-url').replaceChildren(link);
}
async function mount(raw=null){
 const mounted=++mountEpoch;ownerSetup?.dispose();ownerSetup=null;
 await cloudControls?.dispose();cloudControls=null;outputBridge?.dispose();outputBridge=null;
 components?.dispose();model?.dispose();port?.dispose();clearInterval(interval);
 const roomRequest=raw?(path,options)=>request(path,{...options,timeoutMs:300000}):request;
 const client=createRoomApiClient({request:roomRequest,roomId:raw?.roomId??roomId,joinCode:raw?.joinCode??joinCode,ownerToken:raw?.ownerToken,enabled:true});
 port=createRoomModelPort({client,owner:!participant});model=createRoomUIModel({port});
 components=mountRoomComponents({model,role:participant?'participant':'owner',ownerSubmit:participant?null:prompt=>model.submit('オーナー',prompt)});
 model.subscribe(state=>{
  // Collect mode keeps all generation and playback controls visibly disabled.
  if(state.room?.mode==='collect'){
   $('resume-generation').disabled=true;$('pause-generation').disabled=true;
   $('credit-state').textContent='アイデア受付のみ / 音楽・映像生成・自動DJは未接続';
   $('next-state').textContent='アイデアを保留中 · 生成は未接続';
  }
  cloudControls?.refresh();
 });
 if(raw){
  const ownerFetch=(path,options)=>fetch(path,options);
  const ownerRequest=(path,options)=>request(path,{...options,timeoutMs:300000},ownerFetch);
  const holdControls=()=>{if(mountEpoch!==mounted)return;capabilities={...capabilities,generation:false,autoDJ:false,
    cloud:{...capabilities?.cloud,generationJobs:false,portableQC:false,browserPlayback:false,playerObserver:false}};
   cloudControls?.setCapabilities?.(capabilities);};
  const refreshCapabilities=async()=>{
   const next=await request('/api/room-capabilities');
   if(disposed||mountEpoch!==mounted)return false;
   capabilities=next;cloudControls?.setCapabilities?.(next);return true;
  };
  const materialCapabilities=createOwnerSetupCapabilityRefresh({refresh:refreshCapabilities,
   isCurrent:()=>!disposed&&mountEpoch===mounted,onError:holdControls});
  if(capabilities?.serverManaged===true&&capabilities.generation!==true){
   const pending=document.createElement('p');pending.textContent='サーバー側の生成処理を準備しています。現在はアイデアの受付のみ利用できます。';
   $('cloud-setup').replaceChildren(pending);
  }else{
   ownerSetup=mountOwnerSetup({container:$('cloud-setup'),roomId:raw.roomId,
    request:(path,options)=>ownerRequest(path,{...options,...(/\/operator\/(?:status|media\/(?:begin|chunk|finish)|trial\/(?:prepare|start|status))$/.test(path)?{timeoutMs:300000}:{}),
     headers:{'X-Room-Owner':raw.ownerToken}}),
    onState:state=>materialCapabilities.observe(state)});
  }
  drawQR(raw);$('owner-login').hidden=true;$('show-stage').hidden=false;model.snapshot((await import('./rooms/room-contract-view.mjs')).roomView(raw));
  cloudControls=mountCloudOwnerControls({capabilities,openOutput:({onState})=>{
   const headers=new Headers({'X-Room-Owner':raw.ownerToken});
   outputBridge??=createCloudOutputBridge({origin:location.origin,enabled:true,
    enableClipRelativeTimeline:capabilities?.cloud?.clipRelativeTimeline===true,
    enablePlayerObserver:capabilities?.cloud?.playerObserver===true,observerRoomId:raw.roomId,
    request:(path,options)=>{const forwarded=new Headers(options?.headers);forwarded.set('X-Room-Owner',raw.ownerToken);
     return ownerFetch(path,{...options,headers:forwarded});},
    resolveManifest:({cue,plan})=>ownerRequest(`/api/rooms/${raw.roomId}/cloud/media/resolve`,{method:'POST',headers,body:{roomId:raw.roomId,cueId:cue.cueId,generationId:cue.generationId,submissionId:cue.submissionId,controlVersion:cue.controlVersion,commonIntentSha256:cue.commonIntentSha256,music:cue.music.asset,videos:cue.video.clips.map(({assetId,sha256})=>({assetId,sha256})),plan}}),
    embedIn:$('show-output'),
    onState:state=>{
     // The 開場 click inside the embedded output also activates this page, so
     // fullscreen can follow it immediately (once; F key or the button later).
     if(!fullscreenTried&&['PREPARING','READY','PLAYING'].includes(state.phase)){fullscreenTried=true;enterFullscreen();}
     onState(state);}});
   outputBridge.openOutput();return outputBridge;
  },autoOpen:true,onState:({phase})=>{$('show-stage').dataset.phase=phase;},createController:options=>createCloudOwnerPlaybackController({...options,request:ownerRequest,roomId:raw.roomId,ownerCapability:raw.ownerToken,
   onState:state=>{options.onState?.(state);if(state.state==='PLAYING'&&state.currentCredit)deliverCredit(state.currentCredit);}})});
  // The controller reports an accepted ACK once. Keep that credit and retry a
  // failed overlay delivery (bounded) until the bridge confirms it; a newer
  // credit or page teardown supersedes it. The overlay deduplicates itself.
  // Unload-safe Stop: started synchronously in pagehide with keepalive, so the
  // server releases the graph, reservation and credit even if the page closes
  // before the ordinary disposal chain finishes.
  unloadStop=()=>{
   // Once Start was issued a graph may exist even while the output still shows
   // READY. One keepalive request asks the server to stop the graph first and
   // the room's cues only with that graph's Stop receipt (never independently).
   if(cloudControls?.started!==true)return;
   const headers=new Headers({'X-Room-Owner':raw.ownerToken,'Content-Type':'application/json'});
   try{void Promise.resolve(ownerFetch(`/api/rooms/${raw.roomId}/player/unload-stop`,{method:'POST',headers,body:'{}',keepalive:true})).catch(()=>{});}catch{}
  };
  let creditToken=0;
  function deliverCredit(credit){
   const token=++creditToken;let attempt=0;
   const run=()=>{if(token!==creditToken||disposed||!outputBridge)return;
    outputBridge.showCredit(credit).catch(()=>{if(++attempt<5&&token===creditToken&&!disposed)setTimeout(run,1000);});};
   run();
  }
 }
 await model.load();if(raw)saveSession(raw);let polling=false;interval=setInterval(()=>{if(!document.hidden&&!polling){polling=true;void model.load().finally(()=>{polling=false;});}},5000);
}
const showOwnerNav=()=>{for(const button of document.querySelectorAll('nav button'))button.hidden=button.dataset.view==='participant';};
async function restoreSession(){
 const saved=loadSession();if(!saved)return false;
 try{capabilities=await request('/api/room-capabilities');$('owner-login').hidden=true;await mount(saved);showOwnerNav();return true;}
 catch{clearSession();return false;}
}
if(!participant){
 $('show-fullscreen').onclick=()=>enterFullscreen();
 document.addEventListener('keydown',event=>{if((event.key==='f'||event.key==='F')&&!event.target.closest?.('input,textarea'))enterFullscreen();});
 $('show-logout').onclick=()=>{clearSession();location.reload();};
}
async function judgeEntrance(){
 try{const value=await request('/api/room-capabilities');if(value.serverManaged!==true||value.mode!=='judge-cloud')return false;capabilities=value;}
 catch{return false;}
 for(const name of ['owner','join','participant','output'])$(name+'-view').hidden=true;
 for(const button of document.querySelectorAll('nav button'))button.hidden=true;
 $('owner-login').hidden=false;
 $('login-status').textContent=capabilities.generation===true
  ?'本日限定の審査用です。ルームを作成し、参加者のアイデアから音楽と映像を生成できます。アプリのインストールやAPIキーの登録は不要です。'
  :'ルームを作成してアイデアを受け付けられます。音楽・映像の生成は準備中です。アプリのインストールやAPIキーの登録は不要です。';
 const hex=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
 const admission={nonce:crypto.randomUUID(),ownerToken:hex(),joinCode:hex()};
 const button=$('create-room');button.disabled=false;button.textContent='審査用ルームを作成する';
 button.onclick=async()=>{button.disabled=true;try{const raw=await request('/api/judge/rooms',{method:'POST',body:admission});await mount(raw);showOwnerNav();}
  catch{button.disabled=false;$('login-status').textContent='受付上限・公開期限・接続状態をご確認ください。再試行しても同じルームとして受け付けます。';}};
 return true;
}
if(participant){$('owner-login').hidden=true;await mount();}
else if(await restoreSession()){}
else if(await judgeEntrance()){}
else{
 $('owner-login').hidden=false;$('create-room').disabled=true;
 $('login-status').textContent='サーバーの接続を準備しています。少し待ってからページを開き直してください。';
}
window.addEventListener('pagehide',()=>{disposed=true;clearInterval(interval);model?.dispose();port?.dispose();components?.dispose();
 // Stop server playback (output/observer/source and cue stop) through the
 // server first; finish disposal after it settles, with a bounded wait.
 const stopping=Promise.race([Promise.resolve().then(()=>cloudControls?.dispose()).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))]);
 void stopping.finally(()=>{ownerSetup?.dispose();outputBridge?.dispose();});
},{once:true});

window.addEventListener('pageshow',event=>{if(event.persisted&&disposed){$('login-status').textContent='このタブの接続は終了しました。ページを再読み込みしてください。';$('create-room').disabled=true;}});
