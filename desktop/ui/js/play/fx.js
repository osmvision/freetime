// What a move looks and sounds like. The boards are rebuilt on every draw, so a move is animated
// once the new board is in place: the moved piece starts where it was and slides to its square
// (FLIP). Called only when a move was actually played (`plies` went up), never on a plain redraw.
// Input never waits for an animation, and nothing moves under prefers-reduced-motion.

import { chessPiece } from './boards.js';
import { FOUR } from './rules.js';
import { sound } from './sound.js';

const reduced = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const STEP = 140; // ms per square of a draughts move

const cell = (root, i, scope = '') => root.querySelector(`${scope} [data-cell="${i}"]`);
const box = (el) => el.getBoundingClientRect();

/** Lifts `el` above its neighbours while `anim` runs. */
function lift(el, anim) {
  el.classList.add('fx-moving');
  const done = () => el.classList.remove('fx-moving');
  anim.addEventListener('finish', done);
  anim.addEventListener('cancel', done);
}

/** `el` (now in `to`) starts over each square of `path` in turn, then settles in `to`. */
function slide(el, path, to, ms) {
  if (!el || !to) return;
  const end = box(to);
  const frames = path.filter(Boolean).map((c) => {
    const r = box(c);
    return { transform: `translate(${r.left - end.left}px, ${r.top - end.top}px)` };
  });
  if (!frames.length) return;
  lift(el, el.animate([...frames, { transform: 'none' }], { duration: ms, easing: path.length > 1 ? 'linear' : EASE }));
}

/** A copy of a taken piece that fades out where it stood. */
function ghost(where, piece, delay) {
  if (!where) return;
  piece.classList.add('fx-ghost');
  where.append(piece);
  const a = piece.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.6)' }], { duration: 180, delay, easing: 'ease-in', fill: 'both' });
  a.addEventListener('finish', () => piece.remove());
}

const pop = (el, delay = 0) =>
  el?.animate(
    [
      { transform: 'scale(0.4)', opacity: 0 },
      { transform: 'scale(1.12)', opacity: 1, offset: 0.7 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 200, delay, easing: 'ease-out', fill: 'backwards' },
  );

function four(root, next) {
  const c = next.last;
  const target = cell(root, c);
  const disc = target?.querySelector('.piece');
  if (!disc) return 0;
  const row = Math.floor(c / FOUR.cols);
  const top = box(cell(root, c % FOUR.cols));
  const fall = box(target).top - top.top + top.height;
  const ms = 180 + row * 35;
  disc.animate(
    [
      { transform: `translateY(${-fall}px)`, easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
      { transform: 'translateY(0)', offset: 0.78, easing: 'ease-out' },
      { transform: `translateY(${-Math.min(10, top.height * 0.14)}px)`, offset: 0.9, easing: 'ease-in' },
      { transform: 'none' },
    ],
    { duration: ms },
  );
  return ms;
}

function draughts(root, prev, next) {
  const { path, captured } = next.last;
  const end = cell(root, path[path.length - 1]);
  const ms = STEP * (path.length - 1);
  slide(end?.querySelector('.piece'), path.slice(0, -1).map((i) => cell(root, i)), end, ms);
  const taker = Math.floor((prev.board[path[0]] - 1) / 2); // 1-2: player 0, 3-4: player 1
  captured.forEach((i, k) => {
    const v = prev.board[i];
    const king = v === 2 || v === 4;
    ghost(cell(root, i), Object.assign(document.createElement('span'), { className: `piece p${1 - taker}${king ? ' king' : ''}` }), STEP * (k + 0.6));
  });
  return ms;
}

function chess(root, prev, next) {
  const { from, to } = next.last;
  const moved = prev.board[from];
  const dest = cell(root, to);
  slide(dest?.querySelector('.chess-piece:not(.fx-ghost)'), [cell(root, from)], dest, 170);
  // Castling: the rook moves too.
  if (Math.abs(moved) === 6 && Math.abs(to - from) === 2) {
    const base = from - (from & 7);
    const [rf, rt] = to > from ? [base + 7, base + 5] : [base, base + 3];
    const rook = cell(root, rt);
    slide(rook?.querySelector('.chess-piece'), [cell(root, rf)], rook, 170);
  }
  // What was taken: on the square moved to, or beside it (en passant).
  const passant = Math.abs(moved) === 1 && prev.board[to] === 0 && (from & 7) !== (to & 7);
  const taken = passant ? from - (from & 7) + (to & 7) : prev.board[to] !== 0 ? to : -1;
  if (taken >= 0) ghost(cell(root, taken), chessPiece(Math.abs(prev.board[taken]), prev.board[taken] > 0), 90);
  return 170;
}

function dots(root, prev, next) {
  const line = root.querySelector(`[data-line="${next.last}"]`);
  line?.animate([{ transform: line.classList.contains('h') ? 'scaleX(0)' : 'scaleY(0)' }, { transform: 'none' }], { duration: 160, easing: EASE });
  next.boxes.forEach((o, b) => {
    if (o >= 0 && prev.boxes[b] === -1) pop(root.querySelector(`[data-box="${b}"]`), 120);
  });
  return 160;
}

function torpedoes(root, prev, next, me) {
  if (next.phase !== 'play' || prev.phase !== 'play') return 0;
  const shooter = prev.turn;
  const scope = shooter === me ? '.theirs' : '.mine';
  const target = cell(root, next.last, scope);
  const shot = next.shots[shooter].at(-1);
  if (!target || !shot) return 0;
  const ring = Object.assign(document.createElement('span'), { className: `fx-ring ${shot.r}` });
  target.append(ring);
  ring.animate([{ transform: 'scale(0.2)', opacity: 0.95 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: 480, easing: 'ease-out' }).addEventListener('finish', () => ring.remove());
  if (shot.r !== 'miss') target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'none' }], { duration: 240, easing: 'ease-out' });
  if (shot.r === 'sunk') {
    next.sunk[shooter].at(-1).forEach((c, k) => {
      cell(root, c, scope)?.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 360, delay: 200 + k * 60 });
    });
  }
  return 240;
}

