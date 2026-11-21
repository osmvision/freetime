// Ranked: this month's season, your tier, today's points, the friends board and the opt-in
// global board (top 1 first), and player cards. Points come from what you do (core/src/ranked.rs);
// the server caps a day at 20 and only shows people who are friends or opted in.

import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, emptyState, errText, fill, h, icon, toast } from './dom.js';
import { locale } from './i18n.js';

let scope = 'friends';

const TIER_ICON = { bronze: 'award', silver: 'award', gold: 'trophy', platinum: 'trophy', diamond: 'crown' };

/** Badge ids sent to the server -> icon and title (the same list as core/src/book.rs). */
const BADGES = {
  first: ['ticket', 'First ticket'],
  explorer: ['compass', 'Explorer'],
  collector: ['stamp', 'Collector'],
  'full-set': ['award', 'Full set'],
  outdoors: ['tree-pine', 'Fresh air'],
  athlete: ['activity', 'Athlete'],
  chef: ['utensils', 'Chef'],
  curious: ['graduation-cap', 'Curious mind'],
  maker: ['palette', 'Maker'],
  social: ['users', 'Good company'],
  gamer: ['gamepad-2', 'Player'],
  'night-owl': ['moon', 'Night owl'],
  daily: ['calendar-check', 'Daily habit'],
  regular: ['flame', 'Regular'],
  quiz: ['star', 'Quiz master'],
};

const seasonName = (season) => {
  const [y, m] = season.split('-').map(Number);
  const name = new Date(y, m - 1, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
  return name[0].toUpperCase() + name.slice(1);
};

function tierBadge(tier, size = '') {
  return h('span', { class: `tier tier-${tier.id}${size ? ` ${size}` : ''}` }, icon(TIER_ICON[tier.id] ?? 'award'), h('span', {}, tier.label));
}

/** Today's points as chips: "+4 quiz", "+3 ticket of the day"... */
function todayChips(t) {
  const parts = [
    [t.quiz, 'quiz'],
    [t.puzzles ?? 0, 'puzzles'],
    [t.daily, 'ticket of the day'],
    [t.new_ideas, 'new ideas'],
    [t.challenge, 'weekly challenge'],
    [t.badges, 'badges'],
  ].filter(([n]) => n > 0);
  return h(
    'div',
    { class: 'today-points' },
    h('span', { class: 'mini-k' }, 'Today'),
    parts.length ? parts.map(([n, label]) => h('span', { class: 'chip-points' }, h('b', { class: 'figures' }, `+${n}`), ` ${label}`)) : h('span', { class: 'mini-sub' }, 'Do the quiz or the ticket of the day to earn points'),
    h('span', { class: 'figures today-total' }, `${t.total}/20`),
    t.uncapped > t.total ? h('span', { class: 'mini-sub' }, 'Daily maximum reached') : null,
  );
}

function seasonCard(v) {
  const toNext = v.tier.next != null ? v.tier.next - v.points : null;
  return h(
    'section',
    { class: 'season' },
    h('div', { class: 'coupon-head' }, h('span', {}, `Season · ${seasonName(v.season)}`), h('span', { class: 'figures' }, v.days_left === 1 ? 'last day' : `${v.days_left} days left`)),
    h(
      'div',
      { class: 'season-body' },
      h('div', { class: `season-medal tier-${v.tier.id}` }, icon(TIER_ICON[v.tier.id] ?? 'award')),
      h(
        'div',
        { class: 'season-main' },
        tierBadge(v.tier),
        h('div', { class: 'season-points' }, h('span', { class: 'book-big' }, String(v.points)), h('span', { class: 'book-of' }, 'points this season')),
        v.tier.next != null
          ? [
              h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': String(v.tier.from), 'aria-valuemax': String(v.tier.next), 'aria-valuenow': String(v.points) }, h('div', { class: 'meter-fill', vars: { '--w': `${Math.round(((v.points - v.tier.from) / (v.tier.next - v.tier.from)) * 100)}%` } })),
              h('span', { class: 'mini-sub' }, `${toNext} points to the next tier`),
            ]
          : h('span', { class: 'mini-sub' }, 'Top tier: well done!'),
        v.show_in_global && v.global_rank ? h('span', { class: 'season-rank' }, icon('trophy'), `#${v.global_rank} of ${v.global_players} worldwide`) : null,
      ),
      todayChips(v.today),
    ),
  );
}

export function globalSwitch(v, reload, detail = 'Public profile: anyone can see your card and ranking, and add you from the Discover list in Friends.') {
  const box = h('input', { type: 'checkbox', checked: v.show_in_global });
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await api.setGlobalRanking(box.checked);
      toast(box.checked ? 'You’re on the global ranking' : 'You left the global ranking', 'ok');
      reload();
    } catch (e) {
      box.checked = !box.checked;
      toast(errText(e), 'error');
    } finally {
      box.disabled = false;
    }
  });
  return h(
    'div',
    { class: 'strip global-switch' },
    icon('trophy'),
    h(
      'div',
      { class: 'strip-text' },
      h('label', { class: 'check' }, box, h('strong', {}, 'Show me on the global ranking and in Meet')),
      h('span', {}, detail),
    ),
  );
}

