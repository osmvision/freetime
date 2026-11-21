// Games: the daily quiz, quiz duels with friends, and two-player games (Four in a row, Giant
// tic-tac-toe, Draughts, Dots and boxes, Torpedoes, Chess) against the computer or a friend. A duel is 5
// questions for both players; the server picks them and keeps the score. Online games are checked
// move by move on the server with the same rules as the app (js/play/rules.js).

import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, emptyState, errText, fill, h, icon, pageHead, toast } from './dom.js';
import { openQuiz, quizBanner, quizCard, setDuelDot } from './quiz.js';
import { renderGameRanking } from './game-ranking.js';
import { renderPuzzles } from './puzzles/screen.js';
import { GAME_INFO, challenge, playComputer, playOnline } from './play/screen.js';

const DAY = 86400000;

let duelTurns = 0;
let matchTurns = 0;

/** Refreshes the menu dot from your duels (quietly: signed out or offline means no dot). */
export async function refreshDuelDot() {
  try {
    const list = await api.myDuels();
    duelTurns = list.filter((d) => d.state === 'your_turn').length;
    return list;
  } catch {
    duelTurns = 0;
    return null;
  } finally {
    setDuelDot(duelTurns + matchTurns);
  }
}

/** The same for your games with friends. */
export async function refreshMatchDot() {
  try {
    const list = await api.myMatches();
    matchTurns = list.filter((m) => m.phase === 'your_turn'
      || (m.phase === 'waiting' && m.me === 1 && !m.b_moved)).length;
    return list;
  } catch {
    matchTurns = 0;
    return null;
  } finally {
    setDuelDot(duelTurns + matchTurns);
  }
}

export async function render(root, ctx, { invitation } = {}) {
  const quizBox = h('div', { class: 'games-quiz' });
  const puzzlesBox = h('section', { class: 'panel puzzles' });
  const duelsBox = h('section', { class: 'panel duels' });
  const matchesBox = h('section', { class: 'panel duels matches', hidden: true });
  const gamesBox = h('section', { class: 'panel play-games' });
  const rankingBox = h('section', { class: 'panel game-ranking' });
  fill(
    root,
    pageHead('Games', 'The quiz and the puzzles of the day, quiz duels, and games to play with a friend or the computer.',
      btn({ label: 'Game rankings', icon: 'trophy', small: true, onclick: () => rankingBox.querySelector('h2')?.focus() })),
    quizBox, puzzlesBox, matchesBox, gamesBox, duelsBox, rankingBox,
  );
  renderPuzzles(puzzlesBox);
  renderGameRanking(rankingBox, ctx);
  const reloadMatches = () => renderMatches(matchesBox, ctx);
  renderQuiz(quizBox, ctx);
  const matches = renderMatches(matchesBox, ctx);
  renderGames(gamesBox, ctx, reloadMatches);
  const duels = renderDuels(duelsBox, ctx);
  if (invitation) {
    await (invitation.kind === 'match' ? matches : duels);
    const row = document.getElementById(`${invitation.kind}-invite-${invitation.id}`);
    if (!root.hidden && row) row.focus();
  }
}

export function refreshGameList(root, ctx, kind) {
  if (kind === 'match') {
    const box = root.hidden ? null : root.querySelector('.matches');
    return box ? renderMatches(box, ctx) : refreshMatchDot();
  }
  const box = root.hidden ? null : root.querySelector('.duels:not(.matches)');
  return box ? renderDuels(box, ctx) : refreshDuelDot();
}

// ---------------------------------------------------------------- two-player games

function renderGames(box, ctx, reloadMatches) {
  const withFriend = async (id) => {
    const status = await api.accountStatus().catch(() => ({ signed_in: false }));
    if (!status.signed_in) {
      toast('Sign in to play with friends (Settings → Profile)', 'error', 5000);
      return;
    }
    pickFriend(ctx, GAME_INFO[id].name, (f) => challenge(id, f, reloadMatches));
  };
  fill(
    box,
    h('div', { class: 'duels-head' }, h('div', {}, h('h2', {}, 'Two-player games'), h('p', { class: 'hint' }, 'Play the computer right away, or a friend turn by turn: each plays when they like.'))),
    h(
      'ul',
      { class: 'game-tiles' },
      Object.entries(GAME_INFO).map(([id, g]) =>
        h(
          'li',
          { class: `game-tile game-tile-${id}` },
          h('span', { class: 'game-tile-icon' }, icon(g.icon)),
          h('strong', {}, g.name),
          h('p', { class: 'game-tile-rule' }, g.rule),
          h(
            'div',
            { class: 'game-tile-actions' },
            btn({ label: 'Computer', icon: 'monitor', small: true, onclick: () => playComputer(id) }),
            btn({ label: 'A friend', icon: 'users', small: true, kind: 'primary', onclick: () => withFriend(id) }),
          ),
        ),
      ),
    ),
  );
}

