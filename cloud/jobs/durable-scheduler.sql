-- Prepared private scheduler contract, NOT APPLIED. No new role or grant.
-- Uses the existing operation row as its durable due/backoff/fence ledger.
-- Execute permission for the existing privileged host must be reviewed at apply.
-- PostgreSQL SKIP LOCKED is for queue consumers, not an execution authority:
-- https://www.postgresql.org/docs/current/sql-select.html
create or replace function vdj_internal.vdj_scheduler_eligible(operation_id text, requested_room uuid)
returns boolean language sql volatile security invoker set search_path='' as $$
select exists(select 1 from vdj_internal.generation_operations o
 join vdj_internal.generation_permits p on p.id=o.permit_id and p.room_id=o.room_id
 join vdj_internal.rooms r on r.id=o.room_id
 join vdj_internal.owners own on own.uid=r.owner_uid
 where o.id=operation_id and o.room_id=requested_room and own.enabled
 and r.expires_at>clock_timestamp() and p.expires_at>clock_timestamp() and not p.revoked
 and p.room_epoch=r.epoch and p.control_revision=r.control_revision
 and o.document->>'operationId'=o.id and o.document->'permit'->>'permitId'=p.id
 and o.document->'stopped'='false'::jsonb and not(o.document ? 'cue')
 and exists(select 1 from jsonb_array_elements(r.submissions) s
   where s->>'submissionId'=o.document->>'submissionId')
 and jsonb_typeof(o.document->'stages')='object' and o.document->'stages'<>'{}'::jsonb
 and not exists(select 1 from jsonb_each(o.document->'stages') s
   where s.key not in ('intent','music','video') or jsonb_typeof(s.value) is distinct from 'object'
   or coalesce(s.value->>'state','') not in ('SUBMITTED','COMPLETE')
   or coalesce(s.value->>'requestId','') !~ '^[A-Za-z0-9_-]{1,100}$'
   or coalesce(s.value->>'signature','') !~ '^[a-f0-9]{64}$'
   or (s.value->>'state'='COMPLETE' and jsonb_typeof(s.value->'result') is distinct from 'object'))
 and ((o.document->'stages'->'intent'->>'state'='SUBMITTED'
   and not(o.document->'stages' ? 'music') and not(o.document->'stages' ? 'video') and not(o.document ? 'plan'))
   or (o.document->'stages'->'intent'->>'state'='COMPLETE' and o.document->'plan'->>'status'='COMPILED'))
 and (select count(*) from vdj_internal.generation_operations a
   where a.room_id=r.id and a.document ? 'roomRuntime')<=1
 and not exists(select 1 from vdj_internal.generation_operations a where a.room_id=r.id
   and a.document ? 'roomRuntime' and a.document->'roomRuntime'->'stopped' is distinct from 'false'::jsonb))
$$;
revoke all on function vdj_internal.vdj_scheduler_eligible(text,uuid) from public,anon,authenticated;

