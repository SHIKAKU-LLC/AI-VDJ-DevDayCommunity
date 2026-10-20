import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudGenerationJobs} from '../cloud/jobs/generation-jobs.mjs';
import {createCloudJobHandler, createCloudMediaHandler, createCloudMediaManifestHandler} from '../cloud/jobs/http.mjs';
import {createCueCoordinator} from '../cloud/generation/cue-coordinator.mjs';
import {operationBinding} from '../cloud/generation/cue-contract.mjs';
import {DispatchError, GENERATION_CONTRACT} from '../cloud/generation/dispatch.mjs';
import {cueDigest, cueSourceIdentity} from '../snapshot/app/runtime/intent-compiler.mjs';

const owner = 'a'.repeat(64), roomId = '11111111-1111-4111-a111-111111111111';
const operationId = 'operation_' + 'o'.repeat(24), permitId = 'permit_' + 'p'.repeat(24);
const submissionId = 'synthetic-submission', key = 'synthetic-cloud-credential';
const source = {music: {clipId: 'synthetic-parent', contextSeconds: 16, contextSha256: 'd'.repeat(64),
  contextVerified: true, ready: true, control: {version: 1, energy: .5, tension: .5, density: .5, brightness: .5}},
  video: {motifId: 'synthetic-motif', motifSnapshotSha256: 'e'.repeat(64), referenceSha256: 'f'.repeat(64)},
  quality: {fixedBpm: 145, tempoConfidence: 'assumed'}};
const semantic = {needsClarification: false, question: '', interpretation: '穏やかに広がる', direction: 'down',
  intensity: .5, visualOpenness: 'increase', musicDevelopment: 'Reduce competing layers gently.',
  visualDevelopment: 'Open the geometry and preserve detail.'};
