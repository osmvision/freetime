// The main screen: today's ticket (the best pick), why it fits, and the rest of the book behind it.

import { api } from './api.js';
import { locale, t } from './i18n.js';
import { cityPicker, openMeteoCredit } from './city.js';
import {
  btn,
  capitalize,
  categoryIcon,
  emptyState,
  errText,
  fill,
  fmtMinutes,
  h,
  icon,
  linkLabel,
  reducedMotion,
  sourceLabel,
  toast,
  wait,
} from './dom.js';
import { creditLine, photo, photoFor } from './photos.js';
import { freeStrip, invitable, invitePanel } from './together.js';
import { streakChip, weekStrip } from './recap.js';
import { todayStrip } from './book.js';
import { offerShare } from './feed.js';
import { shareTicket } from './share.js';
import { renderPlayNow } from './play-now.js';
import { comingUp, eveningIdeas, planEvening } from './evenings.js';
import { BUILT_IN, MAX_SHORTCUTS, MOOD_KEY, myShortcuts, saveShortcuts } from './shortcuts.js';

const TIMES = [15, 30, 45, 60, 90, 120, 180, 240];
const ENERGY = [
  { id: 'low', label: 'Low', icon: 'battery-low' },
  { id: 'medium', label: 'Steady', icon: 'battery-medium' },
  { id: 'high', label: 'Pumped', icon: 'battery-full' },
];
const COMPANY = [
  { id: false, label: 'Just me', icon: 'user' },
  { id: true, label: 'With friends', icon: 'users' },
];
const OUTSIDE = [
  { id: true, label: 'Can go out', icon: 'tree-pine' },
  { id: false, label: 'Staying in', icon: 'house' },
];
const BUDGET = [
  { id: 'free', label: 'Free', icon: 'wallet' },
  { id: 'cheap', label: 'Cheap', icon: 'wallet' },
  { id: 'paid', label: 'Any price', icon: 'wallet' },
];
const FARE = { free: 'Free', cheap: 'Cheap', paid: 'Paid' };
const BOOK_SIZE = 12;
/** "Not this one", and why: each reason tunes the next picks differently (see core/src/history.rs). */
const NOT_NOW = [
  { id: 'too_long', label: 'Too long', done: 'Noted: fewer ideas that long for the time you have' },
  { id: 'already_done', label: 'Already done', done: 'Noted: it won’t come back for two weeks' },
  { id: 'another_time', label: 'Another time', done: 'Noted: it will come back in a few days' },
];

let ctx;
const els = {};
const state = {
  req: null,
  categories: [],
  online: null,
  setup: null,
  pending: [],
  now: null, // the idea in progress, see loadNow
  hidden: new Set(), // voided during this session
  shuffled: new Set(), // already shown, skipped by "Other picks"
  lead: null, // { c, el }: the ticket on top, for the S / N shortcuts and "Other picks"
  shownLead: null, // { c, el }: the ticket on top as shown, even once started (the automatic refresh keeps it)
  shown: [],
  results: null,
  loading: false,
  stale: false, // settings changed: refresh picks once the new data is in
  timer: null,
  friends: [], // saved friends (from friend codes)
  party: [], // names of the friends you're with right now
};

export function init(root, boot, context) {
  ctx = context;
  state.categories = boot.categories;
  state.online = boot.online;
  state.setup = boot.setup;
  state.pending = boot.pending;
  state.now = loadNow();
  const mood = loadMood(boot.categories);
  state.party = mood.party ?? [];
  delete mood.party;
  state.req = { ...boot.defaults, ...mood };
  loadFriends();

  els.head = h('div');
  els.context = h('div', { class: 'context', role: 'toolbar', 'aria-label': 'Your free time' });
  els.shortcuts = h('div', { class: 'shortcuts', role: 'group', 'aria-label': 'Shortcuts' });
  // On a phone the context folds into one line ("1h · Steady · Just me…"), so the ticket shows
  // without scrolling; on wider screens the selects are always out (see .filters in styles.css).
  els.summary = h('span', { class: 'filters-values' });
  els.filtersToggle = h(
    'button',
    { type: 'button', class: 'filters-summary', 'aria-expanded': 'false', 'aria-controls': 'discover-filters', onclick: () => toggleFilters() },
    icon('sliders-horizontal'),
    els.summary,
    h('span', { class: 'filters-edit' }, 'Change'),
    icon('chevron-down', 'chev'),
  );
  els.filters = h(
    'div',
    { class: 'filters', 'data-open': 'false' },
    els.filtersToggle,
    h('div', { class: 'filters-body', id: 'discover-filters' }, els.context, els.shortcuts),
  );
  els.cityPrompt = h('div', { class: 'city-prompt' });
  els.rate = h('div');
  els.why = h('div');
  els.results = h('div', { 'aria-live': 'polite' }); // the ticket on top
  els.rest = h('div'); // the rest of the book
  els.free = h('div');
  els.playNow = h('div');
  els.evenings = h('div');
  els.week = h('div');
  els.today = h('div');
  els.root = root;
  // The best pick comes first: the context, then the ticket. What's around it (friends, the rest
  // of the book, the day's quiz and challenge) follows, so "Start" is on screen when the app opens.
  root.replaceChildren(
    els.head,
    els.filters,
    els.rate,
    els.why,
    els.results,
    els.cityPrompt,
    els.free,
    els.playNow,
    els.evenings,
    els.rest,
    els.today,
    els.week,
  );
  weekStrip(els.week);
  renderToday();
  // Who's free and "I'm free" (signed in only). Refreshed every minute while Discover is on screen.
  // When the friend list first arrives (or changes size), redraw so the ticket gets its Invite button.
  // Each refresh also updates "Shall we play now?" and the evenings coming up.
  state.together = freeStrip(
    els.free,
    () => state.req.minutes,
    () => {
      renderContext();
      if (state.results?.best && !state.loading) renderResults(state.results);
    },
    (friends) => {
      renderPlayNow(els.playNow, friends, state.req);
      comingUp(els.evenings, ctx);
    },
  );
  // Preferences brought from another device (Settings): take the new context and shortcuts.
  document.addEventListener('preferences-loaded', () => {
    const mood = loadMood(state.categories);
    state.party = mood.party ?? state.party;
    delete mood.party;
    state.req = { ...state.req, ...mood };
    renderContext();
    changed();
  });
  state.together.refresh();
  setInterval(() => {
    if (!document.hidden && !root.hidden) state.together.refresh();
  }, 60000);
  renderHead();
  renderContext();
  renderCityPrompt();
  renderRate();
  runSuggest();
}

