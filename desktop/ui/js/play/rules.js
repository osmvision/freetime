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

export const GAMES = ['four', 'gomoku', 'draughts', 'dots', 'torpedoes', 'chess', 'reversi', 'awale', 'ultimate'];

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

// ---------------------------------------------------------------- chess

// Squares are 0-63: 0 is a8, 7 is h8, 56 is a1, 63 is h1 (row 0 is the 8th rank). Pieces: 1 pawn,
// 2 knight, 3 bishop, 4 rook, 5 queen, 6 king; white is positive, black negative, 0 is empty.
// The player who moves first plays white (`state.white`). A move is { from, to } (and `promo`:
// 'q', 'r', 'b' or 'n' for a pawn reaching the last row); castling is the king's two-square step.
// Drawn automatically: stalemate, a dead position (not enough pieces to mate), 50 moves without a
// capture or a pawn move, and the same position for the third time.

export const CHESS = { quietLimit: 100 }; // half-moves

const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;
const PROMOTES = { q: QUEEN, r: ROOK, b: BISHOP, n: KNIGHT };
const KNIGHT_STEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_STEPS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const STRAIGHTS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

const START_ROW = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];
const chessStartBoard = () => [
  ...START_ROW.map((t) => -t),
  ...Array(8).fill(-PAWN),
  ...Array(32).fill(0),
  ...Array(8).fill(PAWN),
  ...START_ROW,
];

/** Is `target` attacked by the pieces of colour `by` (1 white, -1 black)? */
function attacked(b, target, by) {
  const r = target >> 3;
  const c = target & 7;
  const pr = r + by; // a white pawn attacks upwards (to a smaller row): it stands one row below
  if (pr >= 0 && pr < 8) {
    if (c > 0 && b[pr * 8 + c - 1] === by * PAWN) return true;
    if (c < 7 && b[pr * 8 + c + 1] === by * PAWN) return true;
  }
  for (const [dr, dc] of KNIGHT_STEPS) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === by * KNIGHT) return true;
  }
  for (const [dr, dc] of KING_STEPS) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === by * KING) return true;
  }
  for (const [steps, slider] of [[DIAGONALS, BISHOP], [STRAIGHTS, ROOK]]) {
    for (const [dr, dc] of steps) {
      let rr = r + dr;
      let cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const v = b[rr * 8 + cc];
        if (v !== 0) {
          if (v === by * slider || v === by * QUEEN) return true;
          break;
        }
        rr += dr;
        cc += dc;
      }
    }
  }
  return false;
}

const kingSquare = (b, side) => b.indexOf(side * KING);

/** Is the side to move in check? */
export function chessInCheck(pos) {
  const k = kingSquare(pos.b, pos.side);
  return k >= 0 && attacked(pos.b, k, -pos.side);
}

