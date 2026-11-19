// The computer opponent, on this device only (no server, no points). Two levels: 1 = easy (makes
// mistakes on purpose), 2 = hard. Every move it returns comes from legalMoves(), so it plays by
// the same rules as everyone.

import { DOTS, FOUR, GOMOKU, TORPEDOES, boxSides, draughtsMoves, isKing, legalMoves, ownerOf, play } from './rules.js';

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

/** The computer's move for `player` (null if it has none). */
export function computerMove(state, player, level = 2) {
  if (state.game === 'torpedoes' && state.phase === 'setup') return state.turn === player && !state.ready[player] ? { fleet: randomFleet() } : null;
  const moves = legalMoves(state, player);
  if (!moves.length) return null;
  switch (state.game) {
    case 'four':
      return fourMove(state, player, level, moves);
    case 'gomoku':
      return gomokuMove(state, player, level, moves);
    case 'draughts':
      return draughtsMove(state, player, level, moves);
    case 'dots':
      return dotsMove(state, player, level, moves);
    case 'torpedoes':
      return torpedoMove(state, player, level, moves);
    default:
      return pickRandom(moves);
  }
}

// ---------------------------------------------------------------- four in a row: negamax

function fourScore(board, p) {
  const { cols, rows } = FOUR;
  let score = 0;
  const windows = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const cells = [0, 1, 2, 3].map((k) => [r + dr * k, c + dc * k]);
        if (cells.every(([rr, cc]) => rr >= 0 && rr < rows && cc >= 0 && cc < cols)) windows.push(cells.map(([rr, cc]) => board[rr * cols + cc]));
      }
  for (const w of windows) {
    const mine = w.filter((v) => v === p).length;
    const theirs = w.filter((v) => v === 1 - p).length;
    if (mine && theirs) continue;
    score += [0, 1, 4, 20, 0][mine] - [0, 1, 5, 25, 0][theirs];
  }
  // The centre column is worth more.
  for (let r = 0; r < rows; r++) score += board[r * cols + 3] === p ? 3 : board[r * cols + 3] === 1 - p ? -3 : 0;
  return score;
}

function negamax(state, player, depth, alpha, beta) {
  if (state.winner !== null) return state.winner === 'draw' ? 0 : state.winner === player ? 10000 + depth : -10000 - depth;
  if (depth === 0) return fourScore(state.board, player);
  const order = [3, 2, 4, 1, 5, 0, 6];
  let best = -Infinity;
  for (const col of order) {
    if (state.board[col] !== -1) continue;
    const next = play(state, player, { col }).state;
    const v = -negamax(next, 1 - player, depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

function fourMove(state, player, level, moves) {
  if (level === 1 && Math.random() < 0.35) return pickRandom(moves);
  const depth = level === 1 ? 2 : 6;
  let best = null;
  let bestV = -Infinity;
  for (const m of moves.sort((a, b) => Math.abs(3 - a.col) - Math.abs(3 - b.col))) {
    const v = -negamax(play(state, player, m).state, 1 - player, depth - 1, -Infinity, Infinity);
    if (v > bestV) {
      bestV = v;
      best = m;
    }
  }
  return best;
}

// ---------------------------------------------------------------- giant tic-tac-toe: threat scores

function runScore(board, cell, p) {
  const n = GOMOKU.size;
  const r0 = Math.floor(cell / n);
  const c0 = cell % n;
  let total = 0;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let count = 1;
    let open = 0;
    for (const s of [1, -1]) {
      let r = r0 + dr * s;
      let c = c0 + dc * s;
      while (r >= 0 && r < n && c >= 0 && c < n && board[r * n + c] === p) {
        count += 1;
        r += dr * s;
        c += dc * s;
      }
      if (r >= 0 && r < n && c >= 0 && c < n && board[r * n + c] === -1) open += 1;
    }
    if (count >= 5) total += 1e6;
    else if (open) total += [0, 1, 12, 120, 2000][count] * (open === 2 ? 3 : 1);
  }
  return total;
}

function gomokuMove(state, player, level, moves) {
  const n = GOMOKU.size;
  const board = state.board;
  if (board.every((v) => v === -1)) return { cell: Math.floor((n * n) / 2) };
  // Only squares next to a stone are worth looking at.
  const near = moves.filter(({ cell }) => {
    const r = Math.floor(cell / n);
    const c = cell % n;
    for (let dr = -2; dr <= 2; dr++)
      for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr * n + cc] !== -1) return true;
      }
    return false;
  });
  const scored = (near.length ? near : moves).map((m) => ({
    m,
    v: runScore(board, m.cell, player) * 1.1 + runScore(board, m.cell, 1 - player) * (level === 1 ? 0.5 : 1) + Math.random(),
  }));
  scored.sort((a, b) => b.v - a.v);
  return level === 1 && Math.random() < 0.3 ? pickRandom(scored.slice(0, 5)).m : scored[0].m;
}

// ---------------------------------------------------------------- draughts: negamax on material