/** Your games with friends: your turn first. Hidden while there are none (or signed out). */
async function renderMatches(box, ctx) {
  const status = await api.accountStatus().catch(() => ({ signed_in: false }));
  if (!status.signed_in) {
    box.hidden = true;
    return;
  }
  const list = await refreshMatchDot();
  if (!list?.length) {
    box.hidden = true;
    return;
  }
  const reload = () => renderMatches(box, ctx);
  const groups = [
    ['Your turn', list.filter((m) => m.phase === 'your_turn')],
    ['Waiting for them', list.filter((m) => m.phase === 'waiting')],
    ['Finished', list.filter((m) => m.phase === 'over')],
  ].filter(([, items]) => items.length);
  box.hidden = false;
  fill(
    box,
    h('div', { class: 'duels-head' }, h('div', {}, h('h2', {}, 'Your games with friends'), h('p', { class: 'hint' }, 'With your friends, turn by turn. A game nobody plays for 7 days ends.'))),
    groups.map(([title, items]) => (title === 'Finished' ? finishedGroup(items, reload) : h('div', { class: 'duel-group' }, h('h3', { class: 'duel-group-title' }, title), h('ul', { class: 'duel-list' }, items.map((m) => matchRow(m, reload)))))),
  );
}

// Finished games: the latest few, the rest a click away; each one (or all of them) can be cleared.
const FINISHED_SHOWN = 5;
let finishedAll = false;

function finishedGroup(items, reload) {
  const shown = finishedAll ? items : items.slice(0, FINISHED_SHOWN);
  const clearAll = btn({ label: 'Clear history', icon: 'trash-2', kind: 'quiet', small: true });
  let armed = null;
  clearAll.addEventListener('click', async () => {
    if (!armed) {
      clearAll.classList.add('armed');
      clearAll.lastChild.textContent = 'Click again to clear the history';
      armed = setTimeout(reload, 4000);
      return;
    }
    clearTimeout(armed);
    clearAll.disabled = true;
    try {
      await api.hideFinishedMatches();
      toast('History cleared', 'ok');
    } catch (e) {
      toast(errText(e), 'error', 6000);
    }
    reload();
  });
  return h(
    'div',
    { class: 'duel-group' },
    h('div', { class: 'duel-group-head' }, h('h3', { class: 'duel-group-title' }, 'Finished'), clearAll),
    h('ul', { class: 'duel-list' }, shown.map((m) => matchRow(m, reload))),
    items.length > FINISHED_SHOWN
      ? btn({
          label: finishedAll ? 'Show fewer' : `Show ${items.length - FINISHED_SHOWN} more`,
          icon: finishedAll ? null : 'chevron-down',
          kind: 'quiet',
          small: true,
          onclick: () => {
            finishedAll = !finishedAll;
            reload();
          },
        })
      : null,
  );
}

async function clearMatch(m, reload) {
  try {
    await api.hideMatch(m.id);
  } catch (e) {
    toast(errText(e), 'error', 6000);
  }
  reload();
}

const OUTCOME = { won: ['You won', 'won'], lost: ['You lost', 'lost'], draw: ['Draw', 'draw'], declined: ['Declined', 'off'], cancelled: ['Cancelled', 'off'], expired: ['Expired', 'off'] };

function matchRow(m, reload) {
  const info = GAME_INFO[m.game];
  let side = null;
  let line;
  if (m.phase === 'your_turn') {
    line = h('span', {}, m.b_moved || m.me === 0 ? 'Your turn' : 'challenged you');
    side = h('span', { class: 'duel-when' }, endsIn({ created_at: m.updated_at }));
  } else if (m.phase === 'waiting') {
    line = h('span', {}, 'Their turn');
    side = h('span', { class: 'duel-when' }, endsIn({ created_at: m.updated_at }));
  } else {
    const [text, kind] = OUTCOME[m.outcome] ?? ['Finished', 'off'];
    line = h('span', {}, '');
    side = h('span', { class: `duel-verdict ${kind}` }, text);
  }
  return h(
    'li',
    { class: `duel match duel-${m.phase === 'over' ? 'done' : m.phase}`, id: `match-invite-${m.id}`, tabindex: -1 },
    avatar({ icon: m.other.avatar_icon, color: m.other.avatar_color, userId: m.other.id }),
    h(
      'div',
      { class: 'duel-main' },
      h('div', { class: 'duel-who' }, h('strong', { translate: 'no' }, m.other.display_name), ' ', line),
      h('div', { class: 'match-game' }, icon(info.icon), h('span', {}, info.name)),
    ),
    side,
    h(
      'div',
      { class: 'person-actions' },
      btn({ label: m.phase === 'your_turn' ? 'Play' : 'Open', icon: m.phase === 'your_turn' ? 'play' : 'eye', kind: m.phase === 'your_turn' ? 'primary' : '', small: true, onclick: () => playOnline(m, reload) }),
      m.phase === 'over' ? btn({ label: 'Remove this game from your list', icon: 'trash-2', kind: 'quiet', small: true, square: true, onclick: () => clearMatch(m, reload) }) : null,
    ),
  );
}