function fixture(overrides = {}) {
  let time = 10000, op, allowed = true, stopped = false, credentialReads = 0;
  const permit = {permitId, kind: GENERATION_CONTRACT.version, counts: GENERATION_CONTRACT.counts,
    createdAtMs: time, expiresAtMs: time + 600000, maximumUsd: 1, source,
    sourceSha256: cueDigest(cueSourceIdentity(source)),
    quote: {verified: true, evidenceSha256: '1'.repeat(64), observedAtMs: time, maximumUsd: {intent: .01, music: .1, video: .5}},
    balance: {usd: 2, autoTopUp: false, observedAtMs: time}, assets: {
      context: {url: 'https://media.example.invalid/private/context', private: true, checksumVerified: true,
        sha256: source.music.contextSha256, expiresAtMs: time + 660000, serverAudioQC: true, providerOriginVerified: true},
      reference: {url: 'https://media.example.invalid/private/reference', private: true, checksumVerified: true,
        sha256: source.video.referenceSha256, expiresAtMs: time + 660000}}};
  const repository = {async request(action, room, capability, payload = {}) {
    if (room !== roomId || capability !== owner) throw new DispatchError('OWNER_DENIED');
    if (action === 'permit') {
      if (payload.permitId !== permitId) throw new DispatchError('GENERATION_PERMIT_REQUIRED');
      return structuredClone(permit);
    }
    if (action === 'begin') {
      if (op && (payload.operationId !== op.operationId || payload.submissionId !== op.submissionId || payload.keyProof !== op.keyProof))
        throw new DispatchError('PERMIT_ALREADY_USED');
      op ??= {operationId: payload.operationId, submissionId: payload.submissionId, keyProof: payload.keyProof,
        prompt: '静かな星空', permit: structuredClone(permit), stages: {}, stopped: false};
      return structuredClone(op);
    }
    if (!op || payload.operationId !== operationId) throw new DispatchError('GENERATION_OPERATION_REQUIRED');
    if (action === 'read') return {...structuredClone(op), dispatchAllowed: allowed && time < permit.expiresAtMs};
    if (action === 'stop') { op.stopped = true; stopped = true; return structuredClone(op); }
    if (action === 'cuePublish') { op.cue = structuredClone(payload.cue); return structuredClone(op.cue); }
    const prior = op.stages[payload.stage];
    if (action === 'claim') {
      if (prior) throw new DispatchError('STAGE_ALREADY_RESERVED');
      if (stopped || !allowed) throw new DispatchError('SOURCE_OR_CONTROL_CHANGED');
      op.stages[payload.stage] = {state: 'RESERVED', signature: payload.signature};
      if (overrides.afterClaim) await overrides.afterClaim(payload.stage);
    } else if (action === 'submitted' || action === 'unknown') {
      if (prior?.state !== 'RESERVED') throw new DispatchError('STAGE_CLAIM_REQUIRED');
      Object.assign(prior, {state: action === 'submitted' ? 'SUBMITTED' : 'UNKNOWN'},
        action === 'submitted' ? {requestId: payload.requestId} : {});
      if (action === 'submitted' && overrides.loseSubmittedReply && payload.stage === 'intent') throw Error('synthetic lost durable response');
    } else if (action === 'complete') {
      if (prior.state === 'COMPLETE') return structuredClone(op);
      Object.assign(prior, {state: 'COMPLETE', result: payload.result}); if (payload.plan) op.plan = payload.plan;
    } else if (action === 'held' || action === 'failed') prior.state = action === 'held' ? 'HOLD' : 'FAILED';
    else throw Error('unsupported fixture operation');
    return structuredClone(op);
  }};
  const posts = [], polls = [], hints = [];
  const provider = {async submit(input) { posts.push(input.model); if (overrides.submit) return overrides.submit(input);
    await new Promise(resolve => setImmediate(resolve)); return {request_id: 'synthetic_' + posts.indexOf(input.model)}; },
    async status(input) { polls.push(input.requestId); return {status: 'COMPLETED'}; },
    async result(input) { return {data: input.model === GENERATION_CONTRACT.intent ? {output: JSON.stringify(semantic), usage: {cost: .001}} :
      input.model === GENERATION_CONTRACT.music ? {audio: {url: 'https://v3.fal.media/synthetic.wav'}} :
        {video: {url: 'https://v3.fal.media/synthetic.mp4'}}}; }};
  const options = {enabled: true, repository, provider, mediaHost: 'media.example.invalid', now: () => time,
    credentialForOperation: async binding => { credentialReads++; assert.deepEqual(binding, {roomId, operationId}); return key; },
    schedule: async hint => hints.push(hint)};
  const input = {roomId, operationId, ownerCapability: owner};
  return {repository, provider, options, input, permit, posts, polls, hints, jobs: createCloudGenerationJobs(options),
    start: () => ({...input, permitId, submissionId}), op: () => op,
    credentialReads: () => credentialReads, sourceChanged: () => { allowed = false; }, expire: () => { time = permit.expiresAtMs; }};
}

test('durable operation drives intent then concurrent AV across fresh workers, without a browser session', async () => {
  const x = fixture(); await x.jobs.start(x.start());
  await x.jobs.advance(x.input); assert.deepEqual(x.posts, [GENERATION_CONTRACT.intent]);
  const restarted = createCloudGenerationJobs(x.options);
  await restarted.advance(x.input); assert.equal(x.posts.length, 3);
  const done = await restarted.advance(x.input); assert.equal(done.state, 'WAIT_QC'); assert.equal(done.cueReady, false);
  assert.equal(done.actualPlayback, false); assert.equal(done.playerAcknowledged, false);
  await restarted.advance(x.input); assert.equal(x.posts.length, 3);
  assert.equal(x.polls.length, 3); assert.equal(x.hints.every(h => Object.keys(h).sort().join() === 'operationId,roomId'), true);
  assert.equal(JSON.stringify(done).includes('https:'), false); assert.equal(JSON.stringify(x.op()).includes(key), false);
});
test('default activation is false; owner read never requires provider credentials', async () => {
  const x = fixture(); await x.jobs.start(x.start());
  const disabled = createCloudGenerationJobs({repository: x.repository});
  await assert.rejects(disabled.start(x.start()), /NOT_ACTIVATED/);
  assert.equal((await disabled.read(x.input)).state, 'PENDING');
  const reads = x.credentialReads(); await x.jobs.read(x.input); assert.equal(x.credentialReads(), reads);
  await assert.rejects(x.jobs.start({...x.start(), ownerCapability: 'b'.repeat(64)}), /OWNER_DENIED/);
  assert.equal(x.credentialReads(), reads);
});
test('lost scheduler notifications do not change authoritative start/progress or create new operation work', async () => {
  const x = fixture(), jobs = createCloudGenerationJobs({...x.options, schedule: async () => { throw Error('synthetic lost hint'); }});
  assert.equal((await jobs.start(x.start())).state, 'PENDING');
  assert.equal((await jobs.start(x.start())).operationId, operationId);
  await jobs.advance(x.input); await jobs.advance(x.input);
  assert.equal((await jobs.advance(x.input)).state, 'WAIT_QC'); assert.equal(x.posts.length, 3);
});

