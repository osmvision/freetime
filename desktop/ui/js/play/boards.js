// The boards of the turn-based games, drawn with buttons (keyboard and screen reader friendly).
// board(state, opts) returns an element. opts: { me, active, onMove(move), secret, names, taken }
// (taken: false hides the pieces each side took, in chess).
// `me` is your player number; `active` means it's your turn and you may click.

import { h, icon } from '../dom.js';
import { DOTS, FOUR, GOMOKU, TORPEDOES, isKing, legalMoves, ownerOf } from './rules.js';

export function board(state, opts) {
  switch (state.game) {
    case 'four':
      return fourBoard(state, opts);
    case 'gomoku':
      return gomokuBoard(state, opts);
    case 'draughts':
      return draughtsBoard(state, opts);
    case 'chess':
      return chessBoard(state, opts);
    case 'dots':
      return dotsBoard(state, opts);
    case 'torpedoes':
      return torpedoBoards(state, opts);
    default:
      return h('p', {}, 'Unknown game');
  }
}

const piece = (p) => h('span', { class: `piece p${p}`, 'aria-hidden': 'true' });

// ---------------------------------------------------------------- four in a row

function fourBoard(state, { active, onMove }) {
  const { cols, rows } = FOUR;
  const legal = new Set(active ? legalMoves(state, state.turn).map((m) => m.col) : []);
  const line = new Set(state.line ?? []);
  // The lowest empty cell of each column you may play: where your disc would land.
  const land = (c) => {
    if (!legal.has(c)) return -1;
    let r = rows - 1;
    while (r >= 0 && state.board[r * cols + c] !== -1) r -= 1;
    return r * cols + c;
  };
  const columns = [...Array(cols).keys()].map((c) => {
    const landing = land(c);
    return h(
      'button',
      {
        type: 'button',
        class: 'four-col',
        disabled: !legal.has(c),
        'aria-label': `Column ${c + 1}`,
        onclick: () => onMove({ col: c }),
      },
      [...Array(rows).keys()].map((r) => {
        const cell = r * cols + c;
        const v = state.board[cell];
        return h('span', { class: `four-cell${line.has(cell) ? ' win' : ''}${state.last === cell ? ' last' : ''}${cell === landing ? ' land' : ''}`, 'data-cell': cell }, v === -1 ? null : piece(v));
      }),
    );
  });
  // turn-p0 / turn-p1: the colour of the disc shown over the column you point at.
  return h('div', { class: `board four-board${active ? ` turn-p${state.turn}` : ''}`, role: 'group', 'aria-label': 'Four in a row' }, columns);
}

// ---------------------------------------------------------------- giant tic-tac-toe

function gomokuBoard(state, { active, onMove }) {
  const n = GOMOKU.size;
  const line = new Set(state.line ?? []);
  return h(
    'div',
    { class: 'board gomoku-board', style: `--n:${n}`, role: 'grid', 'aria-label': 'Giant tic-tac-toe' },
    state.board.map((v, cell) =>
      h(
        'button',
        {
          type: 'button',
          class: `go-cell${line.has(cell) ? ' win' : ''}${state.last === cell ? ' last' : ''}`,
          'data-cell': cell,
          disabled: !active || v !== -1,
          'aria-label': `Row ${Math.floor(cell / n) + 1}, column ${(cell % n) + 1}${v === -1 ? '' : v === 0 ? ', cross' : ', circle'}`,
          onclick: () => onMove({ cell }),
        },
        v === -1 ? null : h('span', { class: `mark p${v}`, 'aria-hidden': 'true' }, icon(v === 0 ? 'x' : 'circle')),
      ),
    ),
  );
}

// ---------------------------------------------------------------- draughts

