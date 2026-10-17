-- PREPARED ONLY. After authenticated Stop and Edge broker disable.
-- Existing project only; preserve all business rows, private media and helpers.
revoke execute on function public.vdj_runtime_request(text,uuid,text,jsonb,jsonb) from service_role;
revoke execute on function vdj_internal.player_observer_state(text,uuid,text,uuid,bigint,bigint,jsonb) from service_role;
revoke execute on function vdj_internal.owner_operator_state(text,uuid,text,uuid,bigint,bigint,jsonb) from service_role;
revoke execute on function vdj_internal.owner_operator_permits(uuid,text,uuid,bigint,text,jsonb) from service_role;
revoke execute on function vdj_internal.vdj_scheduler_request(text,uuid,text,jsonb) from service_role;
revoke execute on function vdj_internal.vdj_scheduler_eligible(text,uuid) from service_role;
drop function public.vdj_runtime_request(text,uuid,text,jsonb,jsonb);
