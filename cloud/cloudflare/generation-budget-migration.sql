-- Apply once to the existing staging database after approval.
-- Preserve reservations while allowing the approved $1.50 per-set ceiling.
create table vdj_budget_reservations_150 (
 event_id text not null references vdj_events(id),
 room_id text not null references vdj_rooms(id),
 plan_id text not null,
 cents integer not null check(cents in (50,100,150,250)),
 created_at_ms integer not null,
 primary key(event_id,plan_id)
);
insert into vdj_budget_reservations_150 select * from vdj_budget_reservations;
drop table vdj_budget_reservations;
alter table vdj_budget_reservations_150 rename to vdj_budget_reservations;
create index vdj_budget_room on vdj_budget_reservations(room_id);
update vdj_events set maximum_cents=750 where id='judge-staging';
