-- Additive preparation, not deployed or activated by loading this file.
-- Permits are inserted by an explicitly authorized server-side operator only.
-- No browser role can write a quote, source attestation, budget, or permit.
create table vdj_internal.generation_permits (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{20,100}$'),
  room_id uuid not null references vdj_internal.rooms(id) on delete cascade,
  room_epoch uuid not null,
  control_revision bigint not null,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  document jsonb not null check (jsonb_typeof(document)='object')
);
create table vdj_internal.generation_operations (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{20,100}$'),
  permit_id text unique not null references vdj_internal.generation_permits(id),
  room_id uuid not null references vdj_internal.rooms(id) on delete cascade,
  document jsonb not null check (jsonb_typeof(document)='object')
);
alter table vdj_internal.generation_permits enable row level security;
alter table vdj_internal.generation_operations enable row level security;
revoke all on vdj_internal.generation_permits, vdj_internal.generation_operations from public, anon, authenticated;
grant select, insert, update, delete on vdj_internal.generation_permits, vdj_internal.generation_operations to service_role;

create function public.vdj_generation_request(
  op text, room_id uuid, capability text, payload jsonb default '{}'
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r vdj_internal.rooms; permit vdj_internal.generation_permits;
  existing vdj_internal.generation_operations; doc jsonb; prior jsonb;
  stage text; submission jsonb; next_stage jsonb;
begin
  select * into r from vdj_internal.rooms where id=room_id for update;
  if not found or r.expires_at<=now() then raise exception 'ROOM_UNAVAILABLE'; end if;
  if capability is null or vdj_internal.proof(capability)<>r.owner_proof or not exists(
    select 1 from vdj_internal.owners where uid=r.owner_uid and enabled
  ) then raise exception 'OWNER_DENIED'; end if;

  if op in ('permit','begin') then
    select * into permit from vdj_internal.generation_permits
      where id=payload->>'permitId' and generation_permits.room_id=r.id for update;
    if not found or permit.revoked or permit.expires_at<=now() or permit.room_epoch<>r.epoch or
       permit.control_revision<>r.control_revision then raise exception 'GENERATION_PERMIT_REQUIRED'; end if;
    if op='permit' then return permit.document||jsonb_build_object('permitId',permit.id); end if;
    if (payload->>'operationId') is null or (payload->>'operationId') !~ '^[A-Za-z0-9_-]{20,100}$' or
       (payload->>'keyProof') is null or (payload->>'keyProof') !~ '^[a-f0-9]{64}$' then raise exception 'OPERATION_INVALID'; end if;
    select * into existing from vdj_internal.generation_operations where permit_id=permit.id;
    if found then
      if existing.id<>payload->>'operationId' or existing.document->>'submissionId'<>payload->>'submissionId' or
         existing.document->>'keyProof'<>payload->>'keyProof' then raise exception 'PERMIT_ALREADY_USED'; end if;
      return existing.document;
    end if;
    select value into submission from jsonb_array_elements(r.submissions)
      where value->>'submissionId'=payload->>'submissionId';
    if submission is null then raise exception 'SUBMISSION_REQUIRED'; end if;
    doc:=jsonb_build_object('operationId',payload->>'operationId','submissionId',payload->>'submissionId',
      'prompt',submission->>'prompt','keyProof',payload->>'keyProof',
      'permit',permit.document||jsonb_build_object('permitId',permit.id),'stages','{}'::jsonb,'stopped',false);
    insert into vdj_internal.generation_operations(id,permit_id,room_id,document)
      values(payload->>'operationId',permit.id,r.id,doc);
    return doc;
  end if;

  select * into existing from vdj_internal.generation_operations
    where id=payload->>'operationId' and generation_operations.room_id=r.id for update;
  if not found then raise exception 'GENERATION_OPERATION_REQUIRED'; end if;
  doc:=existing.document;
  if op='read' then
    select * into permit from vdj_internal.generation_permits where id=existing.permit_id;
    return doc||jsonb_build_object('dispatchAllowed',not permit.revoked and permit.expires_at>now() and
      permit.room_epoch=r.epoch and permit.control_revision=r.control_revision);
  end if;
  if op='stop' then doc:=doc||jsonb_build_object('stopped',true);
  else
    stage:=payload->>'stage';
    if stage is null or stage not in ('intent','music','video') then raise exception 'GENERATION_STAGE_REQUIRED'; end if;
    prior:=doc->'stages'->stage;
    if op='claim' then
      select * into permit from vdj_internal.generation_permits where id=existing.permit_id;
      if permit.revoked or permit.expires_at<=now() or permit.room_epoch<>r.epoch or
         permit.control_revision<>r.control_revision or (doc->>'stopped')::boolean then raise exception 'GENERATION_PERMIT_REQUIRED'; end if;
      if prior is not null then raise exception 'STAGE_ALREADY_RESERVED'; end if;
      if (payload->>'signature') is null or (payload->>'signature') !~ '^[a-f0-9]{64}$' then raise exception 'SIGNATURE_REQUIRED'; end if;
      if stage<>'intent' and (doc->'plan'->>'status' is distinct from 'COMPILED' or
        doc->'stages'->'intent'->>'state' is distinct from 'COMPLETE') then raise exception 'COMPILED_INTENT_REQUIRED'; end if;
      next_stage:=jsonb_build_object('state','RESERVED','signature',payload->>'signature');
    elsif op in ('submitted','unknown') then
      if prior->>'state' is distinct from 'RESERVED' or prior->>'signature' is distinct from payload->>'signature'
        then raise exception 'STAGE_CLAIM_REQUIRED'; end if;
      if op='submitted' then
        if (payload->>'requestId') is null or (payload->>'requestId') !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'REQUEST_ID_REQUIRED'; end if;
        next_stage:=prior||jsonb_build_object('state','SUBMITTED','requestId',payload->>'requestId');
      else next_stage:=prior||jsonb_build_object('state','UNKNOWN'); end if;
    elsif op='complete' then
      if prior->>'state'='COMPLETE' then
        if prior->'result' is distinct from payload->'result' then raise exception 'RESULT_IMMUTABLE'; end if;
        return doc;
      end if;
      if prior->>'state' is distinct from 'SUBMITTED' or jsonb_typeof(payload->'result') is distinct from 'object'
        then raise exception 'SUBMITTED_STAGE_REQUIRED'; end if;
      next_stage:=prior||jsonb_build_object('state','COMPLETE','result',payload->'result');
      if stage='intent' then
        if jsonb_typeof(payload->'plan') is distinct from 'object' then raise exception 'COMPILED_INTENT_REQUIRED'; end if;
        doc:=doc||jsonb_build_object('plan',payload->'plan');
      end if;
    elsif op in ('failed','held') then
      if prior->>'state' is distinct from 'SUBMITTED' then raise exception 'SUBMITTED_STAGE_REQUIRED'; end if;
      next_stage:=prior||jsonb_build_object('state',case when op='held' then 'HOLD' else 'FAILED' end);
      if op='held' then
        if (payload->>'observedResultSha256') is null or (payload->>'observedResultSha256') !~ '^[a-f0-9]{64}$'
          then raise exception 'RESULT_DIGEST_REQUIRED'; end if;
        next_stage:=next_stage||jsonb_build_object('observedResultSha256',payload->>'observedResultSha256');
      end if;
    else raise exception 'GENERATION_OPERATION_INVALID'; end if;
    doc:=jsonb_set(doc,array['stages',stage],next_stage,true);
  end if;
  update vdj_internal.generation_operations set document=doc where id=existing.id;
  return doc;
end $$;
revoke all on function public.vdj_generation_request(text,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.vdj_generation_request(text,uuid,text,jsonb) to service_role;
