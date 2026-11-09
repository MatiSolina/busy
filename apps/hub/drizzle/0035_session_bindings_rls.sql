-- 0026 created bot_session_openings and bot_sessions without the RLS/privilege lockdown every other hub
-- table has: Supabase's anon/authenticated roles got full access through the data API. Only the
-- hub's server-side connection uses these tables. Idempotent.
ALTER TABLE public.bot_session_openings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_session_openings FROM PUBLIC, anon, authenticated;
ALTER TABLE public.bot_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_sessions FROM PUBLIC, anon, authenticated;
