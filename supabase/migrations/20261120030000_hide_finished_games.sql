-- Clearing your history of games with friends: one finished game, or all of them at once.
--
-- A game belongs to two people, so "deleting" it only hides it for the one who asks: the other
-- player keeps theirs, and the rankings (which count finished games) stay right. Only finished
-- games can be hidden (done, declined, cancelled, or expired); one still going cannot.

alter table public.matches
  add column hidden_a boolean not null default false,
  add column hidden_b boolean not null default false;

-- my_matches() again, without the games you cleared.
create or replace function public.my_matches() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x.item order by x.rank, x.at desc), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'id', m.id,
        'game', m.game,
        'me', s.me,
        'challenger', s.me = 0,
        'other', jsonb_build_object('id', p.id, 'display_name', p.display_name, 'avatar_icon', p.avatar_icon, 'avatar_color', p.avatar_color),
        'state', m.state,
        'version', m.version,
        'b_moved', m.b_moved,
        'phase', s.phase,
        'outcome', s.outcome,
        -- Your own fleet (Torpedoes), never the other player's.
        'my_secret', (select ms.secret from public.match_secrets ms where ms.match_id = m.id and ms.player = s.me),
        'updated_at', m.updated_at
      ) as item,
      case s.phase when 'your_turn' then 0 when 'waiting' then 1 else 2 end as rank,
      m.updated_at as at
    from public.matches m
    join public.profiles p on p.id = case when m.player_a = auth.uid() then m.player_b else m.player_a end
    cross join lateral (select case when m.player_a = auth.uid() then 0 else 1 end::smallint as me) w
    cross join lateral (
      select
        w.me,
        case
          when public.match_expired(m) or m.status <> 'active' then 'over'
          when m.turn = w.me then 'your_turn'
          else 'waiting'
        end as phase,
        case
          when public.match_expired(m) then 'expired'
          when m.status in ('declined', 'cancelled') then m.status
          when m.result = 'draw' then 'draw'
          when m.result = (case when w.me = 0 then 'a' else 'b' end) then 'won'
          when m.result is not null then 'lost'
        end as outcome
    ) s
    where auth.uid() in (m.player_a, m.player_b)
      and not public.is_blocked(m.player_a, m.player_b)
      and not (case when w.me = 0 then m.hidden_a else m.hidden_b end)
      and (m.status = 'active' or m.updated_at > now() - interval '30 days')
    order by rank, at desc
    limit 50
  ) x
$$;

-- Clears one finished game from your list.
create function public.hide_match(p_match uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  m public.matches;
begin
  select * into m from public.matches where id = p_match for update;
  if me is null or m.id is null or me not in (m.player_a, m.player_b) then
    raise exception 'no such game' using errcode = 'P0002';
  end if;
  if m.status = 'active' and not public.match_expired(m) then
    raise exception 'this game is not over' using errcode = '22023';
  end if;
  if me = m.player_a then
    update public.matches set hidden_a = true where id = m.id;
  else
    update public.matches set hidden_b = true where id = m.id;
  end if;
end
$$;

-- Clears every finished game from your list. Returns how many.
create function public.hide_finished_matches() returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  n integer := 0;
  k integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  update public.matches m set hidden_a = true
  where m.player_a = me and not m.hidden_a and (m.status <> 'active' or public.match_expired(m));
  get diagnostics k = row_count;
  n := k;
  update public.matches m set hidden_b = true
  where m.player_b = me and not m.hidden_b and (m.status <> 'active' or public.match_expired(m));
  get diagnostics k = row_count;
  return n + k;
end
$$;

revoke all on function public.hide_match(uuid), public.hide_finished_matches() from public, anon, authenticated;
grant execute on function public.hide_match(uuid), public.hide_finished_matches() to authenticated;
