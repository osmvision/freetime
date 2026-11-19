// What you picked, how it went, and what freetime learned about your taste.

import { api } from './api.js';
import { btn, categoryIcon, emptyState, errText, h, icon, pageHead, toast } from './dom.js';
import { photo } from './photos.js';
import { recapPanel } from './recap.js';
import { renderBook } from './book.js';

let tab = 'trips';

/** "Your trips" or "Ticket book". */
function tabs(root, ctx) {
  const choices = [
    ['trips', 'Your trips', 'history'],
    ['book', 'Ticket book', 'book-open'],
  ];
  return h(
    'div',
    { class: 'seg', role: 'tablist', 'aria-label': 'History' },
    choices.map(([id, label, name]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'seg-btn',
          'aria-selected': String(tab === id),
          onclick: () => {
            if (tab === id) return;
            tab = id;
            render(root, ctx);
          },
        },
        icon(name),
        label,
      ),
    ),
  );
}

const headFor = (root, ctx) =>
  tab === 'book'
    ? pageHead('Ticket book', 'Every idea you do gets stamped. Collect them all, earn badges, take on the weekly challenge.', tabs(root, ctx))
    : pageHead('Your trips', 'What you picked and how it went. Your ratings teach freetime what you like.', tabs(root, ctx));

export async function render(root, ctx, { quiet = false, tab: wanted } = {}) {
  if (wanted) tab = wanted;
  const head = () => headFor(root, ctx);
  if (tab === 'book') {
    const box = h('div');
    root.replaceChildren(head(), box);
    return renderBook(box, ctx);
  }
  if (!quiet) root.replaceChildren(head(), h('div', { class: 'ghost', style: 'height:96px;margin-bottom:26px' }), h('div', { class: 'ghost', style: 'height:360px' }));
  let data;
  try {
    data = await api.history();
  } catch (e) {
    root.replaceChildren(head(), emptyState({ icon: 'triangle-alert', title: 'Could not load your history', text: errText(e) }));
    return;
  }
  if (!data.entries.length) {
    root.replaceChildren(
      head(),
      emptyState({
        icon: 'ticket',
        title: 'No tickets used yet',
        text: 'Press Start on Discover and the pick lands here, ready for a rating.',
        actions: [btn({ label: 'Find something to do', icon: 'compass', kind: 'primary', onclick: () => ctx.goto('discover') })],
      }),
    );
    return;
  }
  const favorite = [...data.taste].sort((a, b) => b.affinity - a.affinity)[0];
  const recapBox = h('div', { class: 'recap-box' });
  recapPanel(recapBox);
  root.replaceChildren(
    head(),
    recapBox,
    h(
      'div',
      { class: 'stats' },
      stat('Picks', String(data.stats.picks)),
      stat('Loved', String(data.stats.liked)),
      stat('Not for me', String(data.stats.disliked)),
      stat('Favorite', favorite && favorite.affinity > 0 ? favorite.label : 'None yet'),
    ),
    h('div', { class: 'history-grid' }, tastePanel(data.taste), timeline(data.entries, root, ctx)),
  );
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value', title: value }, value));
}

function tastePanel(taste) {
  const rows = [...taste]
    .sort((a, b) => b.affinity - a.affinity)
    .map((t) => {
      const width = Math.min(Math.abs(t.affinity), 1) * 50;
      const value = t.affinity === 0 ? '0' : `${t.affinity > 0 ? '+' : ''}${t.affinity.toFixed(2)}`;
      return h(
        'div',
        { class: 'taste-row' },
        icon(categoryIcon(t.category)),
        h('span', {}, t.label),
        h('div', { class: 'bar', 'aria-hidden': 'true' }, h('div', { class: t.affinity >= 0 ? 'bar-fill pos' : 'bar-fill neg', vars: { '--w': `${width}%` } })),
        h('span', { class: 'taste-val' }, value),
      );
    });
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Your taste'),
    h('p', { class: 'hint' }, 'Learned from your ratings. Kinds you like rank higher.'),
    rows,
  );
}

function timeline(entries, root, ctx) {
  const box = h('section', { class: 'panel', 'aria-label': 'Your picks' });
  let day = null;
  for (const e of entries) {
    if (e.day !== day) {
      day = e.day;
      box.append(h('h3', { class: 'day' }, day));
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
  const toggle = (rating, name, label) =>
    h(
      'button',
      { type: 'button', class: 'toggle', 'aria-pressed': String(e.rating === rating), title: label, 'aria-label': `${label}: ${e.title}`, onclick: () => rate(rating) },
      icon(name),
    );
  return h(
    'div',
    { class: 'entry' },
    h('div', { class: 'entry-thumb' }, photo(e, 'fallback-icon')),
    h(
      'div',
      { class: 'entry-main' },
      h('div', { class: 'entry-title', title: e.title }, e.title),
      h('div', { class: 'entry-sub' }, `${e.category_label} · ${e.time}`),
    ),
    h('div', { class: 'toggles' }, toggle(1, 'thumbs-up', 'Loved it'), toggle(-1, 'thumbs-down', 'Not for me')),
  );
}
