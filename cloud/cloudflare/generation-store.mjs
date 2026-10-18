import {readSubmissionRecords} from './submission-records.mjs';
import {sha256} from './fal-provider.mjs';
import {DJ_DIRECTION} from './creative-direction.mjs';
import {submissionReference} from './reference-store.mjs';
const clock = "cast(unixepoch('subsec')*1000 as integer)";
const fail = code => { throw Error(code); };
export function createGenerationStore({db, eventId, policy = DJ_DIRECTION, normalized = false, independentAudio = false}) {
  const query = (sql, ...values) => db.prepare(sql).bind(...values);
  async function active(roomId) {
    const row = await query(`select r.* from vdj_rooms r join vdj_events e on e.id=r.event_id
      where r.id=? and e.id=? and e.enabled=1 and e.expires_at_ms>${clock} and r.expires_at_ms>${clock}`, roomId, eventId).first();
    if (!row || JSON.parse(row.document).closed) fail('ROOM_NOT_FOUND');
    return row;
  }
  async function records(roomId) {
    const result = await query("select document from vdj_runtime_records where room_id=? and kind='cloud-generation' order by json_extract(document,'$.createdAtMs')", roomId).all();
    return result.results.map(row => JSON.parse(row.document));
  }
  return {
    active,
    async purgeRequested(roomId) {
      return await query(`select json_extract(document,'$.purged') as purged,
        json_extract(document,'$.providerPurge') as providerPurge from vdj_rooms
        where id=? and event_id=? and json_extract(document,'$.closed')=1
        and json_extract(document,'$.purgeGeneratedMedia')=1`, roomId, eventId).first();
    },
    async finishPurge(roomId, providerPurge) {
      await db.batch([...(normalized ? [query('delete from vdj_submissions where room_id=?',roomId),query('delete from vdj_operations where room_id=?',roomId)] : []),query(`update vdj_rooms set document=json_object('closed',json('true'),
        'purgeGeneratedMedia',json('true'),'purged',json('true'),'providerPurge',json(?)),
        owner_proof=?,join_proof=?,version=version+1 where id=? and event_id=?`,
      JSON.stringify(providerPurge), '0'.repeat(64), '0'.repeat(64), roomId, eventId),
      query('delete from vdj_runtime_records where room_id=?', roomId)]);
    },
    async authorize(roomId, capability, ownerOnly = false) {
      if (!/^[a-f0-9]{64}$/.test(capability ?? '')) fail('ACTOR_DENIED');
      const row = await active(roomId), proof = await sha256(capability);
      if (row.owner_proof !== proof && (ownerOnly || !JSON.parse(row.document).members?.some(m => m.proof === proof))) fail('ACTOR_DENIED');
      return row;
    },
    records,
    async enqueue(roomId, submissionId, {imageDirectionEnabled = false} = {}) {
      const row = await active(roomId), document = JSON.parse(row.document);
      if (normalized) document.submissions = await readSubmissionRecords(db, roomId, document);
      if (!document.submissions.some(s => s.submissionId === submissionId)) fail('SUBMISSION_NOT_FOUND');
      const prior = (await records(roomId)).find(j => j.id === submissionId);
      if (prior) return prior;
      const submission = document.submissions.find(s => s.submissionId === submissionId);
      const reference = await submissionReference(db, row, submission);
      if (reference && !imageDirectionEnabled) fail('IMAGE_DIRECTION_DISABLED');
      // Reserve before any provider POST. One immutable reservation per submitted
      // prompt; retries, browser reloads and DO eviction cannot buy it twice.
      await query(`insert into vdj_budget_reservations(event_id,room_id,plan_id,cents,created_at_ms)
        select e.id,r.id,?,${policy.maximumCents},${clock} from vdj_events e join vdj_rooms r on r.event_id=e.id
        where e.id=? and r.id=? and e.enabled=1 and e.expires_at_ms>${clock} and r.expires_at_ms>${clock}
        and coalesce((select sum(cents) from vdj_budget_reservations where event_id=e.id),0)+${policy.maximumCents}<=e.maximum_cents
        and coalesce((select sum(cents) from vdj_budget_reservations where room_id=r.id),0)+${policy.maximumCents}<=${policy.maximumCents * (policy.maximumSets ?? 100)}
        and (select count(*) from vdj_budget_reservations where room_id=r.id and plan_id not like 'soundtrack-batch:%')<${policy.maximumSets ?? 100}
        on conflict(event_id,plan_id) do nothing`, submissionId, eventId, roomId).run();
      if (!await query('select plan_id from vdj_budget_reservations where event_id=? and room_id=? and plan_id=?', eventId, roomId, submissionId).first()) fail('JUDGE_BUDGET');
      const job = {id: submissionId, roomId, prompt: submission.prompt, nickname: submission.nickname,
        submittedAtMs: submission.createdAtMs, submissionOrder: submission.submissionOrder,
        participantId: submission.participantId, state: 'QUEUED', duration: policy.audioSeconds, videoDuration: policy.videoSeconds, profile: independentAudio ? 'visual-12-v1' : policy.audioSeconds === 12 ? 'audience-12-v1' : 'legacy', sceneCount: policy.sceneCount, mediaProfile: policy.mediaProfile, createdAtMs: Date.now(), maximumCents: policy.maximumCents,
        ...(independentAudio ? {videoOnly:true} : {}),
        ...(reference ? {reference, direction: {state: 'QUEUED'}} : {})};
      await query(`insert into vdj_runtime_records(room_id,kind,record_id,version,document) values(?,'cloud-generation',?,0,?)
        on conflict(room_id,kind,record_id) do nothing`, roomId, submissionId, JSON.stringify(job)).run();
      return (await records(roomId)).find(j => j.id === submissionId);
    },
    async enqueueSoundtrack(roomId, sequence) {
      await active(roomId);
      if (!Number.isInteger(sequence) || sequence < 1 || sequence > 100) fail('SOUNDTRACK_LIMIT');
      // Five songs share one $0.50 reservation. Deterministic IDs recover a
      // partially persisted enqueue without buying the same song twice.
      const digest = await sha256(`soundtrack-v1:${roomId}:${sequence}`);
      const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
      const prior = (await records(roomId)).find(j => j.id === id);
      if (prior) return prior;
      const planId = `soundtrack-batch:${roomId}:${Math.floor((sequence-1)/5)}`;
      await query(`insert into vdj_budget_reservations(event_id,room_id,plan_id,cents,created_at_ms)
        select e.id,r.id,?,50,${clock} from vdj_events e join vdj_rooms r on r.event_id=e.id
        where e.id=? and r.id=? and e.enabled=1 and e.expires_at_ms>${clock} and r.expires_at_ms>${clock}
        and coalesce((select sum(cents) from vdj_budget_reservations where event_id=e.id),0)+50<=e.maximum_cents
        on conflict(event_id,plan_id) do nothing`, planId, eventId, roomId).run();
      if (!await query('select plan_id from vdj_budget_reservations where event_id=? and room_id=? and plan_id=?',eventId,roomId,planId).first()) fail('JUDGE_BUDGET');
      const motifs=['rolling acid bass and a bold two-bar hook','warm resonant plucks and deep elastic bass','crisp percussion and evolving psychedelic FM leads','wide euphoric harmonies over a relentless kick'];
      const job={id,roomId,sequence,profile:'soundtrack-60-v1',audioOnly:true,state:'QUEUED',duration:60,videoDuration:12,sceneCount:0,
        mediaProfile:'club-flow-v1',prompt:motifs[(sequence-1)%motifs.length],createdAtMs:Date.now(),maximumCents:10};
      await query("insert into vdj_runtime_records values(?,'cloud-generation',?,0,?) on conflict(room_id,kind,record_id) do nothing",roomId,id,JSON.stringify(job)).run();
      return (await records(roomId)).find(j=>j.id===id);
    },
    async save(job) {
      // Provider handles remain in private DO storage. Browser-visible D1 records
      // contain only safe progress, private R2 descriptors and the submitted text.
      const safe = Object.fromEntries(['id', 'roomId', 'participantId', 'profile', 'audioOnly', 'videoOnly', 'sequence', 'readyAtMs', 'submittedAtMs', 'submissionOrder', 'prompt', 'nickname', 'state', 'duration', 'videoDuration', 'sceneCount', 'mediaProfile', 'createdAtMs', 'maximumCents', 'reason', 'failures', 'assets', 'quality', 'providerReceipts', 'progress', 'timings', 'reference', 'direction'].filter(k => job[k] !== undefined).map(k => [k, job[k]]));
      await query("update vdj_runtime_records set document=?,version=version+1 where room_id=? and kind='cloud-generation' and record_id=?", JSON.stringify(safe), job.roomId, job.id).run();
    },
  };
}
