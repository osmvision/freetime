// The puzzles of the day on the Games page: a Path and a Zones grid, the same for everyone, made
// ahead of time (days.js) and checked here (logic.js). A solve is saved by the app (quiz log and
// history) and earns Ranked points. Progress and the clock are kept on this device until solved.

import { api } from '../api.js';
import { btn, errText, fill, h, icon, toast } from '../dom.js';
import { gameWindow } from '../game-window.js';
import { t } from '../i18n.js';
import { sound } from '../play/sound.js';
import { DAYS, FIRST_DAY } from './days.js';
import { decode, pathSolved, sides, zonesConflicts, zonesSolved } from './logic.js';
import { GUESS_MAX, openGuess, shareGuess } from './guess.js';
import { openProblem, problemLabel, problemOf, shareProblem } from './problem.js';
import { renderFriendsToday, shareResult } from './friends.js';

const KIND_INFO = {
  path: {
    name: 'Path',
    title: 'Path of the day',
    icon: 'route',
    rule: 'Draw one line through every square, from 1 to the last number, passing the numbers in order. Drag, or click the squares next to the end of the line.',
  },
  zones: {
    name: 'Zones',
    title: 'Zones of the day',
    icon: 'grid-3x3',
    rule: 'Put one star in every row, every column and every coloured zone. Stars can’t touch, not even at a corner. Click once for a cross, twice for a star.',
  },
};

const DAY_MS = 86400000;
const LEVELS = ['Hard', 'Easy', 'Easy', 'Medium', 'Medium', 'Medium', 'Hard']; // Sunday first

/** Today's puzzles, from the date the app gives ("2026-11-21"). */
export function puzzlesOf(date) {
  const at = Date.parse(`${date}T00:00:00Z`);
  const number = Math.max(1, Math.round((at - Date.parse(`${FIRST_DAY}T00:00:00Z`)) / DAY_MS) + 1);
  // Past the last day made, the year starts over (until make-puzzles.mjs adds more).
  const [path, zones] = DAYS[(number - 1) % DAYS.length];
  return { date, number, level: LEVELS[new Date(at).getUTCDay()], path: decode('path', path), zones: decode('zones', zones) };
}

export const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Not kept: the puzzle starts over next time.
    }
  },
};

// ---------------------------------------------------------------- the section on the Games page

export async function renderPuzzles(box) {
  let view;
  try {
    view = await api.puzzles();
  } catch (e) {
    fill(box, h('p', { class: 'hint' }, errText(e)));
    return;
  }
  const today = puzzlesOf(view.date);
  const again = () => renderPuzzles(box);
  const friends = h('div', { class: 'friends-today-box', hidden: true });
  fill(
    box,
    h(
      'div',
      { class: 'duels-head' },
      h('div', {}, h('h2', {}, 'Games of the day'), h('p', { class: 'hint' }, 'The same for everyone, new each day. 2 ranking points each.')),
      view.streak >= 2 ? h('span', { class: 'puzzle-streak' }, icon('flame'), h('span', { class: 'figures' }, String(view.streak)), ' ', h('span', {}, 'days in a row')) : null,
    ),
    h('div', { class: 'puzzles-today' }, ['path', 'zones'].map((kind) => puzzleCard(kind, today, view.solved[kind], again)), guessCard(today, view.solved.guess, again), problemCard(today, view.solved.problem, again)),
    friends,
  );
  renderFriendsToday(friends, view);
}

function puzzleCard(kind, today, solve, again) {
  const info = KIND_INFO[kind];
  const p = today[kind];
  return h(
    'div',
    { class: `mini-ticket puzzle-card${solve ? ' done' : ''}` },
    h('span', { class: 'mini-icon' }, icon(info.icon)),
    h(
      'div',
      { class: 'mini-text' },
      h('span', { class: 'mini-k' }, info.title),
      solve
        ? h('strong', {}, h('span', {}, 'Solved in'), ' ', h('span', { class: 'figures' }, clock(solve.secs)))
        : h('strong', {}, `${p.n} × ${p.n} · ${today.level}`),
      h('span', { class: 'mini-sub' }, solve ? 'A new one tomorrow' : h('span', { class: 'figures' }, `#${today.number}`)),
    ),
    solve
      ? btn({ label: 'Share my time', icon: 'share-2', square: true, onclick: () => share(kind, today.number, solve.secs) })
      : btn({ label: `Play: ${info.title}`, icon: 'play', square: true, onclick: () => openPuzzle(kind, today, again) }),
  );
}

