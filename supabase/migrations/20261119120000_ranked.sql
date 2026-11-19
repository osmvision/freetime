-- Ranked: monthly seasons, a friends leaderboard and an opt-in global one, and player cards
-- (docs/engagement-plan.md). Points are earned in the app (quiz, ticket of the day, new
-- stamps, weekly challenge, badges) and capped at 20 a day here, so a tampered client can't
-- climb faster than a regular player. Nobody reads these tables directly: only through the
-- functions below, which decide who sees whom.

-- ---------------------------------------------------------------- opt-in to the global board

-- Off by default (privacy by default). When on, anyone signed in can see your name, avatar,
-- rank, points and badges, and send you a friend request. Never your email, bio or status.
alter table public.profiles add column show_in_global boolean not null default false;
grant update (show_in_global) on public.profiles to authenticated;

-- ---------------------------------------------------------------- tables

create table public.daily_points (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  points smallint not null check (points between 0 and 20),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- What a player card shows besides points: tickets stamped, badges earned, best weekly streak.
create table public.player_stats (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  stamped smallint not null default 0 check (stamped between 0 and 500),
  badges text[] not null default '{}'
    check (cardinality(badges) <= 40 and array_to_string(badges, ',') ~ '^([a-z0-9-]{1,24}(,|$))*$'),
  best_streak smallint not null default 0 check (best_streak between 0 and 520),
  updated_at timestamptz not null default now()
);

alter table public.daily_points enable row level security;
alter table public.player_stats enable row level security;
-- No policies and no grants: reads go through leaderboard(), my_ranking() and player_card(),
-- writes through submit_points().
revoke all on public.daily_points, public.player_stats from anon, authenticated;

-- ---------------------------------------------------------------- helpers

-- The first day of the season (UTC month) that contains `d`, or the current one.
create function public.season_start(d date) returns date
language sql stable set search_path = ''
as $$
  select date_trunc('month', coalesce(d, (now() at time zone 'utc')::date))::date
$$;

-- Whether the signed-in user may see this player in a ranking or a card: themselves, an
-- accepted friend, or someone in the global board; never across a block.
create function public.can_see_player(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and (
    target = auth.uid()
    or (not public.is_blocked(auth.uid(), target)
        and (public.are_friends(auth.uid(), target)
             or exists (select 1 from public.profiles p where p.id = target and p.show_in_global)))
  )
$$;

-- ---------------------------------------------------------------- writing points

-- Today's (or yesterday's) points and the card stats. Points only go up within a day, and are
-- capped at 20. `p_day` is the player's local date: it may be one day ahead of or two days
-- behind UTC, nothing older.
create function public.submit_points(p_day date, p_points integer, p_stamped integer, p_badges text[], p_best_streak integer)
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

  select coalesce(array_agg(b order by b), '{}') into clean
  from (select distinct b from unnest(coalesce(p_badges, '{}')) b where b ~ '^[a-z0-9-]{1,24}$' limit 40) x;
  insert into public.player_stats (user_id, stamped, badges, best_streak, updated_at)
  values (auth.uid(), least(greatest(coalesce(p_stamped, 0), 0), 500), clean, least(greatest(coalesce(p_best_streak, 0), 0), 520), now())
  on conflict (user_id) do update
    set stamped = excluded.stamped, badges = excluded.badges, best_streak = excluded.best_streak, updated_at = now();

  select coalesce(sum(points), 0) into total from public.daily_points
  where user_id = auth.uid() and day >= public.season_start(p_day) and day < (public.season_start(p_day) + interval '1 month')::date;
  return total;
end
$$;

-- ---------------------------------------------------------------- reading rankings

-- 'friends': you and your accepted friends (everyone, even at 0 points).
-- 'global': players who opted in, with points this season. Top 100.
create function public.leaderboard(p_scope text, p_month date default null)
returns table (rank bigint, user_id uuid, display_name text, avatar_icon smallint, avatar_color smallint, points bigint, me boolean)
language sql stable security definer set search_path = ''
as $$
  with s as (select public.season_start(p_month) as start),
  people as (
    select p.id, p.display_name, p.avatar_icon, p.avatar_color
    from public.profiles p
    where auth.uid() is not null and case p_scope
      when 'friends' then p.id = auth.uid() or (public.are_friends(auth.uid(), p.id) and not public.is_blocked(auth.uid(), p.id))
      when 'global' then p.show_in_global and not public.is_blocked(auth.uid(), p.id)
      else false
    end
  ),
  totals as (
    select pe.id, pe.display_name, pe.avatar_icon, pe.avatar_color, coalesce(sum(d.points), 0)::bigint as points
    from people pe
    left join public.daily_points d
      on d.user_id = pe.id and d.day >= (select start from s) and d.day < ((select start from s) + interval '1 month')::date
    group by pe.id, pe.display_name, pe.avatar_icon, pe.avatar_color
  )
  select rank() over (order by t.points desc), t.id, t.display_name, t.avatar_icon, t.avatar_color, t.points, t.id = auth.uid()
  from totals t
  where p_scope = 'friends' or t.points > 0
  order by t.points desc, t.display_name, t.id
  limit 100
$$;

-- Your points this season, and your place on the global board if you're on it.
create function public.my_ranking(p_month date default null)
returns table (points bigint, show_in_global boolean, global_rank bigint, global_players bigint)
language sql stable security definer set search_path = ''
as $$
  with s as (select public.season_start(p_month) as start),
  totals as (
    select p.id, p.show_in_global, coalesce(sum(d.points), 0)::bigint as points
    from public.profiles p
    left join public.daily_points d
      on d.user_id = p.id and d.day >= (select start from s) and d.day < ((select start from s) + interval '1 month')::date
    where p.id = auth.uid() or p.show_in_global
    group by p.id, p.show_in_global
  ),
  mine as (select * from totals where id = auth.uid())
  select m.points, m.show_in_global,
         case when m.show_in_global and m.points > 0
              then 1 + (select count(*) from totals t where t.show_in_global and t.points > m.points) end,
         (select count(*) from totals t where t.show_in_global and t.points > 0)
  from mine m
$$;

-- A player's card. Friends (and you) see bio and status too; global players only what the
-- board shows, plus their friend tag so you can send a request. Null when you may not see them.
create function public.player_card(p_user uuid, p_month date default null) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when public.can_see_player(p.id) then jsonb_build_object(
    'id', p.id,
    'display_name', p.display_name,
    'avatar_icon', p.avatar_icon,
    'avatar_color', p.avatar_color,
    'me', p.id = auth.uid(),
    'friend', public.are_friends(auth.uid(), p.id),
    'bio', case when p.id = auth.uid() or public.are_friends(auth.uid(), p.id) then p.bio end,
    'status_text', case when p.id = auth.uid() or public.are_friends(auth.uid(), p.id) then p.status_text end,
    'friend_tag', case when p.id <> auth.uid() and not public.are_friends(auth.uid(), p.id) and p.show_in_global then p.friend_tag end,
    'in_global', p.show_in_global,
    'points', (select coalesce(sum(d.points), 0) from public.daily_points d
               where d.user_id = p.id and d.day >= public.season_start(p_month)
                 and d.day < (public.season_start(p_month) + interval '1 month')::date),
    'stamped', coalesce(st.stamped, 0),
    'badges', coalesce(to_jsonb(st.badges), '[]'::jsonb),
    'best_streak', coalesce(st.best_streak, 0)
  ) end
  from public.profiles p
  left join public.player_stats st on st.user_id = p.id
  where p.id = p_user
$$;

-- ---------------------------------------------------------------- your data

create or replace function public.export_my_data() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'exported_at', now(),
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at)
                from auth.users u where u.id = auth.uid()),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = auth.uid()),
    'shared_game_list', (select jsonb_build_object('app_ids', g.app_ids, 'taste', g.taste, 'updated_at', g.updated_at)
                         from public.game_libraries g where g.user_id = auth.uid()),
    'points_by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'points', d.points) order by d.day)
                      from public.daily_points d where d.user_id = auth.uid()), '[]'::jsonb),
    'player_stats', (select jsonb_build_object('stamped', s.stamped, 'badges', s.badges, 'best_streak', s.best_streak, 'updated_at', s.updated_at)
                     from public.player_stats s where s.user_id = auth.uid()),
    'friendships', coalesce((select jsonb_agg(jsonb_build_object(
                      'other', case when f.requester = auth.uid() then f.addressee else f.requester end,
                      'you_asked', f.requester = auth.uid(), 'status', f.status,
                      'created_at', f.created_at, 'accepted_at', f.accepted_at))
                    from public.friendships f where auth.uid() in (f.requester, f.addressee)), '[]'::jsonb),
    'blocks', coalesce((select jsonb_agg(jsonb_build_object('blocked', b.blocked, 'created_at', b.created_at))
               from public.blocks b where b.blocker = auth.uid()), '[]'::jsonb),
    'messages_you_sent', coalesce((select jsonb_agg(jsonb_build_object('conversation', m.conversation_id, 'body', m.body, 'created_at', m.created_at) order by m.id)
                          from public.messages m where m.sender = auth.uid()), '[]'::jsonb),
    'invites_you_sent', coalesce((select jsonb_agg(jsonb_build_object('to', i.to_user, 'title', i.title, 'starts_at', i.starts_at, 'note', i.note, 'status', i.status) order by i.id)
                         from public.invites i where i.from_user = auth.uid()), '[]'::jsonb),
    'reports_you_made', coalesce((select jsonb_agg(jsonb_build_object('target', r.target, 'reason', r.reason, 'details', r.details, 'created_at', r.created_at, 'status', r.status))
                         from public.reports r where r.reporter = auth.uid()), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- grants

revoke all on function public.season_start(date), public.can_see_player(uuid),
  public.submit_points(date, integer, integer, text[], integer), public.leaderboard(text, date),
  public.my_ranking(date), public.player_card(uuid, date) from public, anon, authenticated;
grant execute on function public.submit_points(date, integer, integer, text[], integer), public.leaderboard(text, date),
  public.my_ranking(date), public.player_card(uuid, date) to authenticated;
revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