test('a configured wake hint does not certify a durable scheduler', () => {
  const x = fixture();
  assert.equal(x.jobs.capabilities().durableScheduler, false);
  assert.equal(x.jobs.capabilities().wakeHintConfigured, true);
  const plain = createCloudGenerationJobs({...x.options, schedule: undefined});
  assert.equal(plain.capabilities().durableScheduler, false);
  assert.equal(plain.capabilities().wakeHintConfigured, false);
});
test('duplicate starts/advance reuse request IDs and never repost after lost provider or durable response', async () => {
  const lost = fixture({submit: async () => { throw Error('synthetic lost provider response'); }});
  await lost.jobs.start(lost.start()); await lost.jobs.start(lost.start());
  await assert.rejects(lost.jobs.advance(lost.input), /UNKNOWN_NO_RETRY/);
  assert.equal((await createCloudGenerationJobs(lost.options).advance(lost.input)).state, 'HOLD'); assert.equal(lost.posts.length, 1);
  await assert.rejects(lost.jobs.start({...lost.start(), submissionId: 'different'}), /PERMIT_ALREADY_USED/);
  const durable = fixture({loseSubmittedReply: true}); await durable.jobs.start(durable.start());
  await assert.rejects(durable.jobs.advance(durable.input), /UNKNOWN_NO_RETRY/);
  await createCloudGenerationJobs(durable.options).advance(durable.input); assert.equal(durable.posts.filter(m => m === GENERATION_CONTRACT.intent).length, 1);
});
test('stop, source change and expiry prevent subsequent provider work; guards recheck after claim', async () => {
  for (const change of ['stop', 'sourceChanged', 'expire']) {
    const x = fixture(); await x.jobs.start(x.start());
    if (change === 'stop') await x.jobs.stop(x.input); else x[change]();
    const result = await x.jobs.advance(x.input); assert(['STOPPED', 'HOLD'].includes(result.state)); assert.equal(x.posts.length, 0);
  }
  let x; x = fixture({afterClaim: async () => x.sourceChanged()}); await x.jobs.start(x.start());
  await assert.rejects(x.jobs.advance(x.input), /UNKNOWN_NO_RETRY/); assert.equal(x.posts.length, 0);
});
test('overlapping workers share atomic claims; a second worker cannot post reserved intent', async () => {
  let release, entered; const begun = new Promise(resolve => entered = resolve), waiting = new Promise(resolve => release = resolve);
  const x = fixture({submit: async () => { entered(); await waiting; return {request_id: 'one_intent_request'}; }});
  await x.jobs.start(x.start()); const first = x.jobs.advance(x.input); await begun;
  assert.equal((await createCloudGenerationJobs(x.options).advance(x.input)).state, 'HOLD');
  release(); await first; assert.equal(x.posts.length, 1);
});
test('trusted coordinator refuses absent/untrusted portable QC and keeps complete AV at WAIT_QC', async () => {
  const x = fixture(); const coordinator = createCueCoordinator({enabled: true, repository: x.repository,
    inspectGeneration: async () => ({actualGenerationThisRun: false, mode: 'simulation'})});
  const jobs = createCloudGenerationJobs({...x.options, coordinator}); await jobs.start(x.start());
  await jobs.advance(x.input); await jobs.advance(x.input);
  assert.equal((await jobs.advance(x.input)).state, 'WAIT_QC'); assert.equal(x.op().cue, undefined);
  const bad = createCloudGenerationJobs({...x.options, coordinator: createCueCoordinator({enabled: true, repository: x.repository,
    inspectGeneration: async () => ({actualGenerationThisRun: true, mode: 'provider', music: {binding: {}, qc: {passed: true}}, video: {binding: {}, qc: {passed: true}}})})});
  assert.equal((await bad.advance(x.input)).state, 'WAIT_QC'); assert.equal(x.op().cue, undefined);
  const missingSaved = createCloudGenerationJobs({...x.options, coordinator: createCueCoordinator({enabled: true, repository: x.repository,
    inspectGeneration: async () => { throw new DispatchError('PORTABLE_QC_HOLD'); }})});
  assert.equal((await missingSaved.advance(x.input)).state, 'WAIT_QC');
  const diagnostics=[];
  const held=createCloudGenerationJobs({...x.options,onDiagnostic:value=>diagnostics.push(value),
    coordinator:createCueCoordinator({enabled:true,repository:x.repository,inspectGeneration:async()=>{
      const error=new DispatchError('PORTABLE_QC_HOLD');error.holdReason='PROTOTYPE_AUDIO_QC_HOLD';throw error;
    }})});
  assert.equal((await held.advance(x.input)).state,'WAIT_QC');
  assert.deepEqual(diagnostics,[{event:'GENERATION_QC_HOLD',reason:operationId+':PROTOTYPE_AUDIO_QC_HOLD'}]);
  diagnostics.length=0;
  const unsafe=createCloudGenerationJobs({...x.options,onDiagnostic:value=>diagnostics.push(value),
    coordinator:createCueCoordinator({enabled:true,repository:x.repository,inspectGeneration:async()=>{
      const error=new DispatchError('PORTABLE_QC_HOLD');error.holdReason='https://private.invalid/credential';throw error;
    }})});
  assert.equal((await unsafe.advance(x.input)).state,'WAIT_QC');
  assert.deepEqual(diagnostics,[{event:'GENERATION_QC_HOLD',reason:operationId+':PORTABLE_QC_HOLD'}]);
  const unexpected = createCloudGenerationJobs({...x.options, coordinator: createCueCoordinator({enabled: true, repository: x.repository,
    inspectGeneration: async () => { throw Error('unexpected adapter failure'); }})});
  await assert.rejects(unexpected.advance(x.input), /unexpected adapter failure/);
});
test('only trusted bound saved AV evidence publishes READY, without credential access; reservation is separate from player ACK', async () => {
  const x = fixture(); await x.jobs.start(x.start()); await x.jobs.advance(x.input); await x.jobs.advance(x.input); await x.jobs.advance(x.input);
  const op = x.op(), assetSha = '6'.repeat(64), videoSha = '7'.repeat(64), clipSha = '8'.repeat(64);
  const receipt = stage => ({requestId: op.stages[stage].requestId, resultSha256: op.stages[stage].result.resultSha256});
  const music = {binding: operationBinding(roomId, op, 'music'), providerReceipt: receipt('music'), durationSeconds: 24,
    qc: {passed: true, scope: 'synthetic-server'}, privateSaved: true, checksumVerified: true,
    asset: {assetId: 'synthetic-audio', sha256: assetSha}, parentClipId: source.music.clipId,
    contextSha256: source.music.contextSha256, contextVerified: true, continuationVerified: true,
    profile: {method: 'pcm-endpoint-profile-v1', assetSha256: assetSha, sampleRate: 44100, channels: 2, frameCount: 24 * 44100}};
  const video = {binding: operationBinding(roomId, op, 'video'), providerReceipt: receipt('video'), durationSeconds: 24,
    qc: {passed: true, scope: 'synthetic-server'}, privateSaved: true, checksumVerified: true,
    asset: {assetId: 'synthetic-timeline', sha256: videoSha}, compositionQC: {passed: true},
    review: {accepted: true, ownerArtisticApproval: true, assetSha256: videoSha, commonIntentSha256: op.plan.commonIntentSha256},
    clips: [{assetId: 'synthetic-clip', sha256: clipSha, durationSeconds: 5, qcPassed: true, approved: true,
      providerRequestId: receipt('video').requestId, providerResultSha256: receipt('video').resultSha256}],
    timeline: {durationSeconds: 24, timeStretch: false, approvedLoops: true, segments: [0, 5, 10, 15, 20].map(start => ({
      assetId: 'synthetic-clip', sha256: clipSha, startSeconds: start, endSeconds: Math.min(24, start + 5),
      sourceInSeconds: 0, sourceOutSeconds: Math.min(5, 24 - start), playbackRate: 1}))}};
  let prepared = 0; const published = [];
  const coordinator = createCueCoordinator({enabled: true, repository: x.repository,
    inspectGeneration: async () => ({actualGenerationThisRun: true, mode: 'provider', music, video})});
  const jobs = createCloudGenerationJobs({...x.options, provider: undefined,
    credentialForOperation: undefined, coordinator, prepareMedia: async binding => { prepared++; assert.deepEqual(binding, {roomId, operationId}); },
    // A newly READY Cue starts its pair preparation; the hook gets IDs only.
    onPublished: binding => { published.push(binding); throw Error('a hook failure never changes the publication'); }});
  assert.equal((await jobs.advance(x.input)).state, 'READY'); assert.equal(prepared, 1);
  assert.deepEqual(published, [{roomId, operationId}]);
  assert.equal((await jobs.advance(x.input)).state, 'READY'); assert.equal(prepared, 1); assert.equal(published.length, 1);
  op.cue.status = 'SELECTED'; const reserved = await jobs.read(x.input);
  assert.equal(reserved.reservationAcknowledged, true); assert.equal(reserved.playerAcknowledged, false); assert.equal(reserved.actualPlayback, false);
  // Fixture-only authoritative RPC projection after matching actual player ACK.
  op.cue.status = 'PLAYING'; op.cue.playbackRevision = 1; const playing = await jobs.read(x.input);
  assert.equal(playing.playerAcknowledged, true); assert.equal(playing.actualPlayback, true);
  const verified = structuredClone(op.cue);
  for (const mutate of [cue => { cue.roomId = '22222222-2222-4222-a222-222222222222'; },
    cue => { cue.video.binding.controlVersion++; }, cue => { cue.music.qc.passed = false; },
    cue => { cue.video.timeline.segments[1].startSeconds = 6; }, cue => { cue.playbackRevision = null; }]) {
    op.cue = structuredClone(verified); mutate(op.cue);
    const malformed = await jobs.read(x.input); assert.equal(malformed.state, 'HOLD');
    assert.equal(malformed.cueReady, false); assert.equal(malformed.actualPlayback, false);
    assert.equal(malformed.playerAcknowledged, false); assert.equal(malformed.reservationAcknowledged, false);
  }
  op.cue = {...verified, status: 'READY', video: {asset: verified.video.asset}};
  assert.equal((await jobs.read(x.input)).state, 'HOLD'); assert.equal((await jobs.read(x.input)).cueReady, false);
});
test('same-origin owner jobs interface rejects keys and client QC/model/URL/price controls', async () => {
  let calls = 0; const handler = createCloudJobHandler({jobs: {read: async () => { calls++; return {state: 'WAIT_QC'}; }}});
  const url = 'https://ai-vdj.vercel.app/api/rooms/' + roomId + '/jobs/read';
  const req = (body, extra = {}) => handler(new Request(url, {method: 'POST', headers: {Origin: 'https://ai-vdj.vercel.app',
    'X-Room-Owner': owner, 'Content-Type': 'application/json', ...extra}, body: JSON.stringify(body)}));
  for (const body of [{operationId, qcPassed: true}, {operationId, model: 'x'}, {operationId, url: 'https://example.invalid'}, {operationId, maximumUsd: 1}])
    assert.equal((await req(body)).status, 400);
  assert.equal((await req({operationId}, {'X-Fal-Key': key})).status, 403);
  assert.equal((await req({operationId}, {Origin: 'https://evil.invalid'})).status, 403);
  assert.equal((await req({operationId})).status, 200); assert.equal(calls, 1);
});
test('private media interface authenticates owner, bounds/checks bytes, never redirects or returns URLs', async () => {
  const bytes = new TextEncoder().encode('synthetic PCM bytes');
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
  let reads = 0; const handler = createCloudMediaHandler({authorizeOwner: async input => input.ownerCapability === owner,
    readMedia: async input => { reads++; return {bytes, assetId: input.assetId, sha256, privateSaved: true, checksumVerified: true, contentType: 'audio/wav'}; }});
  const url = 'https://ai-vdj.vercel.app/api/rooms/' + roomId + '/media/synthetic-audio?sha256=' + sha256;
  const req = capability => handler(new Request(url, {headers: {Origin: 'https://ai-vdj.vercel.app', 'X-Room-Owner': capability}}));
  assert.equal((await req('b'.repeat(64))).status, 403); assert.equal(reads, 0);
  const result = await req(owner); assert.equal(result.status, 200); assert.equal(result.headers.get('location'), null);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes); assert.equal(result.headers.get('cache-control'), 'no-store');
  const mismatch = await handler(new Request(url.replace(sha256, '0'.repeat(64)), {headers: {Origin: 'https://ai-vdj.vercel.app', 'X-Room-Owner': owner}}));
  assert.equal(mismatch.status, 409);
  const rewritten = url.replace('https://ai-vdj.vercel.app', 'https://media.example.invalid');
  assert.equal((await handler(new Request(rewritten, {headers: {'Sec-Fetch-Site': 'same-origin', 'X-Room-Owner': owner}}))).status, 200);
  for (const value of ['cross-site', 'same-site', 'none'])
    assert.equal((await handler(new Request(url, {headers: {'Sec-Fetch-Site': value, 'X-Room-Owner': owner}}))).status, 403);
  assert.equal((await handler(new Request(url, {headers: {'X-Room-Owner': owner}}))).status, 403);
  for (const from of ['null', 'https://evil.invalid'])
    assert.equal((await handler(new Request(url, {headers: {Origin: from, 'Sec-Fetch-Site': 'same-origin', 'X-Room-Owner': owner}}))).status, 403);
});
test('manifest endpoint is gated by default and derives bound media only from current server reservation', async () => {
  const sha = '1'.repeat(64), incomingSha = '2'.repeat(64), videoSha = '3'.repeat(64);
  const binding = {roomId, cueId: 'synthetic-cue', generationId: 'synthetic-generation', submissionId,
    controlVersion: 2, commonIntentSha256: '4'.repeat(64)};
  const music = {assetId: 'synthetic-incoming', sha256: incomingSha}, videos = [{assetId: 'synthetic-video', sha256: videoSha}];
  const plan = {transition: {renderedSha256: sha, exitFrame: 100, entryFrame: 0}};
  const reservation = {roomId, reservationId: 'synthetic-reservation', cue: {...binding, music: {asset: music}, video: {clips: videos}}, plan};
  const manifest = {...binding, audio: {...music, render: {assetId: 'synthetic-render', sha256: sha, byteLength: (100 + 24 * 44100) * 8,
    mimeType: 'application/vnd.ai-vdj.pcm-f32le', renderedFileSha256: sha, renderedPcmSha256: '5'.repeat(64), sampleRate: 44100,
    startFrame: 100, durationFrames: 100 + 24 * 44100, expectedPlayedWindowSha256: '6'.repeat(64)}},
    videos: [{...videos[0], byteLength: 100, mimeType: 'video/mp4', source: 'fal', requestId: 'synthetic-request'}]};
  let calls = 0, valid = true;
  const options = {enabled: true, authorizeOwner: async input => input.ownerCapability === owner,
    checkReservation: async () => ({valid, reservation: structuredClone(reservation)}),
    describeManifest: async input => { calls++; assert.deepEqual(input.reservation, reservation); return structuredClone(manifest); }};
  const url = 'https://ai-vdj.vercel.app/api/rooms/' + roomId + '/cloud/media/resolve';
  const payload = {...binding, music, videos, plan};
  const request = (handler, body = payload, capability = owner) => handler(new Request(url, {method: 'POST',
    headers: {Origin: 'https://ai-vdj.vercel.app', 'X-Room-Owner': capability, 'Content-Type': 'application/json'}, body: JSON.stringify(body)}));
  assert.equal((await request(createCloudMediaManifestHandler())).status, 503);
  const handler = createCloudMediaManifestHandler(options);
  assert.equal((await request(handler, payload, 'b'.repeat(64))).status, 403); assert.equal(calls, 0);
  assert.equal((await request(handler, {...payload, qcPassed: true})).status, 400);
  assert.equal((await request(handler, {...payload, plan: {transition: {...plan.transition, exitFrame: 101}}})).status, 409); assert.equal(calls, 0);
  const result = await request(handler); assert.equal(result.status, 200); assert.deepEqual(await result.json(), manifest);
  valid = false; assert.equal((await request(handler)).status, 409); assert.equal(calls, 1);
  valid = true;
  const stopDuringDescribe = createCloudMediaManifestHandler({...options, describeManifest: async () => { valid = false; return manifest; }});
  assert.equal((await request(stopDuringDescribe)).status, 409);
  valid = true;
  const unsignedUrl = createCloudMediaManifestHandler({...options, describeManifest: async () => ({...manifest, url: 'https://example.invalid/media'})});
  assert.equal((await request(unsignedUrl)).status, 409);
  const localManifest = structuredClone(manifest); localManifest.audio.render.timelineSpace = 'clip-relative-v1';
  const localOptions = {...options, describeManifest: async () => localManifest};
  assert.equal((await request(createCloudMediaManifestHandler(localOptions))).status, 409);
  assert.equal((await request(createCloudMediaManifestHandler({...localOptions, enableClipRelativeTimeline: true}))).status, 200);
  assert.equal((await request(handler, {...payload, enableClipRelativeTimeline: true})).status, 400);
  localManifest.audio.render.timelineSpace = 'caller-offset';
  assert.equal((await request(createCloudMediaManifestHandler({...localOptions, enableClipRelativeTimeline: true}))).status, 409);
  const ownerVideo={...manifest.videos[0],source:'owner-supplied-bootstrap-video',admissionId:'owner-admission',
    admissionEvidenceSha256:'7'.repeat(64)};delete ownerVideo.requestId;
  const ownerManifest={...manifest,videos:[ownerVideo]};
  const ownerOptions={...options,describeManifest:async()=>ownerManifest};
  const admitted=await request(createCloudMediaManifestHandler(ownerOptions));assert.equal(admitted.status,200);
  assert.equal((await admitted.json()).videos[0].requestId,undefined);
  for(const mutate of [v=>delete v.admissionId,v=>v.admissionEvidenceSha256='bad',v=>v.requestId='fabricated-provider',v=>v.source='fal']){
    const changed=structuredClone(ownerManifest);mutate(changed.videos[0]);
    assert.equal((await request(createCloudMediaManifestHandler({...options,describeManifest:async()=>changed}))).status,409);
  }
});


test('explicit initial intent delivery submits only once and never advances an existing submitted operation', async () => {
  const x = fixture(); await x.jobs.start(x.start());
  const initial = await x.jobs.submitInitialIntent(x.input);
  assert.equal(initial.stages.intent.state, 'SUBMITTED'); assert.equal(x.posts.length, 1); assert.equal(x.polls.length, 0);
  await x.jobs.submitInitialIntent(x.input);
  assert.equal(x.posts.length, 1); assert.equal(x.polls.length, 0);
  await x.jobs.advance(x.input); const before = {posts:x.posts.length,polls:x.polls.length};
  await x.jobs.submitInitialIntent(x.input);
  assert.deepEqual({posts:x.posts.length,polls:x.polls.length}, before);
});