function draughtsBoard(state, { me, active, onMove }) {
  // Your pieces at the bottom: player 1 sees the board turned round.
  const flip = me === 1;
  const moves = active ? legalMoves(state, state.turn) : [];
  let prefix = [];
  let starts = new Set();
  let next = new Set();
  const root = h('div', { class: 'board draughts-board', role: 'grid', 'aria-label': 'Draughts' });
  const last = new Set(state.last?.path ?? []);

  function draw() {
    const fits = moves.filter((m) => prefix.every((x, i) => m.path[i] === x));
    starts = new Set(moves.map((m) => m.path[0]));
    next = new Set(prefix.length ? fits.map((m) => m.path[prefix.length]).filter((x) => x !== undefined) : []);
    const cells = [];
    for (let k = 0; k < 100; k++) {
      const i = flip ? 99 - k : k;
      const r = Math.floor(i / 10);
      const c = i % 10;
      const dark = (r + c) % 2 === 1;
      const v = state.board[i];
      const o = ownerOf(v);
      const selectable = !prefix.length ? starts.has(i) : i === prefix[0] || next.has(i);
      cells.push(
        h(
          'button',
          {
            type: 'button',
            class: `dr-cell${dark ? ' dark' : ''}${prefix.includes(i) ? ' chosen' : ''}${next.has(i) ? ' target' : ''}${!prefix.length && starts.has(i) ? ' movable' : ''}${last.has(i) ? ' last' : ''}`,
            disabled: !dark || !selectable,
            'data-cell': i,
            'aria-label': `${String.fromCharCode(97 + c)}${10 - r}${o >= 0 ? (isKing(v) ? ', king' : ', man') : ''}`,
            onclick: () => pick(i),
          },
          o >= 0 ? h('span', { class: `piece p${o}${isKing(v) ? ' king' : ''}`, 'aria-hidden': 'true' }, isKing(v) ? icon('crown') : null) : null,
        ),
      );
    }
    root.replaceChildren(...cells);
  }

  function pick(i) {
    // Choose a piece, choose another one, or put it back; then each square of the move in turn.
    if (!prefix.length || (prefix.length === 1 && starts.has(i) && !next.has(i))) {
      prefix = i === prefix[0] ? [] : [i];
      return draw();
    }
    if (prefix.length === 1 && i === prefix[0]) {
      prefix = [];
      return draw();
    }
    if (!next.has(i)) return;
    prefix = [...prefix, i];
    const done = moves.find((m) => m.path.length === prefix.length && m.path.every((x, k) => x === prefix[k]));
    if (done) onMove({ path: done.path, captured: done.captured });
    else draw();
  }

  draw();
  return root;
}

// ---------------------------------------------------------------- chess

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgNode = (tag, attrs) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// The pieces are drawn from simple shapes (45 × 45), the same on every device: no font involved.
// 'body' shapes take the piece's colour, 'cut' shapes are the thin lines on top of it.
const SHAPES = {
  1: [
    ['circle', { cx: 22.5, cy: 13.5, r: 5.5 }],
    ['path', { d: 'M22.5 19.5 C17.5 21 15.5 26 15 31 L13 36 C12.5 37.5 13.5 38.5 15 38.5 H30 C31.5 38.5 32.5 37.5 32 36 L30 31 C29.5 26 27.5 21 22.5 19.5 Z' }],
  ],
  2: [
    ['path', { d: 'M13 38.5 C13 33 14.5 29 18 26 C15 26.5 12.5 28 10 27 C9 24 12 20 16 16 C17 14 17.5 11.5 17 9 C19 9.5 20.5 10.5 21.5 12 C24 9.5 28 10.5 30 14 C33 19 33.5 27 32.5 31 L32 38.5 Z' }],
    ['circle', { cx: 17.5, cy: 15.5, r: 1.2 }, 'cut'],
  ],
  3: [
    ['path', { d: 'M12 38.5 V34.5 H33 V38.5 Z' }],
    ['path', { d: 'M15.5 34.5 C16 29 19 26.5 22.5 22.5 C26 26.5 29 29 29.5 34.5 Z' }],
    ['path', { d: 'M22.5 8 C27 12.5 29 16 29 19.5 C29 22.5 26.5 25 22.5 25 C18.5 25 16 22.5 16 19.5 C16 16 18 12.5 22.5 8 Z' }],
    ['circle', { cx: 22.5, cy: 7, r: 2.2 }],
    ['path', { d: 'M21.5 14 L26 19', fill: 'none' }, 'cut'],
  ],
  4: [
    ['path', { d: 'M12 38.5 V34.5 H33 V38.5 Z' }],
    ['path', { d: 'M14.5 34.5 L16 19 H29 L30.5 34.5 Z' }],
    ['path', { d: 'M13 19 V8.5 H18 V12.5 H20.5 V8.5 H24.5 V12.5 H27 V8.5 H32 V19 Z' }],
  ],
  5: [
    ['path', { d: 'M11 38.5 V34.5 H34 V38.5 Z' }],
    ['path', { d: 'M13 34.5 L10.5 14 L13.5 26 L16.5 11 L19.5 26 L22.5 9.5 L25.5 26 L28.5 11 L31.5 26 L34.5 14 L32 34.5 Z' }],
    ...[[10.5, 13], [16.5, 10], [22.5, 8.5], [28.5, 10], [34.5, 13]].map(([cx, cy]) => ['circle', { cx, cy, r: 2.1 }]),
  ],
  6: [
    ['path', { d: 'M11 38.5 V34.5 H34 V38.5 Z' }],
    ['path', { d: 'M13.5 34.5 C12 28 15 23 20 21.5 V18 H25 V21.5 C30 23 33 28 31.5 34.5 Z' }],
    ['path', { d: 'M20.5 5.5 H24.5 V9 H28 V13 H24.5 V18 H20.5 V13 H17 V9 H20.5 Z' }],
  ],
};
const PIECE_NAMES = { 1: 'pawn', 2: 'knight', 3: 'bishop', 4: 'rook', 5: 'queen', 6: 'king' };
const PROMOTION_CHOICES = [['q', 5], ['r', 4], ['b', 3], ['n', 2]];

