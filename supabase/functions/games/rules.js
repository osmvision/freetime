// The rules of freetime's turn-based games, in plain JavaScript with no dependencies. The same
// file runs in the app (boards, the computer opponent) and on the server, which checks every
// online move (supabase/functions/games/rules.js is a copy, kept identical by
// desktop/scripts/sync-game-rules.mjs and checked by a test).
//
// Players are 0 and 1. A state is plain JSON: { game, turn, winner, plies, ... }. `turn` is the
// player to move (null once over); `winner` is null, 0, 1 or 'draw'. `play()` never changes the
// state it gets: it returns a new one, or throws IllegalMove.
//
// Torpedoes hides information: each player's fleet is a secret ({ ships: [[cells]] }) that only
// the server (or, against the computer, this device) knows. `play()` takes both secrets and
// returns the new secret of the player who placed a fleet.

export class IllegalMove extends Error {}

const fail = (why) => {
  throw new IllegalMove(why);
};
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

export const GAMES = ['four', 'gomoku', 'draughts', 'dots', 'torpedoes'];

// ---------------------------------------------------------------- four in a row (7 × 6)

export const FOUR = { cols: 7, rows: 6 };

function fourLine(board, cell, p) {
  const { cols, rows } = FOUR;
  const r0 = Math.floor(cell / cols);
  const c0 = cell % cols;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [cell];
    for (const s of [1, -1]) {
      let r = r0 + dr * s;
      let c = c0 + dc * s;
      while (r >= 0 && r < rows && c >= 0 && c < cols && board[r * cols + c] === p) {
        line.push(r * cols + c);
        r += dr * s;
        c += dc * s;
      }
    }
    if (line.length >= 4) return line;
  }
  return null;
}

const four = {
  init: () => ({ board: Array(FOUR.cols * FOUR.rows).fill(-1) }),
  legal: (s) => [...Array(FOUR.cols).keys()].filter((c) => s.board[c] === -1).map((col) => ({ col })),
  apply(s, move, p) {
    const { cols, rows } = FOUR;
    if (!isInt(move?.col, 0, cols - 1) || s.board[move.col] !== -1) fail('That column is full.');
    const board = s.board.slice();
    let r = rows - 1;
    while (board[r * cols + move.col] !== -1) r -= 1;
    const cell = r * cols + move.col;
    board[cell] = p;
    const line = fourLine(board, cell, p);
    const full = board.every((v) => v !== -1);
    return { state: { board, last: cell, line }, winner: line ? p : full ? 'draw' : null };
  },
};

// ---------------------------------------------------------------- giant tic-tac-toe (11 × 11, five in a row)

export const GOMOKU = { size: 11, row: 5 };

function gomokuLine(board, cell, p) {
  const n = GOMOKU.size;
  const r0 = Math.floor(cell / n);
  const c0 = cell % n;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [cell];
    for (const s of [1, -1]) {
      let r = r0 + dr * s;
      let c = c0 + dc * s;
      while (r >= 0 && r < n && c >= 0 && c < n && board[r * n + c] === p) {
        line.push(r * n + c);
        r += dr * s;
        c += dc * s;
      }
    }
    if (line.length >= GOMOKU.row) return line;
  }
  return null;
}

const gomoku = {
  init: () => ({ board: Array(GOMOKU.size * GOMOKU.size).fill(-1) }),
  legal: (s) => s.board.flatMap((v, cell) => (v === -1 ? [{ cell }] : [])),
  apply(s, move, p) {
    if (!isInt(move?.cell, 0, s.board.length - 1) || s.board[move.cell] !== -1) fail('That square is taken.');
    const board = s.board.slice();
    board[move.cell] = p;
    const line = gomokuLine(board, move.cell, p);
    const full = board.every((v) => v !== -1);
    return { state: { board, last: move.cell, line }, winner: line ? p : full ? 'draw' : null };
  },
};

// ---------------------------------------------------------------- draughts (10 × 10, international rules)
//
// Cells 0–99, row by row; pieces stand on dark squares ((row + col) odd). Values: 0 empty, 1 man
// and 2 king of player 0 (bottom, moving up), 3 man and 4 king of player 1 (top, moving down).
// Captures are compulsory and the longest capture must be taken; men capture backwards too; kings
// fly; captured pieces come off at the end of the move and can't be jumped twice. A man is crowned
// only if its move ends on the far row. Draw after 50 moves in a row without a capture or a man
// moving. A player who can't move loses.

