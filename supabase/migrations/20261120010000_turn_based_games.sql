-- Turn-based games with friends: Four in a row, Giant tic-tac-toe, Draughts, Dots and boxes and
-- Torpedoes (steps 2 and 3 of the mini-games plan).
--
-- Every move is checked by the "games" Edge Function, with the very rules the app ships
-- (supabase/functions/games/rules.js). Players can only read their own games: nobody can write
-- a game, a move or a result directly, and the functions that save them answer to the service
-- role only (the Edge Function). Torpedoes fleets live apart, in match_secrets, which nobody can
-- read: the other player never sees your ships, only the result of their shots.
--
-- Only between friends, never across a block; one game going per pair and per game; at most 5
-- started by you at once. A game where nobody plays for 7 days is over. No ranking points.

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  game text not null check (game in ('four', 'gomoku', 'draughts', 'dots', 'torpedoes')),
  -- player_a challenged player_b. In the rules, a is player 0 and b player 1.
  player_a uuid not null references public.profiles (id) on delete cascade,
  player_b uuid not null references public.profiles (id) on delete cascade,
  -- The public state (board, shots...), as the rules return it.
  state jsonb not null check (pg_column_size(state) < 16000),
  -- Whose move: 0 = a, 1 = b, null once over.
  turn smallint check (turn in (0, 1)),
  status text not null default 'active' check (status in ('active', 'done', 'declined', 'cancelled')),
  result text check (result in ('a', 'b', 'draw')),
  -- Raised by each saved move: a move based on an old version is refused.
  version integer not null default 0,
  -- Whether b has played yet (until then, b may decline and a may cancel).
  b_moved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  check (player_a <> player_b),
  check ((status = 'done') = (result is not null))
);
create index matches_a on public.matches (player_a, updated_at desc);
create index matches_b on public.matches (player_b, updated_at desc);

create table public.match_secrets (
  match_id uuid not null references public.matches (id) on delete cascade,
  player smallint not null check (player in (0, 1)),
  secret jsonb not null check (pg_column_size(secret) < 4000),
  primary key (match_id, player)
);

alter table public.matches enable row level security;
alter table public.match_secrets enable row level security;

create policy "see your own games" on public.matches
  for select to authenticated using ((select auth.uid()) in (player_a, player_b));

revoke all on public.matches, public.match_secrets from anon, authenticated;
grant select on public.matches to authenticated;

-- An active game nobody played for 7 days is over (no winner).
create function public.match_expired(m public.matches) returns boolean
language sql stable set search_path = ''
as $$
  select m.status = 'active' and m.updated_at < now() - interval '7 days'
$$;

-- ---------------------------------------------------------------- for the Edge Function only

