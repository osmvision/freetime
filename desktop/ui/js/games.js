// Games: the daily quiz, and quiz duels with friends (signed in). A duel is 5 questions for both
// players, each plays when they like; the server picks the questions and keeps the score
// (supabase/migrations/*_meet_and_quiz_duels.sql), so nobody can fake one.

import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, emptyState, errText, fill, h, icon, pageHead, toast } from './dom.js';
import { openQuiz, quizBanner, quizCard, setDuelDot } from './quiz.js';

const DAY = 86400000;

/** Refreshes the menu dot from your duels (quietly: signed out or offline means no dot). */
export async function refreshDuelDot() {
  try {
    const list = await api.myDuels();
    setDuelDot(list.filter((d) => d.state === 'your_turn').length);
    return list;
  } catch {
    setDuelDot(0);
    return null;
  }
}

export async function render(root, ctx) {
  const quizBox = h('div', { class: 'games-quiz' });
  const duelsBox = h('section', { class: 'panel duels' });
  fill(root, pageHead('Games', 'The quiz of the day, and quiz duels with your friends.'), quizBox, duelsBox, comingSoon());
  renderQuiz(quizBox, ctx);
  renderDuels(duelsBox, ctx);
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
  const challenge = btn({ label: 'Challenge a friend', icon: 'swords', kind: 'primary', onclick: () => pickFriend(ctx, reload) });
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
    { class: `duel duel-${d.state}` },
    avatar({ icon: d.other.avatar_icon, color: d.other.avatar_color }),
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

/** The list of friends to challenge. */
async function pickFriend(ctx, reload) {
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
            avatar({ icon: f.avatar_icon, color: f.avatar_color }),
            h('div', { class: 'duel-main' }, h('strong', { translate: 'no' }, f.display_name)),
            h('div', { class: 'person-actions' }, btn({ label: 'Challenge', icon: 'swords', kind: 'primary', small: true, onclick: () => { close(); startDuel(f.user_id, f.display_name, reload); } })),
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
    h('div', { class: 'coupon-head' }, h('span', {}, 'Challenge a friend'), h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'quiz-body' }, body),
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  card.querySelector('button.btn, .quiz-close')?.focus();
}

// ---------------------------------------------------------------- what comes next

function comingSoon() {
  const games = [
    ['Four in a row', 'grid-2x2'],
    ['Giant tic-tac-toe', 'hash'],
    ['Draughts', 'circle-dot'],
    ['Dots and boxes', 'square-dashed'],
    ['Torpedoes', 'anchor'],
  ];
  return h(
    'section',
    { class: 'soon' },
    h('h2', {}, 'Coming soon'),
    h('p', { class: 'hint' }, 'More games to play with friends, turn by turn, made by freetime.'),
    h('ul', { class: 'soon-list' }, games.map(([name, ic]) => h('li', {}, icon(ic), h('span', {}, name)))),
  );
}