export const DRAUGHTS = { size: 10, quietLimit: 50 };
const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const at = (r, c) => (r >= 0 && r < 10 && c >= 0 && c < 10 ? r * 10 + c : -1);
export const ownerOf = (v) => (v === 0 ? -1 : v <= 2 ? 0 : 1);
export const isKing = (v) => v === 2 || v === 4;

function captureSequences(board, from, p) {
  const king = isKing(board[from]);
  const out = [];
  const taken = new Set();
  const free = (cell) => board[cell] === 0 || cell === from;
  const dfs = (pos, path) => {
    let extended = false;
    const r = Math.floor(pos / 10);
    const c = pos % 10;
    for (const [dr, dc] of DIRS) {
      if (!king) {
        const mid = at(r + dr, c + dc);
        const land = at(r + 2 * dr, c + 2 * dc);
        if (mid < 0 || land < 0) continue;
        if (ownerOf(board[mid]) === 1 - p && !taken.has(mid) && free(land)) {
          taken.add(mid);
          dfs(land, [...path, land]);
          taken.delete(mid);
          extended = true;
        }
        continue;
      }
      let rr = r + dr;
      let cc = c + dc;
      let cell = at(rr, cc);
      while (cell >= 0 && free(cell)) {
        rr += dr;
        cc += dc;
        cell = at(rr, cc);
      }
      if (cell < 0 || ownerOf(board[cell]) !== 1 - p || taken.has(cell)) continue;
      let lr = rr + dr;
      let lc = cc + dc;
      let land = at(lr, lc);
      while (land >= 0 && free(land)) {
        taken.add(cell);
        dfs(land, [...path, land]);
        taken.delete(cell);
        extended = true;
        lr += dr;
        lc += dc;
        land = at(lr, lc);
      }
    }
    if (!extended && path.length > 1) out.push({ path, captured: [...taken] });
  };
  dfs(from, [from]);
  return out;
}

export function draughtsMoves(board, p) {
  let caps = [];
  for (let i = 0; i < 100; i++) if (ownerOf(board[i]) === p) caps = caps.concat(captureSequences(board, i, p));
  if (caps.length) {
    const most = Math.max(...caps.map((m) => m.captured.length));
    return caps.filter((m) => m.captured.length === most);
  }
  const moves = [];
  const forward = p === 0 ? -1 : 1;
  for (let i = 0; i < 100; i++) {
    if (ownerOf(board[i]) !== p) continue;
    const r = Math.floor(i / 10);
    const c = i % 10;
    if (!isKing(board[i])) {
      for (const dc of [-1, 1]) {
        const to = at(r + forward, c + dc);
        if (to >= 0 && board[to] === 0) moves.push({ path: [i, to], captured: [] });
      }
      continue;
    }
    for (const [dr, dc] of DIRS) {
      let to = at(r + dr, c + dc);
      let k = 1;
      while (to >= 0 && board[to] === 0) {
        moves.push({ path: [i, to], captured: [] });
        k += 1;
        to = at(r + dr * k, c + dc * k);
      }
    }
  }
  return moves;
}

