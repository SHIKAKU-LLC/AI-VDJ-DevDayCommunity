import qrcode from './qr-encoder.mjs';
import {createContinuousPlayer} from './judge-player.mjs';
import {createScenePlayer} from './judge-scenes.mjs';
import {createAudioReactiveVj} from './judge-vj.mjs';

const $ = id => document.getElementById(id);
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const labels = {QUEUED: '生成の準備中', GENERATING: '音楽・映像を並行生成中', AUDIO_SUBMITTING: '音楽を依頼中', AUDIO_WAIT: '音楽を生成中', AUDIO_READY: '音楽が完成',
  VIDEO_SUBMITTING: '映像を依頼中', VIDEO_WAIT: '映像を生成中',
  READY: '再生準備完了', FAILED: '生成を完了できませんでした', NEEDS_REVIEW: '生成結果の確認が必要です'};
const messages = {JUDGE_CLOSED: '現在はルームの受付期間外です。', JUDGE_CAPACITY: 'ルーム数の上限に達しました。',
  JUDGE_BUDGET: 'このルームまたはイベントの生成上限に達しました。', GENERATION_DISABLED: '生成サービスを準備しています。',
  PROVIDER_BALANCE_REQUIRED: '運営側の生成残高を確認しています。', ACTOR_DENIED: '接続情報を確認できません。ページを開き直してください。',
  PROVIDER_PERMISSION_REQUIRED: '運営側で生成サービスの接続権限を確認する必要があります。',
  PROVIDER_AUTHENTICATION_FAILED: '運営側で生成サービスの接続設定を確認する必要があります。',
  PROVIDER_RATE_LIMITED: '生成サービスが混み合っています。しばらく待ってから再確認します。',
  ROOM_NOT_FOUND: 'このルームは終了したか、利用期限を過ぎています。', ACCEPTANCE_OFF: '現在は新しいアイデアの受付を閉じています。',
  RATE_LIMITED: '少し時間をおいてから送信してください。'};
