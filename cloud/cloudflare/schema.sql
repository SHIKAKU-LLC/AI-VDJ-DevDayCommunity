-- Preparation only. Apply to a new dedicated D1 database after approval.
-- No event, owner, external credential or media is inserted by this schema.
create table vdj_events (
 id text primary key,
 enabled integer not null default 0 check(enabled in (0,1)),
 expires_at_ms integer not null,
 maximum_rooms integer not null check(maximum_rooms between 1 and 100),
 maximum_cents integer not null check(maximum_cents between 50 and 37500)
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
 cents integer not null check(cents in (50,100,150,250,400,1500)),
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

-- Only operators can insert explicitly approved shared presets. Audience
-- uploads remain room-private, even when their room supplies ordinary stock.
create table if not exists vdj_curated_scenes (
 event_id text not null references vdj_events(id),
 sha256 text not null check(length(sha256)=64 and sha256 not glob '*[^a-f0-9]*'),
 byte_length integer not null check(byte_length between 1 and 16777216),
 duration integer not null check(duration=12),
 width integer not null check(width=1920),
 height integer not null check(height in (1080,1088)),
 enabled integer not null default 1 check(enabled in (0,1)),
 created_at_ms integer not null,
 primary key(event_id,sha256)
);

-- 投稿と操作の履歴をルーム本文から分離する。既存記録と費用予約は保持する。
create table if not exists vdj_submissions (
 room_id text not null references vdj_rooms(id),
 submission_id text not null,
 participant_id text not null,
 created_at_ms integer not null,
 document text not null check(json_valid(document)),
 primary key(room_id,submission_id)
);
create index if not exists vdj_submissions_order on vdj_submissions(room_id,created_at_ms,submission_id);
create table if not exists vdj_operations (
 room_id text not null references vdj_rooms(id),
 operation_key text not null,
 actor text not null,
 at_ms integer not null,
 document text not null check(json_valid(document)),
 primary key(room_id,operation_key)
);
create table if not exists vdj_curated_audio (
 event_id text not null references vdj_events(id),
 video_sha256 text not null,
 sha256 text not null check(length(sha256)=64 and sha256 not glob '*[^a-f0-9]*'),
 byte_length integer not null check(byte_length between 1 and 12582912),
 duration integer not null check(duration=12),
 enabled integer not null default 1 check(enabled in (0,1)),
 created_at_ms integer not null,
 primary key(event_id,video_sha256)
);

create table if not exists vdj_preset_batches (
 event_id text not null references vdj_events(id),
 batch_id text not null,
 room_id text not null references vdj_rooms(id),
 enabled integer not null default 0 check(enabled in (0,1)),
 document text not null check(json_valid(document)),
 primary key(event_id,batch_id)
);
