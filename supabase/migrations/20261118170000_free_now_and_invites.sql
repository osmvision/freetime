-- "Free now" and ticket invites (step 2, the hook: doing things together).
--
-- set_free(minutes): tells your friends you're free until now + minutes (0 = not free).
-- my_friends(): now also returns free_until, so the app can show who is free.
-- invites: send a pick ("Hades at 21:00") to a friend; they accept or decline, you can cancel.
--   Only to accepted friends who haven't blocked you, at most 30 an hour.

-- ---------------------------------------------------------------- free now

create function public.set_free(minutes integer) returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  until timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  until := case when coalesce(minutes, 0) <= 0 then null else now() + make_interval(mins => least(minutes, 600)) end;
  update public.profiles set free_until = until where id = auth.uid();
  return until;
end
$$;

-- Same as before, plus free_until (only when it's still in the future).
drop function public.my_friends();
create function public.my_friends()
returns table (user_id uuid, state text, display_name text, avatar_icon smallint, avatar_color smallint, bio text, status_text text, since timestamptz, free_until timestamptz)
language sql stable security definer set search_path = ''
as $$
  select p.id,
         case when f.status = 'accepted' then 'friend' when f.requester = auth.uid() then 'outgoing' else 'incoming' end,
         p.display_name, p.avatar_icon, p.avatar_color, p.bio, p.status_text,
         coalesce(f.accepted_at, f.created_at),
         case when f.status = 'accepted' and p.free_until > now() then p.free_until end
  from public.friendships f
  join public.profiles p on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
  where auth.uid() in (f.requester, f.addressee)
    and not public.is_blocked(auth.uid(), p.id)
  order by p.display_name
$$;

-- ---------------------------------------------------------------- invites

create table public.invites (
  id bigint generated always as identity primary key,
  from_user uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  -- The pick: its id in freetime ("idea:run-5k", "steam:570"…), title and kind.
  idea_id text not null check (char_length(idea_id) <= 80 and idea_id ~ '^[a-z]+:[A-Za-z0-9_.-]+$'),
  title text not null check (char_length(btrim(title)) between 1 and 120 and title !~ '[[:cntrl:]]'),
  category text not null check (category in ('game', 'video', 'sport', 'learn', 'create', 'chill', 'social', 'food')),
  starts_at timestamptz not null,
  note text not null default '' check (char_length(note) <= 140 and note !~ '[[:cntrl:]]'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  check (from_user <> to_user)
);
create index invites_to on public.invites (to_user, created_at desc);
create index invites_from on public.invites (from_user, created_at desc);

-- Whether the caller may invite this person: an accepted friend, no block either way.
create function public.can_invite(target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.are_friends(auth.uid(), target) and not public.is_blocked(auth.uid(), target)
$$;

create function public.check_invite() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.starts_at < now() - interval '10 minutes' or new.starts_at > now() + interval '7 days' then
      raise exception 'pick a time between now and next week' using errcode = '22023';
    end if;
    if (select count(*) from public.invites where from_user = new.from_user and created_at > now() - interval '1 hour') >= 30 then
      raise exception 'too many invites in an hour' using errcode = '54000';
    end if;
  else
    new.answered_at := now();
  end if;
  return new;
end
$$;

create trigger invites_check before insert or update on public.invites
  for each row execute function public.check_invite();

alter table public.invites enable row level security;

create policy "invite a friend" on public.invites
  for insert to authenticated
  with check (from_user = (select auth.uid()) and public.can_invite(to_user));

create policy "see invites you sent or got" on public.invites
  for select to authenticated using ((select auth.uid()) in (from_user, to_user));

create policy "answer an invite sent to you" on public.invites
  for update to authenticated
  using (to_user = (select auth.uid()) and status = 'pending')
  with check (to_user = (select auth.uid()) and status in ('accepted', 'declined'));

create policy "cancel an invite you sent" on public.invites
  for update to authenticated
  using (from_user = (select auth.uid()) and status in ('pending', 'accepted'))
  with check (from_user = (select auth.uid()) and status = 'cancelled');

-- Recent invites (not older than a day past their time), with the other person's name and look.
create function public.my_invites()
returns table (id bigint, direction text, other uuid, other_name text, other_icon smallint, other_color smallint,
               idea_id text, title text, category text, starts_at timestamptz, note text, status text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select i.id,
         case when i.to_user = auth.uid() then 'incoming' else 'outgoing' end,
         p.id, p.display_name, p.avatar_icon, p.avatar_color,
         i.idea_id, i.title, i.category, i.starts_at, i.note, i.status, i.created_at
  from public.invites i
  join public.profiles p on p.id = case when i.to_user = auth.uid() then i.from_user else i.to_user end
  where auth.uid() in (i.from_user, i.to_user)
    and i.starts_at > now() - interval '1 day'
    and not public.is_blocked(auth.uid(), p.id)
  order by i.starts_at
$$;

-- ---------------------------------------------------------------- export: include invites

create or replace function public.export_my_data() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'exported_at', now(),
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at)
                from auth.users u where u.id = auth.uid()),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = auth.uid()),
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

revoke all on public.invites from anon, authenticated;
grant select on public.invites to authenticated;
grant insert (to_user, idea_id, title, category, starts_at, note) on public.invites to authenticated;
grant update (status) on public.invites to authenticated;

revoke all on function public.set_free(integer), public.my_friends(), public.can_invite(uuid), public.check_invite(), public.my_invites()
from public, anon, authenticated;
grant execute on function public.set_free(integer), public.my_friends(), public.can_invite(uuid), public.my_invites() to authenticated;
-- create or replace keeps the old grants, but be explicit.
revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