export function onOnline(online) {
  const wasPartial = Boolean(state.results?.partial);
  state.online = online;
  if (!online.ready || online.loading || state.loading) return;
  if (state.stale) {
    state.stale = false;
    runSuggest({ keepShuffle: true, quiet: true, announce: 'Picks updated with your new settings' });
  } else if (wasPartial) {
    runSuggest({ keepShuffle: true, quiet: true, keepLead: true, announce: 'Picks refreshed with Steam, YouTube and the weather' });
  }
}

/** Friends were added or removed on the Friends screen. */
export async function friendsChanged() {
  await loadFriends();
  if (state.req.with_friends) runSuggest({ keepShuffle: true, quiet: true });
}

async function loadFriends() {
  try {
    state.friends = await api.friends();
  } catch {
    state.friends = [];
  }
  const known = new Set(state.friends.map((f) => f.name.toLowerCase()));
  // Online friends ("online:<id>") are checked against the online list when it arrives.
  state.party = state.party.filter((n) => n.startsWith('online:') || known.has(n.toLowerCase()));
  if (els.context) renderContext();
}

export async function settingsChanged() {
  state.stale = true;
  try {
    const boot = await api.bootstrap();
    state.setup = boot.setup;
    state.online = boot.online;
    renderCityPrompt();
  } catch {
    // The next sync event catches up.
  }
}

// ---------------------------------------------------------------- remembered context

function loadMood(categories) {
  try {
    const saved = JSON.parse(localStorage.getItem(MOOD_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return {};
    const known = new Set(categories.map((c) => c.id));
    const mood = {};
    if (Number.isFinite(saved.minutes) && saved.minutes >= 5 && saved.minutes <= 300) mood.minutes = saved.minutes;
    if (ENERGY.some((e) => e.id === saved.energy)) mood.energy = saved.energy;
    if (typeof saved.with_friends === 'boolean') mood.with_friends = saved.with_friends;
    if (typeof saved.can_go_out === 'boolean') mood.can_go_out = saved.can_go_out;
    if (BUDGET.some((b) => b.id === saved.budget)) mood.budget = saved.budget;
    const cats = Array.isArray(saved.categories) ? saved.categories.filter((c) => known.has(c)) : [];
    if (cats.length) mood.categories = cats;
    if (Array.isArray(saved.party)) mood.party = saved.party.filter((n) => typeof n === 'string').slice(0, 50);
    return mood;
  } catch {
    return {};
  }
}

function saveMood() {
  try {
    const { minutes, energy, with_friends, can_go_out, budget, categories } = state.req;
    localStorage.setItem(MOOD_KEY, JSON.stringify({ minutes, energy, with_friends, can_go_out, budget, categories, party: state.party }));
  } catch {
    // Storage unavailable: the context just won't be remembered.
  }
}

// ---------------------------------------------------------------- headline and context bar

function partOfDay() {
  const hour = new Date().getHours();
  if (hour < 5) return 'tonight';
  if (hour < 12) return 'this morning';
  if (hour < 18) return 'this afternoon';
  return 'tonight';
}

function renderHead() {
  const sub = state.results?.summary ?? 'Finding the best way to spend it.';
  fill(
    els.head,
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', { class: 'page-title' }, `Your ${fmtMinutes(state.req.minutes)} ${partOfDay()}`),
        h('p', { class: 'page-sub' }, sub),
      ),
      h(
        'div',
        { class: 'head-actions' },
        btn({ label: 'Other picks', icon: 'refresh-cw', small: true, onclick: shuffle, title: 'Show other ideas for the same context (O)' }),
        btn({ label: 'Surprise me', icon: 'shuffle', small: true, onclick: surprise, title: 'A random idea that still fits (R)' }),
      ),
    ),
  );
  // The weekly streak, next to the summary (from the local history, no network).
  streakChip().then((chip) => {
    const sub = els.head.querySelector('.page-sub');
    if (chip && sub && !sub.parentElement.querySelector('.streak-chip')) sub.after(chip);
  });
}

/** Any change to the context re-ranks after a short pause, so several quick edits cost one request. */
function changed() {
  saveMood();
  renderHead();
  renderShortcuts();
  renderSummary();
  clearTimeout(state.timer);
  state.timer = setTimeout(() => runSuggest(), 220);
}

function renderContext() {
  const r = state.req;
  const one = (name, iconName, options, key) =>
    select({
      name,
      icon: () => options.find((o) => o.id === r[key])?.icon ?? iconName,
      value: () => options.find((o) => o.id === r[key])?.label ?? '',
      options,
      isOn: (o) => o.id === r[key],
      pick: (o) => {
        r[key] = o.id;
        changed();
        // "With friends" shows the "Playing with" select (after this menu has closed).
        if (key === 'with_friends') setTimeout(renderContext);
        return true;
      },
    });

  const timeOptions = () => {
    const list = TIMES.includes(r.minutes) ? TIMES : [...TIMES, r.minutes].sort((a, b) => a - b);
    return list.map((m) => ({ id: m, label: fmtMinutes(m) }));
  };

  fill(
    els.context,
    select({
      name: 'Time',
      icon: () => 'clock',
      value: () => fmtMinutes(r.minutes),
      options: timeOptions,
      isOn: (o) => o.id === r.minutes,
      pick: (o) => {
        r.minutes = o.id;
        changed();
        return true;
      },
    }),
    one('Energy', 'zap', ENERGY, 'energy'),
    one('Who', 'user', COMPANY, 'with_friends'),
    r.with_friends ? partySelect() : null,
    one('Outside', 'tree-pine', OUTSIDE, 'can_go_out'),
    one('Budget', 'wallet', BUDGET, 'budget'),
    select({
      name: 'Mood',
      icon: () => 'heart',
      value: moodValue,
      title: 'In the mood for',
      multi: true,
      options: () => state.categories.map((c) => ({ id: c.id, label: c.label, icon: categoryIcon(c.id) })),
      isOn: (o) => r.categories.includes(o.id),
      pick: (o) => {
        const on = r.categories.includes(o.id);
        setCategories(on ? r.categories.filter((x) => x !== o.id) : [...r.categories, o.id]);
        return true;
      },
      // Select all / clear all; an empty pick only lasts while the menu is open.
      bulk: {
        all: () => setCategories(state.categories.map((c) => c.id)),
        none: () => setCategories([]),
        allOn: () => r.categories.length === state.categories.length,
        noneOn: () => r.categories.length === 0,
      },
      onClose: () => {
        if (r.categories.length) return;
        toast('No kind picked: showing everything');
        setCategories(state.categories.map((c) => c.id));
      },
    }),
  );
  renderShortcuts();
  renderSummary();
}