// ---------------------------------------------------------------- the daily quiz

async function renderQuiz(box, ctx) {
  let q;
  try {
    q = await api.quiz();
  } catch (e) {
    fill(box, h('p', { class: 'hint' }, errText(e)));
    return;
  }
  const again = () => renderQuiz(box, ctx);
  fill(box, q.result ? h('div', { class: 'today games-today' }, quizCard(q, () => openQuiz(q, again))) : quizBanner(q, () => openQuiz(q, again)));
}

// ---------------------------------------------------------------- duels

async function renderDuels(box, ctx) {
  const head = (...aside) => h('div', { class: 'duels-head' }, h('div', {}, h('h2', {}, 'Quiz duels'), h('p', { class: 'hint' }, 'Same 5 questions for both of you. Each plays when they like; the best score wins.')), ...aside);
  const status = await api.accountStatus().catch(() => ({ signed_in: false }));
  if (!status.signed_in) {
    fill(
      box,
      head(),
      h(
        'div',
        { class: 'strip' },
        icon('swords'),
        h('div', { class: 'strip-text' }, h('strong', {}, 'Sign in to challenge your friends'), h('span', {}, 'Optional: your profile lives in Settings.')),
        btn({ label: 'Go to profile', icon: 'log-in', small: true, onclick: () => ctx.goto('settings', { focus: 'profile' }) }),
      ),
    );
    return;
  }
  fill(box, head(), h('div', { class: 'ghost', style: 'height:160px' }));
  const list = await refreshDuelDot();
  if (!list) {
    fill(box, head(), emptyState({ icon: 'triangle-alert', title: 'Could not load your duels', text: 'Check your connection, then try again.', actions: [btn({ label: 'Try again', onclick: () => renderDuels(box, ctx) })] }));
    return;
  }
  const reload = () => renderDuels(box, ctx);
  const challenge = btn({ label: 'Challenge a friend', icon: 'swords', kind: 'primary', onclick: () => pickFriend(ctx, 'Quiz duel', (f) => startDuel(f.user_id, f.display_name, reload)) });
  const groups = [
    ['Your turn', list.filter((d) => d.state === 'your_turn')],
    ['Waiting for them', list.filter((d) => d.state === 'waiting')],
    ['Finished', list.filter((d) => !['your_turn', 'waiting'].includes(d.state))],
  ].filter(([, items]) => items.length);
  fill(
    box,
    head(challenge),
    groups.length
      ? groups.map(([title, items]) => h('div', { class: 'duel-group' }, h('h3', { class: 'duel-group-title' }, title), h('ul', { class: 'duel-list' }, items.map((d) => duelRow(d, ctx, reload)))))
      : h(
          'div',
          { class: 'duels-empty' },
          icon('swords'),
          h('strong', {}, 'No duels yet'),
          h('span', {}, 'Challenge a friend: you play now, they play when they like.'),
        ),
  );
}

/** "Ends in 3 days" for a duel still going (7 days after it started). */
function endsIn(d) {
  const left = Math.ceil((Date.parse(d.created_at) + 7 * DAY - Date.now()) / DAY);
  return left <= 1 ? 'Ends today' : `Ends in ${left} days`;
}

function verdict(d) {
  if (d.state === 'declined') return [d.challenger ? 'They said no' : 'You said no', 'off'];
  if (d.state === 'cancelled') return ['Cancelled', 'off'];
  if (d.state === 'expired') return ['Expired', 'off'];
  if (d.my_score > d.their_score) return ['You won', 'won'];
  if (d.my_score < d.their_score) return ['You lost', 'lost'];
  return ['Draw', 'draw'];
}

