// The boards of the turn-based games, drawn with buttons (keyboard and screen reader friendly).
// board(state, opts) returns an element. opts: { me, active, onMove(move), secret, names }.
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
  const columns = [...Array(cols).keys()].map((c) =>
    h(
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
        return h('span', { class: `four-cell${line.has(cell) ? ' win' : ''}${state.last === cell ? ' last' : ''}` }, v === -1 ? null : piece(v));
      }),
    ),
  );
  return h('div', { class: 'board four-board', role: 'group', 'aria-label': 'Four in a row' }, columns);
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
          disabled: !active || v !== -1,
          'aria-label': `Row ${Math.floor(cell / n) + 1}, column ${(cell % n) + 1}${v === -1 ? '' : v === 0 ? ', cross' : ', circle'}`,
          onclick: () => onMove({ cell }),
        },
        v === -1 ? null : h('span', { class: `mark p${v}`, 'aria-hidden': 'true' }, v === 0 ? '✕' : '◯'),
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

// ---------------------------------------------------------------- dots and boxes

function dotsBoard(state, { active, onMove }) {
  const n = DOTS.size;
  const items = [];
  const lineBtn = (index, dir) =>
    h('button', {
      type: 'button',
      class: `dot-line ${dir}${state.lines[index] >= 0 ? ` drawn p${state.lines[index]}` : ''}${state.last === index ? ' last' : ''}`,
      disabled: !active || state.lines[index] !== -1,
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
        items.push(h('span', { class: `dot-box${o >= 0 ? ` p${o}` : ''}` }, o >= 0 ? h('span', { 'aria-hidden': 'true' }, o === 0 ? '✕' : '◯') : null));
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
      { class: `torp-cell${myShips.has(c) ? ' ship' : ''}${shot ? ` ${shot}` : ''}${state.last === c && state.turn === me ? ' last' : ''}` },
      shot ? h('span', { 'aria-hidden': 'true' }, shot === 'miss' ? '•' : '✕') : null,
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
        'aria-label': `${String.fromCharCode(65 + Math.floor(c / n))}${(c % n) + 1}${shot ? `, ${shot}` : ''}`,
        onclick: () => onMove({ cell: c }),
      },
      shot ? h('span', { 'aria-hidden': 'true' }, shot === 'miss' ? '•' : '✕') : null,
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
