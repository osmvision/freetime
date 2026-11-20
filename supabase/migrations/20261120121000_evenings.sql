-- Evenings that are easy to organise: one invite with up to two times and up to three things to
-- do. Friends answer with a click (which times work for them, and what they'd rather do), then the
-- host settles on a time and an activity, which shows up in everyone's app.
--
-- Everything goes through the functions below; the tables have no direct access at all.
--   create_evening(slots, activities, note, guests) -> id   only to accepted friends, 1-8 guests,
--                                                           times between now and 14 days ahead,
--                                                           at most 10 evenings an hour
--   answer_evening(id, slots, activity)                     a guest, while the evening is open
--   settle_evening(id, slot, activity)                      the host: picks the time and activity
--   cancel_evening(id)                                      the host
--   my_evenings()                                           the ones you host or were invited to,
--                                                           until 6 hours after their last time

create table public.evenings (
  id bigint generated always as identity primary key,
  host uuid not null references public.profiles (id) on delete cascade,
  slots timestamptz[] not null check (cardinality(slots) between 1 and 2 and array_position(slots, null) is null),
  -- [{ "idea_id": "steam:570", "title": "Dota 2", "category": "game" }, ...]
  activities jsonb not null check (jsonb_typeof(activities) = 'array' and jsonb_array_length(activities) between 1 and 3),
  note text not null default '' check (char_length(note) <= 140 and note !~ '[[:cntrl:]]'),
  status text not null default 'open' check (status in ('open', 'set', 'cancelled')),
  chosen_slot smallint check (chosen_slot between 0 and 1),
  chosen_activity smallint check (chosen_activity between 0 and 2),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  -- Open: nothing chosen yet. Set: a time and an activity. Cancelled: either (it may have been set).
  check (status = 'cancelled'
         or (status = 'open' and chosen_slot is null and chosen_activity is null)
         or (status = 'set' and chosen_slot is not null and chosen_activity is not null))
);
create index evenings_host on public.evenings (host, created_at desc);

create table public.evening_guests (
  evening_id bigint not null references public.evenings (id) on delete cascade,
  guest uuid not null references public.profiles (id) on delete cascade,
  -- One yes/no per time of the evening; null until they answer.
  slots boolean[],
  -- The activity they'd rather do (its position), or null for "any".
  activity smallint check (activity between 0 and 2),
  answered_at timestamptz,
  primary key (evening_id, guest)
);
create index evening_guests_guest on public.evening_guests (guest);

alter table public.evenings enable row level security;
alter table public.evening_guests enable row level security;
revoke all on public.evenings, public.evening_guests from public, anon, authenticated;

-- ---------------------------------------------------------------- create

create function public.create_evening(p_slots timestamptz[], p_activities jsonb, p_note text, p_guests uuid[])
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  slots timestamptz[];
  acts jsonb := '[]'::jsonb;
  a jsonb;
  g uuid;
  guests uuid[];
  new_id bigint;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  -- Times: one or two different ones, from now to two weeks ahead, earliest first.
  select array_agg(distinct t order by t) into slots from unnest(coalesce(p_slots, '{}')) t where t is not null;
  if coalesce(cardinality(slots), 0) not between 1 and 2 or cardinality(slots) <> cardinality(p_slots) then
    raise exception 'pick one or two different times' using errcode = '22023';
  end if;
  if slots[1] < now() - interval '10 minutes' or slots[cardinality(slots)] > now() + interval '14 days' then
    raise exception 'pick times between now and two weeks from now' using errcode = '22023';
  end if;
  -- Activities: one to three, each with a freetime id, a title and a kind.
  if p_activities is null or jsonb_typeof(p_activities) <> 'array' or jsonb_array_length(p_activities) not between 1 and 3 then
    raise exception 'pick one to three things to do' using errcode = '22023';
  end if;
  for a in select value from jsonb_array_elements(p_activities) loop
    if jsonb_typeof(a) <> 'object'
      or coalesce(a->>'idea_id', '') !~ '^[a-z]+:[A-Za-z0-9_.-]{1,72}$'
      or char_length(btrim(coalesce(a->>'title', ''))) not between 1 and 120
      or (a->>'title') ~ '[[:cntrl:]]'
      or coalesce(a->>'category', '') not in ('game', 'video', 'sport', 'learn', 'create', 'chill', 'social', 'food') then
      raise exception 'one of the things to do is not valid' using errcode = '22023';
    end if;
    acts := acts || jsonb_build_array(jsonb_build_object('idea_id', a->>'idea_id', 'title', btrim(a->>'title'), 'category', a->>'category'));
  end loop;
  -- Guests: one to eight accepted friends who haven't blocked you (and whom you haven't blocked).
  select array_agg(distinct x) into guests from unnest(coalesce(p_guests, '{}')) x where x is not null;
  if coalesce(cardinality(guests), 0) not between 1 and 8 then
    raise exception 'invite one to eight friends' using errcode = '22023';
  end if;
  foreach g in array guests loop
    if g = me or not public.are_friends(me, g) or public.is_blocked(me, g) then
      raise exception 'you can only invite your friends' using errcode = '42501';
    end if;
  end loop;
  if (select count(*) from public.evenings e where e.host = me and e.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many evenings in an hour' using errcode = '54000';
  end if;
  insert into public.evenings (host, slots, activities, note)
  values (me, slots, acts, btrim(coalesce(p_note, '')))
  returning id into new_id;
  insert into public.evening_guests (evening_id, guest) select new_id, x from unnest(guests) x;
  return new_id;
end
$$;

-- ---------------------------------------------------------------- answer, settle, cancel

create function public.answer_evening(p_id bigint, p_slots boolean[], p_activity smallint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  e public.evenings;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select ev.* into e from public.evenings ev
  join public.evening_guests eg on eg.evening_id = ev.id and eg.guest = me
  where ev.id = p_id and not public.is_blocked(ev.host, me);
  if not found then
    raise exception 'no such evening' using errcode = 'P0002';
  end if;
  if e.status <> 'open' then
    raise exception 'this evening is already decided' using errcode = '22023';
  end if;
  if p_slots is null or cardinality(p_slots) <> cardinality(e.slots) or array_position(p_slots, null) is not null then
    raise exception 'answer for each time' using errcode = '22023';
  end if;
  if p_activity is not null and (p_activity < 0 or p_activity >= jsonb_array_length(e.activities)) then
    raise exception 'no such activity' using errcode = '22023';
  end if;
  update public.evening_guests set slots = p_slots, activity = p_activity, answered_at = now()
  where evening_id = p_id and guest = me;
end
$$;

create function public.settle_evening(p_id bigint, p_slot smallint, p_activity smallint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  e public.evenings;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into e from public.evenings where id = p_id and host = auth.uid();
  if not found then
    raise exception 'no such evening' using errcode = 'P0002';
  end if;
  if e.status <> 'open' then
    raise exception 'this evening is already decided' using errcode = '22023';
  end if;
  if p_slot is null or p_slot < 0 or p_slot >= cardinality(e.slots)
    or p_activity is null or p_activity < 0 or p_activity >= jsonb_array_length(e.activities) then
    raise exception 'pick one of the times and one of the activities' using errcode = '22023';
  end if;
  update public.evenings set status = 'set', chosen_slot = p_slot, chosen_activity = p_activity, settled_at = now()
  where id = p_id;
end
$$;

create function public.cancel_evening(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  update public.evenings set status = 'cancelled', settled_at = now()
  where id = p_id and host = auth.uid() and status <> 'cancelled';
  if not found then
    raise exception 'no such evening' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------- list

create function public.my_evenings() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x.item order by x.at), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'id', e.id,
        'host', jsonb_build_object('id', hp.id, 'display_name', hp.display_name, 'avatar_icon', hp.avatar_icon, 'avatar_color', hp.avatar_color),
        'mine', e.host = auth.uid(),
        'slots', to_jsonb(e.slots),
        'activities', e.activities,
        'note', e.note,
        'status', e.status,
        'chosen_slot', e.chosen_slot,
        'chosen_activity', e.chosen_activity,
        'guests', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', gp.id, 'display_name', gp.display_name, 'avatar_icon', gp.avatar_icon, 'avatar_color', gp.avatar_color,
                   'slots', to_jsonb(eg.slots), 'activity', eg.activity, 'answered', eg.answered_at is not null,
                   'me', eg.guest = auth.uid())
                 order by gp.display_name, gp.id)
          from public.evening_guests eg
          join public.profiles gp on gp.id = eg.guest
          where eg.evening_id = e.id and not public.is_blocked(auth.uid(), eg.guest)
        ), '[]'::jsonb)
      ) as item,
      coalesce(e.slots[e.chosen_slot + 1], e.slots[1]) as at
    from public.evenings e
    join public.profiles hp on hp.id = e.host
    where (e.host = auth.uid() or exists (select 1 from public.evening_guests eg where eg.evening_id = e.id and eg.guest = auth.uid()))
      and not public.is_blocked(auth.uid(), e.host)
      and coalesce(e.slots[e.chosen_slot + 1], e.slots[cardinality(e.slots)]) > now() - interval '6 hours'
      -- A cancelled evening stays a day, so guests can see it was called off.
      and (e.status <> 'cancelled' or e.settled_at > now() - interval '1 day')
    order by at
    limit 30
  ) x