function reversi(root, prev, next) {
  pop(cell(root, next.last)?.querySelector('.piece'));
  // The trapped discs turn over, one after another.
  next.flipped.forEach((c, k) => {
    cell(root, c)?.querySelector('.piece')?.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)', offset: 0.5 }, { transform: 'scaleX(1)' }], { duration: 260, delay: 90 + k * 45, easing: 'ease-in-out' });
  });
  return 90 + next.flipped.length * 45 + 260;
}

function awale(root, prev, next) {
  // Seeds land one pit after another; captured pits empty last.
  next.last.sown.forEach((c, k) => {
    cell(root, c)?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'none' }], { duration: 200, delay: k * 70, easing: 'ease-out' });
  });
  const end = next.last.sown.length * 70;
  next.last.captured.forEach((c) => {
    cell(root, c)?.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 320, delay: end, easing: 'ease-out', fill: 'backwards' });
  });
  return end + 200;
}

function ultimate(root, prev, next) {
  pop(cell(root, next.last)?.querySelector('.mark'));
  const g = Math.floor(next.last / 9);
  if (prev.grids[g] === -1 && (next.grids[g] === 0 || next.grids[g] === 1)) pop(root.querySelector(`[data-grid="${g}"] .ut-big`), 160);
  return 360;
}

/** The winning line lights up, one piece after another. */
function winLine(root, delay) {
  root.querySelectorAll('.win .piece, .win .mark').forEach((el, k) => {
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'none' }], { duration: 320, delay: delay + k * 70, easing: 'ease-out' });
  });
}

/** The sound of a move, from the player `me`'s side. */
function moveSound(prev, next, me) {
  if (next.winner !== null) return next.winner === 'draw' ? 'draw' : next.winner === me ? 'win' : 'lose';
  switch (next.game) {
    case 'chess':
      if (next.check) return 'check';
      return prev.board[next.last.to] !== 0 || (Math.abs(prev.board[next.last.from]) === 1 && (next.last.from & 7) !== (next.last.to & 7)) ? 'capture' : 'move';
    case 'draughts':
      return next.last.captured.length ? 'capture' : 'move';
    case 'dots':
      return next.boxes.some((o, b) => o >= 0 && prev.boxes[b] === -1) ? 'box' : 'move';
    case 'torpedoes':
      return next.phase === 'play' && prev.phase === 'play' ? next.shots[prev.turn].at(-1)?.r ?? null : null;
    case 'reversi':
      return next.flipped.length >= 4 ? 'capture' : 'move';
    case 'awale':
      return next.last.captured.length ? 'capture' : 'move';
    case 'ultimate': {
      const g = Math.floor(next.last / 9);
      return prev.grids[g] === -1 && next.grids[g] !== -1 ? 'box' : 'move';
    }
    default:
      return 'move';
  }
}

/**
 * A move was played between `prev` and `next` (the board for `next` is already in `root`):
 * animate it and play its sound. `me` is the player whose side we're on.
 */
export function moved(root, prev, next, me) {
  if (!prev || !next || prev.game !== next.game || next.plies <= prev.plies) return;
  const name = moveSound(prev, next, me);
  if (name) sound(name);
  if (reduced() || next.last == null) return;
  try {
    const gomoku = (r) => (pop(cell(r, next.last)?.querySelector('.mark')), 200);
    const ms = { four, gomoku, draughts, chess, dots, torpedoes, reversi, awale, ultimate }[next.game]?.(root, prev, next, me) ?? 0;
    if (next.winner !== null && next.winner !== 'draw') winLine(root, ms + 60);
  } catch {
    // An animation is never worth breaking the game for.
  }
}

/** It just became your turn: the status band gives a small nudge. */
export function yourTurn(el) {
  if (reduced()) return;
  el?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'none' }], { duration: 320, easing: 'ease-out' });
}
