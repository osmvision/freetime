// The game rules (desktop/ui/js/play/rules.js, copied to supabase/functions/games/rules.js) and the
// computer opponent. Run: cd supabase/tests && npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { IllegalMove, checkFleet, draughtsMoves, legalMoves, newGame, play, scores } from '../functions/games/rules.js';
import { computerMove, randomFleet } from '../../desktop/ui/js/play/ai.js';

const here = import.meta.dirname;

test('the server runs exactly the rules the app ships', () => {
  const app = readFileSync(join(here, '../../desktop/ui/js/play/rules.js'), 'utf8');
  const server = readFileSync(join(here, '../functions/games/rules.js'), 'utf8');
  assert.equal(server, app, 'run: node desktop/scripts/sync-game-rules.mjs');
});

const illegal = (fn, pattern) => assert.throws(fn, (e) => e instanceof IllegalMove && (!pattern || pattern.test(e.message)));

/** Plays a list of moves, alternating as the state says. */
function run(state, moves, secrets) {
  for (const m of moves) state = play(state, state.turn, m, secrets).state;
  return state;
}

test('turns: nobody plays out of turn or after the end', () => {
  const s = newGame('four', 1);
  assert.equal(s.turn, 1);
  illegal(() => play(s, 0, { col: 3 }), /not your turn/);
  const won = run(newGame('four'), [{ col: 0 }, { col: 1 }, { col: 0 }, { col: 1 }, { col: 0 }, { col: 1 }, { col: 0 }]);
  assert.equal(won.winner, 0);
  assert.equal(won.turn, null);
  illegal(() => play(won, 1, { col: 5 }), /over/);
  illegal(() => newGame('chess'), /Unknown/);
});

test('four in a row: gravity, lines in every direction, full columns, draws', () => {
  let s = run(newGame('four'), [{ col: 3 }, { col: 3 }]);
  assert.equal(s.board[5 * 7 + 3], 0, 'first disc at the bottom');
  assert.equal(s.board[4 * 7 + 3], 1, 'second on top of it');
  // Horizontal.
  s = run(newGame('four'), [{ col: 0 }, { col: 0 }, { col: 1 }, { col: 1 }, { col: 2 }, { col: 2 }, { col: 3 }]);
  assert.equal(s.winner, 0);
  assert.equal(s.line.length, 4);
  // Diagonal.
  s = run(newGame('four'), [0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3].map((col) => ({ col })));
  assert.equal(s.winner, 0);
  // A full column.
  s = run(newGame('four'), [0, 0, 0, 0, 0, 0].map((col) => ({ col })));
  illegal(() => play(s, s.turn, { col: 0 }), /full/);
  illegal(() => play(s, s.turn, { col: 7 }));
  illegal(() => play(s, s.turn, { col: '3' }));
  // A full board with no line is a draw.
  const board = 'abbaabb baabbaa abbaabb baabbaa abbaabb baabbaa'.replace(/ /g, '').split('').map((x) => (x === 'a' ? 0 : 1));
  board[3] = -1;
  const almost = { ...newGame('four'), board, turn: board.filter((v) => v === 0).length > board.filter((v) => v === 1).length ? 1 : 0 };
  const end = play(almost, almost.turn, { col: 3 }).state;
  assert.equal(end.winner, 'draw');
});

