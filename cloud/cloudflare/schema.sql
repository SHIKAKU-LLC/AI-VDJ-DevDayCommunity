-- Preparation only. Apply to a new dedicated D1 database after approval.
-- No event, owner, external credential or media is inserted by this schema.
create table vdj_events (
 id text primary key,
 enabled integer not null default 0 check(enabled in (0,1)),
 expires_at_ms integer not null,
 maximum_rooms integer not null check(maximum_rooms between 1 and 100),
 maximum_cents integer not null check(maximum_cents between 50 and 20000)
);
create table vdj_rooms (
 id text primary key,
 event_id text not null references vdj_events(id),
 nonce text not null,
 epoch text not null,
 owner_proof text not null,
 join_proof text not null,
 expires_at_ms integer not null,
 version integer not null default 0,
 document text not null check(json_valid(document)),
 unique(event_id,nonce)
);
create index vdj_rooms_event on vdj_rooms(event_id);
create table vdj_budget_reservations (
 event_id text not null references vdj_events(id),
 room_id text not null references vdj_rooms(id),
 plan_id text not null,
 cents integer not null check(cents in (50,100,150,250,1500)),
 created_at_ms integer not null,
 primary key(event_id,plan_id)
);
create index vdj_budget_room on vdj_budget_reservations(room_id);
create table vdj_runtime_records (
 room_id text not null references vdj_rooms(id),
 kind text not null,
 record_id text not null,
 version integer not null,
 document text not null check(json_valid(document)),
 primary key(room_id,kind,record_id)
);

create table if not exists vdj_stock_sources (
 room_id text primary key references vdj_rooms(id),
 event_id text not null references vdj_events(id),
 created_at_ms integer not null
);