create or replace function vdj_internal.vdj_scheduler_request(action text, requested_room uuid,
 capability text, payload jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 r vdj_internal.rooms; o vdj_internal.generation_operations; p vdj_internal.generation_permits;
 ledger jsonb; requested_worker text; requested_fence bigint; duration_ms integer;
 current_ms numeric; until_ms numeric; next_ms numeric;
 attempt integer; fence bigint;
begin
 if action not in ('enqueue','claim','assert','renew','finish') or jsonb_typeof(payload) is distinct from 'object'
 then raise exception 'SCHEDULER_INPUT_REQUIRED'; end if;
 select * into r from vdj_internal.rooms where id=requested_room for update;
 current_ms:=floor(extract(epoch from clock_timestamp())*1000);
 if not found or r.expires_at<=clock_timestamp() then raise exception 'SCHEDULER_SCOPE_HOLD'; end if;
 if capability is null or vdj_internal.proof(capability)<>r.owner_proof or not exists(
  select 1 from vdj_internal.owners where uid=r.owner_uid and enabled)
 then raise exception 'SCHEDULER_OWNER_HOLD'; end if;
 if payload->>'sessionId' is distinct from r.epoch::text or
  payload->>'controlRevision' is distinct from r.control_revision::text
 then raise exception 'SCHEDULER_SCOPE_HOLD'; end if;
 if action in ('claim','renew') then
  duration_ms:=(payload->>'leaseMs')::integer;
  if duration_ms<1000 or duration_ms>30000 then raise exception 'SCHEDULER_LEASE_HOLD'; end if;
 end if;
 if action<>'enqueue' then
  requested_worker:=payload->>'workerId';
  if requested_worker is null or requested_worker !~ '^[A-Za-z0-9_-]{20,100}$'
  then raise exception 'SCHEDULER_INPUT_REQUIRED'; end if;
 end if;
 if action='claim' then
  -- The room lock serializes control/Stop and caps this room at one live holder.
  if exists(select 1 from vdj_internal.generation_operations a where a.room_id=r.id
    and coalesce((a.document->'scheduler'->>'leaseUntilMs')::numeric,0)>current_ms)
  then return null; end if;
  select * into o from vdj_internal.generation_operations a where a.room_id=r.id
   and vdj_internal.vdj_scheduler_eligible(a.id,r.id)
   and coalesce(a.document->'scheduler'->>'terminal','false')='false'
   and coalesce((a.document->'scheduler'->>'dueAtMs')::numeric,0)<=current_ms
   and coalesce((a.document->'scheduler'->>'attempt')::integer,0)<64
   order by coalesce((a.document->'scheduler'->>'dueAtMs')::numeric,0),a.id collate "C"
   for update skip locked limit 1;
  if not found then return null; end if;
 else
  select * into o from vdj_internal.generation_operations where id=payload->>'operationId'
   and room_id=r.id for update;
  if not found then raise exception 'SCHEDULER_OPERATION_HOLD'; end if;
 end if;
 select * into p from vdj_internal.generation_permits where id=o.permit_id;
 ledger:=coalesce(o.document->'scheduler','{}'::jsonb);
 if action='enqueue' then
  if not vdj_internal.vdj_scheduler_eligible(o.id,r.id) then raise exception 'SCHEDULER_OPERATION_HOLD'; end if;
  -- Repeated hints cannot clear an active lease, reset attempts, or expedite backoff.
  if ledger='{}'::jsonb then
   ledger:=jsonb_build_object('dueAtMs',current_ms,'attempt',0,'fence',0,'terminal',false,'leaseUntilMs',0);
   update vdj_internal.generation_operations set document=jsonb_set(document,'{scheduler}',ledger,true) where id=o.id;
  end if;
  return jsonb_build_object('scheduled',true,'operationId',o.id);
 end if;
 if action='claim' then
  attempt:=coalesce((ledger->>'attempt')::integer,0)+1;
  fence:=coalesce((ledger->>'fence')::bigint,0)+1;
  until_ms:=least(current_ms+duration_ms,floor(extract(epoch from least(r.expires_at,p.expires_at))*1000));
  if until_ms<=current_ms then raise exception 'SCHEDULER_LEASE_HOLD'; end if;
  ledger:=jsonb_build_object('sessionId',r.epoch,'controlRevision',r.control_revision,'workerId',requested_worker,
   'fence',fence,'attempt',attempt,'leaseUntilMs',until_ms,'dueAtMs',current_ms,'terminal',false);
 else
  requested_fence:=(payload->>'fence')::bigint;
  if ledger->>'workerId' is distinct from requested_worker or (ledger->>'fence')::bigint is distinct from requested_fence
   or ledger->>'sessionId' is distinct from r.epoch::text
   or ledger->>'controlRevision' is distinct from r.control_revision::text
   or coalesce((ledger->>'leaseUntilMs')::numeric,0)<=current_ms
  then raise exception 'SCHEDULER_FENCE_HOLD'; end if;
  if o.document->'stopped' is distinct from 'false'::jsonb or exists(
   select 1 from vdj_internal.generation_operations a where a.room_id=r.id
   and a.document ? 'roomRuntime' and a.document->'roomRuntime'->'stopped' is distinct from 'false'::jsonb)
  then raise exception 'SCHEDULER_OPERATION_HOLD'; end if;
  if p.revoked or p.expires_at<=clock_timestamp() or p.room_epoch<>r.epoch or p.control_revision<>r.control_revision
  then raise exception 'SCHEDULER_OPERATION_HOLD'; end if;
  if action='renew' then
   until_ms:=least(current_ms+duration_ms,floor(extract(epoch from least(r.expires_at,p.expires_at))*1000));
   ledger:=jsonb_set(ledger,'{leaseUntilMs}',to_jsonb(until_ms),true);
  end if;
  if action='finish' then
   if payload->>'outcome' not in ('retry','complete','hold') then raise exception 'SCHEDULER_INPUT_REQUIRED'; end if;
   attempt:=(ledger->>'attempt')::integer;
   next_ms:=current_ms+least(30000,500*power(2,least(attempt-1,6)));
   ledger:=ledger||jsonb_build_object('leaseUntilMs',0,'dueAtMs',next_ms,
    'terminal',payload->>'outcome'<>'retry' or attempt>=64 or not vdj_internal.vdj_scheduler_eligible(o.id,r.id));
  end if;
 end if;
 if action<>'assert' then
  update vdj_internal.generation_operations set document=jsonb_set(document,'{scheduler}',ledger,true) where id=o.id;
 end if;
 return jsonb_build_object('roomId',r.id,'sessionId',r.epoch,'controlRevision',r.control_revision,
  'operationId',o.id,'permitId',p.id,'workerId',ledger->>'workerId','fence',(ledger->>'fence')::bigint,
  'attempt',(ledger->>'attempt')::integer,'leaseUntilMs',(ledger->>'leaseUntilMs')::numeric);
end $$;
revoke all on function vdj_internal.vdj_scheduler_request(text,uuid,text,jsonb) from public,anon,authenticated;
