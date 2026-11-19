-- Faster boards. The friends board used to scan every profile and check the friendship of each
-- one; it now starts from your friendships (indexed both ways). The global board and your rank
-- read only opted-in players, through a partial index. Same results, same rules (see the
-- ranked tests in supabase/tests/rls.test.mjs).

create index if not exists profiles_in_global on public.profiles (id) where show_in_global;
create index if not exists daily_points_day on public.daily_points (day, user_id);

create or replace function public.leaderboard(p_scope text, p_month date default null)
returns table (rank bigint, user_id uuid, display_name text, avatar_icon smallint, avatar_color smallint, points bigint, me boolean)
language sql stable security definer set search_path = ''
as $$
  with s as (select public.season_start(p_month) as start),
  ids as (
    -- You and your accepted friends who haven't blocked you (or been blocked).
    select auth.uid() as id where p_scope = 'friends' and auth.uid() is not null
    union
    select case when f.requester = auth.uid() then f.addressee else f.requester end
    from public.friendships f
    where p_scope = 'friends' and f.status = 'accepted' and auth.uid() in (f.requester, f.addressee)
      and not public.is_blocked(f.requester, f.addressee)
    union
    -- Opted-in players, minus blocks.
    select p.id from public.profiles p
    where p_scope = 'global' and auth.uid() is not null and p.show_in_global
      and not public.is_blocked(auth.uid(), p.id)
  ),
  totals as (
    select p.id, p.display_name, p.avatar_icon, p.avatar_color, coalesce(sum(d.points), 0)::bigint as points
    from ids
    join public.profiles p on p.id = ids.id
    left join public.daily_points d
      on d.user_id = p.id and d.day >= (select start from s) and d.day < ((select start from s) + interval '1 month')::date
    group by p.id, p.display_name, p.avatar_icon, p.avatar_color
  )
  select rank() over (order by t.points desc), t.id, t.display_name, t.avatar_icon, t.avatar_color, t.points, t.id = auth.uid()
  from totals t
  where p_scope = 'friends' or t.points > 0
  order by t.points desc, t.display_name, t.id
  limit 100
$$;

revoke all on function public.leaderboard(text, date) from public, anon, authenticated;
grant execute on function public.leaderboard(text, date) to authenticated;
