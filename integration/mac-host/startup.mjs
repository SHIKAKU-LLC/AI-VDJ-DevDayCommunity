import {createMacConnection} from './client.mjs';
import {createHostHealth} from './health.mjs';

const pairingMessage = {
  PAIRING_UNAVAILABLE: '手順1の本人確認を完了してから、ローカル画面用コードを入力してください。',
  PAIRING_SESSION_ENDED: 'セッションが終了しました。手順1から本人確認をやり直してください。',
  PAIRING_INPUT_INVALID: '手順2には、Macの確認画面のローカル画面用コードをそのまま入力してください。',
  PAIRING_UNKNOWN: 'ローカル画面用コードと一致しません。Macの確認画面を確認してください。',
  PAIRING_ORIGIN_MISMATCH: '公開画面用コードが入力されています。手順2にはローカル画面用コードを入力してください。',
  PAIRING_USED: 'ローカル画面用コードは使用済みです。手順1のボタンで新しいコードを取得してください。',
  PAIRING_EXPIRED: 'ローカル画面用コードの2分の期限が切れました。手順1のボタンで新しいコードを取得してください。',
  PAIRING_LIMIT: '試行回数の上限です。手順1から本人確認をやり直してください。',
};

// UI state only; codes and credentials never enter the guide or storage.
export function mountStartup({document: doc = globalThis.document, lifecycle = globalThis.window,
  origin = globalThis.location.origin, fetchImpl = globalThis.fetch, connect = createMacConnection,
  healthFactory = createHostHealth, schedule = setTimeout} = {}) {
  const byId = id => doc.getElementById(id);
  const show = text => { byId('status').textContent = text; };
  let connection, health, online = false, host = {}, sessionRequested = false, nativeConfirmation = false, cloudConfirmation = false;
  let starting = false, pairing = false, cloudRequest = false, preparing = false, cloudConnected = false;
  const render = () => {
    const paired = !!connection, step = paired ? (cloudConnected ? 0 : 3) : sessionRequested || host.sessionActive ? 2 : 1;
    for (let n = 1; n <= 3; n++) {
      if (online && step === n) byId(`step-${n}`).setAttribute('aria-current', 'step');
      else byId(`step-${n}`).removeAttribute('aria-current');
    }
    byId('next-action').textContent = !online ? 'Macホストとの通信を確認しています。画面を保持して、稼働状態を確認してください。'
      : nativeConfirmation ? 'Macの確認画面を本人が操作してください。コードを控えて確認画面を閉じると、手順2へ入力できます。'
      : cloudConnected ? '公開ルームとの接続を確認しました。生成・自動DJ・再生はまだ実行していません。'
      : cloudConfirmation ? 'Macの確認画面で公開画面用コードを確認し、黒い公開画面の手順3へ入力してください。'
      : step === 3 ? '手順3：公開画面の「このMacへ一時接続」を見つけてから、公開画面用コードをMacに表示してください。'
      : step === 2 ? '手順2：Macの本人確認を完了し、ローカル画面用コードをこの画面に入力してください。'
      : '手順1：「Macで本人確認を始める」を押してください。';
    byId('start-session').hidden = paired;
    byId('step-1').hidden = paired;
    byId('step-2').hidden = paired;
    byId('start-session').textContent = sessionRequested || host.sessionActive ? '本人確認をやり直してローカルコードを再発行' : 'Macで本人確認を始める';
    byId('start-session').disabled = !online || starting || pairing || nativeConfirmation;
    byId('restart-session').disabled = !online || starting || pairing || nativeConfirmation;
    byId('session-controls').hidden = !paired;
    byId('pairing').disabled = !online || paired || pairing || nativeConfirmation || !host.sessionActive;
    byId('connect').disabled = byId('pairing').disabled;
    byId('pair-cloud').disabled = !online || !paired || cloudRequest || nativeConfirmation || cloudConfirmation;
    byId('cloud-status').disabled = !online || !paired;
    byId('stop').disabled = !online || !paired;
    byId('bootstrap').disabled = !online || !paired || host.bootstrapReady === true || preparing;
    byId('media-status').textContent = online && host.bootstrapReady === true
      ? '現在のセッションで開始素材の検証・非公開保存が完了しています。生成・再生は未実行です。'
      : '承認済み開始素材が設定されている場合は、本人確認後に自動で検証・準備されます。';
  };
  byId('mac-address').textContent = origin;
  const begin = async () => {
    if (!online || starting || pairing || nativeConfirmation) return;
    starting = true; render();
    try {
      const r = await fetchImpl('/api/start-session', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
      if (!r.ok) { show(r.status === 409 ? 'Macの確認画面がすでに開いています。その確認画面を操作してください。' : '本人確認を開始できません。画面を保持してMacホストの稼働状態を確認してください。'); return; }
      sessionRequested = true;
      nativeConfirmation = true;
      show('Macの確認画面を本人が操作し、ローカル画面用コードを手順2へ入力してください。');
      void health.refresh();
    } catch { show('Macホストへ通信できません。画面を保持して稼働状態を確認してください。'); }
    finally { starting = false; render(); }
  };
  byId('start-session').onclick = begin;
  byId('restart-session').onclick = begin;
  byId('connect').onclick = async () => {
    if (byId('connect').disabled || pairing) return;
    pairing = true; render();
    const code = byId('pairing').value.trim(); byId('pairing').value = '';
    try {
      const r = await fetchImpl('/api/pair', {method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code})});
      const value = await r.json();
      if (!r.ok) throw Error(value.code ?? 'PAIRING_REFUSED');
      const activeConnection = connect({origin, session: value.session, onEnd: () => {
        if (connection !== activeConnection) return;
        connection = undefined; cloudConnected = false; sessionRequested = false; host = {};
        show('接続が終了しました。手順1から本人確認を始めてください。'); render();
      }});
      connection = activeConnection;
      show(`Mac画面に接続済み。有効期限: ${new Date(value.expiresAt).toLocaleTimeString()}。次は手順3です。生成は未実行です。`);
      schedule(() => { if (connection === activeConnection) activeConnection.forget(); }, Math.max(0, value.expiresAt - Date.now()));
      render();
      try {
        const state = await activeConnection.state();
        if (connection === activeConnection && state.phase === 'BOOTSTRAP_READY') {
          host.bootstrapReady = true;
          show('Mac画面に接続済み。承認済み開始素材も準備済みです。次は手順3で公開ルームへ接続してください。生成・再生は未実行です。');
        }
      } catch { if (connection === activeConnection) show('Mac画面に接続済み。開始素材の準備状況を確認できません。生成・再生は未実行です。'); }
    } catch (error) { show(pairingMessage[error.message] ?? 'Macホストへ通信できません。画面を保持して稼働状態を確認してください。'); }
    finally { pairing = false; render(); }
  };
  byId('pair-cloud').onclick = async () => {
    if (byId('pair-cloud').disabled || cloudRequest) return;
    cloudRequest = true; render();
    try {
      await connection.pairCloud();
      cloudConfirmation = true;
      show(`Macの確認画面の公開画面用コードを、公開owner画面「このMacへ一時接続」へ2分以内に入力してください。Macアドレスは ${origin} です。`);
    } catch { show('公開画面用コードを表示できません。Macの確認画面が開いているか、ローカル接続状態を確認してください。'); }
    finally { cloudRequest = false; render(); }
  };
  byId('cloud-status').onclick = async () => {
    if (byId('cloud-status').disabled) return;
    try {
      const state = await connection.ownerState(); cloudConnected = true;
      show(`公開ルームに接続済み。投稿${state.submissions}件を確認。生成・自動DJ・再生は未実行です。`);
    } catch { cloudConnected = false; show('公開ルームとの接続を確認できません。公開owner画面の「このMacへ一時接続」の表示を確認してください。公開コードだけを再発行する場合は手順3のボタンを使います。'); }
    render();
  };
  byId('prepare').onclick = async () => {
    if (byId('bootstrap').disabled || preparing) return;
    const audio = byId('audio').files[0], reference = byId('reference').files[0];
    if (!audio || !reference || audio.size > 32 * 1024 * 1024 || reference.size > 4 * 1024 * 1024) { show('規定サイズ内のWAVと画像を選んでください。'); return; }
    preparing = true; render(); show('このMac上で素材を検証しています。');
    try {
      await connection.bootstrap({audioBytes: await audio.arrayBuffer(), referenceBytes: await reference.arrayBuffer()});
      byId('audio').value = ''; byId('reference').value = ''; host.bootstrapReady = true;
      show('開始素材の検証・非公開保存が完了しました。生成・再生は未実行です。');
    } catch { show('素材の検証は保留です。開始素材とMac側の接続を確認してください。'); }
    finally { preparing = false; render(); }
  };
  byId('stop').onclick = () => connection?.stop().catch(() => show('ブラウザの接続情報は破棄しました。Mac側でも終了を確認してください。'));
  const onHide = () => {
    health.dispose(); void connection?.stop().catch(() => {});
    connection = undefined; online = false; host = {}; sessionRequested = false;
    nativeConfirmation = false; cloudConfirmation = false; cloudConnected = false;
    byId('pairing').value = ''; show('この画面を離れたため接続情報を破棄しました。戻った場合は手順1から始めてください。'); render();
  };
  const onShow = event => { if (event.persisted) health = startHealth(); };
  lifecycle.addEventListener('pagehide', onHide);
  lifecycle.addEventListener('pageshow', onShow);
  render();
  const startHealth = () => healthFactory({check: async () => {
    const response = await fetchImpl('/api/status', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', cache: 'no-store', signal: AbortSignal.timeout(2000)});
    if (!response.ok) throw Error(); return response.json();
  }, onState: ({online: available, status, dropConnection}) => {
    online = available;
    if (dropConnection && connection) connection.forget();
    if (status) {
      const wasConfirming = nativeConfirmation;
      nativeConfirmation = status.confirmationPending === true;
      cloudConfirmation = status.cloudCodePending === true;
      if (connection && status.sessionActive && status.localPaired === false) connection.forget();
      host = status;
      if (!host.sessionActive && !nativeConfirmation && !starting) {
        sessionRequested = false;
        if (wasConfirming) show('本人確認は完了していません。手順1のボタンからやり直せます。');
      } else if (wasConfirming && !nativeConfirmation && connection && host.localPaired === true) {
        sessionRequested = false; show('新しい本人確認は完了していません。現在の接続を維持しています。');
      }
    }
    byId('host-health').textContent = !online ? 'Macホストと通信できません。接続操作は停止しています。'
      : host.sessionActive ? 'Macホスト稼働中。一時セッションは有効です。' : 'Macホスト稼働中。一時セッションは未開始または終了しています。';
    render();
  }});
  health = startHealth();
  return {dispose() { onHide(); lifecycle.removeEventListener('pagehide', onHide); lifecycle.removeEventListener('pageshow', onShow); }};
}
if (typeof document !== 'undefined') mountStartup();
