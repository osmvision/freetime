-- Instant messages and invites: publish the two tables to Supabase Realtime.
--
-- Realtime applies each table's Row Level Security to every subscriber, using their sign-in
-- token: a member only receives messages of their own conversations, and only invites they sent
-- or got. Nothing else is published.

do $$
begin
  -- The publication exists on Supabase (and not in the local test database).
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
      alter publication supabase_realtime add table public.messages;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'invites') then
      alter publication supabase_realtime add table public.invites;
    end if;
  end if;
end
$$;