-- Starts a game between `p_user` and a friend, with the first state from the rules. Returns its id.
create function public.match_open(p_user uuid, p_opponent uuid, p_game text, p_state jsonb, p_turn smallint, p_secret jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  new_id uuid;
begin
  if p_user is null or p_opponent is null or p_user = p_opponent
     or not public.are_friends(p_user, p_opponent) or public.is_blocked(p_user, p_opponent) then
    raise exception 'you can only play with your friends' using errcode = 'P0002';
  end if;
  perform 1 from public.profiles where id = p_user for update;
  if exists (
    select 1 from public.matches m
    where m.game = p_game and m.status = 'active' and not public.match_expired(m)
      and ((m.player_a = p_user and m.player_b = p_opponent) or (m.player_a = p_opponent and m.player_b = p_user))
  ) then
    raise exception 'you already have this game going with this friend' using errcode = '23505';
  end if;
  if (select count(*) from public.matches m where m.player_a = p_user and m.status = 'active' and not public.match_expired(m)) >= 5 then
    raise exception 'you have 5 games going already: finish one first' using errcode = '54000';
  end if;
  insert into public.matches (game, player_a, player_b, state, turn)
  values (p_game, p_user, p_opponent, p_state, p_turn)
  returning id into new_id;
  if p_secret is not null then
    insert into public.match_secrets (match_id, player, secret) values (new_id, 0, p_secret);
  end if;
  return new_id;
end
$$;

-- A game as one of its players sees it, with both secrets (for the rules, on the server), or null.
create function public.match_load(p_user uuid, p_match uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id,
    'game', m.game,
    'player', case when m.player_a = p_user then 0 else 1 end,
    'state', m.state,
    'version', m.version,
    'open', m.status = 'active' and not public.match_expired(m),
    'secrets', jsonb_build_array(
      (select s.secret from public.match_secrets s where s.match_id = m.id and s.player = 0),
      (select s.secret from public.match_secrets s where s.match_id = m.id and s.player = 1))
  )
  from public.matches m
  where m.id = p_match and p_user in (m.player_a, m.player_b)
    and not public.is_blocked(m.player_a, m.player_b)
$$;

-- Saves a move checked by the rules. Refused if the game moved on meanwhile (`p_version` is the
-- version the move was checked against), if it's over, or if it isn't `p_user`'s game.
-- `p_result`: null, or 'a' / 'b' / 'draw' when the move ends the game. `p_secret`: the fleet
-- `p_user` just placed (set once, never changed). Returns the new version.
create function public.match_save(p_user uuid, p_match uuid, p_version integer, p_state jsonb, p_turn smallint, p_result text, p_secret jsonb)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  m public.matches;
  me smallint;
begin
  select * into m from public.matches where id = p_match for update;
  if m.id is null or p_user is null or p_user not in (m.player_a, m.player_b) then
    raise exception 'no such game' using errcode = 'P0002';
  end if;
  if m.status <> 'active' or public.match_expired(m) or public.is_blocked(m.player_a, m.player_b) then
    raise exception 'this game is over' using errcode = '22023';
  end if;
  if m.version <> p_version then
    raise exception 'the game changed meanwhile: reload it' using errcode = '40001';
  end if;
  me := case when m.player_a = p_user then 0 else 1 end;
  if p_secret is not null then
    insert into public.match_secrets (match_id, player, secret) values (m.id, me, p_secret);
  end if;
  update public.matches set
    state = p_state,
    turn = case when p_result is null then p_turn end,
    status = case when p_result is null then 'active' else 'done' end,
    result = p_result,
    version = version + 1,
    b_moved = b_moved or me = 1,
    updated_at = now(),
    finished_at = case when p_result is null then null else now() end
  where id = m.id;
  return m.version + 1;
end
$$;

-- ---------------------------------------------------------------- for players

-- Your games: your turn first, then waiting, then finished (last 30 days). `me` is your player
-- number in the rules; `my_secret` your own Torpedoes fleet. `outcome`: 'won', 'lost', 'draw', 'declined', 'cancelled' or 'expired'
-- once over.
create function public.my_matches() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x.item order by x.rank, x.at desc), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'id', m.id,
        'game', m.game,
        'me', s.me,
        'challenger', s.me = 0,
        'other', jsonb_build_object('id', p.id, 'display_name', p.display_name, 'avatar_icon', p.avatar_icon, 'avatar_color', p.avatar_color),
        'state', m.state,
        'version', m.version,
        'b_moved', m.b_moved,
        'phase', s.phase,
        'outcome', s.outcome,
        -- Your own fleet (Torpedoes), never the other player's.
        'my_secret', (select ms.secret from public.match_secrets ms where ms.match_id = m.id and ms.player = s.me),
        'updated_at', m.updated_at
      ) as item,
      case s.phase when 'your_turn' then 0 when 'waiting' then 1 else 2 end as rank,
      m.updated_at as at
    from public.matches m
    join public.profiles p on p.id = case when m.player_a = auth.uid() then m.player_b else m.player_a end
    cross join lateral (select case when m.player_a = auth.uid() then 0 else 1 end::smallint as me) w
    cross join lateral (
      select
        w.me,
        case
          when public.match_expired(m) or m.status <> 'active' then 'over'
          when m.turn = w.me then 'your_turn'
          else 'waiting'
        end as phase,
        case
          when public.match_expired(m) then 'expired'
          when m.status in ('declined', 'cancelled') then m.status
          when m.result = 'draw' then 'draw'
          when m.result = (case when w.me = 0 then 'a' else 'b' end) then 'won'
          when m.result is not null then 'lost'
        end as outcome
    ) s
    where auth.uid() in (m.player_a, m.player_b)
      and not public.is_blocked(m.player_a, m.player_b)
      and (m.status = 'active' or m.updated_at > now() - interval '30 days')
    order by rank, at desc
    limit 50
  ) x
