alter table public.conversations
  drop constraint conversations_kind_check,
  add column name text,
  add column owner_id uuid references public.profiles (id) on delete set null,
  add constraint conversations_kind_check check (kind in ('direct', 'group')),
  add constraint group_conversation_name check (
    kind <> 'group' or (name is not null and char_length(name) between 1 and 40 and name !~ '[[:cntrl:]]')
  );

alter table public.conversation_members
  add column joined_at timestamptz not null default now(),
  add column history_after_id bigint not null default 0;

-- Old clients continue to receive only direct conversations.
create or replace function public.my_conversations()
returns table (conversation_id uuid, friend uuid, last_body text, last_sender uuid, last_at timestamptz, unread integer)
language sql stable security definer set search_path = ''
as $$
  select c.id, other.user_id, last.body, last.sender, c.last_message_at,
         (select count(*)::int from public.messages m where m.conversation_id = c.id and m.id > me.last_read_id and m.sender <> auth.uid())
  from public.conversation_members me
  join public.conversations c on c.id = me.conversation_id and c.kind = 'direct'
  join public.conversation_members other on other.conversation_id = c.id and other.user_id <> me.user_id
  left join lateral (
    select body, sender from public.messages m where m.conversation_id = c.id order by m.id desc limit 1
  ) last on true
  where me.user_id = auth.uid()
  order by c.last_message_at desc nulls last
$$;

create or replace function public.can_post(conv uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_member(conv) and (
    exists (select 1 from public.conversations c where c.id = conv and c.kind = 'group')
    or not exists (
      select 1 from public.conversation_members m
      where m.conversation_id = conv and m.user_id <> auth.uid()
        and (not public.are_friends(auth.uid(), m.user_id) or public.is_blocked(auth.uid(), m.user_id))
    )
  )
$$;

-- Group blocks hide messages in both directions without freezing the other members' chat.
-- New members start at the current last message, including if they leave and are re-added.
create function private.group_message_visible(conv uuid, author uuid, message_id bigint) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members me
    join public.conversations c on c.id = me.conversation_id
    where me.conversation_id = conv and me.user_id = (select auth.uid())
      and (c.kind = 'direct' or (
        message_id > me.history_after_id and (author = me.user_id or not public.is_blocked(me.user_id, author))
      ))
  )
$$;
revoke all on function private.group_message_visible(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function private.group_message_visible(uuid, uuid, bigint) to authenticated;

alter policy "read messages where you are a member" on public.messages
  using (private.group_message_visible(conversation_id, sender, id));

-- Editing and reacting can write via privileged functions. Keep that path subject to the
-- same group history and block rules as reading the message.
create function private.guard_group_message_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is not null
    and exists (select 1 from public.conversations c where c.id = old.conversation_id and c.kind = 'group')
    and not private.group_message_visible(old.conversation_id, old.sender, old.id) then
    raise exception 'no such message' using errcode = 'P0002';
  end if;
  return new;
end
$$;
revoke all on function private.guard_group_message_update() from public, anon, authenticated;
create trigger messages_guard_group_update before update on public.messages
  for each row execute function private.guard_group_message_update();

create function private.guard_group_report() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
    where m.id = any(new.message_ids) and c.kind = 'group'
      and not private.group_message_visible(m.conversation_id, m.sender, m.id)
  ) then
    raise exception 'those messages can''t be attached' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.guard_group_report() from public, anon, authenticated;
create trigger reports_guard_group before insert on public.reports
  for each row execute function private.guard_group_report();

