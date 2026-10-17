import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createTypedCloudHostComposition} from '../cloud/jobs/typed-host-composition.mjs';
import {createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';
import {createSupabasePrivateStore} from '../cloud/worker/supabase-private-store.mjs';
import {DispatchError} from '../cloud/generation/dispatch.mjs';
import {prepareBootstrap, saveBootstrap, decodeCompleteWave, contextWave} from '../integration/runtime/bootstrap.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {buildVerifiedCue, operationBinding} from '../cloud/generation/cue-contract.mjs';
import {syntheticStorageTransport} from './cloud-worker-store-fixture.mjs';
import {syntheticWave, fixtureSha} from './cloud-worker-fixture.mjs';

// Entire fixture is offline: existing SQL in PGlite, synthetic WAV and trusted
// QC/observer records, existing private-store logic over an in-memory transport.
// These records do not establish real player, provider or observer transport.
const owner = 'a'.repeat(64), guest = 'b'.repeat(64), invitation = 'c'.repeat(64), h = c => c.repeat(64), RATE = 44100;
const origin = 'https://ai-vdj.vercel.app';
const operationId = 'example_operation_' + 'o'.repeat(24), permitId = 'example_permit_' + 'p'.repeat(24);
function request(roomId, ack, {method = 'POST', headers = {}, body = JSON.stringify({ack}), path = '', requestOrigin = origin} = {}) {
  return new Request(origin + (path || '/api/rooms/' + roomId + '/source/ack'), {method,
    headers: {'Origin': requestOrigin, 'X-Room-Owner': owner, 'Content-Type': 'application/json', ...headers},
    ...(method === 'GET' ? {} : {body})});
}
async function fixture() {
  const db = new PGlite(); await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  const uid = '11111111-1111-4111-a111-111111111111'; await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
  const room = (await db.query("select public.vdj_room_request('create',null,null,$1::jsonb,$2) value",
    [JSON.stringify({ownerCapability: owner, joinCode: invitation}), uid])).rows[0].value;
  let time = Date.now(), selected = null, currentFrontier = null;
  const counters = {query: 0, rpc: 0, auth: 0, start: 0, graph: 0, source: 0, selected: 0, current: 0}, argumentsLog = [];
  const generation = async (action, payload = {}, capability = owner) => (await db.query(
    'select public.vdj_generation_request($1,$2,$3,$4::jsonb) value', [action, room.roomId, capability, JSON.stringify(payload)])).rows[0].value;
  const query = async (sql, values) => {counters.query++; assert(/^select\s/i.test(sql.trim()));
    assert(!values.includes(owner) && !values.includes(guest)); return db.query(sql, values);};
  const hostGenerationRead = input => {counters.rpc++; assert(!JSON.stringify(input).includes(owner));
    assert(['cueState', 'read'].includes(input.action)); return generation(input.action, input.operationId ? {operationId: input.operationId} : {});};
  const ports = createExistingCloudRepositoryReadPorts({query, hostGenerationRead, now: () => time});
  // sessionId is a database room epoch, not an authentication session.
  const {roomId, sessionId, controlRevision} = await ports.readScope({roomId: room.roomId});
  const scope = {roomId, sessionId, controlRevision};
  const storage = syntheticStorageTransport(), privateStore = createSupabasePrivateStore({enabled: true, roomId, transport: storage.transport});
  const seed = syntheticWave(24), reference = Uint8Array.from([137,80,78,71,13,10,26,10]);
  const profileFor = bytes => ({method: 'pcm-endpoint-profile-v1', assetSha256: fixtureSha(bytes), sampleRate: RATE,
    channels: 2, frameCount: 24 * RATE, nonfiniteSamples: 0, clippedFraction: 0,
    activity: {effectiveSilence: false, maxQuietRunSeconds: 0}, loudness: {truePeakDbtp: -6}});
  const prepared = await prepareBootstrap({audioBytes: seed, referenceBytes: reference, inspect: async () => profileFor(seed)});
  const source = await saveBootstrap({prepared, store: privateStore.assetStore}); source.playback.actual = false;
  const start = {...scope, kind: 'server-selected-source-start-v1', mode: 'bootstrap', serverQC: true,
    qcEvidenceSha256: h('d'), sourceSha256: cueDigest(cueSourceIdentity(source)), source};
  const graph = {...scope, kind: 'selected-player-graph-v1', targetPlayerId: 'example_selected_player', graphEpoch: 1,
    mode: 'initial', phase: 'SELECTED', freshGraph: true, sourceCount: 1, receivedFramesBeforeStart: 0,
    consumedFramesBeforeStart: 0, selectedAtMs: time, expiresAtMs: time + 30000, finiteDurationFrames: 24 * RATE};
  const pcm = decodeCompleteWave(seed).pcm, windowSha = fixtureSha(new Uint8Array(pcm.buffer, pcm.byteOffset, 256 * 8));
  const ack = {kind: 'cloud-source-playback-started-v1', graphEpoch: 1, sourceClipId: source.music.clipId,
    sourceSha256: source.music.sha256, sourceContextSha256: source.music.contextSha256, sourcePlaybackRevision: 0,
    sampleRate: RATE, playedUntilFrame: 512, processedWindowSha256: windowSha, actual: true, audioStarted: true, participantCredit: false};
  const frontier = {...scope, kind: 'authenticated-source-frontier-v1', targetPlayerId: graph.targetPlayerId, graphEpoch: 1,
    sourceClipId: ack.sourceClipId, sourceSha256: ack.sourceSha256, sourceContextSha256: ack.sourceContextSha256,
    sourcePlaybackRevision: 0, processedWindowSha256: windowSha, sampleRate: RATE, playedUntilFrame: 512,
    receivedFrames: 24 * RATE, sourceCount: 1, underrunFrames: 0, stopped: false, actual: true, audioStarted: true,
    participantCredit: false, serverObservedAtMs: time};
  const read = (name, get) => async input => {counters[name]++; argumentsLog.push({name, input: structuredClone(input)});
    assert(!JSON.stringify(input).includes(owner) && !JSON.stringify(input).includes(guest)); return structuredClone(get());};
  const authorities = {readStartAuthority: read('start', () => start), readGraphAuthority: read('graph', () => graph),
    readSourceFrontier: read('source', () => frontier), readSelectedTarget: read('selected', () => selected),
    readCurrentFrontier: read('current', () => currentFrontier)};
  const options = {enabled: true, roomId, query, hostGenerationRead, privateStore, authorities, now: () => time, origin,
    authorizeOwner: async ({roomId: requested, ownerCapability}) => {counters.auth++; assert.equal(requested, roomId);
      await generation('cueState', {}, ownerCapability); return true;}};
  const host = createTypedCloudHostComposition(options), input = {roomId};
  const receiptPuts = () => storage.calls.filter(c => c.action === 'put' && c.path.includes('/source-start-receipts/')).length;
  async function installGenerated() {
    await db.query("select public.vdj_room_request('join',$1,$2,$3::jsonb,null)", [roomId, invitation,
      JSON.stringify({nickname: 'example_guest', participantCapability: guest})]);
    const submission = (await db.query("select public.vdj_room_request('submit',$1,$2,$3::jsonb,null) value", [roomId, guest,
      JSON.stringify({nonce: 'example_submission_' + 's'.repeat(24), prompt: 'example request'})])).rows[0].value;
    const incoming = Buffer.from(seed); for (let n = 44; n < incoming.length; n += 2) incoming.writeInt16LE(-incoming.readInt16LE(n), n);
    const currentSource = await host.readCurrentSource(input), permit = {permitId, source: currentSource, sourceSha256: cueDigest(cueSourceIdentity(currentSource))};
    await db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
      select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`, [permitId, roomId, JSON.stringify(permit)]);
    const op = {operationId, submissionId: submission.submissionId, permit, stopped: false,
      plan: {status: 'COMPILED', commonIntentSha256: h('2'), common: {cueId: 'example_cue', control: {...source.music.control, version: 2, prompt: 'example private prompt'}}},
      stages: {music: {state: 'COMPLETE', requestId: 'example_music', result: {resultSha256: h('3')}},
        video: {state: 'COMPLETE', requestId: 'example_video', result: {resultSha256: h('4')}}}};
    const media = channel => ({binding: operationBinding(roomId, op, channel), durationSeconds: 24,
      asset: {assetId: channel === 'music' ? 'example_incoming' : 'example_timeline', sha256: channel === 'music' ? fixtureSha(incoming) : h('6')},
      providerReceipt: {requestId: op.stages[channel].requestId, resultSha256: op.stages[channel].result.resultSha256},
      privateSaved: true, checksumVerified: true, qc: {passed: true, scope: 'example_fixture_server'}});
    const music = {...media('music'), parentClipId: source.music.clipId, contextSha256: source.music.contextSha256,
      contextVerified: true, continuationVerified: true, profile: profileFor(incoming)};
    const video = {...media('video'), compositionQC: {passed: true}, review: {accepted: true, ownerArtisticApproval: true,
      assetSha256: h('6'), commonIntentSha256: op.plan.commonIntentSha256}, clips: [{assetId: 'example_clip', sha256: h('7'), durationSeconds: 5,
      qcPassed: true, approved: true, providerRequestId: op.stages.video.requestId, providerResultSha256: op.stages.video.result.resultSha256}],
      timeline: {durationSeconds: 24, timeStretch: false, approvedLoops: true, segments: [0,5,10,15,20].map(start => ({assetId: 'example_clip', sha256: h('7'),
        startSeconds: start, endSeconds: Math.min(start + 5, 24), sourceInSeconds: 0, sourceOutSeconds: Math.min(5, 24 - start), playbackRate: 1}))}};
    op.cue = buildVerifiedCue({roomId, operation: op, evidence: {actualGenerationThisRun: true, mode: 'provider', music, video}});
    op.cue.contribution = {participantId: submission.participantId, submissionId: submission.submissionId, nickname: submission.nickname};
    await privateStore.assetStore.save({id: 'example_incoming', bytes: incoming, contentType: 'audio/wav', binding: music.binding,
      provenance: {kind: 'provider', operationId, requestId: op.stages.music.requestId, resultSha256: op.stages.music.result.resultSha256}});
    await db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)', [operationId, permitId, roomId, JSON.stringify(op)]);
    const reservationId = 'example_reservation_' + 'r'.repeat(24);
    await generation('cueReserve', {operationId, reservationId, plan: {status: 'ELIGIBLE', liveReady: true, cueId: op.cue.cueId, incomingSha256: fixtureSha(incoming)},
      current: {actual: true, playbackRevision: 0}, expectedRevision: 1, expiresAtMs: time + 30000});
    const cueAck = {roomId, cueId: op.cue.cueId, clipId: 'example_incoming', playbackRevision: 1, audioTime: 9000, actual: true, audioStarted: true, videoPresented: true};
    await generation('cueAck', {reservationId, ack: cueAck, ackSha256: cueDigest(cueAck)});
    selected = {...scope, kind: 'selected-current-player-v1', targetPlayerId: graph.targetPlayerId,
      cueId: op.cue.cueId, generationId: op.cue.generationId, playbackRevision: 1, expiresAtMs: time + 30000};
    currentFrontier = {...scope, kind: 'authenticated-player-frontier-v1', targetPlayerId: graph.targetPlayerId, cueId: op.cue.cueId,
      generationId: op.cue.generationId, assetId: 'example_incoming', sha256: fixtureSha(incoming), playbackRevision: 1, playedUntilFrame: 1024,
      actual: true, audioStarted: true, videoPresented: true, observedAtMs: time, observationSha256: h('8')};
    return {incoming, op, selected, currentFrontier};
  }
  return {db, roomId, input, scope, storage, privateStore, counters, argumentsLog, options, host, source, graph, frontier, ack,
    installGenerated, generation, receiptPuts, now: () => time, setClock: value => {time = value;}, advance: ms => {time += ms;},
    close: async () => {privateStore.close(); await db.close();}};
}

test('default-off typed host constructor and gated methods perform no clock, SQL, RPC, private-store or observer IO', async () => {
  let calls = 0; const forbidden = () => {calls++; throw Error('example IO must not execute');};
  const options = {roomId: '11111111-1111-4111-a111-111111111111', query: forbidden, hostGenerationRead: forbidden, authorizeOwner: forbidden,
    now: forbidden, privateStore: {assetStore: {read: forbidden, save: forbidden, verifySaved: forbidden}, sourceStore: {read: forbidden, save: forbidden},
      sourceStartReceiptStore: {read: forbidden, saveImmutable: forbidden}}, authorities: {readStartAuthority: forbidden, readGraphAuthority: forbidden,
      readSourceFrontier: forbidden, readSelectedTarget: forbidden, readCurrentFrontier: forbidden}};
  const host = createTypedCloudHostComposition(options);
  await assert.rejects(host.readCurrentSource({roomId: options.roomId}), /NOT_ACTIVATED/);
  await assert.rejects(host.prepareCurrentSource({roomId: options.roomId}), /NOT_ACTIVATED/);
  await assert.rejects(host.readSourceRecord({roomId: options.roomId}), /NOT_ACTIVATED/);
  await assert.rejects(host.markSourceStarted({roomId: options.roomId}), /NOT_ACTIVATED/);
  assert.equal((await host.handleRequest(request(options.roomId, {}))).status, 503); assert.equal(calls, 0);
  assert.equal(host.capabilities().actualObserverTransportVerified, false); assert.equal(host.capabilities().credentialPersistence, false);
  assert.equal(host.repositoryPorts, undefined); assert.equal(host.privateStore, undefined);
});

test('fixture owner-only source ACK HTTP persists safe immutable receipt and fresh physical bootstrap without any participant credit', async () => {
  const x = await fixture(); try {
    await assert.rejects(x.host.readCurrentSource(x.input), /RECEIPT_REQUIRED/);
    const response = await x.host.handleRequest(request(x.roomId, x.ack)); assert.equal(response.status, 200);
    const receipt = await response.json(); assert.deepEqual(Object.keys(receipt).sort(), ['accepted','duplicate','sourceOnly','participantCredit','graphEpoch','sourceSha256','sourcePlaybackRevision','receiptSha256'].sort());
    assert.equal(receipt.sourceOnly, true); assert.equal(receipt.participantCredit, false); assert.equal(x.receiptPuts(), 1);
    const current = await x.host.readCurrentSource(x.input); assert.equal(current.playback.actual, true); assert.equal(current.playback.playedUntilFrame, 512);
    assert.equal(current.sourceStart.startMode, 'bootstrap'); assert.equal(current.music.sha256, x.ack.sourceSha256);
    x.frontier.playedUntilFrame = 1024; assert.equal((await x.host.readCurrent(x.roomId)).playedUntilFrame, 1024);
    const counts = (await x.db.query('select (select count(*) from vdj_internal.generation_operations) operations,(select count(*) from vdj_internal.generation_permits) permits')).rows[0];
    assert.deepEqual(counts, {operations: 0, permits: 0}); assert.equal((await x.generation('cueState')).currentCredit, null);
    assert(!JSON.stringify(receipt).includes(owner) && !JSON.stringify(receipt).includes(guest) && !JSON.stringify(receipt).includes('https:'));
    assert(![...x.storage.objects.values()].filter(o => o.contentType === 'application/json').some(o => o.bytes.toString().includes(owner)));
    assert(x.argumentsLog.every(({input}) => !Object.hasOwn(input, 'ownerCapability')));
    assert(x.counters.auth > 0 && x.counters.source > 0 && x.counters.rpc > 0);
  } finally {await x.close();}
});

test('atomic playback snapshots avoid duplicate initial wrappers and still reject Stop during its final frontier',async()=>{
 const x=await fixture();try{
  await x.host.markSourceStarted({roomId:x.roomId,ownerCapability:owner,ack:x.ack});
  const ports=createExistingCloudRepositoryReadPorts({query:x.options.query,hostGenerationRead:x.options.hostGenerationRead,now:x.options.now});let reads=0;
  const readPlaybackSnapshot=async input=>{reads++;const scope=await ports.readScope(input);return {scope,playback:await ports.readPlaybackState(x.scope)};};
  const host=createTypedCloudHostComposition({...x.options,authorities:{...x.options.authorities,readPlaybackSnapshot}});
  assert.equal((await host.readCurrentSource(x.input)).playback.actual,true);assert.equal(reads,1);
  let stopped=false;
  const raced=createTypedCloudHostComposition({...x.options,allowStoppedRestart:true,
   hostGenerationRead:async input=>({...await x.options.hostGenerationRead(input),stopped}),
   authorities:{...x.options.authorities,readPlaybackSnapshot,
   readSourceFrontier:async input=>{const value=await x.options.authorities.readSourceFrontier(input);stopped=true;return value;}}});
  await assert.rejects(raced.readCurrentSource(x.input),/INITIAL_SOURCE_PLAYBACK_SCOPE_REQUIRED/);
 }finally{await x.close();}
});
test('completed initial ACK routes directly through a fresh physical frontier; CURRENT and failed frontier never replay initial source',async()=>{
 const x=await fixture();try{
  const ports=createExistingCloudRepositoryReadPorts({query:x.options.query,hostGenerationRead:x.options.hostGenerationRead,now:x.options.now});
  let routingReads=0,frontierReads=0;
  const host=createTypedCloudHostComposition({...x.options,authorities:{...x.options.authorities,
   readPlaybackSnapshot:async()=>{routingReads++;return {scope:await ports.readScope(x.input),playback:await ports.readPlaybackState(x.scope)};},
   readAcknowledgedSourceFrontier:async()=>{
    frontierReads++;await ports.readScope(x.input);const playback=await ports.readPlaybackState(x.scope);
    if(playback.currentCredit!==null)throw new DispatchError('OBSERVER_TARGET_CHANGED');
    return {...structuredClone(x.frontier),playbackStopped:playback.stopped};
   }}});
  await host.markSourceStarted({roomId:x.roomId,ownerCapability:owner,ack:x.ack});
  assert.equal((await host.readCurrentSource(x.input)).playback.revision,0);assert.equal(routingReads,0);assert.equal(frontierReads,1);
  x.frontier.serverObservedAtMs=x.now()-5001;
  await assert.rejects(host.readCurrentSource(x.input),/FRONTIER_REQUIRED/);
  x.frontier.serverObservedAtMs=x.now();
  const generated=await x.installGenerated();await host.prepareCurrentSource(x.input);
  assert.equal((await host.readCurrentSource(x.input)).playback.revision,1);
  generated.currentFrontier.videoPresented=false;await assert.rejects(host.readCurrentSource(x.input),/FRONTIER_REQUIRED/);
  await x.generation('cueStop');await assert.rejects(host.readCurrentSource(x.input),/PLAYBACK_STOPPED/);
 }finally{await x.close();}
});
test('same-origin HTTP rejects caller authority, keys, malformed or oversized JSON before private IO and sanitizes arbitrary callback failures', async () => {
  const x = await fixture(); try {
    const before = {...x.counters}, calls = x.storage.calls.length;
    for (const variant of [{requestOrigin: 'https://example.invalid'}, {headers: {'Authorization': 'example-invalid'}},
      {headers: {'X-API-Key': 'example-invalid'}}, {headers: {'X-Fal-Key': 'example-invalid'}}, {method: 'GET'},
      {body: JSON.stringify({ack: x.ack, selectedPlayer: 'example_caller_target'})}, {body: JSON.stringify({ack: {...x.ack, serverObservedAtMs: x.now()}})},
      {body: JSON.stringify({ack: {...x.ack, sourceUrl: 'https://example.invalid'}})}, {body: '['},
      {body: new Uint8Array([255])}, {body: ' '.repeat(4097)}, {headers: {'Content-Type': 'text/plain'}}, {headers: {'Content-Type': 'application/jsonp'}},
      {path: '/api/rooms/22222222-2222-4222-a222-222222222222/source/ack'}, {headers: {'X-Room-Owner': ''}}]) {
      const response = await x.host.handleRequest(request(x.roomId, x.ack, variant)); assert(response.status >= 400);
      assert.equal(Object.keys(await response.json()).join(','), 'error');
    }
    assert.deepEqual(x.counters, before); assert.equal(x.storage.calls.length, calls);
    assert.equal(await x.host.handleRequest(request(x.roomId, x.ack, {path: '/unrelated'})), null);
    const denied = await x.host.handleRequest(request(x.roomId, x.ack, {headers: {'X-Room-Owner': guest}})); assert.equal(denied.status, 403);
    const faulty = createTypedCloudHostComposition({...x.options, authorities: {...x.options.authorities,
      readGraphAuthority: async () => {throw new DispatchError('EXAMPLE_PRIVATE_CALLBACK_DETAIL');}}});
    const response = await faulty.handleRequest(request(x.roomId, x.ack)); assert.deepEqual(await response.json(), {error: 'TYPED_SOURCE_ACK_HOLD'});
    assert.equal(x.receiptPuts(), 0);
  } finally {await x.close();}
});

test('duplicate, concurrent and lost receipt replies recover across fresh typed hosts without uploads or re-credit', async () => {
  const x = await fixture(); try {
    let lose = true;
    const privateStore = {...x.privateStore, sourceStartReceiptStore: {...x.privateStore.sourceStartReceiptStore, saveImmutable: async record => {
      const saved = await x.privateStore.sourceStartReceiptStore.saveImmutable(record); if (lose) {lose = false; throw Error('example lost private reply');} return saved;}}};
    const uncertain = createTypedCloudHostComposition({...x.options, privateStore});
    assert.equal((await uncertain.handleRequest(request(x.roomId, x.ack))).status, 409); assert.equal(x.receiptPuts(), 1);
    const fresh = createTypedCloudHostComposition(x.options), replies = await Promise.all([fresh.handleRequest(request(x.roomId, x.ack)), x.host.handleRequest(request(x.roomId, x.ack))]);
    for (const reply of replies) {assert.equal(reply.status, 200); assert.equal((await reply.json()).duplicate, true);}
    assert.equal(x.receiptPuts(), 1); assert.equal((await x.generation('cueState')).currentCredit, null);
    const receipt = [...x.storage.objects].find(([path]) => path.includes('/source-start-receipts/'))[1]; assert(!receipt.bytes.toString().includes(owner));
    x.host.close(); await assert.rejects(x.host.readCurrent(x.roomId), /CLOSED/);
    assert.equal((await fresh.readCurrent(x.roomId)).actual, true, 'closing assembly does not close the host-owned private store');
  } finally {await x.close();}
});

test('typed source requires stopped-false current graph and fresh observer; invalid clocks, expiry, owner and control fail closed', async () => {
  const x = await fixture(); try {
    await x.host.markSourceStarted({roomId: x.roomId, ownerCapability: owner, ack: x.ack});
    for (const change of [() => {x.frontier.stopped = true;}, () => {x.frontier.targetPlayerId = 'example_other_target';},
      () => {x.frontier.sourceSha256 = h('0');}, () => {x.frontier.serverObservedAtMs = x.now() + 1;},
      () => {x.frontier.serverObservedAtMs = x.now() - 5001;}]) {
      const original = structuredClone(x.frontier); change(); await assert.rejects(x.host.readCurrentSource(x.input), /FRONTIER_REQUIRED/); Object.assign(x.frontier, original);
    }
    x.graph.phase = 'STOPPED'; await assert.rejects(x.host.readCurrentSource(x.input), /SELECTED_GRAPH_REQUIRED/); x.graph.phase = 'SELECTED';
    for (const invalid of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const badClock = createTypedCloudHostComposition({...x.options, now: () => invalid}), counters = {...x.counters};
      await assert.rejects(badClock.readCurrentSource(x.input), /CLOCK_REQUIRED/);
      await assert.rejects(badClock.prepareCurrentSource(x.input), /CLOCK_REQUIRED/);
      assert.deepEqual(await (await badClock.handleRequest(request(x.roomId, x.ack))).json(), {error: 'TYPED_HOST_CLOCK_REQUIRED'});
      assert.deepEqual(x.counters, counters);
    }
    await x.db.query('update vdj_internal.owners set enabled=false'); await assert.rejects(x.host.readCurrentSource(x.input), /SCOPE_UNAVAILABLE/);
    await x.db.query('update vdj_internal.owners set enabled=true');
    await x.db.query('update vdj_internal.rooms set control_revision=1 where id=$1', [x.roomId]);
    await assert.rejects(x.host.readCurrentSource(x.input), /SERVER_SELECTED_SOURCE_REQUIRED/);
    // Expire against the fixture's injected clock, independent of wall time
    // spent descheduled by parallel suites. Both authority layers still hold.
    await x.db.query('update vdj_internal.rooms set control_revision=0,expires_at=to_timestamp($2::double precision/1000) where id=$1',
      [x.roomId, x.now() - 1]);
    await assert.rejects(x.host.readCurrentSource(x.input), /SCOPE_UNAVAILABLE/);
  } finally {await x.close();}
});

test('fixture complete source ACK to acknowledged generated source uses canonical snapshot and matching AV frontier, never bootstrap fallback', async () => {
  const x = await fixture(); try {
    assert.equal((await x.host.handleRequest(request(x.roomId, x.ack))).status, 200);
    const generated = await x.installGenerated(), sourceReads = x.counters.source;
    await assert.rejects(x.host.readCurrentSource(x.input), error => error.code === 'PRIVATE_STORE_HOLD' && error.holdReason === 'PRIVATE_ASSET_RECORD_REQUIRED');
    assert.equal(x.counters.source, sourceReads, 'generated missing context is held rather than reading bootstrap');
    const prepared = await x.host.prepareCurrentSource(x.input), record = await x.host.readSourceRecord(x.scope);
    assert.equal(record.source.playback.actual, false); assert.equal(record.source.music.contextSha256, fixtureSha(contextWave(decodeCompleteWave(generated.incoming))));
    assert.notEqual(record.source.music.contextSha256, x.source.music.contextSha256); assert.equal(record.source.music.control.prompt, undefined);
    const current = await x.host.readCurrentSource(x.input); assert.equal(current.playback.actual, true); assert.equal(current.playback.revision, 1);
    assert.equal(current.playback.playedUntilFrame, 1024); assert.equal(current.music.clipId, 'example_incoming'); assert.equal(current.sourceStart, undefined);
    const restartedStore = createSupabasePrivateStore({enabled: true, roomId: x.roomId, transport: x.storage.transport});
    const fresh = createTypedCloudHostComposition({...x.options, privateStore: restartedStore});
    assert.deepEqual(await fresh.prepareCurrentSource(x.input), prepared); assert.deepEqual(await fresh.readSourceRecord(x.scope), record);
    const puts = x.storage.calls.filter(c => c.action === 'put').length;
    generated.currentFrontier.playedUntilFrame = 2048; assert.equal((await fresh.readCurrent(x.roomId)).playedUntilFrame, 2048);
    for (const mutate of [() => {generated.currentFrontier.videoPresented = false;}, () => {generated.currentFrontier.targetPlayerId = 'example_other_target';},
      () => {generated.currentFrontier.observedAtMs = x.now() - 5001;}, () => {generated.currentFrontier.observedAtMs = x.now() + 1;}]) {
      const original = structuredClone(generated.currentFrontier); mutate(); await assert.rejects(fresh.readCurrentSource(x.input), /FRONTIER_REQUIRED/); Object.assign(generated.currentFrontier, original);
    }
    generated.selected.targetPlayerId = 'example_moved_target'; await assert.rejects(fresh.readCurrentSource(x.input), /FRONTIER_REQUIRED/);
    generated.selected.targetPlayerId = x.graph.targetPlayerId;
    await assert.rejects(fresh.readSourceRecord({...x.scope, sourceId: 'example_caller_selection'}), /SCOPE_CHANGED/);
    assert.equal(x.storage.calls.filter(c => c.action === 'put').length, puts); assert.equal(x.counters.source, sourceReads);
    assert.equal(Object.values((await x.generation('cueState')).servedCounts)[0], 1);
    await x.generation('cueStop'); await assert.rejects(fresh.readCurrentSource(x.input), /PLAYBACK_STOPPED/);
    assert.equal(x.counters.source, sourceReads); restartedStore.close();
  } finally {await x.close();}
});

test('late graph stop, close or current-source scope race suppress successful response even after durable receipt was saved', async () => {
  const x = await fixture(); try {
    const stopping = createTypedCloudHostComposition({...x.options, privateStore: {...x.privateStore,
      sourceStartReceiptStore: {...x.privateStore.sourceStartReceiptStore, saveImmutable: async record => {
        const saved = await x.privateStore.sourceStartReceiptStore.saveImmutable(record); x.graph.phase = 'STOPPED'; return saved;}}}});
    assert.equal((await stopping.handleRequest(request(x.roomId, x.ack))).status, 409); assert.equal(x.receiptPuts(), 1);
    await assert.rejects(x.host.readCurrentSource(x.input), /SELECTED_GRAPH_REQUIRED/);
    // Restoring same authority is fixture reconciliation only, not graph restart.
    x.graph.phase = 'SELECTED'; assert.equal((await (await x.host.handleRequest(request(x.roomId, x.ack))).json()).duplicate, true);
    let host;
    host = createTypedCloudHostComposition({...x.options, authorities: {...x.options.authorities,
      readSourceFrontier: async input => {const value = await x.options.authorities.readSourceFrontier(input); host.close(); return value;}}});
    assert.deepEqual(await (await host.handleRequest(request(x.roomId, x.ack))).json(), {error: 'TYPED_HOST_CLOSED'});
    let changed = false;
    const raced = createTypedCloudHostComposition({...x.options, authorities: {...x.options.authorities,
      readSourceFrontier: async input => {const value = await x.options.authorities.readSourceFrontier(input);
        if (!changed) {changed = true; await x.db.query('update vdj_internal.rooms set control_revision=1 where id=$1', [x.roomId]);} return value;}}});
    await assert.rejects(raced.readCurrentSource(x.input), /SOURCE_CHANGED|SERVER_SELECTED_SOURCE_REQUIRED/);
    assert.equal(x.receiptPuts(), 1);
  } finally {await x.close();}
});


test('physical corruption and clock becoming nonfinite mid-observation hold both source paths without bootstrap fallback', async () => {
  const x = await fixture(); try {
    await x.host.markSourceStarted({roomId: x.roomId, ownerCapability: owner, ack: x.ack});
    const physical = [...x.storage.objects].find(([path]) => path.endsWith('/' + x.source.contextAssetId + '.media'))[1];
    physical.bytes[50] ^= 1;
    await assert.rejects(x.host.readCurrentSource(x.input), error => error.code === 'PRIVATE_STORE_HOLD' && error.holdReason === 'PRIVATE_ASSET_PHYSICAL_SHA_MISMATCH');
    physical.bytes[50] ^= 1;
    const midClock = createTypedCloudHostComposition({...x.options, authorities: {...x.options.authorities,
      readSourceFrontier: async input => {const value = await x.options.authorities.readSourceFrontier(input); x.setClock(NaN); return value;}}});
    const validTime = x.now();
    await assert.rejects(midClock.readCurrentSource(x.input), /CLOCK_REQUIRED/); x.setClock(validTime);
    const generated = await x.installGenerated(); await x.host.prepareCurrentSource(x.input);
    const before = x.counters.source, parent = [...x.storage.objects].find(([path]) => path.endsWith('/example_incoming.media'))[1];
    parent.bytes[50] ^= 1;
    await assert.rejects(x.host.readCurrentSource(x.input), error => error.code === 'PRIVATE_STORE_HOLD' && error.holdReason === 'PRIVATE_ASSET_PHYSICAL_SHA_MISMATCH');
    parent.bytes[50] ^= 1;
    const rawSnapshot = [...x.storage.objects].find(([path]) => path.includes('/sources/'))[1];
    const original = Buffer.from(rawSnapshot.bytes), saved = JSON.parse(original);
    saved.source.playback = {phase: 'PLAYING', revision: 1, playedUntilFrame: 1024, actual: true};
    rawSnapshot.bytes = Buffer.from(JSON.stringify(saved));
    await assert.rejects(x.host.readCurrentSource(x.input), error => error.code === 'PRIVATE_STORE_HOLD' && error.holdReason === 'PRIVATE_STORE_RECORD_CHANGED');
    rawSnapshot.bytes = original;
    generated.currentFrontier.videoPresented = false; await assert.rejects(x.host.readCurrentSource(x.input), /FRONTIER_REQUIRED/);
    assert.equal(x.counters.source, before); assert.equal(x.receiptPuts(), 1);
    assert.equal(Object.values((await x.generation('cueState')).servedCounts)[0], 1);
  } finally {await x.close();}
});