function moodValue() {
  const r = state.req;
  const n = r.categories.length;
  if (n === 0) return 'None';
  if (n === state.categories.length) return 'Anything';
  if (n === 1) return state.categories.find((c) => c.id === r.categories[0])?.label ?? '1 kind';
  return `${n} kinds`;
}

/** The folded context on a phone: each value in its own span, so the page layer translates it. */
function renderSummary() {
  if (!els.summary) return;
  const r = state.req;
  const label = (list, key) => list.find((o) => o.id === r[key])?.label ?? '';
  const values = [
    fmtMinutes(r.minutes),
    label(ENERGY, 'energy'),
    label(COMPANY, 'with_friends'),
    label(OUTSIDE, 'can_go_out'),
    label(BUDGET, 'budget'),
    moodValue(),
  ].filter(Boolean);
  fill(
    els.summary,
    values.flatMap((v, i) => [i ? h('span', { class: 'filters-dot', 'aria-hidden': 'true' }, '·') : null, h('span', {}, v)]),
  );
}

function toggleFilters(open = els.filters.dataset.open !== 'true') {
  els.filters.dataset.open = String(open);
  els.filtersToggle.setAttribute('aria-expanded', String(open));
}

// ---------------------------------------------------------------- shortcuts

/** Whether the context already is what this shortcut sets. */
function applies(set) {
  return Object.entries(set).every(([k, v]) =>
    Array.isArray(v) ? [...v].sort().join() === [...(state.req[k] ?? [])].sort().join() : state.req[k] === v,
  );
}

function renderShortcuts() {
  if (!els.shortcuts) return;
  const mine = myShortcuts();
  const chip = (s, own) =>
    h(
      'span',
      { class: own ? 'shortcut own' : 'shortcut' },
      h(
        'button',
        { type: 'button', class: 'shortcut-btn', 'aria-pressed': String(applies(s.set)), onclick: () => applyShortcut(s) },
        icon(s.icon ?? 'zap'),
        h('span', own ? { translate: 'no' } : {}, s.label),
      ),
      own
        ? h(
            'button',
            {
              type: 'button',
              class: 'shortcut-remove',
              'aria-label': `Remove the shortcut ${s.label}`,
              title: 'Remove',
              onclick: () => {
                saveShortcuts(myShortcuts().filter((x) => x.id !== s.id));
                renderShortcuts();
              },
            },
            icon('x'),
          )
        : null,
    );
  fill(
    els.shortcuts,
    BUILT_IN.map((s) => chip(s, false)),
    mine.map((s) => chip(s, true)),
    mine.length < MAX_SHORTCUTS
      ? h('button', { type: 'button', class: 'shortcut-btn shortcut-add', onclick: addShortcut }, icon('plus'), h('span', {}, 'Save this context'))
      : null,
  );
}

function applyShortcut(s) {
  const set = { ...s.set };
  if (set.categories) {
    set.categories = set.categories.filter((c) => state.categories.some((x) => x.id === c));
    if (!set.categories.length) delete set.categories;
  }
  Object.assign(state.req, set);
  renderContext();
  changed();
}

/** "Save this context": a name (prefilled), then it joins the shortcuts on this device. */
function addShortcut() {
  const r = state.req;
  // A field's value isn't translated by the page layer: translate the energy word here.
  const energy = t(ENERGY.find((e) => e.id === r.energy)?.label ?? '');
  const name = h('input', { class: 'input shortcut-name', type: 'text', maxlength: 40, value: `${fmtMinutes(r.minutes)} · ${energy}`, 'aria-label': 'Shortcut name' });
  const done = (keep) => {
    const label = name.value.trim();
    if (keep && label) {
      const { minutes, energy: e, with_friends, can_go_out, budget, categories } = state.req;
      const set = { minutes, energy: e, with_friends, can_go_out, budget, categories };
      if (saveShortcuts([...myShortcuts(), { id: `mine-${Date.now().toString(36)}`, label, set }])) toast('Shortcut saved', 'ok');
      else toast('This device can’t keep shortcuts', 'error');
    }
    renderShortcuts();
  };
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      done(true);
    } else if (e.key === 'Escape') done(false);
  });
  els.shortcuts.querySelector('.shortcut-add')?.replaceWith(
    h('span', { class: 'shortcut-form' }, name, btn({ label: 'Save', small: true, kind: 'primary', onclick: () => done(true) }), btn({ label: 'Cancel', small: true, kind: 'quiet', onclick: () => done(false) })),
  );
  name.focus();
  name.select();
}

/** Sets the kinds of ideas wanted. None picked (while the menu is open) asks for nothing yet. */
function setCategories(ids) {
  state.req.categories = state.categories.map((c) => c.id).filter((id) => ids.includes(id));
  if (state.req.categories.length) changed();
}

/** Online friends (keys "online:<id>") and friends added by code (keys are their names). */
const onlineFriends = () => state.together?.friends() ?? [];
const partyLabel = (key) =>
  key.startsWith('online:') ? (onlineFriends().find((f) => `online:${f.user_id}` === key)?.display_name ?? null) : key;

/** Who you're with: online friends and friends added by code; without any, a shortcut to add one. */
function partySelect() {
  if (!state.friends.length && !onlineFriends().length) {
    return btn({ label: 'Add a friend', icon: 'user-plus', kind: 'quiet', small: true, onclick: () => ctx.goto('friends') });
  }
  const isOn = (o) => state.party.some((n) => n.toLowerCase() === o.id.toLowerCase());
  return select({
    name: 'With',
    icon: () => 'users',
    title: 'Playing with',
    multi: true,
    value: () => {
      const names = state.party.map(partyLabel).filter(Boolean);
      if (!names.length) return 'Choose friends';
      if (names.length <= 2) return names.join(', ');
      return `${names.length} friends`;
    },
    options: () => [
      ...onlineFriends().map((f) => ({ id: `online:${f.user_id}`, label: f.free_until && new Date(f.free_until) > new Date() ? `${f.display_name} · free now` : f.display_name, icon: 'user' })),
      ...state.friends.map((f) => ({ id: f.name, label: f.common ? `${f.name} · ${f.common} games in common` : `${f.name} · code`, icon: 'ticket' })),
    ],
    isOn,
    pick: (o) => {
      state.party = isOn(o) ? state.party.filter((n) => n.toLowerCase() !== o.id.toLowerCase()) : [...state.party, o.id];
      changed();
      return true;
    },
  });
}