/** One piece as an SVG: `type` is 1-6 (pawn to king). */
export function chessPiece(type, white) {
  const svg = svgNode('svg', { viewBox: '0 0 45 45', class: `chess-piece ${white ? 'w' : 'b'}`, 'aria-hidden': 'true', focusable: 'false' });
  for (const [tag, attrs, role] of SHAPES[type]) svg.append(svgNode(tag, { ...attrs, class: role === 'cut' ? 'cut' : 'body' }));
  return svg;
}

function chessBoard(state, { me, active, onMove, taken: showTaken = true }) {
  // Your pieces at the bottom: whoever plays black sees the board turned round.
  const flip = me !== state.white;
  const moves = active ? legalMoves(state, me) : [];
  const last = new Set(state.last ? [state.last.from, state.last.to] : []);
  let selected = -1;
  let promoting = null;

  // The king in check: the side to move, or the side that has just been mated.
  const mover = state.turn ?? (state.winner === 0 || state.winner === 1 ? 1 - state.winner : null);
  const kingInCheck = state.check && mover !== null ? state.board.indexOf((mover === state.white ? 1 : -1) * 6) : -1;

  const root = h('div', { class: 'board chess-board', role: 'grid', 'aria-label': 'Chess' });
  const name = (i) => `${String.fromCharCode(97 + (i & 7))}${8 - (i >> 3)}`;

  function draw() {
    const from = new Set(moves.map((m) => m.from));
    const targets = new Set(selected >= 0 ? moves.filter((m) => m.from === selected).map((m) => m.to) : []);
    const cells = [];
    for (let k = 0; k < 64; k++) {
      const i = flip ? 63 - k : k;
      const r = i >> 3;
      const c = i & 7;
      const v = state.board[i];
      const movable = from.has(i);
      const target = targets.has(i);
      const col = k & 7;
      const row = k >> 3;
      cells.push(
        h(
          'button',
          {
            type: 'button',
            class: `ch-cell ${(r + c) % 2 === 1 ? 'dark' : 'light'}${i === selected ? ' chosen' : ''}${target ? (v !== 0 || (Math.abs(state.board[selected]) === 1 && i === state.ep) ? ' capture' : ' target') : ''}${movable && selected < 0 ? ' movable' : ''}${last.has(i) ? ' last' : ''}${i === kingInCheck ? ' check' : ''}`,
            disabled: promoting !== null || !(movable || target),
            'data-cell': i,
            'aria-label': `${name(i)}${v !== 0 ? `, ${v > 0 ? 'white' : 'black'} ${PIECE_NAMES[Math.abs(v)]}` : ''}`,
            'aria-pressed': movable ? String(i === selected) : null,
            onclick: () => pick(i),
          },
          v !== 0 ? chessPiece(Math.abs(v), v > 0) : null,
          // The coordinates sit on the board's own edges, in the squares' corners.
          col === 0 ? h('span', { class: 'ch-rank', 'aria-hidden': 'true' }, String(8 - r)) : null,
          row === 7 ? h('span', { class: 'ch-file', 'aria-hidden': 'true' }, String.fromCharCode(97 + c)) : null,
        ),
      );
    }
    root.replaceChildren(...cells, ...(promoting ? [chooser()] : []));
  }

  /** The four pieces a pawn can become, over the board. */
  function chooser() {
    const white = state.board[promoting.from] > 0;
    return h(
      'div',
      { class: 'ch-promote', role: 'group', 'aria-label': 'Promote the pawn to' },
      PROMOTION_CHOICES.map(([promo, type]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'ch-choice',
            'aria-label': PIECE_NAMES[type],
            onclick: () => onMove({ from: promoting.from, to: promoting.to, promo }),
          },
          chessPiece(type, white),
        ),
      ),
      h('button', { type: 'button', class: 'ch-choice cancel', 'aria-label': 'Cancel', onclick: () => ((promoting = null), draw()) }, icon('x')),
    );
  }

  function pick(i) {
    const options = selected >= 0 ? moves.filter((m) => m.from === selected && m.to === i) : [];
    if (options.length) {
      if (options[0].promo) {
        promoting = { from: selected, to: i };
        return draw();
      }
      return onMove({ from: selected, to: i });
    }
    selected = i === selected || !moves.some((m) => m.from === i) ? -1 : i;
    draw();
  }

  draw();
  const mine = me === state.white;
  if (!showTaken) return root;
  return h('div', { class: 'chess-wrap' }, takenRow(state.board, !mine), root, takenRow(state.board, mine));
}

