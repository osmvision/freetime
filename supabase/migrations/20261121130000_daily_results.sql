-- Friends' times on the games of the day (Path, Zones, Guess the activity, the problem of the day).
--
-- Opt-in: a result is sent only by players who switched "Show my times to my friends" on, and only
-- their friends see it (never across a block). One result per game and day, the first one. Kept 30
-- days, part of "Export my data", deleted with the account; switching off deletes them all.
-- The puzzles are the same for everyone, so a time says nothing private beyond "played today".

create table public.daily_results (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('path', 'zones', 'guess', 'problem')),
  secs integer not null check (secs between 0 and 86400),
  score integer check (score between 0 and 50),
  created_at timestamptz not null default now(),
  primary key (user_id, day, kind)
);

alter table public.daily_results enable row level security;

create policy "see your own daily results" on public.daily_results
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.daily_results from anon, authenticated;
grant select on public.daily_results to authenticated;

-- Shares one result of today (the day is the player's own date: yesterday to tomorrow in UTC).
create function public.share_daily_result(p_day date, p_kind text, p_secs integer, p_score integer default null) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_day is null or p_day < current_date - 1 or p_day > current_date + 1 then
    raise exception 'only today''s results' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('path', 'zones', 'guess', 'problem') then
    raise exception 'unknown game' using errcode = '22023';
  end if;
  if p_secs is null or p_secs < 0 or p_secs > 86400 or (p_score is not null and (p_score < 0 or p_score > 50)) then
    raise exception 'that result can''t be right' using errcode = '22023';
  end if;
  delete from public.daily_results where user_id = me and day < current_date - 30;
  insert into public.daily_results (user_id, day, kind, secs, score)
  values (me, p_day, p_kind, p_secs, p_score)
  on conflict (user_id, day, kind) do nothing;
end
$$;

-- Stops sharing: every result you sent is deleted.
create function public.stop_sharing_daily_results() returns void
language sql volatile security definer set search_path = ''
as $$
  delete from public.daily_results where user_id = (select auth.uid());
$$;

-- Your friends' results of one day, and yours: only those who shared, never across a block.
create function public.friends_daily_results(p_day date) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  return (
    with people as (
      select me as id
      union
      select f.addressee from public.friendships f where f.status = 'accepted' and f.requester = me
      union
      select f.requester from public.friendships f where f.status = 'accepted' and f.addressee = me
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', r.kind, 'secs', r.secs, 'score', r.score,
        'user_id', p.id, 'display_name', p.display_name, 'avatar_icon', p.avatar_icon, 'avatar_color', p.avatar_color,
        'me', p.id = me
      ) order by r.kind, r.score desc nulls last, r.secs, p.display_name), '[]'::jsonb)
    from people x
    join public.daily_results r on r.user_id = x.id and r.day = p_day
    join public.profiles p on p.id = r.user_id
    where x.id = me or not public.is_blocked(me, x.id)
  );
end
$$;

revoke all on function public.share_daily_result(date, text, integer, integer) from public, anon, authenticated;
revoke all on function public.stop_sharing_daily_results() from public, anon, authenticated;
revoke all on function public.friends_daily_results(date) from public, anon, authenticated;
grant execute on function public.share_daily_result(date, text, integer, integer) to authenticated;
grant execute on function public.stop_sharing_daily_results() to authenticated;
grant execute on function public.friends_daily_results(date) to authenticated;

-- ---------------------------------------------------------------- export

alter function public.export_my_data() rename to export_my_data_before_daily_results;
alter function public.export_my_data_before_daily_results() set schema private;

create function public.export_my_data() returns jsonb
language sql stable security invoker set search_path = ''
return private.export_my_data_before_daily_results() || jsonb_build_object('daily_results', (
  select coalesce(jsonb_agg(jsonb_build_object('day', r.day, 'kind', r.kind, 'secs', r.secs, 'score', r.score) order by r.day, r.kind), '[]'::jsonb)
  from public.daily_results r
  where r.user_id = (select auth.uid())
));
revoke all on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
