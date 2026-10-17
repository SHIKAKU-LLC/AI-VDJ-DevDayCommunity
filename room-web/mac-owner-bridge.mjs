// Explicit owner actions. Codes and credentials stay in memory and request
// bodies/headers; no URLs, status messages, logs or persistent storage.
const APPROVED_MAC_ORIGIN = 'http://127.0.0.1:54414';
// Must equal room-entry.html's vdj-mac-guide meta and the candidate's
// room-release.json macConnectionGuide (tests pin all three together).
export const GUIDE_REVISION = '2026-10-15-companion-3';
// This check needs no login, pairing code, room capability or native session.
export function mountMacPreflight({container,fetchImpl=globalThis.fetch,lifecycle=window,
  readPermission=async()=>{try{return (await navigator.permissions.query({name:'local-network-access'})).state;}catch{return 'unknown';}},
  schedule=setTimeout,cancel=clearTimeout}={}){
  const panel=document.createElement('section');panel.className='mac-preflight';
  panel.innerHTML=`<h3>最初に、このMacへの通信を確認</h3><p>ログイン・Macの本人確認・コード取得より先に確認できます。接続先は ${APPROVED_MAC_ORIGIN} です。</p>
    <button type="button" name="preflight">ログイン前にMacへの通信を確認</button>
    <p data-preflight-result role="status" aria-live="polite">コード・APIキーは使いません。生成・自動DJ・再生は開始しません。</p>`;
  container.prepend(panel);
  const button=panel.querySelector('[name=preflight]'),status=panel.querySelector('[data-preflight-result]');
  let closed=false,busy=false,controller=null,csp=false,reason=null,timer=null;
  const onCsp=e=>{if(e.effectiveDirective==='connect-src'&&(e.blockedURI===APPROVED_MAC_ORIGIN||e.blockedURI?.startsWith(APPROVED_MAC_ORIGIN+'/')))csp=true;};
  lifecycle.addEventListener('securitypolicyviolation',onCsp);
  button.onclick=async()=>{
    if(closed||busy)return;busy=true;csp=false;reason=null;button.disabled=true;
    status.textContent='Macへの通信を確認しています。Chromeが許可を求めた場合は本人が確認してください。';
    controller=new AbortController();timer=schedule(()=>{reason='timeout';controller?.abort();},5000);
    try{
      const response=await fetchImpl(APPROVED_MAC_ORIGIN+'/api/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',credentials:'omit',redirect:'error',signal:controller.signal});
      reason='response';const data=await response.json();if(closed)return;
      if(response.status!==403||data.code!=='LOCAL_STATUS_ONLY')throw Error('STATUS_UNEXPECTED');
      status.textContent='このMacへの通信を確認しました。次に本人ログインし、「既存ルームに接続し直す」で進めます。Macの本人確認はその後です。';
    }catch{
      if(closed)return;
      if(reason==='response'){status.textContent='Macから応答は届きましたが、接続確認の形式が違います。コード入力を始めず、Macホストを確認してください。';return;}
      const permission=await readPermission();if(closed)return;
      status.textContent=csp?'この文書のCSPが通信を遮断しています。新版の画面が必要です。':
        permission!=='granted'?'Chromeのローカルネットワーク許可が未確認です。本人が許可してから、このボタンで通信を確認してください。':
        reason==='timeout'?'Chromeの許可は有効ですが、Macから応答が届きません。ログインやコード入力を始めず、通信を確認してください。':
        'Chromeの許可は有効ですが通信を確認できません。ログインやコード入力を始めず、Macホストの稼働を確認してください。';
    }finally{cancel(timer);controller=null;busy=false;if(!closed)button.disabled=false;}
  };
  const dispose=()=>{if(closed)return;closed=true;controller?.abort();cancel(timer);button.disabled=true;};
  lifecycle.addEventListener('pagehide',dispose,{once:true});
  return {dispose(){dispose();lifecycle.removeEventListener('pagehide',dispose);lifecycle.removeEventListener('securitypolicyviolation',onCsp);panel.remove();}};
}
const pairingMessages = {
  PAIRING_EXPIRED: '公開画面用コードの2分の期限が切れました。白いMac画面で「公開owner用コードを表示」を押して、公開画面用コードだけを再表示してください。',
  PAIRING_USED: 'この公開画面用コードは使用済みです。白いMac画面で公開画面用コードだけを再表示してください。',
  PAIRING_ORIGIN_MISMATCH: 'ローカル画面用コードが入力されています。ここには、白いMac画面の「公開owner用コードを表示」で取得した公開画面用コードを入力します。',
  PAIRING_INPUT_INVALID: '公開画面用コードを入力してください。送信後は入力欄を空にするため、空欄だけでは前回未入力だったとは判断できません。',
  PAIRING_UNKNOWN: 'Macに通信は届きましたが、公開画面用コードを確認できませんでした。Macの確認画面にある公開画面用コードを確認してください。',
  PAIRING_UNAVAILABLE: 'Macの一時セッションは未開始です。手順2の本人確認とローカル接続を完了してください。',
  PAIRING_SESSION_ENDED: 'Macの一時セッションが終了しました。白いMac画面で状態を確認し、手順2から始めてください。',
  PAIRING_LIMIT: 'コード確認の試行回数が上限です。白いMac画面で一時セッションを開始し直してください。',
};
export function mountMacOwnerBridge({container,roomId,ownerCapability,fetchImpl=globalThis.fetch,lifecycle=window,
  schedule=setTimeout,cancel=clearTimeout,approvedOrigin=APPROVED_MAC_ORIGIN,versionFetch=globalThis.fetch,
  cloudOrigin=globalThis.location?.origin,onState=()=>{}} = {}) {
  // Tests inject an isolated loopback origin. Production keeps the approved
  // exact default and its independent fixed-port HTTP CSP.
  const allowed=new URL(approvedOrigin);
  if(allowed.origin!==approvedOrigin||allowed.protocol!=='http:'||allowed.hostname!=='127.0.0.1'||!allowed.port||allowed.username||allowed.password)throw Error('APPROVED_MAC_ORIGIN_REQUIRED');
  const panel=document.createElement('article');panel.className='panel mac-connection-panel';
  panel.innerHTML=`<div class="row"><h2>このMacへ一時接続</h2><span class="badge" data-phase>未接続</span></div>
    <p class="mac-next" data-next role="status" aria-live="polite">次は手順1：コードを取得する前に、Macへの通信を確認します。</p>
    <ol class="mac-stepper" aria-label="Mac接続の順番"><li data-step="1">1 通信を確認</li><li data-step="2">2 Macで本人確認</li><li data-step="3">3 公開コードで接続</li></ol>
    <section data-section="1"><h3>1. Macへの通信を確認</h3><p>コードを使わずに通信だけを確認します。公開画面はこのタブを開いたまま進めてください。</p>
      <label>Macアドレス <input name="local" type="url" value="${approvedOrigin}" autocomplete="off"></label>
      <button name="probe" type="button">Macへの通信を確認する</button>
      <p class="muted">Chromeがローカルネットワークへの接続許可を求めた場合は、対象サイトと接続先を本人が確認してください。許可は自動で変更しません。</p></section>
    <section data-section="2" hidden><h3>2. 白いMac画面で本人確認</h3>
      <p>既に白い画面に「接続済み」と出ている場合は、そのタブを使います。最初からやり直す必要はありません。</p>
      <ol><li>白い画面の<strong>「セッション開始 / コード再発行」</strong>（改善版では「Macで本人確認を始める」）を押して本人確認。</li>
      <li>Macの確認画面の<strong>ローカル画面用コード</strong>を、白い画面へ入力して<strong>「接続する」</strong>。</li>
      <li>ローカル接続が済んだらこの黒い画面に戻り、下のボタンで<strong>公開コード入力へ進みます</strong>。公開画面用コードは、入力欄を準備してから表示します。</li></ol>
      <a name="open-local" href="${approvedOrigin}/" target="_blank" rel="noopener noreferrer">白いMac画面が開いていない場合に開く ↗</a>
      <p class="muted">ローカル画面用コードは白い画面へ。公開画面用コードは手順3の黒い公開画面へ。コードはチャットに送りません。</p>
      <button name="ready" type="button">ローカル接続を完了したので、公開コード入力へ進む</button></section>
    <section data-section="3" hidden><h3 data-connect-title>3. 公開画面用コードをこの黒い画面に入力</h3><div data-code-entry>
      <p>入力欄の準備ができました。白いMac画面の<strong>「公開owner用コードを表示」</strong>（改善版では「公開画面用コードをMacに表示」）を押し、Macの確認画面を本人が操作してから、公開画面用コードをこの欄へ入力します。</p>
      <label>公開画面用コード（2分以内・一回限り） <input name="code" type="password" autocomplete="off" spellcheck="false"></label>
      <p class="muted">送信後は安全のため入力欄を空にします。接続結果は下に表示します。</p>
      <button name="connect" type="button" disabled>公開画面用コードでMacに接続</button></div>
      <button name="refresh" type="button" disabled>接続結果だけを再確認</button>
      <button name="back" type="button">白いMac画面の手順をもう一度見る</button></section>
    <p data-result role="status" aria-live="polite">未接続。通信確認から始めてください。</p>
    <button name="recheck" type="button" hidden>コードを使わず通信を再確認</button>
    <details data-update><summary>画面が古いとき・更新の確認</summary>
      <button name="check-version" type="button">接続画面の更新を確認</button><p data-version-status role="status" aria-live="polite"></p>
      <div data-update-warning hidden><p>新しい接続画面を使えます。今のタブを保持したまま、別タブで最新版を開いてください。</p>
      <a name="open-latest" href="/room?macGuide=${GUIDE_REVISION}" target="_blank" rel="noopener noreferrer">最新版の接続画面を別タブで開く ↗</a>
      <p class="muted">ログイン情報やコードは別タブへ渡しません。新しいタブで本人がログインし、既存ルームへ接続してください。今のタブの再読み込みも、ログイン情報を破棄します。</p></div></details>
    <p class="muted">接続は公開ルームの投稿をMacへ渡す準備です。音楽・映像の生成、自動DJ、再生は開始しません。</p>`;
  (container.prepend ?? container.append).call(container,panel);
  const field=selector=>panel.querySelector(selector), input=field('[name=local]'),code=field('[name=code]'),
    probe=field('[name=probe]'),ready=field('[name=ready]'),button=field('[name=connect]'),refresh=field('[name=refresh]'),
    status=field('[data-result]'),next=field('[data-next]'),phase=field('[data-phase]');
  input.value=approvedOrigin;
  let target='',session='',owner=ownerCapability,closed=false,busy=false,reached=false,readyForCode=false,attached=false;
  let nativeActivated=false,sessionExpiresAt=0;
  let cspBlocked=false,lastFailure=false,expiryTimer;const pending=new Set();
  const state=()=>({paired:!!session&&!closed,attached:!!session&&attached&&!closed,
    runtimeActivated:!!session&&attached&&nativeActivated&&!closed,
    nativeReady:!!session&&attached&&nativeActivated&&!closed&&Date.now()<sessionExpiresAt});
  const publish=()=>{try{onState(state());}catch{}};
  const render=()=>{
    const stage=attached?0:readyForCode?3:reached?2:1;
    for(let n=1;n<=3;n++) {
      const step=field(`[data-step="${n}"]`);
      step.setAttribute('data-state',attached||n<stage?'done':n===stage?'current':'waiting');
      if(n===stage)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');
    }
    field('[data-section="1"]').hidden=reached;
    field('[data-section="2"]').hidden=!reached||readyForCode;
    field('[data-section="3"]').hidden=!readyForCode;
    field('[data-code-entry]').hidden=!!session;
    field('[data-connect-title]').textContent=attached?'3. 公開ルームとMacの接続を確認しました':session?'3. Macコード確認済み・公開ルーム接続待ち':'3. 公開画面用コードをこの黒い画面に入力';
    field('[name=back]').hidden=!!session;field('[name=back]').disabled=closed||busy;
    field('[name=recheck]').hidden=!reached||!!session;field('[name=recheck]').disabled=closed||busy;
    const blocked=cspBlocked&&lastFailure;
    phase.textContent=closed?'接続終了':blocked?'画面の更新待ち':attached?'接続済み':session?'Macコード確認済み':reached?'通信確認済み':'未接続';
    field('[name=check-version]').disabled=closed;
    next.textContent=closed?'この画面の接続情報は終了しています。新しい公開画面を開いてください。'
      :blocked?'この画面の通信制限が接続を遮断しています。下の「最新版の接続画面を別タブで開く」から新しい画面へ進めます。'
      :attached?'公開ルームとMacの接続を確認しました。生成・自動DJ・再生は未実行です。'
      :session?'Mac側のコードは確認済みです。「接続結果だけを再確認」で公開ルームとの接続を確認します。'
      :stage===3?'次は手順3：公開画面用コードをこの黒い画面に入力してください。'
      :stage===2?'次は手順2：白いMac画面でローカル接続を完了してください。'
      :'次は手順1：コードを取得する前に、Macへの通信を確認します。';
    input.disabled=closed||busy||!!session;
    probe.disabled=closed||busy||!!session||blocked;ready.disabled=closed||busy||blocked;
    code.disabled=closed||busy||!!session||!readyForCode||blocked;
    button.disabled=closed||busy||!!session||!readyForCode||!code.value.trim()||blocked;
    refresh.disabled=closed||busy||!session;
  };
  const validateAddress=()=>{
    let url;try{url=new URL(input.value.trim());}catch{throw Error('MAC_ADDRESS_INVALID');}
    if(url.origin!==approvedOrigin||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('MAC_ADDRESS_INVALID');
    target=url.origin;input.value=target;
  };
  const markCsp=event=>{
    if(event.effectiveDirective!=='connect-src'||!(event.blockedURI===approvedOrigin||event.blockedURI?.startsWith(approvedOrigin+'/')))return;
    cspBlocked=true;
    if(lastFailure)status.textContent='このタブの通信制限がMac接続を遮断しています。コードは原因と判断できません。このタブを保持し、修正済みの新しい公開画面を開いてください。';
    field('[data-update]').open=true;field('[data-update-warning]').hidden=false;
    field('[data-version-status]').textContent='この画面の通信制限がMac接続を遮断しています。更新の案内から新しい接続画面を開けます。';
    render();
  };
  lifecycle.addEventListener('securitypolicyviolation',markCsp);
  const request=async(path,body,{withSession=true,probeOnly=false}={})=>{
    if(closed)throw Error('MAC_CONNECTION_CLOSED');
    const controller=new AbortController();pending.add(controller);
    try{
      const credential=withSession?session:'';
      const headers=new Headers({'Content-Type':'application/json'});if(credential)headers.set('X-VDJ-Session',credential);
      let response;try{response=await fetchImpl(target+path,{method:'POST',headers,body:JSON.stringify(body),credentials:'omit',
        redirect:'error',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});}
      catch(error){throw Error(cspBlocked?'MAC_CSP_BLOCKED':error.name==='TimeoutError'?'MAC_NETWORK_TIMEOUT':'MAC_NETWORK_HELD');}
      if(closed)throw Error('MAC_CONNECTION_CLOSED');
      let result;try{result=await response.json();}catch{throw Error('MAC_RESPONSE_INVALID');}
      if(closed)throw Error('MAC_CONNECTION_CLOSED');
      if(credential&&session!==credential)throw Error('SESSION_REQUIRED');
      // The existing local-only status endpoint denies the public caller; this
      // denial proves reachability without disclosing local session state.
      if(probeOnly&&response.status===403&&result.code==='LOCAL_STATUS_ONLY')return {reached:true};
      if(!response.ok){const known=new Set([...Object.keys(pairingMessages),'SESSION_REQUIRED']);throw Error(known.has(result.code)?result.code:'MAC_ROOM_HELD');}
      if(probeOnly)throw Error('MAC_RESPONSE_INVALID');
      return result;
    }finally{pending.delete(controller);}
  };
  const showError=error=>{
    lastFailure=true;
    if(['PAIRING_UNAVAILABLE','PAIRING_SESSION_ENDED','PAIRING_LIMIT','SESSION_REQUIRED'].includes(error.message))readyForCode=false;
    status.textContent=pairingMessages[error.message]??{
      MAC_ADDRESS_INVALID:`この公開画面が接続できるMacアドレスは ${approvedOrigin} だけです。アドレスを確認してください。`,
      MAC_CSP_BLOCKED:'このタブの通信制限がMac接続を遮断しています。コードは原因と判断できません。このタブを保持し、修正済みの新しい公開画面を開いてください。',
      MAC_NETWORK_HELD:'ブラウザからMacへの通信を確認できません。コードが間違っているとは判断できません。白いMac画面の稼働表示と、Chromeのローカルネットワーク許可を確認してください。',
      MAC_NETWORK_TIMEOUT:'Macへの応答待ちが時間切れです。コードの再入力はせず、白いMac画面の稼働表示とブラウザの許可を確認してください。',
      MAC_ROOM_HELD:session?'Mac側のコードは確認済みですが、公開ルームとの接続は保留です。コードを再取得せず「接続結果だけを再確認」を押してください。':'Macから応答はありましたが、接続を完了できません。白いMac画面の状態を確認してください。',
      SESSION_REQUIRED:'Macの一時接続が失効しました。白い画面のセッション状態を確認してください。',
      MAC_RESPONSE_INVALID:'接続先から想定した応答を確認できません。Macアドレスと起動画面を確認してください。',
      MAC_CONNECTION_CLOSED:'この画面の接続は終了しました。新しい公開画面を開いてください。',
    }[error.message]??'接続結果を確認できません。コードは自動で再送しません。';
  };
  probe.onclick=async()=>{
    if(probe.disabled)return;busy=true;cspBlocked=false;lastFailure=false;render();
    status.textContent='コードを使わずMacへの通信を確認しています。ブラウザの接続許可が出た場合は本人が確認してください。';
    try{validateAddress();await request('/api/status',{}, {withSession:false,probeOnly:true});reached=true;status.textContent='Macへの通信を確認しました。次は白いMac画面の本人確認・ローカル接続です。';}
    catch(error){reached=false;readyForCode=false;showError(error);}finally{busy=false;render();}
  };
  ready.onclick=()=>{if(ready.disabled||!reached)return;readyForCode=true;status.textContent='白い画面で公開owner用コードを表示し、ここへ公開画面用コードを入力してください。';render();};
  field('[name=back]').onclick=()=>{if(closed||busy||session)return;readyForCode=false;render();};
  field('[name=recheck]').onclick=()=>probe.onclick();
  field('[name=check-version]').onclick=async()=>{
    const check=field('[name=check-version]');if(closed||check.disabled)return;check.disabled=true;
    try{
      const response=await versionFetch('/room-release.json',{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error();const release=await response.json();if(closed)return;
      if(typeof release.macConnectionGuide!=='string')throw Error();
      const changed=release.macConnectionGuide!==GUIDE_REVISION;
      field('[data-update-warning]').hidden=!changed&&!cspBlocked;
      field('[data-version-status]').textContent=changed?'新しい接続画面が公開されています。このタブはそのまま保管できます。':cspBlocked?'接続ガイドの版は一致しますが、この文書の通信制限が接続を遮断しています。新しい公開画面を別タブで開いてください。':'このタブの接続ガイドは公開中の版と一致しています。';
    }catch{if(!closed){field('[data-update-warning]').hidden=false;field('[data-version-status]').textContent='更新状況を確認できません。今のタブを保持して、新しい接続画面を別タブで開けます。';}}
    finally{check.disabled=closed;}
  };
  input.oninput=()=>{if(!session){reached=false;readyForCode=false;}render();};code.oninput=render;
  const attach=async()=>{const result=await request('/api/owner/connect',{roomId,ownerCapability:owner});attached=true;nativeActivated=false;publish();
    status.textContent=`公開ルームとMacに接続済み。投稿${result.submissions}件を確認。生成・自動DJ・再生は未実行です。`;};
  const expire=()=>{session='';attached=false;nativeActivated=false;sessionExpiresAt=0;code.value='';cancel(expiryTimer);
    for(const controller of pending)controller.abort();publish();status.textContent='Macの一時接続の期限が切れました。白いMac画面の状態を確認してから、必要な手順だけやり直してください。';render();};
  button.onclick=async()=>{
    if(button.disabled)return;busy=true;lastFailure=false;cspBlocked=false;render();
    const pairing=code.value.trim();code.value='';
    status.textContent='公開画面用コードをMacで確認しています。入力欄は送信後に消去されます。';
    try{
      validateAddress();const paired=await request('/api/pair',{code:pairing},{withSession:false});
      if(!/^[A-Za-z0-9_-]{43}$/.test(paired.session??'')||!Number.isSafeInteger(paired.expiresAt)||paired.expiresAt<=Date.now())throw Error('MAC_RESPONSE_INVALID');
      session=paired.session;sessionExpiresAt=paired.expiresAt;publish();
      expiryTimer=schedule(expire,Math.max(0,paired.expiresAt-Date.now()));
      await attach();
    }catch(error){if(error.message==='SESSION_REQUIRED')expire();showError(error);}finally{busy=false;render();}
  };
  refresh.onclick=async()=>{
    if(refresh.disabled)return;busy=true;lastFailure=false;render();
    try{if(!attached)await attach();else{const result=await request('/api/owner/state',{});
      nativeActivated=result.runtimeActivated===true;publish();
      status.textContent=`公開ルームとMacに接続済み。投稿${result.submissions}件を確認。生成・自動DJ・再生は未実行です。`;}}
    catch(error){if(error.message==='SESSION_REQUIRED')expire();showError(error);}finally{busy=false;render();}
  };
  const dispose=()=>{
    if(closed)return;closed=true;owner='';nativeActivated=false;sessionExpiresAt=0;code.value='';cancel(expiryTimer);publish();
    for(const controller of pending)controller.abort();pending.clear();
    if(session){const headers=new Headers({'Content-Type':'application/json','X-VDJ-Session':session});void fetchImpl(target+'/api/stop',{method:'POST',headers,body:'{}',credentials:'omit',redirect:'error',keepalive:true}).catch(()=>{});}session='';attached=false;render();
  };
  const onShow=event=>{if(event.persisted&&closed){status.textContent='この画面を離れたためMac接続は終了しました。古い接続済み表示は引き継ぎません。新しい公開画面でログインと既存ルーム接続を確認してください。';render();}};
  lifecycle.addEventListener('pagehide',dispose,{once:true});lifecycle.addEventListener('pageshow',onShow);render();
  async function productionFetch(path,options={}){
    if(!state().nativeReady)throw Error('MAC_NATIVE_SESSION_REQUIRED');
    if(typeof path!=='string'||!path.startsWith(`/api/rooms/${roomId}/`)||typeof cloudOrigin!=='string'||
      !cloudOrigin.startsWith('https://'))throw Error('MAC_NATIVE_ROUTE_REQUIRED');
    const local=new URL(path,target),logical=new URL(path,cloudOrigin);
    if(path!==local.pathname+local.search||local.origin!==target||logical.origin!==cloudOrigin||
      local.hash||logical.hash||!local.pathname.startsWith(`/api/rooms/${roomId}/`))throw Error('MAC_NATIVE_ROUTE_REQUIRED');
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
    const credential=session,controller=new AbortController();pending.add(controller);
    const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    try{
      // keepalive lets an unload-time Stop outlive the closing owner page.
      const response=await fetchImpl(target+path,{method,headers,...(options.body===undefined?{}:{body:options.body}),...(options.keepalive===true?{keepalive:true}:{}),
        credentials:'omit',redirect:'error',cache:'no-store',signal});
      if(response.status===401){expire();throw Error('MAC_NATIVE_SESSION_REQUIRED');}
      if(!state().nativeReady||session!==credential||signal.aborted||response.redirected||response.url&&response.url!==target+path)
        throw Error('MAC_NATIVE_SESSION_REQUIRED');
      // Existing playback checks compare the logical API URL. Every body read
      // remains bounded by the current paired session and its absolute expiry.
      const reader=response.body?.getReader();
      const body=reader?new ReadableStream({async pull(out){
        if(!state().nativeReady||session!==credential||signal.aborted){await reader.cancel().catch(()=>{});out.error(Error('MAC_NATIVE_SESSION_REQUIRED'));return;}
        try{const part=await reader.read();
          if(!state().nativeReady||session!==credential||signal.aborted)throw Error('MAC_NATIVE_SESSION_REQUIRED');
          if(part.done)out.close();else out.enqueue(part.value);
        }catch(error){await reader.cancel().catch(()=>{});out.error(error);}
      },cancel(){return reader.cancel();}},{highWaterMark:0}):null;
      const result=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      Object.defineProperty(result,'url',{value:logical.href});return result;
    }finally{pending.delete(controller);}
  }
  return{state,productionFetch,dispose(){dispose();lifecycle.removeEventListener('pagehide',dispose);lifecycle.removeEventListener('pageshow',onShow);lifecycle.removeEventListener('securitypolicyviolation',markCsp);panel.remove();}};
}

// Selection is sticky: a stopped or expired native session never silently
// falls back to a cloud endpoint for an owner operation.
export function createOwnerProductionRouter({bridge,cloudFetch=globalThis.fetch}={}){
  if(typeof bridge!=='function'||typeof cloudFetch!=='function')throw Error('OWNER_PRODUCTION_ROUTER_REQUIRED');
  let selected=false,closed=false;
  return Object.freeze({
    selectNative(){if(closed||bridge()?.state()?.nativeReady!==true)throw Error('MAC_NATIVE_SESSION_REQUIRED');selected=true;},
    fetch(path,options){if(closed)throw Error('OWNER_PRODUCTION_ROUTER_CLOSED');
      if(selected){const native=bridge();if(!native?.state()?.nativeReady)throw Error('MAC_NATIVE_SESSION_REQUIRED');return native.productionFetch(path,options);}
      return cloudFetch(path,options);},
    selected:()=>selected,close(){closed=true;},
  });
}
