-- Dedicated temporary-public admission. Existing email-owner rules are unchanged.
-- Install separately from activating an event. No event is enabled by this file.
create table vdj_internal.judge_events (
 id text primary key, enabled boolean not null default false,
 expires_at timestamptz not null, maximum_rooms integer not null check (maximum_rooms between 1 and 100),
 maximum_cents integer not null check (maximum_cents between 1 and 20000)
);
create table vdj_internal.judge_rooms (
 event_id text not null references vdj_internal.judge_events(id), nonce uuid not null,
 room_id uuid not null unique references vdj_internal.rooms(id),
 primary key(event_id,nonce)
);
create table vdj_internal.judge_reservations (
 event_id text not null references vdj_internal.judge_events(id),
 room_id uuid not null references vdj_internal.judge_rooms(room_id), plan_id text not null,
 cents integer not null check (cents in (50,100,250)), created_at timestamptz not null default now(),
 primary key(event_id,plan_id)
);
alter table vdj_internal.judge_events enable row level security;
alter table vdj_internal.judge_rooms enable row level security;
alter table vdj_internal.judge_reservations enable row level security;
revoke all on vdj_internal.judge_events,vdj_internal.judge_rooms,vdj_internal.judge_reservations from public,anon,authenticated;
grant select,insert,update on vdj_internal.judge_events,vdj_internal.judge_rooms,vdj_internal.judge_reservations to service_role;
grant insert on vdj_internal.owners to service_role;

create function public.vdj_judge_request(p_action text,p_event_id text,p_room_id uuid default null,
 p_capability text default null,p_payload jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare e vdj_internal.judge_events; r vdj_internal.rooms; j vdj_internal.judge_rooms;
 n uuid; owner_id uuid; invitation text; amount integer; used integer;
 prior vdj_internal.judge_reservations;
begin
 select * into e from vdj_internal.judge_events v where v.id=p_event_id for update;
 if not found or not e.enabled or e.expires_at<=now() then raise exception 'JUDGE_CLOSED'; end if;
 if p_action='create' then
  n:=(p_payload->>'nonce')::uuid; invitation:=p_payload->>'joinCode';
  if p_capability is null or p_capability !~ '^[a-f0-9]{64}$' or invitation is null or invitation !~ '^[a-f0-9]{64}$' then raise exception 'JUDGE_DENIED'; end if;
  select * into j from vdj_internal.judge_rooms v where v.event_id=e.id and v.nonce=n;
  if found then
   select * into r from vdj_internal.rooms v where v.id=j.room_id;
   if r.owner_proof<>vdj_internal.proof(p_capability) or r.join_proof<>vdj_internal.proof(invitation) then raise exception 'JUDGE_DENIED'; end if;
  else
   if (select count(*) from vdj_internal.judge_rooms v where v.event_id=e.id)>=e.maximum_rooms then raise exception 'JUDGE_CAPACITY'; end if;
   owner_id:=gen_random_uuid();
   insert into vdj_internal.owners(uid,enabled) values(owner_id,true);
   insert into vdj_internal.rooms(id,owner_uid,epoch,owner_proof,join_proof,expires_at)
    values(gen_random_uuid(),owner_id,gen_random_uuid(),vdj_internal.proof(p_capability),vdj_internal.proof(invitation),least(e.expires_at,now()+interval '4 hours')) returning * into r;
   insert into vdj_internal.judge_rooms values(e.id,n,r.id);
  end if;
  return vdj_internal.snapshot(r,'owner')||jsonb_build_object('ownerToken',p_capability,'joinCode',invitation);
 end if;
 select v.* into r from vdj_internal.rooms v join vdj_internal.judge_rooms q on q.room_id=v.id
  where q.event_id=e.id and v.id=p_room_id;
 if not found or r.expires_at<=now() or p_capability is null or r.owner_proof<>vdj_internal.proof(p_capability) then raise exception 'JUDGE_DENIED'; end if;
 if p_action='authorize' then return jsonb_build_object('roomId',r.id,'expiresAtMs',floor(extract(epoch from r.expires_at)*1000)); end if;
 if p_action='reserve' then
  amount:=(p_payload->>'cents')::integer;
  if amount is null or amount not in (50,100,250) or coalesce(p_payload->>'planId','') !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'JUDGE_DENIED'; end if;
  select * into prior from vdj_internal.judge_reservations v where v.event_id=e.id and v.plan_id=p_payload->>'planId';
  if found then
   if prior.room_id<>r.id or prior.cents<>amount then raise exception 'JUDGE_DENIED'; end if;
   return jsonb_build_object('reserved',true);
  end if;
  select coalesce(sum(v.cents),0) into used from vdj_internal.judge_reservations v where v.event_id=e.id;
  if used+amount>e.maximum_cents or (select coalesce(sum(v.cents),0) from vdj_internal.judge_reservations v where v.room_id=r.id)+amount>250 then raise exception 'JUDGE_BUDGET'; end if;
  insert into vdj_internal.judge_reservations(event_id,room_id,plan_id,cents) values(e.id,r.id,p_payload->>'planId',amount);
  return jsonb_build_object('reserved',true);
 end if;
 raise exception 'JUDGE_DENIED';
end;
$$;
revoke all on function public.vdj_judge_request(text,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.vdj_judge_request(text,text,uuid,text,jsonb) to service_role;
