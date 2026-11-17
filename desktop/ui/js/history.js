// What you picked, how it went, and what freetime learned about your taste.

import { api } from './api.js';
import { catVars, emptyState, errText, h, pageHead, toast } from './dom.js';

const head = () =>
  pageHead('History', 'What you picked and how it went. Your ratings teach freetime what you like.');

export async function render(root, ctx, { quiet = false } = {}) {
  if (!quiet) root.replaceChildren(head(), h('div', { class: 'skeleton block' }));
  let data;
  try {
    data = await api.history();
  } catch (e) {
    root.replaceChildren(head(), emptyState({ emoji: '😵', title: "Couldn't load your history", text: errText(e) }));
    return;
  }
  if (!data.entries.length) {
    root.replaceChildren(
      head(),
      emptyState({
        emoji: '📜',
        title: 'No picks yet',
        text: 'Choose something on Discover and it will show up here.',
        action: h('button', { class: 'btn primary', onclick: () => ctx.goto('discover') }, '✨ Find something to do'),
      }),
    );
    return;
  }
  const favorite = [...data.taste].sort((a, b) => b.affinity - a.affinity)[0];
  root.replaceChildren(
    head(),
    h(
      'div',
      { class: 'stats' },
      stat(String(data.stats.picks), 'Picks'),
      stat(`👍 ${data.stats.liked}`, 'Loved'),
      stat(`👎 ${data.stats.disliked}`, 'Not for me'),
      stat(favorite && favorite.affinity > 0 ? `${favorite.icon} ${favorite.label}` : '—', 'Favorite'),
    ),
    h('div', { class: 'history-grid' }, tasteCard(data.taste), timeline(data.entries, root, ctx)),
  );
}

function stat(value, label) {
  return h('div', { class: 'card stat' }, h('div', { class: 'stat-num' }, value), h('div', { class: 'stat-label' }, label));
}

function tasteCard(taste) {
  const rows = [...taste]
    .sort((a, b) => b.affinity - a.affinity)
    .map((t) => {
      const width = Math.min(Math.abs(t.affinity), 1) * 50;
      const value = t.affinity === 0 ? '·' : `${t.affinity > 0 ? '+' : ''}${t.affinity.toFixed(2)}`;
      return h(
        'div',
        { class: 'taste-row', vars: catVars(t.category) },
        h('span', {}, t.icon),
        h('span', { class: 'taste-label' }, t.label),
        h('div', { class: 'bar' }, h('div', { class: t.affinity >= 0 ? 'fill pos' : 'fill neg', vars: { '--w': `${width}%` } })),
        h('span', { class: 'taste-val' }, value),
      );
    });
  return h(
    'div',
    { class: 'card taste' },
    h('h3', {}, 'Your taste'),
    h('p', { class: 'muted' }, 'Learned from your 👍 and 👎. Categories you like rank higher.'),
    rows,
  );
}

function timeline(entries, root, ctx) {
  const box = h('div', { class: 'card timeline' });
  let day = null;
  for (const e of entries) {
    if (e.day !== day) {
      day = e.day;
      box.append(h('div', { class: 'day' }, day));
    }
    box.append(entryRow(e, root, ctx));
  }
  return box;
}

function entryRow(e, root, ctx) {
  const rate = async (rating) => {
    try {
      await api.rate(e.id, e.ts, e.rating === rating ? 0 : rating);
      const main = document.getElementById('main');
      const y = main.scrollTop;
      await render(root, ctx, { quiet: true });
      main.scrollTop = y;
    } catch (err) {
      toast(errText(err), 'error');
    }
  };
  return h(
    'div',
    { class: 'entry', vars: catVars(e.category) },
    h('span', { class: 'entry-emo' }, e.icon),
    h(
      'div',
      { class: 'entry-main' },
      h('div', { class: 'entry-title', title: e.title }, e.title),
      h('div', { class: 'entry-sub' }, `${e.category_label} · ${e.time}`),
    ),
    h(
      'div',
      { class: 'rate-toggle' },
      h('button', { 'aria-pressed': String(e.rating === 1), title: 'Loved it', 'aria-label': 'Loved it', onclick: () => rate(1) }, '👍'),
      h('button', { 'aria-pressed': String(e.rating === -1), title: 'Not for me', 'aria-label': 'Not for me', onclick: () => rate(-1) }, '👎'),
    ),
  );
}
