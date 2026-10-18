import {readSubmissionRecords} from './submission-records.mjs';
import {sha256} from './fal-provider.mjs';
import {DJ_DIRECTION} from './creative-direction.mjs';
import {submissionReference} from './reference-store.mjs';
const clock = "cast(unixepoch('subsec')*1000 as integer)";
const fail = code => { throw Error(code); };
export function createGenerationStore({db, eventId, policy = DJ_DIRECTION, normalized = false}) {
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
        and (select count(*) from vdj_budget_reservations where room_id=r.id)<${policy.maximumSets ?? 100}
        on conflict(event_id,plan_id) do nothing`, submissionId, eventId, roomId).run();
      if (!await query('select plan_id from vdj_budget_reservations where event_id=? and room_id=? and plan_id=?', eventId, roomId, submissionId).first()) fail('JUDGE_BUDGET');
      const job = {id: submissionId, roomId, prompt: submission.prompt, nickname: submission.nickname,
        submittedAtMs: submission.createdAtMs, submissionOrder: submission.submissionOrder,
        participantId: submission.participantId, state: 'QUEUED', duration: policy.audioSeconds, videoDuration: policy.videoSeconds, profile: policy.audioSeconds === 12 ? 'audience-12-v1' : 'legacy', sceneCount: policy.sceneCount, mediaProfile: policy.mediaProfile, createdAtMs: Date.now(), maximumCents: policy.maximumCents,
        ...(reference ? {reference, direction: {state: 'QUEUED'}} : {})};
      await query(`insert into vdj_runtime_records(room_id,kind,record_id,version,document) values(?,'cloud-generation',?,0,?)
        on conflict(room_id,kind,record_id) do nothing`, roomId, submissionId, JSON.stringify(job)).run();
      return (await records(roomId)).find(j => j.id === submissionId);
    },
    async save(job) {
      // Provider handles remain in private DO storage. Browser-visible D1 records
      // contain only safe progress, private R2 descriptors and the submitted text.
      const safe = Object.fromEntries(['id', 'roomId', 'participantId', 'profile', 'readyAtMs', 'submittedAtMs', 'submissionOrder', 'prompt', 'nickname', 'state', 'duration', 'videoDuration', 'sceneCount', 'mediaProfile', 'createdAtMs', 'maximumCents', 'reason', 'failures', 'assets', 'quality', 'providerReceipts', 'progress', 'timings', 'reference', 'direction'].filter(k => job[k] !== undefined).map(k => [k, job[k]]));
      await query("update vdj_runtime_records set document=?,version=version+1 where room_id=? and kind='cloud-generation' and record_id=?", JSON.stringify(safe), job.roomId, job.id).run();
    },
  };
}
