// The weekly recap: picks, time, streak and memories, from the history on this PC.
// A weekly rhythm on purpose: the streak counts weeks with at least one pick, not days.

import { api } from './api.js';
import { btn, categoryIcon, fill, fmtMinutes, h, icon } from './dom.js';

const DISMISSED = 'freetime.recap.dismissed';

/** The "This week" panel for the History tab. Renders nothing when there's no history yet. */
export async function recapPanel(box) {
  let r;
  try {
    r = await api.recap();
  } catch {
    return box.replaceChildren();
  }
  if (!r.week_picks && !r.last_week_picks && !r.streak_weeks && !r.memories.length) return box.replaceChildren();
  const figure = (label, value, sub) =>
    h('div', { class: 'recap-figure' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'recap-sub' }, sub) : null);
  fill(
    box,
    h(
      'section',
      { class: 'recap' },
      h('div', { class: 'coupon-head' }, h('span', {}, 'This week'), h('span', { class: 'figures' }, r.week)),
      h(
        'div',
        { class: 'recap-figures' },
        figure('Picks', String(r.week_picks), r.last_week_picks ? `last week: ${r.last_week_picks}` : null),
        figure('Time', r.week_minutes ? fmtMinutes(r.week_minutes) : '0', r.last_week_minutes ? `last week: ${fmtMinutes(r.last_week_minutes)}` : null),
        figure('Loved', String(r.week_loved), null),
        h(
          'div',
          { class: 'recap-figure streak' },
          h('div', { class: 'stat-label' }, 'Streak'),
          h('div', { class: 'stat-value' }, icon('flame'), r.streak_weeks === 1 ? '1 week' : `${r.streak_weeks} weeks`),
          h('div', { class: 'recap-sub' }, r.best_streak > r.streak_weeks ? `best: ${r.best_streak} weeks` : r.streak_weeks ? 'your best yet' : 'pick something to start one'),
        ),
      ),
      r.kinds.length
        ? h('div', { class: 'recap-kinds' }, r.kinds.map((k) => h('span', { class: 'recap-kind' }, icon(categoryIcon(k.category)), h('span', {}, k.label), h('span', { class: 'figures' }, `×${k.picks}`))))
        : null,
      r.memories.length
        ? h(
            'ul',
            { class: 'recap-memories' },
            r.memories.map((m) =>
              h('li', {}, icon('history'), h('span', { class: 'recap-when' }, capitalizeFirst(m.when)), h('span', { class: 'recap-what' }, m.title), m.loved ? h('span', { class: 'recap-loved' }, icon('heart'), 'loved') : null),
            ),
          )
        : null,
    ),
  );
}

const capitalizeFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The streak chip next to Discover's headline (2 weeks or more), or nothing. */
export async function streakChip() {
  try {
    const r = await api.recap();
    if (r.streak_weeks < 2) return null;
    return h('span', { class: 'streak-chip', title: `Best: ${r.best_streak} weeks` }, icon('flame'), `${r.streak_weeks}-week streak`);
  } catch {
    return null;
  }
}

/** Early in a new week, before the first pick: last week in one line, dismissable. */
export async function weekStrip(box) {
  let r;
  try {
    r = await api.recap();
  } catch {
    return box.replaceChildren();
  }
  let dismissed = null;
  try {
    dismissed = localStorage.getItem(DISMISSED);
  } catch {
    // No storage: the strip just shows until the first pick.
  }
  if (r.this_week_active || !r.last_week_picks || dismissed === r.week) return box.replaceChildren();
  fill(
    box,
    h(
      'div',
      { class: 'strip' },
      icon('flame'),
      h(
        'div',
        { class: 'strip-text' },
        h('strong', {}, `Last week: ${r.last_week_picks} ${r.last_week_picks === 1 ? 'pick' : 'picks'} · ${fmtMinutes(r.last_week_minutes)}`),
        h('span', {}, r.streak_weeks >= 2 ? `Pick something this week to keep your ${r.streak_weeks}-week streak.` : 'Pick something this week to start a streak.'),
      ),
      btn({
        label: 'Dismiss',
        kind: 'quiet',
        small: true,
        onclick: () => {
          try {
            localStorage.setItem(DISMISSED, r.week);
          } catch {
            // Not remembered: it comes back next launch.
          }
          box.replaceChildren();
        },
      }),
    ),
  );
}
