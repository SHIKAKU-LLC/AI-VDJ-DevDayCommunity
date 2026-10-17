-- Prepared cue lifecycle upgrade, NOT APPLIED.
-- Base schema.sql remains frozen at its existing approval hash.
-- This replaces the same service-only RPC body and writes only the two new
-- generation tables. It adds no table, grant or browser access. Review this
-- separate upgrade before deployment; base-DDL approval does not apply it.
create or replace function public.vdj_generation_request(
  op text, room_id uuid, capability text, payload jsonb default '{}'
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r vdj_internal.rooms; permit vdj_internal.generation_permits;
  existing vdj_internal.generation_operations; doc jsonb; prior jsonb;
  stage text; submission jsonb; next_stage jsonb;
  anchor vdj_internal.generation_operations; target vdj_internal.generation_operations;
  runtime jsonb; reservation jsonb; saved_ack jsonb; credit jsonb; submitted_cue jsonb;
  participant_key text; served integer;
begin
  select * into r from vdj_internal.rooms where id=room_id for update;
  if not found or r.expires_at<=now() then raise exception 'ROOM_UNAVAILABLE'; end if;
  if capability is null or vdj_internal.proof(capability)<>r.owner_proof or not exists(
    select 1 from vdj_internal.owners where uid=r.owner_uid and enabled
  ) then raise exception 'OWNER_DENIED'; end if;

  -- Cue lifecycle upgrade. New data remains in the two prepared tables.
  -- This replacement is a separate, not-yet-approved migration; base DDL is frozen.
  if op in ('cueState','cuePublish','cueReserve','cueReservation','cueAck','cueStop','cueStart') then
    select * into anchor from vdj_internal.generation_operations
      where generation_operations.room_id=r.id and document ? 'roomRuntime' for update;
    runtime:=coalesce(anchor.document->'roomRuntime',jsonb_build_object(
      'currentCredit',null,'servedCounts','{}'::jsonb,'acks','[]'::jsonb,'stopped',false));
    -- An expired, unacknowledged reservation can no longer be ACKed and earned
    -- no credit: release it (its SELECTED Cue back to READY) under this same
    -- row lock, so state reads and the next reservation see a READY Cue
    -- instead of a pending lock that only Stop -> Start could clear.
    if anchor.id is not null and runtime->'pending' is not null and runtime->'pending'<>'null'::jsonb and
       (runtime->'pending'->>'expiresAtMs')::numeric<=extract(epoch from now())*1000 then
      update vdj_internal.generation_operations set document=jsonb_set(document,'{cue,status}','"READY"'::jsonb)
        where id=runtime->'pending'->>'operationId' and generation_operations.room_id=r.id and document->'cue'->>'status'='SELECTED';
      runtime:=runtime||jsonb_build_object('pending',null);
      update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime}',runtime,true) where id=anchor.id;
    end if;
    if op='cueState' then
      return jsonb_build_object('roomId',r.id,'cues',coalesce((select jsonb_agg(document->'cue')
        from vdj_internal.generation_operations where generation_operations.room_id=r.id and document ? 'cue'),'[]'::jsonb),
        'currentCredit',runtime->'currentCredit','servedCounts',runtime->'servedCounts',
        'pending',runtime->'pending' is not null and runtime->'pending'<>'null'::jsonb,
        'stopped',runtime->'stopped');
    end if;
    if op='cuePublish' then
      select * into target from vdj_internal.generation_operations
        where id=payload->>'operationId' and generation_operations.room_id=r.id for update;
      if not found then raise exception 'GENERATION_OPERATION_REQUIRED'; end if;
      select * into permit from vdj_internal.generation_permits where id=target.permit_id;
      if permit.revoked or permit.room_epoch<>r.epoch or permit.control_revision<>r.control_revision or
         (target.document->>'stopped')::boolean then raise exception 'SOURCE_OR_CONTROL_CHANGED'; end if;
      submitted_cue:=payload->'cue';
      if target.document->'stages'->'music'->>'state' is distinct from 'COMPLETE' or
         target.document->'stages'->'video'->>'state' is distinct from 'COMPLETE' or
         submitted_cue->>'operationId' is distinct from target.id or
         submitted_cue->>'roomId' is distinct from r.id::text or
         submitted_cue->>'submissionId' is distinct from target.document->>'submissionId' or
         submitted_cue->>'commonIntentSha256' is distinct from target.document->'plan'->>'commonIntentSha256' or
         submitted_cue->>'cueId' is distinct from target.document->'plan'->'common'->>'cueId' or
         submitted_cue->'atomicReady' is distinct from 'true'::jsonb or submitted_cue->>'status' is distinct from 'READY'
        then raise exception 'BOUND_CUE_REQUIRED'; end if;
      if target.document ? 'cue' then
        if target.document->'cue'->>'evidenceSha256' is distinct from submitted_cue->>'evidenceSha256'
          then raise exception 'CUE_EVIDENCE_IMMUTABLE'; end if;
        return target.document->'cue';
      end if;
      select value into submission from jsonb_array_elements(r.submissions)
        where value->>'submissionId'=target.document->>'submissionId';
      if submission is null then raise exception 'SUBMISSION_REQUIRED'; end if;
      submitted_cue:=submitted_cue||jsonb_build_object('contribution',jsonb_build_object(
        'participantId',submission->>'participantId','nickname',submission->>'nickname',
        'submissionId',submission->>'submissionId'));
      update vdj_internal.generation_operations set document=jsonb_set(document,'{cue}',submitted_cue,true) where id=target.id;
      return submitted_cue;
    end if;
    if op in ('cueStop','cueStart') then
      if anchor.id is null then
        select * into anchor from vdj_internal.generation_operations
          where generation_operations.room_id=r.id order by id limit 1 for update;
        if anchor.id is null then raise exception 'GENERATION_OPERATION_REQUIRED'; end if;
      end if;
      if op='cueStop' then
        -- A reserved Cue whose actual AV ACK never arrived earned no credit and
        -- stays a valid candidate: return it to READY rather than stranding it
        -- in HOLD. The pending lock and current credit are still cleared, so a
        -- late ACK for the old reservation remains ineligible.
        if runtime->'pending' is not null and runtime->'pending'<>'null'::jsonb then
          update vdj_internal.generation_operations set document=jsonb_set(document,'{cue,status}','"READY"'::jsonb)
            where id=runtime->'pending'->>'operationId' and document->'cue'->>'status'='SELECTED';
        end if;
        -- The Cue sounding at Stop keeps its credit, ACK history and served
        -- count, and becomes a candidate again for the next Start (AI DJ
        -- selection already prefers less-served participants).
        update vdj_internal.generation_operations set document=jsonb_set(document,'{cue,status}','"READY"'::jsonb)
          where generation_operations.room_id=r.id and document->'cue'->>'status'='PLAYING';
        runtime:=runtime||jsonb_build_object('stopped',true,'pending',null,'currentCredit',null);
      else
        if runtime->'pending' is not null and runtime->'pending'<>'null'::jsonb then raise exception 'PLAYBACK_PENDING'; end if;
        if payload->'current'->'actual' is distinct from 'true'::jsonb or (payload->'current'->>'playbackRevision')::bigint<0
          then raise exception 'ACTUAL_PLAYBACK_SOURCE_REQUIRED'; end if;
        runtime:=runtime||jsonb_build_object('stopped',false,'currentRevision',(payload->'current'->>'playbackRevision')::bigint);
      end if;
      update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime}',runtime,true) where id=anchor.id;
      return jsonb_build_object('stopped',runtime->'stopped','currentCredit',runtime->'currentCredit');
    end if;
    if op='cueReserve' then
      if (runtime->>'stopped')::boolean then raise exception 'PLAYBACK_STOPPED'; end if;
      if runtime->'pending' is not null and runtime->'pending'<>'null'::jsonb then raise exception 'PLAYBACK_PENDING'; end if;
      select * into target from vdj_internal.generation_operations
        where id=payload->>'operationId' and generation_operations.room_id=r.id for update;
      if not found or target.document->'cue'->>'status' is distinct from 'READY' then raise exception 'READY_CUE_REQUIRED'; end if;
      select * into permit from vdj_internal.generation_permits where id=target.permit_id;
      if permit.revoked or permit.room_epoch<>r.epoch or permit.control_revision<>r.control_revision then raise exception 'SOURCE_OR_CONTROL_CHANGED'; end if;
      if payload->'plan'->>'status' is distinct from 'ELIGIBLE' or payload->'plan'->'liveReady' is distinct from 'true'::jsonb or
         payload->'plan'->>'cueId' is distinct from target.document->'cue'->>'cueId' or
         payload->'plan'->>'incomingSha256' is distinct from target.document->'cue'->'music'->'asset'->>'sha256' or
         (payload->>'expectedRevision')::bigint<>(payload->'current'->>'playbackRevision')::bigint+1 or
         (runtime ? 'currentRevision' and (runtime->>'currentRevision')::bigint<>(payload->'current'->>'playbackRevision')::bigint) or
         payload->'current'->'actual' is distinct from 'true'::jsonb or
         (payload->>'expiresAtMs')::numeric<=extract(epoch from now())*1000 or
         (payload->>'expiresAtMs')::numeric>extract(epoch from now())*1000+31000
        then raise exception 'BOUND_PLAYBACK_PLAN_REQUIRED'; end if;
      if anchor.id is null then anchor:=target; end if;
      submitted_cue:=target.document->'cue'||jsonb_build_object('status','SELECTED');
      reservation:=jsonb_build_object('roomId',r.id,'operationId',target.id,'reservationId',payload->>'reservationId',
        'cue',submitted_cue,'plan',payload->'plan','expectedRevision',(payload->>'expectedRevision')::bigint,
        'expiresAtMs',(payload->>'expiresAtMs')::numeric,'controlRevision',r.control_revision,'completed',false);
      runtime:=runtime||jsonb_build_object('pending',reservation,'currentRevision',(payload->'current'->>'playbackRevision')::bigint);
      update vdj_internal.generation_operations set document=jsonb_set(document,'{cue}',submitted_cue,true) where id=target.id;
      update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime}',runtime,true) where id=anchor.id;
      return reservation;
    end if;
    select value into saved_ack from jsonb_array_elements(runtime->'acks') where value->>'reservationId'=payload->>'reservationId';
    if op='cueReservation' then
      if saved_ack is not null then return saved_ack->'reservation'||jsonb_build_object('completed',true); end if;
      reservation:=runtime->'pending';
      if reservation is null or reservation->>'reservationId' is distinct from payload->>'reservationId' or
        (runtime->>'stopped')::boolean or (reservation->>'controlRevision')::bigint<>r.control_revision
        then raise exception 'PLAYBACK_RESERVATION_REQUIRED'; end if;
      return reservation;
    end if;
    if op='cueAck' then
      if saved_ack is not null then
        if saved_ack->>'ackSha256' is distinct from payload->>'ackSha256' then raise exception 'ACK_CONFLICT'; end if;
        return jsonb_build_object('accepted',true,'duplicate',true,'currentCredit',runtime->'currentCredit');
      end if;
      reservation:=runtime->'pending';
      if reservation is null or reservation->>'reservationId' is distinct from payload->>'reservationId' or
         (runtime->>'stopped')::boolean or (reservation->>'controlRevision')::bigint<>r.control_revision or
         (reservation->>'expiresAtMs')::numeric<extract(epoch from now())*1000
        then raise exception 'PLAYBACK_RESERVATION_REQUIRED'; end if;
      if payload->'ack'->>'roomId' is distinct from r.id::text or
         payload->'ack'->>'cueId' is distinct from reservation->'cue'->>'cueId' or
         payload->'ack'->>'clipId' is distinct from reservation->'cue'->'music'->'asset'->>'assetId' or
         payload->'ack'->>'playbackRevision' is distinct from reservation->>'expectedRevision' or
         payload->'ack'->'actual' is distinct from 'true'::jsonb or
         payload->'ack'->'audioStarted' is distinct from 'true'::jsonb or payload->'ack'->'videoPresented' is distinct from 'true'::jsonb or
         jsonb_typeof(payload->'ack'->'audioTime') is distinct from 'number' or (payload->'ack'->>'audioTime')::numeric<0
        then raise exception 'MATCHING_ACTUAL_AV_ACK_REQUIRED'; end if;
      select * into target from vdj_internal.generation_operations where id=reservation->>'operationId';
      participant_key:=target.document->'cue'->'contribution'->>'participantId';
      credit:=target.document->'cue'->'contribution'||jsonb_build_object('roomId',r.id,
        'cueId',reservation->'cue'->>'cueId','generationId',reservation->'cue'->>'generationId',
        'playbackRevision',(reservation->>'expectedRevision')::bigint,'actual',true,'actualPlayback',true,
        'audioTime',payload->'ack'->'audioTime');
      served:=coalesce((runtime->'servedCounts'->>participant_key)::integer,0)+1;
      runtime:=jsonb_set(runtime,array['servedCounts',participant_key],to_jsonb(served),true);
      runtime:=runtime||jsonb_build_object('pending',null,'currentCredit',credit,
        'currentRevision',(reservation->>'expectedRevision')::bigint,'acks',
        (select coalesce(jsonb_agg(value),'[]'::jsonb) from (
          select value from jsonb_array_elements(runtime->'acks'||jsonb_build_array(jsonb_build_object(
            'reservationId',payload->>'reservationId','ackSha256',payload->>'ackSha256','reservation',reservation)))
          with ordinality where ordinality>greatest(0,jsonb_array_length(runtime->'acks')+1-20)
        ) recent));
      update vdj_internal.generation_operations set document=jsonb_set(document,'{cue,status}','"PLAYED"'::jsonb)
        where generation_operations.room_id=r.id and document->'cue'->>'status'='PLAYING';
      update vdj_internal.generation_operations set document=jsonb_set(document,'{cue}',
        document->'cue'||jsonb_build_object('status','PLAYING','playbackRevision',(reservation->>'expectedRevision')::bigint)) where id=target.id;
      update vdj_internal.generation_operations set document=jsonb_set(document,'{roomRuntime}',runtime,true) where id=anchor.id;
      return jsonb_build_object('accepted',true,'duplicate',false,'currentCredit',credit);
    end if;
    raise exception 'CUE_OPERATION_INVALID';
  end if;

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
