-- Prepared ONLY: existing private room/permit rows, invoker, no new grants/TTL.
create or replace function vdj_internal.owner_operator_state(action text, requested_room uuid, capability text,
 expected_epoch uuid, expected_control bigint, expected_version bigint, document jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r vdj_internal.rooms; saved jsonb; version bigint;
begin
 select * into r from vdj_internal.rooms where id=requested_room for update;
 if not found or r.expires_at<=clock_timestamp() then raise exception 'OPERATOR_SCOPE_CHANGED'; end if;
 if capability is null or vdj_internal.proof(capability)<>r.owner_proof or not exists(select 1 from vdj_internal.owners where uid=r.owner_uid and enabled)
 then raise exception 'OWNER_DENIED'; end if;
 if expected_epoch is distinct from r.epoch or expected_control is distinct from r.control_revision then raise exception 'OPERATOR_SCOPE_CHANGED'; end if;
 saved:=r.operations->'__owner_operator_v1';
 if saved->>'sessionId' is distinct from r.epoch::text or saved->>'controlRevision' is distinct from r.control_revision::text then saved:=null; end if;
 version:=coalesce((saved->>'version')::bigint,0);
 if action='read' then return coalesce(saved,jsonb_build_object('version',0,'record',null)); end if;
 if action<>'cas' or expected_version is distinct from version then raise exception 'OPERATOR_CAS_CONFLICT'; end if;
 if document is null or jsonb_typeof(document)<>'object' or octet_length(document::text)>65536 or
 document->>'roomId' is distinct from r.id::text or document->>'sessionId' is distinct from r.epoch::text or document->>'controlRevision' is distinct from r.control_revision::text
 then raise exception 'OPERATOR_STATE_REQUIRED'; end if;
 saved:=jsonb_build_object('sessionId',r.epoch,'controlRevision',r.control_revision,'version',version+1,'record',document);
 update vdj_internal.rooms set operations=jsonb_set(operations,'{__owner_operator_v1}',saved,true) where id=r.id;return saved;
end $$;
revoke all on function vdj_internal.owner_operator_state(text,uuid,text,uuid,bigint,bigint,jsonb) from public,anon,authenticated;

create or replace function vdj_internal.owner_operator_permits(requested_room uuid, capability text,
 expected_epoch uuid, expected_control bigint, requested_plan text, document jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r vdj_internal.rooms; saved jsonb; plan jsonb; op jsonb; frozen jsonb; count integer:=0;
 grant_doc jsonb; existing_op vdj_internal.generation_operations; existing_permit vdj_internal.generation_permits; stamp numeric; refreshed jsonb;
begin
 select * into r from vdj_internal.rooms where id=requested_room for update;
 if not found or r.expires_at<=clock_timestamp() then raise exception 'OPERATOR_SCOPE_CHANGED'; end if;
 if capability is null or vdj_internal.proof(capability)<>r.owner_proof or not exists(select 1 from vdj_internal.owners where uid=r.owner_uid and enabled)
 then raise exception 'OWNER_DENIED'; end if;
 if expected_epoch is distinct from r.epoch or expected_control is distinct from r.control_revision then raise exception 'OPERATOR_SCOPE_CHANGED'; end if;
 saved:=r.operations->'__owner_operator_v1'->'record';plan:=saved->'plans'->requested_plan;
 -- Refresh delivery/financial evidence for the SAME admitted operations. The
 -- durable application consent has no deadline; owner/device/room, Stop,
 -- finite credentials, <=1h URLs/prices/balance and cumulative limits still gate.
 if plan->>'phase'='STARTED' and plan ? 'executionAuthorization' then
  grant_doc:=plan->'executionAuthorization';stamp:=floor(extract(epoch from clock_timestamp())*1000);
  if saved->'active'->>'planId' is distinct from requested_plan or
   saved->>'roomId' is distinct from r.id::text or saved->>'sessionId' is distinct from r.epoch::text or
   saved->>'controlRevision' is distinct from r.control_revision::text or
   plan->>'roomId' is distinct from r.id::text or plan->>'sessionId' is distinct from r.epoch::text or
   plan->>'controlRevision' is distinct from r.control_revision::text or
   grant_doc->>'kind' is distinct from 'room-budget-execution-consent-v1' or
   grant_doc->'expiresAtMs' is distinct from 'null'::jsonb or grant_doc->'revoked' is distinct from 'false'::jsonb or
   grant_doc->>'roomId' is distinct from r.id::text or grant_doc->>'sessionId' is distinct from r.epoch::text or
   grant_doc->>'controlRevision' is distinct from r.control_revision::text or grant_doc->>'planId' is distinct from requested_plan or
   (grant_doc->>'approvedAtMs')::numeric>stamp or (grant_doc->>'approvedAtMs')::numeric<=0 or
   grant_doc->'generationMaximumCents' is distinct from '150'::jsonb or
   grant_doc->'infrastructureMaximumCents' is distinct from '150'::jsonb or
   grant_doc->'unknownReserveCents' is distinct from plan->'recovery'->'unknownIntentReserveCents' or
   grant_doc->'totalReservationCents' is distinct from plan->'recovery'->'totalGenerationReservationCents' or
   (grant_doc->>'totalReservationCents')::integer<>100+(grant_doc->>'unknownReserveCents')::integer or
   (grant_doc->>'unknownReserveCents')::integer<0 or (grant_doc->>'totalReservationCents')::integer>150 or
   plan->'recovery'->'thirdParticipantExcluded' is distinct from 'true'::jsonb or
   plan->'participants' is distinct from '2'::jsonb or plan->'maximumCents' is distinct from '100'::jsonb or
   (plan->>'infrastructureMaximumUsd')::numeric>1.5 or jsonb_array_length(plan->'operations')<>2 or
   grant_doc->'operationIds' is distinct from (select jsonb_agg(x->'operationId') from jsonb_array_elements(plan->'operations') x) or
   grant_doc->'operationIds' is distinct from (select jsonb_agg(x->'operationId') from jsonb_array_elements(document->'operations') x) or
   (document - 'expiresAtMs' - 'operations') is distinct from (plan - 'expiresAtMs' - 'operations') or
   jsonb_array_length(document->'operations')<>2 or
   (document->>'expiresAtMs')::numeric<=stamp or (document->>'expiresAtMs')::numeric>stamp+3600000 or
   (document->>'expiresAtMs')::numeric>floor(extract(epoch from r.expires_at)*1000) or
   exists(select 1 from vdj_internal.generation_operations a where a.room_id=r.id and a.document ? 'roomRuntime'
     and a.document->'roomRuntime'->'stopped' is distinct from 'false'::jsonb)
  then raise exception 'EXECUTION_EVIDENCE_REFRESH_HOLD';end if;
  for op in select value from jsonb_array_elements(document->'operations') loop
   select value into frozen from jsonb_array_elements(plan->'operations') where value->>'operationId'=op->>'operationId';
   select * into existing_op from vdj_internal.generation_operations where id=op->>'operationId' and room_id=r.id for update;
   if not found then raise exception 'EXECUTION_OPERATION_CHANGED';end if;
   select * into existing_permit from vdj_internal.generation_permits where id=existing_op.permit_id and room_id=r.id for update;
   if not found or existing_permit.revoked or existing_permit.room_epoch<>r.epoch or existing_permit.control_revision<>r.control_revision or
    frozen is null or (op - 'permit') is distinct from (frozen - 'permit') or
    ((op->'permit') - 'createdAtMs' - 'expiresAtMs' - 'quote' - 'balance' - 'assets') is distinct from ((frozen->'permit') - 'createdAtMs' - 'expiresAtMs' - 'quote' - 'balance' - 'assets') or
    op->'permit'->'expiresAtMs' is distinct from document->'expiresAtMs' or
    (op->'permit'->>'createdAtMs')::numeric>stamp or stamp-(op->'permit'->>'createdAtMs')::numeric>60000 or
    op->'permit'->'maximumUsd' is distinct from '0.5'::jsonb or
    existing_op.document->'permit' is distinct from existing_permit.document or
    existing_op.document->'stopped' is distinct from 'false'::jsonb or
    jsonb_typeof(existing_op.document->'stages') is distinct from 'object' or existing_op.document->'stages'='{}'::jsonb or
    coalesce((existing_op.document->'scheduler'->>'leaseUntilMs')::numeric,0)>stamp or
    exists(select 1 from jsonb_each(existing_op.document->'stages') st where st.value->>'state' not in ('SUBMITTED','COMPLETE')
      or coalesce(st.value->>'requestId','') !~ '^[A-Za-z0-9_-]{1,100}$')
   then raise exception 'EXECUTION_OPERATION_CHANGED';end if;
   if existing_op.document ? 'cue' then
    -- A published Cue is an immutable completed admission, not new spending.
    -- Preserve its exact permit, media, receipt and terminal scheduler. Refresh
    -- only the unfinished member of the same already approved two-ID plan.
    if coalesce(existing_op.document->'cue'->>'status','') not in ('READY','PLAYING','PLAYED') or
     existing_op.document->'cue'->'atomicReady' is distinct from 'true'::jsonb or
     existing_op.document->'cue'->>'operationId' is distinct from existing_op.id or
     existing_op.document->'cue'->>'roomId' is distinct from r.id::text or
     existing_op.document->'cue'->>'submissionId' is distinct from existing_op.document->>'submissionId' or
     existing_op.document->'cue'->>'cueId' is distinct from existing_op.document->'plan'->'common'->>'cueId' or
     existing_op.document->'cue'->>'commonIntentSha256' is distinct from existing_op.document->'plan'->>'commonIntentSha256' or
     coalesce(existing_op.document->'cue'->>'evidenceSha256','') !~ '^[a-f0-9]{64}$' or
     existing_op.document->'cue'->'music'->'qc'->'passed' is distinct from 'true'::jsonb or
     existing_op.document->'cue'->'video'->'qc'->'passed' is distinct from 'true'::jsonb or
     existing_op.document->'cue'->>'mode' is distinct from 'provider' or
     existing_op.document->'cue'->'actualGenerationThisRun' is distinct from 'true'::jsonb or
     existing_op.document->'cue'->>'sourceSha256' is distinct from existing_op.document->'permit'->>'sourceSha256' or
     coalesce(existing_op.document->'cue'->>'generationId','') !~ '^[A-Za-z0-9_-]{1,100}$' or
     exists(select 1 from (values ('music'),('video')) channels(channel) where
      existing_op.document->'cue'->channel->'actualGenerationThisRun' is distinct from 'true'::jsonb or
      existing_op.document->'cue'->channel->'binding'->>'channel' is distinct from channel or
      exists(select 1 from (values ('roomId'),('submissionId'),('generationId'),('commonIntentSha256'),('controlVersion')) fields(field) where
       existing_op.document->'cue'->channel->'binding'->field is distinct from existing_op.document->'cue'->field)) or
     not (existing_op.document->'stages' ?& array['intent','music','video']) or
     exists(select 1 from jsonb_each(existing_op.document->'stages') st where st.value->>'state' is distinct from 'COMPLETE')
    then raise exception 'EXECUTION_COMPLETED_CUE_CHANGED';end if;
    count:=count+1;continue;
   end if;
   update vdj_internal.generation_permits set document=op->'permit',expires_at=to_timestamp((owner_operator_permits.document->>'expiresAtMs')::numeric/1000)
    where id=existing_permit.id;
   -- Retain every stage, signature, request ID, result and scheduler fence.
   refreshed:=jsonb_set(existing_op.document,'{permit}',op->'permit');
   refreshed:=jsonb_set(refreshed,'{scheduler}',coalesce(refreshed->'scheduler','{}'::jsonb)||jsonb_build_object('terminal',false,'dueAtMs',stamp));
   update vdj_internal.generation_operations set document=refreshed where id=existing_op.id;
   count:=count+1;
  end loop;
  if count<>2 then raise exception 'EXECUTION_OPERATION_CHANGED';end if;
  -- The operator journal never contains signed URLs. Its immutable descriptors
  -- keep the same fields while the private permit row holds delivery URLs.
  refreshed:=jsonb_set(plan,'{expiresAtMs}',document->'expiresAtMs');
  refreshed:=jsonb_set(refreshed,'{operations}',(select jsonb_agg(x || jsonb_build_object('permit',
   (select (a.document->'permit') - 'assets' from vdj_internal.generation_operations a where a.id=x->>'operationId' and a.room_id=r.id)))
   from jsonb_array_elements(plan->'operations') x));
  saved:=jsonb_set(saved,array['plans',requested_plan],refreshed);
  update vdj_internal.rooms set operations=jsonb_set(operations,'{__owner_operator_v1}',
   (r.operations->'__owner_operator_v1')||jsonb_build_object('record',saved,'version',(r.operations->'__owner_operator_v1'->>'version')::bigint+1)) where id=r.id;
  return jsonb_build_object('inserted',count,'refreshed',true);
 end if;
 if saved->>'roomId' is distinct from r.id::text or saved->>'sessionId' is distinct from r.epoch::text or
 saved->>'controlRevision' is distinct from r.control_revision::text or
 plan->>'roomId' is distinct from r.id::text or plan->>'sessionId' is distinct from r.epoch::text or
 plan->>'controlRevision' is distinct from r.control_revision::text or
 document->>'roomId' is distinct from r.id::text or document->>'sessionId' is distinct from r.epoch::text or
 document->>'controlRevision' is distinct from r.control_revision::text or
 saved->'active'->>'planId' is distinct from requested_plan or plan->>'phase' is distinct from 'CLAIMED' or
 document->>'planId' is distinct from requested_plan or jsonb_typeof(document->'operations') is distinct from 'array' or
 jsonb_array_length(document->'operations')<>jsonb_array_length(plan->'operations') or
 ((plan->'participants'='1'::jsonb and plan->'maximumCents'='50'::jsonb and jsonb_array_length(document->'operations')=1) or
      (plan->'participants'='2'::jsonb and plan->'maximumCents'='100'::jsonb and jsonb_array_length(document->'operations')=2) or
      (plan->'participants'='3'::jsonb and plan->'maximumCents'='150'::jsonb and jsonb_array_length(document->'operations')=1) or
      (plan->'participants'='5'::jsonb and plan->'maximumCents'='250'::jsonb and jsonb_array_length(document->'operations')=5)) is not true
 then raise exception 'OPERATOR_PLAN_CHANGED'; end if;
 for op in select value from jsonb_array_elements(document->'operations') loop
  select value into frozen from jsonb_array_elements(plan->'operations') where value->>'operationId'=op->>'operationId';
  if frozen is null or frozen->>'permitId' is distinct from op->>'permitId' or frozen->>'submissionId' is distinct from op->>'submissionId' or
   frozen->>'participantId' is distinct from op->>'participantId' or op->'permit'->>'permitId' is distinct from frozen->>'permitId' or
   op->'permit'->'source' is distinct from frozen->'permit'->'source' or
   op->'permit'->>'connectionId' is distinct from plan->>'connectionId' or
   op->'permit'->'expiresAtMs' is distinct from frozen->'permit'->'expiresAtMs' or
   op->'permit'->>'sourceSha256' is distinct from plan->>'sourceSha256' or op->'permit'->'maximumUsd' is distinct from '0.5'::jsonb or
   op->'permit'->'counts' is distinct from '{"intent":1,"music":1,"video":1}'::jsonb or
   (op->'permit'->>'expiresAtMs')::numeric<=floor(extract(epoch from clock_timestamp())*1000) or
   (op->'permit'->>'expiresAtMs')::numeric>floor(extract(epoch from r.expires_at)*1000) or
   not exists(select 1 from jsonb_array_elements(r.submissions) s where s->>'submissionId'=op->>'submissionId' and s->>'participantId'=op->>'participantId')
  then raise exception 'OPERATOR_PLAN_CHANGED'; end if;
  insert into vdj_internal.generation_permits(id,room_id,room_epoch,control_revision,expires_at,document)
   values(op->>'permitId',r.id,r.epoch,r.control_revision,to_timestamp((op->'permit'->>'expiresAtMs')::numeric/1000),op->'permit');
  count:=count+1;
 end loop;
 return jsonb_build_object('inserted',count);
end $$;
revoke all on function vdj_internal.owner_operator_permits(uuid,text,uuid,bigint,text,jsonb) from public,anon,authenticated;