function guessCard(today, done, again) {
  return h(
    'div',
    { class: `mini-ticket puzzle-card${done ? ' done' : ''}` },
    h('span', { class: 'mini-icon' }, icon('image')),
    h(
      'div',
      { class: 'mini-text' },
      h('span', { class: 'mini-k' }, 'Guess the activity'),
      done
        ? h('strong', {}, h('span', { class: 'figures' }, `${done.score ?? 0}/${GUESS_MAX}`), ' ', h('span', {}, 'today'))
        : h('strong', {}, '5 photos · 1 min'),
      h('span', { class: 'mini-sub' }, done ? 'A new one tomorrow' : h('span', { class: 'figures' }, `#${today.number}`)),
    ),
    done
      ? btn({ label: 'Share my score', icon: 'share-2', square: true, onclick: () => shareGuess(today.number, done.score ?? 0) })
      : btn({ label: 'Play: Guess the activity', icon: 'play', square: true, onclick: () => openGuess(today, again) }),
  );
}

function problemCard(today, done, again) {
  const { goal, game } = problemLabel(problemOf(today.number));
  return h(
    'div',
    { class: `mini-ticket puzzle-card${done ? ' done' : ''}` },
    h('span', { class: 'mini-icon' }, icon('target')),
    h(
      'div',
      { class: 'mini-text' },
      h('span', { class: 'mini-k' }, 'Problem of the day'),
      done ? h('strong', {}, h('span', {}, 'Solved in'), ' ', h('span', { class: 'figures' }, clock(done.secs))) : h('strong', {}, `${goal} · ${game}`),
      h('span', { class: 'mini-sub' }, done ? 'A new one tomorrow' : h('span', { class: 'figures' }, `#${today.number}`)),
    ),
    done
      ? btn({ label: 'Share my time', icon: 'share-2', square: true, onclick: () => shareProblem(today.number, done.secs) })
      : btn({ label: 'Play: Problem of the day', icon: 'play', square: true, onclick: () => openProblem(today, again) }),
  );
}

/** A spoiler-free line to paste anywhere: the puzzle and the time, nothing of the answer. */
async function share(kind, number, secs) {
  const text = `freetime · ${t(KIND_INFO[kind].name)} #${number} · ${clock(secs)}`;
  try {
    await navigator.clipboard.writeText(text);
    toast(`${t('Copied')}: ${text}`, 'ok', 3500);
  } catch {
    toast(text, 'ok', 8000); // no clipboard: at least it can be read and typed
  }
}

// ---------------------------------------------------------------- the puzzle window

export function openPuzzle(kind, today, onDone = () => {}) {
  const info = KIND_INFO[kind];
  const p = today[kind];
  const key = `freetime.puzzle.${today.date}.${kind}`;
  const saved = store.get(key) ?? {};
  let secs = saved.secs ?? 0;
  let solved = false;
  let board = null;

  const ui = gameWindow({
    name: info.title,
    iconName: info.icon,
    head: h('span', { class: 'figures' }, `#${today.number}`),
    rule: info.rule,
    className: `puzzle-window puzzle-${kind}`,
    onClose: () => {
      clearInterval(tick);
      if (!solved) save(board.state());
    },
  });
  const time = h('span', { class: 'figures puzzle-clock', 'aria-label': 'Time' }, clock(secs));
  const progress = h('span', { class: 'puzzle-progress' });
  ui.status.removeAttribute('aria-live'); // the clock ticks: only the progress is announced
  progress.setAttribute('aria-live', 'polite');
  ui.status.append(time, progress);
  const save = (state) => store.set(key, { ...state, secs });

  const tick = setInterval(() => {
    if (solved || document.visibilityState !== 'visible') return;
    secs += 1;
    time.textContent = clock(secs);
  }, 1000);

  async function finish() {
    solved = true;
    sound('win');
    try {
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        board.el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
      }
    } catch {
      // no animation, no problem
    }
    let done = { secs };
    try {
      const view = await api.finishPuzzle(kind, secs);
      done = view.solved[kind] ?? done;
      api.syncPoints().catch(() => {}); // Ranked (signed in only; quiet otherwise)
      shareResult(today.date, kind, done.secs);
    } catch (e) {
      toast(errText(e), 'error', 5000);
    }
    store.set(key, null);
    ui.status.setAttribute('aria-live', 'polite');
    fill(ui.status, h('strong', { class: 'game-result won' }, h('span', {}, 'Solved in'), ' ', h('span', { class: 'figures' }, clock(done.secs))));
    fill(
      ui.tools,
      btn({ label: 'Share my time', icon: 'share-2', small: true, kind: 'primary', onclick: () => share(kind, today.number, done.secs) }),
      btn({ label: 'Close', small: true, onclick: ui.close }),
    );
    onDone();
  }

  board = kind === 'path' ? pathBoard(p, saved, { save, progress, finish }) : zonesBoard(p, saved, { save, progress, finish });
  ui.area.append(board.el);
  ui.tools.append(
    btn({ label: 'Start again', icon: 'rotate-ccw', small: true, onclick: () => board.reset() }),
    btn({ label: 'Close', small: true, onclick: ui.close }),
  );
  board.focus();
}

