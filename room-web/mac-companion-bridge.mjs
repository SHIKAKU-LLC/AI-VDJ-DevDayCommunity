// Owner controls for the ordinary Mac companion. Capabilities and browser
// credentials live only in memory/request bodies, never in URLs or storage.
const MAC_ORIGIN='http://127.0.0.1:54414';
export function mountMacCompanionBridge({container,roomId,ownerCapability,
  fetchImpl=globalThis.fetch,lifecycle=window,cloudOrigin=globalThis.location?.origin,onState=()=>{},schedule=setTimeout,cancel=clearTimeout,now=Date.now}={}){
  const panel=document.createElement('article');panel.className='panel mac-connection-panel';
  panel.innerHTML=`<div class="row"><h2>このMacに接続</h2><span class="badge" data-phase>未接続</span></div>
    <p data-result role="status" aria-live="polite">Mac companionを起動し、この画面で接続してください。初回はMacの確認画面で許可します。</p>
    <button name="connect" type="button">このMacに接続</button>
    <button name="refresh" type="button" disabled>接続状態を確認</button>
    <button name="stop" type="button" disabled>Mac接続を停止</button>
    <details><summary>Macの登録を解除</summary><p>登録の解除は停止とは別操作です。解除後の接続には本人確認が必要です。</p>
      <button name="unregister" type="button" disabled>このMacの登録を解除</button></details>
    <p class="muted">接続だけでは生成・課金・再生は始まりません。Macが未起動なら、既存launcherを起動してください。</p>`;
  (container.prepend??container.append).call(container,panel);
  const f=s=>panel.querySelector(s),status=f('[data-result]');
  let nativeActivated=false,runtimeExpiresAt=0,preparation='idle';
  const target=MAC_ORIGIN;
  let session='',owner=ownerCapability,phase='IDLE',busy=false,closed=false,registered=false,expiry=0,timer,revision=0;
  const pending=new Set();let pollTimer,renewTimer,renewalPromise;
  const pollNative=()=>{cancel(pollTimer);if(closed||!session)return;
    pollTimer=schedule(()=>{if(closed||!session)return;if(busy){pollNative();return;}
      void f('[name=refresh]').onclick();},1000);};
  // Native readiness comes only from the authenticated companion response.
  // Browser state cannot grant runtime or provider permissions.
  const state=()=>({paired:!!session&&!closed,attached:!!session&&phase==='CONNECTED'&&!closed,
    runtimeActivated:!!session&&nativeActivated&&!closed,
    nativeReady:!!session&&nativeActivated&&!closed&&phase==='CONNECTED'&&now()<expiry&&now()<runtimeExpiresAt});
  const reuseConnection=()=>!!session&&phase==='CONNECTED'&&now()<expiry&&preparation!=='hold'&&
    !(runtimeExpiresAt>0&&now()>=runtimeExpiresAt);
  const describeConnection=result=>preparation==='pending'?
    'Macへ接続しました。音源と映像を準備しています。完了までこのままお待ちください。再接続は不要です。':
    preparation==='hold'?'Macへの接続後、素材の準備でエラーが発生しました。接続状態を確認してください。':
    `このMacに接続済み。投稿${result.submissions}件を確認。接続の復帰だけでは生成・課金・再生を開始しません。`;
  const readReadiness=result=>{
    nativeActivated=result.runtimeActivated===true;runtimeExpiresAt=Number.isSafeInteger(result.expiresAtMs)?result.expiresAtMs:0;
    preparation=['hold','expired','closed'].includes(result.nativeOrchestration?.state)?'hold':nativeActivated?'ready':'pending';
  };
  const render=()=>{
    f('[data-phase]').textContent={IDLE:'未接続',CONNECTED:'接続済み',OFFLINE:'Macと通信できません',
      AUTH_EXPIRED:'接続認証の更新が必要',OWNER_AUTH:'owner認証を確認',STOPPED:'停止済み',CLOSED:'画面を終了'}[phase]??'接続を確認';
    if(phase==='CONNECTED'&&preparation==='pending')f('[data-phase]').textContent='接続済み・素材を準備中';
    if(phase==='CONNECTED'&&preparation==='hold')f('[data-phase]').textContent='接続済み・準備エラー';
    f('[name=connect]').textContent=reuseConnection()?preparation==='pending'?'接続済み・準備中':'このMacに接続済み':registered?'このMacに再接続':'このMacに接続';
    f('[name=connect]').disabled=busy||closed||!!renewalPromise||reuseConnection();
    f('[name=refresh]').disabled=busy||closed||!session;
    f('[name=stop]').disabled=busy||closed||!session;
    f('[name=unregister]').disabled=busy||closed||!registered;
    try{onState(state());}catch{}
  };
  const forgetSession=()=>{session='';nativeActivated=false;runtimeExpiresAt=0;preparation='idle';expiry=0;cancel(timer);cancel(pollTimer);cancel(renewTimer);revision++;};
  const publish=()=>render();
  const expire=()=>{forgetSession();phase='AUTH_EXPIRED';status.textContent='画面の接続認証が失効しました。Mac companionは稼働を続けます。この画面で再接続してください。';render();};
  async function request(path,body,{authenticated=true}={}){
    const credential=authenticated?session:'',generation=revision,controller=new AbortController();pending.add(controller);
    const headers=new Headers({'Content-Type':'application/json'});if(credential)headers.set('X-VDJ-Session',credential);
    try{
      let response;try{response=await fetchImpl(MAC_ORIGIN+path,{method:'POST',headers,body:JSON.stringify(body),
        credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(path==='/api/companion/connect'?120000:10000)])});}
      catch{throw Error('COMPANION_OFFLINE');}
      if(closed||generation!==revision)throw Error('COMPANION_CLOSED');
      const result=await response.json();
      if(closed||generation!==revision)throw Error('COMPANION_CLOSED');
      if(!response.ok)throw Error(['SESSION_REQUIRED','OWNER_AUTH_REQUIRED','OWNER_CANCELLED','COMPANION_BUSY',
        'COMPANION_UNAVAILABLE'].includes(result.code)?result.code:'COMPANION_HELD');
      return result;
    }finally{pending.delete(controller);}
  }
  const showError=e=>{
    if(closed)return;
    if(e.message==='SESSION_REQUIRED'){expire();return;}
    if(e.message==='COMPANION_OFFLINE'){
      phase='OFFLINE';status.textContent=session?'Macとの通信を確認できません。「接続状態を確認」で同じ接続の状態を確認してください。':
        'Mac companionへの通信を確認できません。Macの起動状態とChromeのローカルネットワーク許可を確認してください。';
    }else if(e.message==='OWNER_AUTH_REQUIRED'){
      forgetSession();phase='OWNER_AUTH';status.textContent='サーバーでowner権限を確認できません。ownerログインとルームの有効性を確認してください。';
    }else status.textContent={OWNER_CANCELLED:'Macの本人確認はキャンセルされました。この画面で再接続できます。',
      COMPANION_BUSY:'Macの接続確認が進行中です。Macの確認画面を操作してから状態を確認してください。',
      COMPANION_UNAVAILABLE:'起動中のMacホストは試験モードまたは旧版です。通常のcompanion launcherで起動してください。'}[e.message]??'接続結果は保留です。この画面で状態を確認してください。';
  };
  async function action(invoke){if(busy||closed)return;busy=true;render();try{await invoke();}catch(e){showError(e);}finally{busy=false;render();}}
  const scheduleRenew=()=>{cancel(renewTimer);if(!closed&&session)renewTimer=schedule(()=>void renew(),Math.max(1000,expiry-now()-300000));};
  function acceptConnection(result){
    if(result.connected!==true||typeof result.generationEnabled!=='boolean'||!Number.isSafeInteger(result.submissions)||result.submissions<0||
      !/^[A-Za-z0-9_-]{43}$/.test(result.session??'')||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=now())throw Error('COMPANION_HELD');
    forgetSession();session=result.session;expiry=result.expiresAt;registered=true;phase='CONNECTED';
    readReadiness(result);
    timer=schedule(expire,Math.max(0,expiry-now()));if(result.nativeOrchestration?.state==='pending')pollNative();
    scheduleRenew();
  }
  async function renew(){
    if(closed||!session||phase!=='CONNECTED'||renewalPromise)return;
    // Do not rotate during a pending request or private streamed body.
    if(pending.size||busy){renewTimer=schedule(()=>void renew(),1000);return;}
    const previous=session;
    renewalPromise=(async()=>{
      const result=await request('/api/companion/connect',{roomId,ownerCapability:owner},{authenticated:false});
      if(closed||session!==previous)throw Error('COMPANION_CLOSED');
      acceptConnection(result);
    })().catch(error=>{if(!closed){expire();showError(error);}}).finally(()=>{renewalPromise=null;render();});
    render();await renewalPromise;
  }
  f('[name=connect]').onclick=()=>{
    // A completed pairing remains the same connection throughout native
    // preparation and playback. Ignore even a programmatic repeated click.
    if(reuseConnection()){render();return Promise.resolve();}
    return action(async()=>{
    status.textContent='owner権限を確認しています。初回はMacの確認画面で接続を許可してください。';
    const result=await request('/api/companion/connect',{roomId,ownerCapability:owner},{authenticated:false});
    acceptConnection(result);
    status.textContent=describeConnection(result);
    });
  };
  f('[name=refresh]').onclick=()=>action(async()=>{
    const result=await request('/api/owner/state',{});
    if(result.connected!==true||typeof result.generationEnabled!=='boolean')throw Error('COMPANION_HELD');
    phase='CONNECTED';readReadiness(result);
    if(result.nativeOrchestration?.state==='pending')pollNative();else cancel(pollTimer);
    status.textContent=describeConnection(result);
  });
  f('[name=stop]').onclick=()=>action(async()=>{
    await request('/api/stop',{});forgetSession();phase='STOPPED';
    status.textContent='Mac接続を停止しました。登録の同意は保持しています。この画面で再接続できます。';
  });
  f('[name=unregister]').onclick=()=>action(async()=>{
    await request('/api/companion/unregister',{roomId,ownerCapability:owner},{authenticated:false});
    forgetSession();registered=false;phase='IDLE';status.textContent='Macの登録を解除しました。次の接続でMac本人の同意を確認します。';
  });
  const dispose=()=>{if(closed)return;closed=true;forgetSession();owner='';phase='CLOSED';
    for(const controller of pending)controller.abort();pending.clear();cancel(pollTimer);render();};
  // Leaving this tab forgets browser credentials; it does not stop the Mac or
  // unregister it. The next owner screen re-verifies the backend before resume.
  lifecycle.addEventListener('pagehide',dispose,{once:true});render();
  async function productionFetch(path,options={}){
    if(renewalPromise)await renewalPromise;
    if(!state().nativeReady)throw Error('MAC_NATIVE_SESSION_REQUIRED');
    if(typeof path!=='string'||!(path===`/api/rooms/${roomId}`||path.startsWith(`/api/rooms/${roomId}/`))||cloudOrigin!=='https://ai-vdj.vercel.app'||
      !cloudOrigin.startsWith('https://'))throw Error('MAC_NATIVE_ROUTE_REQUIRED');
    const local=new URL(path,target),logical=new URL(path,cloudOrigin);
    if(path!==local.pathname+local.search||local.origin!==target||logical.origin!==cloudOrigin||
      local.hash||logical.hash||!(local.pathname===`/api/rooms/${roomId}`||local.pathname.startsWith(`/api/rooms/${roomId}/`)))throw Error('MAC_NATIVE_ROUTE_REQUIRED');
    // Native Keychain verification is selected on the Mac. The existing
    // browser credential form must never relay a provider key into this path.
    if(local.pathname===`/api/rooms/${roomId}/operator/connection`)throw Error('MAC_NATIVE_CREDENTIAL_INPUT_REFUSED');
    if(local.search&&(!new RegExp(`^/api/rooms/${roomId}/(?:cloud/)?media/[A-Za-z0-9_-]{1,100}$`).test(local.pathname)||
      !/^\?sha256=[a-f0-9]{64}$/.test(local.search)))throw Error('MAC_NATIVE_ROUTE_REQUIRED');
    const method=options.method??'GET';if(!['GET','POST'].includes(method))throw Error('MAC_NATIVE_METHOD_REQUIRED');
    const headers=new Headers(options.headers);
    for(const name of headers.keys())if(name.toLowerCase()!=='content-type'&&name.toLowerCase()!=='x-room-owner')
      throw Error('MAC_NATIVE_HEADERS_REFUSED');
    headers.delete('x-room-owner');headers.set('X-VDJ-Session',session);
    const credential=session,controller=new AbortController();pending.add(controller);let reading=false;
    const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    try{
      // keepalive lets an unload-time Stop outlive the closing owner page.
      const response=await fetchImpl(target+path,{method,headers,...(options.body===undefined?{}:{body:options.body}),
        ...(options.keepalive===true?{keepalive:true}:{}),credentials:'omit',redirect:'error',cache:'no-store',signal});
      if(response.status===401){expire();throw Error('MAC_NATIVE_SESSION_REQUIRED');}
      if(!state().nativeReady||session!==credential||signal.aborted||response.redirected||response.url&&response.url!==target+path)
        throw Error('MAC_NATIVE_SESSION_REQUIRED');
      // Existing playback checks compare the logical API URL. Every body read
      // remains bounded by the current paired session and its absolute expiry.
      const reader=response.body?.getReader();reading=!!reader;
      const body=reader?new ReadableStream({async pull(out){
        if(!state().nativeReady||session!==credential||signal.aborted){pending.delete(controller);await reader.cancel().catch(()=>{});out.error(Error('MAC_NATIVE_SESSION_REQUIRED'));return;}
        try{const part=await reader.read();
          if(!state().nativeReady||session!==credential||signal.aborted)throw Error('MAC_NATIVE_SESSION_REQUIRED');
          if(part.done){pending.delete(controller);out.close();}else out.enqueue(part.value);
        }catch(error){pending.delete(controller);await reader.cancel().catch(()=>{});out.error(error);}
      },cancel(){pending.delete(controller);return reader.cancel();}},{highWaterMark:0}):null;
      const result=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      Object.defineProperty(result,'url',{value:logical.href});return result;
    }finally{if(!reading)pending.delete(controller);}
  }
  // The single-screen flow connects automatically after the room mounts. It
  // reuses the button's guarded handler, so a paired session is never repeated.
  return{state,productionFetch,connect:()=>f('[name=connect]').onclick(),dispose(){dispose();lifecycle.removeEventListener('pagehide',dispose);panel.remove();}};
}
