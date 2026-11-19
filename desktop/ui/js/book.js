// The ticket book: every idea you do gets stamped. Badges, the weekly challenge and the ticket of
// the day live here too. All of it is computed from the history on this PC (desktop/src/book.rs).

import { api } from './api.js';
import { btn, categoryIcon, emptyState, errText, fill, h, icon } from './dom.js';
import { locale } from './i18n.js';
import { photo } from './photos.js';
import { openQuiz, quizCard } from './quiz.js';

const shortDate = (ts) => new Date(ts * 1000).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });

function meter(value, max, label) {
  const pct = max ? Math.round((Math.min(value, max) / max) * 100) : 0;
  return h(
    'div',
    { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value), 'aria-label': label },
    h('div', { class: 'meter-fill', vars: { '--w': `${pct}%` } }),
  );
}

const daysLeft = (n) => (n <= 1 ? 'last day' : `${n} days left`);

/** The weekly challenge as a small ticket. */
function challengeCard(c) {
  return h(
    'div',
    { class: `mini-ticket challenge${c.done ? ' done' : ''}` },
    h('span', { class: 'mini-icon' }, icon(c.done ? 'award' : 'target')),
    h(
      'div',
      { class: 'mini-text' },
      h('span', { class: 'mini-k' }, 'This week’s challenge'),
      h('strong', {}, c.title),
      meter(c.progress, c.target, c.title),
      h('span', { class: 'mini-sub' }, c.done ? 'Done! A new one comes on Monday.' : `${c.progress}/${c.target} · ${daysLeft(c.days_left)}`),
    ),
  );
}

/** The ticket of the day: the same idea for everyone today. */
function dailyCard(c, done, onStart) {
  if (!c) return null;
  const startBtn = done
    ? h('span', { class: 'mini-done' }, icon('stamp'), 'Stamped')
    : btn({
        label: 'Start',
        icon: 'play',
        kind: 'primary',
        square: true,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          await onStart(c);
        },
      });
  return h(
    'div',
    { class: `mini-ticket daily${done ? ' done' : ''}` },
    h('div', { class: 'mini-photo' }, photo(c)),
    h(
      'div',
      { class: 'mini-text' },
      h('span', { class: 'mini-k' }, 'Ticket of the day'),
      h('strong', {}, c.title),
      h('span', { class: 'mini-sub figures' }, c.duration),
    ),
    startBtn,
  );
}

/** Discover's strip: ticket of the day, weekly challenge, and a door to the book. */
export async function todayStrip(box, { onStart, openBook }) {
  let t;
  let q = null;
  try {
    [t, q] = await Promise.all([api.today(), api.quiz().catch(() => null)]);
  } catch {
    return box.replaceChildren();
  }
  const again = () => todayStrip(box, { onStart, openBook });
  box.replaceChildren(
    h(
      'div',
      { class: 'today' },
      dailyCard(t.daily, t.daily_done, async (c) => {
        await onStart(c);
        todayStrip(box, { onStart, openBook });
      }),
      challengeCard(t.challenge),
      quizCard(q, () => openQuiz(q, again)),
      h(
        'button',
        { type: 'button', class: 'today-book', onclick: openBook, title: 'Open your ticket book' },
        icon('book-open'),
        h('span', { class: 'mini-k' }, 'Ticket book'),
        h('span', { class: 'figures' }, `${t.stamped}/${t.total}`),
      ),
    ),
  );
}

// ---------------------------------------------------------------- the book page

function badgeCard(b) {
  return h(
    'li',
    { class: `badge${b.earned ? ' earned' : ''}`, title: b.how },
    h('span', { class: 'badge-medal' }, icon(b.icon)),
    h('strong', {}, b.title),
    h('span', { class: 'badge-how' }, b.how),
    b.earned ? null : h('span', { class: 'badge-progress figures' }, `${b.progress}/${b.target}`),
  );
}

function ticketCard(t, shelf) {
  const stamped = t.first != null;
  const item = { id: t.id, title: t.title, category: shelf.category, category_label: shelf.label };
  return h(
    'li',
    { class: `book-ticket${stamped ? ' stamped' : ''}`, title: stamped ? t.title : `${t.title}: still to collect` },
    h('div', { class: 'book-photo' }, photo(item)),
    h('span', { class: 'book-title' }, t.title),
    stamped
      ? h(
          'span',
          { class: 'book-stamp', 'aria-label': `Stamped ${shortDate(t.first)}` },
          h('span', { class: 'book-stamp-word' }, 'Stamped'),
          h('span', { class: 'figures' }, t.times > 1 ? `${shortDate(t.first)} · ×${t.times}` : shortDate(t.first)),
        )
      : null,
  );
}

function shelfSection(s) {
  const full = s.stamped === s.total;
  return h(
    'section',
    { class: `shelf${full ? ' full' : ''}` },
    h(
      'div',
      { class: 'shelf-head' },
      icon(categoryIcon(s.category)),
      h('h3', {}, s.label),
      h('span', { class: 'figures' }, `${s.stamped}/${s.total}`),
      full ? h('span', { class: 'shelf-full' }, icon('award'), 'Full set') : null,
    ),
    h('ul', { class: 'book-grid' }, s.tickets.map((t) => ticketCard(t, s))),
  );
}

export async function renderBook(box, ctx) {
  box.replaceChildren(h('div', { class: 'ghost', style: 'height:140px;margin-bottom:24px' }), h('div', { class: 'ghost', style: 'height:420px' }));
  let b;
  let q = null;
  try {
    [b, q] = await Promise.all([api.book(), api.quiz().catch(() => null)]);
  } catch (e) {
    box.replaceChildren(emptyState({ icon: 'triangle-alert', title: 'Could not open your ticket book', text: errText(e) }));
    return;
  }
  const earned = b.badges.filter((x) => x.earned).length;
  fill(
    box,
    h(
      'section',
      { class: 'book-cover' },
      h('div', { class: 'coupon-head' }, h('span', {}, 'Your ticket book'), h('span', { class: 'figures' }, `${b.stamped}/${b.total}`)),
      h(
        'div',
        { class: 'book-cover-body' },
        h(
          'div',
          { class: 'book-count' },
          h('span', { class: 'book-big' }, String(b.stamped)),
          h('span', { class: 'book-of' }, `of ${b.total} ideas stamped`),
          meter(b.stamped, b.total, 'Ideas stamped'),
          h('span', { class: 'mini-sub' }, b.games || b.videos || b.quizzes ? `Plus ${b.games} games, ${b.videos} videos and ${b.quizzes} quizzes` : 'Every idea you do gets stamped here.'),
        ),
        h('div', { class: 'book-side' }, dailyCard(b.daily, b.daily_done, async (c) => {
          await ctx.startIdea(c);
          renderBook(box, ctx);
        }), challengeCard(b.challenge), quizCard(q, () => openQuiz(q, () => renderBook(box, ctx)))),
      ),
    ),
    h(
      'section',
      { class: 'panel badges-panel' },
      h('div', { class: 'shelf-head' }, icon('award'), h('h3', {}, 'Badges'), h('span', { class: 'figures' }, `${earned}/${b.badges.length}`)),
      h('ul', { class: 'badges' }, b.badges.map(badgeCard)),
    ),
    b.shelves.map(shelfSection),
  );
}
