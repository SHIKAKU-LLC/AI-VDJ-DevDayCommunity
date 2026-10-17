import {createCloudPlaybackAdapter} from '/cloud-playback.mjs';
import {createCloudPlaybackChannel, cloudPlaybackCommitTimeoutMs} from '/cloud-output-bridge.mjs';
import {pcmSha256} from '/playback/cue-contract.mjs';
import {createVideoAdapter} from '/scene-video-adapter.mjs';
import {prepareCloudInitialAudio, createCloudSeedPlayback} from '/cloud-initial-audio.mjs';
import {createWorkletPlaybackEngine} from '/playback/worklet-engine.mjs';
import {createAudioOutputLease} from '/playback/output-lease.mjs';
import {createCloudCreditOverlay} from '/cloud-output-credit.mjs';

// Test-only entry. Production HTTPS bridge/resolver are intentionally unchanged.
if (location.origin !== 'http://127.0.0.1:8892' || !isSecureContext || location.search || location.hash)
  throw Error('EXACT_SYNTHETIC_FIXTURE_ORIGIN_REQUIRED');
const role = document.body.dataset.role, multiMode = role.startsWith('multi-'), seedMode = role.startsWith('seed-') || multiMode, ownerRole = role.endsWith('owner'), status = document.getElementById('status'), evidenceView = document.getElementById('evidence');
const buttons = document.getElementById('buttons'), turn = () => new Promise(r => setTimeout(r, 0));
// Browser translation must not rewrite machine JSON or fixed test controls.
evidenceView.setAttribute('translate', 'no'); buttons.setAttribute('translate', 'no');
let channel, port, popup, operation = 0, selected = null, stopped = false, graph = null, prepared = null, seed = null, engine = null;
let graphEpoch = 1, sourceRevision = 0;
let fixtureCreditOverlay = null, currentBinding = null;
const evidence = {fixture: 'synthetic-browser-v1', physicalSpeakerVerified: false, browser: navigator.userAgent,
  secureContext: isSecureContext, sampleRate: null, processedWindow: null, videoFrames: [], states: [], guards: [], checks: [], events: []};
function draw() { evidenceView.textContent = JSON.stringify(evidence, null, 2); }
function log(type, value) { evidence.events.push({type, value}); draw(); }
function button(label, fn) { const b = document.createElement('button'); b.type = 'button'; b.lang = 'en'; b.textContent = label; b.onclick = fn; buttons.append(b); return b; }
function error(e) { evidence.error = e.message; status.textContent = 'HOLD: ' + e.message; draw(); void save(); }
async function save() {
  if (ownerRole) await fetch('/fixture-evidence', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(evidence)});
}
const readManifest = async () => (await fetch(multiMode ? '/fixture-multi-manifest' : seedMode ? '/fixture-seed-manifest' : '/fixture-manifest', {cache: 'no-store', redirect: 'error'})).json();
function compactOutput() { return {sampleRate: evidence.sampleRate, processedWindow: evidence.processedWindow,
  videoFrames: evidence.videoFrames, states: evidence.states, ...(multiMode ? {processedWindows: evidence.processedWindows,
    commandCounts: evidence.commandCounts, telemetry: evidence.telemetry, visualContinuity: evidence.visualContinuity} : {})}; }
