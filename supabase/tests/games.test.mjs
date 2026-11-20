// The game rules (desktop/ui/js/play/rules.js, copied to supabase/functions/games/rules.js) and the
// computer opponent. Run: cd supabase/tests && npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { IllegalMove, checkFleet, chessFromFen, chessMake, chessMoves, chessPosition, draughtsMoves, legalMoves, newGame, play, scores } from '../functions/games/rules.js';
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
  illegal(() => newGame('checkers'), /Unknown/);
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

// ---------------------------------------------------------------- chess

const sqr = (name) => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97); // 'e4' -> 36
/** A move from text: 'e2e4', or 'a7a8q' for a promotion. */
const mv = (text) => ({ from: sqr(text.slice(0, 2)), to: sqr(text.slice(2, 4)), ...(text[4] ? { promo: text[4] } : {}) });
const playText = (state, ...moves) => run(state, moves.map(mv));

function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = chessMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(chessMake(pos, m), depth - 1);
  return n;
}

test('chess: the number of reachable positions matches the known counts (perft)', () => {
  const cases = [
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
    ['r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
  ];
  for (const [fen, counts] of cases) {
    const pos = chessPosition(chessFromFen(fen));
    counts.forEach((expected, i) => assert.equal(perft(pos, i + 1), expected, `${fen} at depth ${i + 1}`));
  }
});

test('chess: the player who moves first has the white pieces', () => {
  for (const first of [0, 1]) {
    const s = newGame('chess', first);
    assert.equal(s.white, first);
    assert.equal(s.turn, first);
    assert.equal(legalMoves(s, first).length, 20);
    assert.deepEqual(legalMoves(s, 1 - first), []);
    illegal(() => play(s, 1 - first, mv('e7e5')), /not your turn/);
  }
  // Black (player 1) answers when white is player 0, and the moves keep their meaning.
  const s = playText(newGame('chess', 0), 'e2e4', 'e7e5');
  assert.equal(s.turn, 0);
  assert.equal(s.board[sqr('e5')], -1);
  assert.deepEqual(s.last, { from: sqr('e7'), to: sqr('e5') });
});

test('chess: moves are checked (turns, pieces, paths, kings in check)', () => {
  const s = newGame('chess', 0);
  illegal(() => play(s, 0, mv('e7e5')), /allowed/); // black's pawn
  illegal(() => play(s, 0, mv('e2e5')), /allowed/); // three squares
  illegal(() => play(s, 0, mv('a1a3')), /allowed/); // a rook through its own pawn
  illegal(() => play(s, 0, mv('e4e5')), /allowed/); // an empty square
  illegal(() => play(s, 0, { from: 'e2', to: 'e4' }), /Pick a piece/);
  illegal(() => play(s, 0, { from: 64, to: 0 }), /Pick a piece/);
  illegal(() => play(s, 0, mv('e2e4q')), /last row/);
  // A pinned piece can't move: the rook on e2 shields the king from the rook on e8.
  const pinned = chessFromFen('4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1');
  illegal(() => play(pinned, 0, mv('e2a2')), /leave your king in check/);
  play(pinned, 0, mv('e2e8')); // along the pin it is fine (and takes the rook)
  // In check, only moves that end the check are allowed.
  const check = chessFromFen('4k3/8/8/8/8/8/3r4/R3K3 w - - 0 1');
  assert.equal(check.check, false);
  const inCheck = playText(chessFromFen('4k3/8/8/8/8/8/8/R3K2r w - - 0 1'), 'e1d2');
  assert.equal(inCheck.board[sqr('d2')], 6);
});

test('chess: fool’s mate is checkmate and ends the game', () => {
  const s = playText(newGame('chess', 0), 'f2f3', 'e7e5', 'g2g4', 'd8h4');
  assert.equal(s.winner, 1, 'black mated white');
  assert.equal(s.turn, null);
  assert.equal(s.check, true);
  illegal(() => play(s, 0, mv('a2a3')), /over/);
  // And the same game with the sides swapped: player 1 has white and loses.
  const t = playText(newGame('chess', 1), 'f2f3', 'e7e5', 'g2g4', 'd8h4');
  assert.equal(t.winner, 0);
});

test('chess: castling needs free squares, unmoved pieces and a safe path', () => {
  const free = chessFromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  let s = playText(free, 'e1g1');
  assert.equal(s.board[sqr('g1')], 6);
  assert.equal(s.board[sqr('f1')], 4, 'the rook jumps over');
  assert.equal(s.board[sqr('h1')], 0);
  s = playText(free, 'e1c1');
  assert.equal(s.board[sqr('c1')], 6);
  assert.equal(s.board[sqr('d1')], 4);
  assert.equal(s.board[sqr('a1')], 0);
  assert.deepEqual(s.castle, [false, false, true, true], 'white lost both rights');
  s = playText(free, 'e1g1', 'e8c8');
  assert.equal(s.board[sqr('d8')], -4);
  // Not through an attacked square (f1), not out of or into check, not with a piece in between.
  assert.equal(chessMoves(chessPosition(chessFromFen('r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1'))).some((m) => m.from === sqr('e1') && m.to === sqr('g1')), false);
  assert.equal(chessMoves(chessPosition(chessFromFen('r3k2r/8/8/8/8/4r3/8/R3K2R w KQkq - 0 1'))).some((m) => m.from === sqr('e1') && Math.abs(m.to - m.from) === 2), false, 'in check');
  assert.equal(chessMoves(chessPosition(chessFromFen('r3k2r/8/8/8/8/8/8/R3K1NR w KQkq - 0 1'))).some((m) => m.to === sqr('g1') && m.from === sqr('e1')), false);
  // The queen side may cross an attacked b1; the king may not cross an attacked d1.
  assert.equal(chessMoves(chessPosition(chessFromFen('r3k2r/8/8/8/8/1r6/8/R3K2R w KQkq - 0 1'))).some((m) => m.to === sqr('c1') && m.from === sqr('e1')), true);
  assert.equal(chessMoves(chessPosition(chessFromFen('r3k2r/8/8/8/8/3r4/8/R3K2R w KQkq - 0 1'))).some((m) => m.to === sqr('c1') && m.from === sqr('e1')), false);
  // Moving the rook or the king gives the right up for good.
  s = playText(free, 'h1h2', 'e8e7', 'h2h1', 'e7e8');
  assert.equal(chessMoves(chessPosition(s)).some((m) => m.to === sqr('g1') && m.from === sqr('e1')), false);
  assert.equal(chessMoves(chessPosition(s)).some((m) => m.to === sqr('c1') && m.from === sqr('e1')), true);
});

test('chess: en passant only right after the double step', () => {
  let s = playText(newGame('chess', 0), 'e2e4', 'a7a6', 'e4e5', 'd7d5');
  assert.equal(s.ep, sqr('d6'));
  s = play(s, 0, mv('e5d6')).state;
  assert.equal(s.board[sqr('d6')], 1);
  assert.equal(s.board[sqr('d5')], 0, 'the pawn that stepped past is taken');
  // One move later the chance is gone.
  let late = playText(newGame('chess', 0), 'e2e4', 'a7a6', 'e4e5', 'd7d5', 'a2a3', 'a6a5');
  illegal(() => play(late, 0, mv('e5d6')), /allowed/);
  // Black can do it too, and it can't be used to leave the king in check.
  const black = playText(chessFromFen('4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1'), 'd4e3');
  assert.equal(black.board[sqr('e4')], 0);
  assert.equal(black.board[sqr('e3')], -1);
  const exposed = chessFromFen('8/8/8/K2pP2r/8/8/8/7k w - d6 0 1');
  illegal(() => play(exposed, 0, mv('e5d6')), /leave your king in check/);
});

test('chess: promotion asks for the piece and allows every choice', () => {
  const s = chessFromFen('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  illegal(() => play(s, 0, mv('a7a8')), /promote/);
  illegal(() => play(s, 0, { ...mv('a7a8'), promo: 'k' }), /promote/);
  for (const [promo, piece] of [['q', 5], ['r', 4], ['b', 3], ['n', 2]]) {
    assert.equal(play(s, 0, mv(`a7a8${promo}`)).state.board[sqr('a8')], piece);
  }
  const black = playText(chessFromFen('8/8/8/8/8/7K/p7/7k b - - 0 1'), 'a2a1n');
  assert.equal(black.board[sqr('a1')], -2);
  // A promotion can capture, and give mate.
  const mate = playText(chessFromFen('1r5k/P7/6K1/8/8/8/8/8 w - - 0 1'), 'a7b8q');
  assert.equal(mate.board[sqr('b8')], 5);
});

test('chess: stalemate and dead positions are draws, and mate beats them', () => {
  const quiet = chessFromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  assert.equal(playText(quiet, 'e7f7').winner, 'draw', 'stalemate');
  assert.equal(playText(quiet, 'e7g7').winner, 0, 'checkmate');
  assert.equal(playText(chessFromFen('7k/8/8/8/8/8/n7/K7 w - - 0 1'), 'a1a2').winner, 'draw', 'king against king');
  assert.equal(playText(chessFromFen('7k/8/8/8/8/8/8/K1B4n w - - 0 1'), 'c1d2').winner, null, 'bishop against knight is not dead');
  assert.equal(playText(chessFromFen('7k/8/8/8/8/8/n5N1/K7 w - - 0 1'), 'g2f4').winner, null, 'two knights are not declared dead');
  // Bishops on the same colour can't mate; on opposite colours they could.
  assert.equal(playText(chessFromFen('b6k/8/8/8/8/8/8/K1B5 w - - 0 1'), 'a1b2').winner, null, 'bishops on different colours');
  assert.equal(playText(chessFromFen('1b5k/8/8/8/8/8/8/K1B5 w - - 0 1'), 'a1b2').winner, 'draw', 'bishops on the same colour');
});

test('chess: fifty quiet moves and the same position three times are draws', () => {
  const nearly = chessFromFen('7k/8/8/8/8/8/8/K6R w - - 99 80');
  assert.equal(playText(nearly, 'h1h2').winner, 'draw');
  assert.equal(playText(chessFromFen('7k/8/8/8/8/8/p7/K6R w - - 99 80'), 'h1h2').winner, 'draw');
  // A capture or a pawn move starts the count again.
  const pawn = playText(chessFromFen('7k/7p/8/8/8/8/8/K6R b - - 99 80'), 'h7h6');
  assert.equal(pawn.winner, null);
  assert.equal(pawn.clock, 0);
  // Knights going back and forth: the start position comes back for the third time.
  let s = newGame('chess', 0);
  for (let i = 0; i < 2; i++) s = playText(s, 'g1f3', 'g8f6', 'f3g1', 'f6g8');
  assert.equal(s.winner, 'draw');
  assert.equal(s.plies, 8);
  // Not a draw after only two occurrences.
  s = playText(newGame('chess', 0), 'g1f3', 'g8f6', 'f3g1', 'f6g8');
  assert.equal(s.winner, null);
  assert.equal(s.seen.length, 5);
});

test('chess: the state stays small and plain whatever happens', () => {
  // Plays random legal moves until something ends the game, checking the state each time.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let game = 0; game < 6; game++) {
    let s = newGame('chess', game % 2);
    while (s.winner === null) {
      const moves = legalMoves(s, s.turn);
      assert.ok(moves.length > 0, 'a game that is not over always has a move');
      s = play(s, s.turn, moves[Math.floor(random() * moves.length)]).state;
      assert.ok(JSON.stringify(s).length < 6000, 'fits in the 16000-byte limit with room');
      assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'plain JSON');
    }
    assert.ok(s.plies > 0);
  }
});