/** Arrow keys move the focus around a grid of buttons (one tab stop for the whole grid). */
function roving(cells, n, onMove) {
  let at = 0;
  const focus = (c, move = true) => {
    cells[at].tabIndex = -1;
    at = c;
    cells[at].tabIndex = 0;
    if (move) cells[at].focus();
  };
  cells.forEach((el, c) => {
    el.tabIndex = c === 0 ? 0 : -1;
    el.addEventListener('focus', () => focus(c, false));
    el.addEventListener('keydown', (e) => {
      const step = { ArrowUp: -n, ArrowDown: n, ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      const to = c + step;
      if (to < 0 || to >= n * n || (Math.abs(step) === 1 && Math.floor(to / n) !== Math.floor(c / n))) return;
      onMove?.(c, to);
      focus(to);
    });
  });
  return focus;
}

const where = (n, c) => `${t('Row')} ${Math.floor(c / n) + 1}, ${t('column')} ${(c % n) + 1}`;

// ---------------------------------------------------------------- path

const SVG_NS = 'http://www.w3.org/2000/svg';

function pathBoard(p, saved, { save, progress, finish }) {
  const { n, hints } = p;
  const total = n * n;
  const number = new Map(hints.map((c, i) => [c, i]));
  const end = hints[hints.length - 1];
  let line = [];
  let done = false;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('class', 'path-line');
  svg.setAttribute('aria-hidden', 'true');
  const poly = document.createElementNS(SVG_NS, 'polyline');
  svg.append(poly);
  const cells = [...Array(total).keys()].map((c) =>
    h('button', { type: 'button', class: 'pz-cell', 'data-cell': c }, number.has(c) ? h('span', { class: 'pz-num figures' }, String(number.get(c) + 1)) : null),
  );
  const grid = h('div', { class: 'puzzle-grid path-grid', role: 'grid', 'aria-label': 'Path', style: `--n:${n}` }, svg, cells);

  const nextNumber = () => line.filter((c) => number.has(c)).length;

  /** Adds `c` to the line, or goes back to it if it's already on it. */
  function step(c) {
    if (done) return false;
    if (!line.length) {
      if (c !== hints[0]) return false;
      line = [c];
      return true;
    }
    const head = line[line.length - 1];
    if (c === head) return false;
    const i = line.indexOf(c);
    if (i >= 0) {
      line = line.slice(0, i + 1);
      return true;
    }
    if (!sides(n, head).includes(c)) return false;
    if (number.has(c) && number.get(c) !== nextNumber()) return false;
    if (c === end && line.length !== total - 1) return false;
    line = [...line, c];
    return true;
  }

  function draw() {
    const on = new Set(line);
    const head = line[line.length - 1];
    cells.forEach((el, c) => {
      el.classList.toggle('on', on.has(c));
      el.classList.toggle('head', c === head);
      el.setAttribute('aria-label', `${where(n, c)}${number.has(c) ? `, ${t('number')} ${number.get(c) + 1}` : ''}${on.has(c) ? `, ${t('on the line')}` : ''}`);
      el.disabled = done;
    });
    poly.setAttribute('points', line.map((c) => `${(c % n) + 0.5},${Math.floor(c / n) + 0.5}`).join(' '));
    progress.textContent = `${line.length}/${total}`;
  }

  function changed() {
    draw();
    save({ line });
    if (line.length === total && pathSolved(p, line)) {
      done = true;
      draw();
      finish();
    }
  }

  // The saved line goes through the rules again: a damaged or outdated save stops where it breaks.
  for (const c of Array.isArray(saved.line) ? saved.line : []) if (!step(c)) break;

  // Drag: the board keeps the pointer, and the square under it extends (or shortens) the line.
  let dragging = false;
  const cellAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.pz-cell');
    return el && grid.contains(el) ? Number(el.dataset.cell) : -1;
  };
  grid.addEventListener('pointerdown', (e) => {
    const c = cellAt(e);
    if (c < 0 || done) return;
    if (step(c) || line[line.length - 1] === c) {
      dragging = true;
      grid.setPointerCapture?.(e.pointerId);
      changed();
    }
  });
  grid.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const c = cellAt(e);
    if (c >= 0 && c !== line[line.length - 1] && step(c)) changed();
  });
  const stop = () => (dragging = false);
  grid.addEventListener('pointerup', stop);
  grid.addEventListener('pointercancel', stop);
  // Keyboard: Enter or Space on a square is a click; arrows from the end of the line draw it.
  cells.forEach((el, c) =>
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (step(c)) changed();
      } else if (e.key === 'Backspace' && line.length) {
        e.preventDefault();
        line = line.slice(0, -1);
        changed();
      }
    }),
  );
  const focusAt = roving(cells, n, (from, to) => {
    if (from === line[line.length - 1] && step(to)) changed();
  });

  draw();
  return {
    el: grid,
    state: () => ({ line }),
    reset: () => {
      line = [];
      changed();
      focusAt(hints[0]);
    },
    focus: () => focusAt(line.length ? line[line.length - 1] : hints[0]),
  };
}