if (ownerRole) {
  const packageData = await readManifest(), manifests = multiMode ? packageData.cues : [packageData];
  let manifest = manifests[0], cueIndex = 0, busy = false;
  const open = button('Open synthetic output', () => {
    if (seedMode) selected = manifest;
    popup = window.open(multiMode ? '/fixture-multi-output' : seedMode ? '/fixture-seed-output' : '/fixture-output', 'vdj-synthetic-browser-output-8892');
    if (!popup) error(Error('POPUP_BLOCKED')); else status.textContent = 'Output opened. Activate its audio button.';
  });
  const start = button('Commit synthetic AV', () => { void commit().catch(error); }); start.disabled = true;
  const stop = button('Stop synthetic output', () => {
    stopped = true; operation++; void channel?.call('stop', {}).then(async () => {
      evidence.checks.push({name: 'stop', passed: true}); status.textContent = 'STOPPED'; draw(); await save();
    }).catch(error);
  }); stop.disabled = true;
  if (seedMode) button('Reopen stopped seed graph', () => {
    selected = manifest; stopped = false; operation++; graphEpoch++; sourceRevision = evidence.ack?.playbackRevision ?? 0;
    void channel.call('restart', {graphEpoch, playbackRevision: sourceRevision, operationId: operation}).then(async () => {
      evidence.checks.push({name: 'fresh-suspended-restart-graph', passed: true}); status.textContent = 'Restart prepared. A new output audio gesture is required.'; draw(); await save();
    }).catch(error);
  });
  button('Test stale guard rejection', () => {
    selected = null; stopped = true; operation++;
    void channel.call('guard-test', {}).then(async result => {
      evidence.checks.push({name: 'stale-guard-rejection', passed: result.rejected === true}); draw(); await save();
    }).catch(error);
  });
  button('Close fixture output', () => { popup?.close(); });
  async function commit() {
    if (busy || multiMode && cueIndex >= manifests.length) throw Error('NO_NEXT_SYNTHETIC_CUE');
    busy = true; start.disabled = true;
    if (multiMode) manifest = manifests[cueIndex];
    if (!channel || stopped) stopped = false;
    selected = manifest; const revision = ++operation;
    const input = {roomId: manifest.roomId, cue: manifest.cue, plan: manifest.plan, expectedRevision: sourceRevision + 1, operationId: revision};
    status.textContent = 'Waiting for processed PCM and actual video frame presentation.';
    const result = await channel.call('commit', input, {timeoutMs: cloudPlaybackCommitTimeoutMs(input.plan)});
    if (revision !== operation || stopped) throw Error('OWNER_STALE_ACK');
    evidence.ack = result.ack; Object.assign(evidence, result.observations);
    if (multiMode) { evidence.cueAcks ??= []; evidence.cueAcks.push({...result.ack,
      processedWindow: result.observations.processedWindow}); cueIndex++; sourceRevision = result.ack.playbackRevision; }
    const creditResult = await channel.call('credit', {operationId: revision, roomId: input.roomId, cueId: input.cue.cueId,
      generationId: input.cue.generationId, playbackRevision: result.ack.playbackRevision, nickname: '合成ゲスト', actual: true, actualPlayback: true});
    evidence.checks.push({name: 'credit-overlay-after-browser-ack', passed: creditResult.shown === true});
    evidence.checks.push({name: 'actual-browser-start-ack', passed: result.ack.actual === true && result.ack.audioStarted === true && result.ack.videoPresented === true,
      nameDetail: 'browser processing and presentation; physical speaker unverified'});
    status.textContent = multiMode ? `PASS: ${cueIndex}/3 actual cue ACKs. ${cueIndex < 3 ? 'Queue the next synthetic AV tail.' : 'Finite three-tail run complete.'}` :
      'PASS: processed PCM SHA and presented video frame confirmed before ACK.';
    busy = false; start.disabled = !multiMode || cueIndex >= manifests.length; draw(); await save();
  }
  window.addEventListener('message', event => {
    if (event.source !== popup || event.origin !== location.origin || event.data?.type !== 'synthetic-output-ready' || channel) return;
    const pair = new MessageChannel();
    channel = createCloudPlaybackChannel({port: pair.port1, handle: async (type, data) => {
      if (type === 'state') { log('output-state', data); start.disabled = busy || (multiMode ? !['READY', 'PLAYING'].includes(data.phase) || cueIndex >= manifests.length : data.phase !== 'READY'); stop.disabled = !['READY', 'PREPARING', 'STARTING', 'PLAYING'].includes(data.phase); return {accepted: true}; }
      if (type === 'seed-state') { log('seed-state', data); return {accepted: true}; }
      if (type === 'seed-ack') {
        if (!seedMode || data.kind !== 'cloud-source-playback-started-v1' || data.sourceSha256 !== manifests[0].seed.source.sha256 ||
            data.sourcePlaybackRevision !== sourceRevision || data.graphEpoch !== graphEpoch || data.participantCredit !== false || data.actual !== true)
          throw Error('SEED_ACK_INVALID');
        if (graphEpoch === 1) evidence.seedAck = data; else evidence.restartAck = data;
        evidence.checks.push({name: graphEpoch === 1 ? 'seed-source-start-no-participant-credit' : 'restart-source-start-no-participant-credit', passed: true}); draw(); await save();
        return {accepted: true, graphEpoch, sourceSha256: data.sourceSha256, sourcePlaybackRevision: sourceRevision};
      }
      if (type === 'guard') { const valid = selected !== null && data.operationId === operation && !stopped;
        evidence.guards.push({phase: data.phase, valid}); draw(); return {valid}; }
      if (type === 'manifest') {
        if (!selected || data.operationId !== operation || stopped) throw Error('STALE_MANIFEST'); return selected;
      }
      if (type === 'asset') {
        if (!selected || data.operationId !== operation || stopped || !['music-fixture', 'video-fixture', 'seed-fixture', 'render-fixture', 'render-fixture-2', 'render-fixture-3'].includes(data.assetId)) throw Error('ASSET_NOT_RESERVED');
        const descriptor = data.assetId === 'music-fixture' ? selected.audio : data.assetId === 'video-fixture' ? selected.video : data.assetId === 'seed-fixture' ? manifests[0].seed?.descriptor : selected.renderAsset;
        if (!descriptor) throw Error('ASSET_NOT_RESERVED');
        if (data.sha256 !== descriptor.sha256) throw Error('ASSET_CHECKSUM_NOT_RESERVED');
        const paths = {'music-fixture': '/fixture-audio', 'video-fixture': '/fixture-video', 'seed-fixture': '/fixture-seed', 'render-fixture': '/fixture-render',
          'render-fixture-2': '/fixture-render-2', 'render-fixture-3': '/fixture-render-3'};
        const response = await fetch(paths[data.assetId], {redirect: 'error', cache: 'no-store'});
        const bytes = await response.arrayBuffer(); if (bytes.byteLength !== descriptor.byteLength || await pcmSha256(bytes) !== descriptor.sha256) throw Error('ASSET_SHA');
        return bytes;
      }
      throw Error('UNKNOWN_FIXTURE_COMMAND');
    }});
    popup.postMessage({type: 'synthetic-output-connect'}, location.origin, [pair.port2]);
  });
  window.addEventListener('pagehide', () => { void channel?.call('stop', {}).finally(() => channel?.close()); });
  status.textContent = 'Ready. Open the dedicated synthetic output.'; draw();
} else if (role.endsWith('output')) {
  const openerWindow = window.opener;
  const activate = button(seedMode ? 'Activate synthetic seed' : 'Activate synthetic audio', () => {
    if (!port) return;
    const unlocking = seedMode ? seed.start().then(async () => { await port.unlock(); seed.handoff(port); }) : port.unlock(); // direct gesture; resume before awaiting.
    void unlocking.then(() => { activate.disabled = true; status.textContent = 'READY: return to owner and commit synthetic AV.'; }).catch(error);
  }); activate.disabled = true;
  button('Stop output', () => { void port?.stop('OUTPUT_STOP').then(() => { status.textContent = 'STOPPED'; }).catch(error); });
  // Test-only native action: exercises the context-state watchdog without
  // injecting processor telemetry or reaching into runtime state through CUA.
  button('Suspend synthetic audio context', () => {
    if (!graph || graph.context.state !== 'running') return;
    void graph.context.suspend().then(() => {
      log('native-context-suspended', {contextState: graph.context.state,
        phase: port.read().phase, playbackRevision: port.read().playbackRevision});
      status.textContent = port.read().message;
    }).catch(error);
  });
  async function makeGraph() {
    const context = new AudioContext({sampleRate: 44100});
    await context.suspend(); await context.audioWorklet.addModule('/room-worklet.mjs');
    const node = new AudioWorkletNode(context, 'queue-audio', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]});
    let connected = true; node.connect(context.destination);
    if (multiMode) {
      const post = node.port.postMessage.bind(node.port); evidence.commandCounts ??= {};
      node.port.postMessage = (message, transfer) => { evidence.commandCounts[message.type] = (evidence.commandCounts[message.type] ?? 0) + 1;
        return post(message, transfer); };
    }
    evidence.sampleRate = context.sampleRate;
    node.port.addEventListener('message', async event => {
      if (multiMode && event.data.telemetry) {
        const {sampleRate, consumedFrames, receivedFrames, underrunFrames, stopped} = event.data.telemetry;
        evidence.telemetry = {sampleRate, consumedFrames, receivedFrames, underrunFrames, stopped};
      }
      if (!event.data.playedWindow) return;
      const window = event.data.playedWindow;
      evidence.processedWindow = {startFrame: window.startFrame, byteLength: window.pcm.byteLength,
        sha256: await pcmSha256(window.pcm), expectedSha256: prepared?.expectedPlayedWindowSha256 ?? null}; draw();
      if (multiMode) { evidence.processedWindows ??= []; evidence.processedWindows.push({...evidence.processedWindow}); }
    }); node.port.start();
    return {context, node, readSourceCount: () => connected ? 1 : 0,
      async stopAudio() { await context.suspend(); node.disconnect(); connected = false; await context.close(); }};
  }
  const mediaResolver = {
    async resolveMedia(input) {
      const manifest = await channel.call('manifest', {operationId: operation});
      if (manifest.cue.cueId !== input.cue.cueId || manifest.cue.generationId !== input.cue.generationId) throw Error('BINDING_MISMATCH');
      const renderAsset = manifest.renderAsset ?? manifest.audio;
      const audioBytes = await channel.call('asset', {operationId: operation, assetId: renderAsset.assetId, sha256: renderAsset.sha256});
      const videoBytes = await channel.call('asset', {operationId: operation, assetId: manifest.video.assetId, sha256: manifest.video.sha256});
      if (await pcmSha256(audioBytes) !== renderAsset.sha256 || await pcmSha256(videoBytes) !== manifest.video.sha256) throw Error('MEDIA_SHA_MISMATCH');
      const audio = {assetId: manifest.audio.assetId, sha256: manifest.audio.sha256, renderedPcmSha256: manifest.audio.renderedPcmSha256};
      prepared = {...manifest.audio, pcm: new Float32Array(audioBytes)};
      const url = URL.createObjectURL(new Blob([videoBytes], {type: 'video/mp4'}));
      return {audio, videos: [{assetId: manifest.video.assetId, sha256: manifest.video.sha256,
        url, source: 'fake', requestId: 'fixture-video'}], release() { URL.revokeObjectURL(url); }};
    },
    async loadVerifiedRender() { if (!prepared) throw Error('RENDER_NOT_PREPARED'); return prepared; },
  };
  const videos = [];
  function videoFactory() {
    const video = document.createElement('video'), native = video.requestVideoFrameCallback.bind(video);
    video.dataset.fixtureCueId = currentBinding?.cueId ?? 'seed-source'; videos.push(video);
    video.requestVideoFrameCallback = callback => native((now, metadata) => {
      evidence.videoFrames.push({nowMs: now, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
        width: metadata.width, height: metadata.height, muted: video.muted, volume: video.volume,
        ...(multiMode ? {cueId: video.dataset.fixtureCueId} : {})}); draw(); callback(now, metadata);
    });
    return video;
  }
  async function init({playbackRevision = 0, nextGraphEpoch = 1} = {}) {
    graphEpoch = nextGraphEpoch; sourceRevision = playbackRevision;
    graph = await makeGraph();
    fixtureCreditOverlay ??= createCloudCreditOverlay({element: document.getElementById('fixture-credit'),
      readPlayback: () => port?.read() ?? {}, readBinding: () => currentBinding});
    const lease = createAudioOutputLease();
    port = createCloudPlaybackAdapter({enabled: true, fixtureMode: true, mediaResolver, outputLease: lease, initialPlaybackRevision: playbackRevision,
      ackTimeoutMs: 8000,
      createAudioEngine: ({loadVerifiedRender}) => engine = createWorkletPlaybackEngine({...graph, allowInitialAudio: seedMode, loadVerifiedRender}),
      createVideoAdapter: options => createVideoAdapter({...options, crossfadeMs: 0,
        fetchImpl() { throw Error('PROVIDER_FETCH_FORBIDDEN'); }}), container: document.getElementById('video'), videoFactory,
      onState: state => { status.textContent = state.message;
        fixtureCreditOverlay.observePlaybackState(state);
        if (multiMode && state.playbackRevision > 0 && ['PREPARING', 'STARTING'].includes(state.phase)) {
          evidence.visualContinuity ??= []; evidence.visualContinuity.push({phase: state.phase, currentRevision: state.playbackRevision,
            pendingRevision: state.pendingRevision, visibleCueIds: videos.filter(video => video.isConnected && video.videoWidth > 0 &&
              Number(video.style.opacity) > 0).map(video => video.dataset.fixtureCueId)});
        }
        evidence.states.push({phase: state.phase, sourceCount: state.sourceCount, playbackRevision: state.playbackRevision,
        audioStarted: state.audioStarted, videoPresented: state.videoPresented}); draw();
        if (channel) void channel.call('state', state).catch(error); }});
    if (seedMode) {
      const manifest = await channel.call('manifest', {operationId: operation});
      const raw = await channel.call('asset', {operationId: operation, assetId: manifest.seed.descriptor.assetId, sha256: manifest.seed.descriptor.sha256});
      const plan = await prepareCloudInitialAudio({bytes: new Uint8Array(raw), descriptor: manifest.seed.descriptor,
        source: {...manifest.seed.source, playbackRevision}, firstPlan: {...manifest.seed.firstPlan, currentPlaybackRevision: playbackRevision},
        mode: graphEpoch === 1 ? 'initial' : 'restart', graphEpoch, previousGraphStopped: graphEpoch > 1});
      seed = createCloudSeedPlayback({enabled: true, plan, audioEngine: engine, outputLease: lease,
        guard: async ({phase}) => (await channel.call('guard', {operationId: operation, phase})).valid === true,
        markSourceStarted: ack => channel.call('seed-ack', ack), onState: state => {
          evidence.seedStates ??= []; evidence.seedStates.push(state); draw(); void channel.call('seed-state', state).catch(error); }});
    }
    activate.disabled = false; status.textContent = 'Activate this output with its audio button.';
  }
  window.addEventListener('message', event => {
    if (event.source !== openerWindow || event.origin !== location.origin || event.data?.type !== 'synthetic-output-connect' || event.ports?.length !== 1 || channel) return;
    channel = createCloudPlaybackChannel({port: event.ports[0], timeoutMs: 15000, handle: async (type, data) => {
      if (type === 'commit') {
        operation = data.operationId;
        currentBinding = {operationId: operation, roomId: data.roomId, cueId: data.cue.cueId,
          generationId: data.cue.generationId, expectedRevision: data.expectedRevision};
        const ack = await port.commitPlayback({...data, guard: async ({phase}) =>
          (await channel.call('guard', {operationId: operation, phase})).valid === true});
        // Hash observer is asynchronous; let its microtask finish before report.
        for (let n = 0; evidence.processedWindow?.startFrame !== data.plan.transition.exitFrame && n < 20; n++) await turn();
        return {ack, observations: compactOutput()};
      }
      if (type === 'credit') return fixtureCreditOverlay.show(data);
      if (type === 'stop') { fixtureCreditOverlay.clear(); await seed?.dispose(); await port.stop('OWNER_STOP'); return {stopped: true}; }
      if (type === 'restart') {
        if (!seedMode || !Number.isSafeInteger(data.graphEpoch) || data.graphEpoch <= graphEpoch ||
            !Number.isSafeInteger(data.playbackRevision) || data.playbackRevision !== port.read().playbackRevision)
          throw Error('RESTART_REVISION_OR_EPOCH_INVALID');
        operation = data.operationId;
        await seed?.dispose(); await port.dispose(); prepared = null;
        await init({playbackRevision: data.playbackRevision, nextGraphEpoch: data.graphEpoch}); return {prepared: true};
      }
      if (type === 'guard-test') {
        const check = await channel.call('guard', {operationId: operation, phase: 'ack'}); return {rejected: check.valid !== true};
      }
      throw Error('UNKNOWN_OUTPUT_COMMAND');
    }});
    void init().catch(error);
  });
  window.addEventListener('pagehide', () => { void port?.dispose(); channel?.close(); });
  openerWindow?.postMessage({type: 'synthetic-output-ready'}, location.origin);
  status.textContent = 'Waiting for the exact fixture owner connection.'; draw();
}
