// Makes the "Win in N" problem of each day ahead of time into desktop/ui/js/puzzles/problems-days.js:
// chess "mate in 2" on Monday, Wednesday, Friday and Sunday; Four in a row "win in 2" on Tuesday
// and "win in 3" on Thursday and Saturday. Positions come from games the computer plays against
// itself (easy level); a problem is kept only if exactly one first move wins, and not faster.
// Seeded by the date: running it again gives the same problems. Takes several minutes.
//   node desktop/scripts/make-problems.mjs [last day, default 2027-12-31]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computerMove } from '../ui/js/play/ai.js';
import { newGame, play } from '../ui/js/play/rules.js';
import { seeded } from '../ui/js/puzzles/logic.js';
import { encodeProblem, winningMoves, winsWithin } from '../ui/js/puzzles/problems.js';
import { FIRST_DAY } from '../ui/js/puzzles/days.js';

const last = process.argv[2] ?? '2027-12-31';

// getUTCDay: 0 Sunday … 6 Saturday.
const KIND = { 0: ['chess', 2], 1: ['chess', 2], 2: ['four', 2], 3: ['chess', 2], 4: ['four', 3], 5: ['chess', 2], 6: ['four', 3] };

/** Exactly one first move wins within n, and nothing wins sooner. */
function good(state, n) {
  if (state.winner !== null) return false;
  if (n > 1 && winsWithin(state, state.turn, n - 1)) return false;
  return winningMoves(state, state.turn, n, 2).length === 1;
}

/** Four in a row: a position along an easy game where the player to move wins in exactly n. */
function fourProblem(n) {
  for (;;) {
    let s = newGame('four', 0);
    while (s.winner === null) {
      if (s.plies >= 8 && s.turn === 0 && good(s, n)) return { game: 'four', n, state: s };
      s = play(s, s.turn, computerMove(s, s.turn, 1)).state;
    }
  }
}

function toFen(s) {
  const sym = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const v = s.board[r * 8 + c];
      if (!v) {
        empty++;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += v > 0 ? sym[v].toUpperCase() : sym[-v];
    }
    rows.push(row + (empty || ''));
  }
  const white = s.turn === s.white;
  const rights = ['K', 'Q', 'k', 'q'].filter((_, i) => s.castle[i]).join('') || '-';
  const ep = s.ep >= 0 ? `${String.fromCharCode(97 + (s.ep & 7))}${8 - (s.ep >> 3)}` : '-';
  return `${rows.join('/')} ${white ? 'w' : 'b'} ${rights} ${ep} 0`;
}

/** Chess: three half-moves before the mate of an easy game, if it's a real mate in 2. */
function chessProblem() {
  for (;;) {
    let s = newGame('chess', 0);
    const seen = [s];
    while (s.winner === null && s.plies < 160) {
      s = play(s, s.turn, computerMove(s, s.turn, 1)).state;
      seen.push(s);
    }
    if (s.winner !== 0 && s.winner !== 1) continue;
    const c = seen[seen.length - 4];
    if (c && c.turn === s.winner && good(c, 2)) return { game: 'chess', n: 2, fen: toFen(c) };
  }
}

const days = [];
const end = Date.parse(`${last}T00:00:00Z`);
const real = Math.random;
for (let t = Date.parse(`${FIRST_DAY}T00:00:00Z`); t <= end; t += 86400000) {
  const date = new Date(t).toISOString().slice(0, 10);
  Math.random = seeded(`freetime-problem-${date}`); // the easy computer plays by chance
  const [game, n] = KIND[new Date(t).getUTCDay()];
  days.push(encodeProblem(game === 'four' ? fourProblem(n) : chessProblem()));
  if (days.length % 50 === 0) console.log(`${days.length} days…`);
}
Math.random = real;

const out = join(import.meta.dirname, '..', 'ui', 'js', 'puzzles', 'problems-days.js');
writeFileSync(
  out,
  '// Made by desktop/scripts/make-problems.mjs: do not edit. The "Win in N" problem of each day,\n' +
    `// from ${FIRST_DAY} (#1) to ${last}, the same days as days.js. One winning first move each.\n` +
    `export const PROBLEMS = [\n${days.map((d) => `  ${JSON.stringify(d)},`).join('\n')}\n];\n`,
);
console.log(`${days.length} problems written to ${out}`);
