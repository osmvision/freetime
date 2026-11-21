// What the games Edge Function does, without Deno or HTTP (so it can be tested with Node):
// starts games and checks moves with the shared rules, then saves them through the database
// functions only the service role may call (supabase/migrations/*_turn_based_games.sql).
//
//   { "action": "start", "game": "four", "opponent": "<uuid>", "fleet": {...} (Torpedoes),
//     "options": {...} (a variant, checked by the rules) }
//   { "action": "move", "match": "<uuid>", "version": 3, "move": {...} }
//   { "action": "flag", "match": "<uuid>" }   (a clock ran out: the game ends on time)
//
// A live game has a clock (`clock` at the start: 180, 300 or 600 seconds each). The server keeps
// the time: `state.clock` = { limit, left: [ms, ms], since, moved: [bool, bool] }, `since` being
// when the clock of the player to move started. Each player's first move is free (so a friend who
// hasn't joined yet can't lose on time). A move made after your time ran out loses the game on
// time; either player may also ask the server to call it ("flag").
//
// `db.rpc(name, args)` answers like supabase-js: { data, error }.

import { GAMES, IllegalMove, newGame, play } from './rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BODY = 4000;

export class GameError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Database errors, as the app should see them. */
function dbError(error) {
  const known = {
    P0002: [404, 'not_found'],
    23505: [409, 'already'],
    54000: [429, 'too_many'],
    40001: [409, 'stale'],
    22023: [409, 'over'],
  };
  const [status, code] = known[error?.code] ?? [502, 'database'];
  return new GameError(status, code, status === 502 ? 'The game server is having trouble.' : error.message);
}

async function save(db, userId, m, state, secret) {
  const saved = await db.rpc('match_save', {
    p_user: userId,
    p_match: m.id,
    p_version: m.version,
    p_state: state,
    p_turn: state.turn,
    p_result: resultOf(state.winner),
    p_secret: secret,
  });
  if (saved.error) throw dbError(saved.error);
  return { state, version: saved.data };
}

const resultOf = (winner) => (winner === null ? null : winner === 'draw' ? 'draw' : winner === 0 ? 'a' : 'b');

/** The clocks a live game may have, in seconds (not Torpedoes: the fleets take their own time). */
export const CLOCKS = [180, 300, 600];

/** The state after `loser` ran out of time: the other player wins. */
function timedOut(state, loser) {
  const left = state.clock.left.slice();
  left[loser] = 0;
  return { ...state, clock: { ...state.clock, left, since: null }, turn: null, winner: 1 - loser, timeout: loser };
}

export async function handle(db, userId, body, random = Math.random, now = Date.now) {
  if (!body || typeof body !== 'object') throw new GameError(400, 'bad_request', 'Send a JSON body.');
  try {
    if (body.action === 'start') {
      if (!GAMES.includes(body.game)) throw new GameError(400, 'bad_request', 'Unknown game.');
      if (typeof body.opponent !== 'string' || !UUID.test(body.opponent)) throw new GameError(400, 'bad_request', 'Pick a friend to play with.');
      // Who moves first is drawn here (Torpedoes: the challenger places first, then shoots first).
      if (body.clock !== undefined && body.clock !== null && (!CLOCKS.includes(body.clock) || body.game === 'torpedoes')) {
        throw new GameError(400, 'bad_request', 'A clock is 3, 5 or 10 minutes (and not for Torpedoes).');
      }
      let state = newGame(body.game, random() < 0.5 ? 0 : 1, body.options ?? null);
      let secret = null;
      if (body.game === 'torpedoes') ({ state, secret } = play(state, 0, { fleet: body.fleet }));
      if (body.clock) state = { ...state, clock: { limit: body.clock * 1000, left: [body.clock * 1000, body.clock * 1000], since: null, moved: [false, false] } };
      const { data, error } = await db.rpc('match_open', {
        p_user: userId,
        p_opponent: body.opponent,
        p_game: body.game,
        p_state: state,
        p_turn: state.turn,
        p_secret: secret,
      });
      if (error) throw dbError(error);
      return { id: data, state, version: 0 };
    }

    if (body.action === 'move') {
      if (typeof body.match !== 'string' || !UUID.test(body.match) || !Number.isInteger(body.version)) {
        throw new GameError(400, 'bad_request', 'Which game?');
      }
      const { data: m, error } = await db.rpc('match_load', { p_user: userId, p_match: body.match });
      if (error) throw dbError(error);
      if (!m) throw new GameError(404, 'not_found', 'No such game.');
      if (!m.open) throw new GameError(409, 'over', 'This game is over.');
      if (m.version !== body.version) throw new GameError(409, 'stale', 'The game changed meanwhile: reload it.');
      const t = now();
      const clock = m.state.clock;
      // Too late: the move doesn't count, the game is lost on time.
      if (clock?.since != null && clock.moved[m.player] && m.state.turn === m.player && t - clock.since >= clock.left[m.player]) {
        return await save(db, userId, m, timedOut(m.state, m.player), null);
      }
      const r = play(m.state, m.player, body.move, m.secrets ?? [null, null]);
      if (clock) {
        const left = clock.left.slice();
        if (clock.since != null && clock.moved[m.player]) left[m.player] -= t - clock.since;
        const moved = clock.moved.slice();
        moved[m.player] = true;
        r.state = { ...r.state, clock: { ...clock, left, moved, since: r.state.winner === null ? t : null } };
      }
      return await save(db, userId, m, r.state, r.secret);
    }

    if (body.action === 'flag') {
      if (typeof body.match !== 'string' || !UUID.test(body.match)) throw new GameError(400, 'bad_request', 'Which game?');
      const { data: m, error } = await db.rpc('match_load', { p_user: userId, p_match: body.match });
      if (error) throw dbError(error);
      if (!m) throw new GameError(404, 'not_found', 'No such game.');
      if (!m.open) throw new GameError(409, 'over', 'This game is over.');
      const clock = m.state.clock;
      const turn = m.state.turn;
      if (clock?.since == null || turn === null || !clock.moved[turn] || now() - clock.since < clock.left[turn]) {
        throw new GameError(409, 'not_yet', 'The clock is still running.');
      }
      return await save(db, userId, m, timedOut(m.state, turn), null);
    }

    throw new GameError(400, 'bad_request', 'Unknown action.');
  } catch (e) {
    if (e instanceof IllegalMove) throw new GameError(422, 'illegal', e.message);
    throw e;
  }
}
