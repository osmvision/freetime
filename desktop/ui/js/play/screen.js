// The game window: against the computer (all on this device, saved between sessions) or against a
// friend (every move goes through the games Edge Function, which checks it with the same rules).

import { api } from '../api.js';
import { btn, errText, h, icon, toast } from '../dom.js';
import { computerMove, randomFleet } from './ai.js';
import { board, fleetEditor } from './boards.js';
import { newGame, play, scores } from './rules.js';

export const GAME_INFO = {
  four: { name: 'Four in a row', icon: 'grid-2x2', rule: 'Drop a disc in turn. Line up 4, across, down or diagonally, to win.' },
  gomoku: { name: 'Giant tic-tac-toe', icon: 'hash', rule: 'Mark a square in turn. Line up 5 to win.' },
  draughts: { name: 'Draughts', icon: 'circle-dot', rule: 'International rules: captures are compulsory (the longest one), men capture backwards, kings fly.' },
  dots: { name: 'Dots and boxes', icon: 'square-dashed', rule: 'Draw a line in turn. Close a box to score it and play again. Most boxes wins.' },
  torpedoes: { name: 'Torpedoes', icon: 'anchor', rule: 'Hide 4 ships, then fire one shot in turn. Sink the whole fleet first.' },
  chess: { name: 'Chess', icon: 'crown', rule: 'Checkmate the king. Castling, en passant and promotion are allowed. Stalemate and repeated positions are draws.' },
};

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
      // Private mode or full storage: the game just isn't kept.
    }
  },
};

