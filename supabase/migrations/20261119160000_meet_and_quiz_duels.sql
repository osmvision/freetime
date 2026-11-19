-- Meet people and quiz duels (step 1 of the mini-games plan).
--
-- Meet: a list of the people who chose to be visible (the same opt-in as the global board, with
-- the same promise: name, avatar, points and badges, and friend requests; never email, bio or
-- status), newest accounts first, and a one-tap friend request to one of them.
--
-- Quiz duels: two friends answer the same 5 questions, each when they like, and compare scores.
-- The server picks the questions and scores the answers against its own copy of the answer key,
-- so a modified app can't send a made-up score or play for someone else. Duels are only between
-- friends, never across a block, at most 5 waiting per challenger and one at a time per pair;
-- one that nobody finishes within 7 days expires. Wins give no ranking points (no reason to
-- farm them with spare accounts).

-- ---------------------------------------------------------------- meet

-- Opted-in players you're not friends with yet, newest accounts first. `new` = joined in the
-- last 14 days (the date itself isn't shown). `request`: 'sent', 'received' or 'none'.
create function public.meet_people()
returns table (user_id uuid, display_name text, avatar_icon smallint, avatar_color smallint, new boolean, points bigint, badges integer, request text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.display_name, p.avatar_icon, p.avatar_color,
    p.created_at > now() - interval '14 days',
    coalesce((select sum(d.points) from public.daily_points d
              where d.user_id = p.id and d.day >= public.season_start(null)), 0)::bigint,
    coalesce((select cardinality(s.badges) from public.player_stats s where s.user_id = p.id), 0),
    case
      when exists (select 1 from public.friendships f where f.requester = auth.uid() and f.addressee = p.id) then 'sent'
      when exists (select 1 from public.friendships f where f.requester = p.id and f.addressee = auth.uid()) then 'received'
      else 'none'
    end
  from public.profiles p
  where auth.uid() is not null
    and p.show_in_global
    and p.id <> auth.uid()
    and not public.is_blocked(auth.uid(), p.id)
    and not public.are_friends(auth.uid(), p.id)
  order by p.created_at desc, p.id
  limit 60
$$;

-- A friend request by id, for Meet: only to someone who chose to be visible (or who already asked
-- you). Same answers as send_friend_request: 'pending', or 'accepted' if they had asked you.
-- At most 20 requests waiting, and 20 sent a day.
create function public.request_friend(p_user uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  existing text;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- Hidden, unknown and blocked people all get the same answer.
  if p_user is null or p_user = me or public.is_blocked(me, p_user)
     or not (exists (select 1 from public.profiles p where p.id = p_user and p.show_in_global)
             or exists (select 1 from public.friendships f where f.requester = p_user and f.addressee = me)) then
    raise exception 'this person can''t be added from here' using errcode = 'P0002';
  end if;

  select status into existing from public.friendships where requester = me and addressee = p_user;
  if existing is not null then
    return existing;
  end if;
  select status into existing from public.friendships where requester = p_user and addressee = me;
  if existing = 'pending' then
    update public.friendships set status = 'accepted' where requester = p_user and addressee = me;
    return 'accepted';
  elsif existing = 'accepted' then
    return 'accepted';
  end if;

  if (select count(*) from public.friendships where requester = me and status = 'pending') >= 20 then
    raise exception 'too many friend requests are waiting for an answer' using errcode = '54000';
  end if;
  if (select count(*) from public.friendships where requester = me and created_at > now() - interval '1 day') >= 20 then
    raise exception 'that''s a lot of friend requests for one day: try again tomorrow' using errcode = '54000';
  end if;
  insert into public.friendships (requester, addressee) values (me, p_user);
  return 'pending';
end
$$;

-- ---------------------------------------------------------------- the answer key

-- A copy of each quiz question's id, topic and right answer (core/data/quiz.toml, choices in
-- their original order). Nobody reads it through the API: only the duel functions do. A core
-- test checks it matches the questions shipped in the app.
create table public.quiz_keys (
  id text primary key check (id ~ '^q[0-9]{3,4}$'),
  topic text not null check (topic ~ '^[a-z]{1,16}$'),
  answer smallint not null check (answer between 0 and 3)
);
alter table public.quiz_keys enable row level security;
revoke all on public.quiz_keys from anon, authenticated;

insert into public.quiz_keys (id, topic, answer) values
  ('q001', 'space', 1),
  ('q002', 'space', 3),
  ('q003', 'space', 1),
  ('q004', 'space', 0),
  ('q005', 'space', 2),
  ('q006', 'space', 0),
  ('q007', 'space', 1),
  ('q008', 'space', 2),
  ('q009', 'space', 3),
  ('q010', 'space', 0),
  ('q011', 'geography', 2),
  ('q012', 'geography', 2),
  ('q013', 'geography', 3),
  ('q014', 'geography', 0),
  ('q015', 'geography', 1),
  ('q016', 'geography', 1),
  ('q017', 'geography', 2),
  ('q018', 'geography', 1),
  ('q019', 'geography', 0),
  ('q020', 'geography', 2),
  ('q021', 'geography', 3),
  ('q022', 'geography', 0),
  ('q023', 'geography', 1),
  ('q024', 'history', 1),
  ('q025', 'history', 2),
  ('q026', 'history', 2),
  ('q027', 'history', 0),
  ('q028', 'history', 1),
  ('q029', 'history', 2),
  ('q030', 'history', 3),
  ('q031', 'history', 0),
  ('q032', 'science', 1),
  ('q033', 'science', 1),
  ('q034', 'science', 1),
  ('q035', 'science', 2),
  ('q036', 'science', 2),
  ('q037', 'science', 2),
  ('q038', 'science', 1),
  ('q039', 'science', 0),
  ('q040', 'science', 3),
  ('q041', 'science', 0),
  ('q042', 'science', 1),
  ('q043', 'nature', 1),
  ('q044', 'nature', 0),
  ('q045', 'nature', 1),
  ('q046', 'nature', 2),
  ('q047', 'nature', 0),
  ('q048', 'nature', 3),
  ('q049', 'nature', 1),
  ('q050', 'nature', 2),
  ('q051', 'nature', 0),
  ('q052', 'food', 0),
  ('q053', 'food', 0),
  ('q054', 'food', 1),
  ('q055', 'food', 2),
  ('q056', 'food', 3),
  ('q057', 'food', 1),
  ('q058', 'food', 0),
  ('q059', 'food', 2),
  ('q060', 'food', 3),
  ('q061', 'food', 1),
  ('q062', 'sport', 2),
  ('q063', 'sport', 1),
  ('q064', 'sport', 0),
  ('q065', 'sport', 2),
  ('q066', 'sport', 1),
  ('q067', 'sport', 2),
  ('q068', 'sport', 1),
  ('q069', 'sport', 1),
  ('q070', 'sport', 0),
  ('q071', 'sport', 3),
  ('q072', 'words', 2),
  ('q073', 'words', 0),
  ('q074', 'words', 2),
  ('q075', 'words', 2),
  ('q076', 'words', 1),
  ('q077', 'words', 3),
  ('q078', 'art', 1),
  ('q079', 'art', 2),
  ('q080', 'art', 0),
  ('q081', 'art', 1),
  ('q082', 'art', 3),
  ('q083', 'art', 2),
  ('q084', 'games', 1),
  ('q085', 'games', 1),
  ('q086', 'games', 1),
  ('q087', 'games', 2),
  ('q088', 'games', 3),
  ('q089', 'games', 0),
  ('q090', 'logic', 1),
  ('q091', 'logic', 1),
  ('q092', 'logic', 2),
  ('q093', 'logic', 1),
  ('q094', 'logic', 3),
  ('q095', 'logic', 2),
  ('q096', 'logic', 1),
  ('q097', 'logic', 0),
  ('q098', 'logic', 2),
  ('q099', 'logic', 3),
  ('q100', 'life', 1),
  ('q101', 'life', 2),
  ('q102', 'life', 0),
  ('q103', 'life', 3),
  ('q104', 'space', 0),
  ('q105', 'space', 2),
  ('q106', 'space', 1),
  ('q107', 'space', 3),
  ('q108', 'space', 0),
  ('q109', 'geography', 2),
  ('q110', 'geography', 1),
  ('q111', 'geography', 0),
  ('q112', 'geography', 3),
  ('q113', 'geography', 1),
  ('q114', 'geography', 2),
  ('q115', 'history', 0),
  ('q116', 'history', 2),
  ('q117', 'history', 1),
  ('q118', 'history', 3),
  ('q119', 'history', 0),
  ('q120', 'science', 0),
  ('q121', 'science', 3),
  ('q122', 'science', 1),
  ('q123', 'science', 2),
  ('q124', 'science', 0),
  ('q125', 'science', 2),
  ('q126', 'nature', 1),
  ('q127', 'nature', 2),
  ('q128', 'nature', 0),
  ('q129', 'nature', 3),
  ('q130', 'nature', 1),
  ('q131', 'food', 3),
  ('q132', 'food', 0),
  ('q133', 'food', 2),
  ('q134', 'food', 1),
  ('q135', 'food', 0),
  ('q136', 'sport', 1),
  ('q137', 'sport', 2),
  ('q138', 'sport', 0),
  ('q139', 'sport', 3),
  ('q140', 'sport', 1),
  ('q141', 'words', 0),
  ('q142', 'words', 2),
  ('q143', 'words', 1),
  ('q144', 'words', 3),
  ('q145', 'art', 2),
  ('q146', 'art', 0),
  ('q147', 'art', 3),
  ('q148', 'art', 1),
  ('q149', 'games', 2),
  ('q150', 'games', 0),
  ('q151', 'games', 3),
  ('q152', 'games', 1),
  ('q153', 'logic', 1),
  ('q154', 'logic', 2),
  ('q155', 'logic', 3),
  ('q156', 'logic', 0),
  ('q157', 'logic', 1),
  ('q158', 'logic', 2),
  ('q159', 'life', 1),
  ('q160', 'life', 2),
  ('q161', 'life', 0),
  ('q162', 'life', 3);

-- ---------------------------------------------------------------- duels

create table public.duels (
  id uuid primary key default gen_random_uuid(),
  challenger uuid not null references public.profiles (id) on delete cascade,
  opponent uuid not null references public.profiles (id) on delete cascade,
  -- quiz_keys ids, in the order they are asked.
  questions text[] not null check (cardinality(questions) = 5),
  challenger_score smallint check (challenger_score between 0 and 5),
  opponent_score smallint check (opponent_score between 0 and 5),
  -- 'open' until both played ('done'), or the opponent said no ('declined'), or the challenger
  -- took it back before the opponent played ('cancelled'). Expiry is computed from created_at.
  status text not null default 'open' check (status in ('open', 'done', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check (challenger <> opponent)
);
create index duels_challenger on public.duels (challenger, created_at desc);
create index duels_opponent on public.duels (opponent, created_at desc);

-- Each player's answers (original choice order), kept apart so the live updates of `duels` never
-- carry them.
create table public.duel_answers (
  duel_id uuid not null references public.duels (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  answers smallint[] not null check (cardinality(answers) = 5),
  created_at timestamptz not null default now(),
  primary key (duel_id, user_id)
);

alter table public.duels enable row level security;
alter table public.duel_answers enable row level security;

-- Players see their own duels (needed for live updates); every change goes through the functions.
create policy "see your own duels" on public.duels
  for select to authenticated using ((select auth.uid()) in (challenger, opponent));

revoke all on public.duels, public.duel_answers from anon, authenticated;
grant select on public.duels to authenticated;

-- An open duel nobody finished within 7 days is over.
create function public.duel_expired(d public.duels) returns boolean
language sql stable set search_path = ''
as $$
  select d.status = 'open' and d.created_at < now() - interval '7 days'
$$;

-- Challenges a friend: 5 questions from 5 different topics. Returns the duel's id.
create function public.create_duel(p_opponent uuid) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  qs text[];
  new_id uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_opponent is null or p_opponent = me or not public.are_friends(me, p_opponent) or public.is_blocked(me, p_opponent) then
    raise exception 'you can only challenge your friends' using errcode = 'P0002';
  end if;
  -- Serializes the checks below for this challenger (two clicks at once can't both pass).
  perform 1 from public.profiles where id = me for update;
  if exists (
    select 1 from public.duels d
    where d.status = 'open' and not public.duel_expired(d)
      and ((d.challenger = me and d.opponent = p_opponent) or (d.challenger = p_opponent and d.opponent = me))
  ) then
    raise exception 'you already have a duel going with this friend' using errcode = '23505';
  end if;
  if (select count(*) from public.duels d where d.challenger = me and d.status = 'open' and not public.duel_expired(d)) >= 5 then
    raise exception 'you have 5 duels waiting already: finish one first' using errcode = '54000';
  end if;

  select array_agg(picked.id order by random()) into qs
  from (
    select t.id from (select distinct on (k.topic) k.id, k.topic from public.quiz_keys k order by k.topic, random()) t
    order by random()
    limit 5
  ) picked;
  insert into public.duels (challenger, opponent, questions) values (me, p_opponent, qs) returning id into new_id;
  return new_id;
end
$$;

-- Plays your side of a duel: `p_answers` are the indexes you chose, in the original choice order.
-- Returns your score, the right answers, and the other player's score once they played too.
create function public.play_duel(p_duel uuid, p_answers integer[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  d public.duels;
  key smallint[];
  score smallint := 0;
  i integer;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into d from public.duels where id = p_duel for update;
  if d.id is null or me not in (d.challenger, d.opponent) then
    raise exception 'no such duel' using errcode = 'P0002';
  end if;
  if d.status <> 'open' or public.duel_expired(d) then
    raise exception 'this duel is over' using errcode = '22023';
  end if;
  if (me = d.challenger and d.challenger_score is not null) or (me = d.opponent and d.opponent_score is not null) then
    raise exception 'you already played this duel' using errcode = '23505';
  end if;
  if p_answers is null or cardinality(p_answers) <> 5 or array_position(p_answers, null) is not null
     or exists (select 1 from unnest(p_answers) a where a < 0 or a > 3) then
    raise exception 'a duel takes 5 answers, from 0 to 3' using errcode = '22023';
  end if;

  select array_agg(k.answer order by q.n) into key
  from unnest(d.questions) with ordinality q(id, n)
  join public.quiz_keys k on k.id = q.id;
  if coalesce(cardinality(key), 0) <> 5 then
    raise exception 'this duel uses unknown questions' using errcode = '22023';
  end if;
  for i in 1..5 loop
    if p_answers[i] = key[i] then
      score := score + 1;
    end if;
  end loop;

  insert into public.duel_answers (duel_id, user_id, answers) values (d.id, me, p_answers::smallint[]);
  if me = d.challenger then
    update public.duels set challenger_score = score,
      status = case when opponent_score is null then 'open' else 'done' end,
      finished_at = case when opponent_score is null then null else now() end
    where id = d.id returning * into d;
  else
    update public.duels set opponent_score = score,
      status = case when challenger_score is null then 'open' else 'done' end,
      finished_at = case when challenger_score is null then null else now() end
    where id = d.id returning * into d;
  end if;

  return jsonb_build_object(
    'score', score,
    'key', to_jsonb(key),
    'other_score', case when me = d.challenger then d.opponent_score else d.challenger_score end,
    'status', d.status
  );
end
$$;

-- Says no to a duel (the opponent) or takes it back (the challenger), while the opponent hasn't
-- played yet.
create function public.drop_duel(p_duel uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  d public.duels;
begin
  select * into d from public.duels where id = p_duel for update;
  if me is null or d.id is null or me not in (d.challenger, d.opponent) then
    raise exception 'no such duel' using errcode = 'P0002';
  end if;
  if d.status <> 'open' or d.opponent_score is not null then
    raise exception 'this duel can''t be dropped any more' using errcode = '22023';
  end if;
  update public.duels set status = case when me = d.opponent then 'declined' else 'cancelled' end, finished_at = now()
  where id = d.id;
end
$$;

-- Your duels of the last 30 days (and every open one), with the other player. `questions` only
-- while it's your turn. `state`: 'your_turn', 'waiting' (for them), 'done', 'declined',
-- 'cancelled' or 'expired'. Duels with someone you blocked (or who blocked you) are left out.
create function public.my_duels() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x.item order by x.rank, x.at desc), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'id', d.id,
        'challenger', d.challenger = auth.uid(),
        'other', jsonb_build_object('id', p.id, 'display_name', p.display_name, 'avatar_icon', p.avatar_icon, 'avatar_color', p.avatar_color),
        'state', s.state,
        'questions', case when s.state = 'your_turn' then to_jsonb(d.questions) end,
        'my_score', case when d.challenger = auth.uid() then d.challenger_score else d.opponent_score end,
        'their_score', case when d.challenger = auth.uid() then d.opponent_score else d.challenger_score end,
        'created_at', d.created_at,
        'finished_at', d.finished_at
      ) as item,
      case s.state when 'your_turn' then 0 when 'waiting' then 1 else 2 end as rank,
      coalesce(d.finished_at, d.created_at) as at
    from public.duels d
    join public.profiles p on p.id = case when d.challenger = auth.uid() then d.opponent else d.challenger end
    cross join lateral (
      select case
        when public.duel_expired(d) then 'expired'
        when d.status <> 'open' then d.status
        when (case when d.challenger = auth.uid() then d.challenger_score else d.opponent_score end) is null then 'your_turn'
        else 'waiting'
      end as state
    ) s
    where auth.uid() in (d.challenger, d.opponent)
      and not public.is_blocked(d.challenger, d.opponent)
      and (d.status = 'open' or coalesce(d.finished_at, d.created_at) > now() - interval '30 days')
    order by rank, at desc
    limit 50
  ) x
$$;

-- ---------------------------------------------------------------- live updates

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'duels') then
      alter publication supabase_realtime add table public.duels;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------- your data (duels added)

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
                    from public.duels d where auth.uid() in (d.challenger, d.opponent)), '[]'::jsonb)
  )
$$;

revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

-- ---------------------------------------------------------------- function grants

revoke all on function
  public.meet_people(), public.request_friend(uuid), public.duel_expired(public.duels),
  public.create_duel(uuid), public.play_duel(uuid, integer[]), public.drop_duel(uuid), public.my_duels()
from public, anon, authenticated;
grant execute on function
  public.meet_people(), public.request_friend(uuid),
  public.create_duel(uuid), public.play_duel(uuid, integer[]), public.drop_duel(uuid), public.my_duels()
to authenticated;
