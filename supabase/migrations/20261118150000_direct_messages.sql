-- Direct messages between friends, and the lists the app shows (phase 3 of docs/social-plan.md).
--
-- Same rules as before: RLS on every table, explicit grants, and anything that crosses between
-- users goes through checked functions. You can read a conversation only if you're in it, post
-- only as yourself, and only to a friend who hasn't blocked you.

-- ---------------------------------------------------------------- tables

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'direct' check (kind in ('direct')),
  -- "<smaller id>:<larger id>" for a direct chat, so a pair has exactly one.
  direct_key text unique,
  created_at timestamptz not null default now(),
  last_message_at timestamptz
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Messages up to this id have been read (for unread counts).
  last_read_id bigint not null default 0,
  primary key (conversation_id, user_id)
);
create index conversation_members_user on public.conversation_members (user_id);

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Always the signed-in user: there is no grant to set it.
  sender uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  -- Text only, 1 to 2,000 characters; line breaks and tabs allowed, other control characters not.
  body text not null
    check (char_length(body) between 1 and 2000 and btrim(body, E' \n\t') <> '' and body !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  created_at timestamptz not null default now()
);
create index messages_conversation on public.messages (conversation_id, id);
create index messages_sender_time on public.messages (sender, created_at);

-- ---------------------------------------------------------------- helpers

-- Whether the caller is in this conversation. Only answers about the caller.
create function public.is_member(conv uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.conversation_members where conversation_id = conv and user_id = auth.uid())
$$;

create function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted' and ((requester = a and addressee = b) or (requester = b and addressee = a))
  )
$$;

-- The caller may post here: a member, and in a direct chat still friends with the other person
-- (unfriending or blocking stops new messages; the history stays readable).
create function public.can_post(conv uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_member(conv)
    and not exists (
      select 1 from public.conversation_members m
      where m.conversation_id = conv and m.user_id <> auth.uid()
        and (not public.are_friends(auth.uid(), m.user_id) or public.is_blocked(auth.uid(), m.user_id))
    )
$$;

-- ---------------------------------------------------------------- triggers

-- At most 30 messages a minute per person.
create function public.limit_message_rate() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from public.messages where sender = new.sender and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'slow down: too many messages in a minute' using errcode = '54000';
  end if;
  return new;
end
$$;

create trigger messages_rate before insert on public.messages
  for each row execute function public.limit_message_rate();

create function public.touch_conversation() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  -- Your own message counts as read.
  update public.conversation_members set last_read_id = greatest(last_read_id, new.id)
  where conversation_id = new.conversation_id and user_id = new.sender;
  return new;
end
$$;

create trigger messages_touch after insert on public.messages
  for each row execute function public.touch_conversation();

-- ---------------------------------------------------------------- actions

-- The direct chat with a friend, created the first time. Only between accepted friends.
create function public.open_direct(friend uuid) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  key text;
  conv uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if friend = me or not public.are_friends(me, friend) or public.is_blocked(me, friend) then
    raise exception 'you can only message your friends' using errcode = '42501';
  end if;
  key := least(me::text, friend::text) || ':' || greatest(me::text, friend::text);
  insert into public.conversations (kind, direct_key) values ('direct', key) on conflict (direct_key) do nothing;
  select id into conv from public.conversations where direct_key = key;
  insert into public.conversation_members (conversation_id, user_id) values (conv, me), (conv, friend)
  on conflict do nothing;
  return conv;
end
$$;

-- Friends, incoming and outgoing requests, with what the app shows for each. Never anyone else.
create function public.my_friends()
returns table (user_id uuid, state text, display_name text, avatar_icon smallint, avatar_color smallint, bio text, status_text text, since timestamptz)
language sql stable security definer set search_path = ''
as $$
  select p.id,
         case when f.status = 'accepted' then 'friend' when f.requester = auth.uid() then 'outgoing' else 'incoming' end,
         p.display_name, p.avatar_icon, p.avatar_color, p.bio, p.status_text,
         coalesce(f.accepted_at, f.created_at)
  from public.friendships f
  join public.profiles p on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
  where auth.uid() in (f.requester, f.addressee)
    and not public.is_blocked(auth.uid(), p.id)
  order by p.display_name
$$;

-- Your conversations, newest first, with the other person, the last message and unread count.
create function public.my_conversations()
returns table (conversation_id uuid, friend uuid, last_body text, last_sender uuid, last_at timestamptz, unread integer)
language sql stable security definer set search_path = ''
as $$
  select c.id,
         other.user_id,
         last.body,
         last.sender,
         c.last_message_at,
         (select count(*)::int from public.messages m where m.conversation_id = c.id and m.id > me.last_read_id and m.sender <> auth.uid())
  from public.conversation_members me
  join public.conversations c on c.id = me.conversation_id
  join public.conversation_members other on other.conversation_id = c.id and other.user_id <> me.user_id
  left join lateral (
    select body, sender from public.messages m where m.conversation_id = c.id order by m.id desc limit 1
  ) last on true
  where me.user_id = auth.uid()
  order by c.last_message_at desc nulls last
$$;

-- ---------------------------------------------------------------- row level security

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

create policy "see your conversations" on public.conversations
  for select to authenticated using (public.is_member(id));

create policy "see who is in your conversations" on public.conversation_members
  for select to authenticated using (public.is_member(conversation_id));

create policy "mark your own reading" on public.conversation_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "read messages where you are a member" on public.messages
  for select to authenticated using (public.is_member(conversation_id));

create policy "post as yourself where you may" on public.messages
  for insert to authenticated
  with check (sender = (select auth.uid()) and public.can_post(conversation_id));

create policy "delete your own messages" on public.messages
  for delete to authenticated using (sender = (select auth.uid()));

-- ---------------------------------------------------------------- grants (nothing for anon)

revoke all on public.conversations, public.conversation_members, public.messages from anon, authenticated;

grant select on public.conversations to authenticated;
grant select on public.conversation_members to authenticated;
grant update (last_read_id) on public.conversation_members to authenticated;
-- No grant on "sender" or "id": the database sets them.
grant select, delete on public.messages to authenticated;
grant insert (conversation_id, body) on public.messages to authenticated;

revoke all on function
  public.is_member(uuid), public.are_friends(uuid, uuid), public.can_post(uuid),
  public.limit_message_rate(), public.touch_conversation(), public.open_direct(uuid),
  public.my_friends(), public.my_conversations()
from public, anon, authenticated;

-- Used by the rules (answer only about the caller) and by the app.
grant execute on function public.is_member(uuid), public.can_post(uuid) to authenticated;
grant execute on function public.open_direct(uuid), public.my_friends(), public.my_conversations() to authenticated;
