-- LOCAL TESTING ONLY: mimic Supabase's default table grants (RLS still applies)
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
