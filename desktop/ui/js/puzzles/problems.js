// "Win in N": a position from one of the two-player games where the player to move can force a
// win within N of their own moves (Four in a row) or mate in N (chess). Made ahead of time by
// desktop/scripts/make-puzzles.mjs and played on the games' own boards. The rules are the games'
// (play/rules.js), so a problem can't break them.

import { chessFromFen, legalMoves, newGame, play } from '../play/rules.js';

/**
 * True when `player`, to move in `state`, can force a win within `n` of their own moves, whatever
 * the other player answers.
 */
export function winsWithin(state, player, n) {
  return winningMoves(state, player, n, 1).length > 0;
}

/** The first moves that force a win within `n` (up to `limit` of them). */
export function winningMoves(state, player, n, limit = Infinity) {
  const out = [];
  if (n <= 0 || state.winner !== null || state.turn !== player) return out;
  for (const m of legalMoves(state, player)) {
    if (holds(play(state, player, m).state, player, n - 1)) {
      out.push(m);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** After `player`'s move: they have won, or every answer still loses within `n` more moves. */
export function holds(state, player, n) {
  if (state.winner === player) return true;
  if (state.winner !== null || n <= 0) return false;
  const other = state.turn;
  return legalMoves(state, other).every((r) => {
    const next = play(state, other, r).state;
    return next.winner === player || winsWithin(next, player, n);
  });
}

/** The answer that holds out longest (the computer's reply in a problem). */
export function bestDefence(state, player, n) {
  const other = state.turn;
  const replies = legalMoves(state, other).map((r) => ({ r, next: play(state, other, r).state }));
  // Longest resistance first: an answer after which the win takes the most moves.
  const lasts = ({ next }) => {
    for (let k = 1; k <= n; k++) if (next.winner === player || winsWithin(next, player, k)) return k;
    return n + 1;
  };
  return replies.map((x) => ({ ...x, k: lasts(x) })).sort((a, b) => b.k - a.k)[0]?.r ?? null;
}

// ---------------------------------------------------------------- the stored form

/** "four|n|board" (42 of . 0 1, player 0 to move) or "chess|n|fen". */
export function encodeProblem(p) {
  if (p.game === 'four') return `four|${p.n}|${p.state.board.map((v) => (v === -1 ? '.' : v)).join('')}`;
  return `chess|${p.n}|${p.fen}`;
}

export function decodeProblem(text) {
  const [game, n, body] = text.split('|');
  if (game === 'four') {
    const board = [...body].map((ch) => (ch === '.' ? -1 : Number(ch)));
    const plies = board.filter((v) => v !== -1).length;
    return { game, n: Number(n), state: { ...newGame('four', 0), board, plies, turn: 0 }, player: 0 };
  }
  const state = chessFromFen(body);
  return { game, n: Number(n), fen: body, state, player: state.turn };
}
