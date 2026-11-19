// What the games Edge Function does, without Deno or HTTP (so it can be tested with Node):
// starts games and checks moves with the shared rules, then saves them through the database
// functions only the service role may call (supabase/migrations/*_turn_based_games.sql).
//
//   { "action": "start", "game": "four", "opponent": "<uuid>", "fleet": {...} (Torpedoes) }
//   { "action": "move", "match": "<uuid>", "version": 3, "move": {...} }
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

const resultOf = (winner) => (winner === null ? null : winner === 'draw' ? 'draw' : winner === 0 ? 'a' : 'b');

export async function handle(db, userId, body, random = Math.random) {
  if (!body || typeof body !== 'object') throw new GameError(400, 'bad_request', 'Send a JSON body.');
  try {
    if (body.action === 'start') {
      if (!GAMES.includes(body.game)) throw new GameError(400, 'bad_request', 'Unknown game.');
      if (typeof body.opponent !== 'string' || !UUID.test(body.opponent)) throw new GameError(400, 'bad_request', 'Pick a friend to play with.');
      // Who moves first is drawn here (Torpedoes: the challenger places first, then shoots first).
      let state = newGame(body.game, random() < 0.5 ? 0 : 1);
      let secret = null;
      if (body.game === 'torpedoes') ({ state, secret } = play(state, 0, { fleet: body.fleet }));
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
      const r = play(m.state, m.player, body.move, m.secrets ?? [null, null]);
      const saved = await db.rpc('match_save', {
        p_user: userId,
        p_match: m.id,
        p_version: m.version,
        p_state: r.state,
        p_turn: r.state.turn,
        p_result: resultOf(r.state.winner),
        p_secret: r.secret,
      });
      if (saved.error) throw dbError(saved.error);
      return { state: r.state, version: saved.data };
    }

    throw new GameError(400, 'bad_request', 'Unknown action.');
  } catch (e) {
    if (e instanceof IllegalMove) throw new GameError(422, 'illegal', e.message);
    throw e;
  }
}