let session, snapshot, jobs = [], capabilities, context, player, autoGenerate = true, polling = false, pendingSubmit, submitBusy = false;
const loaded = new Map(), loadPending = new Set(), videos = new Map();
let decodeFailures = 0, meter = {}, meterNode, playerInit, vj, scenePlayer;
const sceneLoading = new Map(), sceneUrls = new Map(), sceneAssets = new Map();
let generationRetryAfterMs = 0, queueBusy = false;
const route = /^\/join\/([a-f0-9-]{36})$/.exec(location.pathname);
let invitation = new URLSearchParams(location.search).get('code');
if (location.search || location.hash) history.replaceState(null, '', location.pathname);
const sessionKey = 'vdj-cloud:' + (route?.[1] ?? 'owner');
try { session = JSON.parse(sessionStorage.getItem(sessionKey)); } catch { /* new session */ }
if (session?.autoGenerate === false) autoGenerate = false;
if (route && invitation) sessionStorage.setItem('vdj-invite:' + route[1], invitation);
if (route && !invitation) invitation = sessionStorage.getItem('vdj-invite:' + route[1]);
function persist() { sessionStorage.setItem(sessionKey, JSON.stringify(session)); }
function status(message) { $('status').textContent = message; }
function error(e) { $('error').textContent = messages[e.message] ?? '通信または生成処理を確認できません。時間をおいて再度お試しください。'; }
async function request(path, body, {authenticated = true, raw = false} = {}) {
  const headers = {};
  if (authenticated && session) headers[session.owner ? 'x-room-owner' : 'authorization'] = session.owner ? session.capability : 'Bearer ' + session.capability;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), cache: 'no-store', credentials: 'omit'});
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw Error(data.error ?? 'NETWORK_FAILED'); }
  return raw ? response : response.json();
}
const roomPath = suffix => '/api/rooms/' + session.roomId + (suffix ? '/' + suffix : '');
function showRoom() {
  $('welcome').hidden = true; $('join-card').hidden = true; $('room').hidden = false;
  $('owner-card').hidden = !session.owner; $('stage').hidden = !session.owner;
  $('submit').textContent = session.owner ? '音楽・映像を生成する' : 'このアイデアを送る';
  if (session.owner && session.joinUrl) {
    $('join-url').value = session.joinUrl;
    const code = qrcode(0, 'M'); code.addData(session.joinUrl, 'Byte'); code.make();
    // Encoder output contains only computed SVG geometry, never submitted text.
    $('qr').innerHTML = code.createSvgTag({cellSize: 3, margin: 4, scalable: true});
  }
}
function render() {
  $('badge').textContent = session.owner ? 'オーナー' : '参加中';
  $('accept').textContent = snapshot.accepting ? '受付を閉じる' : '受付を開く';
  $('generate').textContent = autoGenerate ? '自動生成 ON' : '自動生成 OFF';
  $('submissions').replaceChildren(...snapshot.submissions.map(submission => {
    const li = document.createElement('li'), name = document.createElement('strong'), prompt = document.createElement('p'), state = document.createElement('small');
    const job = jobs.find(j => j.id === submission.submissionId);
    name.textContent = submission.nickname; prompt.textContent = submission.prompt;
    state.textContent = job ? labels[job.state] ?? '処理中' : jobs.length >= 5 ? '生成枠の上限に達しました' : '受付済み';
    li.append(name, prompt, state);
    if (session.owner && job?.state === 'FAILED') {
      const retry = document.createElement('button'); retry.textContent = '生成済み素材の検査を再試行';
      retry.onclick = async () => {
        retry.disabled = true;
        try { await request(roomPath('generation'), {retryPreparation: [job.id]}); await poll(); }
        catch (e) { error(e); } finally { retry.disabled = false; }
      };
      li.append(retry);
    }
    return li;
  }));
  const maximum = Math.max(250, ...jobs.map(job => job.maximumCents ?? 250)) / 100;
  $('budget').textContent = `生成枠 ${jobs.length} / 5 セット。運営負担は1セット上限 $${maximum.toFixed(2)}、ルーム合計上限 $${(maximum * 5).toFixed(2)}。`;
}
async function queuePending() {
  if (queueBusy || !session.owner || !autoGenerate || !capabilities.generation || jobs.length >= 5 || Date.now() < generationRetryAfterMs) return;
  const ids = snapshot.submissions.filter(s => !jobs.some(j => j.id === s.submissionId)).slice(0, 5 - jobs.length).map(s => s.submissionId);
  if (!ids.length) return;
  queueBusy = true;
  try { await request(roomPath('generation'), {submissionIds: ids}); }
  catch (e) { generationRetryAfterMs = Date.now() + 30000; error(e); }
  finally { queueBusy = false; }
}
function ensurePlayer() {
  if (playerInit) return playerInit;
  playerInit = (async () => {
  context = new AudioContext({sampleRate: 44100});
  await context.suspend();
  await context.audioWorklet.addModule('/judge-meter.mjs');
  meterNode = new AudioWorkletNode(context, 'vdj-continuity-meter', {outputChannelCount: [2]});
  meterNode.connect(context.destination); meterNode.port.onmessage = event => { meter = event.data; };
  vj = createAudioReactiveVj({context, input: meterNode, canvas: $('vj-overlay'), videoLayer: $('videos')});
  scenePlayer = createScenePlayer({clock: () => context.currentTime, onPrepare: scene => prepareScene(scene.id),
    async onChange(scene, previous, isCurrent) {
      const video = await prepareScene(scene.id);
      if (!isCurrent()) return;
      video.currentTime = 0; await video.play();
      if (!isCurrent()) { video.pause(); return; }
      for (const [id, node] of videos) node.classList.toggle('active', id === scene.id);
      setTimeout(() => {
        if (previous && !videos.get(previous.id)?.classList.contains('active')) videos.get(previous.id)?.pause();
        // Keep the active scene and two nearby decoded clips; all other
        // library entries remain descriptors until their turn approaches.
        for (const [id, node] of videos) {
          if (videos.size <= 3) break;
          if (node.classList.contains('active')) continue;
          node.pause(); node.removeAttribute('src'); node.load(); node.remove(); videos.delete(id);
          URL.revokeObjectURL(sceneUrls.get(id)); sceneUrls.delete(id);
        }
      }, 800);
      $('stage-empty').hidden = true;
    }, onStop() { for (const node of videos.values()) node.pause(); }});
  player = createContinuousPlayer({context, destination: meterNode, onTrack(track) {
    vj.setTrack(track.id); scenePlayer.setTrack(track.id);
    $('credit-label').textContent = 'このアイデアから生まれました'; $('credit').textContent = track.nickname;
    $('play-status').textContent = '再生中 · ' + track.prompt;
  }});
  window.__vdjPlayback = () => ({...player.read(), decodeFailures, meter: {...meter}, visualizer: vj?.read(), scenes: scenePlayer.read(),
    video: [...videos.values()].filter(v => v.classList.contains('active')).map(v => ({paused: v.paused, readyState: v.readyState, currentTime: v.currentTime, duration: v.duration, width: v.videoWidth, height: v.videoHeight}))});
  })();
  return playerInit;
}
async function fetchAsset(job, kind, descriptor = job.assets[kind]) {
  const response = await request(roomPath(`generated-media/${job.id}/${kind}`), undefined, {raw: true});
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== descriptor.byteLength) throw Error('MEDIA_INVALID');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== descriptor.sha256) throw Error('MEDIA_INVALID');
  return bytes;
}
function updatePlayButton() {
  if (!player) return;
  const minimum = jobs.some(j => j.sceneCount > 1) ? 2 : 1;
  const ready = player.read().ready > 0 && scenePlayer.read().ready >= minimum;
  $('play').disabled = player.read().running || !ready;
  if (ready && !player.read().running) $('play-status').textContent = '音楽と映像の準備完了。「再生する」を押してください。';
}
async function loadScene(id, trackId, descriptor, fetchBytes) {
  if (sceneAssets.has(id)) return;
  await ensurePlayer();
  if (sceneAssets.has(id)) return;
  sceneAssets.set(id, {descriptor, fetchBytes});
  scenePlayer.add({id, trackId, duration: descriptor.duration}); updatePlayButton();
}
async function prepareScene(id) {
  if (videos.has(id)) return videos.get(id);
  if (sceneLoading.has(id)) return sceneLoading.get(id);
  const task = decodeScene(id); sceneLoading.set(id, task);
  try { return await task; } finally { sceneLoading.delete(id); }
}
async function decodeScene(id) {
  const {descriptor, fetchBytes} = sceneAssets.get(id);
  let blobUrl;
  let video;
  try {
    const bytes = await fetchBytes();
    video = document.createElement('video'); video.muted = true; video.loop = false; video.playsInline = true; video.preload = 'auto';
    blobUrl = URL.createObjectURL(new Blob([bytes], {type: 'video/mp4'}));
    const loadedData = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('VIDEO_TIMEOUT')), 20000);
      video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, {once: true});
      video.addEventListener('error', () => { clearTimeout(timeout); reject(Error('VIDEO_INVALID')); }, {once: true});
    });
    video.src = blobUrl; $('videos').append(video); await loadedData;
    if (Math.abs(video.duration - descriptor.duration) > .1 ||
        ![[854,480],[1920,1080],[1920,1088]].some(([w,h]) => video.videoWidth === w && video.videoHeight === h) ||
        video.videoWidth !== (descriptor.width ?? 854) || video.videoHeight !== (descriptor.height ?? 480)) throw Error('VIDEO_INVALID');
    videos.set(id, video); sceneUrls.set(id, blobUrl);
    return video;
  } catch (error) {
    if (video) { video.removeAttribute('src'); video.load(); video.remove(); }
    if (blobUrl) URL.revokeObjectURL(blobUrl); decodeFailures++; throw error;
  }
}
async function load(job) {
  const scenes = job.assets?.scenes ?? (job.assets?.video ? [{key:'video', ...job.assets.video}] : []);
  for (const scene of scenes) void loadScene(job.id + ':' + scene.key, job.id, scene, () => fetchAsset(job, scene.key, scene));
  if (loaded.has(job.id) || loadPending.has(job.id) || !job.assets?.audio) return;
  loadPending.add(job.id);
  try {
    await ensurePlayer(); const buffer = await context.decodeAudioData(await fetchAsset(job, 'audio'));
    const duration = job.assets.audio.duration;
    if (![12,24,60].includes(duration) || Math.abs(buffer.duration - duration) > .05 || buffer.numberOfChannels !== 2) throw Error('MEDIA_INVALID');
    loaded.set(job.id, {...job, buffer});
    for (const ready of jobs.filter(j => j.assets?.audio)) { if (!loaded.has(ready.id)) break; player.add(loaded.get(ready.id)); }
    updatePlayButton();
  } catch { decodeFailures++; status('素材を読み込めませんでした。現在の再生を続けながら再確認します。'); }
  finally { loadPending.delete(job.id); }
}
let libraryLoaded = false;
async function loadLibrary() {
  if (libraryLoaded) return;
  try {
    const result = await request(roomPath('scene-library')); libraryLoaded = true;
    const own = new Set(jobs.flatMap(job => job.assets?.scenes ?? []).map(scene => scene.sha256));
    for (const scene of result.scenes.filter(scene => !own.has(scene.sha256))) void loadScene('stock:' + scene.sha256, null, scene, async () => {
      const response = await request(roomPath('library-media/' + scene.sha256), undefined, {raw:true});
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b=>b.toString(16).padStart(2,'0')).join('');
      if (bytes.byteLength !== scene.byteLength || hash !== scene.sha256) throw Error('MEDIA_INVALID');
      return bytes;
    });
  } catch { /* An empty/unavailable stock never interrupts owner media. */ }
}