/** The window frame shared by both kinds of games. */
function frame(game, opponent, onClose) {
  const previousFocus = document.activeElement;
  const status = h('div', { class: 'game-status', 'aria-live': 'polite' });
  const area = h('div', { class: 'game-area' });
  const tools = h('div', { class: 'game-tools' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const card = h(
    'section',
    { class: `quiz game-window game-${game}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': GAME_INFO[game].name },
    h(
      'div',
      { class: 'coupon-head' },
      h('span', { class: 'game-title' }, icon(GAME_INFO[game].icon), h('span', {}, GAME_INFO[game].name), h('span', { class: 'game-vs' }, h('span', {}, 'vs'), ' ', opponent)),
      h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close', onclick: close }, icon('x')),
    ),
    h('div', { class: 'quiz-body game-body' }, status, area, h('p', { class: 'game-rule' }, GAME_INFO[game].rule), tools),
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  card.querySelector('.quiz-close').focus();
  return { status, area, tools, close, isOpen: () => backdrop.isConnected };
}

/** "Your turn", "Julian is playing", "You won!"... with the Dots and boxes score. */
function statusLine(state, me, otherName, thinking) {
  const parts = [];
  if (state.winner !== null) {
    const text = state.winner === 'draw' ? 'Draw!' : state.winner === me ? 'You won!' : otherName ? null : 'The computer won';
    parts.push(h('strong', { class: `game-result ${state.winner === me ? 'won' : state.winner === 'draw' ? 'draw' : 'lost'}` }, text ?? h('span', {}, h('span', { translate: 'no' }, otherName), ' ', h('span', {}, 'won'))));
  } else if (state.game === 'torpedoes' && state.phase === 'setup') {
    parts.push(h('strong', {}, state.turn === me ? 'Place your ships' : otherName ? h('span', {}, h('span', { translate: 'no' }, otherName), ' ', h('span', {}, 'is placing their ships')) : 'The computer is placing its ships'));
  } else if (state.turn === me) {
    parts.push(h('strong', { class: 'game-your-turn' }, h('span', { class: `piece p${me}`, 'aria-hidden': 'true' }), 'Your turn'));
  } else {
    parts.push(h('strong', {}, h('span', { class: `piece p${1 - me}`, 'aria-hidden': 'true' }), otherName ? h('span', {}, h('span', {}, 'Waiting for'), ' ', h('span', { translate: 'no' }, otherName)) : thinking ? 'The computer is thinking…' : 'The computer’s turn'));
  }
  if (state.game === 'chess' && state.check && state.winner === null) parts.push(h('strong', { class: 'game-check' }, 'Check!'));
  const sc = scores(state);
  if (sc) parts.push(h('span', { class: 'game-score figures' }, `${sc[me]} – ${sc[1 - me]}`));
  if (state.game === 'torpedoes' && state.phase === 'play') {
    parts.push(h('span', { class: 'game-score' }, h('span', { class: 'figures' }, `${state.sunk[me].length}/4`), ' ', h('span', {}, 'sunk')));
  }
  return parts;
}

// ---------------------------------------------------------------- against the computer

export function playComputer(game) {
  const key = `freetime.play.${game}`;
  let saved = store.get(key);
  if (!saved || saved.state?.game !== game || saved.state.winner !== null) saved = null;
  let level = saved?.level ?? store.get('freetime.play.level') ?? 1;
  let humanFirst = saved?.humanFirst ?? true;
  let state = saved?.state ?? newGame(game, 0);
  let secrets = saved?.secrets ?? [null, null];
  let thinking = false;
  const ui = frame(game, h('span', {}, 'the computer'));

  const restart = () => {
    humanFirst = !humanFirst;
    state = newGame(game, humanFirst ? 0 : 1);
    secrets = [null, null];
    save();
    draw();
    think();
  };
  const save = () => store.set(key, state.winner === null ? { state, secrets, level, humanFirst } : null);

  function move(m, p) {
    try {
      const r = play(state, p, m, secrets);
      if (r.secret) secrets = Object.assign([...secrets], { [p]: r.secret });
      state = r.state;
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    save();
    draw();
    think();
  }

  function think() {
    if (state.winner !== null || state.turn !== 1 || thinking) return;
    thinking = true;
    draw();
    setTimeout(() => {
      thinking = false;
      if (!ui.isOpen()) return;
      const m = computerMove(state, 1, level);
      if (m) move(m, 1);
    }, game === 'torpedoes' && state.phase === 'setup' ? 200 : 550);
  }

  function draw() {
    ui.status.replaceChildren(...statusLine(state, 0, null, thinking));
    const placing = game === 'torpedoes' && state.phase === 'setup' && state.turn === 0;
    ui.area.replaceChildren(
      placing
        ? fleetEditor({ randomFleet, onReady: (fleet) => move({ fleet }, 0) })
        : board(state, { me: 0, active: state.turn === 0 && !thinking, onMove: (m) => move(m, 0), secret: secrets[0] }),
    );
    const levels = h(
      'div',
      { class: 'seg small', role: 'radiogroup', 'aria-label': 'Level' },
      [
        [1, 'Easy'],
        [2, 'Hard'],
      ].map(([v, label]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: 'seg-btn',
            'aria-checked': String(level === v),
            'aria-selected': String(level === v),
            onclick: () => {
              if (level === v) return;
              level = v;
              store.set('freetime.play.level', v);
              save();
              draw();
            },
          },
          label,
        ),
      ),
    );
    ui.tools.replaceChildren(levels, btn({ label: state.winner === null ? 'Start again' : 'Play again', icon: 'refresh-cw', small: true, kind: state.winner === null ? '' : 'primary', onclick: restart }));
  }

  draw();
  think();
}

// ---------------------------------------------------------------- against a friend

/** Starts a game with a friend (Torpedoes: place your ships first), then opens it. */
export async function challenge(game, friend, onChange = () => {}) {
  const start = async (fleet) => {
    let r;
    try {
      r = await api.gameAction({ action: 'start', game, opponent: friend.user_id, fleet });
    } catch (e) {
      toast(errText(e), 'error', 6000);
      return false;
    }
    onChange();
    const list = await api.myMatches().catch(() => []);
    const match = list.find((m) => m.id === r.id);
    if (match) playOnline(match, onChange);
    return true;
  };
  if (game !== 'torpedoes') return start(undefined);
  const ui = frame(game, h('span', { translate: 'no' }, friend.display_name));
  ui.status.replaceChildren(h('strong', {}, 'Place your ships'));
  ui.area.replaceChildren(
    fleetEditor({
      randomFleet,
      readyLabel: 'Send the challenge',
      onReady: async (fleet) => {
        if (await start(fleet)) ui.close();
      },
    }),
  );
}

/** Opens a game with a friend (a row of my_matches). Follows the other player's moves live. */
export function playOnline(match, onChange = () => {}) {
  let m = match;
  let busy = false;
  const name = m.other.display_name;
  const ui = frame(m.game, h('span', { translate: 'no' }, name), () => {
    document.removeEventListener('matches-changed', reload);
    onChange();
  });

  async function reload() {
    try {
      const list = await api.myMatches();
      const fresh = list.find((x) => x.id === m.id);
      if (fresh && (fresh.version !== m.version || fresh.outcome !== m.outcome)) {
        m = fresh;
        draw();
      }
    } catch {
      // Offline: the next change brings it back.
    }
  }
  document.addEventListener('matches-changed', reload);

  async function send(move) {
    if (busy) return;
    busy = true;
    draw();
    try {
      const r = await api.gameAction({ action: 'move', match: m.id, version: m.version, move });
      m = { ...m, state: r.state, version: r.version, my_secret: move.fleet ? move.fleet : m.my_secret };
      if (r.state.winner !== null) m.outcome = r.state.winner === 'draw' ? 'draw' : r.state.winner === m.me ? 'won' : 'lost';
    } catch (e) {
      const text = errText(e);
      if (/HTTP 409/.test(text)) await reload();
      toast(text.replace(/\s*\(HTTP \d+\)$/, ''), 'error', 5000);
    } finally {
      busy = false;
      draw();
    }
  }

  async function leave() {
    try {
      const r = await api.leaveMatch(m.id);
      toast(r === 'resigned' ? 'You resigned' : r === 'declined' ? 'Game declined' : 'Game cancelled', 'ok');
      onChange();
      ui.close();
    } catch (e) {
      toast(errText(e), 'error');
    }
  }

  function draw() {
    const s = m.state;
    const over = m.outcome && m.outcome !== null;
    const parts = statusLine(s, m.me, name, false);
    if (over && ['declined', 'cancelled', 'expired'].includes(m.outcome)) {
      parts.splice(0, parts.length, h('strong', {}, { declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired: nobody played for 7 days' }[m.outcome]));
    } else if (m.outcome === 'won' && s.winner === null) {
      parts.splice(0, 1, h('strong', { class: 'game-result won' }, h('span', { translate: 'no' }, name), ' ', h('span', {}, 'resigned: you won!')));
    } else if (m.outcome === 'lost' && s.winner === null) {
      parts.splice(0, 1, h('strong', { class: 'game-result lost' }, 'You resigned'));
    }
    ui.status.replaceChildren(...parts);
    const myTurn = !over && s.turn === m.me && !busy;
    const placing = s.game === 'torpedoes' && s.phase === 'setup' && s.turn === m.me && !s.ready[m.me] && !over;
    const finished = ['won', 'lost', 'draw'].includes(m.outcome);
    if (finished && !endBox) endBox = gameEnd(m, name);
    ui.area.replaceChildren(
      placing ? fleetEditor({ randomFleet, onReady: (fleet) => send({ fleet }) }) : board(s, { me: m.me, active: myTurn, onMove: send, secret: m.my_secret }),
      finished ? endBox : null,
    );
    const tools = [];
    if (finished) {
      tools.push(btn({ label: 'Rematch', icon: 'rotate-ccw', small: true, kind: 'primary', onclick: () => rematch(m, name, ui.close, onChange) }));
    }
    if (!over) {
      const label = !m.b_moved ? (m.me === 1 ? 'Decline' : 'Cancel') : 'Resign';
      const b = btn({ label, icon: m.b_moved ? 'flag' : 'x', small: true, kind: 'quiet' });
      let armed = false;
      b.addEventListener('click', () => {
        if (!armed && m.b_moved) {
          armed = true;
          b.lastChild.textContent = 'Sure? Click again';
          setTimeout(() => {
            armed = false;
          }, 3000);
          return;
        }
        leave();
      });
      tools.push(b);
    }
    tools.push(btn({ label: 'Close', small: true, kind: over && !finished ? 'primary' : '', onclick: ui.close }));
    ui.tools.replaceChildren(...tools);
  }

  let endBox = null;
  draw();
}

// ---------------------------------------------------------------- the end of a game with a friend

/** Starts the same game again with the same friend, in one click. */
function rematch(m, name, close, onChange) {
  close();
  challenge(m.game, { user_id: m.other.id, display_name: name }, onChange);
}

const POINTS = { won: 3, draw: 1, lost: 0 };

/**
 * Under the finished board: your record against this friend (this game, all time) with the last
 * results, and what the game did to your place in the friends' ranking for this game.
 */
function gameEnd(m, name) {
  const box = h('div', { class: 'game-end', 'aria-live': 'polite' }, h('div', { class: 'ghost', style: 'height:64px' }));
  Promise.all([api.headToHead(m.other.id, m.game).catch(() => null), api.gameLeaderboard(m.game, 'friends').catch(() => null)]).then(([record, board]) => {
    const parts = [];
    if (record && record.wins + record.draws + record.losses > 0) {
      // Symbols rather than letters: they read the same in every language.
      const mark = { won: '✓', draw: '=', lost: '✗' };
      parts.push(
        h(
          'div',
          { class: 'game-end-row' },
          icon('swords'),
          h(
            'div',
            {},
            h('strong', {}, h('span', {}, 'Against'), ' ', h('span', { translate: 'no' }, name)),
            h('span', { class: 'game-end-record' }, `${record.wins} won · ${record.draws} drawn · ${record.losses} lost`),
            h(
              'span',
              { class: 'game-end-last', 'aria-label': 'Last games' },
              record.last.map((g) => h('span', { class: `game-end-dot ${g.outcome}`, title: { won: 'Won', draw: 'Draw', lost: 'Lost' }[g.outcome] }, mark[g.outcome])),
            ),
          ),
        ),
      );
    }
    const me = board?.rows?.find((r) => r.me);
    if (me) {
      const gained = POINTS[m.outcome] ?? 0;
      parts.push(
        h(
          'div',
          { class: 'game-end-row' },
          icon('trophy'),
          h(
            'div',
            {},
            h('strong', {}, gained ? `+${gained} ranking points` : 'No points this time'),
            h('span', { class: 'game-end-record' }, `Friends’ ranking: #${me.rank} with ${me.points} points`),
          ),
        ),
      );
    }
    if (parts.length) box.replaceChildren(...parts);
    else box.remove();
  });
  return box;
}
