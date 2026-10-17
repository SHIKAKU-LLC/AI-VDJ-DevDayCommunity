-- PREPARED ONLY. Requires explicit deployment/EXECUTE approval.
-- Existing dedicated project only. No role/table/policy or SECURITY DEFINER.
-- Fixed projections/calls, never arbitrary SQL. Server-authenticated runtime
-- signature is verified in Edge; this service_role-only RPC consumes its nonce
-- under the existing room lock in the SAME transaction as each private call.
begin;
create function public.vdj_runtime_request(action text, requested_room uuid,
 capability text, payload jsonb, runtime jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare room_row vdj_internal.rooms; current_ms numeric; args jsonb; statement_id text;
 ledger jsonb; nonces jsonb; result jsonb; value jsonb; key_count integer;
begin
 if action='scope' then
  if payload is distinct from '{}'::jsonb or runtime is distinct from '{}'::jsonb then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
  select * into room_row from vdj_internal.rooms where id=requested_room for update;
  if not found or room_row.expires_at<=clock_timestamp() then raise exception 'RUNTIME_SCOPE_HOLD';end if;
  if capability is null or vdj_internal.proof(capability)<>room_row.owner_proof or not exists(
   select 1 from vdj_internal.owners where uid=room_row.owner_uid and enabled)
  then raise exception 'OWNER_DENIED';end if;
  return jsonb_build_object('roomId',room_row.id,'sessionId',room_row.epoch,'controlRevision',room_row.control_revision,
   'expiresAtMs',floor(extract(epoch from room_row.expires_at)*1000));
 end if;
 if action not in ('authorize','query') or jsonb_typeof(payload) is distinct from 'object' or
  octet_length(payload::text)>131072 or jsonb_typeof(runtime) is distinct from 'object'
 then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
 select count(*) into key_count from jsonb_object_keys(runtime);
 if key_count<>7 or exists(select 1 from jsonb_object_keys(runtime) k where k not in
  ('workerId','roomId','sessionId','controlRevision','expiresAtMs','requestedAtMs','nonceSha256')) or
  coalesce(runtime->>'workerId','')!~'^[A-Za-z0-9_-]{20,100}$' or
  coalesce(runtime->>'nonceSha256','')!~'^[a-f0-9]{64}$' or jsonb_typeof(runtime->'expiresAtMs') is distinct from 'number' or
  jsonb_typeof(runtime->'requestedAtMs') is distinct from 'number' or
  coalesce(runtime->>'expiresAtMs','')!~'^[0-9]{1,16}$' or coalesce(runtime->>'requestedAtMs','')!~'^[0-9]{1,16}$'
 then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
 select * into room_row from vdj_internal.rooms where id=requested_room for update;
 current_ms:=floor(extract(epoch from clock_timestamp())*1000);
 if not found or room_row.expires_at<=clock_timestamp() then raise exception 'RUNTIME_SCOPE_HOLD';end if;
 if capability is null or vdj_internal.proof(capability)<>room_row.owner_proof or not exists(
  select 1 from vdj_internal.owners where uid=room_row.owner_uid and enabled)
 then raise exception 'OWNER_DENIED';end if;
 if runtime->>'roomId' is distinct from requested_room::text or runtime->>'sessionId' is distinct from room_row.epoch::text or
  runtime->>'controlRevision' is distinct from room_row.control_revision::text or
  (runtime->>'expiresAtMs')::numeric<=current_ms or (runtime->>'expiresAtMs')::numeric>current_ms+1800000 or
  (runtime->>'expiresAtMs')::numeric>floor(extract(epoch from room_row.expires_at)*1000) or
  (runtime->>'requestedAtMs')::numeric>current_ms+1000 or (runtime->>'requestedAtMs')::numeric<current_ms-8000
 then raise exception 'RUNTIME_SCOPE_HOLD';end if;
 ledger:=room_row.operations->'__runtime_worker_v1';
 if ledger is not null and ledger->>'sessionId' is not distinct from room_row.epoch::text and ledger->>'controlRevision'=room_row.control_revision::text and
  (ledger->>'expiresAtMs')::numeric>current_ms and
  (ledger->>'workerId' is distinct from runtime->>'workerId' or ledger->>'expiresAtMs' is distinct from runtime->>'expiresAtMs')
 then raise exception 'RUNTIME_WORKER_HOLD';end if;
 if ledger is null or ledger->>'sessionId' is distinct from room_row.epoch::text or
  ledger->>'controlRevision' is distinct from room_row.control_revision::text or (ledger->>'expiresAtMs')::numeric<=current_ms
 then ledger:='{}'::jsonb;end if;
 select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) into nonces from
  jsonb_each(coalesce(ledger->'nonces','{}'::jsonb)) e(k,v) where v::numeric>current_ms;
 if nonces ? (runtime->>'nonceSha256') then raise exception 'RUNTIME_REPLAY_HOLD';end if;
 if (select count(*) from jsonb_object_keys(nonces))>=128 then raise exception 'RUNTIME_REQUEST_CAP';end if;
 nonces:=nonces||jsonb_build_object(runtime->>'nonceSha256',(runtime->>'requestedAtMs')::numeric+9000);
 ledger:=jsonb_build_object('workerId',runtime->>'workerId','sessionId',room_row.epoch,'controlRevision',room_row.control_revision,
  'expiresAtMs',(runtime->>'expiresAtMs')::numeric,'nonces',nonces);
 update vdj_internal.rooms set operations=jsonb_set(operations,'{__runtime_worker_v1}',ledger,true) where id=requested_room;
 if action='authorize' then
  if payload<>'{}'::jsonb then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
  return jsonb_build_object('authorized',true);
 end if;
 if (select count(*) from jsonb_object_keys(payload))<>2 or not(payload ? 'statementId' and payload ? 'args') or
  jsonb_typeof(payload->'args') is distinct from 'array' then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
 args:=payload->'args';statement_id:=payload->>'statementId';
 if statement_id in ('scope','runtime') and jsonb_array_length(args)<>0 or
  statement_id in ('operation','permit','attachments') and jsonb_array_length(args)<>1 or
  statement_id in ('observer','operator','candidates') and jsonb_array_length(args)<>5 or
  statement_id='permits' and jsonb_array_length(args)<>4 or statement_id='scheduler' and jsonb_array_length(args)<>2
 then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
 if statement_id in ('operation','permit') and coalesce(args->>0,'')!~'^[A-Za-z0-9_-]{20,100}$'
 then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
 if statement_id='attachments' and (jsonb_typeof(args->0) is distinct from 'array' or jsonb_array_length(args->0)>100 or
  exists(select 1 from jsonb_array_elements_text(args->0) e(v) where v!~'^[A-Za-z0-9_-]{1,100}$'))
 then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
 if statement_id='candidates' and ((args->>0)::uuid is distinct from room_row.epoch or (args->>1)::bigint is distinct from room_row.control_revision or
  (args->>4)::integer not between 1 and 21 or args->3<>'null'::jsonb and coalesce(args->>3,'')!~'^[A-Za-z0-9_-]{20,100}$')
 then raise exception 'RUNTIME_SCOPE_HOLD';end if;
 if statement_id='scope' then
  select coalesce(jsonb_agg(to_jsonb(selected)),'[]'::jsonb) into value from (select r.id as "roomId",r.epoch as "sessionId",r.control_revision::float as "controlRevision",
      extract(epoch from r.expires_at)*1000 as "expiresAtMs",o.enabled as "ownerEnabled"
      from vdj_internal.rooms r join vdj_internal.owners o on o.uid=r.owner_uid where r.id=(requested_room)) selected;
 elsif statement_id='runtime' then
  select coalesce(jsonb_agg(to_jsonb(selected)),'[]'::jsonb) into value from (select document->'roomRuntime' as runtime from vdj_internal.generation_operations
      where room_id=(requested_room) and document ? 'roomRuntime' order by id limit 2) selected;
 elsif statement_id='attachments' then
  select coalesce(jsonb_agg(to_jsonb(selected)),'[]'::jsonb) into value from (select o.id as "operationId",p.id as "permitId",o.room_id as "roomId",p.room_epoch as "sessionId",
      p.control_revision::float as "controlRevision",o.document->>'submissionId' as "submissionId",
      p.document->>'sourceSha256' as "sourceSha256" from vdj_internal.generation_operations o
      join vdj_internal.generation_permits p on p.id=o.permit_id and p.room_id=o.room_id
      join vdj_internal.rooms r on r.id=o.room_id where o.room_id=(requested_room) and o.document->>'submissionId'=any((array(select jsonb_array_elements_text(args->0)))::text[])
      and exists(select 1 from jsonb_array_elements(r.submissions) s where s->>'submissionId'=o.document->>'submissionId')
      order by o.id limit 101) selected;
 elsif statement_id='operation' then
  select coalesce(jsonb_agg(to_jsonb(selected)),'[]'::jsonb) into value from (select o.room_id as "roomId",p.room_epoch as "sessionId",p.id as "permitId",
      p.control_revision::float as "controlRevision",p.revoked,extract(epoch from p.expires_at)*1000 as "expiresAtMs",
      p.document as "permitDocument" from vdj_internal.generation_operations o
      join vdj_internal.generation_permits p on p.id=o.permit_id and p.room_id=o.room_id where o.id=(args->>0) and o.room_id=(requested_room)) selected;
 elsif statement_id='permit' then
  select coalesce(jsonb_agg(to_jsonb(selected)),'[]'::jsonb) into value from (select p.room_id as "roomId",p.room_epoch as "sessionId",p.id as "permitId",
      p.control_revision::float as "controlRevision",p.revoked,extract(epoch from p.expires_at)*1000 as "expiresAtMs",
      p.document as "permitDocument" from vdj_internal.generation_permits p where p.id=(args->>0) and p.room_id=(requested_room)) selected;
 elsif statement_id='candidates' then
  select coalesce(jsonb_agg(to_jsonb(selected)),'[]'::jsonb) into value from (select o.room_id as "roomId",o.id as "operationId",p.id as "permitId",
  r.epoch as "sessionId",r.control_revision::float as "controlRevision"
  from vdj_internal.generation_operations o
  join vdj_internal.generation_permits p on p.id=o.permit_id and p.room_id=o.room_id
  join vdj_internal.rooms r on r.id=o.room_id
  join vdj_internal.owners owner on owner.uid=r.owner_uid
  left join lateral (
    select a.document->'roomRuntime' as runtime from vdj_internal.generation_operations a
    where a.room_id=r.id and a.document ? 'roomRuntime' limit 1
  ) anchor on true
  where o.room_id=(requested_room)::uuid and r.epoch=((args->>0)::uuid)::uuid and r.control_revision=((args->>1)::bigint)::bigint
  and owner.enabled=true and r.expires_at>to_timestamp((current_ms)::double precision/1000)
  and p.expires_at>to_timestamp((current_ms)::double precision/1000) and p.revoked=false
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
  and ((args->>3)::text is null or o.id collate "C">(args->>3)::text collate "C")
  order by o.id collate "C" limit ((args->>4)::integer)::integer) selected;
 elsif statement_id in ('observer','operator') then
  if (statement_id='operator' and args->>0 not in ('read','cas')) or
   (statement_id='observer' and args->>0 not in ('read','cas','sourceReceiptRead','sourceReceiptPut')) or
   (args->>1)::uuid is distinct from room_row.epoch or
   (args->>2)::bigint is distinct from room_row.control_revision or
   (args->>0='read' and (args->3<>'null'::jsonb or args->4<>'null'::jsonb)) or
   (args->>0 in ('sourceReceiptRead','sourceReceiptPut') and (args->3<>'null'::jsonb or jsonb_typeof(args->4) is distinct from 'object')) or
   (args->>0='cas' and (jsonb_typeof(args->4) is distinct from 'object' or (args->>3)::bigint<0))
  then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
  if statement_id='observer' then
   value:=vdj_internal.player_observer_state(args->>0,requested_room,capability,(args->>1)::uuid,(args->>2)::bigint,(args->>3)::bigint,nullif(args->4,'null'::jsonb));
  else value:=vdj_internal.owner_operator_state(args->>0,requested_room,capability,(args->>1)::uuid,(args->>2)::bigint,(args->>3)::bigint,nullif(args->4,'null'::jsonb));end if;
  value:=jsonb_build_array(jsonb_build_object('value',value));
 elsif statement_id='permits' then
  if (args->>0)::uuid is distinct from room_row.epoch or (args->>1)::bigint is distinct from room_row.control_revision or
   coalesce(args->>2,'')!~'^[A-Za-z0-9_-]{20,100}$' or jsonb_typeof(args->3) is distinct from 'object'
  then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
  value:=jsonb_build_array(jsonb_build_object('value',vdj_internal.owner_operator_permits(requested_room,capability,
   (args->>0)::uuid,(args->>1)::bigint,args->>2,args->3)));
 elsif statement_id='scheduler' then
  if args->>0 not in ('enqueue','claim','assert','renew','finish') or jsonb_typeof(args->1) is distinct from 'object'
  then raise exception 'RUNTIME_INPUT_REQUIRED';end if;
  value:=jsonb_build_array(jsonb_build_object('value',vdj_internal.vdj_scheduler_request(args->>0,requested_room,capability,args->1)));
 else raise exception 'RUNTIME_INPUT_REQUIRED';end if;
 result:=jsonb_build_object('rows',value);
 if octet_length(result::text)>1048576 then raise exception 'RUNTIME_REPLY_LIMIT';end if;
 return result;
end $$;
revoke all on function public.vdj_runtime_request(text,uuid,text,jsonb,jsonb) from public,anon,authenticated;
-- Proposed minimal EXECUTE only. NOT APPLIED; no broad all-functions grant.
grant execute on function public.vdj_runtime_request(text,uuid,text,jsonb,jsonb) to service_role;
grant execute on function vdj_internal.player_observer_state(text,uuid,text,uuid,bigint,bigint,jsonb) to service_role;
grant execute on function vdj_internal.owner_operator_state(text,uuid,text,uuid,bigint,bigint,jsonb) to service_role;
grant execute on function vdj_internal.owner_operator_permits(uuid,text,uuid,bigint,text,jsonb) to service_role;
grant execute on function vdj_internal.vdj_scheduler_request(text,uuid,text,jsonb) to service_role;
grant execute on function vdj_internal.vdj_scheduler_eligible(text,uuid) to service_role;
commit;
