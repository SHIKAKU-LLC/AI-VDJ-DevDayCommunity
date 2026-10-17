-- Prepared collect-only schema. Not applied to a hosted project yet.
-- Apply ONLY to the dedicated AI VDJ project after its Free quote is verified.
create schema if not exists vdj_internal;
revoke all on schema vdj_internal from public, anon, authenticated;
grant usage on schema vdj_internal to service_role;

create table vdj_internal.owners (
  uid uuid primary key, enabled boolean not null default true,
  email_proof text unique, otp_attempts timestamptz[] not null default '{}',
  verify_attempts timestamptz[] not null default '{}'
);
create table vdj_internal.rooms (
  id uuid primary key, owner_uid uuid not null references vdj_internal.owners(uid),
  epoch uuid not null, owner_proof text not null, join_proof text not null,
  expires_at timestamptz not null, revision bigint not null default 0,
  control_revision bigint not null default 0,
  accepting boolean not null default true,
  participants jsonb not null default '[]', submissions jsonb not null default '[]',
  operations jsonb not null default '{}'
);
alter table vdj_internal.owners enable row level security;
alter table vdj_internal.rooms enable row level security;
revoke all on all tables in schema vdj_internal from public, anon, authenticated;
grant select, update on vdj_internal.owners to service_role;
grant select, insert, update, delete on vdj_internal.rooms to service_role;

create function vdj_internal.proof(v text) returns text
language sql immutable strict security invoker set search_path = ''
as $$select encode(sha256(convert_to(v,'UTF8')), 'hex')$$;

create function vdj_internal.snapshot(r vdj_internal.rooms, actor text) returns jsonb
language sql stable security invoker set search_path = ''
as $$select jsonb_build_object(
  'roomId', r.id, 'sessionId', r.epoch, 'eventSeq', r.revision, 'controlRevision', r.control_revision,
  'closed', r.expires_at <= now(), 'accepting', r.accepting,
  'generationPaused', true, 'autoDJ', false, 'mode', 'collect',
  'cues', '[]'::jsonb, 'currentCredit', null, 'playbackAdapterAvailable', false,
  'submissions', coalesce((select jsonb_agg(s.value) from jsonb_array_elements(r.submissions) s
    where actor='owner' or s.value->>'participantId'=actor), '[]'::jsonb))$$;