function boardRow(r, ctx) {
  const medal = r.rank <= 3 ? h('span', { class: `place place-${r.rank}` }, r.rank === 1 ? icon('crown') : String(r.rank)) : h('span', { class: 'place' }, String(r.rank));
  return h(
    'li',
    {},
    h(
      'button',
      { type: 'button', class: `board-row${r.me ? ' me' : ''}`, onclick: () => openCard(r.user_id, ctx) },
      medal,
      avatar({ icon: r.avatar_icon, color: r.avatar_color, userId: r.user_id }, 'sm'),
      h('span', { class: 'board-name', translate: 'no' }, r.display_name),
      r.me ? h('span', { class: 'board-you' }, 'You') : null,
      h('span', { class: 'board-points figures' }, `${r.points} pts`),
    ),
  );
}

function topOne(r, ctx) {
  return h(
    'button',
    { type: 'button', class: 'top-one', onclick: () => openCard(r.user_id, ctx) },
    h('span', { class: 'top-crown' }, icon('crown')),
    avatar({ icon: r.avatar_icon, color: r.avatar_color, userId: r.user_id }, 'lg'),
    h('span', { class: 'mini-k' }, 'Top 1 this month'),
    h('strong', { translate: 'no' }, r.display_name),
    h('span', { class: 'figures' }, `${r.points} pts`),
  );
}

export async function renderRanked(box, ctx) {
  fill(box, h('div', { class: 'ghost', style: 'height:220px;margin-bottom:22px' }), h('div', { class: 'ghost', style: 'height:360px' }));
  let v;
  try {
    v = await api.rankedOverview(scope);
  } catch (e) {
    fill(box, emptyState({ icon: 'triangle-alert', title: 'Could not load the ranking', text: errText(e), actions: [btn({ label: 'Try again', onclick: () => renderRanked(box, ctx) })] }));
    return;
  }
  const reload = () => renderRanked(box, ctx);
  const tabs = h(
    'div',
    { class: 'seg', role: 'tablist', 'aria-label': 'Ranking' },
    [
      ['friends', 'Friends', 'users'],
      ['global', 'Worldwide', 'trophy'],
    ].map(([id, label, name]) =>
      h('button', { type: 'button', role: 'tab', class: 'seg-btn', 'aria-selected': String(scope === id), onclick: () => { if (scope !== id) { scope = id; reload(); } } }, icon(name), label),
    ),
  );
  const rows = v.rows;
  const list = rows.length
    ? h('ol', { class: 'board' }, rows.map((r) => boardRow(r, ctx)))
    : h('p', { class: 'hint' }, scope === 'global' ? 'Nobody on the global ranking this month yet. Be the first!' : 'Add friends to compare your points.');
  fill(
    box,
    seasonCard(v),
    globalSwitch(v, reload),
    h(
      'section',
      { class: 'panel board-panel' },
      h('div', { class: 'board-head' }, h('h2', {}, scope === 'global' ? 'Global ranking' : 'Friends ranking'), tabs),
      scope === 'global' && rows[0] ? topOne(rows[0], ctx) : null,
      list,
      h('p', { class: 'hint' }, 'Points: 1 per right quiz answer, 2 per puzzle of the day, 3 for the ticket of the day, 2 per new idea, 10 for the weekly challenge, 5 per badge. 20 a day at most. A new season starts each month.'),
    ),
  );
}

// ---------------------------------------------------------------- player card

/** Your streak together with a friend: weeks in a row with an accepted invite, one wildcard a month. */
function streakBlock(s, name) {
  const weeks = s?.weeks ?? 0;
  const lines = [];
  if (s?.best > weeks) lines.push(`Best: ${s.best} weeks`);
  lines.push(s?.wildcard_left ?? true ? 'Wildcard: available this month' : 'Wildcard: used this month');
  return h(
    'div',
    { class: 'card-streak' },
    h('span', { class: 'card-streak-flame' }, icon('flame')),
    h(
      'div',
      { class: 'card-streak-text' },
      h('span', { class: 'stat-label' }, 'Streak together'),
      h('strong', {}, weeks === 1 ? '1 week' : `${weeks} weeks`),
      lines.map((l) => h('span', { class: 'mini-sub' }, l)),
      weeks > 0 && !s.this_week
        ? h('span', { class: 'mini-sub' }, 'Do something together this week to keep it going: invite them from any pick.')
        : weeks === 0
          ? h('span', { class: 'mini-sub' }, 'Invite them to a pick and do it together: each week counts.')
          : null,
    ),
  );
}

