import {DispatchError, generationIdentity} from '../generation/dispatch.mjs';
import {cueDigest, cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';
import {operationBinding} from '../generation/cue-contract.mjs';
import {TECHNICAL_VISUAL_POLICY, assessTechnicalVisual} from '../../integration/qc/visual-policy.mjs';

const fail = code => { throw new DispatchError(code); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const nonce = value => id(value) && value.length >= 20;
const roomId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
// sessionId is the opaque room epoch, never an authentication session.
const roomScope = ({roomId, sessionId, controlRevision}) => ({roomId, sessionId, controlRevision});
// Limits count Unicode code points like the room API, never splitting a pair.
export const projectedText = (value, length) =>
  text(value, length);
const text = (value, length) => typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, length).join('') : '';
const stageStates = new Set(['RESERVED', 'SUBMITTED', 'COMPLETE', 'UNKNOWN', 'HOLD', 'FAILED']);
const close = (value, expected) => Number.isFinite(value) && Math.abs(value - expected) <= 1 / 44100;

// Validate the persisted projection emitted by buildVerifiedCue. Raw stage
// COMPLETE is never media QC. The trusted repository stores private asset/QC
// evidence hashes, channel bindings and the approved complete visual timeline.
function fullyVerifiedCue(op, bound) {
  const cue = op.cue;
  if (op.plan?.status !== 'COMPILED' || !hash(cue?.evidenceSha256) || !['READY', 'SELECTED', 'PLAYING', 'PLAYED'].includes(cue.status) ||
      !['music', 'video'].every(channel => op.stages?.[channel]?.state === 'COMPLETE')) return false;
  for (const channel of ['music', 'video']) {
    const media = cue[channel];
    if (media?.status !== 'QC_READY' || media.actualGenerationThisRun !== true || media.qc?.passed !== true ||
        !hash(media.qc.evidenceSha256) || !id(media.asset?.assetId) || !hash(media.asset.sha256) ||
        !close(media.durationSeconds, 24) || cueDigest(media.binding ?? null) !== cueDigest(operationBinding(bound.roomId, op, channel))) return false;
  }
  const music = cue.music, video = cue.video, profile = music.profile, timeline = video.timeline;
  if (music.parentClipId !== op.permit.source.music.clipId || music.contextSha256 !== op.permit.source.music.contextSha256 ||
      music.contextVerified !== true || music.continuationVerified !== true || profile?.method !== 'pcm-endpoint-profile-v1' ||
      profile.assetSha256 !== music.asset.sha256 || profile.sampleRate !== 44100 || profile.channels !== 2 || profile.frameCount !== 24 * 44100) return false;
  const technicalApproval = video.review?.kind === 'technical-qc' &&
    cueDigest(op.permit.visualPolicy ?? null) === cueDigest(TECHNICAL_VISUAL_POLICY) &&
    video.review.policySha256 === cueDigest(TECHNICAL_VISUAL_POLICY) &&
    video.compositionQC?.visualPolicySha256 === video.review.policySha256 && Array.isArray(video.compositionQC.clips) &&
    video.compositionQC.clips.length > 0 && video.compositionQC.clips.every(clip => assessTechnicalVisual(clip.measurement).passed);
  if (video.compositionQC?.passed !== true || video.review?.accepted !== true ||
      !(video.review.ownerArtisticApproval === true || technicalApproval) || video.review.assetSha256 !== video.asset.sha256 ||
      video.review.commonIntentSha256 !== cue.commonIntentSha256 || !close(timeline?.durationSeconds, 24) || timeline.timeStretch !== false ||
      !Array.isArray(timeline.segments) || timeline.segments.length < 1 || timeline.segments.length > 128 ||
      !Array.isArray(video.clips) || video.clips.length < 1 || video.clips.length > 32) return false;
  const clips = new Map();
  for (const clip of video.clips) {
    if (!id(clip.assetId) || !hash(clip.sha256) || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0 || clips.has(clip.assetId)) return false;
    clips.set(clip.assetId, clip);
  }
  let end = 0; const seen = new Set();
  for (const segment of timeline.segments) {
    const clip = clips.get(segment.assetId);
    if (!clip || segment.sha256 !== clip.sha256 || !close(segment.startSeconds, end) || !Number.isFinite(segment.endSeconds) ||
        segment.endSeconds <= segment.startSeconds || !Number.isFinite(segment.sourceInSeconds) || segment.sourceInSeconds < 0 ||
        !Number.isFinite(segment.sourceOutSeconds) || segment.sourceOutSeconds > clip.durationSeconds + 1 / 44100 ||
        !close(segment.endSeconds - segment.startSeconds, segment.sourceOutSeconds - segment.sourceInSeconds) ||
        segment.playbackRate !== 1 || seen.has(segment.assetId) && timeline.approvedLoops !== true) return false;
    end = segment.endSeconds; seen.add(segment.assetId);
  }
  return close(end, 24);
}

// Server-side reuse for private current-source ports. This validates only an
// authoritative persisted cue; it is not a callable browser QC grant.
export function hasVerifiedPersistedCloudCue({roomId, operation} = {}) {
  const cue = operation?.cue;
  try {
    return !!cue && cue.roomId === roomId && cue.operationId === operation.operationId &&
      cue.submissionId === operation.submissionId && cue.generationId === generationIdentity(operation.operationId).generationId &&
      cue.commonIntentSha256 === operation.plan?.commonIntentSha256 && cue.controlVersion === operation.plan?.common?.control?.version &&
      cue.cueId === operation.plan?.common?.cueId && cue.sourceSha256 === operation.permit?.sourceSha256 &&
      cue.atomicReady === true && cue.mode === 'provider' && cue.actualGenerationThisRun === true &&
      fullyVerifiedCue(operation, {roomId});
  } catch { return false; }
}

// A view over existing persisted room/generation/cue records. Attachment lookup
// is server-only and uses visible submission IDs, never browser operation IDs.
// No in-memory attachment registry or new database mutation is introduced.
export function createCloudRoomProjection({roomRepository, authorizeOwner, readAttachments,
  readOperation, readPlaybackState, now = Date.now} = {}) {
  if (!roomRepository?.request || typeof readAttachments !== 'function' || typeof readOperation !== 'function')
    fail('ROOM_JOB_PROJECTION_PORTS_REQUIRED');
  function actor(input) {
    if (!input || !roomId(input.roomId) || !!input.ownerCapability === !!input.participantCapability)
      fail('ROOM_ACTOR_REQUIRED');
    const capability = input.ownerCapability ?? input.participantCapability;
    if (!hash(capability)) fail('ROOM_ACTOR_REQUIRED');
    return {owner: !!input.ownerCapability, capability};
  }
  async function visible(input, submissionId) {
    const who = actor(input);
    if (who.owner && (typeof authorizeOwner !== 'function' ||
        await authorizeOwner({roomId: input.roomId, ownerCapability: who.capability}) !== true)) fail('OWNER_DENIED');
    const state = await roomRepository.request('read', input.roomId, who.capability, {});
    if (state?.roomId !== input.roomId || !id(state.sessionId) || !integer(state.controlRevision) || state.closed)
      fail('ROOM_JOB_SCOPE_CHANGED');
    if (!Array.isArray(state.submissions) || state.submissions.length > 100) fail('ROOM_JOB_VIEW_REQUIRED');
    const submissions = state.submissions.filter(item => item.roomId === state.roomId && Object.is(item.sessionId, state.sessionId) && id(item.submissionId));
    if (submissionId !== undefined) {
      if (!id(submissionId)) fail('SUBMISSION_REQUIRED');
      // Existing room proof RPC validates participant ownership independently
      // from the filtered snapshot before any privileged ledger lookup.
      const item = await roomRepository.request('submission', input.roomId, who.capability, {submissionId});
      if (!submissions.some(visible => visible.submissionId === item?.submissionId) || item.submissionId !== submissionId)
        fail('SUBMISSION_REQUIRED');
      return {who, state, submissions: submissions.filter(item => item.submissionId === submissionId)};
    }
    return {who, state, submissions};
  }
  function attachment(record, state, submission) {
    if (!record || record.roomId !== state.roomId || record.sessionId !== state.sessionId ||
        record.controlRevision !== state.controlRevision || record.submissionId !== submission.submissionId ||
        !nonce(record.operationId) || !nonce(record.permitId) || !hash(record.sourceSha256)) return null;
    const value = {...roomScope(state),
      submissionId: submission.submissionId, operationId: record.operationId, permitId: record.permitId, sourceSha256: record.sourceSha256};
    return {...value, attachmentSha256: cueDigest(value)};
  }
  async function activeAttachment(records,state,item){
    const matches=records.filter(record=>record.submissionId===item.submissionId);
    if(matches.length<=1)return matches.length?attachment(matches[0],state,item):null;
    // An explicitly superseded UNKNOWN keeps its immutable audit row. Only
    // exactly one currently authorized operation may represent this post.
    const live=[];
    for(const record of matches){
      const bound=attachment(record,state,item);if(!bound)continue;
      const saved=await readOperation({roomId:state.roomId,operationId:bound.operationId,permitId:bound.permitId});
      if(operationValid(saved,bound))live.push(bound);
    }
    return live.length===1?live[0]:null;
  }
  function operationValid(saved, bound) {
    const op = saved?.operation;
    // Permit expiry/dispatch only bound unfinished generation. A published,
    // QC-sealed Cue stays visible (playback already outlives the permit);
    // revocation and Stop still hide it.
    const published = hash(op?.cue?.evidenceSha256) && ['READY', 'SELECTED', 'PLAYING', 'PLAYED'].includes(op?.cue?.status);
    return saved?.roomId === bound.roomId && Object.is(saved.sessionId, bound.sessionId) &&
      saved.controlRevision === bound.controlRevision && saved.permitId === bound.permitId &&
      saved.revoked === false && (published || Number.isFinite(saved.expiresAtMs) && saved.expiresAtMs > now()) &&
      op?.operationId === bound.operationId && op.submissionId === bound.submissionId &&
      op.permit?.permitId === bound.permitId && op.permit.sourceSha256 === bound.sourceSha256 &&
      (published || op.dispatchAllowed === true) && !op.stopped &&
      cueDigest(cueSourceIdentity(op.permit.source)) === bound.sourceSha256;
  }
  function cueValid(op, bound) {
    const cue = op.cue;
    return cue?.roomId === bound.roomId && cue.operationId === bound.operationId && cue.submissionId === bound.submissionId &&
      cue.generationId === generationIdentity(bound.operationId).generationId && cue.sourceSha256 === bound.sourceSha256 &&
      cue.commonIntentSha256 === op.plan?.commonIntentSha256 && cue.controlVersion === op.plan?.common?.control?.version &&
      cue.cueId === op.plan?.common?.cueId && cue.atomicReady === true && cue.mode === 'provider' && cue.actualGenerationThisRun === true;
  }
  function credited(playback, cue, submission) {
    const credit = playback?.currentCredit;
    return playback?.stopped === false && playback.roomId === cue.roomId && credit?.actual === true && credit.actualPlayback === true &&
      credit.roomId === cue.roomId && credit.cueId === cue.cueId && credit.generationId === cue.generationId &&
      credit.submissionId === submission.submissionId && credit.participantId === submission.participantId &&
      integer(credit.playbackRevision) && credit.playbackRevision === cue.playbackRevision && cue.status === 'PLAYING';
  }
  function progress(saved, bound, submission, playback) {
    const op = saved?.operation, stages = Object.fromEntries(['intent', 'music', 'video'].filter(stage => op?.stages?.[stage]).map(stage =>
      [stage, {state: stageStates.has(op.stages[stage].state) ? op.stages[stage].state : 'HOLD'}]));
    const base = {operationId: bound.operationId, generationId: generationIdentity(bound.operationId).generationId,
      submissionId: bound.submissionId, stages, state: 'HOLD', actualPlayback: false, playerAcknowledged: false, credit: null,
      cueId: id(op?.plan?.common?.cueId) ? op.plan.common.cueId : null,
      commonIntentSha256: hash(op?.plan?.commonIntentSha256) ? op.plan.commonIntentSha256 : null,
      controlVersion: integer(op?.plan?.common?.control?.version) ? op.plan.common.control.version : null,
      atomicReady: false, actualGenerationThisRun: false, channels: {},
      cueStatus: ['READY', 'SELECTED', 'PLAYING', 'PLAYED', 'HOLD'].includes(op?.cue?.status) ? op.cue.status : null,
      playbackRevision: integer(op?.cue?.playbackRevision) ? op.cue.playbackRevision : null};
    let valid = false;
    try { valid = operationValid(saved, bound); } catch { /* Malformed authoritative source is a hold. */ }
    if (!valid || Object.values(stages).some(stage => ['RESERVED', 'UNKNOWN', 'HOLD', 'FAILED'].includes(stage.state))) return base;
    if (op.plan?.status === 'NEEDS_CLARIFICATION') return {...base, state: 'CLARIFY', question: text(op.plan.question, 500)};
    if (cueValid(op, bound)) {
      let atomic = false;
      try { atomic = fullyVerifiedCue(op, bound); } catch { /* Invalid persisted QC projection cannot become an atomic summary. */ }
      const summary = atomic ? {atomicReady: true, actualGenerationThisRun: true,
        channels: Object.fromEntries(['music', 'video'].map(channel => [channel, {status: 'QC_READY', qcPassed: true,
          durationSeconds: 24, generationId: op.cue.generationId, controlVersion: op.cue.controlVersion,
          ...(channel === 'video' ? {compositionQcPassed: true} : {})}]))} : {};
      if (atomic && credited(playback, op.cue, submission)) {
        const credit = playback.currentCredit;
        return {...base, ...summary, state: 'PLAYING', actualPlayback: true, playerAcknowledged: true,
          credit: {roomId: bound.roomId, cueId: op.cue.cueId, generationId: op.cue.generationId, submissionId: bound.submissionId,
            participantId: submission.participantId, nickname: text(submission.nickname, 40), playbackRevision: credit.playbackRevision,
            actual: true, actualPlayback: true}};
      }
      if (op.cue.status === 'SELECTED' && playback?.pending === true && playback.stopped === false) return {...base, ...summary, state: 'RESERVED'};
      if (op.cue.status === 'READY') return {...base, ...summary, state: 'READY'};
      if (atomic && op.cue.status === 'PLAYED') return {...base, ...summary, state: 'PLAYED'};
      return base;
    }
    const complete = ['music', 'video'].filter(stage => stages[stage]?.state === 'COMPLETE').length;
    return {...base, state: complete === 2 ? 'WAIT_REVIEW' : complete === 1 ? 'PARTIAL_READY' : 'PENDING'};
  }
  function submissionView(item, job = null) {
    const {roomId, sessionId} = item;
    return {roomId, sessionId, submissionId: item.submissionId,
      participantId: item.participantId, nickname: text(item.nickname, 40), prompt: text(item.prompt, 2000),
      state: job?.state ?? 'QUEUED', reason: job?.state === 'HOLD' ? 'AUTHORITATIVE_JOB_HOLD' : job ? null : 'PROVIDER_NOT_CONNECTED',
      jobs: job ? [job] : [], mode: job ? 'cloud' : 'collect'};
  }
  async function project(input, submissionId) {
    const view = await visible(input, submissionId), {state, submissions, who} = view;
    const records = await readAttachments({...roomScope(state), submissionIds: submissions.map(item => item.submissionId)});
    if (!Array.isArray(records) || records.length > 100) fail('ROOM_JOB_ATTACHMENTS_REQUIRED');
    const playback = typeof readPlaybackState === 'function' ? await readPlaybackState({...roomScope(state)}) : null;
    const output = [];
    for (const item of submissions) {
      const matches = records.filter(record => record.submissionId === item.submissionId);
      const bound = await activeAttachment(records,state,item);
      if (!bound) { output.push(submissionView(item, matches.length ? {state: 'HOLD', stages: {}, actualPlayback: false, credit: null} : null)); continue; }
      const saved = await readOperation({roomId: state.roomId, operationId: bound.operationId, permitId: bound.permitId});
      const job = progress(saved, bound, item, playback);
      // A participant sees progress for their already proof-filtered submission,
      // never server permit/attachment IDs or another participant's credit.
      output.push(submissionView(item, job));
    }
    const latest = await roomRepository.request('read', input.roomId, who.capability, {});
    if (latest?.sessionId !== state.sessionId || latest.controlRevision !== state.controlRevision || latest.closed)
      fail('ROOM_JOB_SCOPE_CHANGED');
    // A source/control stop or player ACK can arrive while a long view is being
    // assembled. Re-read authoritative operation/credit facts before exposing
    // READY/RESERVED/PLAYING; notifications and old room snapshots are not facts.
    const latestPlayback = typeof readPlaybackState === 'function' ? await readPlaybackState({...roomScope(state)}) : null;
    for (let index = 0; index < output.length; index++) {
      const item = submissions[index], matches = records.filter(record => record.submissionId === item.submissionId);
      const bound = await activeAttachment(records,state,item);
      if (!bound) {if(matches.length)output[index]=submissionView(item,{state:'HOLD',stages:{},actualPlayback:false,credit:null});continue;}
      const saved = await readOperation({roomId: state.roomId, operationId: bound.operationId, permitId: bound.permitId});
      output[index] = submissionView(item, progress(saved, bound, item, latestPlayback));
    }
    const currentCredit = output.find(item => item.jobs[0]?.credit)?.jobs[0].credit ?? null;
    // Stop -> Start can replay a Cue at the same graph-local revision. The
    // served total grows with every accepted ACK and Stop flips stopped, so a
    // new run never repeats an earlier fingerprint the browser already saw.
    const servedTotal = Object.values(latestPlayback?.servedCounts ?? {}).reduce((sum, n) => sum + (Number.isSafeInteger(n) ? n : 0), 0);
    const jobStateSha256 = cueDigest({domain: 'room-job-state-v1', ...roomScope(state),
      playback: {servedTotal, stopped: latestPlayback?.stopped === true}, submissions: output.map(item => ({submissionId: item.submissionId, state: item.state,
        jobs: item.jobs.map(job => ({operationId: job.operationId ?? null, generationId: job.generationId ?? null,
          stages: job.stages ?? {}, cueId: job.cueId ?? null, cueStatus: job.cueStatus ?? null,
          commonIntentSha256: job.commonIntentSha256 ?? null, controlVersion: job.controlVersion ?? null,
          playbackRevision: job.playbackRevision ?? null, state: job.state, atomicReady: job.atomicReady === true,
          actualGenerationThisRun: job.actualGenerationThisRun === true, actualPlayback: job.actualPlayback === true,
          channels: job.channels ?? {}}))})), currentCredit: currentCredit ? {roomId: currentCredit.roomId,
        cueId: currentCredit.cueId, generationId: currentCredit.generationId, submissionId: currentCredit.submissionId,
        participantId: currentCredit.participantId, playbackRevision: currentCredit.playbackRevision, actual: true} : null});
    return {...roomScope(state), eventSeq: integer(state.eventSeq) ? state.eventSeq : 0,
      controlRevision: state.controlRevision, closed: false, accepting: state.accepting === true,
      generationPaused: state.generationPaused !== false, autoDJ: state.autoDJ === true, mode: output.some(item => item.jobs.length) ? 'cloud' : 'collect',
      submissions: output, cues: [], currentCredit, actualCredit: currentCredit?.actual === true, jobStateSha256};
  }
  async function prepare(input) {
    if (!input?.ownerCapability || Object.keys(input).some(key => !['roomId', 'ownerCapability', 'submissionId'].includes(key)))
      fail('SERVER_ATTACHMENT_IDS_ONLY');
    const {state, submissions} = await visible(input, input.submissionId), item = submissions[0];
    const records = await readAttachments({...roomScope(state),
      submissionIds: [item.submissionId]});
    if (!Array.isArray(records) || !records.length || records.length>100) fail('SERVER_ATTACHMENT_REQUIRED');
    const bound = await activeAttachment(records,state,item);
    if (!bound) fail('ROOM_JOB_SCOPE_CHANGED');
    const saved = await readOperation({roomId: state.roomId, operationId: bound.operationId, permitId: bound.permitId});
    if (!operationValid(saved, bound)) fail('ROOM_JOB_SCOPE_CHANGED');
    const latest = await roomRepository.request('read', input.roomId, input.ownerCapability, {});
    if (latest?.sessionId !== state.sessionId || latest.controlRevision !== state.controlRevision || latest.closed)
      fail('ROOM_JOB_SCOPE_CHANGED');
    if (!operationValid(await readOperation({roomId: state.roomId, operationId: bound.operationId, permitId: bound.permitId}), bound))
      fail('ROOM_JOB_SCOPE_CHANGED');
    const latestBound=await activeAttachment(records,state,item);
    if(!latestBound||latestBound.operationId!==bound.operationId)fail('ROOM_JOB_SCOPE_CHANGED');
    return bound;
  }
  return Object.freeze({prepare, readAttachment: prepare, readRoom: input => project(input),
    readSubmission: async input => (await project(input, input.submissionId)).submissions[0]});
}
