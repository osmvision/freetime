-- A real end of game: your record against this friend, and chess on the leaderboards.
--
-- head_to_head(other, game): wins, draws and losses between you and one friend (finished games,
--   all time, cleared ones included: clearing a game only hides it from your list), and the last
--   five results. Only your own games are counted; a blocked person gets nothing.
-- game_leaderboard: chess joins the games that are ranked (it was playable but not ranked).

create function public.head_to_head(p_other uuid, p_game text default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_other is null or p_other = me then
    raise exception 'pick a friend' using errcode = '22023';
  end if;
  if p_game is not null and p_game not in ('four', 'gomoku', 'draughts', 'dots', 'torpedoes', 'chess') then
    raise exception 'unknown game' using errcode = '22023';
  end if;
  if public.is_blocked(me, p_other) then
    return jsonb_build_object('wins', 0, 'draws', 0, 'losses', 0, 'last', '[]'::jsonb);
  end if;
  return (
    with games as (
      select m.game, m.updated_at as at,
        case
          when m.result = 'draw' then 'draw'
          when m.result = (case when m.player_a = me then 'a' else 'b' end) then 'won'
          else 'lost'
        end as outcome
      from public.matches m
      where m.status = 'done' and m.result is not null
        and ((m.player_a = me and m.player_b = p_other) or (m.player_a = p_other and m.player_b = me))
        and (p_game is null or m.game = p_game)
    )
    select jsonb_build_object(
      'wins', (select count(*) from games where outcome = 'won'),
      'draws', (select count(*) from games where outcome = 'draw'),
      'losses', (select count(*) from games where outcome = 'lost'),
      'last', coalesce((select jsonb_agg(jsonb_build_object('game', g.game, 'outcome', g.outcome, 'at', g.at) order by g.at desc)
                        from (select * from games order by at desc limit 5) g), '[]'::jsonb)
    )
  );
end
$$;

revoke all on function public.head_to_head(uuid, text) from public, anon, authenticated;
grant execute on function public.head_to_head(uuid, text) to authenticated;

-- ---------------------------------------------------------------- chess on the leaderboards

-- Same as 20261120081645_game_leaderboards.sql, with 'chess' in the list of games.
create or replace function private.game_leaderboard(p_game text, p_scope text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  viewer uuid := auth.uid();
begin
  if viewer is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_game is null or p_game not in ('four', 'gomoku', 'draughts', 'dots', 'torpedoes', 'chess', 'quiz-duel')
    or p_scope is null or p_scope not in ('friends', 'global') then
    raise exception 'unknown game leaderboard' using errcode = '22023';
  end if;
  return (
    with candidates as (
      select viewer as id where p_scope = 'friends'
      union all
      select f.addressee from public.friendships f
      where p_scope = 'friends' and f.status = 'accepted' and f.requester = viewer
      union all
      select f.requester from public.friendships f
      where p_scope = 'friends' and f.status = 'accepted' and f.addressee = viewer
      union all
      select p.id from public.profiles p where p_scope = 'global' and p.show_in_global
    ),
    visible as (
      select c.id from candidates c where not public.is_blocked(viewer, c.id)
    ),
    results as (
      select v.id, case m.result when 'a' then 1 when 'b' then -1 else 0 end as outcome
      from visible v join public.matches m on m.player_a = v.id
      where m.game = p_game and m.status = 'done'
      union all
      select v.id, case m.result when 'b' then 1 when 'a' then -1 else 0 end
      from visible v join public.matches m on m.player_b = v.id
      where m.game = p_game and m.status = 'done'
      union all
      select v.id, sign(d.challenger_score - d.opponent_score)
      from visible v join public.duels d on d.challenger = v.id
      where p_game = 'quiz-duel' and d.status = 'done' and d.challenger_score is not null and d.opponent_score is not null
      union all
      select v.id, sign(d.opponent_score - d.challenger_score)
      from visible v join public.duels d on d.opponent = v.id
      where p_game = 'quiz-duel' and d.status = 'done' and d.challenger_score is not null and d.opponent_score is not null
    ),
    totals as (
      select id,
        count(*) filter (where outcome = 1) as wins,
        count(*) filter (where outcome = 0) as draws,
        count(*) filter (where outcome = -1) as losses
      from results group by id
    ),
    scored as (
      select p.id, p.display_name, p.avatar_icon, p.avatar_color,
        t.wins, t.draws, t.losses, 3 * t.wins + t.draws as points, p.id = viewer as me
      from totals t join public.profiles p on p.id = t.id
    ),
    ranked as (
      select s.*, rank() over (order by s.points desc) as rank,
        row_number() over (order by s.points desc, s.display_name, s.id) as position
      from scored s
    )
    select jsonb_build_object(
      'show_in_global', coalesce((select p.show_in_global from public.profiles p where p.id = viewer), false),
      'rows', coalesce(jsonb_agg(to_jsonb(r) - 'id' - 'position' order by r.position), '[]'::jsonb)
    )
    from ranked r where r.position <= 100 or r.me
  );
end
$$;