const START_COUNT = { 1: 8, 2: 2, 3: 2, 4: 2, 5: 1 };
const VALUE = { 1: 1, 2: 3, 3: 3, 4: 5, 5: 9 };

/**
 * The pieces `white` (true) or black has taken, smallest first, and its lead in material (pawn 1,
 * knight and bishop 3, rook 5, queen 9). A promoted pawn counts as the piece it became.
 */
export function taken(board, white) {
  const count = (sign) => {
    const n = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const v of board) if (v * sign > 0 && Math.abs(v) !== 6) n[Math.abs(v)] += 1;
    return n;
  };
  const theirs = count(white ? -1 : 1);
  const ours = count(white ? 1 : -1);
  const pieces = [1, 2, 3, 4, 5].flatMap((t) => Array(Math.max(0, START_COUNT[t] - theirs[t])).fill(t));
  const material = (n) => Object.entries(n).reduce((sum, [t, k]) => sum + VALUE[t] * k, 0);
  return { pieces, lead: material(ours) - material(theirs) };
}

// Visual only: the squares of the board already tell a screen reader every piece left.
function takenRow(board, white) {
  const { pieces, lead } = taken(board, white);
  return h(
    'div',
    { class: 'ch-taken', 'aria-hidden': 'true' },
    pieces.map((t) => chessPiece(t, !white)),
    lead > 0 ? h('span', { class: 'ch-lead figures' }, `+${lead}`) : null,
  );
}

// ---------------------------------------------------------------- dots and boxes

function dotsBoard(state, { active, onMove }) {
  const n = DOTS.size;
  const items = [];
  const lineBtn = (index, dir) =>
    h('button', {
      type: 'button',
      class: `dot-line ${dir}${state.lines[index] >= 0 ? ` drawn p${state.lines[index]}` : ''}${state.last === index ? ' last' : ''}`,
      disabled: !active || state.lines[index] !== -1,
      'data-line': index,
      'aria-label': `${dir === 'h' ? 'Horizontal' : 'Vertical'} line ${index + 1}`,
      onclick: () => onMove({ line: index }),
    });
  for (let r = 0; r <= 2 * n; r++) {
    for (let c = 0; c <= 2 * n; c++) {
      if (r % 2 === 0 && c % 2 === 0) items.push(h('span', { class: 'dot' }));
      else if (r % 2 === 0) items.push(lineBtn((r / 2) * n + (c - 1) / 2, 'h'));
      else if (c % 2 === 0) items.push(lineBtn(n * (n + 1) + ((r - 1) / 2) * (n + 1) + c / 2, 'v'));
      else {
        const b = ((r - 1) / 2) * n + (c - 1) / 2;
        const o = state.boxes[b];
        items.push(h('span', { class: `dot-box${o >= 0 ? ` p${o}` : ''}`, 'data-box': b }, o >= 0 ? h('span', { class: 'mark', 'aria-hidden': 'true' }, icon(o === 0 ? 'x' : 'circle')) : null));
      }
    }
  }
  return h('div', { class: 'board dots-board', style: `--n:${n}`, role: 'group', 'aria-label': 'Dots and boxes' }, items);
}

// ---------------------------------------------------------------- torpedoes

function grid(cells, cls, label) {
  return h('div', { class: `board torp-grid ${cls}`, style: `--n:${TORPEDOES.size}`, role: 'grid', 'aria-label': label }, cells);
}

