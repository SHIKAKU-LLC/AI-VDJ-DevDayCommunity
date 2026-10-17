-- Supabase's automatic-RLS event trigger keeps its owner execution rights.
-- Browser roles must not invoke the generated SECURITY DEFINER helper via RPC.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