create function private.group_member_visible(conv uuid, member uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_member(conv) and (
    not exists (select 1 from public.conversations c where c.id = conv and c.kind = 'group')
    or member = (select auth.uid()) or not public.is_blocked((select auth.uid()), member)
  )
$$;
revoke all on function private.group_member_visible(uuid, uuid) from public, anon, authenticated;
grant execute on function private.group_member_visible(uuid, uuid) to authenticated;

alter policy "see who is in your conversations" on public.conversation_members
  using (private.group_member_visible(conversation_id, user_id));

create function private.transfer_group_on_departure() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  owner uuid;
  next_member uuid;
begin
  select c.owner_id into owner from public.conversations c
    where c.id = old.conversation_id and c.kind = 'group' for update;
  if not found or (owner is not null and owner <> old.user_id) then return old; end if;
  select m.user_id into next_member from public.conversation_members m
    where m.conversation_id = old.conversation_id order by m.joined_at, m.user_id limit 1;
  if next_member is null then
    delete from public.conversations where id = old.conversation_id;
  else
    update public.conversations set owner_id = next_member where id = old.conversation_id;
  end if;
  return old;
end
$$;
revoke all on function private.transfer_group_on_departure() from public, anon, authenticated;
create trigger conversation_members_transfer_group after delete on public.conversation_members
  for each row execute function private.transfer_group_on_departure();

create function private.manage_friend_group(p_action text, p_id uuid, p_name text, p_add uuid[], p_remove uuid[]) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  group_id uuid := p_id;
  owner uuid;
  clean_name text := btrim(p_name);
  additions uuid[];
  member_count integer;
  history_cutoff bigint;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('create', 'update', 'leave') then
    raise exception 'unknown group action' using errcode = '22023';
  end if;
  if p_action = 'create' then
    group_id := null;
  else
    select c.owner_id into owner from public.conversations c where c.id = p_id and c.kind = 'group' for update;
    if not found or not public.is_member(p_id) then
      raise exception 'group not found' using errcode = '42501';
    end if;
    if p_action = 'leave' then
      delete from public.conversation_members where conversation_id = p_id and user_id = me;
      return p_id;
    end if;
    if owner is distinct from me then
      raise exception 'only the group owner can edit it' using errcode = '42501';
    end if;
  end if;

  if (p_action = 'create' or p_name is not null)
    and (clean_name is null or char_length(clean_name) not between 1 and 40 or clean_name ~ '[[:cntrl:]]') then
    raise exception 'group name must be 1 to 40 characters' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_add), 0) > 19 or coalesce(cardinality(p_remove), 0) > 19
    or exists (select 1 from unnest(p_add) as a(id) where a.id is null or a.id = me)
    or exists (select 1 from unnest(p_remove) as r(id) where r.id is null or r.id = me or r.id = any(p_add)) then
    raise exception 'invalid group members' using errcode = '22023';
  end if;
  select array(select distinct a.id from unnest(p_add) as a(id)
    where not exists (select 1 from public.conversation_members m where m.conversation_id = group_id and m.user_id = a.id))
    into additions;
  if exists (select 1 from unnest(additions) as a(id)
    where not public.are_friends(me, a.id) or public.is_blocked(me, a.id)) then
    raise exception 'you can only add your friends to a group' using errcode = '42501';
  end if;

  if p_action = 'create' then
    if cardinality(additions) < 2 then
      raise exception 'choose at least two friends' using errcode = '22023';
    end if;
    insert into public.conversations (kind, name, owner_id) values ('group', clean_name, me) returning id into group_id;
    insert into public.conversation_members (conversation_id, user_id) values (group_id, me);
  else
    delete from public.conversation_members
      where conversation_id = group_id and user_id = any(p_remove);
    if p_name is not null then update public.conversations set name = clean_name where id = group_id; end if;
  end if;
  select count(*) into member_count from public.conversation_members where conversation_id = group_id;
  if member_count + cardinality(additions) > 20 then
    raise exception 'a group can have up to 20 members' using errcode = '22023';
  end if;
  select coalesce(max(id), 0) into history_cutoff from public.messages where conversation_id = group_id;
  insert into public.conversation_members (conversation_id, user_id, last_read_id, history_after_id)
    select group_id, a.id, history_cutoff, history_cutoff from unnest(additions) as a(id);
  return group_id;
end
$$;
revoke all on function private.manage_friend_group(text, uuid, text, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function private.manage_friend_group(text, uuid, text, uuid[], uuid[]) to authenticated;

create function public.manage_friend_group(p_action text, p_id uuid, p_name text, p_add uuid[], p_remove uuid[]) returns uuid
language sql security invoker set search_path = ''
return private.manage_friend_group(p_action, p_id, p_name, p_add, p_remove);
revoke all on function public.manage_friend_group(text, uuid, text, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.manage_friend_group(text, uuid, text, uuid[], uuid[]) to authenticated;

create function private.friend_group_members(group_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', p.id, 'display_name', p.display_name, 'avatar_icon', p.avatar_icon, 'avatar_color', p.avatar_color
  ) order by p.display_name, p.id), '[]'::jsonb)
  from public.conversations c
  join public.conversation_members m on m.conversation_id = c.id
  join public.profiles p on p.id = m.user_id
  where c.id = group_id and c.kind = 'group' and public.is_member(c.id)
    and (p.id = (select auth.uid()) or not public.is_blocked((select auth.uid()), p.id))
$$;
revoke all on function private.friend_group_members(uuid) from public, anon, authenticated;
grant execute on function private.friend_group_members(uuid) to authenticated;

create function public.my_friend_groups() returns jsonb
language sql stable security invoker set search_path = ''
begin atomic
  select coalesce(jsonb_agg(to_jsonb(g) order by g.last_at desc nulls last, g.name), '[]'::jsonb)
  from (
    select c.id as conversation_id, c.name, coalesce(c.owner_id = (select auth.uid()), false) as owned,
      last.body as last_body, last.sender as last_sender, last.created_at as last_at,
      (select count(*) from public.messages m where m.conversation_id = c.id and m.id > me.last_read_id and m.sender <> me.user_id) as unread,
      private.friend_group_members(c.id) as members
    from public.conversation_members me
    join public.conversations c on c.id = me.conversation_id and c.kind = 'group'
    left join lateral (
      select m.body, m.sender, m.created_at from public.messages m where m.conversation_id = c.id order by m.id desc limit 1
    ) last on true
    where me.user_id = (select auth.uid())
  ) g;
end;
revoke all on function public.my_friend_groups() from public, anon, authenticated;
grant execute on function public.my_friend_groups() to authenticated;

alter function public.export_my_data() rename to export_my_data_before_groups;
alter function public.export_my_data_before_groups() set schema private;

create function public.export_my_data() returns jsonb
language sql stable security invoker set search_path = ''
return private.export_my_data_before_groups() || jsonb_build_object('groups', (
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'joined_at', m.joined_at,
    'owned', c.owner_id = (select auth.uid())) order by m.joined_at), '[]'::jsonb)
  from public.conversation_members m join public.conversations c on c.id = m.conversation_id
  where c.kind = 'group' and m.user_id = (select auth.uid())
));
revoke all on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
