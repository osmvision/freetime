-- Each device has its own history. Keep achievements already earned on other devices.
create or replace function public.submit_points(p_day date, p_points integer, p_stamped integer, p_badges text[], p_best_streak integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  today date := (now() at time zone 'utc')::date;
  pts smallint := least(greatest(coalesce(p_points, 0), 0), 20);
  clean text[];
  total integer;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_day is null or p_day < today - 2 or p_day > today + 1 then
    raise exception 'points can only be sent for today' using errcode = '22023';
  end if;
  insert into public.daily_points (user_id, day, points) values (auth.uid(), p_day, pts)
  on conflict (user_id, day) do update
    set points = greatest(public.daily_points.points, excluded.points), updated_at = now();

  clean := array(
    select distinct badge from unnest(coalesce(p_badges, '{}')) as badge
    where badge ~ '^[a-z0-9-]{1,24}$' order by badge limit 40
  );
  insert into public.player_stats as stats (user_id, stamped, badges, best_streak, updated_at)
  values (auth.uid(), least(greatest(coalesce(p_stamped, 0), 0), 500), clean, least(greatest(coalesce(p_best_streak, 0), 0), 520), now())
  on conflict (user_id) do update
    set stamped = greatest(stats.stamped, excluded.stamped),
        badges = array(
          select distinct badge from unnest(stats.badges || excluded.badges) as badge
          order by badge limit 40
        ),
        best_streak = greatest(stats.best_streak, excluded.best_streak),
        updated_at = now();

  select coalesce(sum(points), 0) into total from public.daily_points
  where user_id = auth.uid() and day >= public.season_start(p_day) and day < (public.season_start(p_day) + interval '1 month')::date;
  return total;
end
$$;