$$;

-- Leaves a game: declines it (invited, before your first move), cancels it (you started it and
-- the other hasn't played yet), or resigns (the other player wins).
create function public.leave_match(p_match uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  m public.matches;
  outcome text;
begin
  select * into m from public.matches where id = p_match for update;
  if me is null or m.id is null or me not in (m.player_a, m.player_b) then
    raise exception 'no such game' using errcode = 'P0002';
  end if;
  if m.status <> 'active' or public.match_expired(m) then
    raise exception 'this game is over' using errcode = '22023';
  end if;
  if not m.b_moved then
    outcome := case when me = m.player_b then 'declined' else 'cancelled' end;
    update public.matches set status = outcome, turn = null, updated_at = now(), finished_at = now() where id = m.id;
  else
    outcome := 'resigned';
    update public.matches set status = 'done', result = case when me = m.player_a then 'b' else 'a' end,
      turn = null, version = version + 1, updated_at = now(), finished_at = now()
    where id = m.id;
  end if;
  return outcome;
end
$$;

-- ---------------------------------------------------------------- live updates

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches') then
      alter publication supabase_realtime add table public.matches;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------- your data (games added)

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
    'posts_you_shared', coalesce((select jsonb_agg(jsonb_build_object('kind', p.kind, 'idea_id', p.idea_id, 'title', p.title, 'detail', p.detail, 'created_at', p.created_at) order by p.id)
                         from public.posts p where p.author = auth.uid()), '[]'::jsonb),
    'reactions_you_gave', coalesce((select jsonb_agg(jsonb_build_object('post', r.post_id, 'emoji', r.emoji, 'created_at', r.created_at))
                           from public.reactions r where r.user_id = auth.uid()), '[]'::jsonb),
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
                         from public.reports r where r.reporter = auth.uid()), '[]'::jsonb),
    'quiz_duels', coalesce((select jsonb_agg(jsonb_build_object(
                      'other', case when d.challenger = auth.uid() then d.opponent else d.challenger end,
                      'you_challenged', d.challenger = auth.uid(), 'status', d.status,
                      'your_score', case when d.challenger = auth.uid() then d.challenger_score else d.opponent_score end,
                      'their_score', case when d.challenger = auth.uid() then d.opponent_score else d.challenger_score end,
                      'your_answers', (select a.answers from public.duel_answers a where a.duel_id = d.id and a.user_id = auth.uid()),
                      'created_at', d.created_at, 'finished_at', d.finished_at) order by d.created_at)
                    from public.duels d where auth.uid() in (d.challenger, d.opponent)), '[]'::jsonb),
    'games', coalesce((select jsonb_agg(jsonb_build_object(
                      'game', m.game,
                      'other', case when m.player_a = auth.uid() then m.player_b else m.player_a end,
                      'you_started', m.player_a = auth.uid(), 'status', m.status, 'result', m.result,
                      'state', m.state,
                      'your_ships', (select s.secret from public.match_secrets s
                                     where s.match_id = m.id and s.player = case when m.player_a = auth.uid() then 0 else 1 end),
                      'created_at', m.created_at, 'finished_at', m.finished_at) order by m.created_at)
                from public.matches m where auth.uid() in (m.player_a, m.player_b)), '[]'::jsonb)
  )
$$;

revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

-- ---------------------------------------------------------------- function grants

revoke all on function
  public.match_expired(public.matches),
  public.match_open(uuid, uuid, text, jsonb, smallint, jsonb),
  public.match_load(uuid, uuid),
  public.match_save(uuid, uuid, integer, jsonb, smallint, text, jsonb),
  public.my_matches(), public.leave_match(uuid)
from public, anon, authenticated;
grant execute on function
  public.match_open(uuid, uuid, text, jsonb, smallint, jsonb),
  public.match_load(uuid, uuid),
  public.match_save(uuid, uuid, integer, jsonb, smallint, text, jsonb)
to service_role;
grant execute on function public.my_matches(), public.leave_match(uuid) to authenticated;