/** What `suggest` needs: names of code friends, and online friends as { id, name }. */
function partyForRequest() {
  if (!state.req.with_friends) return { party: [], mates: [] };
  const mates = state.party
    .filter((k) => k.startsWith('online:'))
    .map((k) => ({ id: k.slice(7), name: partyLabel(k) }))
    .filter((m) => m.name);
  return { party: state.party.filter((k) => !k.startsWith('online:')), mates };
}

let openMenu = null;

function closeMenu(focusButton = false) {
  if (!openMenu) return;
  const { menu, button, onClose } = openMenu;
  openMenu = null;
  menu.remove();
  button.setAttribute('aria-expanded', 'false');
  onClose?.();
  if (focusButton) button.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.wrap.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenu) closeMenu(true);
});

// Single-key shortcuts on Discover: S starts the lead ticket, N passes it ("Not this one"),
// O shows other picks, R draws a surprise. Never while typing, with a modifier, or under a dialog.
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.repeat || e.isComposing) return;
  if (!els.root || els.root.hidden || document.hidden || openMenu || state.loading) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
  if (document.querySelector('dialog[open], .quiz-backdrop, [aria-modal="true"]')) return;
  const lead = state.lead?.el?.isConnected ? state.lead : null;
  const action = {
    s: lead && (() => start(lead.c, lead.el)),
    n: lead && (() => voidCoupon(lead.c, lead.el)),
    o: () => shuffle(),
    r: () => surprise(),
  }[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();
  action();
});
// The menu is placed against the window, so it can't follow a scroll: close it instead.
document.addEventListener(
  'scroll',
  (e) => {
    if (!openMenu || openMenu.menu.contains(e.target)) return;
    const rect = openMenu.button.getBoundingClientRect();
    // A touch/browser focus can queue a scroll event before the menu opens.
    // Only a movement of the anchor invalidates the fixed placement.
    if (Math.abs(rect.top - openMenu.anchor.top) > 1 || Math.abs(rect.left - openMenu.anchor.left) > 1) closeMenu();
  },
  true,
);
window.addEventListener('resize', () => closeMenu());
window.visualViewport?.addEventListener('resize', () => closeMenu());

/** Puts the menu under its button, inside the window and above the bottom tab bar
    (the context row scrolls sideways on narrow windows and would clip it). */
function placeMenu(menu, button) {
  const gap = 6;
  const margin = 8;
  const r = button.getBoundingClientRect();
  const zoom = Number(document.documentElement.style.zoom) || 1;
  const viewport = window.visualViewport;
  const viewportRight = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth);
  const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
  const nav = document.querySelector('.nav');
  const floor = nav && getComputedStyle(nav).position === 'fixed' ? Math.min(nav.getBoundingClientRect().top, viewportBottom) : viewportBottom;
  const roof = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
  menu.style.position = 'fixed';
  menu.style.maxWidth = `${(viewportRight - margin * 2) / zoom}px`;
  menu.style.minWidth = `${Math.min(230, (viewportRight - margin * 2) / zoom)}px`;
  menu.style.left = `${Math.max(margin, Math.min(r.left, viewportRight - menu.getBoundingClientRect().width - margin)) / zoom}px`;
  const below = floor - r.bottom - gap - margin;
  const above = r.top - roof - gap - margin;
  if (below >= Math.min(menu.scrollHeight, 220) || below >= above) {
    menu.style.top = `${(r.bottom + gap) / zoom}px`;
    menu.style.maxHeight = `${Math.max(44, below / zoom)}px`;
  } else {
    menu.style.top = `${(roof + gap) / zoom}px`;
    menu.style.maxHeight = `${Math.max(44, above / zoom)}px`;
  }
}

/** A context select: a labelled button that opens a small menu of options. */
function select({ name, icon: iconOf, value, options, isOn, pick, multi = false, title, bulk, onClose }) {
  const valueEl = h('span', { class: 'select-value' });
  const iconSlot = h('span', { class: 'icon-slot' });
  const button = h(
    'button',
    { type: 'button', class: 'select-button', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    iconSlot,
    h('span', { class: 'select-name' }, name),
    valueEl,
    icon('chevron-down', 'chev'),
  );
  const wrap = h('div', { class: 'select' }, button);
  const paint = () => {
    valueEl.textContent = value();
    fill(iconSlot, icon(iconOf()));
    button.setAttribute('aria-label', `${title ?? name}: ${value()}`);
  };

  function open() {
    const list = typeof options === 'function' ? options() : options;
    const menu = h('div', { class: bulk ? 'menu has-bulk' : 'menu', role: 'group', 'aria-label': title ?? name });
    const draw = () =>
      fill(
        menu,
        title ? h('div', { class: 'menu-title' }, title) : null,
        bulk
          ? h(
              'div',
              { class: 'menu-bulk' },
              ['all', 'none'].map((which) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'menu-bulk-btn',
                    'data-bulk': which,
                    disabled: (which === 'all' ? bulk.allOn() : bulk.noneOn()) || null,
                    onclick: () => {
                      bulk[which]();
                      paint();
                      draw();
                      menu.querySelector(`[data-bulk="${which === 'all' ? 'none' : 'all'}"]`)?.focus({ preventScroll: true });
                    },
                  },
                  icon(which === 'all' ? 'check' : 'x'),
                  which === 'all' ? 'Select all' : 'Clear all',
                ),
              ),
            )
          : null,
        list.map((o) =>
          h(
            'button',
            {
              type: 'button',
              class: 'option',
              'aria-pressed': String(isOn(o)),
              onclick: () => {
                if (!pick(o)) return;
                paint();
                if (multi) {
                  draw();
                  menu.querySelectorAll('.option')[list.indexOf(o)]?.focus({ preventScroll: true });
                } else {
                  closeMenu(true);
                }
              },
            },
            h('span', { class: 'option-left' }, o.icon ? icon(o.icon) : null, o.label),
            isOn(o) ? icon('check') : null,
          ),
        ),
        multi ? btn({ label: 'Done', small: true, onclick: () => closeMenu(true) }) : null,
      );
    draw();
    wrap.append(menu);
    placeMenu(menu, button);
    button.setAttribute('aria-expanded', 'true');
    // After closing, the label shows what onClose may have changed.
    openMenu = { menu, button, wrap, anchor: button.getBoundingClientRect(), onClose: () => { onClose?.(); paint(); } };
    (menu.querySelector('.option[aria-pressed="true"]') ?? menu.querySelector('.option'))?.focus({ preventScroll: true });
  }

  button.addEventListener('click', () => {
    const mine = openMenu?.wrap === wrap;
    closeMenu();
    if (!mine) open();
  });
  paint();
  return wrap;
}