const REASONS = [
  ['harassment', 'Harassment'],
  ['spam', 'Spam'],
  ['hate', 'Hate'],
  ['sexual', 'Sexual content'],
  ['impersonation', 'Pretending to be someone'],
  ['other', 'Something else'],
];

function reportForm(c, onDone) {
  let reason = null;
  const reasons = h('div', { class: 'reasons', role: 'group', 'aria-label': 'Reason' });
  const paint = () => reasons.replaceChildren(...REASONS.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(reason === id), onclick: () => { reason = id; paint(); } }, label)));
  paint();
  const details = h('input', { class: 'input', type: 'text', maxlength: 500, placeholder: 'What happened? (optional)', 'aria-label': 'Details' });
  return h(
    'div',
    { class: 'report-form' },
    h('strong', {}, 'Report this player to the freetime team'),
    reasons,
    details,
    btn({
      label: 'Send report',
      icon: 'flag',
      kind: 'primary',
      small: true,
      onclick: async () => {
        if (!reason) return toast('Pick a reason first');
        try {
          await api.reportUser(c.id, reason, details.value, []);
          toast('Report sent. Thank you: the freetime team will look at it.', 'ok', 6000);
          onDone();
        } catch (e) {
          toast(errText(e), 'error', 6000);
        }
      },
    }),
  );
}

export async function openCard(userId, ctx) {
  let data;
  try {
    data = await api.playerCard(userId);
  } catch (e) {
    toast(errText(e), 'error');
    return;
  }
  const c = data.card;
  const streak = c.friend ? (await api.togetherStreaks().catch(() => ({})))[c.id] ?? null : null;
  const previousFocus = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const extra = h('div');
  const badges = (c.badges ?? []).filter((id) => BADGES[id]);
  const actions = [];
  if (c.friend) {
    actions.push(btn({ label: 'Message', icon: 'message-circle', kind: 'primary', small: true, onclick: () => { close(); ctx.openChat(c.id); } }));
  } else if (!c.me && c.friend_tag) {
    actions.push(
      btn({
        label: 'Add friend',
        icon: 'user-plus',
        kind: 'primary',
        small: true,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await api.friendRequest(c.friend_tag);
            toast(r === 'accepted' ? 'You are now friends' : 'Request sent', 'ok');
          } catch (err) {
            toast(errText(err), 'error');
          }
        },
      }),
    );
  }
  if (!c.me) {
    actions.push(btn({ label: 'Report', icon: 'flag', kind: 'quiet', small: true, onclick: () => fill(extra, reportForm(c, close)) }));
    actions.push(
      btn({
        label: 'Block',
        icon: 'ban',
        kind: 'quiet',
        small: true,
        onclick: async () => {
          try {
            await api.blockUser(c.id);
            toast(`${c.display_name} blocked`, 'ok');
            close();
          } catch (e) {
            toast(errText(e), 'error');
          }
        },
      }),
    );
  }
  const card = h(
    'section',
    { class: 'quiz player-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': c.display_name },
    h('div', { class: 'coupon-head' }, h('span', {}, c.me ? 'Your card' : c.friend ? 'Friend' : 'Player'), h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h(
      'div',
      { class: 'quiz-body' },
      h(
        'div',
        { class: 'card-top' },
        avatar({ icon: c.avatar_icon, color: c.avatar_color, userId: c.id }, 'lg'),
        h(
          'div',
          { class: 'card-who' },
          h('h2', { class: 'quiz-question', translate: 'no' }, c.display_name),
          tierBadge(data.tier),
          c.status_text ? h('p', { class: 'card-status', translate: 'no' }, c.status_text) : null,
        ),
      ),
      c.bio ? h('p', { class: 'card-bio', translate: 'no' }, c.bio) : null,
      h(
        'div',
        { class: 'card-stats' },
        h('div', {}, h('span', { class: 'stat-label' }, 'This season'), h('span', { class: 'stat-value figures' }, `${c.points} pts`)),
        h('div', {}, h('span', { class: 'stat-label' }, 'Tickets stamped'), h('span', { class: 'stat-value figures' }, String(c.stamped))),
        h('div', {}, h('span', { class: 'stat-label' }, 'Best streak'), h('span', { class: 'stat-value figures' }, c.best_streak === 1 ? '1 week' : `${c.best_streak} weeks`)),
      ),
      c.friend ? streakBlock(streak, c.display_name) : null,
      badges.length
        ? h('ul', { class: 'card-badges' }, badges.map((id) => h('li', { title: BADGES[id][1] }, h('span', { class: 'badge-medal' }, icon(BADGES[id][0])), h('span', {}, BADGES[id][1]))))
        : h('p', { class: 'hint' }, 'No badges yet.'),
      actions.length ? h('div', { class: 'quiz-end-actions card-actions' }, actions) : null,
      extra,
    ),
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  card.querySelector('.quiz-close').focus();
}
