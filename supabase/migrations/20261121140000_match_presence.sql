-- Live games: is the other player in the game right now ("Sam is here")?
--
-- While a game with a friend is open, the app calls match_here every few seconds: it notes that
-- you are there and says how long ago the other player last was. Only the two players of the
-- game, never across a block. One row per player and game, deleted with the game or the account;
-- a day-old row is dropped the next time you call. Part of "Export my data".

create table public.match_presence (
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table public.match_presence enable row level security;

create policy "see your own presence" on public.match_presence
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.match_presence from anon, authenticated;
grant select on public.match_presence to authenticated;

create function public.match_here(p_match uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  m public.matches;
  other uuid;
  seen timestamptz;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into m from public.matches where id = p_match;
  if m.id is null or me not in (m.player_a, m.player_b) then
    raise exception 'no such game' using errcode = 'P0002';
  end if;
  other := case when m.player_a = me then m.player_b else m.player_a end;
  if public.is_blocked(me, other) then
    return jsonb_build_object('other_seconds', null);
  end if;
  delete from public.match_presence where user_id = me and seen_at < now() - interval '1 day';
  insert into public.match_presence (match_id, user_id, seen_at) values (p_match, me, now())
  on conflict (match_id, user_id) do update set seen_at = now();
  select p.seen_at into seen from public.match_presence p where p.match_id = p_match and p.user_id = other;
  return jsonb_build_object('other_seconds', case when seen is null then null else floor(extract(epoch from now() - seen))::integer end);
end
$$;

revoke all on function public.match_here(uuid) from public, anon, authenticated;
grant execute on function public.match_here(uuid) to authenticated;

-- ---------------------------------------------------------------- export

alter function public.export_my_data() rename to export_my_data_before_presence;
alter function public.export_my_data_before_presence() set schema private;

create function public.export_my_data() returns jsonb
language sql stable security invoker set search_path = ''
return private.export_my_data_before_presence() || jsonb_build_object('game_presence', (
  select coalesce(jsonb_agg(jsonb_build_object('match', p.match_id, 'seen_at', p.seen_at) order by p.seen_at), '[]'::jsonb)
  from public.match_presence p
  where p.user_id = (select auth.uid())
));
revoke all on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