async function poll() {
  if (!session || polling) return;
  polling = true;
  try {
    snapshot = await request(roomPath()); jobs = (await request(roomPath('generation'))).jobs; render();
    if (session.owner) {
      for (const job of jobs) void load(job);
      void loadLibrary();
      // Enqueue can wait behind a media inspection. Keep progress polling,
      // completed playback and new submissions responsive while it waits.
      void queuePending();
    }
  } catch (e) { error(e); } finally { polling = false; }
}
$('create').onclick = async () => {
  $('create').disabled = true;
  try {
    let pending; try { pending = JSON.parse(sessionStorage.getItem('vdj-create')); } catch { /* new */ }
    pending ??= {nonce: crypto.randomUUID(), ownerToken: token(), joinCode: token()};
    sessionStorage.setItem('vdj-create', JSON.stringify(pending));
    const data = await request('/api/judge/rooms', pending, {authenticated: false});
    session = {owner: true, roomId: data.roomId, capability: data.ownerToken, joinUrl: data.joinUrl};
    persist(); sessionStorage.removeItem('vdj-create'); showRoom(); await poll();
  } catch (e) { error(e); } finally { $('create').disabled = false; }
};
$('join').onclick = async () => {
  $('join').disabled = true;
  try {
    const data = await request(`/api/rooms/${route[1]}/participants`, {nickname: $('nickname').value.trim(), joinCode: invitation}, {authenticated: false});
    session = {owner: false, roomId: data.roomId, capability: data.participantToken}; persist(); showRoom(); await poll();
  } catch (e) { error(e); } finally { $('join').disabled = false; }
};
$('prompt-form').onsubmit = async event => {
  event.preventDefault(); if (submitBusy) return;
  const prompt = $('prompt').value.trim(); if (!prompt) return;
  submitBusy = true; $('submit').disabled = true; $('error').textContent = '';
  try {
    if (!pendingSubmit || pendingSubmit.prompt !== prompt) pendingSubmit = {nonce: token(), prompt, ...(session.owner ? {nickname: 'オーナー'} : {})};
    await request(roomPath('submissions'), pendingSubmit); pendingSubmit = null;
    $('prompt').value = ''; status(session.owner ? autoGenerate ? '受付完了。音楽と映像を生成しています。' :
      '受付完了。自動生成をONにすると音楽と映像を生成します。' : '受付完了。オーナーの画面で音楽と映像を準備します。'); await poll();
  } catch (e) { error(e); } finally { submitBusy = false; $('submit').disabled = false; }
};
$('generate').onclick = () => { autoGenerate = !autoGenerate; session.autoGenerate = autoGenerate; persist(); render(); if (autoGenerate) void poll(); };
$('accept').onclick = async () => {
  try { await request(roomPath('control'), {nonce: token(), expectedRevision: snapshot.controlRevision, accepting: !snapshot.accepting}); await poll(); } catch (e) { error(e); }
};
$('copy').onclick = () => navigator.clipboard.writeText(session.joinUrl).then(() => { $('copy').textContent = 'コピーしました'; }).catch(error);
$('play').onclick = async () => {
  try { await ensurePlayer(); meterNode.port.postMessage('start'); await player.start(); scenePlayer.start(); vj?.start(); $('stop').disabled = false; $('play').disabled = true; } catch (e) { error(e); }
};
$('stop').onclick = () => {
  player?.stop(); scenePlayer?.stop(); vj?.stop(); meterNode?.port.postMessage('stop'); for (const node of videos.values()) node.pause();
  $('play').disabled = false; $('stop').disabled = true; $('play-status').textContent = '再生を停止しました。';
};
$('fullscreen').onclick = () => $('stage').requestFullscreen().catch(error);
document.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'f' && !['INPUT', 'TEXTAREA'].includes(event.target.tagName) && session?.owner) void $('stage').requestFullscreen(); });
try {
  capabilities = await request('/api/room-capabilities', undefined, {authenticated: false});
  $('badge').textContent = capabilities.generation ? '受付中' : '準備中';
  $('create').disabled = !capabilities.generation;
  $('welcome-status').textContent = capabilities.generation ? 'インストール不要。ブラウザから始められます。' : '生成サービスを準備しています。しばらくお待ちください。';
  if (session) { showRoom(); await poll(); }
  else if (route) { $('welcome').hidden = true; $('join-card').hidden = false; }
} catch (e) { error(e); }
setInterval(() => void poll(), 4000);
// Read-only playback evidence contains no capabilities, media URLs or samples.
setInterval(() => { if (player) $('stage').dataset.playback = JSON.stringify(window.__vdjPlayback()); }, 1000);
window.addEventListener('pagehide', () => {
  player?.stop(); scenePlayer?.stop();
  for (const url of sceneUrls.values()) URL.revokeObjectURL(url);
});

window.addEventListener('pagehide', event => { if (event.persisted) vj?.stop(); else vj?.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted && player?.read().running) vj?.start(); });