/** Your fleet with the other player's shots, and their waters with yours. */
function torpedoBoards(state, { me, active, onMove, secret }) {
  const n = TORPEDOES.size;
  const other = 1 - me;
  const myShips = new Set((secret?.ships ?? []).flat());
  const theirShots = new Map(state.shots[other].map((s) => [s.c, s.r]));
  const myShots = new Map(state.shots[me].map((s) => [s.c, s.r]));
  const sunkThere = new Set(state.sunk[me].flat());
  const mine = [...Array(n * n).keys()].map((c) => {
    const shot = theirShots.get(c);
    return h(
      'span',
      { class: `torp-cell${myShips.has(c) ? ' ship' : ''}${shot ? ` ${shot}` : ''}${state.last === c && state.turn === me ? ' last' : ''}`, 'data-cell': c },
      shot ? icon(shot === 'miss' ? 'dot' : 'x', 'shot') : null,
    );
  });
  const theirs = [...Array(n * n).keys()].map((c) => {
    const shot = myShots.get(c);
    return h(
      'button',
      {
        type: 'button',
        class: `torp-cell sea${shot ? ` ${shot}` : ''}${sunkThere.has(c) ? ' sunk' : ''}`,
        disabled: !active || state.phase !== 'play' || Boolean(shot),
        'data-cell': c,
        'aria-label': `${String.fromCharCode(65 + Math.floor(c / n))}${(c % n) + 1}${shot ? `, ${shot}` : ''}`,
        onclick: () => onMove({ cell: c }),
      },
      shot ? icon(shot === 'miss' ? 'dot' : 'x', 'shot') : null,
    );
  });
  return h(
    'div',
    { class: 'torp-boards' },
    h('div', { class: 'torp-side' }, h('h3', {}, 'Their waters'), grid(theirs, 'theirs', 'Their waters: pick a square to fire')),
    h('div', { class: 'torp-side' }, h('h3', {}, 'Your fleet'), grid(mine, 'mine', 'Your fleet')),
  );
}

/** Placing a fleet: click a square to put the next ship there, turn it, or let chance do it. */
export function fleetEditor({ onReady, randomFleet, readyLabel = 'Ready' }) {
  const n = TORPEDOES.size;
  let ships = [];
  let across = true;
  const box = h('div', { class: 'fleet-editor' });
  const nextLen = () => TORPEDOES.fleet[ships.length];

  function cellsAt(c, len) {
    const r = Math.floor(c / n);
    const col = c % n;
    if (across ? col + len > n : r + len > n) return null;
    const cells = [...Array(len).keys()].map((k) => (across ? c + k : c + k * n));
    const used = new Set(ships.flat());
    return cells.some((x) => used.has(x)) ? null : cells;
  }

  function draw() {
    const used = new Map();
    ships.forEach((s, k) => s.forEach((x) => used.set(x, k)));
    const len = nextLen();
    const cells = [...Array(n * n).keys()].map((c) =>
      h('button', {
        type: 'button',
        class: `torp-cell${used.has(c) ? ' ship' : ''}`,
        disabled: !len || !cellsAt(c, len),
        'aria-label': `${String.fromCharCode(65 + Math.floor(c / n))}${(c % n) + 1}`,
        onclick: () => {
          const cs = cellsAt(c, len);
          if (cs) {
            ships = [...ships, cs];
            draw();
          }
        },
      }),
    );
    box.replaceChildren(
      h('p', { class: 'fleet-help' }, len ? h('span', {}, h('span', {}, 'Place a ship of'), ' ', h('strong', { class: 'figures' }, String(len)), ' ', h('span', {}, 'squares')) : h('span', {}, 'Your fleet is ready.')),
      grid(cells, 'mine placing', 'Your fleet'),
      h(
        'div',
        { class: 'fleet-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => { across = !across; draw(); } }, icon('rotate-ccw'), across ? 'Across' : 'Down'),
        h('button', { type: 'button', class: 'btn small', onclick: () => { ships = randomFleet().ships; draw(); } }, icon('dice-5'), 'At random'),
        h('button', { type: 'button', class: 'btn small quiet', disabled: !ships.length, onclick: () => { ships = []; draw(); } }, 'Clear the grid'),
        h('button', { type: 'button', class: 'btn small primary', disabled: Boolean(len), onclick: () => onReady({ ships }) }, icon('check'), readyLabel),
      ),
    );
  }
  draw();
  return box;
}