/** Moves that follow the pieces' movement, leaving the king's safety to `chessMoves`. */
function pseudoMoves(pos) {
  const { b, side, castle, ep } = pos;
  const out = [];
  const lastRow = side === 1 ? 0 : 7;
  const add = (from, to, promotes) => {
    if (promotes) for (const promo of ['q', 'r', 'b', 'n']) out.push({ from, to, promo });
    else out.push({ from, to });
  };
  for (let from = 0; from < 64; from++) {
    const v = b[from];
    if (v * side <= 0) continue;
    const t = Math.abs(v);
    const r = from >> 3;
    const c = from & 7;
    if (t === PAWN) {
      const r1 = r - side;
      if (b[r1 * 8 + c] === 0) {
        add(from, r1 * 8 + c, r1 === lastRow);
        const startRow = side === 1 ? 6 : 1;
        if (r === startRow && b[(r - 2 * side) * 8 + c] === 0) out.push({ from, to: (r - 2 * side) * 8 + c });
      }
      for (const dc of [-1, 1]) {
        const cc = c + dc;
        if (cc < 0 || cc > 7) continue;
        const to = r1 * 8 + cc;
        if (b[to] * side < 0) add(from, to, r1 === lastRow);
        else if (to === ep) out.push({ from, to });
      }
    } else if (t === KNIGHT || t === KING) {
      for (const [dr, dc] of t === KNIGHT ? KNIGHT_STEPS : KING_STEPS) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        if (b[rr * 8 + cc] * side <= 0) out.push({ from, to: rr * 8 + cc });
      }
    } else {
      const steps = t === BISHOP ? DIAGONALS : t === ROOK ? STRAIGHTS : [...DIAGONALS, ...STRAIGHTS];
      for (const [dr, dc] of steps) {
        let rr = r + dr;
        let cc = c + dc;
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          const to = rr * 8 + cc;
          if (b[to] * side > 0) break;
          out.push({ from, to });
          if (b[to] !== 0) break;
          rr += dr;
          cc += dc;
        }
      }
    }
  }
  // Castling: king and rook unmoved, the squares between empty, and the king neither in check nor
  // crossing or landing on an attacked square.
  const home = side === 1 ? 56 : 0;
  if (b[home + 4] === side * KING && !attacked(b, home + 4, -side)) {
    const rights = side === 1 ? [castle[0], castle[1]] : [castle[2], castle[3]];
    if (rights[0] && b[home + 7] === side * ROOK && b[home + 5] === 0 && b[home + 6] === 0 && !attacked(b, home + 5, -side) && !attacked(b, home + 6, -side)) {
      out.push({ from: home + 4, to: home + 6 });
    }
    if (rights[1] && b[home] === side * ROOK && b[home + 1] === 0 && b[home + 2] === 0 && b[home + 3] === 0 && !attacked(b, home + 3, -side) && !attacked(b, home + 2, -side)) {
      out.push({ from: home + 4, to: home + 2 });
    }
  }
  return out;
}

/** The position after `m` (a new object; `m` must be legal). */
export function chessMake(pos, m) {
  const { side } = pos;
  const b = pos.b.slice();
  const castle = pos.castle.slice();
  const v = b[m.from];
  const t = Math.abs(v);
  let ep = -1;
  b[m.from] = 0;
  if (t === PAWN) {
    if (m.to === pos.ep && b[m.to] === 0 && (m.from & 7) !== (m.to & 7)) b[m.to + 8 * side] = 0; // en passant
    if (Math.abs(m.to - m.from) === 16) ep = (m.from + m.to) / 2;
    b[m.to] = m.promo ? side * PROMOTES[m.promo] : v;
  } else {
    b[m.to] = v;
    if (t === KING && Math.abs(m.to - m.from) === 2) {
      const home = side === 1 ? 56 : 0;
      if (m.to > m.from) {
        b[home + 7] = 0;
        b[home + 5] = side * ROOK;
      } else {
        b[home] = 0;
        b[home + 3] = side * ROOK;
      }
    }
  }
  if (t === KING) {
    castle[side === 1 ? 0 : 2] = false;
    castle[side === 1 ? 1 : 3] = false;
  }
  for (const s of [m.from, m.to]) {
    if (s === 63) castle[0] = false;
    else if (s === 56) castle[1] = false;
    else if (s === 7) castle[2] = false;
    else if (s === 0) castle[3] = false;
  }
  return { b, side: -side, castle, ep };
}

/** Every legal move of the side to move in `pos` = { b, side, castle, ep }. */
export function chessMoves(pos) {
  const legal = [];
  for (const m of pseudoMoves(pos)) {
    const next = chessMake(pos, m);
    const k = kingSquare(next.b, pos.side);
    if (k >= 0 && !attacked(next.b, k, next.side)) legal.push(m);
  }
  return legal;
}

/** The position of a chess state, for the side to move (or for `player`). */
export function chessPosition(state, player = state.turn) {
  return { b: state.board, side: player === state.white ? 1 : -1, castle: state.castle, ep: state.ep };
}

function hash53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A number that is the same for two equal positions (pieces, side to move, rights, en passant). */
function positionKey(pos) {
  const { b, side, castle, ep } = pos;
  // An en passant square only counts when a pawn could take there.
  let epKey = -1;
  if (ep >= 0) {
    const row = ep >> 3;
    const c = ep & 7;
    const pawnRow = row + side;
    const mine = side * PAWN;
    if ((c > 0 && b[pawnRow * 8 + c - 1] === mine) || (c < 7 && b[pawnRow * 8 + c + 1] === mine)) epKey = ep;
  }
  return hash53(`${b.join(',')}|${side}|${castle.map(Number).join('')}|${epKey}`);
}