// ---------------------------------------------------------------- first launch: where are you?

/** Asked once: the city is used for the weather (and places nearby, on request); skipping is fine. */
function renderCityPrompt() {
  if (!els.cityPrompt) return;
  if (!state.setup?.needs_city) {
    els.cityPrompt.replaceChildren();
    return;
  }
  const answer = async (place) => {
    try {
      await api.setCity(place);
      state.setup.needs_city = false;
      if (place) {
        state.setup.city = place.name;
        state.stale = true;
        toast(`City set to ${place.name}: checking the weather`, 'ok');
      }
      renderCityPrompt();
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  fill(
    els.cityPrompt,
    h(
      'div',
      { class: 'strip' },
      icon('map-pin'),
      h(
        'div',
        { class: 'strip-text' },
        h('strong', {}, 'Where are you?'),
        h('span', {}, 'Only used for the weather, so outdoor ideas show up when it is nice out. '),
        openMeteoCredit(),
      ),
      cityPicker({ onPick: answer }),
      btn({ label: 'Skip', kind: 'quiet', small: true, onclick: () => answer(null) }),
    ),
  );
}

// ---------------------------------------------------------------- the idea in progress, "how was it?"

const NOW_KEY = 'freetime.now';
/** Past this, an idea is no longer "in progress": the usual "how was it?" asks about it later. */
const NOW_MAX_AGE_MS = 12 * 3600 * 1000;

/** The idea started last ({ id, ts, title, category, link, at, done }), kept across reloads. */
function loadNow() {
  try {
    const n = JSON.parse(localStorage.getItem(NOW_KEY) ?? 'null');
    return n && Number.isFinite(n.ts) && Date.now() - n.at < NOW_MAX_AGE_MS ? n : null;
  } catch {
    return null;
  }
}

function setNow(n, { focus = false } = {}) {
  state.now = n;
  try {
    if (n) localStorage.setItem(NOW_KEY, JSON.stringify(n));
    else localStorage.removeItem(NOW_KEY);
  } catch {
    // Private browsing: kept in memory only.
  }
  renderRate();
  if (focus) els.rate.querySelector('.strip-actions .btn')?.focus();
}

/**
 * The strip above the ticket. While an idea is in progress: "I'm done", then one tap to say how it
 * was. Otherwise "how was it?" for a pick made a while ago.
 */
function renderRate() {
  const n = state.now;
  if (n && !n.done) {
    const time = new Date(n.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    fill(
      els.rate,
      h(
        'div',
        { class: 'strip now-strip' },
        h('span', { class: 'now-dot', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'strip-text' },
          h('strong', {}, h('span', {}, 'In progress:'), ' ', h('span', { translate: 'no' }, n.title)),
          h('span', {}, `Started at ${time}. When you finish, one tap tells freetime how it was.`),
        ),
        h(
          'div',
          { class: 'strip-actions' },
          btn({ label: 'I’m done', icon: 'check', kind: 'primary', small: true, onclick: () => setNow({ ...n, done: true }, { focus: true }) }),
          n.link ? btn({ label: 'Open again', icon: 'external-link', small: true, onclick: () => openLink(n.link) }) : null,
          btn({ label: 'Close', icon: 'x', square: true, small: true, kind: 'quiet', onclick: () => setNow(null) }),
        ),
      ),
    );
    return;
  }
  const p = n ?? state.pending[0];
  if (!p) {
    els.rate.replaceChildren();
    return;
  }
  const answer = async (rating) => {
    try {
      state.pending = await api.rate(p.id, p.ts, rating);
      toast(rating > 0 ? 'Noted: more ideas like that' : rating < 0 ? 'Noted: fewer ideas like that' : 'Skipped', 'ok');
      if (p === n) setNow(null);
      else renderRate();
      if (rating > 0) offerShare({ kind: 'pick', idea_id: p.id, title: p.title, category: p.category ?? '', detail: '' });
    } catch (e) {
      toast(errText(e), 'error');
      if (p === n) setNow(null); // gone from the history (cleared elsewhere): don't stay stuck on it
    }
  };
  fill(
    els.rate,
    h(
      'div',
      { class: 'strip' },
      icon('ticket'),
      h(
        'div',
        { class: 'strip-text' },
        h('strong', {}, `How was ${p.title}?`),
        h('span', {}, p === n ? 'Your answer tunes the next picks.' : `You picked it ${p.ago}. Your answer tunes the next picks.`),
      ),
      h(
        'div',
        { class: 'strip-actions' },
        btn({ label: 'Loved it', icon: 'thumbs-up', small: true, onclick: () => answer(1) }),
        btn({ label: 'Not for me', icon: 'thumbs-down', small: true, onclick: () => answer(-1) }),
        btn({ label: 'Skip', kind: 'quiet', small: true, onclick: () => answer(0) }),
      ),
    ),
  );
}

// ---------------------------------------------------------------- suggestions

/**
 * Asks for picks and shows them. `keepLead` is for the automatic refresh, when the online sources
 * arrive: the user may be reading the ticket on top, so it stays put ("Other picks" is one tap
 * away), and a failed refresh leaves the page as it is.
 */
async function runSuggest({ keepShuffle = false, quiet = false, keepLead = false, announce = null } = {}) {
  if (state.loading) {
    state.again = true;
    return;
  }
  state.loading = true;
  if (!keepShuffle) state.shuffled.clear();
  if (!quiet || !state.results) renderLoading();
  let refreshAfter = false;
  try {
    const { party, mates } = partyForRequest();
    const res = await api.suggest(state.req, [...state.hidden, ...state.shuffled], party, mates);
    state.results = res;
    const kept = renderResults(res, { keepLead });
    renderHead();
    // A kept ticket means nothing moved under the user's eyes: no need to say so.
    if (announce && !kept) toast(announce, 'ok');
    // The online data may have arrived while this request was running.
    refreshAfter = res.partial && Boolean(state.online?.ready) && !state.online?.loading;
  } catch (e) {
    if (keepLead && state.shownLead?.el?.isConnected) {
      els.rest.querySelector('.partial-note')?.remove();
    } else {
      els.rest.replaceChildren();
      fill(
        els.results,
        emptyState({
          icon: 'triangle-alert',
          title: 'Something went wrong',
          text: errText(e),
          actions: [btn({ label: 'Try again', icon: 'refresh-cw', onclick: () => runSuggest() })],
        }),
      );
    }
  } finally {
    state.loading = false;
  }
  if (state.again) {
    state.again = false;
    runSuggest({ keepShuffle: true });
  } else if (refreshAfter) {
    runSuggest({ keepShuffle: true, quiet: true, keepLead: true, announce: 'Picks refreshed with Steam, YouTube and the weather' });
  }
}

function renderLoading() {
  fill(els.results, h('div', { class: 'ghost coupon-ghost', 'aria-label': 'Finding your best pick' }));
  fill(
    els.rest,
    h('div', { class: 'section-head' }, h('div', { class: 'ghost', style: 'width:260px;height:28px' })),
    h('div', { class: 'book' }, Array.from({ length: 4 }, () => h('div', { class: 'ghost leaf-ghost' }))),
  );
}

/** Shows the picks. Returns true when the ticket on screen was kept (`keepLead`, see runSuggest). */
function renderResults(res, { keepLead = false } = {}) {
  const before = state.lead;
  state.lead = null;
  if (!res.best) {
    const seenAll = state.shuffled.size > 0 || state.hidden.size > 0;
    state.shownLead = null;
    els.rest.replaceChildren();
    fill(
      els.results,
      emptyState({
        icon: seenAll ? 'check' : 'search',
        title: seenAll ? 'That is the whole book' : 'Nothing fits right now',
        text: seenAll
          ? 'You have seen every idea for this context.'
          : 'Try more time, a bigger budget, more kinds of ideas, or going outside.',
        actions: seenAll
          ? [
              btn({ label: 'Start over', icon: 'refresh-cw', onclick: () => { state.hidden.clear(); runSuggest(); } }),
              btn({ label: 'Add your own idea', icon: 'pencil', onclick: () => ctx.goto('settings', { focus: 'my-ideas' }) }),
            ]
          : [btn({ label: 'Add your own idea', icon: 'pencil', onclick: () => ctx.goto('settings', { focus: 'my-ideas' }) })],
      }),
    );
    return false;
  }
  let picks = [res.best, ...res.groups.flatMap((g) => g.items)];
  // The ticket on screen stays (started or not): only the book below changes, and a new best pick
  // opens the book. Not only when it is still in the new list: scores carry a little randomness, so
  // an idea that still fits can drop out of it from one call to the next.
  const shown = state.shownLead;
  const kept = keepLead && shown?.el?.isConnected ? shown : null;
  if (kept) {
    picks = [kept.c, ...picks.filter((c) => c.id !== kept.c.id)];
    state.lead = before?.el === kept.el ? before : null;
  } else {
    const lead = coupon(picks[0]);
    state.lead = state.shownLead = { c: picks[0], el: lead };
    fill(els.results, lead);
  }
  state.shown = picks.map((c) => c.id);
  const rest = picks.slice(1);
  fill(
    els.rest,
    // Below the ticket, so the ticket does not move when the note goes.
    res.partial
      ? h(
          'div',
          { class: 'note partial-note', style: 'margin:0 0 14px;border:0' },
          icon('loader-circle', 'spin'),
          h('span', {}, 'Steam, YouTube and the weather are still loading. More ideas will show up here by themselves.'),
        )
      : null,
    rest.length
      ? [
          h(
            'div',
            { class: 'section-head' },
            h('h2', { class: 'section-title' }, 'The rest of your book'),
            h('span', { class: 'section-note' }, `${Math.min(rest.length, BOOK_SIZE)} more that fit`),
          ),
          h('div', { class: 'book' }, rest.slice(0, BOOK_SIZE).map((c, i) => leaf(c, i))),
        ]
      : null,
    notesBlock(res.notes),
  );
  return Boolean(kept);
}

function shuffle() {
  // Only the lead ticket counts as passed over: the rest of the book was barely looked at.
  passed(state.lead?.c);
  state.shown.forEach((id) => state.shuffled.add(id));
  runSuggest({ keepShuffle: true });
}

/** A light, fading "not now" for this idea (it sinks a little for three weeks). */
function passed(c) {
  if (c?.id) api.passIdea(c.id).catch(() => {});
}

/** "Never suggest this": hidden for good, with an undo right away and in Settings later. */
async function never(c, onHidden) {
  try {
    await api.hideIdea(c.id);
  } catch (e) {
    toast(errText(e), 'error');
    return;
  }
  state.hidden.add(c.id);
  await onHidden();
  toast('You won’t see this idea again. Settings can bring it back.', 'ok', 7000, {
    label: 'Undo',
    onclick: async () => {
      try {
        await api.unhideIdea(c.id);
        state.hidden.delete(c.id);
        runSuggest({ keepShuffle: true, quiet: true });
      } catch (e) {
        toast(errText(e), 'error');
      }
    },
  });
}

// ---------------------------------------------------------------- the coupon

function ticketDate() {
  const d = new Date();
  const day = d.toLocaleDateString(locale(), { day: '2-digit', month: 'short' }).toUpperCase();
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** "10–20 min", "45 min–1h30", "1h–2h": short enough for a fare box. */
function span(c) {
  const min = c.min_minutes ?? 0;
  const max = Math.max(c.max_minutes ?? min, min);
  if (!min && !max) return c.duration;
  if (min === max) return fmtMinutes(min);
  if (max < 60) return `${min}–${max} min`;
  return `${fmtMinutes(min)}–${fmtMinutes(max)}`;
}

function weatherFare(c) {
  if (!c.outdoor) return 'Indoors';
  const w = state.online?.weather;
  return w ? `${Math.round(w.temp_c)}°C` : 'Outside';
}

function coupon(c, { label = 'Admit one' } = {}) {
  const p = photoFor(c);
  const link = c.link ? linkLabel(c) : null;
  const el = h(
    'article',
    { class: 'coupon', 'aria-label': `Best pick: ${c.title}` },
    h(
      'div',
      { class: 'coupon-main' },
      h(
        'div',
        { class: 'coupon-head' },
        h('span', {}, `${label} · ${c.category_label}`),
        h('span', { class: 'figures' }, ticketDate()),
      ),
      h(
        'div',
        { class: 'coupon-body' },
        h('h2', { class: 'coupon-title' }, c.title),
        c.detail ? h('p', { class: 'coupon-detail' }, c.detail) : null,
        h(
          'dl',
          { class: 'fare' },
          fareBox('Duration', span(c)),
          fareBox('Fare', FARE[c.cost] ?? c.cost),
          fareBox('Weather', weatherFare(c)),
          fareBox('Energy', capitalize(c.energy ?? '')),
        ),
        timebar(c),
        c.reasons?.length ? h('ul', { class: 'why' }, c.reasons.map((r) => h('li', {}, icon('check'), capitalize(r)))) : null,
        h(
          'div',
          { class: 'coupon-actions' },
          btn({ label: 'Start', icon: 'play', kind: 'primary', onclick: () => start(c, el), title: 'Start (S)' }),
          link ? btn({ label: link.text, icon: link.icon, onclick: () => openLink(c.link) }) : null,
          c.place
            ? btn({ label: 'Nearby', icon: 'map-pin', onclick: (e) => toggleNearby(c, e.currentTarget.closest('.coupon-actions')), title: 'Real places near your city (OpenStreetMap)' })
            : null,
          state.together?.friends().length && invitable(c)
            ? btn({
                label: 'Invite',
                icon: 'users',
                onclick: (e) => {
                  const actions = e.currentTarget.closest('.coupon-actions');
                  const open = actions.nextElementSibling?.classList.contains('invite-panel');
                  if (open) return actions.nextElementSibling.remove();
                  const panel = invitePanel(c, state.together.friends(), () => panel.remove());
                  // Or a whole evening: two times and up to three things to do, this one first.
                  panel.append(
                    btn({
                      label: 'Plan an evening: two times, up to three ideas',
                      icon: 'calendar',
                      kind: 'quiet',
                      small: true,
                      onclick: async () => {
                        panel.remove();
                        planEvening({
                          friends: state.together.friends(),
                          activities: [{ idea_id: c.id, title: c.title, category: c.category }],
                          ideas: await eveningIdeas(),
                          onDone: () => comingUp(els.evenings, ctx),
                        });
                      },
                    }),
                  );
                  actions.after(panel);
                },
              })
            : null,
          btn({ label: 'Share as an image', icon: 'send', square: true, onclick: () => shareTicket(c) }),
          btn({ label: 'Not this one', icon: 'x', kind: 'quiet', onclick: () => voidCoupon(c, el), title: 'Not now: it comes back less often (N)' }),
          btn({ label: 'Never suggest this', icon: 'ban', kind: 'quiet', square: true, onclick: () => never(c, () => tearCoupon(el)) }),
        ),
      ),
    ),
    h(
      'div',
      { class: 'coupon-stub' },
      h('div', { class: 'stub-photo' }, photo(c)),
      h(
        'div',
        { class: 'stub-foot' },
        h('span', { class: 'tag-label' }, 'From'),
        h('span', { class: 'source' }, sourceLabel(c)),
        p?.credit ? h('span', { class: 'credit', title: creditLine(p.credit) }, creditLine(p.credit)) : null,
      ),
    ),
  );
  return el;
}

/** "Nearby": the closest real places for this idea, under the ticket's buttons. Asked only on
    click (OpenStreetMap, with the city's coordinates); a second click closes it. */
async function toggleNearby(c, actions) {
  const open = actions.nextElementSibling;
  if (open?.classList.contains('nearby-panel')) return open.remove();
  const panel = h('div', { class: 'invite-panel nearby-panel', 'aria-live': 'polite' }, h('p', { class: 'hint' }, icon('loader-circle', 'spin'), ' Looking around your city…'));
  actions.after(panel);
  let res;
  try {
    res = await api.nearbyPlaces(c.id);
  } catch (e) {
    fill(panel, h('p', { class: 'hint' }, errText(e)));
    return;
  }
  if (!res.city) {
    fill(
      panel,
      h('p', {}, 'Set your city to see real places nearby.'),
      h('div', {}, btn({ label: 'Set my city', icon: 'map-pin', small: true, onclick: () => ctx.goto('settings', { focus: 'location' }) })),
    );
    return;
  }
  const km = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
  fill(
    panel,
    res.places.length
      ? h(
          'ul',
          { class: 'nearby-list' },
          res.places.map((p) =>
            h(
              'li',
              {},
              h('span', { class: 'nearby-name', translate: p.named ? 'no' : null }, p.name),
              h('span', { class: 'nearby-dist figures' }, km(p.distance_m)),
              btn({ label: `Open the map: ${p.name}`, icon: 'external-link', small: true, square: true, onclick: () => openLink(p.link) }),
            ),
          ),
        )
      : h('p', { class: 'hint' }, 'Nothing found within 8 km of your city.'),
    h('p', { class: 'nearby-credit' }, 'Map data © OpenStreetMap contributors'),
  );
}

function fareBox(label, value) {
  return h('div', {}, h('dt', {}, label), h('dd', { title: value }, value));
}

/** The idea's length (solid: at least, hatched: up to) against the free time you have. */
function timebar(c) {
  const min = c.min_minutes ?? 0;
  const max = Math.max(c.max_minutes ?? min, min);
  const you = state.req.minutes;
  const scale = Math.max(you, max) * 1.08 || 1;
  const pct = (m) => `${Math.min(100, (m / scale) * 100).toFixed(2)}%`;
  const takes = min === max ? fmtMinutes(min) : `${fmtMinutes(min)} to ${fmtMinutes(max)}`;
  return h(
    'div',
    { class: 'timebar' },
    h(
      'div',
      { class: 'timebar-track', role: 'img', 'aria-label': `Takes ${takes}; you have ${fmtMinutes(you)}` },
      h('div', { class: 'timebar-fill', style: `width:${pct(min)}` }),
      max > min ? h('div', { class: 'timebar-range', style: `left:${pct(min)};width:calc(${pct(max)} - ${pct(min)})` }) : null,
      h('div', { class: 'timebar-you', style: `left:${pct(you)}` }),
    ),
    h(
      'div',
      { class: 'timebar-legend' },
      h('span', {}, 'Takes ', h('span', { class: 'figures' }, takes)),
      h('span', {}, 'You have ', h('span', { class: 'figures' }, fmtMinutes(you))),
    ),
  );
}

/** On a started ticket, Start becomes a quiet "In progress": a second tap would count twice. */
function startedButton(el) {
  const button = el.querySelector('.coupon-actions > .btn.primary');
  if (!button) return;
  const done = btn({ label: 'In progress', icon: 'timer', kind: 'primary', title: 'Say how it was in the strip above' });
  done.disabled = true;
  done.classList.add('started');
  button.replaceWith(done);
}

function stamp(el, kind) {
  el.querySelector('.stamp')?.remove();
  el.append(h('div', { class: `stamp ${kind}`, 'aria-hidden': 'true' }, kind === 'void' ? 'Void' : 'Validated'));
}

/** "Not this one": stamp VOID, tear the coupon off, rank again without it. The idea is passed
    over: it sinks a little for a while instead of coming back as the lead next time. */
async function voidCoupon(c, el) {
  passed(c);
  state.hidden.add(c.id);
  askWhy(c);
  await tearCoupon(el);
}

async function tearCoupon(el) {
  state.lead = null;
  if (state.shownLead?.el === el) state.shownLead = null; // torn up: never kept by a refresh
  stamp(el, 'void');
  if (!reducedMotion()) {
    await wait(380);
    el.classList.add('tearing');
    await wait(420);
  }
  runSuggest({ keepShuffle: true, quiet: true });
}

/**
 * After "Not this one": an optional "why?" for that idea. The answer stays on this device
 * (history) and tunes the next picks; ignoring it changes nothing.
 */
function askWhy(c) {
  clearTimeout(state.whyTimer);
  const close = () => {
    clearTimeout(state.whyTimer);
    els.why.replaceChildren();
  };
  const answer = async (reason) => {
    close();
    try {
      await api.notNow(c.id, reason.id, state.req.minutes);
      toast(reason.done, 'ok', 4200);
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  fill(
    els.why,
    h(
      'div',
      { class: 'strip not-now' },
      icon('x'),
      h('div', { class: 'strip-text' }, h('strong', {}, h('span', {}, 'Not this one:'), ' ', h('span', { translate: 'no' }, c.title)), h('span', {}, 'Tell freetime why (optional): the next picks will take it into account.')),
      h(
        'div',
        { class: 'strip-actions' },
        NOT_NOW.map((r) => btn({ label: r.label, small: true, onclick: () => answer(r) })),
        btn({ label: 'Close', icon: 'x', square: true, small: true, kind: 'quiet', onclick: close }),
      ),
    ),
  );
  state.whyTimer = setTimeout(close, 20000);
}

/** A friend's "free now" changed (live): refresh the strip right away. */
export function friendFreeChanged() {
  state.together?.refresh();
}

/** Ticket of the day, weekly challenge and the door to the ticket book. */
function renderToday() {
  if (els.today) todayStrip(els.today, { onStart: (c) => start(c, null), openBook: () => ctx.goto('history', { tab: 'book' }) });
}

/** Start an idea picked elsewhere (the ticket book): same as Start on a ticket. */
export async function startIdea(c) {
  await start(c, null);
}

/**
 * "Start": record the pick, stamp VALIDATED, open the link if there is one. The idea is then in
 * progress: the strip above the ticket offers "I'm done" and asks how it was right away.
 */
async function start(c, el) {
  try {
    const picked = await api.pick(c.id);
    if (el && state.lead?.el === el) state.lead = null; // started: not "passed over", and S won't repeat it
    api.syncPoints().catch(() => {}); // ranked points (signed in only; quiet otherwise)
    // The week is now active: the "last week" strip goes, the streak chip may appear.
    if (els.week) weekStrip(els.week);
    renderToday();
    renderHead();
    if (el) {
      stamp(el, 'validated');
      startedButton(el);
    }
    if (Number.isFinite(picked?.ts)) {
      setNow({ id: c.id, ts: picked.ts, title: c.title, category: c.category, link: c.link ?? null, at: Date.now() });
    }
    // Started from further down (the book) or another screen: the strip may be out of sight.
    if (!el || !picked?.ts) toast('Enjoy. When you are done, Discover asks how it went.', 'ok', 4200);
    if (c.link) {
      if (el && !reducedMotion()) await wait(450);
      openLink(c.link);
    }
  } catch (e) {
    toast(errText(e), 'error');
  }
}

async function openLink(url) {
  try {
    await api.open(url);
  } catch (e) {
    toast(errText(e), 'error');
  }
}

// ---------------------------------------------------------------- the rest of the book

function leaf(c, i) {
  const link = c.link ? linkLabel(c) : null;
  const removeLeaf = () => {
    el.classList.add('voided');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 260);
  };
  const meta = [span(c), FARE[c.cost] ?? c.cost, c.outdoor ? 'Outside' : null, c.social === 'group' ? 'Group' : null];
  const el = h(
    'article',
    { class: 'leaf', vars: { '--i': i } },
    h('div', { class: 'leaf-photo' }, photo(c), h('span', { class: 'leaf-source' }, c.category_label)),
    h('div', { class: 'leaf-perf', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'leaf-body' },
      h('h3', { class: 'leaf-title', title: c.title }, c.title),
      c.detail ? h('p', { class: 'leaf-detail', title: c.detail }, c.detail) : null,
      h('div', { class: 'leaf-meta' }, meta.filter(Boolean).map((m) => h('span', {}, m))),
      h(
        'div',
        { class: 'leaf-actions' },
        btn({ label: 'Start', icon: 'play', small: true, onclick: () => start(c, null) }),
        link ? btn({ label: link.text, icon: link.icon, small: true, square: true, onclick: () => openLink(c.link) }) : null,
        btn({
          label: `Not now: ${c.title}`,
          icon: 'x',
          kind: 'quiet',
          small: true,
          square: true,
          onclick: () => {
            passed(c);
            state.hidden.add(c.id);
            askWhy(c);
            removeLeaf();
          },
        }),
        btn({
          label: `Never suggest: ${c.title}`,
          icon: 'ban',
          kind: 'quiet',
          small: true,
          square: true,
          onclick: () => never(c, removeLeaf),
        }),
      ),
    ),
  );
  return el;
}

function notesBlock(notes) {
  if (!notes?.length) return null;
  return h(
    'div',
    { class: 'notes' },
    notes.map((n) =>
      h(
        'div',
        { class: n.tip ? 'note' : 'note problem' },
        icon(n.tip ? 'info' : 'triangle-alert'),
        h('span', {}, n.text),
        n.tip ? btn({ label: 'Open settings', kind: 'quiet', small: true, onclick: () => ctx.goto('settings') }) : null,
      ),
    ),
  );
}

// ---------------------------------------------------------------- surprise

/** A random idea that still fits, issued as today's ticket. */
async function surprise() {
  renderLoading();
  try {
    const started = performance.now();
    const s = await api.surprise([...state.hidden]);
    await wait(Math.max(0, 350 - (performance.now() - started)));
    state.lead = state.shownLead = null;
    if (!s.pick) {
      els.rest.replaceChildren();
      fill(els.results, emptyState({ icon: 'shuffle', title: 'Nothing left to draw', text: 'Every idea has been voided this session.' }));
      return;
    }
    const lead = coupon(s.pick, { label: 'Surprise' });
    state.lead = state.shownLead = { c: s.pick, el: lead };
    fill(els.results, lead);
    fill(
      els.rest,
      s.alternatives?.length
        ? [
            h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Or maybe')),
            h('div', { class: 'book' }, s.alternatives.map((c, i) => leaf(c, i))),
          ]
        : null,
    );
  } catch (e) {
    toast(errText(e), 'error');
    runSuggest({ keepShuffle: true });
  }
}