function draughtsEval(board, p) {
  let v = 0;
  for (let i = 0; i < 100; i++) {
    const o = ownerOf(board[i]);
    if (o < 0) continue;
    const row = Math.floor(i / 10);
    const advance = o === 0 ? 9 - row : row;
    const worth = isKing(board[i]) ? 32 : 10 + advance * 0.3;
    v += o === p ? worth : -worth;
  }
  return v;
}

function draughtsSearch(state, player, depth, alpha, beta) {
  if (state.winner !== null) return state.winner === 'draw' ? 0 : state.winner === player ? 1000 + depth : -1000 - depth;
  if (depth === 0) return draughtsEval(state.board, player);
  let best = -Infinity;
  for (const m of draughtsMoves(state.board, player)) {
    const v = -draughtsSearch(play(state, player, m).state, 1 - player, depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

function draughtsMove(state, player, level, moves) {
  if (moves.length === 1) return moves[0];
  const depth = level === 1 ? 1 : 4;
  const scored = moves.map((m) => ({ m, v: -draughtsSearch(play(state, player, m).state, 1 - player, depth - 1, -Infinity, Infinity) + Math.random() * (level === 1 ? 6 : 0.5) }));
  scored.sort((a, b) => b.v - a.v);
  return scored[0].m;
}

// ---------------------------------------------------------------- dots and boxes: greedy and careful

function sidesDrawn(lines, b) {
  return boxSides(b).filter((l) => lines[l] !== -1).length;
}

function dotsMove(state, player, level, moves) {
  const boxesOf = (line) => [...Array(DOTS.size * DOTS.size).keys()].filter((b) => boxSides(b).includes(line));
  // Close a box when you can.
  const closing = moves.filter(({ line }) => boxesOf(line).some((b) => state.boxes[b] === -1 && sidesDrawn(state.lines, b) === 3));
  if (closing.length && (level === 2 || Math.random() < 0.8)) return pickRandom(closing);
  // Otherwise don't hand over a box (no third side).
  const safe = moves.filter(({ line }) => boxesOf(line).every((b) => sidesDrawn(state.lines, b) < 2));
  if (safe.length && (level === 2 || Math.random() < 0.7)) return pickRandom(safe);
  if (level === 1) return pickRandom(moves);
  // Forced to give something: give the fewest boxes away.
  let best = moves[0];
  let bestCost = Infinity;
  for (const m of moves) {
    let { state: s } = play(state, player, m);
    let cost = 0;
    // Count how many boxes the other player could then take in a row.
    let guard = 0;
    while (s.winner === null && guard++ < 40) {
      const takers = legalMoves(s, s.turn).filter(({ line }) => boxesOf(line).some((b) => s.boxes[b] === -1 && sidesDrawn(s.lines, b) === 3));
      if (!takers.length || s.turn === player) break;
      const before = s.boxes.filter((o) => o === 1 - player).length;
      s = play(s, s.turn, takers[0]).state;
      cost += s.boxes.filter((o) => o === 1 - player).length - before;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = m;
    }
  }
  return best;
}

// ---------------------------------------------------------------- torpedoes: hunt and target

/** A random valid fleet. */
export function randomFleet() {
  const n = TORPEDOES.size;
  for (;;) {
    const used = new Set();
    const ships = [];
    let ok = true;
    for (const len of TORPEDOES.fleet) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const across = Math.random() < 0.5;
        const r = Math.floor(Math.random() * (across ? n : n - len + 1));
        const c = Math.floor(Math.random() * (across ? n - len + 1 : n));
        const cells = [...Array(len).keys()].map((k) => (across ? r * n + c + k : (r + k) * n + c));
        if (cells.every((x) => !used.has(x))) {
          cells.forEach((x) => used.add(x));
          ships.push(cells);
          placed = true;
        }
      }
      if (!placed) ok = false;
    }
    if (ok) return { ships };
  }
}

function torpedoMove(state, player, level, moves) {
  const n = TORPEDOES.size;
  const shots = state.shots[player];
  const sunkCells = new Set(state.sunk[player].flat());
  const open = new Set(moves.map((m) => m.cell));
  if (level === 2) {
    // Finish off ships that were hit but not sunk.
    const hits = shots.filter((s) => s.r === 'hit' && !sunkCells.has(s.c)).map((s) => s.c);
    const targets = [];
    for (const h of hits) {
      const r = Math.floor(h / n);
      const c = h % n;
      for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const rr = r + dr;
        const cc = c + dc;
        const cell = rr * n + cc;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n && open.has(cell)) {
          // Prefer squares in line with another hit.
          const lined = hits.some((o) => o !== h && (Math.floor(o / n) === r && dr === 0 ? true : o % n === c && dc === 0));
          targets.push({ cell, w: lined ? 3 : 1 });
        }
      }
    }
    if (targets.length) {
      const top = Math.max(...targets.map((t) => t.w));
      return { cell: pickRandom(targets.filter((t) => t.w === top)).cell };
    }
    // Hunt on a checkerboard: every ship covers at least one of these squares.
    const parity = moves.filter(({ cell }) => (Math.floor(cell / n) + (cell % n)) % 2 === 0);
    if (parity.length) return pickRandom(parity);
  }
  return pickRandom(moves);
}
