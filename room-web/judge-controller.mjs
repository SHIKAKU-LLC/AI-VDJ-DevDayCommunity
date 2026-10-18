import qrcode from "./qr-encoder.mjs";
import { createContinuousPlayer } from "./judge-player.mjs";
import { createScenePlayer } from "./judge-scenes.mjs";
import { createAudioReactiveVj } from "./judge-vj.mjs";
import { prepareReferenceImage } from "./judge-image.mjs";
import { createMasterOutput } from "./judge-output.mjs";

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
    ready: false,
    running: false,
    credit: "",
    playStatus: "音楽・映像の完成を待っています。",
    gainDb: 0,
    muted: false,
    elapsed: 0,
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
    GENERATING: "音楽・映像を並行生成中",
    AUDIO_SUBMITTING: "音楽を依頼中",
    AUDIO_WAIT: "音楽を生成中",
    AUDIO_READY: "音楽が完成",
    VIDEO_SUBMITTING: "映像を依頼中",
    VIDEO_WAIT: "映像を生成中",
    READY: "再生準備完了",
    FAILED: "生成を完了できませんでした",
    NEEDS_REVIEW: "生成結果の確認が必要です",
  };
  const messages = {
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
      "画像を読み取れませんでした。JPEG・PNG・WebPの画像を選んでください。",
    IMAGE_TOO_LARGE:
      "画像が大きすぎます。小さい画像を選んでください（元画像は8MBまで）。",
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
  let generationRetryAfterMs = 0,
    queueBusy = false;
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
  }
  function render() {
    update({
      accepting: snapshot.accepting,
      autoGenerate,
      submissions: snapshot.submissions,
      jobs: jobs.map(
        ({ id, state, progress, sceneCount, direction, reason }) => ({
          id,
          state,
          progress,
          sceneCount,
          direction,
          reason,
        }),
      ),
      budget: `生成枠 ${jobs.length} / 5 セット`,
      tracks: jobs
        .filter((job) => job.assets?.audio)
        .map((job) => ({
          id: job.id,
          nickname: job.nickname,
          prompt: job.prompt,
          duration: job.assets.audio.duration,
        })),
    });
  }
  async function queuePending() {
    if (
      queueBusy ||
      !session.owner ||
      !autoGenerate ||
      !capabilities.generation ||
      jobs.length >= 5 ||
      Date.now() < generationRetryAfterMs
    )
      return;
    const ids = snapshot.submissions
      .filter((s) => !jobs.some((j) => j.id === s.submissionId))
      .slice(0, 5 - jobs.length)
      .map((s) => s.submissionId);
    if (!ids.length) return;
    queueBusy = true;
    try {
      await request(roomPath("generation"), { submissionIds: ids });
    } catch (e) {
      generationRetryAfterMs = Date.now() + 30000;
      error(e);
    } finally {
      queueBusy = false;
    }
  }
  function ensurePlayer() {
    if (playerInit) return playerInit;
    if (!elements.videos || !elements["vj-overlay"])
      throw Error("STAGE_UNAVAILABLE");
    playerInit = (async () => {
      context = new AudioContext({ sampleRate: 44100 });
      await context.suspend();
      await context.audioWorklet.addModule("/judge-meter.mjs");
      meterNode = new AudioWorkletNode(context, "vdj-continuity-meter", {
        outputChannelCount: [2],
      });
      master = createMasterOutput(context);
      meterNode.connect(master.input);
      master.set(view.gainDb, view.muted);
      meterNode.port.onmessage = (event) => {
        meter = event.data;
      };
      vj = createAudioReactiveVj({
        context,
        input: meterNode,
        canvas: $("vj-overlay"),
        videoLayer: $("videos"),
      });
      scenePlayer = createScenePlayer({
        clock: () => context.currentTime,
        onPrepare: (scene) => prepareScene(scene.id),
        async onChange(scene, previous, isCurrent) {
          const video = await prepareScene(scene.id);
          if (!isCurrent()) return;
          video.currentTime = 0;
          await video.play();
          if (!isCurrent()) {
            video.pause();
            return;
          }
          for (const [id, node] of videos)
            node.classList.toggle("active", id === scene.id);
          setTimeout(() => {
            if (
              previous &&
              !videos.get(previous.id)?.classList.contains("active")
            )
              videos.get(previous.id)?.pause();
            // Keep the active scene and two nearby decoded clips; all other
            // library entries remain descriptors until their turn approaches.
            for (const [id, node] of videos) {
              if (videos.size <= 3) break;
              if (node.classList.contains("active")) continue;
              node.pause();
              node.removeAttribute("src");
              node.load();
              node.remove();
              videos.delete(id);
              URL.revokeObjectURL(sceneUrls.get(id));
              sceneUrls.delete(id);
            }
          }, 800);
          update({ hasVideo: true });
        },
        onStop() {
          for (const node of videos.values()) node.pause();
        },
      });
      player = createContinuousPlayer({
        context,
        destination: meterNode,
        onTrack(track) {
          vj.setTrack(track.id);
          scenePlayer.setTrack(track.id);
          update({
            credit: track.nickname,
            playStatus: "再生中 · " + track.prompt,
            currentId: track.id,
            trackStarted: context.currentTime,
          });
        },
      });
      window.__vdjPlayback = () => ({
        ...player.read(),
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
    const minimum = jobs.some((j) => j.sceneCount > 1) ? 2 : 1;
    const ready =
      player.read().ready > 0 && scenePlayer.read().ready >= minimum;
    update({ ready, running: player.read().running });
    if (ready && !player.read().running)
      update({ playStatus: "音楽と映像の準備完了。再生できます。" });
  }
  async function loadScene(id, trackId, descriptor, fetchBytes) {
    if (sceneAssets.has(id)) return;
    await ensurePlayer();
    if (sceneAssets.has(id)) return;
    sceneAssets.set(id, { descriptor, fetchBytes });
    scenePlayer.add({ id, trackId, duration: descriptor.duration });
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
  async function load(job) {
    const scenes =
      job.assets?.scenes ??
      (job.assets?.video ? [{ key: "video", ...job.assets.video }] : []);
    for (const scene of scenes)
      void loadScene(job.id + ":" + scene.key, job.id, scene, () =>
        fetchAsset(job, scene.key, scene),
      );
    if (loaded.has(job.id) || loadPending.has(job.id) || !job.assets?.audio)
      return;
    loadPending.add(job.id);
    try {
      await ensurePlayer();
      const buffer = await context.decodeAudioData(
        await fetchAsset(job, "audio"),
      );
      const duration = job.assets.audio.duration;
      if (
        ![12, 24, 60].includes(duration) ||
        Math.abs(buffer.duration - duration) > 0.05 ||
        buffer.numberOfChannels !== 2
      )
        throw Error("MEDIA_INVALID");
      loaded.set(job.id, { ...job, buffer });
      for (const ready of jobs.filter((j) => j.assets?.audio)) {
        if (!loaded.has(ready.id)) break;
        player.add(loaded.get(ready.id));
      }
      updatePlayButton();
    } catch {
      decodeFailures++;
      status(
        "素材を読み込めませんでした。現在の再生を続けながら再確認します。",
      );
    } finally {
      loadPending.delete(job.id);
    }
  }
  let libraryLoaded = false;
  async function loadLibrary() {
    if (libraryLoaded) return;
    try {
      const result = await request(roomPath("scene-library"));
      libraryLoaded = true;
      const own = new Set(
        jobs
          .flatMap((job) => job.assets?.scenes ?? [])
          .map((scene) => scene.sha256),
      );
      for (const scene of result.scenes.filter(
        (scene) => !own.has(scene.sha256),
      ))
        void loadScene("stock:" + scene.sha256, null, scene, async () => {
          const response = await request(
            roomPath("library-media/" + scene.sha256),
            undefined,
            { raw: true },
          );
          const bytes = await response.arrayBuffer();
          const hash = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          if (bytes.byteLength !== scene.byteLength || hash !== scene.sha256)
            throw Error("MEDIA_INVALID");
          return bytes;
        });
    } catch {
      /* An empty/unavailable stock never interrupts owner media. */
    }
  }

  async function loadCapabilities() {
    capabilities = await request("/api/room-capabilities", undefined, {
      authenticated: false,
    });
    update({
      generation: capabilities.generation,
      imageEnabled: !!capabilities.cloud?.imageDirection,
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
    try {
      snapshot = await request(roomPath());
      jobs = (await request(roomPath("generation"))).jobs;
      render();
      if (session.owner) {
        for (const job of jobs) void load(job);
        void loadLibrary();
        // Enqueue can wait behind a media inspection. Keep progress polling,
        // completed playback and new submissions responsive while it waits.
        void queuePending();
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
    if (submitBusy || imageBusy) return false;
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
            ? "受付完了。音楽と映像を生成しています。"
            : "受付完了。自動生成をONにすると音楽と映像を生成します。"
          : "受付完了。オーナーの画面で音楽と映像を準備します。",
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
    update({ image: null, imageBusy: false });
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
      if (version === imageVersion) error(e);
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
  async function play() {
    try {
      await ensurePlayer();
      meterNode.port.postMessage("start");
      await player.start();
      scenePlayer.start();
      vj?.start();
      update({ running: true });
    } catch (e) {
      error(e);
    }
  }
  function stop() {
    player?.stop();
    scenePlayer?.stop();
    vj?.stop();
    meterNode?.port.postMessage("stop");
    for (const node of videos.values()) node.pause();
    update({ running: false, playStatus: "再生を停止しました。" });
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
    pollTimer = setInterval(() => void poll(), 4000);
    // Read-only playback evidence contains no capabilities, media URLs or samples.
    clockTimer = setInterval(() => {
      if (!player) return;
      const playback = player.read();
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
      if (referenceImage) URL.revokeObjectURL(referenceImage.previewUrl);
      player?.stop();
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
    copyInvitation,
    getInvitation,
    play,
    stop,
    fullscreen,
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
