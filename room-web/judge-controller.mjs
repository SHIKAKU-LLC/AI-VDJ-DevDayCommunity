import qrcode from "./qr-encoder.mjs";
import { createSetPlayer } from "./judge-set-player.mjs";
import { createSoundtrackPlayer } from "./judge-soundtrack.mjs";
import { createAudioReactiveVj } from "./judge-vj.mjs";
import { prepareReferenceImage, REFERENCE_IMAGE_EXTENSIONS } from "./judge-image.mjs";
import { createMasterOutput } from "./judge-output.mjs";
import { createDisplayHost, videoDescriptor, displaySchedule } from "./judge-display.mjs";

export function createRoomController() {
  let elements = {};
  const $ = (id) => elements[id];
  let view = {
    loading: true,
    role: null,
    joining: false,
    status: "",
    error: "",
    submissions: [],
    jobs: [],
    accepting: true,
    autoGenerate: true,
    generation: false,
    imageEnabled: false,
    image: null,
    createBusy: false,
    joinBusy: false,
    submitBusy: false,
    imageBusy: false,
    imageError: false,
    maximumSets: 100,
    remainingSets: null,
    ready: false,
    playBusy: false,
    running: false,
    credit: "",
    playStatus: "音楽・映像の完成を待っています。",
    gainDb: 0,
    muted: false,
    elapsed: 0,
    independentAudio: false,
    musicStatus: "",
  };
  const listeners = new Set();
  const update = (patch) => {
    view = { ...view, ...patch };
    for (const callback of listeners) callback();
  };
  const subscribe = (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  let master, clockTimer, pollTimer;

  const token = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  const labels = {
    QUEUED: "生成の準備中",
    DIRECTING: "画像の特徴から演出を作成中",
    GENERATING: "生成中",
    AUDIO_SUBMITTING: "音楽を依頼中",
    AUDIO_WAIT: "音楽を生成中",
    AUDIO_READY: "音楽が完成",
    VIDEO_SUBMITTING: "映像を依頼中",
    VIDEO_WAIT: "映像を生成中",
    FAILED: "生成を完了できませんでした",
    PLAYED: "再生済み",
    READY: "再生待ち",
    NEEDS_REVIEW: "生成結果の確認が必要です",
  };
  const messages = {
    DISPLAY_UNAVAILABLE: "表示タブを開けませんでした。ブラウザのポップアップ設定を確認してください。",
    PLAYBACK_IN_USE:
      "別のオーナー画面で再生中です。その画面で停止してから開始してください。",
    PLAYBACK_NOT_READY:
      "プリセットの読み込みに時間がかかっています。再生するを押すと、もう一度確認します。",
    PRESETS_UNAVAILABLE:
      "プリセットを取得できませんでした。通信を確認して、再生するを押してください。",
    JUDGE_CLOSED: "現在はルームの受付期間外です。",
    JUDGE_CAPACITY: "ルーム数の上限に達しました。",
    JUDGE_BUDGET: "このルームまたはイベントの生成上限に達しました。",
    GENERATION_DISABLED: "生成サービスを準備しています。",
    PROVIDER_BALANCE_REQUIRED: "運営側の生成残高を確認しています。",
    ACTOR_DENIED: "接続情報を確認できません。ページを開き直してください。",
    PROVIDER_PERMISSION_REQUIRED:
      "運営側で生成サービスの接続権限を確認する必要があります。",
    PROVIDER_AUTHENTICATION_FAILED:
      "運営側で生成サービスの接続設定を確認する必要があります。",
    PROVIDER_RATE_LIMITED:
      "生成サービスが混み合っています。しばらく待ってから再確認します。",
    ROOM_NOT_FOUND: "このルームは終了したか、利用期限を過ぎています。",
    ACCEPTANCE_OFF: "現在は新しいアイデアの受付を閉じています。",
    RATE_LIMITED: "少し時間をおいてから送信してください。",
    IMAGE_FORMAT_INVALID:
      `対応していない画像形式、または拡張子と内容が一致しない画像です。${REFERENCE_IMAGE_EXTENSIONS} の画像を選んでください。`,
    IMAGE_DECODE_FAILED:
      "このブラウザで画像を読み込めませんでした。.jpg・.jpeg・.png・.webp で保存し直すか、画像のスクリーンショットを選んでください。",
    IMAGE_TOO_LARGE:
      "画像が大きすぎます。小さい画像を選んでください（元画像は8MB・5,000万画素まで）。",
    IMAGE_REFERENCE_LIMIT:
      "このルームの画像投稿上限に達しました。画像を外すと文章だけで投稿できます。",
    IMAGE_DIRECTION_DISABLED:
      "画像付き生成は準備中です。画像を外すと文章だけで投稿できます。",
    IMAGE_REFERENCE_CONFLICT:
      "送信中の画像と一致しません。画像を選び直してください。",
    IMAGE_REFERENCE_LOCKED:
      "送信済みの画像は変更できません。新しいアイデアとして投稿してください。",
  };
  let session,
    snapshot,
    jobs = [],
    capabilities,
    context,
    player,
    autoGenerate = true,
    polling = false,
    pendingSubmit,
    submitBusy = false;
  const loaded = new Map(),
    loadPending = new Set(),
    videos = new Map();
  let decodeFailures = 0,
    meter = {},
    meterNode,
    playerInit,
    vj,
    scenePlayer;
  const sceneLoading = new Map(),
    sceneUrls = new Map(),
    sceneAssets = new Map();
  const clientId = crypto.randomUUID();
  const setDefinitions = new Map();
  const display = createDisplayHost({
    onConnected: connected => {
      if (view.displayConnected !== connected) update({ displayConnected: connected });
    },
    snapshot: () => {
      const playback = player?.read();
      const describe = id => videoDescriptor(setDefinitions.get(id), sceneUrls.get(id + ":video"), location.origin);
      return {
        running: !!playback?.running,
        audioTime: playback?.audioTime ?? 0,
        scheduled: displaySchedule(playback, describe),
        preload: [...loaded.keys()].map(describe).filter(Boolean).slice(0, 6),
        visual: vj?.sample() ?? null,
      };
    },
  });
  let playbackView = { queue: [], counts: {}, played: [], presetsPlayed: [] };
  let remainingSets = null,
    candidateLoading = null,
    heartbeatTimer;
  let playRequest;
  let music, musicRun, musicLoading=false, musicPollAt=0;
  const musicLoaded=new Set();
  const emergencySeen = new Set();
  const reservedForPlayback = new Set();
  const failedUntil = new Map();
  let presetOrder = [],
    leaseUntil = 0;
  let referenceImage,
    imageBusy = false,
    imageVersion = 0;
  const route = /^\/join\/([a-f0-9-]{36})$/.exec(location.pathname);
  let invitation = new URLSearchParams(location.search).get("code");
  if (location.search || location.hash)
    history.replaceState(null, "", location.pathname);
  const sessionKey = "vdj-cloud:" + (route?.[1] ?? "owner");
  try {
    session = JSON.parse(sessionStorage.getItem(sessionKey));
  } catch {
    /* new session */
  }
  if (session?.autoGenerate === false) autoGenerate = false;
  if (route && invitation)
    sessionStorage.setItem("vdj-invite:" + route[1], invitation);
  if (route && !invitation)
    invitation = sessionStorage.getItem("vdj-invite:" + route[1]);
  function persist() {
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
  }
  function status(message) {
    update({ status: message });
  }
  function error(e) {
    update({
      error:
        messages[e.message] ??
        "通信または生成処理を確認できません。時間をおいて再度お試しください。",
    });
  }
  async function request(
    path,
    body,
    { authenticated = true, raw = false } = {},
  ) {
    const headers = {};
    if (authenticated && session)
      headers[session.owner ? "x-room-owner" : "authorization"] = session.owner
        ? session.capability
        : "Bearer " + session.capability;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Error(data.error ?? "NETWORK_FAILED");
    }
    return raw ? response : response.json();
  }
  const roomPath = (suffix) =>
    "/api/rooms/" + session.roomId + (suffix ? "/" + suffix : "");
  function showRoom() {
    update({ role: session.owner ? "owner" : "participant", joining: false });
    if (session.owner) update({playStatus:"プリセットを読み込んでいます。再生するを押すと、準備でき次第始まります。"});
  }
  function render() {
    update({
      accepting: snapshot.accepting,
      autoGenerate: true,
      submissions: snapshot.submissions,
      jobs: jobs.map(
        ({
          id,
          participantId,
          state,
          adopted,
          progress,
          sceneCount,
          direction,
          reason,
        }) => ({
          id,
          state: playbackView.played.includes(id) ? "PLAYED" : state,
          adopted: playbackView.counts[participantId] ?? adopted ?? 0,
          progress,
          sceneCount,
          direction,
          reason,
        }),
      ),
      maximumSets: 100,
      remainingSets,
      budget: `このルーム ${snapshot.submissions.length} / 100 投稿 · 全体の残り ${remainingSets ?? "確認中"} セット`,
      tracks: jobs
        .filter(
          (job) =>
            ["audience-12-v1","visual-12-v1"].includes(job.profile) &&
            job.assets?.video,
        )
        .map((job) => ({
          id: job.id,
          nickname: job.nickname,
          prompt: job.prompt,
          duration: job.assets.video.duration,
        })),
    });
  }
  function ensurePlayer() {
    if (playerInit) return playerInit;
    if (!elements.videos || !elements["vj-overlay"])
      throw Error("STAGE_UNAVAILABLE");
    playerInit = (async () => {
      context = new AudioContext({ sampleRate: 44100 });
      if (context.state === "running") await context.suspend();
      await context.audioWorklet.addModule("/judge-meter.mjs");
      meterNode = new AudioWorkletNode(context, "vdj-continuity-meter", {
        outputChannelCount: [2],
      });
      master = createMasterOutput(context);
      meterNode.connect(master.input);
      master.set(view.gainDb, view.muted);
      if(view.independentAudio) music=createSoundtrackPlayer({context,destination:meterNode,onTrack:track=>{
        if(track.kind==='preset')return;
        update({musicStatus:"60秒の音楽を連続再生中"});
        void pollMusic('played',track.id);
      }});
      meterNode.port.onmessage = (event) => {
        meter = event.data;
      };
      vj = createAudioReactiveVj({
        context,
        input: meterNode,
        canvas: $("vj-overlay"),
        videoLayer: $("videos"),
      });
      scenePlayer = {
        read: () => ({
          ready: loaded.size,
          currentId: player?.read().currentId,
          history: player?.read().history ?? [],
        }),
        stop: () => {
          for (const v of videos.values()) v.pause();
        },
      };
      player = createSetPlayer({
        context,
        audioEnabled: !view.independentAudio,
        destination: meterNode,
        choose: chooseSet,
        fallback: standbySet,
        onAbandon: async (set) => {
          reservedForPlayback.delete(set.id);
          try {
            await request(roomPath("playback"), {
              action: "abandon",
              clientId,
            });
          } catch {}
        },
        async onStart(set, at, offset) {
          reservedForPlayback.delete(set.id);
          const video = videos.get(set.id + ":video");
          if (video) {
            if (offset > 0.15) video.currentTime = Math.min(offset, 11.9);
            void video.play().catch(() => {});
          }
          if (!player.read().running) return;
          for (const [id, node] of videos)
            node.classList.toggle("active", id === set.id + ":video");
          setTimeout(() => {
            for (const node of videos.values())
              if (!node.classList.contains("active")) node.pause();
          }, 250);
          vj.setTrack(set.id);
          update({
            hasVideo: !!video,
            credit: set.kind === "preset" ? "AI VDJ プリセット" : set.nickname,
            playStatus:
              set.kind === "preset"
                ? "投稿の完成を待ちながらプリセットを再生中"
                : "再生中 · " + set.prompt,
            currentId: set.id,
            trackStarted: at,
          });
          if (set.nonce) await acknowledge(set).catch(() => {});
          void refreshCandidates();
        },
      });
      window.__vdjPlayback = () => ({
        ...player.read(),
        ...(music ? {music:music.read()} : {}),
        decodeFailures,
        meter: { ...meter },
        visualizer: vj?.read(),
        scenes: scenePlayer.read(),
        output: {
          gainDb: view.gainDb,
          muted: view.muted,
          channels: master.read().channels,
        },
        video: [...videos.values()]
          .filter((v) => v.classList.contains("active"))
          .map((v) => ({
            paused: v.paused,
            readyState: v.readyState,
            currentTime: v.currentTime,
            duration: v.duration,
            width: v.videoWidth,
            height: v.videoHeight,
          })),
      });
    })();
    return playerInit;
  }
  async function fetchAsset(job, kind, descriptor = job.assets[kind]) {
    const response = await request(
      roomPath(`generated-media/${job.id}/${kind}`),
      undefined,
      { raw: true },
    );
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== descriptor.byteLength)
      throw Error("MEDIA_INVALID");
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== descriptor.sha256) throw Error("MEDIA_INVALID");
    return bytes;
  }
  function updatePlayButton() {
    if (!player) return;
    player.setReady(loaded.size);
    const ready = loaded.size > 0 && (!music || music.read().ready);
    update({ ready, running: player.read().running });
    if (ready && !player.read().running && !view.playBusy)
      update({ playStatus: "音楽と映像の準備完了。再生できます。" });
  }
  async function loadScene(id, trackId, descriptor, fetchBytes) {
    if (sceneAssets.has(id)) return;
    await ensurePlayer();
    if (sceneAssets.has(id)) return;
    sceneAssets.set(id, { descriptor, fetchBytes });

    updatePlayButton();
  }
  async function prepareScene(id) {
    if (videos.has(id)) return videos.get(id);
    if (sceneLoading.has(id)) return sceneLoading.get(id);
    const task = decodeScene(id);
    sceneLoading.set(id, task);
    try {
      return await task;
    } finally {
      sceneLoading.delete(id);
    }
  }
  async function decodeScene(id) {
    const { descriptor, fetchBytes } = sceneAssets.get(id);
    let blobUrl;
    let video;
    try {
      const bytes = await fetchBytes();
      video = document.createElement("video");
      video.muted = true;
      video.loop = false;
      video.playsInline = true;
      video.preload = "auto";
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      const loadedData = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error("VIDEO_TIMEOUT")), 20000);
        video.addEventListener(
          "loadeddata",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        video.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(Error("VIDEO_INVALID"));
          },
          { once: true },
        );
      });
      video.src = blobUrl;
      $("videos").append(video);
      await loadedData;
      if (
        Math.abs(video.duration - descriptor.duration) > 0.1 ||
        ![
          [854, 480],
          [1920, 1080],
          [1920, 1088],
        ].some(([w, h]) => video.videoWidth === w && video.videoHeight === h) ||
        video.videoWidth !== (descriptor.width ?? 854) ||
        video.videoHeight !== (descriptor.height ?? 480)
      )
        throw Error("VIDEO_INVALID");
      videos.set(id, video);
      sceneUrls.set(id, blobUrl);
      return video;
    } catch (error) {
      if (video) {
        video.removeAttribute("src");
        video.load();
        video.remove();
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      decodeFailures++;
      throw error;
    }
  }
  function load(job) {
    if (
      !["audience-12-v1",...(view.independentAudio?["visual-12-v1"]:[])].includes(job.profile) ||
      !["READY", "PLAYED"].includes(job.state) ||
      (!view.independentAudio && job.assets?.audio?.duration !== 12) ||
      job.assets?.video?.duration !== 12
    )
      return;
    setDefinitions.set(job.id, { ...job, kind: "generated" });
  }
  async function loadLibrary() {
    if (Date.now() < libraryRefreshAt) return;
    if (libraryLoading) return libraryLoading;
    libraryLoading = (async () => {
    try {
      const result = await request(roomPath("preset-library"));
      const available = new Set(result.presets.map((p) => p.id));
      for (const [id, set] of setDefinitions)
        if (set.kind === "preset" && !available.has(id))
          setDefinitions.delete(id);
      for (const preset of result.presets)
        setDefinitions.set(preset.id, {
          ...preset,
          kind: "preset",
          assets: { audio: preset.audio, video: preset.video },
        });
      libraryRefreshAt = Date.now() + 15000;
    } catch { throw Error("PRESETS_UNAVAILABLE"); }
    finally { libraryLoading = null; }
    })();
    return libraryLoading;
  }
  let libraryRefreshAt = 0, libraryLoading;
  async function setBytes(set, kind) {
    if (set.kind !== "preset") return fetchAsset(set, kind);
    const response = await request(
      roomPath(`preset-media/${set.id.slice(7)}/${kind}`),
      undefined,
      { raw: true },
    );
    const bytes = await response.arrayBuffer(),
      descriptor = set.assets[kind];
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (
      bytes.byteLength !== descriptor.byteLength ||
      hash !== descriptor.sha256
    )
      throw Error("MEDIA_INVALID");
    return bytes;
  }
  async function prepareSet(set) {
    if (loaded.has(set.id)) {
      const video = videos.get(set.id + ":video");
      if (
        video &&
        !video.classList.contains("active") &&
        video.paused &&
        video.currentTime > 0.05
      )
        video.currentTime = 0;
      return;
    }
    if (loadPending.has(set.id)) return;
    loadPending.add(set.id);
    try {
      await ensurePlayer();
      await loadScene(set.id + ":video", set.id, set.assets.video, () =>
        setBytes(set, "video"),
      );
      const [buffer] = await Promise.all([
        view.independentAudio && set.kind!=='preset' ? Promise.resolve(null) : setBytes(set, "audio").then(bytes => context.decodeAudioData(bytes)),
        prepareScene(set.id + ":video"),
      ]);
      if (
        buffer && (Math.abs(buffer.duration - 12) > 0.05 ||
        buffer.numberOfChannels !== 2)
      )
        throw Error("MEDIA_INVALID");
      loaded.set(set.id, { ...set, buffer });
      if(buffer && set.kind==='preset')music?.setFallback({...set,buffer});
      updatePlayButton();
    } catch {
      decodeFailures++;
      failedUntil.set(set.id, Date.now() + 30000);
    } finally {
      loadPending.delete(set.id);
    }
  }
  function presetCandidates() {
    const presets = [...setDefinitions.values()].filter(
      (s) => s.kind === "preset",
    );
    if (
      presetOrder.length !== presets.length ||
      presetOrder.some((id) => !setDefinitions.has(id)) ||
      presets.every((s) => playbackView.presetsPlayed.includes(s.id))
    ) {
      presetOrder = presets.map((s) => s.id);
      for (let i = presetOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [presetOrder[i], presetOrder[j]] = [presetOrder[j], presetOrder[i]];
      }
    }
    const fresh = presetOrder.filter(
      (id) => !playbackView.presetsPlayed.includes(id),
    );
    return (
      fresh.length
        ? fresh
        : presetOrder.filter((id) => id !== playbackView.lastPreset)
    )
      .map((id) => setDefinitions.get(id))
      .filter((s) => s && (failedUntil.get(s.id) ?? 0) < Date.now());
  }
  function refreshCandidates() {
    if (!session?.owner) return Promise.resolve();
    if (candidateLoading) return candidateLoading;
    candidateLoading = (async () => {
    try {
      const preferred = playbackView.queue
        .map((j) => setDefinitions.get(j.id))
        .filter((s) => s && (failedUntil.get(s.id) ?? 0) < Date.now())
        .slice(0, 2);
      const presets = presetCandidates().slice(0, 2);
      // Get one complete pair playable before spending bandwidth on the backup.
      const first = preferred[0] ?? presets[0];
      if (!view.ready && first) await prepareSet(first);
      await Promise.all([...preferred, ...presets].map(prepareSet));
      const keep = new Set([
        ...reservedForPlayback,
        ...[...preferred, ...presets].map((s) => s.id),
      ]);
      for (const s of player?.read().scheduled ?? [])
        if (s.end > context.currentTime) keep.add(s.id);
      for (const id of loaded.keys()) {
        if (keep.has(id)) continue;
        loaded.delete(id);
        const key = id + ":video",
          node = videos.get(key);
        if (node && !node.classList.contains("active")) {
          node.pause();
          node.removeAttribute("src");
          node.load();
          node.remove();
          videos.delete(key);
          URL.revokeObjectURL(sceneUrls.get(key));
          sceneUrls.delete(key);
        }
      }
      updatePlayButton();
    } finally {
      candidateLoading = null;
    }
    })();
    return candidateLoading;
  }
  async function chooseSet() {
    const eligible = new Set(playbackView.queue.map((j) => j.id));
    const readyIds = [...loaded.values()]
      .filter((s) => s.kind === "preset" || eligible.has(s.id))
      .map((s) => s.id)
      .slice(0, 8);
    for (const id of readyIds) reservedForPlayback.add(id);
    const nonce = crypto.randomUUID();
    let claim;
    try {
      ({ claim } = await request(roomPath("playback"), {
        action: "claim",
        clientId,
        nonce,
        readyIds,
      }));
    } finally {
      for (const id of readyIds) reservedForPlayback.delete(id);
    }
    if (claim) {
      leaseUntil = claim.until;
      reservedForPlayback.add(claim.id);
    }
    return claim ? { ...loaded.get(claim.id), nonce } : null;
  }
  function standbySet() {
    let available = [...loaded.values()].filter(
      (s) => s.kind === "preset" && !emergencySeen.has(s.id),
    );
    if (!available.length) {
      emergencySeen.clear();
      available = [...loaded.values()].filter(
        (s) => s.kind === "preset" && s.id !== player?.read().currentId,
      );
    }
    const set = available[Math.floor(Math.random() * available.length)];
    if (set) emergencySeen.add(set.id);
    return set;
  }
  async function acknowledge(set) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await request(roomPath("playback"), {
          action: "started",
          clientId,
          nonce: set.nonce,
          id: set.id,
        });
        if (set.kind !== "preset") playbackView.played.push(set.id);
        else playbackView.presetsPlayed.push(set.id);
        await poll();
        return;
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
  }
  async function loadCapabilities() {
    capabilities = await request("/api/room-capabilities", undefined, {
      authenticated: false,
    });
    update({
      generation: capabilities.generation,
      imageEnabled: !!capabilities.cloud?.imageDirection,
      independentAudio: !!capabilities.cloud?.independentAudio,
    });
  }
  async function recheck() {
    update({ error: "" });
    if (session) return poll();
    try {
      await loadCapabilities();
      if (route) update({ joining: true });
    } catch (e) {
      error(e);
    }
  }
  async function poll() {
    if (!session || polling) return;
    polling = true;
    if (session.owner) void loadLibrary().then(refreshCandidates).catch(() => {
      if (!view.ready && !view.playBusy) update({playStatus:messages.PRESETS_UNAVAILABLE});
    });
    if(session.owner && view.running && view.independentAudio && Date.now()>musicPollAt)void pollMusic();
    try {
      const [nextSnapshot, result] = await Promise.all([request(roomPath()), request(roomPath("generation"))]);
      snapshot = nextSnapshot;
      jobs = result.jobs;
      remainingSets = result.remainingSets ?? null;
      update({ presetBatchId: result.presetBatchId });
      if (result.playback) playbackView = result.playback;
      render();
      if (session.owner) {
        for (const job of jobs) void load(job);
        void refreshCandidates();
      }
    } catch (e) {
      error(e);
    } finally {
      polling = false;
    }
  }
  async function create() {
    if (view.createBusy) return;
    update({ createBusy: true, error: "" });
    try {
      let pending;
      try {
        pending = JSON.parse(sessionStorage.getItem("vdj-create"));
      } catch {
        /* new */
      }
      pending ??= {
        nonce: crypto.randomUUID(),
        ownerToken: token(),
        joinCode: token(),
      };
      sessionStorage.setItem("vdj-create", JSON.stringify(pending));
      const data = await request("/api/judge/rooms", pending, {
        authenticated: false,
      });
      session = {
        owner: true,
        roomId: data.roomId,
        capability: data.ownerToken,
        joinUrl: data.joinUrl,
      };
      persist();
      sessionStorage.removeItem("vdj-create");
      showRoom();
      await poll();
    } catch (e) {
      error(e);
    } finally {
      update({ createBusy: false });
    }
  }
  async function join(nickname) {
    if (view.joinBusy || !nickname.trim()) return;
    update({ joinBusy: true, error: "" });
    try {
      const data = await request(
        `/api/rooms/${route[1]}/participants`,
        { nickname: nickname.trim(), joinCode: invitation },
        { authenticated: false },
      );
      session = {
        owner: false,
        roomId: data.roomId,
        capability: data.participantToken,
      };
      persist();
      showRoom();
      await poll();
    } catch (e) {
      error(e);
    } finally {
      update({ joinBusy: false });
    }
  }
  async function submit(value) {
    if (submitBusy || imageBusy || view.imageError) return false;
    const prompt = value.trim();
    if (!prompt) return false;
    submitBusy = true;
    update({ submitBusy: true, error: "" });
    try {
      const imageHash = referenceImage?.hash;
      if (
        !pendingSubmit ||
        pendingSubmit.prompt !== prompt ||
        pendingSubmit.imageHash !== imageHash
      )
        pendingSubmit = {
          nonce: token(),
          prompt,
          imageHash,
          ...(session.owner ? { nickname: "オーナー" } : {}),
        };
      if (referenceImage) {
        status(
          "画像を受け付けています。演出用の詳しい指示は自動で作成します。",
        );
        const promptHash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(prompt),
            ),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        const headers = {
          "content-type": "image/png",
          "x-vdj-prompt-sha256": promptHash,
          "x-vdj-source-format": referenceImage.sourceFormat,
        };
        headers[session.owner ? "x-room-owner" : "authorization"] =
          session.owner ? session.capability : "Bearer " + session.capability;
        const response = await fetch(
          roomPath("reference-image/" + pendingSubmit.nonce),
          {
            method: "PUT",
            headers,
            body: referenceImage.blob,
            cache: "no-store",
            credentials: "omit",
          },
        );
        if (!response.ok)
          throw Error(
            (await response.json().catch(() => ({}))).error ??
              "IMAGE_UPLOAD_UNAVAILABLE",
          );
      }
      const { imageHash: _, ...submission } = pendingSubmit;
      await request(roomPath("submissions"), submission);
      pendingSubmit = null;
      clearReference();
      status(
        session.owner
          ? autoGenerate
            ? "受付完了。サーバーで音楽と映像を生成しています。"
            : "受付完了。サーバーで音楽と映像を生成しています。"
          : "受付完了。サーバーで音楽と映像を生成しています。",
      );
      await poll();
      return true;
    } catch (e) {
      error(e);
    } finally {
      submitBusy = false;
      update({ submitBusy: false });
    }
    return false;
  }
  function clearReference() {
    imageVersion++;
    if (referenceImage) URL.revokeObjectURL(referenceImage.previewUrl);
    referenceImage = null;
    imageBusy = false;
    update({ image: null, imageBusy: false, imageError: false, ...(view.imageError ? {error:""} : {}) });
  }
  async function attach(file) {
    clearReference();
    if (!file) return;
    const version = imageVersion;
    imageBusy = true;
    update({ imageBusy: true, error: "" });
    try {
      const image = await prepareReferenceImage(file);
      if (version !== imageVersion) {
        URL.revokeObjectURL(image.previewUrl);
        return;
      }
      referenceImage = image;
      update({ image: { url: image.previewUrl, name: file.name } });
    } catch (e) {
      if (version === imageVersion) {
        update({imageError:true});
        error(e);
      }
    } finally {
      if (version === imageVersion) {
        imageBusy = false;
        update({ imageBusy: false });
      }
    }
  }
  function toggleGeneration() {
    autoGenerate = !autoGenerate;
    session.autoGenerate = autoGenerate;
    persist();
    render();
    if (autoGenerate) void poll();
  }
  async function toggleAcceptance() {
    try {
      await request(roomPath("control"), {
        nonce: token(),
        expectedRevision: snapshot.controlRevision,
        accepting: !snapshot.accepting,
      });
      await poll();
    } catch (e) {
      error(e);
    }
  }
  async function retry(id) {
    if (view.retryBusy) return;
    update({ retryBusy: id, error: "" });
    try {
      await request(roomPath("generation"), { retryPreparation: [id] });
      await poll();
    } catch (e) {
      error(e);
    } finally {
      update({ retryBusy: null });
    }
  }
  async function copyInvitation() {
    try {
      await navigator.clipboard.writeText(session.joinUrl);
      status("参加用URLをコピーしました。");
    } catch (e) {
      error(e);
    }
  }
  function getInvitation() {
    if (!session?.owner || !session.joinUrl) return null;
    const code = qrcode(0, "M");
    code.addData(session.joinUrl, "Byte");
    code.make();
    return {
      url: session.joinUrl,
      svg: code.createSvgTag({ cellSize: 3, margin: 4, scalable: true }),
    };
  }
  function waitForPlayableSet(signal) {
    if (view.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = error => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new DOMException("Playback cancelled", "AbortError"));
      const unsubscribe = subscribe(() => { if (view.ready) finish(); });
      timer = setTimeout(() => finish(Error("PLAYBACK_NOT_READY")), 30000);
      signal.addEventListener("abort", cancel, {once:true});
      if (signal.aborted) cancel();
    });
  }
  async function pollMusic(action='pulse',id) {
    if(!music || !player?.read().running || action==='pulse' && musicLoading)return;
    if(action==='pulse')musicLoading=true;
    musicPollAt=Date.now()+8000;
    try {
      const result=await request(roomPath('soundtrack'),{action,clientId,runId:musicRun,...(id?{id}:{})});
      if(!player.read().running)return;
      if(result.reason)update({musicStatus:'新しい音楽の生成を確認中。準備済みの音楽で再生を続けます。'});
      else if(!result.songs.some(s=>s.state==='READY'))update({musicStatus:'60秒の音楽を生成中。待機音楽でつないでいます。'});
      for(const song of result.songs.filter(s=>s.state==='READY' && s.assets?.audio?.duration===60)) {
        if(musicLoaded.has(song.id))continue;
        musicLoaded.add(song.id);
        try {
          const bytes=await fetchAsset(song,'audio');
          const buffer=await context.decodeAudioData(bytes);
          if(Math.abs(buffer.duration-60)>.05 || buffer.numberOfChannels!==2)throw Error('MEDIA_INVALID');
          music.add({...song,buffer});
        }catch{musicLoaded.delete(song.id);}
      }
    }catch{
      update({musicStatus:'音楽の生成状況を再確認しています。準備済みの音楽で再生を続けます。'});
    }finally{if(action==='pulse')musicLoading=false;}
  }
  async function play() {
    if (!session?.owner || view.playBusy || view.running) return;
    const attempt = new AbortController();
    playRequest = attempt;
    update({playBusy:true, error:"", playStatus:"プリセットを準備しています。準備でき次第、再生を始めます。"});
    try {
      const initialized = ensurePlayer();
      // Resume during the click, before waiting for any network or decoding.
      const resumed = context.resume();
      await Promise.all([initialized, resumed]);
      if (attempt.signal.aborted) return;
      await Promise.race([
        waitForPlayableSet(attempt.signal),
        loadLibrary().then(refreshCandidates).then(() => {
          if (!view.ready) throw Error("PLAYBACK_NOT_READY");
        }),
      ]);
      if (attempt.signal.aborted) return;
      meterNode.port.postMessage("start");
      await player.start();
      if (!player.read().running) return;
      music?.start();
      if(music){musicRun=crypto.randomUUID();void pollMusic('start');}
      heartbeatTimer = setInterval(
        () =>
          request(roomPath("playback"), { action: "heartbeat", clientId })
            .then((v) => {
              leaseUntil = v.until;
            })
            .catch((e) => {
              if (e.message === "PLAYBACK_IN_USE") stop();
            }),
        5000,
      );
      vj?.start();
      update({ running: true });
    } catch (e) {
      if (!attempt.signal.aborted) error(e);
    } finally {
      attempt.abort();
      if (playRequest === attempt) {
        playRequest = null;
        update({playBusy:false});
      }
    }
  }
  function stop() {
    playRequest?.abort();
    clearInterval(heartbeatTimer);
    if (session?.owner) {
      const ending=music && musicRun ? request(roomPath('soundtrack'),{action:'stop',clientId,runId:musicRun}).catch(()=>{}) : Promise.resolve();
      void ending.then(()=>request(roomPath("playback"),{action:"release",clientId})).catch(()=>{});
    }
    music?.stop();
    player?.stop();
    scenePlayer?.stop();
    vj?.stop();
    meterNode?.port.postMessage("stop");
    for (const node of videos.values()) node.pause();
    update({ running: false, playBusy: false, playStatus: "再生を停止しました。" });
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $("stage").requestFullscreen();
    } catch (e) {
      error(e);
    }
  }
  function setOutput(gainDb, muted = view.muted) {
    const value =
      gainDb === -Infinity
        ? -60
        : Math.max(-60, Math.min(0, Number(gainDb) || 0));
    master?.set(value, muted);
    update({ gainDb: value, muted });
  }
  let started = false;
  async function start(nodes) {
    elements = nodes;
    if (started) return;
    started = true;
    document.addEventListener("keydown", (event) => {
      if (
        event.key.toLowerCase() === "f" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !["INPUT", "TEXTAREA"].includes(event.target.tagName) &&
        !event.target.isContentEditable &&
        session?.owner
      ) {
        event.preventDefault();
        void fullscreen();
      }
    });
    try {
      await loadCapabilities();
      if (session) {
        showRoom();
        await poll();
      } else if (route) update({ joining: true });
    } catch (e) {
      error(e);
    } finally {
      update({ loading: false });
    }
    pollTimer = setInterval(() => void poll(), session?.owner ? 1000 : 4000);
    // Read-only playback evidence contains no capabilities, media URLs or samples.
    clockTimer = setInterval(() => {
      if (!player) return;
      const playback = player.read();
      if (playback.running && leaseUntil && Date.now() > leaseUntil) {
        stop();
        status(
          "再生権の接続を確認できないため停止しました。再接続後に再生してください。",
        );
        return;
      }
      const current = playback.scheduled.findLast(
        (track) =>
          track.start <= playback.audioTime && track.end > playback.audioTime,
      );
      if (playback.running)
        update({
          elapsed: Math.max(
            0,
            playback.audioTime - (current?.start ?? playback.audioTime),
          ),
          running: true,
        });
    }, 500);
    window.addEventListener("pagehide", () => {
      playRequest?.abort();
      display.close();
      clearInterval(heartbeatTimer);
      if (referenceImage) URL.revokeObjectURL(referenceImage.previewUrl);
      player?.stop();
      music?.stop();
      scenePlayer?.stop();
      for (const url of sceneUrls.values()) URL.revokeObjectURL(url);
    });

    window.addEventListener("pagehide", (event) => {
      if (event.persisted) vj?.stop();
      else vj?.dispose();
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && player?.read().running) vj?.start();
    });
  }
  return {
    subscribe,
    getSnapshot: () => view,
    start,
    create,
    join,
    submit,
    attach,
    clearReference,
    toggleGeneration,
    toggleAcceptance,
    retry,
    async startPresets() {
      if (view.presetBatchId) {
        await request(roomPath("generation"), {
          presetBatchId: view.presetBatchId,
        });
        status("承認済みの待機音楽を準備しています。");
      }
    },
    copyInvitation,
    getInvitation,
    play,
    stop,
    fullscreen,
    openDisplay() {
      if (!session?.owner) return;
      try { display.open(); } catch { error(new Error("DISPLAY_UNAVAILABLE")); }
    },
    setOutput,
    poll,
    recheck,
    readOutput: () =>
      master?.read() ?? {
        channels: [
          { peakDb: -60, rmsDb: -60 },
          { peakDb: -60, rmsDb: -60 },
        ],
      },
    labels,
  };
}
