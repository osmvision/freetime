-- Profiles, friends and blocks (phase 2 of docs/social-plan.md).
--
-- Deny by default: Row Level Security is on for every table, the API roles get only the grants
-- written here (automatic grants are off in the project), and anything that crosses from one
-- user to another (friend requests) goes through a checked function, never a direct insert.

-- ---------------------------------------------------------------- friend tags

-- What you share to be added as a friend, like "7F3A9-C21DE". 40 random bits: not guessable,
-- and it says nothing about you. It can be reset if it leaks.
create function public.new_friend_tag() returns text
language sql volatile set search_path = ''
as $$
  select upper(substr(r, 1, 5) || '-' || substr(r, 6, 5))
  from (select replace(gen_random_uuid()::text, '-', '') as r) t
$$;

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  -- No real name is copied from the login provider: you choose what others see.
  display_name text not null default 'Friend'
    check (char_length(btrim(display_name)) between 1 and 24 and display_name !~ '[[:cntrl:]]'),
  -- Indexes into the lists in desktop/ui/js/avatars.js (same limits as core/src/party.rs).
  avatar_icon smallint not null default 0 check (avatar_icon between 0 and 23),
  avatar_color smallint not null default 0 check (avatar_color between 0 and 7),
  bio text not null default '' check (char_length(bio) <= 160 and bio !~ '[[:cntrl:]]'),
  status_text text not null default '' check (char_length(status_text) <= 60 and status_text !~ '[[:cntrl:]]'),
  -- "Free until": set when you mark yourself free tonight.
  free_until timestamptz,
  friend_tag text not null unique default public.new_friend_tag(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.friendships (
  requester uuid not null references public.profiles (id) on delete cascade,
  addressee uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- One row per pair, whoever asked first.
create unique index friendships_one_per_pair on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index friendships_addressee on public.friendships (addressee);

create table public.blocks (
  blocker uuid not null references public.profiles (id) on delete cascade,
  blocked uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);

-- ---------------------------------------------------------------- helpers (used by the rules)

-- Either of the two blocked the other. Internal: not callable through the API.
create function public.is_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.blocks
    where (blocker = a and blocked = b) or (blocker = b and blocked = a)
  )
$$;

-- Whether the signed-in user may see this profile: their own, or someone they have a friendship
-- or a pending request with, unless either blocked the other. Only answers for the caller, so
-- it can't be used to probe other people's friendships.
create function public.can_see_profile(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select target = auth.uid()
    or (
      exists (
        select 1 from public.friendships f
        where (f.requester = auth.uid() and f.addressee = target)
           or (f.requester = target and f.addressee = auth.uid())
      )
      and not public.is_blocked(auth.uid(), target)
    )
$$;

-- ---------------------------------------------------------------- triggers

-- Every new account gets a profile with neutral defaults (no data from Google or Discord).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

create function public.stamp_accepted() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.status = 'accepted' and old.status <> 'accepted' then
    new.accepted_at := now();
  end if;
  return new;
end
$$;

create trigger friendships_stamp before update on public.friendships
  for each row execute function public.stamp_accepted();

-- Blocking someone also ends any friendship or request between you.
create function public.end_friendship_on_block() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.friendships
  where (requester = new.blocker and addressee = new.blocked)
     or (requester = new.blocked and addressee = new.blocker);
  return new;
end
$$;

create trigger blocks_end_friendship after insert on public.blocks
  for each row execute function public.end_friendship_on_block();

-- ---------------------------------------------------------------- actions

-- Sends a friend request to whoever owns this tag. If they already asked you, you become friends.
-- Returns 'pending' or 'accepted'. Unknown tags, your own tag and blocked people all get the same
-- answer, so the function can't be used to learn who blocked whom.
create function public.send_friend_request(tag text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  them uuid;
  existing text;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select id into them from public.profiles where friend_tag = upper(btrim(tag));
  if them is null or them = me or public.is_blocked(me, them) then
    raise exception 'no one has that friend tag' using errcode = 'P0002';
  end if;

  select status into existing from public.friendships where requester = me and addressee = them;
  if existing is not null then
    return existing;
  end if;

  select status into existing from public.friendships where requester = them and addressee = me;
  if existing = 'pending' then
    update public.friendships set status = 'accepted' where requester = them and addressee = me;
    return 'accepted';
  elsif existing = 'accepted' then
    return 'accepted';
  end if;

  if (select count(*) from public.friendships where requester = me and status = 'pending') >= 20 then
    raise exception 'too many friend requests are waiting for an answer' using errcode = '54000';
  end if;
  insert into public.friendships (requester, addressee) values (me, them);
  return 'pending';
end
$$;

-- A new friend tag, if the old one was shared too widely. Existing friends stay friends.
create function public.reset_friend_tag() returns text
language plpgsql security definer set search_path = ''
as $$
declare
  tag text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  update public.profiles set friend_tag = public.new_friend_tag() where id = auth.uid() returning friend_tag into tag;
  return tag;
end
$$;

-- ---------------------------------------------------------------- row level security

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;

create policy "see yourself, friends and requests" on public.profiles
  for select to authenticated using (public.can_see_profile(id));

create policy "edit your own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "see your own friendships and requests" on public.friendships
  for select to authenticated using ((select auth.uid()) in (requester, addressee));

-- Accepting is the only change allowed, and only by the person who was asked.
create policy "accept a request sent to you" on public.friendships
  for update to authenticated
  using (addressee = (select auth.uid()) and status = 'pending')
  with check (addressee = (select auth.uid()) and status = 'accepted');

-- Decline, cancel or unfriend.
create policy "leave a friendship or request" on public.friendships
  for delete to authenticated using ((select auth.uid()) in (requester, addressee));

create policy "see who you blocked" on public.blocks
  for select to authenticated using (blocker = (select auth.uid()));

create policy "block someone" on public.blocks
  for insert to authenticated with check (blocker = (select auth.uid()));

create policy "unblock" on public.blocks
  for delete to authenticated using (blocker = (select auth.uid()));

-- ---------------------------------------------------------------- grants (nothing for anon)

revoke all on public.profiles, public.friendships, public.blocks from anon, authenticated;

grant select on public.profiles to authenticated;
-- Only these columns can be edited: never id, friend_tag (use reset_friend_tag) or timestamps.
grant update (display_name, avatar_icon, avatar_color, bio, status_text, free_until) on public.profiles to authenticated;

grant select, delete on public.friendships to authenticated;
grant update (status) on public.friendships to authenticated;

grant select, insert, delete on public.blocks to authenticated;

revoke all on function
  public.new_friend_tag(), public.is_blocked(uuid, uuid), public.can_see_profile(uuid),
  public.handle_new_user(), public.touch_updated_at(), public.stamp_accepted(),
  public.end_friendship_on_block(), public.send_friend_request(text), public.reset_friend_tag()
from public, anon, authenticated;

-- The rules call can_see_profile as the signed-in user; it only ever answers about the caller.
grant execute on function public.can_see_profile(uuid) to authenticated;
grant execute on function public.send_friend_request(text), public.reset_friend_tag() to authenticated;
