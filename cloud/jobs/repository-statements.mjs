// Shared fixed statements only; safe to import in Edge without native modules.
export const EXISTING_REPOSITORY_SELECTS = Object.freeze({
  runtime: `select document->'roomRuntime' as runtime from vdj_internal.generation_operations
      where room_id=$1 and document ? 'roomRuntime' order by id limit 2`,
  scope: `select r.id as "roomId",r.epoch as "sessionId",r.control_revision::float as "controlRevision",
      extract(epoch from r.expires_at)*1000 as "expiresAtMs",o.enabled as "ownerEnabled"
      from vdj_internal.rooms r join vdj_internal.owners o on o.uid=r.owner_uid where r.id=$1`,
  attachments: `select o.id as "operationId",p.id as "permitId",o.room_id as "roomId",p.room_epoch as "sessionId",
      p.control_revision::float as "controlRevision",o.document->>'submissionId' as "submissionId",
      p.document->>'sourceSha256' as "sourceSha256" from vdj_internal.generation_operations o
      join vdj_internal.generation_permits p on p.id=o.permit_id and p.room_id=o.room_id
      join vdj_internal.rooms r on r.id=o.room_id where o.room_id=$1 and o.document->>'submissionId'=any($2::text[])
      and exists(select 1 from jsonb_array_elements(r.submissions) s where s->>'submissionId'=o.document->>'submissionId')
      order by o.id limit 101`,
  operation: `select o.room_id as "roomId",p.room_epoch as "sessionId",p.id as "permitId",
      p.control_revision::float as "controlRevision",p.revoked,extract(epoch from p.expires_at)*1000 as "expiresAtMs",
      p.document as "permitDocument" from vdj_internal.generation_operations o
      join vdj_internal.generation_permits p on p.id=o.permit_id and p.room_id=o.room_id where o.id=$1 and o.room_id=$2`,
  permit: `select p.room_id as "roomId",p.room_epoch as "sessionId",p.id as "permitId",
      p.control_revision::float as "controlRevision",p.revoked,extract(epoch from p.expires_at)*1000 as "expiresAtMs",
      p.document as "permitDocument" from vdj_internal.generation_permits p where p.id=$1 and p.room_id=$2`,
});
export const RECOVERY_CANDIDATE_SELECT = `select o.room_id as "roomId",o.id as "operationId",p.id as "permitId",
  r.epoch as "sessionId",r.control_revision::float as "controlRevision"
  from vdj_internal.generation_operations o
  join vdj_internal.generation_permits p on p.id=o.permit_id and p.room_id=o.room_id
  join vdj_internal.rooms r on r.id=o.room_id
  join vdj_internal.owners owner on owner.uid=r.owner_uid
  left join lateral (
    select a.document->'roomRuntime' as runtime from vdj_internal.generation_operations a
    where a.room_id=r.id and a.document ? 'roomRuntime' limit 1
  ) anchor on true
  where o.room_id=$1::uuid and r.epoch=$2::uuid and r.control_revision=$3::bigint
  and owner.enabled=true and r.expires_at>to_timestamp($4::double precision/1000)
  and p.expires_at>to_timestamp($4::double precision/1000) and p.revoked=false
  and p.room_epoch=r.epoch and p.control_revision=r.control_revision
  and o.document->>'operationId'=o.id and o.document->'permit'->>'permitId'=p.id
  and o.document->'stopped'='false'::jsonb
  and not (o.document ? 'cue')
  and exists(select 1 from jsonb_array_elements(
    case when jsonb_typeof(r.submissions)='array' then r.submissions else '[]'::jsonb end
  ) submission where submission->>'submissionId'=o.document->>'submissionId')
  and jsonb_typeof(o.document->'stages')='object'
  and not exists(select 1 from jsonb_each(
    case when jsonb_typeof(o.document->'stages')='object' then o.document->'stages' else '{}'::jsonb end
  ) stage where stage.key not in ('intent','music','video')
    or jsonb_typeof(stage.value) is distinct from 'object'
    or coalesce(stage.value->>'state','') not in ('SUBMITTED','COMPLETE')
    or coalesce(stage.value->>'requestId','') !~ '^[A-Za-z0-9_-]{1,100}$'
    or coalesce(stage.value->>'signature','') !~ '^[a-f0-9]{64}$'
    or (stage.value->>'state'='COMPLETE' and jsonb_typeof(stage.value->'result') is distinct from 'object'))
  and (
    (o.document->'stages'='{}'::jsonb and not (o.document ? 'plan'))
    or (o.document->'stages'->'intent'->>'state'='SUBMITTED'
      and not (o.document->'stages' ? 'music') and not (o.document->'stages' ? 'video')
      and not (o.document ? 'plan'))
    or (o.document->'stages'->'intent'->>'state'='COMPLETE'
      and jsonb_typeof(o.document->'plan')='object' and o.document->'plan'->>'status'='COMPILED')
  )
  and (select count(*) from vdj_internal.generation_operations a
    where a.room_id=r.id and a.document ? 'roomRuntime')<=1
  and (anchor.runtime is null or (jsonb_typeof(anchor.runtime)='object' and anchor.runtime->'stopped'='false'::jsonb))
  and ($5::text is null or o.id collate "C">$5::text collate "C")
  order by o.id collate "C" limit $6::integer`;
export const PLAYER_OBSERVER_SQL = 'select vdj_internal.player_observer_state($1,$2,$3,$4,$5,$6,$7::jsonb) as value';
export const OPERATOR_STATE_SQL='select vdj_internal.owner_operator_state($1,$2,$3,$4,$5,$6,$7::jsonb) as value';
export const OPERATOR_PERMITS_SQL='select vdj_internal.owner_operator_permits($1,$2,$3,$4,$5,$6::jsonb) as value';
export const DURABLE_SCHEDULER_SQL='select vdj_internal.vdj_scheduler_request($1::text,$2::uuid,$3::text,$4::jsonb) as value';
