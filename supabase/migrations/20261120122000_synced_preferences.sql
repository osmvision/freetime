-- Your tastes on all your devices, only when you ask: Discover shortcuts, the usual context and
-- what tunes the recommendations (ratings and "not now" answers). The app sends them when you
-- press "Save to my account" and reads them back when you press "Bring them here"; nothing is
-- sent on its own. One row per account, at most 64 KB, deleted with the account.
--
--   save_my_preferences(data) -> saved_at
--   my_preferences()          -> { data, saved_at } or null
--   forget_my_preferences()

create table public.synced_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 65536),
  saved_at timestamptz not null default now()
);

alter table public.synced_preferences enable row level security;
revoke all on public.synced_preferences from public, anon, authenticated;

create function public.save_my_preferences(p_data jsonb) returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  at timestamptz;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'nothing to save' using errcode = '22023';
  end if;
  if octet_length(p_data::text) > 65536 then
    raise exception 'your preferences are too big to save' using errcode = '22023';
  end if;
  insert into public.synced_preferences (user_id, data, saved_at) values (me, p_data, now())
  on conflict (user_id) do update set data = excluded.data, saved_at = excluded.saved_at
  returning saved_at into at;
  return at;
end
$$;

create function public.my_preferences() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('data', p.data, 'saved_at', p.saved_at)
  from public.synced_preferences p where p.user_id = auth.uid()
$$;

create function public.forget_my_preferences() returns void
language sql security definer set search_path = ''
as $$
  delete from public.synced_preferences where user_id = auth.uid()
$$;

-- ---------------------------------------------------------------- export: include them

create or replace function public.export_my_data() returns jsonb
language sql stable security invoker set search_path = ''
return private.export_my_data() || private.my_evening_data() || jsonb_build_object(
  'profile_photo', (
    select 'data:image/png;base64,' || p.image from public.profile_photos p where p.user_id = (select auth.uid())
  ),
  'synced_preferences', public.my_preferences()
);

-- ---------------------------------------------------------------- grants

revoke all on function public.save_my_preferences(jsonb), public.my_preferences(), public.forget_my_preferences()
from public, anon, authenticated;
grant execute on function public.save_my_preferences(jsonb), public.my_preferences(), public.forget_my_preferences()
to authenticated;
revoke all on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
