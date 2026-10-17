-- Private existing-function contract. No new grant, role or TTL.
-- Uses the existing room row for durable CAS, under its existing owner proof.
create or replace function vdj_internal.player_observer_state(
 action text, room_id uuid, capability text, expected_epoch uuid,
 expected_control bigint, expected_version bigint, document jsonb default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare r vdj_internal.rooms; saved jsonb; version bigint; playback jsonb; runtime_records jsonb;
 receipts jsonb; receipt_key text; prior_receipt jsonb; receipt_version bigint;
 observed_graph jsonb; observation jsonb; clock_ms double precision;
begin
 select * into r from vdj_internal.rooms where id=room_id for update;
 if not found or r.expires_at<=clock_timestamp() then raise exception 'ROOM_UNAVAILABLE'; end if;
 if capability is null or vdj_internal.proof(capability)<>r.owner_proof or not exists(
   select 1 from vdj_internal.owners where uid=r.owner_uid and enabled) then raise exception 'OWNER_DENIED'; end if;
 if expected_epoch is distinct from r.epoch or expected_control is distinct from r.control_revision then raise exception 'OBSERVER_SCOPE_CHANGED'; end if;
 saved:=r.operations->'__player_observer_v1';
 if saved->>'sessionId' is distinct from r.epoch::text or (saved->>'controlRevision')::bigint is distinct from r.control_revision then saved:=null; end if;
 version:=coalesce((saved->>'version')::bigint,0);
 if action in ('sourceReceiptRead','sourceReceiptPut') then
   -- Source-only ACKs are small immutable records, not media. Keep their
   -- durable write on the existing authenticated room transaction instead of
   -- several Storage HTTP round trips while the finite audio clock is running.
   if expected_version is not null or document is null or jsonb_typeof(document)<>'object' or
     octet_length(document::text)>16384 or coalesce(document->>'targetPlayerId','')!~'^[A-Za-z0-9_-]{1,100}$' or
     jsonb_typeof(document->'graphEpoch') is distinct from 'number' or
     coalesce(document->>'graphEpoch','')!~'^[0-9]{1,10}$' or (document->>'graphEpoch')::bigint<1
     then raise exception 'SOURCE_START_RECEIPT_KEY_REQUIRED'; end if;
   receipt_key:=expected_epoch::text||':'||expected_control::text||':'||
     (document->>'graphEpoch')||':'||(document->>'targetPlayerId');
   receipts:=coalesce(r.operations->'__source_start_receipts_v1',jsonb_build_object('version',0,'records','{}'::jsonb));
   if jsonb_typeof(receipts->'records') is distinct from 'object' then raise exception 'SOURCE_START_RECEIPT_STORE_REQUIRED'; end if;
   receipt_version:=coalesce((receipts->>'version')::bigint,0);
   prior_receipt:=receipts->'records'->receipt_key;
   if action='sourceReceiptRead' then
     if (document-'targetPlayerId'-'graphEpoch')<>'{}'::jsonb then raise exception 'SOURCE_START_RECEIPT_KEY_REQUIRED'; end if;
     return jsonb_build_object('version',receipt_version,'record',prior_receipt);
   end if;
   if document->>'roomId' is distinct from r.id::text or document->>'sessionId' is distinct from r.epoch::text or
     (document->>'controlRevision')::bigint is distinct from r.control_revision or
     document->>'kind' is distinct from 'immutable-source-start-receipt-v1' or
     document->'actual' is distinct from 'true'::jsonb or document->'sourceOnly' is distinct from 'true'::jsonb or
     document->'participantCredit' is distinct from 'false'::jsonb or
     jsonb_typeof(document->'ack') is distinct from 'object' or
     jsonb_typeof(document->'ack'->'playedUntilFrame') is distinct from 'number' or
     jsonb_typeof(document->'serverReceivedAtMs') is distinct from 'number' or
     document->'ack'->'actual' is distinct from 'true'::jsonb or
     document->'ack'->'audioStarted' is distinct from 'true'::jsonb or
     document->'ack'->'participantCredit' is distinct from 'false'::jsonb or
     document->'ack'->'graphEpoch' is distinct from document->'graphEpoch' or
     document->'ack'->>'sourceClipId' is distinct from document->>'sourceClipId' or
     document->'ack'->>'sourceSha256' is distinct from document->>'sourceSha256' or
     document->'ack'->>'sourceContextSha256' is distinct from document->>'sourceContextSha256' or
     document->'ack'->'sourcePlaybackRevision' is distinct from document->'sourcePlaybackRevision' or
     document->'ack'->>'processedWindowSha256' is distinct from document->>'processedWindowSha256' or
     coalesce(document->>'ackSha256','')!~'^[a-f0-9]{64}$' or
     coalesce(document->>'authoritySha256','')!~'^[a-f0-9]{64}$' or
     coalesce(document->>'receiptSha256','')!~'^[a-f0-9]{64}$'
     then raise exception 'IMMUTABLE_SOURCE_START_RECEIPT_REQUIRED'; end if;
   if prior_receipt is not null then
     if prior_receipt->>'ackSha256' is distinct from document->>'ackSha256' or
       prior_receipt->>'authoritySha256' is distinct from document->>'authoritySha256'
       then raise exception 'SOURCE_START_ACK_CONFLICT'; end if;
     return jsonb_build_object('version',receipt_version,'record',prior_receipt,'duplicate',true);
   end if;
   observed_graph:=saved->'record';observation:=observed_graph->'observation';
   playback:=public.vdj_generation_request('cueState',r.id,capability,'{}'::jsonb);
   clock_ms:=extract(epoch from clock_timestamp())*1000;
   if playback->'currentCredit' is distinct from 'null'::jsonb or
     observed_graph->'stopped' is distinct from 'false'::jsonb or
     jsonb_typeof(observed_graph->'graph'->'expiresAtMs') is distinct from 'number' or
     observed_graph->'graph'->>'targetPlayerId' is distinct from document->>'targetPlayerId' or
     observed_graph->'graph'->'graphEpoch' is distinct from document->'graphEpoch' or
     (observed_graph->'graph'->>'expiresAtMs')::double precision<=clock_ms or
     observed_graph->'binding'->>'kind' is distinct from 'source' or
     observed_graph->'binding'->>'assetId' is distinct from document->>'sourceClipId' or
     observed_graph->'binding'->>'sha256' is distinct from document->>'sourceSha256' or
     observed_graph->'binding'->>'contextSha256' is distinct from document->>'sourceContextSha256' or
     observed_graph->'binding'->'playbackRevision' is distinct from document->'sourcePlaybackRevision' or
     observation is null or observation='null'::jsonb or
     jsonb_typeof(observation->'serverObservedAtMs') is distinct from 'number' or
     jsonb_typeof(observation->'playedUntilFrame') is distinct from 'number' or
     observation->'receivedFrames' is distinct from document->'queuedPrefixFrames' or
     (observation->>'serverObservedAtMs')::double precision>clock_ms or
     clock_ms-(observation->>'serverObservedAtMs')::double precision>5000 or
     observation->>'initialWindowSha256' is distinct from document->>'processedWindowSha256' or
     (document->'ack'->>'playedUntilFrame')::bigint<256 or
     (document->'ack'->>'playedUntilFrame')::bigint>(observation->>'playedUntilFrame')::bigint or
     (observation->>'playedUntilFrame')::bigint>=1058400 or
     (document->>'serverReceivedAtMs')::double precision<(observed_graph->'graph'->>'selectedAtMs')::double precision or
     (document->>'serverReceivedAtMs')::double precision>clock_ms
     then raise exception 'SOURCE_START_RECEIPT_PHYSICAL_REQUIRED'; end if;
   if (select count(*) from jsonb_object_keys(receipts->'records'))>=128 then raise exception 'SOURCE_START_RECEIPT_LIMIT'; end if;
   receipts:=jsonb_set(receipts,array['records',receipt_key],document,true)||jsonb_build_object('version',receipt_version+1);
   update vdj_internal.rooms set operations=jsonb_set(operations,'{__source_start_receipts_v1}',receipts,true) where id=r.id;
   return jsonb_build_object('version',receipt_version+1,'record',document,'duplicate',false);
 end if;
 if action='read' then
   -- Same authenticated transaction: no completed Stop/scope snapshot is cached.
   playback:=public.vdj_generation_request('cueState',r.id,capability,'{}'::jsonb);
   select coalesce(jsonb_agg(item.value),'[]'::jsonb) into runtime_records from (
     select operation.document->'roomRuntime' as value from vdj_internal.generation_operations operation
       where operation.room_id=r.id and operation.document ? 'roomRuntime' order by operation.id limit 2
   ) item;
   if jsonb_array_length(runtime_records)>1 then raise exception 'AUTHORITATIVE_ROOM_RUNTIME_REQUIRED'; end if;
   return coalesce(saved,jsonb_build_object('version',0,'record',null))||jsonb_build_object(
     'scope',jsonb_build_object('roomId',r.id,'sessionId',r.epoch,'controlRevision',r.control_revision,
       'expiresAtMs',extract(epoch from r.expires_at)*1000),
    'playback',playback,'runtime',runtime_records->0,
    'stateFence',jsonb_build_object('scopeExpiresAtMs',extract(epoch from r.expires_at)*1000,
      'playbackSha256',encode(sha256(convert_to(playback::text,'UTF8')),'hex'),
      'runtimeSha256',encode(sha256(convert_to(coalesce(runtime_records->0,'null'::jsonb)::text,'UTF8')),'hex')));
 end if;
 if action<>'cas' or expected_version is distinct from version then raise exception 'OBSERVER_CAS_CONFLICT'; end if;
 -- The transient exact playback/runtime fence includes retained participant
 -- receipts and a pending Cue. It is checked but never saved in this record.
 -- Keep the persisted observation at64KiB and the whole request at256KiB.
 if document is null or jsonb_typeof(document)<>'object' or octet_length((document-'__observationFence')::text)>65536 or
   octet_length(document::text)>262144 or
   document->>'roomId' is distinct from r.id::text or document->>'sessionId' is distinct from r.epoch::text or
   (document->>'controlRevision')::bigint is distinct from r.control_revision then raise exception 'OBSERVER_DOCUMENT_INVALID'; end if;
 if document ? '__observationFence' then
   playback:=public.vdj_generation_request('cueState',r.id,capability,'{}'::jsonb);
   select coalesce(jsonb_agg(item.value),'[]'::jsonb) into runtime_records from (
     select operation.document->'roomRuntime' as value from vdj_internal.generation_operations operation
       where operation.room_id=r.id and operation.document ? 'roomRuntime' order by operation.id limit 2
   ) item;
   if jsonb_array_length(runtime_records)>1 or
     jsonb_typeof(document->'__observationFence') is distinct from 'object' or
     (document->'__observationFence'->>'scopeExpiresAtMs')::double precision is distinct from (extract(epoch from r.expires_at)*1000)::double precision
     then raise exception 'OBSERVER_PLAYBACK_CHANGED'; end if;
   if document->'__observationFence' ? 'playbackSha256' or document->'__observationFence' ? 'runtimeSha256' then
     -- Fingerprints are issued by the authenticated atomic read above and
     -- recomputed from the complete live JSONB in THIS locked transaction.
     -- No ACK history is truncated or replaced by a client claim.
     if ((document->'__observationFence')-'scopeExpiresAtMs'-'playbackSha256'-'runtimeSha256')<>'{}'::jsonb or
       coalesce(document->'__observationFence'->>'playbackSha256','')!~'^[a-f0-9]{64}$' or
       coalesce(document->'__observationFence'->>'runtimeSha256','')!~'^[a-f0-9]{64}$' or
       document->'__observationFence'->>'playbackSha256' is distinct from encode(sha256(convert_to(playback::text,'UTF8')),'hex') or
       document->'__observationFence'->>'runtimeSha256' is distinct from encode(sha256(convert_to(coalesce(runtime_records->0,'null'::jsonb)::text,'UTF8')),'hex')
       then raise exception 'OBSERVER_PLAYBACK_CHANGED'; end if;
   else
     -- Existing clients retain the original exact full-document comparison.
     if ((document->'__observationFence')-'scopeExpiresAtMs'-'playback'-'runtime')<>'{}'::jsonb or
       document->'__observationFence'->'playback' is distinct from playback or
       document->'__observationFence'->'runtime' is distinct from coalesce(runtime_records->0,'null'::jsonb)
       then raise exception 'OBSERVER_PLAYBACK_CHANGED'; end if;
   end if;
   document:=document-'__observationFence';
 end if;
 saved:=jsonb_build_object('sessionId',r.epoch,'controlRevision',r.control_revision,'version',version+1,'record',document);
 update vdj_internal.rooms set operations=jsonb_set(operations,'{__player_observer_v1}',saved,true) where id=r.id;
 return saved;
end $$;
revoke all on function vdj_internal.player_observer_state(text,uuid,text,uuid,bigint,bigint,jsonb) from public, anon, authenticated;