$$;

-- ---------------------------------------------------------------- export: include evenings

-- Every evening you hosted, and every answer you gave (all of them, not only the recent ones).
create function private.my_evening_data() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'evenings_you_hosted', coalesce((
      select jsonb_agg(jsonb_build_object('slots', e.slots, 'activities', e.activities, 'note', e.note, 'status', e.status,
                                          'chosen_slot', e.chosen_slot, 'chosen_activity', e.chosen_activity, 'created_at', e.created_at,
                                          'guests', (select jsonb_agg(eg.guest) from public.evening_guests eg where eg.evening_id = e.id))
                       order by e.id)
      from public.evenings e where e.host = auth.uid()), '[]'::jsonb),
    'evening_answers', coalesce((
      select jsonb_agg(jsonb_build_object('evening', eg.evening_id, 'slots', eg.slots, 'activity', eg.activity, 'answered_at', eg.answered_at)
                       order by eg.evening_id)
      from public.evening_guests eg where eg.guest = auth.uid()), '[]'::jsonb)
  )
$$;
revoke all on function private.my_evening_data() from public, anon, authenticated;
grant execute on function private.my_evening_data() to authenticated;

create or replace function public.export_my_data() returns jsonb
language sql stable security invoker set search_path = ''
return private.export_my_data() || private.my_evening_data() || jsonb_build_object('profile_photo', (
  select 'data:image/png;base64,' || p.image from public.profile_photos p where p.user_id = (select auth.uid())
));

-- ---------------------------------------------------------------- grants

revoke all on function public.create_evening(timestamptz[], jsonb, text, uuid[]), public.answer_evening(bigint, boolean[], smallint),
  public.settle_evening(bigint, smallint, smallint), public.cancel_evening(bigint), public.my_evenings()
from public, anon, authenticated;
grant execute on function public.create_evening(timestamptz[], jsonb, text, uuid[]), public.answer_evening(bigint, boolean[], smallint),
  public.settle_evening(bigint, smallint, smallint), public.cancel_evening(bigint), public.my_evenings()
to authenticated;
revoke all on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
