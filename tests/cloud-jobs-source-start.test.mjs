import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../qa-tools/node_modules/@electric-sql/pglite/dist/index.js';
import {createSourceStartReceiptAdapter, createImmutableSourceStartReceiptStore} from '../cloud/jobs/source-start-receipts.mjs';
import {createExistingCloudRepositoryReadPorts} from '../cloud/jobs/repository-read-ports.mjs';
import {prepareBootstrap, saveBootstrap, decodeCompleteWave} from '../integration/runtime/bootstrap.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';
import {transitionDigest} from '../snapshot/app/runtime/dj-transition-selector.mjs';
import {syntheticWave, fixtureSha, createSyntheticPrivateStore} from './cloud-worker-fixture.mjs';

const owner = 'a'.repeat(64), guest = 'b'.repeat(64), h = value => value.repeat(64), RATE = 44100;
async function fixture() {
  const db = new PGlite(); await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for (const file of ['cloud/room/schema.sql', 'cloud/generation/schema.sql', 'cloud/generation/cue-operations.sql'])
    await db.exec(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  const uid = '11111111-1111-4111-a111-111111111111'; await db.query('insert into vdj_internal.owners(uid) values($1)', [uid]);
  const room = (await db.query("select public.vdj_room_request('create',null,null,$1::jsonb,$2) value", [
    JSON.stringify({ownerCapability: owner, joinCode: 'c'.repeat(64)}), uid])).rows[0].value;
  let clock = Date.now();
  const generation = async (action, capability = owner, payload = {}) => (await db.query('select public.vdj_generation_request($1,$2,$3,$4::jsonb) value',
    [action, room.roomId, capability, JSON.stringify(payload)])).rows[0].value;
  const repository = createExistingCloudRepositoryReadPorts({now: () => clock, query: (sql, values) => db.query(sql, values),
    hostGenerationRead: input => generation(input.action)}), scope = await repository.readScope({roomId: room.roomId});
  const {roomId, sessionId, controlRevision} = scope;
  const scoped = {roomId, sessionId, controlRevision}, store = createSyntheticPrivateStore();
  const bytes = syntheticWave(24), reference = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const prepared = await prepareBootstrap({audioBytes: bytes, referenceBytes: reference, inspect: async () => ({method: 'pcm-endpoint-profile-v1',
    assetSha256: fixtureSha(bytes), sampleRate: RATE, channels: 2, frameCount: 24 * RATE, nonfiniteSamples: 0,
    clippedFraction: 0, activity: {effectiveSilence: false, maxQuietRunSeconds: 0}, loudness: {truePeakDbtp: -6}})});
  const source = await saveBootstrap({prepared, store}); source.playback.actual = false;
  const firstPlan = {...scoped, status: 'ELIGIBLE', liveReady: true, qualityReady: true, fixtureOnly: false,
    currentClipId: source.music.clipId, currentSha256: source.music.sha256, currentContextSha256: source.music.contextSha256,
    currentPlaybackRevision: 0, transition: {renderVerified: true, renderedSha256: h('d'), sampleRate: RATE,
      timeStretch: false, pitchShift: false, editStartFrame: 24 * RATE - 442, exitFrame: 24 * RATE, entryFrame: 0}};
  firstPlan.planSha256 = transitionDigest(firstPlan);
  const selection = {...scoped, kind: 'server-selected-source-start-v1', serverQC: true, qcEvidenceSha256: h('e'),
    sourceSha256: cueDigest(cueSourceIdentity(source)), source, firstPlan};
  const graph = {...scoped, kind: 'selected-player-graph-v1', targetPlayerId: 'synthetic-browser', graphEpoch: 1, mode: 'initial',
    phase: 'SELECTED', freshGraph: true, sourceCount: 1, receivedFramesBeforeStart: 0, consumedFramesBeforeStart: 0,
    selectedAtMs: clock, expiresAtMs: clock + 30000};
  const pcm = decodeCompleteWave(bytes).pcm;
  const windowSha = fixtureSha(new Uint8Array(pcm.buffer, pcm.byteOffset, 256 * 8));
  const ack = {kind: 'cloud-source-playback-started-v1', graphEpoch: 1, sourceClipId: source.music.clipId,
    sourceSha256: source.music.sha256, sourceContextSha256: source.music.contextSha256, sourcePlaybackRevision: 0, sampleRate: RATE,
    playedUntilFrame: 512, processedWindowSha256: windowSha, actual: true, audioStarted: true, participantCredit: false};
  const observation = {...scoped, kind: 'authenticated-source-frontier-v1', targetPlayerId: graph.targetPlayerId, graphEpoch: 1,
    sourceClipId: ack.sourceClipId, sourceSha256: ack.sourceSha256, sourceContextSha256: ack.sourceContextSha256,
    sourcePlaybackRevision: 0, processedWindowSha256: windowSha, sampleRate: RATE, playedUntilFrame: 512,
    receivedFrames: firstPlan.transition.editStartFrame, sourceCount: 1, underrunFrames: 0, actual: true, audioStarted: true,
    participantCredit: false, serverObservedAtMs: clock};
  const records = new Map(); let puts = 0, loseWrite = false, stopReceipt = null;
  const receiptStore = createImmutableSourceStartReceiptStore({readRecord: async ({id}) => structuredClone(records.get(id) ?? null),
    putIfAbsent: async ({id, record}) => { if (!records.has(id)) { puts++; records.set(id, structuredClone(record)); }
      if (loseWrite) { loseWrite = false; throw Error('synthetic lost receipt write response'); } }});
  const options = {enabled: true, now: () => clock, authorizeOwner: async ({ownerCapability}) => { await generation('cueState', ownerCapability); return true; },
    readScope: input => repository.readScope(input), readPlaybackState: input => repository.readPlaybackState(input),
    readStartAuthority: async () => structuredClone(selection), readGraphAuthority: async () => structuredClone(graph),
    readPriorStopReceipt: async () => structuredClone(stopReceipt),
    verifyContinuation: async ({scope, firstPlan, source}) => ({...scope, kind: 'verified-first-continuation-v1', valid: true,
      planSha256: firstPlan.planSha256, renderedSha256: firstPlan.transition.renderedSha256,
      sourceSha256: source.music.sha256, contextSha256: source.music.contextSha256, evidenceSha256: h('f')}),
    readPlayerFrontier: async () => structuredClone(observation), assetStore: store, receiptStore};
  const adapter = createSourceStartReceiptAdapter(options), input = () => ({roomId: room.roomId, ownerCapability: owner, ack: structuredClone(ack)});
  const restart = () => {
    const body = {...scoped, kind: 'selected-player-graph-stopped-v1', targetPlayerId: graph.targetPlayerId, graphEpoch: graph.graphEpoch,
      stopped: true, serverStoppedAtMs: clock}; stopReceipt = {...body, receiptSha256: cueDigest(body)};
    Object.assign(graph, {mode: 'restart', previousGraphEpoch: graph.graphEpoch, previousTargetPlayerId: graph.targetPlayerId,
      priorStopReceiptSha256: stopReceipt.receiptSha256, graphEpoch: graph.graphEpoch + 1, selectedAtMs: clock, expiresAtMs: clock + 30000});
    ack.graphEpoch = graph.graphEpoch; observation.graphEpoch = graph.graphEpoch;
  };
  return {db, room, repository, source, selection, graph, ack, observation, store, records, options, adapter, input, restart,
    puts: () => puts, loseNextWrite: () => { loseWrite = true; }, advance: ms => { clock += ms; },
    now: () => clock, clearStop: () => { stopReceipt = null; }, generation};
}

test('atomic observed receipt port replaces repeated authority reads but rejects a stop or graph change after the write',async()=>{
 for(const mutation of ['none','stopped','graph','expiry']){
  const x=await fixture();try{
   let authorityReads=0,frontierReads=0,writes=0;
   const adapter=createSourceStartReceiptAdapter({...x.options,
    readStartAuthority:async input=>{authorityReads++;return x.options.readStartAuthority(input);},
    readPlayerFrontier:async()=>{frontierReads++;return structuredClone(x.observation);},
    receiptStore:{...x.options.receiptStore,saveObservedImmutable:async record=>{
     writes++;const saved=await x.options.receiptStore.saveImmutable(record);
     if(mutation==='stopped')x.observation.stopped=true;
     if(mutation==='graph')x.observation.graphEpoch++;
     if(mutation==='expiry')x.advance(31000);
     return saved;}}});
   if(mutation==='none')assert.equal((await adapter.markSourceStarted(x.input())).accepted,true);
   else await assert.rejects(adapter.markSourceStarted(x.input()),/FRESH_SOURCE_PLAYER_FRONTIER_REQUIRED|FRESH_SELECTED_GRAPH_REQUIRED/);
   assert.equal(authorityReads,1);assert.equal(writes,1);assert.equal(frontierReads,1);
   assert.equal((await x.generation('cueState')).currentCredit,null);
  }finally{await x.db.close();}
 }
});

test('default disabled; only owner-approved exact source-only PCM ACK creates immutable receipt and truthful initial current source', async () => {
  const x = await fixture(); try {
    const disabled = createSourceStartReceiptAdapter({...x.options, enabled: false});
    await assert.rejects(disabled.markSourceStarted(x.input()), /NOT_ACTIVATED/);
    await assert.rejects(x.adapter.markSourceStarted({...x.input(), ownerCapability: guest}), /OWNER_DENIED/);
    await assert.rejects(x.adapter.readInitialCurrentSource({roomId: x.room.roomId}), /RECEIPT_REQUIRED/);
    const receipt = await x.adapter.markSourceStarted(x.input()); assert.equal(receipt.accepted, true); assert.equal(receipt.participantCredit, false);
    const source = await x.adapter.readInitialCurrentSource({roomId: x.room.roomId});
    assert.equal(source.playback.actual, true); assert.equal(source.playback.playedUntilFrame, 512); assert.equal(source.sourceStart.sourceOnly, true);
    assert.equal((await x.adapter.readCurrent(x.room.roomId)).participantCredit, false); assert.equal(x.puts(), 1);
    const counts = (await x.db.query('select (select count(*) from vdj_internal.generation_operations) operations,(select count(*) from vdj_internal.generation_permits) permits')).rows[0];
    assert.deepEqual(counts, {operations: 0, permits: 0}); assert.equal((await x.generation('cueState')).currentCredit, null);
    assert(!JSON.stringify([...x.records.values()]).includes(owner)); assert(!JSON.stringify(receipt).includes('https:'));
  } finally { await x.db.close(); }
});
test('acknowledged immutable source reuse still requires a fresh authenticated graph/frontier, Stop state and unchanged30s lease',async()=>{
 const x=await fixture();try{
  let immutableReads=0,frontierReads=0,stopped=false;
  const adapter=createSourceStartReceiptAdapter({...x.options,
   readStartAuthority:async input=>{immutableReads++;return x.options.readStartAuthority(input);},
   receiptStore:{...x.options.receiptStore,read:async input=>{immutableReads++;return x.options.receiptStore.read(input);}},
   readAcknowledgedFrontier:async()=>{
    frontierReads++;await x.repository.readScope({roomId:x.room.roomId});
    return {...structuredClone(x.observation),playbackStopped:stopped};
   }});
  await adapter.markSourceStarted(x.input());const before=immutableReads;
  const first=await adapter.readInitialCurrentSource({roomId:x.room.roomId},{requirePlaying:true});
  first.music.sha256=h('0');assert.equal((await adapter.readInitialCurrentSource({roomId:x.room.roomId})).music.sha256,x.source.music.sha256);
  assert.equal(immutableReads,before);assert.equal(frontierReads,2);assert.equal(x.puts(),1);
  stopped=true;await assert.rejects(adapter.readInitialCurrentSource({roomId:x.room.roomId},{requirePlaying:true}),/PLAYBACK_SCOPE_REQUIRED/);stopped=false;
  await x.db.query('update vdj_internal.owners set enabled=false');await assert.rejects(adapter.readCurrent(x.room.roomId),/SCOPE_UNAVAILABLE/);
  await x.db.query('update vdj_internal.owners set enabled=true');
  x.advance(5001);await assert.rejects(adapter.readCurrent(x.room.roomId),/FRONTIER_REQUIRED/);
  x.observation.serverObservedAtMs=x.now();x.restart();await assert.rejects(adapter.readCurrent(x.room.roomId),/FRONTIER_REQUIRED/);
  x.advance(30001);await assert.rejects(adapter.readCurrent(x.room.roomId),/SELECTED_GRAPH_REQUIRED/);
 }finally{await x.db.close();}
});
test('duplicate ACK, overlapping start calls and lost immutable write response recover across fresh adapters without re-crediting', async () => {
  const x = await fixture(); try {
    x.loseNextWrite(); await assert.rejects(x.adapter.markSourceStarted(x.input()), /synthetic lost receipt write response/); assert.equal(x.puts(), 1);
    const fresh = createSourceStartReceiptAdapter(x.options), recovered = await fresh.markSourceStarted(x.input()); assert.equal(recovered.duplicate, true);
    const replies = await Promise.all([fresh.markSourceStarted(x.input()), createSourceStartReceiptAdapter(x.options).markSourceStarted(x.input())]);
    assert(replies.every(reply => reply.receiptSha256 === recovered.receiptSha256 && reply.duplicate)); assert.equal(x.puts(), 1);
    x.observation.playedUntilFrame = 1024;
    assert.equal((await createSourceStartReceiptAdapter(x.options).readCurrent(x.room.roomId)).playedUntilFrame, 1024);
    const changed = x.input(); changed.ack.playedUntilFrame = 768;
    await assert.rejects(fresh.markSourceStarted(changed), /ACK_CONFLICT/); assert.equal((await x.generation('cueState')).currentCredit, null);
  } finally { await x.db.close(); }
});
test('client selection/QC/timestamp, wrong seed/window/plan, zero or over-prefix frames and stale player observations cannot start source', async () => {
  const x = await fixture(); try {
    for (const mutate of [input => { input.sourceId = x.source.audioAssetId; }, input => { input.ack.observedAtMs = x.now(); },
      input => { input.ack.qcPassed = true; }, input => { input.ack.processedWindowSha256 = h('0'); },
      input => { input.ack.sourceSha256 = h('1'); }, input => { input.ack.playedUntilFrame = 0; },
      input => { input.ack.playedUntilFrame = 24 * RATE; }, input => { input.ack.participantCredit = true; },
      input => { input.ack.graphEpoch++; }]) {
      const input = x.input(); mutate(input); await assert.rejects(x.adapter.markSourceStarted(input));
    }
    assert.equal(x.puts(), 0); x.advance(5001);
    await assert.rejects(x.adapter.markSourceStarted(x.input()), /FRONTIER_REQUIRED/);
    x.observation.serverObservedAtMs = x.now(); x.selection.firstPlan.transition.editStartFrame -= 128;
    await assert.rejects(x.adapter.markSourceStarted(x.input()), /CONTINUATION_REQUIRED/);
  } finally { await x.db.close(); }
});
test('restart requires immutable prior stop and new fresh graph; old receipt or old target graph cannot be replayed', async () => {
  const x = await fixture(); try {
    await x.adapter.markSourceStarted(x.input()); const old = x.input(); x.restart();
    await assert.rejects(x.adapter.markSourceStarted(old), /PCM_ACK_REQUIRED/);
    await assert.rejects(x.adapter.readInitialCurrentSource({roomId: x.room.roomId}), /RECEIPT_REQUIRED/);
    const restarted = await x.adapter.markSourceStarted(x.input()); assert.equal(restarted.graphEpoch, 2); assert.equal(x.puts(), 2);
    assert.equal((await x.adapter.readCurrent(x.room.roomId)).graphEpoch, 2);
    x.restart(); x.clearStop(); await assert.rejects(x.adapter.markSourceStarted(x.input()), /PRIOR_GRAPH_STOP_REQUIRED/);
  } finally { await x.db.close(); }
});
test('scope/control/stop/handoff, private bytes and a changed measured continuation hold initial source even after receipt exists', async () => {
  const x = await fixture(); try {
    await x.adapter.markSourceStarted(x.input());
    const credited = createSourceStartReceiptAdapter({...x.options, readPlaybackState: async () => ({roomId: x.room.roomId, stopped: false, currentCredit: {actual: true}})});
    await assert.rejects(credited.readCurrent(x.room.roomId), /PLAYBACK_SCOPE_REQUIRED/);
    x.graph.phase = 'STOPPED'; await assert.rejects(x.adapter.readCurrent(x.room.roomId), /SELECTED_GRAPH_REQUIRED/); x.graph.phase = 'SELECTED';
    x.store.records.get(x.source.contextAssetId).bytes[50] ^= 1;
    await assert.rejects(x.adapter.readCurrent(x.room.roomId), /PRIVATE_ASSET_REQUIRED/);
    x.store.records.get(x.source.contextAssetId).bytes[50] ^= 1;
    const changedPlan = createSourceStartReceiptAdapter({...x.options, verifyContinuation: async () => ({valid: false})});
    await assert.rejects(changedPlan.readCurrent(x.room.roomId), /CONTINUATION_REQUIRED/);
    await x.db.query('update vdj_internal.rooms set control_revision=1 where id=$1', [x.room.roomId]);
    await assert.rejects(x.adapter.readCurrent(x.room.roomId), /SERVER_SELECTED_SOURCE_REQUIRED/);
  } finally { await x.db.close(); }
});
test('late authority stop cannot acknowledge committed receipt; immutable receipt still recovers only under unchanged current authority', async () => {
  const x = await fixture(); try {
    const store = {...x.options.receiptStore, saveImmutable: async record => {
      const result = await x.options.receiptStore.saveImmutable(record); x.graph.phase = 'STOPPED'; return result;
    }};
    const late = createSourceStartReceiptAdapter({...x.options, receiptStore: store});
    await assert.rejects(late.markSourceStarted(x.input()), /SELECTED_GRAPH_REQUIRED/); assert.equal(x.puts(), 1);
    await assert.rejects(x.adapter.markSourceStarted(x.input()), /SELECTED_GRAPH_REQUIRED/);
    // Fixture host restores the same still-selected authority only to test read
    // reconciliation; a real stopped graph must instead use a new graph epoch.
    x.graph.phase = 'SELECTED'; assert.equal((await x.adapter.markSourceStarted(x.input())).duplicate, true);
    x.records.values().next().value.ack.participantCredit = true;
    await assert.rejects(x.adapter.readCurrent(x.room.roomId), /IMMUTABLE_SOURCE_START_RECEIPT_REQUIRED/);
  } finally { await x.db.close(); }
});
test('server-selected bootstrap queues finite physical24s without an ELIGIBLE plan; receipt truth precedes generation and participant credit', async () => {
  const x = await fixture(); try {
    x.selection.mode = 'bootstrap'; delete x.selection.firstPlan;
    x.graph.finiteDurationFrames = 24 * RATE; x.observation.receivedFrames = 24 * RATE;
    const bootstrap = createSourceStartReceiptAdapter({...x.options, verifyContinuation: undefined});
    await assert.rejects(bootstrap.readInitialCurrentSource({roomId: x.room.roomId}), /RECEIPT_REQUIRED/);
    const started = await bootstrap.markSourceStarted(x.input()); assert.equal(started.participantCredit, false);
    const record = [...x.records.values()][0];
    assert.equal(record.startMode, 'bootstrap'); assert.equal(record.maximumDurationFrames, 24 * RATE);
    assert.equal(record.queuedPrefixFrames, 24 * RATE); assert.equal(record.continuationPlanSha256, null); assert.equal(record.continuationRenderSha256, null);
    const current = await bootstrap.readInitialCurrentSource({roomId: x.room.roomId});
    assert.equal(current.playback.actual, true); assert.equal(current.sourceStart.startMode, 'bootstrap');
    assert.equal(current.sourceStart.participantCredit, false); assert.equal((await x.generation('cueState')).currentCredit, null);
    const counts = (await x.db.query('select (select count(*) from vdj_internal.generation_operations) operations,(select count(*) from vdj_internal.generation_permits) permits')).rows[0];
    assert.deepEqual(counts, {operations: 0, permits: 0});
    x.graph.finiteDurationFrames = 180 * RATE; await assert.rejects(bootstrap.markSourceStarted(x.input()), /FINITE_BOOTSTRAP_SOURCE_REQUIRED/);
    x.graph.finiteDurationFrames = 24 * RATE; x.selection.firstPlan = {};
    await assert.rejects(bootstrap.markSourceStarted(x.input()), /FINITE_BOOTSTRAP_SOURCE_REQUIRED/);
    delete x.selection.firstPlan; x.observation.playedUntilFrame = 24 * RATE;
    await assert.rejects(bootstrap.readInitialCurrentSource({roomId: x.room.roomId}), /FRONTIER_REQUIRED/);
    x.observation.playedUntilFrame = 512; x.observation.stopped = true;
    await assert.rejects(bootstrap.readInitialCurrentSource({roomId: x.room.roomId}), /FRONTIER_REQUIRED/);
  } finally { await x.db.close(); }
});
test('existing SQL cueStop keeps source-only restart held until an explicit host restart-reset authority is supplied', async () => {
  const x = await fixture(); try {
    x.selection.mode = 'bootstrap'; delete x.selection.firstPlan; x.graph.finiteDurationFrames = 24 * RATE;
    x.observation.receivedFrames = 24 * RATE;
    const adapter = createSourceStartReceiptAdapter({...x.options, verifyContinuation: undefined});
    await adapter.markSourceStarted(x.input());
    // Existing cueStop persists in an existing generation operation. This
    // queued record is fixture-only and grants no provider execution or credit.
    const permitId = 'example_permit_' + 'p'.repeat(24), operationId = 'example_operation_' + 'o'.repeat(24);
    const permit = {permitId, source: x.source, sourceSha256: x.selection.sourceSha256};
    await x.db.query(`insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
      select $1,id,epoch,control_revision,now()+interval '10 minutes',$3::jsonb from vdj_internal.rooms where id=$2`, [permitId, x.room.roomId, JSON.stringify(permit)]);
    await x.db.query('insert into vdj_internal.generation_operations(id,permit_id,room_id,document) values($1,$2,$3,$4::jsonb)',
      [operationId, permitId, x.room.roomId, JSON.stringify({operationId, submissionId: 'example_submission', permit, stages: {}, stopped: false})]);
    await x.generation('cueStop'); assert.equal((await x.generation('cueState')).stopped, true);
    x.restart();
    await assert.rejects(adapter.markSourceStarted(x.input()), /INITIAL_SOURCE_PLAYBACK_SCOPE_REQUIRED/);
    await assert.rejects(adapter.readInitialCurrentSource({roomId: x.room.roomId}), /INITIAL_SOURCE_PLAYBACK_SCOPE_REQUIRED/);
    assert.equal((await x.generation('cueState')).stopped, true); assert.equal((await x.generation('cueState')).currentCredit, null);
    assert.equal(x.puts(), 1);
  } finally { await x.db.close(); }
});
test('custom durable receipt ports cannot bypass sealed ACK integrity or server chronology checks', async () => {
  const x = await fixture(); try {
    await x.adapter.markSourceStarted(x.input());
    const reseal = record => { const {receiptSha256, ...body} = record; record.receiptSha256 = cueDigest(body); };
    for (const mutate of [record => { record.receiptSha256 = h('0'); }, record => { record.ackSha256 = h('1'); reseal(record); },
      record => { delete record.serverReceivedAtMs; reseal(record); }, record => { record.serverReceivedAtMs = 0; reseal(record); },
      record => { record.serverReceivedAtMs = x.now() + 1; reseal(record); }, record => { record.kind = 'example_wrong_receipt'; reseal(record); }]) {
      const adapter = createSourceStartReceiptAdapter({...x.options, receiptStore: {...x.options.receiptStore, read: async key => {
        const record = await x.options.receiptStore.read(key); mutate(record); return record;
      }}});
      await assert.rejects(adapter.readInitialCurrentSource({roomId: x.room.roomId}), /VERIFIED_SOURCE_START_RECEIPT_REQUIRED/);
      await assert.rejects(adapter.markSourceStarted(x.input()), /VERIFIED_SOURCE_START_RECEIPT_REQUIRED/);
    }
    assert.equal(x.puts(), 1); assert.equal((await x.generation('cueState')).currentCredit, null);
  } finally { await x.db.close(); }
});
test('duplicate receipt lookup or delayed successful save cannot return accepted after a late graph stop or stale observer', async () => {
  const x = await fixture(); try {
    await x.adapter.markSourceStarted(x.input());
    const duplicate = createSourceStartReceiptAdapter({...x.options, receiptStore: {...x.options.receiptStore, read: async key => {
      const record = await x.options.receiptStore.read(key); x.graph.phase = 'STOPPED'; return record;
    }}});
    await assert.rejects(duplicate.markSourceStarted(x.input()), /SELECTED_GRAPH_REQUIRED/); assert.equal(x.puts(), 1);
    x.graph.phase = 'SELECTED'; x.restart();
    const delayed = createSourceStartReceiptAdapter({...x.options, receiptStore: {...x.options.receiptStore, saveImmutable: async record => {
      const saved = await x.options.receiptStore.saveImmutable(record); x.advance(5001); return saved;
    }}});
    await assert.rejects(delayed.markSourceStarted(x.input()), /FRONTIER_REQUIRED/); assert.equal(x.puts(), 2);
    // The durable receipt is retained, but source truth stays held until the
    // same registered target supplies a fresh observation under current scope.
    await assert.rejects(x.adapter.readInitialCurrentSource({roomId: x.room.roomId}), /FRONTIER_REQUIRED/);
    x.observation.serverObservedAtMs = x.now();
    assert.equal((await x.adapter.markSourceStarted(x.input())).duplicate, true);
  } finally { await x.db.close(); }
});
// Production 2026-10-16: the first Cue check arrived 41s after graph selection
// (preparation took longer than the lease), so the playing source could no
// longer be read as current and every reservation held forever.
test('show mode keeps an acknowledged playing source current past the 30s graph lease; Stop still holds it',async()=>{
 for(const showMode of [false,true]){
  const x=await fixture();try{
   let stopped=false;
   const adapter=createSourceStartReceiptAdapter({...x.options,showMode,maximumAgeMs:30000,
    readAcknowledgedFrontier:async()=>({...structuredClone(x.observation),serverObservedAtMs:x.now(),playbackStopped:stopped})});
   await adapter.markSourceStarted(x.input());
   x.advance(41000);
   const read=adapter.readInitialCurrentSource({roomId:x.room.roomId},{requirePlaying:true});
   if(!showMode){await assert.rejects(read,/FRESH_SELECTED_GRAPH_REQUIRED/);continue;}
   assert.equal((await read).playback.phase,'PLAYING');
   stopped=true;await assert.rejects(adapter.readInitialCurrentSource({roomId:x.room.roomId},{requirePlaying:true}),/PLAYBACK_SCOPE_REQUIRED/);
   // Startup (not yet playing) reads keep the strict lease.
   stopped=false;await assert.rejects(adapter.readInitialCurrentSource({roomId:x.room.roomId}),/FRESH_SELECTED_GRAPH_REQUIRED/);
  }finally{await x.db.close();}
 }
});
test('a measured crossfade first continuation (overlap ending at the seed end) establishes the source receipt', async () => {
  const x = await fixture(); try {
    const N = 3 * RATE, t = x.selection.firstPlan.transition;
    Object.assign(t, {overlapFrames: N, entryFrame: N / 2, exitFrame: 24 * RATE - N / 2, editStartFrame: 24 * RATE - N});
    const {planSha256, ...body} = x.selection.firstPlan; x.selection.firstPlan.planSha256 = transitionDigest(body);
    x.observation.receivedFrames = t.editStartFrame;
    const receipt = await x.adapter.markSourceStarted(x.input()); assert.equal(receipt.accepted, true);
    // An overlap that does not end exactly at the seed end is still refused.
    const y = await fixture(); try {
      const u = y.selection.firstPlan.transition;
      Object.assign(u, {overlapFrames: N, entryFrame: N / 2, exitFrame: 24 * RATE - N, editStartFrame: 24 * RATE - 3 * N / 2});
      const {planSha256: _, ...rest} = y.selection.firstPlan; y.selection.firstPlan.planSha256 = transitionDigest(rest);
      y.observation.receivedFrames = u.editStartFrame;
      await assert.rejects(y.adapter.markSourceStarted(y.input()), /MEASURED_FIRST_CONTINUATION_REQUIRED/);
    } finally { await y.db.close(); }
  } finally { await x.db.close(); }
});
