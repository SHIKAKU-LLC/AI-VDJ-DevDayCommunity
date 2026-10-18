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
insert or ignore into vdj_submissions
 select r.id,json_extract(s.value,'$.submissionId'),json_extract(s.value,'$.participantId'),0,s.value
 from vdj_rooms r,json_each(r.document,'$.submissions') s;
insert or ignore into vdj_operations
 select r.id,o.key,json_extract(o.value,'$.actor'),json_extract(o.value,'$.atMs'),o.value
 from vdj_rooms r,json_each(r.document,'$.operations') o;
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
-- 音楽38本の予約は$4を一括予約する（既存予約の金額は変更しない）。
pragma defer_foreign_keys = on;
create table vdj_budget_reservations_audience (
 event_id text not null references vdj_events(id),
 room_id text not null references vdj_rooms(id),
 plan_id text not null,
 cents integer not null check(cents in (50,100,150,250,400,1500)),
 created_at_ms integer not null,
 primary key(event_id,plan_id)
);
insert into vdj_budget_reservations_audience select * from vdj_budget_reservations;
drop table vdj_budget_reservations;
alter table vdj_budget_reservations_audience rename to vdj_budget_reservations;
create index vdj_budget_room on vdj_budget_reservations(room_id);
pragma foreign_key_check;
pragma defer_foreign_keys = off;

create table if not exists vdj_preset_batches (
 event_id text not null references vdj_events(id),
 batch_id text not null,
 room_id text not null references vdj_rooms(id),
 enabled integer not null default 0 check(enabled in (0,1)),
 document text not null check(json_valid(document)),
 primary key(event_id,batch_id)
);