test('chess computer opponent: only legal moves, from either side, at both levels', () => {
  for (const [first, levels] of [[0, [1, 1]], [1, [1, 1]], [0, [2, 1]], [1, [1, 2]]]) {
    let s = newGame('chess', first);
    for (let i = 0; i < (levels.includes(2) ? 8 : 160) && s.winner === null; i++) {
      const m = computerMove(s, s.turn, levels[s.turn]);
      assert.ok(m, 'the computer found no move');
      s = play(s, s.turn, m).state; // throws if the move isn't legal
    }
    assert.ok(s.plies > 0);
  }
});

test('chess computer opponent: never misses a mate in one, takes a free queen, promotes', () => {
  const mate = chessFromFen('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
  for (const level of [1, 2]) {
    for (let i = 0; i < 20; i++) assert.deepEqual(computerMove(mate, 0, level), mv('a1a8'), `level ${level} mates`);
  }
  assert.deepEqual(computerMove(chessFromFen('k7/8/8/3q4/8/8/8/K2R4 w - - 0 1'), 0, 2), mv('d1d5'), 'hard takes the queen');
  assert.deepEqual(computerMove(chessFromFen('k7/8/8/3q4/8/8/8/K2R4 w - - 0 1'), 0, 1), mv('d1d5'), 'so does easy');
  const promote = computerMove(chessFromFen('8/P6k/8/8/8/8/8/K7 w - - 0 1'), 0, 2);
  assert.equal(promote.promo, 'q', 'hard promotes to a queen');
});

test('chess computer opponent: hard answers in about a second, even in a crowded position', () => {
  const busy = chessFromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const started = Date.now();
  const m = computerMove(busy, 0, 2);
  const took = Date.now() - started;
  assert.ok(took < 2500, `took ${took} ms`);
  play(busy, 0, m);
});