test('giant tic-tac-toe: five in a row wins, taken squares are refused', () => {
  const s = run(newGame('gomoku'), [0, 20, 1, 21, 2, 22, 3, 23].map((cell) => ({ cell })));
  illegal(() => play(s, 0, { cell: 1 }), /taken/);
  const won = play(s, 0, { cell: 4 }).state;
  assert.equal(won.winner, 0);
  assert.deepEqual([...won.line].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  illegal(() => play(newGame('gomoku'), 0, { cell: 121 }));
});

/** A draughts board from a list of [cell, piece]. */
function board(...pieces) {
  const b = Array(100).fill(0);
  for (const [cell, v] of pieces) b[cell] = v;
  return { ...newGame('draughts'), board: b };
}

test('draughts: the opening, simple moves and no backward steps for men', () => {
  const s = newGame('draughts');
  assert.equal(s.board.filter((v) => v === 1).length, 20);
  assert.equal(s.board.filter((v) => v === 3).length, 20);
  assert.equal(legalMoves(s, 0).length, 9);
  // A man can't step backwards.
  const b = board([55, 1]);
  assert.deepEqual(draughtsMoves(b.board, 0).map((m) => m.path[1]).sort(), [44, 46]);
});

test('draughts: captures are compulsory, men capture backwards, the longest capture wins', () => {
  // Player 0 man on 55 can capture the black man on 64 (backwards) by landing on 73.
  let s = board([55, 1], [64, 3], [11, 3]);
  let moves = legalMoves(s, 0);
  assert.deepEqual(moves.map((m) => m.path), [[55, 73]], 'the only legal move is the capture');
  illegal(() => play(s, 0, { path: [55, 44] }), /compulsory/);
  const after = play(s, 0, { path: [55, 73] }).state;
  assert.equal(after.board[64], 0, 'the captured man is gone');
  assert.equal(after.board[73], 1);
  // Two options: one capture or a double one: only the double is allowed.
  s = board([66, 1], [55, 3], [33, 3], [77, 3]);
  moves = legalMoves(s, 0);
  assert.ok(moves.every((m) => m.captured.length === 2), 'majority rule');
  assert.deepEqual(moves[0].path, [66, 44, 22]);
});

test('draughts: flying kings, no piece jumped twice, crowning only at the end', () => {
  // A king on 90 sees a black man far away on the long diagonal and can land on any square past it.
  let s = board([90, 2], [54, 3], [5, 3]);
  const lands = legalMoves(s, 0).map((m) => m.path[1]).sort((a, b) => a - b);
  assert.deepEqual(lands, [9, 18, 27, 36, 45]);
  // A man reaching the far row becomes a king.
  s = board([11, 1], [99, 3]);
  const crowned = play(s, 0, { path: [11, 0] }).state;
  assert.equal(crowned.board[0], 2);
  // A player left without a move loses: black's last man is blocked after white's move.
  s = board([10, 3], [21, 1], [32, 1], [55, 1]);
  const blocked = play(s, 0, { path: [55, 44] }).state;
  assert.equal(blocked.winner, 0);
});

test('draughts: 50 quiet king moves end in a draw', () => {
  let s = { ...board([90, 2], [9, 4]), quiet: 49 };
  s = play(s, 0, { path: [90, 81] }).state;
  assert.equal(s.winner, 'draw');
});

test('dots and boxes: closing a box scores and plays again', () => {
  // Box 0's sides: top 0, bottom 5, left 30, right 31.
  let s = run(newGame('dots'), [{ line: 0 }, { line: 5 }, { line: 30 }]);
  assert.equal(s.turn, 1);
  s = play(s, 1, { line: 31 }).state;
  assert.equal(s.boxes[0], 1);
  assert.equal(s.turn, 1, 'plays again');
  illegal(() => play(s, 1, { line: 31 }), /already/);
  assert.deepEqual(scores(s), [0, 1]);
});

test('dots and boxes: the game ends when every line is drawn', () => {
  let s = newGame('dots');
  while (s.winner === null) s = play(s, s.turn, legalMoves(s, s.turn)[0]).state;
  const [a, b] = scores(s);
  assert.equal(a + b, 25);
  assert.equal(s.winner, a > b ? 0 : 1);
});

test('torpedoes: fleets are checked, shots are resolved against the secret fleet', () => {
  illegal(() => checkFleet({ ships: [[0, 1, 2, 3], [8, 9, 10], [16, 17, 18]] }), /all your ships/);
  illegal(() => checkFleet({ ships: [[0, 1, 2, 3], [8, 9, 10], [16, 17, 18], [24, 33]] }), /straight/);
  illegal(() => checkFleet({ ships: [[6, 7, 8, 9], [16, 17, 18], [24, 25, 26], [40, 41]] }), /straight/, 'no wrapping round the edge');
  illegal(() => checkFleet({ ships: [[0, 1, 2, 3], [0, 8, 16], [24, 25, 26], [40, 41]] }), /overlap/);
  illegal(() => checkFleet({ ships: [[0, 1, 2], [8, 9, 10], [16, 17, 18], [40, 41]] }), /sizes/);
  const fleetA = { ships: [[0, 1, 2, 3], [16, 24, 32], [20, 21, 22], [62, 63]] };
  const fleetB = { ships: [[7, 15, 23, 31], [40, 41, 42], [44, 45, 46], [56, 57]] };
  let s = newGame('torpedoes');
  illegal(() => play(s, 0, { cell: 5 }));
  let r = play(s, 0, { fleet: fleetA });
  const secrets = [r.secret, null];
  s = r.state;
  assert.equal(s.turn, 1, 'now the other player places');
  assert.equal(s.phase, 'setup');
  assert.equal(JSON.stringify(s).includes('"ships"'), false, 'the public state never holds a fleet');
  r = play(s, 1, { fleet: fleetB }, secrets);
  secrets[1] = r.secret;
  s = r.state;
  assert.equal(s.phase, 'play');
  assert.equal(s.turn, 0);
  s = play(s, 0, { cell: 56 }, secrets).state;
  assert.deepEqual(s.shots[0].at(-1), { c: 56, r: 'hit' });
  s = play(s, 1, { cell: 5 }, secrets).state;
  assert.equal(s.shots[1].at(-1).r, 'miss');
  illegal(() => play(s, 0, { cell: 56 }, secrets), /already fired/);
  s = play(s, 0, { cell: 57 }, secrets).state;
  assert.equal(s.shots[0].at(-1).r, 'sunk');
  assert.deepEqual(s.sunk[0], [[56, 57]]);
  // Sink everything else.
  for (const cell of [7, 15, 23, 31, 40, 41, 42, 44, 45, 46]) {
    s = play(s, 1, legalMoves(s, 1).find((m) => ![0, 1, 2, 3, 16, 24, 32, 20, 21, 22, 62, 63].includes(m.cell)), secrets).state;
    s = play(s, 0, { cell }, secrets).state;
  }
  assert.equal(s.winner, 0);
});

/** Two computers play a whole game; every move must be legal and the game must end. */
function selfPlay(game, levels) {
  let s = newGame(game, Math.round(Math.random()));
  const secrets = [null, null];
  for (let i = 0; i < 400 && s.winner === null; i++) {
    const p = s.turn;
    const m = computerMove(s, p, levels[p]);
    assert.ok(m, `${game}: the computer found no move`);
    const r = play(s, p, m, secrets);
    if (r.secret) secrets[p] = r.secret;
    s = r.state;
  }
  return s;
}

for (const game of ['four', 'gomoku', 'draughts', 'dots', 'torpedoes']) {
  test(`computer opponent plays legal ${game} games to the end`, () => {
    for (const levels of [[1, 1], [2, 1], [2, 2]]) {
      const s = selfPlay(game, levels);
      assert.notEqual(s.winner, null, `${game} ${levels} didn't finish`);
    }
  });
}

test('computer opponent: takes a win and blocks one (four in a row, hard)', () => {
  const win = run(newGame('four'), [0, 6, 0, 6, 0, 5].map((col) => ({ col })));
  assert.deepEqual(computerMove(win, 0, 2), { col: 0 });
  const block = run(newGame('four'), [0, 6, 0, 6, 0].map((col) => ({ col })));
  assert.deepEqual(computerMove(block, 1, 2), { col: 0 });
});

test('random fleets are always valid', () => {
  for (let i = 0; i < 200; i++) checkFleet(randomFleet());
});
