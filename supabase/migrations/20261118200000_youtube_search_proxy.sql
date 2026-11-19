-- YouTube search proxy (Edge Function `youtube-search`): the app searches YouTube without a key
-- of its own. The YouTube Data API key stays a function secret.
--
-- Two things protect the shared quota (10,000 units a day, 100 per search):
-- - a cache shared by everyone: each topic is searched at most once every few hours,
-- - a daily cap on real searches, counted on Google's quota day (midnight, Pacific time).
--
-- Both tables live in a schema the Data API doesn't expose. Only the Edge Function (service
-- role) can call the three functions below: signed-in or signed-out users can't touch them.

create schema if not exists private;

create table if not exists private.youtube_searches (
  query text primary key check (char_length(query) between 1 and 60),
  items jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists private.youtube_quota (
  day date primary key,
  searches integer not null default 0
);

alter table private.youtube_searches enable row level security;
alter table private.youtube_quota enable row level security;

-- The cached results for a topic (fresh or not: a stale copy beats nothing once the cap is hit).
create or replace function public.youtube_cache_get(q text)
returns table (items jsonb, fetched_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select s.items, s.fetched_at from private.youtube_searches s where s.query = q;
$$;

create or replace function public.youtube_cache_put(q text, found jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.youtube_searches (query, items, fetched_at)
  values (q, found, now())
  on conflict (query) do update set items = excluded.items, fetched_at = excluded.fetched_at;
$$;

-- Takes one search from today's allowance. False once `daily_cap` searches were made today.
create or replace function public.youtube_take_search(daily_cap integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'America/Los_Angeles')::date;
  used integer;
begin
  insert into private.youtube_quota (day, searches) values (today, 1)
  on conflict (day) do update set searches = private.youtube_quota.searches + 1
  where private.youtube_quota.searches < daily_cap
  returning searches into used;
  -- Old days are of no use.
  delete from private.youtube_quota where day < today - 7;
  return used is not null;
end;
$$;

revoke all on function public.youtube_cache_get(text) from public, anon, authenticated;
revoke all on function public.youtube_cache_put(text, jsonb) from public, anon, authenticated;
revoke all on function public.youtube_take_search(integer) from public, anon, authenticated;
grant execute on function public.youtube_cache_get(text) to service_role;
grant execute on function public.youtube_cache_put(text, jsonb) to service_role;
grant execute on function public.youtube_take_search(integer) to service_role;
