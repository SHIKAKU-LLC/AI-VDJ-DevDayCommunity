-- 既存の予約を保持し、1曲と6映像の検証枠を追加する。
create table vdj_budget_reservations_flow (
 event_id text not null references vdj_events(id),
 room_id text not null references vdj_rooms(id),
 plan_id text not null,
 cents integer not null check(cents in (50,100,150,250,1500)),
 created_at_ms integer not null,
 primary key(event_id,plan_id)
);
insert into vdj_budget_reservations_flow select * from vdj_budget_reservations;
drop table vdj_budget_reservations;
alter table vdj_budget_reservations_flow rename to vdj_budget_reservations;
create index vdj_budget_room on vdj_budget_reservations(room_id);
create table if not exists vdj_stock_sources (
 room_id text primary key references vdj_rooms(id),
 event_id text not null references vdj_events(id),
 created_at_ms integer not null
);
-- 音楽5曲と映像30本、今回$75、以前と合わせた予約上限$110。
update vdj_events set maximum_rooms=6, maximum_cents=11000
where id='judge-staging' and enabled=1 and maximum_rooms=5 and maximum_cents=3500;