function draughtsInit() {
  const board = Array(100).fill(0);
  for (let i = 0; i < 100; i++) {
    const r = Math.floor(i / 10);
    if ((r + (i % 10)) % 2 === 1) {
      if (r <= 3) board[i] = 3;
      if (r >= 6) board[i] = 1;
    }
  }
  return { board, quiet: 0 };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const draughts = {
  init: draughtsInit,
  legal: (s, p) => draughtsMoves(s.board, p),
  apply(s, move, p) {
    const path = move?.path;
    if (!Array.isArray(path) || path.length < 2 || path.length > 21 || !path.every((x) => isInt(x, 0, 99))) fail('That move isn’t allowed.');
    const options = draughtsMoves(s.board, p).filter((m) => sameList(m.path, path));
    if (!options.length) fail('That move isn’t allowed (captures are compulsory, and the longest one).');
    const chosen =
      Array.isArray(move.captured) && options.length > 1
        ? options.find((m) => sameList([...m.captured].sort((a, b) => a - b), [...move.captured].sort((a, b) => a - b))) ?? options[0]
        : options[0];
    const board = s.board.slice();
    const piece = board[path[0]];
    board[path[0]] = 0;
    for (const x of chosen.captured) board[x] = 0;
    const end = path[path.length - 1];
    const row = Math.floor(end / 10);
    board[end] = piece === 1 && row === 0 ? 2 : piece === 3 && row === 9 ? 4 : piece;
    const quiet = chosen.captured.length || !isKing(piece) ? 0 : s.quiet + 1;
    const stuck = draughtsMoves(board, 1 - p).length === 0;
    return {
      state: { board, quiet, last: { path, captured: chosen.captured } },
      winner: stuck ? p : quiet >= DRAUGHTS.quietLimit ? 'draw' : null,
    };
  },
};

// ---------------------------------------------------------------- dots and boxes (5 × 5 boxes)
//
// Lines 0–29 are horizontal (row r = 0..5, col c = 0..4: r * 5 + c), 30–59 vertical
// (row r = 0..4, col c = 0..5: 30 + r * 6 + c). Closing a box scores it and plays again.

export const DOTS = { size: 5 };
const H = (r, c) => r * DOTS.size + c;
const V = (r, c) => (DOTS.size + 1) * DOTS.size + r * (DOTS.size + 1) + c;
export const boxSides = (b) => {
  const r = Math.floor(b / DOTS.size);
  const c = b % DOTS.size;
  return [H(r, c), H(r + 1, c), V(r, c), V(r, c + 1)];
};
export const DOT_LINES = 2 * DOTS.size * (DOTS.size + 1);

const dots = {
  init: () => ({ lines: Array(DOT_LINES).fill(-1), boxes: Array(DOTS.size * DOTS.size).fill(-1) }),
  legal: (s) => s.lines.flatMap((v, line) => (v === -1 ? [{ line }] : [])),
  apply(s, move, p) {
    if (!isInt(move?.line, 0, DOT_LINES - 1) || s.lines[move.line] !== -1) fail('That line is already drawn.');
    const lines = s.lines.slice();
    const boxes = s.boxes.slice();
    lines[move.line] = p;
    let scored = 0;
    boxes.forEach((owner, b) => {
      if (owner === -1 && boxSides(b).includes(move.line) && boxSides(b).every((l) => lines[l] !== -1)) {
        boxes[b] = p;
        scored += 1;
      }
    });
    const state = { lines, boxes, last: move.line };
    if (lines.every((v) => v !== -1)) {
      const mine = boxes.filter((o) => o === 0).length;
      const theirs = boxes.length - mine;
      return { state, winner: mine === theirs ? 'draw' : mine > theirs ? 0 : 1 };
    }
    return { state, winner: null, again: scored > 0 };
  },
};

// ---------------------------------------------------------------- torpedoes (8 × 8, ships 4 3 3 2)
//
// Each player places a fleet (secret), then they take turns firing one shot. A ship whose every
// cell is hit is sunk, and its cells are shown. Sinking the whole fleet wins.

export const TORPEDOES = { size: 8, fleet: [4, 3, 3, 2] };

/** Throws unless `secret` is a valid fleet: straight ships of the right sizes, on the grid, not overlapping. */
export function checkFleet(secret) {
  const n = TORPEDOES.size;
  const ships = secret?.ships;
  if (!Array.isArray(ships) || ships.length !== TORPEDOES.fleet.length) fail('Place all your ships.');
  const sizes = ships.map((s) => (Array.isArray(s) ? s.length : 0)).sort((a, b) => b - a);
  if (!sameList(sizes, [...TORPEDOES.fleet].sort((a, b) => b - a))) fail('The ships don’t have the right sizes.');
  const used = new Set();
  for (const ship of ships) {
    if (!ship.every((x) => isInt(x, 0, n * n - 1))) fail('A ship is off the grid.');
    const cells = [...ship].sort((a, b) => a - b);
    const row = cells.every((x) => Math.floor(x / n) === Math.floor(cells[0] / n)) && cells.every((x, i) => i === 0 || x === cells[i - 1] + 1);
    const col = cells.every((x, i) => i === 0 || x === cells[i - 1] + n);
    if (!row && !col) fail('Ships must be straight.');
    for (const x of cells) {
      if (used.has(x)) fail('Ships can’t overlap.');
      used.add(x);
    }
  }
  return { ships: ships.map((s) => [...s].sort((a, b) => a - b)) };
}

const torpedoes = {
  init: () => ({ phase: 'setup', ready: [false, false], shots: [[], []], sunk: [[], []] }),
  legal(s, p) {
    if (s.phase === 'setup') return [];
    const shot = new Set(s.shots[p].map((x) => x.c));
    return [...Array(TORPEDOES.size ** 2).keys()].filter((c) => !shot.has(c)).map((cell) => ({ cell }));
  },
  apply(s, move, p, secrets) {
    if (s.phase === 'setup') {
      if (s.ready[p]) fail('Your ships are already placed.');
      const fleet = checkFleet(move?.fleet);
      const ready = s.ready.slice();
      ready[p] = true;
      const both = ready[0] && ready[1];
      return {
        state: { ...s, ready, phase: both ? 'play' : 'setup' },
        winner: null,
        secret: fleet,
        // Once both fleets are placed, player 0 fires first; until then, the other one places.
        nextTurn: both ? 0 : 1 - p,
      };
    }
    const n = TORPEDOES.size;
    if (!isInt(move?.cell, 0, n * n - 1)) fail('Pick a square on the grid.');
    if (s.shots[p].some((x) => x.c === move.cell)) fail('You already fired there.');
    const target = secrets?.[1 - p]?.ships;
    if (!target) fail('The other fleet isn’t placed yet.');
    const shots = [s.shots[0].slice(), s.shots[1].slice()];
    const sunk = [s.sunk[0].slice(), s.sunk[1].slice()];
    const ship = target.find((sh) => sh.includes(move.cell));
    let result = 'miss';
    if (ship) {
      const hit = new Set(shots[p].map((x) => x.c));
      hit.add(move.cell);
      result = ship.every((x) => hit.has(x)) ? 'sunk' : 'hit';
      if (result === 'sunk') sunk[p].push(ship);
    }
    shots[p].push({ c: move.cell, r: result });
    const all = target.every((sh) => sunk[p].some((x) => x[0] === sh[0]));
    return { state: { ...s, shots, sunk, last: move.cell }, winner: all ? p : null };
  },
};

// ---------------------------------------------------------------- the common interface

const RULES = { four, gomoku, draughts, dots, torpedoes };

/** A new game. `first` is the player who moves first (Torpedoes: player 0 places first). */
export function newGame(game, first = 0) {
  const rules = RULES[game];
  if (!rules) fail('Unknown game.');
  return { game, ...rules.init(), turn: game === 'torpedoes' ? 0 : first === 1 ? 1 : 0, winner: null, plies: 0 };
}

/** The moves `player` can make now ([] when it isn't their turn). */
export function legalMoves(state, player) {
  if (state.winner !== null || state.turn !== player) return [];
  return RULES[state.game].legal(state, player);
}

/**
 * Plays `move` for `player`. `secrets` = [fleet of 0, fleet of 1] for Torpedoes (null when not
 * placed). Returns { state, secret } where `secret` is the fleet just placed (Torpedoes setup).
 */
export function play(state, player, move, secrets = [null, null]) {
  const rules = RULES[state?.game];
  if (!rules) fail('Unknown game.');
  if (state.winner !== null) fail('This game is over.');
  if (state.turn !== player) fail('It’s not your turn.');
  const r = rules.apply(state, move, player, secrets);
  const turn = r.winner !== null ? null : r.nextTurn ?? (r.again ? player : 1 - player);
  return { state: { ...state, ...r.state, game: state.game, turn, winner: r.winner, plies: state.plies + 1 }, secret: r.secret ?? null };
}

/** Player 0's or 1's score where it means something (Dots and boxes). */
export function scores(state) {
  if (state.game !== 'dots') return null;
  return [0, 1].map((p) => state.boxes.filter((o) => o === p).length);
}
