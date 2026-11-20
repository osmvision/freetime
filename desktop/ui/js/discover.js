// The main screen: today's ticket (the best pick), why it fits, and the rest of the book behind it.

import { api } from './api.js';
import { locale } from './i18n.js';
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
const MOOD_KEY = 'freetime.mood.v2';
const BOOK_SIZE = 12;

let ctx;
const els = {};
const state = {
  req: null,
  categories: [],
  online: null,
  setup: null,
  pending: [],
  hidden: new Set(), // voided during this session
  shuffled: new Set(), // already shown, skipped by "Other picks"
  lead: null, // { c, el }: the ticket on top, for the S / N shortcuts and "Other picks"
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
  const mood = loadMood(boot.categories);
  state.party = mood.party ?? [];
  delete mood.party;
  state.req = { ...boot.defaults, ...mood };
  loadFriends();

  els.head = h('div');
  els.context = h('div', { class: 'context', role: 'toolbar', 'aria-label': 'Your free time' });
  els.cityPrompt = h('div');
  els.rate = h('div');
  els.results = h('div', { 'aria-live': 'polite' });
  els.free = h('div');
  els.week = h('div');
  els.today = h('div');
  els.root = root;
  root.replaceChildren(els.head, els.context, els.free, els.week, els.today, els.cityPrompt, els.rate, els.results);
  weekStrip(els.week);
  renderToday();
  // Who's free and "I'm free" (signed in only). Refreshed every minute while Discover is on screen.
  // When the friend list first arrives (or changes size), redraw so the ticket gets its Invite button.
  state.together = freeStrip(els.free, () => state.req.minutes, () => {
    renderContext();
    if (state.results?.best && !state.loading) renderResults(state.results);
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
    runSuggest({ keepShuffle: true, quiet: true, announce: 'Picks refreshed with Steam, YouTube and the weather' });
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
      value: () => {
        const n = r.categories.length;
        if (n === 0) return 'None';
        if (n === state.categories.length) return 'Anything';
        if (n === 1) return state.categories.find((c) => c.id === r.categories[0])?.label ?? '1 kind';
        return `${n} kinds`;
      },
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

/** Asked once: the city is only used for the weather, and skipping is fine. */
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

// ---------------------------------------------------------------- "how was it?"

function renderRate() {
  const p = state.pending[0];
  if (!p) {
    els.rate.replaceChildren();
    return;
  }
  const answer = async (rating) => {
    try {
      state.pending = await api.rate(p.id, p.ts, rating);
      toast(rating > 0 ? 'Noted: more ideas like that' : rating < 0 ? 'Noted: fewer ideas like that' : 'Skipped', 'ok');
      renderRate();
      if (rating > 0) offerShare({ kind: 'pick', idea_id: p.id, title: p.title, category: p.category ?? '', detail: '' });
    } catch (e) {
      toast(errText(e), 'error');
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
        h('span', {}, `You picked it ${p.ago}. Your answer tunes the next picks.`),
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

async function runSuggest({ keepShuffle = false, quiet = false, announce = null } = {}) {
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
    renderResults(res);
    renderHead();
    if (announce) toast(announce, 'ok');
    // The online data may have arrived while this request was running.
    refreshAfter = res.partial && Boolean(state.online?.ready) && !state.online?.loading;
  } catch (e) {
    fill(
      els.results,
      emptyState({
        icon: 'triangle-alert',
        title: 'Something went wrong',
        text: errText(e),
        actions: [btn({ label: 'Try again', icon: 'refresh-cw', onclick: () => runSuggest() })],
      }),
    );
  } finally {
    state.loading = false;
  }
  if (state.again) {
    state.again = false;
    runSuggest({ keepShuffle: true });
  } else if (refreshAfter) {
    runSuggest({ keepShuffle: true, quiet: true, announce: 'Picks refreshed with Steam, YouTube and the weather' });
  }
}

function renderLoading() {
  fill(
    els.results,
    h('div', { class: 'ghost coupon-ghost', 'aria-label': 'Finding your best pick' }),
    h('div', { class: 'section-head' }, h('div', { class: 'ghost', style: 'width:260px;height:28px' })),
    h('div', { class: 'book' }, Array.from({ length: 4 }, () => h('div', { class: 'ghost leaf-ghost' }))),
  );
}

function renderResults(res) {
  state.lead = null;
  if (!res.best) {
    const seenAll = state.shuffled.size > 0 || state.hidden.size > 0;
    fill(
      els.results,
      emptyState({
        icon: seenAll ? 'check' : 'search',
        title: seenAll ? 'That is the whole book' : 'Nothing fits right now',
        text: seenAll
          ? 'You have seen every idea for this context.'
          : 'Try more time, a bigger budget, more kinds of ideas, or going outside.',
        actions: seenAll
          ? [btn({ label: 'Start over', icon: 'refresh-cw', onclick: () => { state.hidden.clear(); runSuggest(); } })]
          : [],
      }),
    );
    return;
  }
  const rest = res.groups.flatMap((g) => g.items);
  state.shown = [res.best, ...rest].map((c) => c.id);
  const lead = coupon(res.best);
  state.lead = { c: res.best, el: lead };
  fill(
    els.results,
    res.partial
      ? h(
          'div',
          { class: 'note', style: 'margin-bottom:14px;border:0' },
          icon('loader-circle', 'spin'),
          h('span', {}, 'Steam, YouTube and the weather are still loading. Your picks will refresh by themselves.'),
        )
      : null,
    lead,
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
          state.together?.friends().length && invitable(c)
            ? btn({
                label: 'Invite',
                icon: 'users',
                onclick: (e) => {
                  const actions = e.currentTarget.closest('.coupon-actions');
                  const open = actions.nextElementSibling?.classList.contains('invite-panel');
                  if (open) return actions.nextElementSibling.remove();
                  const panel = invitePanel(c, state.together.friends(), () => panel.remove());
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

function stamp(el, kind) {
  el.querySelector('.stamp')?.remove();
  el.append(h('div', { class: `stamp ${kind}`, 'aria-hidden': 'true' }, kind === 'void' ? 'Void' : 'Validated'));
}

/** "Not this one": stamp VOID, tear the coupon off, rank again without it. The idea is passed
    over: it sinks a little for a while instead of coming back as the lead next time. */
async function voidCoupon(c, el) {
  passed(c);
  state.hidden.add(c.id);
  await tearCoupon(el);
}

async function tearCoupon(el) {
  state.lead = null;
  stamp(el, 'void');
  if (!reducedMotion()) {
    await wait(380);
    el.classList.add('tearing');
    await wait(420);
  }
  runSuggest({ keepShuffle: true, quiet: true });
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

/** "Start": record the pick, stamp VALIDATED, open the link if there is one. */
async function start(c, el) {
  try {
    await api.pick(c.id);
    if (el && state.lead?.el === el) state.lead = null; // started: not "passed over", and S won't repeat it
    api.syncPoints().catch(() => {}); // ranked points (signed in only; quiet otherwise)
    // The week is now active: the "last week" strip goes, the streak chip may appear.
    if (els.week) weekStrip(els.week);
    renderToday();
    renderHead();
    if (el) stamp(el, 'validated');
    toast('Enjoy. Next time freetime will ask how it went.', 'ok', 4200);
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
    state.lead = null;
    if (!s.pick) {
      fill(els.results, emptyState({ icon: 'shuffle', title: 'Nothing left to draw', text: 'Every idea has been voided this session.' }));
      return;
    }
    const lead = coupon(s.pick, { label: 'Surprise' });
    state.lead = { c: s.pick, el: lead };
    fill(
      els.results,
      lead,
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
