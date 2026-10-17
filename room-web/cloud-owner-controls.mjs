// Cloud-first owner controls. The owner tab holds only the existing temporary
// proof; an output port receives commands/media/ACK, never this proof.
export function cloudReadiness(capabilities = {}) {
  const cloud = capabilities.cloud ?? {};
  const ready = capabilities.generation === true && capabilities.autoDJ === true &&
    cloud.generationJobs === true && cloud.portableQC === true && cloud.browserPlayback === true;
  return {ready, transport: 'same-origin', macRequired: false,
    message: ready ? 'クラウド生成・QC・ブラウザ出力を利用できます。' :
      'クラウド生成・QC・ブラウザ出力は準備中です。現在はアイデアを受付できます。'};
}

export function mountCloudOwnerControls({root = document, capabilities, openOutput,
  createController, onState = () => {}, autoOpen = false} = {}) {
  const $ = id => root.querySelector('#' + id);let readiness = cloudReadiness(capabilities);
  const open = $('cloud-open-output'), start = $('cloud-start'), stop = $('cloud-stop'),
    status = $('cloud-status');
  if (!open || !start || !stop || !status) throw Error('CLOUD_OWNER_CONTROLS_REQUIRED');
  let output = null, controller = null, closed = false, opening = null, busy = false, running = false, stopPending = false, autoOpened = false, ended = false;
  // Stop is meaningful only after a Start: before any graph or reservation a
  // cue Stop would mark the room stopped with no graph to prove a restart.
  let started = false;
  // The bounded code of the last HOLD/stop cause, shown so a production run
  // names what stopped it (never a value, URL or credential).
  let cause = null;
  // A Start that failed stays HOLD with its reason until the owner retries
  // Start or presses Stop; a READY/PLAYING output must not paint over it.
  let startFailed = null;
  const code = value => typeof value === 'string' && /^[A-Z0-9_:]{1,80}$/.test(value) ? value : null;
  function draw(state = null) {
    const phase = state?.state ?? (startFailed ? 'HOLD' : output?.read?.().phase);
    // While a stop settles, keep the cause that triggered it, not the stop's own echo.
    if (['HOLD', 'STOPPED'].includes(phase) && code(state?.reason) && !(stopPending && cause)) cause = code(state.reason);
    else if (['PLAYING', 'STAGING'].includes(phase)) cause = null;
    const suffix = ['HOLD', 'STOPPED'].includes(phase) && cause ? `（コード: ${cause}）` : '';
    const snapshot=output?.read?.();
    const outputReady = ['READY','PLAYING'].includes(snapshot?.phase)||
      snapshot?.phase==='PREPARING'&&snapshot?.sourceStartAvailable===true;
    open.disabled = closed || !readiness.ready || !!opening;
    start.disabled = closed || !readiness.ready || !outputReady || busy || running;
    stop.disabled = closed || !controller || stopPending || !started;
    status.textContent = !readiness.ready ? readiness.message :
      ended ? 'Cue が最後まで再生されました。次の Cue が間に合わなかったため待機しています（ルームは停止していません）。' +
        '再開するには「演奏停止」→「演奏開始」を押してください。（コード: CUE_DURATION_END）' :
      phase === 'PLAYING' ? '音声開始と映像提示を確認しました。' :
      phase === 'STAGING' ? '次のセットを出力に準備しています。' :
      phase === 'PREPARING' && running ? '音楽と映像の準備ができ次第、演奏を開始します。' :
      phase === 'STOPPED' ? '演奏を停止しました。再開するには出力を有効にしてください。' + suffix :
      phase === 'HOLD' ? '次のセットを確認しています。完成・確認前の素材は再生しません。' + suffix :
      outputReady ? '出力の準備ができました。「演奏開始」を押してください。' :
      output ? (autoOpen ? 'ステージ中央の「開場する」を押してください。素材の準備が終わると「演奏開始」を押せます。' :
        '出力画面の「音声出力を有効にする」を一度押してください。') :
      autoOpen ? 'Macとの接続と素材の準備を待っています。' : '「映像・音声出力を開く」を押してください。';
    onState({readiness, phase: phase ?? 'IDLE'});
    // Single-screen flow: an embedded output needs no popup gesture, so open it
    // as soon as the cloud side is ready. Its own click still unlocks audio.
    if (autoOpen && !autoOpened && !closed && readiness.ready && !output && !opening) {
      autoOpened = true; queueMicrotask(() => open.onclick());
    }
  }
  open.onclick = () => {
    if (closed || !readiness.ready || opening || typeof openOutput !== 'function') return;
    // Open synchronously in the click handler so the browser can display it.
    let connecting;
    try { connecting = openOutput({onState: outputState}); }
    catch { status.textContent = '出力画面を開けませんでした。ポップアップの表示を確認してください。'; return; }
    opening = Promise.resolve(connecting).then(port => {
      if (closed) { void port.dispose?.(); return; }
      output = port;
      controller ??= createController({outputPort: output, onState: draw});
      draw();
    }).catch(() => { status.textContent = '出力画面を開けませんでした。ポップアップの表示を確認してください。'; })
      .finally(() => { opening = null; draw(); });
    draw();
  };
  start.onclick = () => {
    if (start.disabled) return;
    busy = true; running = true; ended = false; startFailed = null; started = true;
    let pending;
    try { pending = controller.start(); } catch { pending = Promise.reject(Error('CLOUD_START_FAILED')); }
    draw();
    void pending.catch(error => { running = false; startFailed = code(error?.message) ?? 'CLOUD_START_FAILED';
      cause = 'START_FAILED:' + startFailed; draw({state: 'HOLD', reason: cause}); }).finally(() => { busy = stopPending; draw(); });
  };
  // A stop the server could not confirm stays HOLD with Stop enabled, so the
  // owner retries instead of seeing STOPPED while a reservation may remain.
  const settleStop = pending => void pending.then(() => { stopPending = false; busy = false; started = false; draw({state: 'STOPPED'}); },
    () => { stopPending = false; busy = false; draw({state: 'HOLD'});
      status.textContent = '停止をサーバーで確認できませんでした。もう一度「演奏停止」を押してください。'; });
  stop.onclick = () => {
    if (stop.disabled) return;
    busy = true; stopPending = true; running = false; cause = null; ended = false; startFailed = null;
    settleStop(Promise.resolve().then(() => controller.stop('OWNER_STOP')));
  };
  function outputState(state) {
    draw(state);
    if (!closed && running && controller && !busy && state.phase === 'STOPPED' && state.reason === 'CUE_DURATION_END') {
      // The sounding Cue played to its end before a next Cue was committed.
      // That is not a room Stop: keep the room, credits and served counts and
      // stop selecting for the ended graph. The owner restarts with Stop.
      running = false; ended = true; controller.halt?.('CUE_DURATION_END'); draw(state);
      return;
    }
    if (!closed && running && controller && !busy && ['STOPPED', 'HOLD'].includes(state.phase)) {
      running = false; busy = true; stopPending = true;
      cause = 'OUTPUT_' + state.phase + (code(state.reason) ? ':' + code(state.reason) : '');
      // Output close/stop invalidates the server reservation as well. Mark
      // stopped before forwarding so the bridge's state reply cannot recurse.
      settleStop(Promise.resolve().then(() => controller.stop('OUTPUT_STOP')));
    }
  }
  draw();
  return {refresh: draw, outputState, get readiness(){return readiness;}, get started(){return started;},setCapabilities(value){readiness=cloudReadiness(value);draw();}, async dispose() {
    closed = true; running = false; open.onclick = start.onclick = stop.onclick = null;
    await controller?.dispose?.(); await output?.dispose?.(); output = controller = null;
  }};
}
