-- Add an operator-only per-asset allowlist; do not promote audience uploads.
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