// ---------------------------------------------------------------- zones

function zonesBoard(p, saved, { save, progress, finish }) {
  const { n, regions } = p;
  const total = n * n;
  // 1 = a cross (the player's note), 2 = a star.
  let marks = new Map(Object.entries(saved.marks ?? {}).map(([c, v]) => [Number(c), v]).filter(([c, v]) => c >= 0 && c < total && (v === 1 || v === 2)));
  let done = false;

  // A thick line between two zones, so they read without the colours too (the board's own border
  // is the outside edge).
  const cells = [...Array(total).keys()].map((c) => {
    const r = Math.floor(c / n);
    const k = c % n;
    const walls = [
      r > 0 && regions[c - n] !== regions[c] ? ' wall-t' : '',
      r < n - 1 && regions[c + n] !== regions[c] ? ' wall-b' : '',
      k > 0 && regions[c - 1] !== regions[c] ? ' wall-l' : '',
      k < n - 1 && regions[c + 1] !== regions[c] ? ' wall-r' : '',
    ].join('');
    return h('button', { type: 'button', class: `pz-cell zone-${regions[c]}${walls}`, 'data-cell': c, onclick: () => cycle(c) });
  });
  const grid = h('div', { class: 'puzzle-grid zones-grid', role: 'grid', 'aria-label': 'Zones', style: `--n:${n}` }, cells);

  const stars = () => [...marks].filter(([, v]) => v === 2).map(([c]) => c);

  function cycle(c) {
    if (done) return;
    const v = ((marks.get(c) ?? 0) + 1) % 3;
    if (v) marks.set(c, v);
    else marks.delete(c);
    changed();
  }

  function draw() {
    const bad = zonesConflicts(p, stars());
    cells.forEach((el, c) => {
      const v = marks.get(c) ?? 0;
      el.classList.toggle('star', v === 2);
      el.classList.toggle('cross', v === 1);
      el.classList.toggle('bad', bad.has(c));
      el.replaceChildren(v === 2 ? icon('star') : v === 1 ? icon('x') : '');
      el.setAttribute('aria-label', `${where(n, c)}, ${t('zone')} ${regions[c] + 1}${v === 2 ? `, ${t('star')}` : v === 1 ? `, ${t('cross')}` : ''}${bad.has(c) ? `, ${t('breaks a rule')}` : ''}`);
      el.disabled = done;
    });
    progress.replaceChildren(h('span', { class: 'figures' }, `${stars().length}/${n}`), icon('star', 'progress-star'));
  }

  function changed() {
    draw();
    save({ marks: Object.fromEntries(marks) });
    if (zonesSolved(p, stars())) {
      done = true;
      draw();
      finish();
    }
  }

  const focusAt = roving(cells, n);
  draw();
  return {
    el: grid,
    state: () => ({ marks: Object.fromEntries(marks) }),
    reset: () => {
      marks = new Map();
      changed();
      focusAt(0);
    },
    focus: () => focusAt(0),
  };
}
