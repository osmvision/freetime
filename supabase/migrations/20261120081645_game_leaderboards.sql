-- Rank only completed multiplayer results already checked by the game or duel server.
create index matches_rank_player_a on public.matches (game, player_a) include (result) where status = 'done';
create index matches_rank_player_b on public.matches (game, player_b) include (result) where status = 'done';
create index duels_rank_challenger on public.duels (challenger) include (challenger_score, opponent_score) where status = 'done';
create index duels_rank_opponent on public.duels (opponent) include (challenger_score, opponent_score) where status = 'done';

-- RLS on the game tables remains limited to the two participants. Only aggregate results
-- and the public profile fields of an eligible player leave this function.
create function private.game_leaderboard(p_game text, p_scope text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  viewer uuid := auth.uid();
begin
  if viewer is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_game is null or p_game not in ('four', 'gomoku', 'draughts', 'dots', 'torpedoes', 'quiz-duel')
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

revoke all on function private.game_leaderboard(text, text) from public, anon, authenticated;
grant execute on function private.game_leaderboard(text, text) to authenticated;

-- Define the body at creation time, so authenticated callers need no USAGE on private.
create function public.game_leaderboard(p_game text, p_scope text) returns jsonb
language sql stable security invoker set search_path = ''
return private.game_leaderboard(p_game, p_scope);

revoke all on function public.game_leaderboard(text, text) from public, anon, authenticated;
grant execute on function public.game_leaderboard(text, text) to authenticated;