function duelRow(d, ctx, reload) {
  const who = h('strong', { translate: 'no' }, d.other.display_name);
  let line;
  let side = null;
  const actions = [];
  if (d.state === 'your_turn') {
    line = d.challenger
      ? h('span', {}, 'Your turn to play')
      : d.their_score == null
        ? h('span', {}, 'challenged you')
        : h('span', {}, h('span', {}, 'scored'), ' ', h('span', { class: 'figures' }, `${d.their_score}/5`), ' · ', h('span', {}, 'beat it!'));
    side = h('span', { class: 'duel-when' }, endsIn(d));
    actions.push(btn({ label: 'Play', icon: 'play', kind: 'primary', small: true, onclick: () => playDuel(d, reload) }));
    if (!d.challenger && d.their_score == null) actions.push(dropBtn(d, 'Decline', reload));
  } else if (d.state === 'waiting') {
    line = h('span', {}, h('span', {}, 'hasn’t played yet'), ' · ', h('span', {}, 'you scored'), ' ', h('span', { class: 'figures' }, `${d.my_score}/5`));
    side = h('span', { class: 'duel-when' }, endsIn(d));
    if (d.challenger) actions.push(dropBtn(d, 'Cancel', reload));
  } else {
    const [text, kind] = verdict(d);
    line =
      d.state === 'done'
        ? h('span', {}, '· ', h('span', {}, 'you'), ' ', h('span', { class: 'figures' }, `${d.my_score} – ${d.their_score}`))
        : h('span', {}, d.my_score != null ? `${d.my_score}/5` : '');
    side = h('span', { class: `duel-verdict ${kind}` }, text);
    actions.push(btn({ label: 'Rematch', icon: 'refresh-cw', small: true, onclick: () => startDuel(d.other.id, d.other.display_name, reload) }));
  }
  return h(
    'li',
    { class: `duel duel-${d.state}`, id: `duel-invite-${d.id}`, tabindex: -1 },
    avatar({ icon: d.other.avatar_icon, color: d.other.avatar_color, userId: d.other.id }),
    h('div', { class: 'duel-main' }, h('div', { class: 'duel-who' }, who, ' ', line)),
    side,
    h('div', { class: 'person-actions' }, actions),
  );
}

function dropBtn(d, label, reload) {
  return btn({
    label,
    kind: 'quiet',
    small: true,
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.dropDuel(d.id);
        reload();
      } catch (err) {
        toast(errText(err), 'error');
        e.currentTarget.disabled = false;
      }
    },
  });
}

/** Challenges a friend and, since you're here, lets you play your side right away. */
export async function startDuel(friendId, name, reload = () => {}) {
  let id;
  try {
    id = await api.createDuel(friendId);
  } catch (e) {
    toast(errText(e), 'error', 5000);
    return;
  }
  const list = await refreshDuelDot();
  const d = list?.find((x) => x.id === id);
  reload();
  if (d) playDuel(d, reload);
  else toast(`Duel sent to ${name}`, 'ok');
}

async function playDuel(d, reload) {
  let questions;
  try {
    questions = await api.duelQuestions(d.id, d.questions);
  } catch (e) {
    toast(errText(e), 'error', 6000);
    return;
  }
  openQuiz({ questions }, () => {}, { duel: { id: d.id, ids: d.questions, other: d.other.display_name, theirScore: d.their_score, onClose: reload } });
}

/** The list of friends to challenge; `onPick(friend)` once one is chosen. */
async function pickFriend(ctx, title, onPick) {
  let data;
  try {
    data = await api.socialOverview();
  } catch (e) {
    toast(errText(e), 'error');
    return;
  }
  const friends = data.friends.filter((f) => f.state === 'friend');
  const previousFocus = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const body = friends.length
    ? h(
        'ul',
        { class: 'duel-list pick-list' },
        friends.map((f) =>
          h(
            'li',
            { class: 'duel' },
            avatar({ icon: f.avatar_icon, color: f.avatar_color, userId: f.user_id }),
            h('div', { class: 'duel-main' }, h('strong', { translate: 'no' }, f.display_name)),
            h('div', { class: 'person-actions' }, btn({ label: 'Challenge', icon: 'swords', kind: 'primary', small: true, onclick: () => { close(); onPick(f); } })),
          ),
        ),
      )
    : emptyState({
        icon: 'users',
        title: 'No friends to challenge yet',
        text: 'Find people on freetime in Friends → Meet, or send your invite link.',
        actions: [btn({ label: 'Meet people', icon: 'user-plus', kind: 'primary', onclick: () => { close(); ctx.goto('friends', { tab: 'meet' }); } })],
      });
  const card = h(
    'section',
    { class: 'quiz pick-friend', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Challenge a friend' },
    h('div', { class: 'coupon-head' }, h('span', {}, h('span', {}, 'Challenge a friend'), ' · ', h('span', {}, title)), h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'quiz-body' }, body),
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  card.querySelector('button.btn, .quiz-close')?.focus();
}
