-- 同一トランザクションで実行し、既存の受付条件・参照関係を保持する。
-- この変更だけではイベントの予算を増やさない。承認済みイベントを別途更新する。
-- https://developers.cloudflare.com/d1/sql-api/foreign-keys/
pragma defer_foreign_keys = on;
create table vdj_events_capacity (
 id text primary key,
 enabled integer not null default 0 check(enabled in (0,1)),
 expires_at_ms integer not null,
 maximum_rooms integer not null check(maximum_rooms between 1 and 100),
 maximum_cents integer not null check(maximum_cents between 50 and 37500)
);
insert into vdj_events_capacity select id,enabled,expires_at_ms,maximum_rooms,maximum_cents from vdj_events;
drop table vdj_events;
alter table vdj_events_capacity rename to vdj_events;
pragma foreign_key_check;
pragma defer_foreign_keys = off;
