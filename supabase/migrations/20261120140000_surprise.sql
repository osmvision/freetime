-- A surprise for one person: the app shows it once, at the next opening, to that account only.
--
-- Surprises are added by the freetime team (dashboard or service role), never from the app.
-- The app can only ask for its own unseen surprise and say it was opened:
--   my_surprise()          -> { id, title, message } (the oldest unseen one), or null
--   surprise_seen(id)      -> marks it seen; it won't show again
-- An opened surprise is part of the data export; an unopened one isn't (it would spoil it).
-- Deleted with the account.

create table public.surprises (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- Both optional: the gift can come without words.
  title text not null default '' check (char_length(title) <= 80 and title !~ '[[:cntrl:]]'),
  message text not null default '' check (char_length(message) <= 500 and message !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  created_at timestamptz not null default now(),
  seen_at timestamptz
);
create index surprises_waiting on public.surprises (user_id, created_at) where seen_at is null;

alter table public.surprises enable row level security;
revoke all on public.surprises from public, anon, authenticated;

create function public.my_surprise() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', s.id, 'title', s.title, 'message', s.message)
  from public.surprises s
  where s.user_id = auth.uid() and s.seen_at is null
  order by s.created_at, s.id
  limit 1
$$;

create function public.surprise_seen(p_id bigint) returns void
language sql security definer set search_path = ''
as $$
  update public.surprises set seen_at = now()
  where id = p_id and user_id = auth.uid() and seen_at is null
$$;

-- ---------------------------------------------------------------- export: opened surprises only

create function private.my_opened_surprises() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('title', s.title, 'message', s.message, 'created_at', s.created_at, 'seen_at', s.seen_at) order by s.id), '[]'::jsonb)
  from public.surprises s
  where s.user_id = auth.uid() and s.seen_at is not null
$$;
revoke all on function private.my_opened_surprises() from public, anon, authenticated;
grant execute on function private.my_opened_surprises() to authenticated;

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
  ), '[]'::jsonb),
  'surprises_you_opened', private.my_opened_surprises()
);

-- ---------------------------------------------------------------- grants

revoke all on function public.my_surprise(), public.surprise_seen(bigint) from public, anon, authenticated;
grant execute on function public.my_surprise(), public.surprise_seen(bigint) to authenticated;
revoke all on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