-- Only the Edge server's platform credential can invoke this RPC. The browser
-- cannot supply verified_uid directly. Every room operation verifies a proof.
create function public.vdj_room_request(
  op text, room_id uuid default null, capability text default null,
  payload jsonb default '{}', verified_uid uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r vdj_internal.rooms; actor text; p jsonb; s jsonb; rec jsonb;
  nonce text; opkey text; canonical text; participant_id uuid;
  invitation text; owner_cap text; result jsonb; nickname text; prompt text;
  configured_owner vdj_internal.owners; attempt_times timestamptz[];
begin
  if op='ownerCheck' then
    return to_jsonb(exists(select 1 from vdj_internal.owners where uid=verified_uid and enabled));
  end if;
  if op in ('otpCheck','otpPermit','otpVerifyPermit') then
    select * into configured_owner from vdj_internal.owners
      where email_proof=payload->>'emailProof' and enabled for update;
    if not found then return 'false'::jsonb; end if;
    if op='otpCheck' then return 'true'::jsonb; end if;
    if op='otpVerifyPermit' then
      select coalesce(array_agg(t),'{}') into attempt_times from unnest(configured_owner.verify_attempts) t
        where t>now()-interval '10 minutes';
      if cardinality(attempt_times)>=6 then return 'false'::jsonb; end if;
      update vdj_internal.owners set verify_attempts=attempt_times||now() where uid=configured_owner.uid;
      return 'true'::jsonb;
    end if;
    select coalesce(array_agg(t),'{}') into attempt_times from unnest(configured_owner.otp_attempts) t
      where t>now()-interval '1 hour';
    if cardinality(attempt_times)>=2 then return 'false'::jsonb; end if;
    update vdj_internal.owners set otp_attempts=attempt_times||now() where uid=configured_owner.uid;
    return 'true'::jsonb;
  end if;
  if op in ('create','recoverOwner') then
    if not exists(select 1 from vdj_internal.owners where uid=verified_uid and enabled) then
      raise exception 'OWNER_DENIED';
    end if;
    -- Serializes create across instances, including the absent-row case.
    perform pg_advisory_xact_lock(hashtextextended(verified_uid::text,0));
    if op='create' and exists(select 1 from vdj_internal.rooms where owner_uid=verified_uid and expires_at>now()) then
      raise exception 'ROOM_ALREADY_ACTIVE';
    end if;
    -- Starting/recovering a room must not discard expired rooms or their posts.
    -- Expiry remains enforced below; retained records do not extend access.
    owner_cap := payload->>'ownerCapability'; invitation := payload->>'joinCode';
    if owner_cap !~ '^[a-f0-9]{64}$' or invitation !~ '^[a-f0-9]{64}$'
       or owner_cap is null or invitation is null then raise exception 'CAPABILITY_INVALID'; end if;
    if op='recoverOwner' then
      select * into r from vdj_internal.rooms where owner_uid=verified_uid and expires_at>now() for update;
      if not found then raise exception 'ROOM_NOT_FOUND'; end if;
      update vdj_internal.rooms set owner_proof=vdj_internal.proof(owner_cap),join_proof=vdj_internal.proof(invitation),
        revision=revision+1 where id=r.id returning * into r;
      return vdj_internal.snapshot(r,'owner') || jsonb_build_object('ownerToken',owner_cap,'joinCode',invitation);
    end if;
    insert into vdj_internal.rooms(id,owner_uid,epoch,owner_proof,join_proof,expires_at)
      values(gen_random_uuid(),verified_uid,gen_random_uuid(),vdj_internal.proof(owner_cap),
        vdj_internal.proof(invitation), now()+interval '4 hours') returning * into r;
    return vdj_internal.snapshot(r,'owner') || jsonb_build_object('ownerToken',owner_cap,'joinCode',invitation);
  end if;

  -- Row lock makes proof checks, admission caps, nonce, revision, and writes atomic.
  select * into r from vdj_internal.rooms where id=room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if r.expires_at<=now() then raise exception 'ROOM_EXPIRED'; end if;
  if op in ('joinInfo','join') then
    if capability is null or vdj_internal.proof(capability)<>r.join_proof then raise exception 'INVITE_DENIED'; end if;
    if not r.accepting then raise exception 'ACCEPTANCE_OFF'; end if;
    if op='joinInfo' then
      return vdj_internal.snapshot(r,'invited') - 'submissions';
    end if;
    if jsonb_array_length(r.participants)>=5 then raise exception 'PARTICIPANT_CAP'; end if;
    nickname:=payload->>'nickname';
    if nickname is null or length(nickname) not between 1 and 40 or nickname<>normalize(nickname,NFKC)
      or nickname~'[[:cntrl:]]' then raise exception 'NICKNAME_INVALID'; end if;
    if (payload->>'participantCapability') is null or (payload->>'participantCapability') !~ '^[a-f0-9]{64}$'
      then raise exception 'CAPABILITY_INVALID'; end if;
    participant_id:=gen_random_uuid();
    p:=jsonb_build_object('id',participant_id,'nickname',nickname,'proof',
      vdj_internal.proof(payload->>'participantCapability'));
    update vdj_internal.rooms set participants=participants||jsonb_build_array(p),revision=revision+1
      where id=r.id;
    return jsonb_build_object('roomId',r.id,'participantId',participant_id,
      'participantToken',payload->>'participantCapability');
  end if;

  if capability is null then raise exception 'ACTOR_DENIED'; end if;
  if vdj_internal.proof(capability)=r.owner_proof and exists(
      select 1 from vdj_internal.owners where uid=r.owner_uid and enabled) then
    actor:='owner';
  else
    select value into p from jsonb_array_elements(r.participants)
      where value->>'proof'=vdj_internal.proof(capability);
    if p is null then raise exception 'ACTOR_DENIED'; end if;
    actor:=p->>'id';
  end if;
  if op='read' then return vdj_internal.snapshot(r,actor); end if;
  if op='submission' then
    select value into s from jsonb_array_elements(r.submissions)
      where value->>'submissionId'=payload->>'submissionId'
      and (actor='owner' or value->>'participantId'=actor);
    if s is null then raise exception 'OPERATION_NOT_FOUND'; end if;
    return s;
  end if;
  -- All feed reads return an actor-filtered snapshot. No private event payloads.
  if op='events' then return jsonb_build_object('eventSeq',r.revision,'events','[]'::jsonb,
    'snapshot',vdj_internal.snapshot(r,actor)); end if;

  nonce:=payload->>'nonce';
  if nonce is null or nonce !~ '^[A-Za-z0-9_-]{20,100}$' then raise exception 'NONCE_INVALID'; end if;
  opkey:=actor||':'||nonce;
  rec:=r.operations->opkey;
  if op='operation' then
    if rec is null then raise exception 'OPERATION_NOT_FOUND'; end if;
    return jsonb_build_object('kind',rec->>'kind','nonce',nonce,'receipt',rec->'receipt');
  end if;
  if op not in ('submit','control') then raise exception 'ROUTE_NOT_FOUND'; end if;
  canonical:=vdj_internal.proof(op||':'||payload::text);
  if rec is not null then
    if rec->>'fingerprint'<>canonical then raise exception 'NONCE_CONFLICT'; end if;
    return rec->'receipt';
  end if;
  if (select count(*) from jsonb_each(r.operations))>=120 then raise exception 'ROOM_OPERATION_CAP'; end if;
  -- Durable actor burst limit. Retries with the same nonce are checked first.
  if (select count(*) from jsonb_each(r.operations) t
      where t.value->>'actor'=actor and (t.value->>'at')::timestamptz>now()-interval '1 minute')>=6
    then raise exception 'RATE_LIMITED'; end if;

  if op='control' then
    if actor<>'owner' then raise exception 'OWNER_DENIED'; end if;
    if not (payload ?| array['accepting','generationPaused','autoDJ']) then raise exception 'CONTROL_INVALID'; end if;
    if (payload->>'expectedRevision') is null or (payload->>'expectedRevision')::bigint<>r.control_revision
      then raise exception 'REVISION_CONFLICT'; end if;
    if payload ? 'autoDJ' and payload->'autoDJ'<>'false'::jsonb then raise exception 'PROVIDER_NOT_CONNECTED'; end if;
    if payload ? 'generationPaused' and payload->'generationPaused'<>'true'::jsonb
      then raise exception 'PROVIDER_NOT_CONNECTED'; end if;
    if payload ? 'accepting' and jsonb_typeof(payload->'accepting')<>'boolean' then raise exception 'CONTROL_INVALID'; end if;
    update vdj_internal.rooms set accepting=coalesce((payload->>'accepting')::boolean,accepting),
      revision=revision+1,control_revision=control_revision+1 where id=r.id returning * into r;
    result:=jsonb_build_object('kind','owner-control','nonce',nonce,'controlRevision',r.control_revision,
      'accepting',r.accepting,'generationPaused',true,'autoDJ',false);
  else
    if actor<>'owner' and not r.accepting then raise exception 'ACCEPTANCE_OFF'; end if;
    if jsonb_array_length(r.submissions)>=100 then raise exception 'SUBMISSION_CAP'; end if;
    nickname:=case when actor='owner' then payload->>'nickname' else p->>'nickname' end;
    prompt:=payload->>'prompt';
    if nickname is null or length(nickname) not between 1 and 40 or nickname<>normalize(nickname,NFKC)
      or nickname~'[[:cntrl:]]' then raise exception 'NICKNAME_INVALID'; end if;
    if prompt is null or length(prompt) not between 1 and 2000 or prompt<>normalize(prompt,NFKC)
      or prompt~'[[:cntrl:]]' then raise exception 'PROMPT_INVALID'; end if;
    s:=jsonb_build_object('roomId',r.id,'sessionId',r.epoch,'nonce',nonce,
      'submissionId',gen_random_uuid(),'participantId',case when actor='owner' then 'owner' else actor end,
      'nickname',nickname,'prompt',prompt,'state','QUEUED','reason','PROVIDER_NOT_CONNECTED',
      'jobs','[]'::jsonb,'mode','collect');
    update vdj_internal.rooms set submissions=submissions||jsonb_build_array(s),revision=revision+1
      where id=r.id returning * into r;
    result:=s||jsonb_build_object('kind','submission');
  end if;
  update vdj_internal.rooms set operations=operations||jsonb_build_object(opkey,
    jsonb_build_object('actor',actor,'at',now(),'fingerprint',canonical,
      'kind',case when op='control' then 'owner-control' else 'submission' end,'receipt',result)) where id=r.id;
  return result;
end $$;

revoke all on all functions in schema vdj_internal from public, anon, authenticated;
grant execute on all functions in schema vdj_internal to service_role;
revoke all on function public.vdj_room_request(text,uuid,text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.vdj_room_request(text,uuid,text,jsonb,uuid) to service_role;