/** Dead position: no way left to checkmate (K v K, K+minor v K, bishops all on one colour). */
function insufficientMaterial(b) {
  const pieces = [];
  for (let i = 0; i < 64; i++) if (b[i] !== 0 && Math.abs(b[i]) !== KING) pieces.push([Math.abs(b[i]), i]);
  if (pieces.length === 0) return true;
  if (pieces.length === 1) return pieces[0][0] === KNIGHT || pieces[0][0] === BISHOP;
  const shade = ([, i]) => ((i >> 3) + (i & 7)) % 2;
  return pieces.every(([t]) => t === BISHOP) && pieces.every((p) => shade(p) === shade(pieces[0]));
}

/**
 * A chess state from a FEN string (tests and puzzles). White is player 0; the side to move in the
 * FEN is the player to move.
 */
export function chessFromFen(fen) {
  const [placement, side, rights = '-', ep = '-', clock = '0'] = fen.trim().split(/\s+/);
  const board = [];
  for (const ch of placement.replace(/\//g, '')) {
    if (/\d/.test(ch)) board.push(...Array(Number(ch)).fill(0));
    else {
      const t = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING }[ch.toLowerCase()];
      board.push(ch === ch.toLowerCase() ? -t : t);
    }
  }
  if (board.length !== 64) throw new Error('Bad FEN');
  const state = {
    game: 'chess',
    white: 0,
    board,
    castle: [rights.includes('K'), rights.includes('Q'), rights.includes('k'), rights.includes('q')],
    ep: ep === '-' ? -1 : (8 - Number(ep[1])) * 8 + (ep.charCodeAt(0) - 97),
    clock: Number(clock),
    last: null,
    check: false,
    turn: side === 'b' ? 1 : 0,
    winner: null,
    plies: 0,
  };
  const pos = chessPosition(state);
  return { ...state, seen: [positionKey(pos)], check: chessInCheck(pos) };
}

const chess = {
  init: (first = 0) => {
    const state = { white: first === 1 ? 1 : 0, board: chessStartBoard(), castle: [true, true, true, true], ep: -1, clock: 0, last: null, check: false };
    return { ...state, seen: [positionKey(chessPosition({ ...state, turn: state.white }))] };
  },
  legal: (s, p) => chessMoves(chessPosition(s, p)),
  apply(s, move, p) {
    const pos = chessPosition(s, p);
    if (!isInt(move?.from, 0, 63) || !isInt(move?.to, 0, 63)) fail('Pick a piece, then a square.');
    const legal = chessMoves(pos);
    const wanted = legal.filter((m) => m.from === move.from && m.to === move.to);
    if (!wanted.length) {
      const mine = pos.b[move.from] * pos.side > 0;
      fail(mine && pseudoMoves(pos).some((m) => m.from === move.from && m.to === move.to) ? 'That would leave your king in check.' : 'That move isn’t allowed.');
    }
    let m = wanted[0];
    if (m.promo) {
      m = wanted.find((x) => x.promo === move.promo);
      if (!m) fail('Pick the piece to promote to.');
    } else if (move.promo !== undefined && move.promo !== null) {
      fail('Only a pawn reaching the last row promotes.');
    }
    const next = chessMake(pos, m);
    const capture = pos.b[m.to] !== 0 || (Math.abs(pos.b[m.from]) === PAWN && m.to === pos.ep && (m.from & 7) !== (m.to & 7));
    const reset = capture || Math.abs(pos.b[m.from]) === PAWN;
    const clock = reset ? 0 : s.clock + 1;
    const key = positionKey(next);
    const seen = reset ? [key] : [...s.seen, key];
    const check = chessInCheck(next);
    let winner = null;
    if (!chessMoves(next).length) winner = check ? p : 'draw';
    else if (insufficientMaterial(next.b) || clock >= CHESS.quietLimit || seen.filter((k) => k === key).length >= 3) winner = 'draw';
    return { state: { board: next.b, castle: next.castle, ep: next.ep, clock, seen, last: { from: m.from, to: m.to }, check }, winner };
  },
};

// ---------------------------------------------------------------- reversi (8 × 8)
//
// Cells 0–63, row by row; -1 empty. A disc must trap at least one straight line of the other
// colour between itself and another disc of yours: the line turns to your colour. A player with
// no move is skipped (the other plays again); when neither can move, most discs wins.

