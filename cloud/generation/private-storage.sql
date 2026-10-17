-- Prepared only. Apply together with the reviewed cue RPC upgrade after approval.
-- Empty private bucket; no object upload, deletion or browser grants here.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('ai-vdj-private','ai-vdj-private',false,33554432,
  array['audio/wav','video/mp4','image/png','image/jpeg','application/json'])
on conflict(id) do nothing;

do $$ begin
  if not exists(select 1 from storage.buckets where id='ai-vdj-private' and name='ai-vdj-private'
    and public=false and file_size_limit=33554432
    and allowed_mime_types=array['audio/wav','video/mp4','image/png','image/jpeg','application/json']) then
    raise exception 'PRIVATE_BUCKET_CONFIGURATION_MISMATCH';
  end if;
end $$;
