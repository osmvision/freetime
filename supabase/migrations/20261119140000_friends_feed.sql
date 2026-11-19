-- Friends' feed (phase B of docs/engagement-plan.md): what friends did, shared on purpose, with
-- quick reactions. Friends only, never strangers; posts expire after 30 days; the feed ends
-- after 7 days ("you're up to date"); reaction counts are shown to the author only.
-- Tables are read and written only through the functions below.

create table public.posts (
  id bigint generated always as identity primary key,
  author uuid not null references public.profiles (id) on delete cascade,
  -- pick: an idea you did and liked; quiz: today's quiz score; badge: a badge you earned.
  kind text not null check (kind in ('pick', 'quiz', 'badge')),
  idea_id text check (idea_id is null or idea_id ~ '^[a-z]+:[A-Za-z0-9_.:-]{1,80}$'),
  title text not null check (char_length(btrim(title)) between 1 and 120 and title !~ '[[:cntrl:]]'),
  category text not null default '' check (category ~ '^[a-z]{0,12}$'),
  detail text not null default '' check (char_length(detail) <= 40 and detail !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
create index posts_author_created on public.posts (author, created_at desc);
create index posts_expires on public.posts (expires_at);

create table public.reactions (
  post_id bigint not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('fire', 'laugh', 'eyes', 'clap')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, emoji)
);
create index reactions_user on public.reactions (user_id, created_at);

alter table public.posts enable row level security;
alter table public.reactions enable row level security;
revoke all on public.posts, public.reactions from anon, authenticated;

-- ---------------------------------------------------------------- helpers

-- You, or an accepted friend with no block either way.
create function public.can_see_author(author uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and (
    author = auth.uid()
    or (public.are_friends(auth.uid(), author) and not public.is_blocked(auth.uid(), author))
  )
$$;

-- ---------------------------------------------------------------- writing

-- Shares something you did with your friends. The same thing twice within 6 hours returns the
-- first post. At most 20 posts a day. Also clears expired posts.
create function public.share_post(p_kind text, p_idea_id text, p_title text, p_category text, p_detail text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  existing bigint;
  new_id bigint;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  delete from public.posts where expires_at < now();
  select id into existing from public.posts
  where author = auth.uid() and kind = p_kind and coalesce(idea_id, '') = coalesce(p_idea_id, '')
    and coalesce(detail, '') = coalesce(p_detail, '') and created_at > now() - interval '6 hours'
  order by id desc limit 1;
  if existing is not null then
    return existing;
  end if;
  if (select count(*) from public.posts where author = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'you shared a lot today: try again tomorrow' using errcode = '54000';
  end if;
  insert into public.posts (author, kind, idea_id, title, category, detail)
  values (auth.uid(), p_kind, nullif(p_idea_id, ''), btrim(p_title), coalesce(p_category, ''), coalesce(p_detail, ''))
  returning id into new_id;
  return new_id;
end
$$;

create function public.delete_post(p_id bigint) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.posts where id = p_id and author = auth.uid();
end
$$;

-- Turns a reaction on or off on a friend's post. Returns whether it's now on.
create function public.toggle_reaction(p_post bigint, p_emoji text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  writer uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select author into writer from public.posts where id = p_post and expires_at > now();
  if writer is null or writer = auth.uid() or not public.can_see_author(writer) then
    raise exception 'you can only react to your friends'' posts' using errcode = '42501';
  end if;
  if p_emoji not in ('fire', 'laugh', 'eyes', 'clap') then
    raise exception 'unknown reaction' using errcode = '22023';
  end if;
  delete from public.reactions where post_id = p_post and user_id = auth.uid() and emoji = p_emoji;
  if found then
    return false;
  end if;
  if (select count(*) from public.reactions where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 120 then
    raise exception 'slow down: too many reactions' using errcode = '54000';
  end if;
  insert into public.reactions (post_id, user_id, emoji) values (p_post, auth.uid(), p_emoji);
  return true;
end
$$;

-- ---------------------------------------------------------------- reading

-- The last days of you and your friends, newest first (at most 7 days and 100 posts).
-- `counts` only on your own posts; `mine` lists the reactions you gave.
create function public.friend_feed(p_days integer default 7)
returns table (id bigint, author uuid, display_name text, avatar_icon smallint, avatar_color smallint, kind text, idea_id text,
               title text, category text, detail text, created_at timestamptz, own boolean, mine text[], counts jsonb)
language sql stable security definer set search_path = ''
as $$
  with authors as (
    select auth.uid() as id where auth.uid() is not null
    union
    select case when f.requester = auth.uid() then f.addressee else f.requester end
    from public.friendships f
    where f.status = 'accepted' and auth.uid() in (f.requester, f.addressee)
      and not public.is_blocked(f.requester, f.addressee)
  )
  select p.id, p.author, pr.display_name, pr.avatar_icon, pr.avatar_color, p.kind, p.idea_id, p.title, p.category, p.detail,
         p.created_at, p.author = auth.uid(),
         coalesce((select array_agg(r.emoji order by r.emoji) from public.reactions r where r.post_id = p.id and r.user_id = auth.uid()), '{}'),
         case when p.author = auth.uid() then coalesce((select jsonb_object_agg(c.emoji, c.n) from
           (select r.emoji, count(*) as n from public.reactions r where r.post_id = p.id group by r.emoji) c), '{}'::jsonb) end
  from public.posts p
  join authors a on a.id = p.author
  join public.profiles pr on pr.id = p.author
  where p.expires_at > now() and p.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 7))
  order by p.created_at desc
  limit 100
$$;

-- ---------------------------------------------------------------- live "free now"

-- Friends' profile changes (like "free until") reach the app instantly. Realtime applies the
-- profiles rules to each subscriber: only profiles they may see.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles') then
      alter publication supabase_realtime add table public.profiles;
    end if;
  end if;
end
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
                         from public.reports r where r.reporter = auth.uid()), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- grants

revoke all on function public.can_see_author(uuid), public.share_post(text, text, text, text, text), public.delete_post(bigint),
  public.toggle_reaction(bigint, text), public.friend_feed(integer) from public, anon, authenticated;
grant execute on function public.share_post(text, text, text, text, text), public.delete_post(bigint),
  public.toggle_reaction(bigint, text), public.friend_feed(integer) to authenticated;
revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
