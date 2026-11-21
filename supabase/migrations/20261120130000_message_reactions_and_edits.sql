-- Reactions on messages between friends, and fixing a typo in a message you sent.
--
-- Reactions live on the message itself ({ "heart": ["<user id>", ...], ... }), so they reach both
-- people through the same channel as the message (Realtime applies the messages' row rules).
-- Editing: only your own message, within 15 minutes of sending it, at most 10 times. The message
-- shows "edited". Earlier versions are kept apart (message_edits), for the freetime team only:
-- editing can't erase what a report points to. They go when the message or the account goes.
--
--   toggle_message_reaction(id, emoji) -> the message's reactions
--   edit_message(id, body)             -> { id, body, edited_at }

alter table public.messages
  add column edited_at timestamptz,
  add column reactions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(reactions) = 'object' and octet_length(reactions::text) <= 2000),
  -- Last edit or reaction: what the app asks for when it catches up without the live connection.
  add column changed_at timestamptz;
create index messages_changed on public.messages (conversation_id, changed_at) where changed_at is not null;

-- Earlier versions of edited messages. No access at all for users: only the team (service role).
create table public.message_edits (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.messages (id) on delete cascade,
  body text not null,
  replaced_at timestamptz not null default now()
);
create index message_edits_message on public.message_edits (message_id);
alter table public.message_edits enable row level security;
revoke all on public.message_edits from public, anon, authenticated;

-- Reaction clicks in the last hour, for the rate limit only.
create table public.message_reaction_log (
  user_id uuid not null references public.profiles (id) on delete cascade,
  at timestamptz not null default now()
);
create index message_reaction_log_user on public.message_reaction_log (user_id, at);
alter table public.message_reaction_log enable row level security;
revoke all on public.message_reaction_log from public, anon, authenticated;

-- ---------------------------------------------------------------- reactions

create function public.toggle_message_reaction(p_id bigint, p_emoji text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  m public.messages;
  people jsonb;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_emoji is null or p_emoji not in ('heart', 'laugh', 'thumbs_up', 'wow', 'sad', 'fire') then
    raise exception 'unknown reaction' using errcode = '22023';
  end if;
  select * into m from public.messages where id = p_id for update;
  -- Only in your own conversations, and only while you can still write there (not blocked,
  -- still friends): the same rule as sending.
  if not found or not public.is_member(m.conversation_id) then
    raise exception 'no such message' using errcode = 'P0002';
  end if;
  if not public.can_post(m.conversation_id) then
    raise exception 'you can''t react in this chat any more' using errcode = '42501';
  end if;
  delete from public.message_reaction_log where user_id = me and at < now() - interval '1 hour';
  if (select count(*) from public.message_reaction_log where user_id = me) >= 200 then
    raise exception 'slow down: too many reactions' using errcode = '54000';
  end if;
  insert into public.message_reaction_log (user_id) values (me);

  people := coalesce(m.reactions -> p_emoji, '[]'::jsonb);
  if people ? me::text then
    people := (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(people) x where x <> me::text);
  else
    people := people || to_jsonb(me::text);
  end if;
  update public.messages
  set reactions = case when jsonb_array_length(people) = 0 then reactions - p_emoji else jsonb_set(reactions, array[p_emoji], people) end,
      changed_at = now()
  where id = p_id
  returning reactions into people;
  return people;
end
$$;

-- ---------------------------------------------------------------- editing

create function public.edit_message(p_id bigint, p_body text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  m public.messages;
  new_body text := btrim(coalesce(p_body, ''), E' \n\t\r');
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into m from public.messages where id = p_id for update;
  if not found or m.sender <> me then
    raise exception 'no such message' using errcode = 'P0002';
  end if;
  if m.created_at < now() - interval '15 minutes' then
    raise exception 'a message can only be edited in the 15 minutes after sending it' using errcode = '22023';
  end if;
  if not public.can_post(m.conversation_id) then
    raise exception 'you can''t write in this chat any more' using errcode = '42501';
  end if;
  if char_length(new_body) not between 1 and 2000 or new_body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'a message has 1 to 2,000 characters' using errcode = '22023';
  end if;
  if new_body = m.body then
    return jsonb_build_object('id', m.id, 'body', m.body, 'edited_at', m.edited_at);
  end if;
  if (select count(*) from public.message_edits where message_id = p_id) >= 10 then
    raise exception 'this message was edited too many times' using errcode = '54000';
  end if;
  insert into public.message_edits (message_id, body) values (p_id, m.body);
  update public.messages set body = new_body, edited_at = now(), changed_at = now() where id = p_id;
  return jsonb_build_object('id', p_id, 'body', new_body, 'edited_at', now());
end
$$;

-- ---------------------------------------------------------------- export: reactions you gave

create or replace function public.export_my_data() returns jsonb
language sql stable security invoker set search_path = ''
return private.export_my_data() || private.my_evening_data() || jsonb_build_object(
  'profile_photo', (
    select 'data:image/png;base64,' || p.image from public.profile_photos p where p.user_id = (select auth.uid())
  ),
  'synced_preferences', public.my_preferences(),
  'message_reactions_you_gave', coalesce((
    select jsonb_agg(jsonb_build_object('message', m.id, 'emoji', e.key) order by m.id, e.key)
    from public.messages m, jsonb_each(m.reactions) e
    where e.value ? (select auth.uid())::text
  ), '[]'::jsonb)
);

-- ---------------------------------------------------------------- grants and live updates

revoke all on function public.toggle_message_reaction(bigint, text), public.edit_message(bigint, text) from public, anon, authenticated;
grant execute on function public.toggle_message_reaction(bigint, text), public.edit_message(bigint, text) to authenticated;
revoke all on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
-- The messages table was already published to Realtime (INSERT); edits and reactions are UPDATEs
-- of the same rows, delivered under the same row rules.