export const REVERSI = { size: 8 };
const ALL_DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/** The discs a disc of `p` on `cell` would turn ([] if none: not a move). */
export function reversiFlips(board, cell, p) {
  if (board[cell] !== -1) return [];
  const r0 = Math.floor(cell / 8);
  const c0 = cell % 8;
  const out = [];
  for (const [dr, dc] of ALL_DIRS) {
    const line = [];
    let r = r0 + dr;
    let c = c0 + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === 1 - p) {
      line.push(r * 8 + c);
      r += dr;
      c += dc;
    }
    if (line.length && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === p) out.push(...line);
  }
  return out;
}

const reversiCells = (board, p) => board.flatMap((v, cell) => (v === -1 && reversiFlips(board, cell, p).length ? [cell] : []));

const reversi = {
  init: () => {
    const board = Array(64).fill(-1);
    board[27] = board[36] = 1;
    board[28] = board[35] = 0;
    return { board };
  },
  legal: (s, p) => reversiCells(s.board, p).map((cell) => ({ cell })),
  apply(s, move, p) {
    if (!isInt(move?.cell, 0, 63)) fail('Pick a square on the board.');
    const flipped = reversiFlips(s.board, move.cell, p);
    if (!flipped.length) fail('A disc must trap a line of the other colour.');
    const board = s.board.slice();
    board[move.cell] = p;
    for (const x of flipped) board[x] = p;
    const state = { board, last: move.cell, flipped };
    if (reversiCells(board, 1 - p).length) return { state, winner: null };
    if (reversiCells(board, p).length) return { state, winner: null, again: true }; // they can't move
    const mine = board.filter((v) => v === p).length;
    const theirs = board.filter((v) => v === 1 - p).length;
    return { state, winner: mine === theirs ? 'draw' : mine > theirs ? p : 1 - p };
  },
};

// ---------------------------------------------------------------- awalé (oware, abapa rules)
//
// Pits 0–5 are player 0's, 6–11 player 1's; seeds go round anticlockwise (0 → 1 → … → 11 → 0).
// Take every seed of one of your pits and sow them one by one in the following pits, skipping the
// pit you emptied. If the last seed makes 2 or 3 in a pit of the other player, they are captured,
// and so are the 2s and 3s just before it on that side; a move that would capture all their seeds
// captures nothing. If they have no seeds, you must give them some when you can. When a player
// can't move, or after 100 moves without a capture, each player keeps the seeds on their side.
// More than 24 seeds wins; 24 each is a draw.

export const AWALE = { pits: 12, seeds: 4, quietLimit: 100 };
const sideOf = (pit) => (pit < 6 ? 0 : 1);
const seedsOn = (pits, p) => pits.slice(p * 6, p * 6 + 6).reduce((a, b) => a + b, 0);

/** The pits after sowing from `pit`, the pits sown (in order) and the seeds captured. */
export function awaleSow(pits, pit, p) {
  const next = pits.slice();
  let hand = next[pit];
  next[pit] = 0;
  const sown = [];
  let at = pit;
  while (hand > 0) {
    at = (at + 1) % 12;
    if (at === pit) continue;
    next[at] += 1;
    sown.push(at);
    hand -= 1;
  }
  const captured = [];
  let c = at;
  while (sideOf(c) === 1 - p && (next[c] === 2 || next[c] === 3)) {
    captured.push(c);
    c = (c + 11) % 12;
  }
  const taken = captured.reduce((a, x) => a + next[x], 0);
  // Taking every seed they have (a grand slam) captures nothing.
  if (taken && taken === seedsOn(next, 1 - p)) return { pits: next, sown, captured: [], taken: 0 };
  for (const x of captured) next[x] = 0;
  return { pits: next, sown, captured, taken };
}

function awaleMoves(pits, p) {
  const mine = [0, 1, 2, 3, 4, 5].map((k) => p * 6 + k).filter((pit) => pits[pit] > 0);
  if (seedsOn(pits, 1 - p) > 0) return mine;
  // They have nothing: feed them if you can.
  return mine.filter((pit) => seedsOn(awaleSow(pits, pit, p).pits, 1 - p) > 0);
}

