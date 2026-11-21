// The problem of the day: a chess mate in 2 or a Four in a row win in 2 or 3, on the games' own
// boards (play/boards.js). Find the move that wins whatever the computer answers; it defends as
// long as it can. A move that lets the win slip away is shown, then the position comes back.

import { api } from '../api.js';
import { btn, errText, fill, h, toast } from '../dom.js';
import { gameWindow } from '../game-window.js';
import { t } from '../i18n.js';
import { board } from '../play/boards.js';
import { moved } from '../play/fx.js';
import { play } from '../play/rules.js';
import { sound } from '../play/sound.js';
import { PROBLEMS } from './problems-days.js';
import { bestDefence, decodeProblem, holds } from './problems.js';
import { shareResult } from './friends.js';

/** Today's problem, by its number (the same days as the Path and Zones). */
export function problemOf(number) {
  return decodeProblem(PROBLEMS[(number - 1) % PROBLEMS.length]);
}

/** "Mate in 2" / "Win in 3 moves", and the game's name. */
export function problemLabel(p) {
  return { goal: p.game === 'chess' ? `Mate in ${p.n}` : `Win in ${p.n} moves`, game: p.game === 'chess' ? 'Chess' : 'Four in a row' };
}

const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

export function openProblem(today, onDone = () => {}) {
  const p = problemOf(today.number);
  const { goal, game } = problemLabel(p);
  const me = p.player;
  let state = p.state;
  let left = p.n; // moves still to find
  let busy = false;
  let solved = false;
  let secs = 0;
  let tries = 1;

  const ui = gameWindow({
    name: 'Problem of the day',
    iconName: 'target',
    head: [h('span', {}, game), ' ', h('span', { class: 'figures' }, `#${today.number}`)],
    className: `problem-window game-${p.game}`,
    rule:
      p.game === 'chess'
        ? 'Find the move that mates in two, whatever the computer answers. It defends as well as it can.'
        : 'Find the move that wins in time, whatever the computer answers. It defends as well as it can.',
    onClose: () => clearInterval(tick),
  });
  const tick = setInterval(() => {
    if (solved || document.visibilityState !== 'visible') return;
    secs += 1;
  }, 1000);

  function line() {
    const side = p.game === 'chess' ? (me === state.white ? 'White to play' : 'Black to play') : 'You play';
    return [
      h('strong', { class: 'game-your-turn' }, h('span', {}, side), ' · ', h('span', {}, goal)),
    ];
  }

  function draw(prev = null) {
    if (!solved) fill(ui.status, ...line());
    ui.status.classList.toggle('mine', !solved && !busy);
    ui.area.replaceChildren(board(state, { me, active: !solved && !busy && state.turn === me, onMove: move, taken: false }));
    moved(ui.area, prev, state, me);
  }

  function reset() {
    state = p.state;
    left = p.n;
    busy = false;
    draw();
  }

  function move(m) {
    if (busy || solved) return;
    const before = state;
    try {
      state = play(state, me, m).state;
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    if (state.winner === me) return win(before);
    busy = true;
    draw(before);
    // Let the move show before the check (a chess position takes a moment).
    setTimeout(() => {
      if (!ui.isOpen()) return;
      if (!holds(state, me, left - 1)) {
        tries += 1;
        sound('lose');
        fill(ui.status, h('strong', { class: 'game-result lost' }, 'Not the winning move'), h('span', { class: 'game-score' }, 'Try again'));
        setTimeout(() => ui.isOpen() && reset(), 1300);
        return;
      }
      const reply = bestDefence(state, me, left - 1);
      const mid = state;
      state = play(state, state.turn, reply).state;
      left -= 1;
      busy = false;
      draw(mid);
    }, 450);
  }

  async function win(prev) {
    solved = true;
    draw(prev);
    let done = { secs };
    try {
      const view = await api.finishPuzzle('problem', secs);
      done = view.solved.problem ?? done;
      api.syncPoints().catch(() => {});
      shareResult(today.date, 'problem', done.secs);
    } catch (e) {
      toast(errText(e), 'error', 5000);
    }
    fill(
      ui.status,
      h('strong', { class: 'game-result won' }, h('span', {}, 'Solved in'), ' ', h('span', { class: 'figures' }, clock(done.secs))),
      tries > 1 ? h('span', { class: 'game-score' }, h('span', { class: 'figures' }, String(tries)), ' ', h('span', {}, 'tries')) : null,
    );
    fill(
      ui.tools,
      btn({ label: 'Share my time', icon: 'share-2', small: true, kind: 'primary', onclick: () => shareProblem(today.number, done.secs) }),
      btn({ label: 'Close', small: true, onclick: ui.close }),
    );
    onDone();
  }

  fill(ui.tools, btn({ label: 'Start again', icon: 'rotate-ccw', small: true, onclick: reset }), btn({ label: 'Close', small: true, onclick: ui.close }));
  draw();
}

export async function shareProblem(number, secs) {
  const text = `freetime · ${t('Problem of the day')} #${number} · ${clock(secs)}`;
  try {
    await navigator.clipboard.writeText(text);
    toast(`${t('Copied')}: ${text}`, 'ok', 3500);
  } catch {
    toast(text, 'ok', 8000);
  }
}