const awale = {
  init: () => ({ pits: Array(12).fill(AWALE.seeds), stores: [0, 0], quiet: 0 }),
  legal: (s, p) => awaleMoves(s.pits, p).map((pit) => ({ pit })),
  apply(s, move, p) {
    if (!isInt(move?.pit, 0, 11) || sideOf(move.pit) !== p) fail('Pick one of your pits.');
    if (!s.pits[move.pit]) fail('That pit is empty.');
    if (!awaleMoves(s.pits, p).includes(move.pit)) fail('They have no seeds: give them some.');
    const r = awaleSow(s.pits, move.pit, p);
    let pits = r.pits;
    const stores = s.stores.slice();
    stores[p] += r.taken;
    const quiet = r.taken ? 0 : s.quiet + 1;
    const state = { pits, stores, quiet, last: { pit: move.pit, sown: r.sown, captured: r.captured } };
    const done = stores[p] > 24 || awaleMoves(pits, 1 - p).length === 0 || quiet >= AWALE.quietLimit;
    if (!done) return { state, winner: null };
    // The end: each keeps the seeds on their side.
    if (stores[p] <= 24) {
      stores[0] += seedsOn(pits, 0);
      stores[1] += seedsOn(pits, 1);
      pits = Array(12).fill(0);
    }
    return { state: { ...state, pits, stores }, winner: stores[0] === stores[1] ? 'draw' : stores[0] > stores[1] ? 0 : 1 };
  },
};

// ---------------------------------------------------------------- ultimate tic-tac-toe
//
// Nine small grids of nine squares: cell = grid * 9 + square. The square you play sends the other
// player to the grid in the same place; if that grid is already decided, they play anywhere open.
// Three in a row wins a small grid; three small grids in a row win the game.

const LINES3 = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

/** The line of three `p` has in a 3 × 3 list, or null. */
const line3 = (cells, p) => LINES3.find((l) => l.every((k) => cells[k] === p)) ?? null;

export const ultimateOpen = (s) =>
  s.cells.flatMap((v, cell) => {
    const g = Math.floor(cell / 9);
    return v === -1 && s.grids[g] === -1 && (s.next < 0 || s.next === g) ? [cell] : [];
  });

const ultimate = {
  // grids: -1 open, 0 or 1 won, 2 full without a line.
  init: () => ({ cells: Array(81).fill(-1), grids: Array(9).fill(-1), next: -1 }),
  legal: (s) => ultimateOpen(s).map((cell) => ({ cell })),
  apply(s, move, p) {
    if (!isInt(move?.cell, 0, 80) || !ultimateOpen(s).includes(move.cell)) fail('Play in the grid you were sent to, on a free square.');
    const cells = s.cells.slice();
    const grids = s.grids.slice();
    cells[move.cell] = p;
    const g = Math.floor(move.cell / 9);
    const small = cells.slice(g * 9, g * 9 + 9);
    if (line3(small, p)) grids[g] = p;
    else if (small.every((v) => v !== -1)) grids[g] = 2;
    const sent = move.cell % 9;
    const next = grids[sent] === -1 ? sent : -1;
    const big = line3(grids, p);
    const state = { cells, grids, next, last: move.cell, line: big };
    if (big) return { state, winner: p };
    if (grids.every((v) => v !== -1)) return { state, winner: 'draw' };
    return { state, winner: null };
  },
};

// ---------------------------------------------------------------- the common interface

const RULES = { four, gomoku, draughts, dots, torpedoes, chess, reversi, awale, ultimate };

/** A new game. `first` is the player who moves first (Torpedoes: player 0 places first). */
export function newGame(game, first = 0) {
  const rules = RULES[game];
  if (!rules) fail('Unknown game.');
  return { game, ...rules.init(first), turn: game === 'torpedoes' ? 0 : first === 1 ? 1 : 0, winner: null, plies: 0 };
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

/** Player 0's or 1's score where it means something (boxes, discs, seeds captured). */
export function scores(state) {
  if (state.game === 'dots') return [0, 1].map((p) => state.boxes.filter((o) => o === p).length);
  if (state.game === 'reversi') return [0, 1].map((p) => state.board.filter((v) => v === p).length);
  if (state.game === 'awale') return state.stores.slice();
  return null;
}
