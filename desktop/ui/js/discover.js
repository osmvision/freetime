// The main screen: tell it how you feel, get the best thing to do right now.

import { api } from './api.js';
import { cityPicker, openMeteoCredit } from './city.js';
import {
  capitalize,
  catVars,
  closeModal,
  confetti,
  emptyState,
  errText,
  fill,
  fmtMinutes,
  h,
  linkLabel,
  openModal,
  pageHead,
  setModal,
  toast,
  wait,
} from './dom.js';

const TIMES = [15, 30, 60, 120, 240];
const ENERGY = [
  { id: 'low', emo: '😴', label: 'Chill' },
  { id: 'medium', emo: '🙂', label: 'Steady' },
  { id: 'high', emo: '⚡', label: 'Pumped' },
];
const COMPANY = [
  { id: false, label: '🧍 Just me' },
  { id: true, label: '👥 With friends' },
];
const BUDGET = [
  { id: 'free', label: 'Free' },
  { id: 'cheap', label: 'Cheap' },
  { id: 'paid', label: 'Any' },
];
const COST = { free: '💸 Free', cheap: '🪙 Cheap', paid: '💳 Paid' };
const MOOD_KEY = 'freetime.mood.v1';

let ctx;
const els = {};
const state = {
  req: null,
  categories: [],
  online: null,
  setup: null,
  pending: [],
  hidden: new Set(), // "not for me" during this session
  shuffled: new Set(), // already shown, skipped by Shuffle
  shown: [],
  results: null,
  loading: false,
  stale: false, // settings changed: refresh picks once the new data is in
};

export function init(root, boot, context) {
  ctx = context;
  state.categories = boot.categories;
  state.online = boot.online;
  state.setup = boot.setup;
  state.pending = boot.pending;
  state.req = { ...boot.defaults, ...loadMood(boot.categories) };

  els.rate = h('div', { class: 'rate-zone' });
  els.cityPrompt = h('div', { class: 'city-prompt-zone' });
  els.results = h('section', { class: 'results', 'aria-live': 'polite' });
  root.replaceChildren(header(), els.cityPrompt, els.rate, h('div', { class: 'discover-grid' }, moodPanel(), els.results));
  renderCityPrompt();
  renderRate();
  runSuggest();
}

export function onOnline(online) {
  const wasPartial = Boolean(state.results?.partial);
  state.online = online;
  renderWeather();
  renderOutsideHint();
  if (!online.ready || online.loading || state.loading) return;
  if (state.stale) {
    state.stale = false;
    runSuggest({ keepShuffle: true, quiet: true, announce: 'Picks updated with your new settings' });
  } else if (wasPartial) {
    runSuggest({ keepShuffle: true, quiet: true, announce: 'Picks refreshed with Steam, YouTube and the weather' });
  }
}

export async function settingsChanged() {
  state.stale = true;
  try {
    const boot = await api.bootstrap();
    state.setup = boot.setup;
    state.online = boot.online;
    renderWeather();
    renderOutsideHint();
    renderCityPrompt();
  } catch {
    // The next sync event catches up.
  }
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
      renderWeather();
      renderOutsideHint();
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  els.cityPrompt.replaceChildren(
    h(
      'div',
      { class: 'city-prompt card' },
      h(
        'div',
        { class: 'city-prompt-text' },
        h('strong', {}, 'Where are you?'),
        h('span', {}, 'Your city lets freetime check the weather, so outdoor ideas only show up when it’s nice out. You can change it anytime in Settings.'),
        openMeteoCredit(),
      ),
      h(
        'div',
        { class: 'city-prompt-actions' },
        cityPicker({ onPick: answer }),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => answer(null) }, 'Skip'),
      ),
    ),
  );
}

// ---------------------------------------------------------------- remembered mood

function loadMood(categories) {
  try {
    const saved = JSON.parse(localStorage.getItem(MOOD_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return {};
    const known = new Set(categories.map((c) => c.id));
    const mood = {};
    if (Number.isFinite(saved.minutes) && saved.minutes >= 5 && saved.minutes <= 300) mood.minutes = saved.minutes;
    if (typeof saved.with_friends === 'boolean') mood.with_friends = saved.with_friends;
    if (BUDGET.some((b) => b.id === saved.budget)) mood.budget = saved.budget;
    const cats = Array.isArray(saved.categories) ? saved.categories.filter((c) => known.has(c)) : [];
    if (cats.length) mood.categories = cats;
    return mood;
  } catch {
    return {};
  }
}

function saveMood() {
  try {
    const { minutes, with_friends, budget, categories } = state.req;
    localStorage.setItem(MOOD_KEY, JSON.stringify({ minutes, with_friends, budget, categories }));
  } catch {
    // Storage unavailable: the mood just won't be remembered.
  }
}

// ---------------------------------------------------------------- header

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return ['Night owl mode', '🦉'];
  if (hour < 12) return ['Good morning', '☀️'];
  if (hour < 18) return ['Good afternoon', '🌤️'];
  if (hour < 22) return ['Good evening', '🌆'];
  return ['Late night', '🌙'];
}

function header() {
  const [hello, emoji] = greeting();
  els.weather = h('div', { class: 'weather-slot' });
  renderWeather();
  return pageHead(`${hello} ${emoji}`, "Got some free time? Let's make it count.", els.weather);
}

function renderWeather() {
  if (!els.weather) return;
  const online = state.online;
  const w = online?.weather;
  let chip;
  if (w) {
    chip = h(
      'div',
      { class: 'weather-chip', title: w.summary },
      h('span', { class: 'w-emoji' }, w.emoji),
      h('strong', {}, `${Math.round(w.temp_c)}°C`),
      h('span', {}, `${w.place} · ${w.sky}`),
    );
  } else if (!online?.ready) {
    chip = h('div', { class: 'weather-chip' }, h('span', { class: 'spinner' }), 'Checking the weather…');
  } else if (!state.setup?.city) {
    chip = h('button', { class: 'weather-chip clickable', onclick: () => ctx.goto('settings') }, '📍 Set your city');
  } else {
    chip = h('div', { class: 'weather-chip' }, '🌡️ Weather unavailable');
  }
  els.weather.replaceChildren(chip);
}

// ---------------------------------------------------------------- mood panel

function moodPanel() {
  els.findBtn = h('button', { class: 'btn primary big', onclick: () => runSuggest() }, '✨ Find my best pick');
  return h(
    'aside',
    { class: 'mood card', 'aria-label': 'Your mood' },
    timeField(),
    field(
      'Energy',
      null,
      choice('energy', ENERGY, state.req.energy, (id) => (state.req.energy = id), (o) => [
        h('span', { class: 'emo' }, o.emo),
        h('span', {}, o.label),
      ]),
    ),
    field(
      'Who',
      null,
      choice('segmented', COMPANY, state.req.with_friends, (id) => {
        state.req.with_friends = id;
        saveMood();
      }, (o) => o.label),
    ),
    outsideField(),
    field(
      'Budget',
      null,
      choice('segmented', BUDGET, state.req.budget, (id) => {
        state.req.budget = id;
        saveMood();
      }, (o) => o.label),
    ),
    categoriesField(),
    h(
      'div',
      { class: 'mood-actions' },
      els.findBtn,
      h('button', { class: 'btn big ghost', onclick: () => runSurprise([]) }, '🎲 Surprise me'),
    ),
  );
}

function field(label, aside, ...children) {
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('span', {}, label), aside), children);
}

/** A group of toggle buttons where exactly one is pressed. */
function choice(cls, options, current, onPick, render) {
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(o.id === current),
        onclick: () => {
          buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].id === o.id)));
          onPick(o.id);
        },
      },
      render(o),
    ),
  );
  return h('div', { class: cls, role: 'group' }, buttons);
}

function timeField() {
  const value = h('span', { class: 'time-value' });
  const range = h('input', { type: 'range', min: 5, max: 300, step: 5, 'aria-label': 'Free time in minutes' });
  const chips = TIMES.map((m) => h('button', { type: 'button', class: 'chip', onclick: () => setMinutes(m) }, fmtMinutes(m)));

  function paint() {
    const m = state.req.minutes;
    value.textContent = fmtMinutes(m);
    range.value = String(m);
    range.style.setProperty('--p', `${((m - 5) / 295) * 100}%`);
    chips.forEach((c, i) => c.setAttribute('aria-pressed', String(TIMES[i] === m)));
  }
  function setMinutes(m) {
    state.req.minutes = m;
    paint();
    saveMood();
  }

  range.addEventListener('input', () => setMinutes(Number(range.value)));
  paint();
  return field('Free time', value, h('div', { class: 'chips' }, chips), range);
}

function outsideField() {
  const input = h('input', {
    type: 'checkbox',
    id: 'go-out',
    checked: state.req.can_go_out,
    onchange: (e) => {
      state.req.can_go_out = e.target.checked;
      renderOutsideHint();
    },
  });
  els.outsideHint = h('div', { class: 'hint' });
  const el = h(
    'div',
    { class: 'field' },
    h(
      'label',
      { class: 'switch-row', for: 'go-out' },
      h('span', {}, 'Up for going outside'),
      h('span', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' })),
    ),
    els.outsideHint,
  );
  renderOutsideHint();
  return el;
}

function renderOutsideHint() {
  const el = els.outsideHint;
  if (!el) return;
  const w = state.online?.weather;
  if (!state.req.can_go_out) {
    el.className = 'hint';
    el.textContent = 'Indoor ideas only.';
  } else if (!w) {
    el.className = 'hint';
    el.textContent = state.setup?.city ? 'Weather unknown right now.' : 'Set your city in Settings to factor in the weather.';
  } else if (w.outdoor_ok) {
    el.className = 'hint good';
    el.textContent = `${w.emoji} Nice out: ${Math.round(w.temp_c)}°C, ${w.sky}.`;
  } else {
    el.className = 'hint warn';
    el.textContent = `${w.emoji} ${capitalize(w.sky)}, ${Math.round(w.temp_c)}°C: indoor ideas will rank higher.`;
  }
}

function categoriesField() {
  const chips = state.categories.map((c) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip cat',
        vars: catVars(c.id),
        'aria-pressed': String(state.req.categories.includes(c.id)),
        onclick: (e) => toggleCategory(c.id, e.currentTarget),
      },
      `${c.icon} ${c.label}`,
    ),
  );
  const all = h(
    'button',
    {
      type: 'button',
      class: 'link-btn',
      onclick: () => {
        state.req.categories = state.categories.map((c) => c.id);
        chips.forEach((b) => b.setAttribute('aria-pressed', 'true'));
        saveMood();
      },
    },
    'Select all',
  );
  return field('In the mood for', all, h('div', { class: 'chips' }, chips));
}

function toggleCategory(id, button) {
  const on = state.req.categories.includes(id);
  if (on && state.req.categories.length === 1) {
    toast('Keep at least one category 🙂');
    return;
  }
  state.req.categories = on ? state.req.categories.filter((x) => x !== id) : [...state.req.categories, id];
  button.setAttribute('aria-pressed', String(!on));
  saveMood();
}

// ---------------------------------------------------------------- suggestions

async function runSuggest({ keepShuffle = false, quiet = false, announce = null } = {}) {
  if (state.loading) return;
  state.loading = true;
  setBusy(true);
  if (!keepShuffle) state.shuffled.clear();
  if (!quiet || !state.results) renderSkeleton();
  let refreshAfter = false;
  try {
    const res = await api.suggest(state.req, [...state.hidden, ...state.shuffled]);
    state.results = res;
    renderResults(res);
    if (announce) toast(announce, 'ok');
    // The online data may have arrived while this request was running.
    refreshAfter = res.partial && Boolean(state.online?.ready) && !state.online?.loading;
  } catch (e) {
    els.results.replaceChildren(
      emptyState({
        emoji: '😵',
        title: 'Something went wrong',
        text: errText(e),
        action: h('button', { class: 'btn', onclick: () => runSuggest() }, 'Try again'),
      }),
    );
  } finally {
    state.loading = false;
    setBusy(false);
  }
  if (refreshAfter) {
    runSuggest({ keepShuffle: true, quiet: true, announce: 'Picks refreshed with Steam, YouTube and the weather' });
  }
}

function setBusy(busy) {
  if (!els.findBtn) return;
  els.findBtn.disabled = busy;
  els.findBtn.textContent = busy ? 'Finding…' : '✨ Find my best pick';
}

function renderSkeleton() {
  els.results.replaceChildren(
    h(
      'div',
      { class: 'results-head' },
      h(
        'div',
        {},
        h('h2', {}, 'Finding your best pick…'),
        h('div', { class: 'summary' }, state.online?.ready ? 'Ranking ideas for your mood' : 'Checking Steam, YouTube and the weather'),
      ),
    ),
    h('div', { class: 'skeleton best-skeleton' }),
    h('div', { class: 'grid' }, Array.from({ length: 6 }, () => h('div', { class: 'skeleton card-skeleton' }))),
  );
}

function renderResults(res) {
  if (!res.best) {
    const seenAll = state.shuffled.size > 0 || state.hidden.size > 0;
    els.results.replaceChildren(
      emptyState({
        emoji: seenAll ? '🏁' : '🤔',
        title: seenAll ? "That's everything that fits" : 'Nothing fits those settings',
        text: seenAll
          ? "You've seen every idea for this mood."
          : 'Try more time, a bigger budget, more categories, or going outside.',
        action: seenAll
          ? h('button', { class: 'btn', onclick: () => { state.hidden.clear(); runSuggest(); } }, '↺ Start over')
          : null,
      }),
    );
    return;
  }
  state.shown = [res.best, ...res.groups.flatMap((g) => g.items)].map((c) => c.id);
  let index = 0;
  fill(
    els.results,
    h(
      'div',
      { class: 'results-head' },
      h('div', {}, h('h2', {}, 'Your picks'), h('div', { class: 'summary' }, res.summary)),
      h('button', { class: 'btn small', title: 'Show other ideas for the same mood', onclick: shuffle }, '🔀 Shuffle'),
    ),
    res.partial
      ? h(
          'div',
          { class: 'note' },
          h('span', {}, '⏳'),
          h('span', {}, 'Steam, YouTube and the weather are still loading. Your picks will refresh by themselves.'),
        )
      : null,
    bestCard(res.best),
    res.groups.map((g) =>
      h(
        'section',
        { class: 'group', vars: catVars(g.category) },
        h('h3', { class: 'group-title' }, h('span', { class: 'group-dot' }), `${g.icon} ${g.label}`),
        h('div', { class: 'grid' }, g.items.map((c) => ideaCard(c, index++))),
      ),
    ),
    notesBlock(res.notes),
  );
}

function shuffle() {
  state.shown.forEach((id) => state.shuffled.add(id));
  runSuggest({ keepShuffle: true });
}

function bestCard(c) {
  return h(
    'article',
    { class: 'best', vars: catVars(c.category) },
    thumb(c, true),
    h(
      'div',
      { class: 'best-body' },
      h('div', { class: 'kicker' }, '★ Best pick right now'),
      h('h3', {}, c.title),
      h('p', { class: 'detail' }, c.detail),
      meta(c, true),
      reasons(c),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => doPick(c) }, "Let's do it"),
        c.link ? h('button', { class: 'btn', onclick: () => openLink(c.link) }, linkLabel(c)) : null,
        h('button', { class: 'btn ghost', onclick: () => hide(c, null) }, 'Not this one'),
      ),
    ),
  );
}

function ideaCard(c, i) {
  const card = h(
    'article',
    { class: 'idea', vars: { ...catVars(c.category), '--i': i } },
    thumb(c, false),
    h('button', { class: 'hide-btn', title: 'Not for me', 'aria-label': `Hide ${c.title}`, onclick: () => hide(c, card) }, '✕'),
    h(
      'div',
      { class: 'idea-body' },
      h('h4', { title: c.title }, c.title),
      h('p', { class: 'detail', title: c.detail }, c.detail),
      meta(c),
      reasons(c),
    ),
    h(
      'div',
      { class: 'idea-actions' },
      h('button', { class: 'btn small primary', onclick: () => doPick(c) }, 'Do it'),
      c.link
        ? h('button', { class: 'btn small', title: linkLabel(c), 'aria-label': linkLabel(c), onclick: () => openLink(c.link) }, '↗')
        : null,
    ),
  );
  return card;
}

function thumb(c, big) {
  const box = h('div', { class: big ? 'thumb big' : 'thumb' });
  const fallback = () => h('span', { class: 'thumb-emoji' }, c.icon);
  if (c.image) {
    const img = h('img', { src: c.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    box.append(img);
  } else {
    box.append(fallback());
  }
  const src = source(c);
  if (src) box.append(h('span', { class: 'src' }, src));
  return box;
}

function source(c) {
  if (c.id.startsWith('steam:')) return c.tags.includes('store') ? 'Steam store' : 'Your library';
  if (c.id.startsWith('yt:')) return 'YouTube';
  if (c.id.startsWith('ytsearch:')) return 'YouTube search';
  return null;
}

function meta(c, withCategory = false) {
  const badges = [`⏱ ${c.duration}`, COST[c.cost]];
  if (withCategory) badges.unshift(`${c.icon} ${c.category_label}`);
  if (c.outdoor) badges.push('🌳 Outside');
  if (c.social === 'group') badges.push('👥 Group');
  return h('div', { class: 'meta' }, badges.map((b) => h('span', { class: 'badge' }, b)));
}

function reasons(c) {
  if (!c.reasons?.length) return null;
  return h('div', { class: 'reasons' }, c.reasons.map((r) => h('span', { class: 'reason' }, `✓ ${r}`)));
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
        h('span', {}, n.tip ? '💡' : '⚠️'),
        h('span', {}, n.text),
        n.tip ? h('button', { class: 'btn small ghost', onclick: () => ctx.goto('settings') }, 'Open settings') : null,
      ),
    ),
  );
}

function hide(c, cardEl) {
  state.hidden.add(c.id);
  if (!cardEl) {
    // The best pick was skipped: rank again without it.
    runSuggest({ keepShuffle: true });
    return;
  }
  cardEl.classList.add('leaving');
  setTimeout(() => cardEl.remove(), 220);
  toast(`Hidden “${c.title}” for now`);
}

async function openLink(url) {
  try {
    await api.open(url);
  } catch (e) {
    toast(errText(e), 'error');
  }
}

async function doPick(c) {
  try {
    const picked = await api.pick(c.id);
    openModal([
      h('div', { class: 'big-emoji' }, picked.icon),
      h('h2', {}, 'Enjoy!'),
      h('p', { class: 'modal-title' }, picked.title),
      h('p', { class: 'muted' }, "Next time you open freetime I'll ask how it went, so I can learn what you like."),
      h(
        'div',
        { class: 'actions' },
        picked.link
          ? h('button', { class: 'btn primary', onclick: () => { openLink(picked.link); closeModal(); } }, linkLabel(picked))
          : null,
        h('button', { class: picked.link ? 'btn' : 'btn primary', onclick: () => closeModal() }, picked.link ? 'Later' : 'Done'),
      ),
    ]);
    confetti(picked.icon);
  } catch (e) {
    toast(errText(e), 'error');
  }
}

async function runSurprise(exclude) {
  setModal([h('div', { class: 'dice' }, '🎲'), h('p', { class: 'muted' }, 'Rolling the dice…')]);
  const started = performance.now();
  try {
    const s = await api.surprise(exclude);
    await wait(Math.max(0, 800 - (performance.now() - started)));
    if (!s.pick) {
      setModal([
        h('div', { class: 'big-emoji' }, '🤷'),
        h('h2', {}, 'Nothing left to roll'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeModal() }, 'Close')),
      ]);
      return;
    }
    const c = s.pick;
    setModal([
      h('div', { class: 'kicker' }, '🎲 Try this'),
      h('div', { class: 'surprise-card', vars: catVars(c.category) }, thumb(c, true)),
      h('h2', {}, c.title),
      h('p', { class: 'muted' }, c.detail),
      meta(c),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => { closeModal(); doPick(c); } }, "Let's do it"),
        h('button', { class: 'btn', onclick: () => runSurprise([...exclude, c.id]) }, '🎲 Reroll'),
      ),
      s.alternatives.length
        ? h(
            'div',
            { class: 'alts' },
            h('div', { class: 'alts-label' }, 'Or maybe'),
            s.alternatives.map((a) =>
              h(
                'button',
                { class: 'alt', vars: catVars(a.category), onclick: () => { closeModal(); doPick(a); } },
                h('span', {}, a.icon),
                h('span', { class: 'alt-title' }, a.title),
                h('span', { class: 'alt-dur' }, a.duration),
              ),
            ),
          )
        : null,
    ]);
  } catch (e) {
    closeModal();
    toast(errText(e), 'error');
  }
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
      toast(rating > 0 ? 'Noted: more ideas like that 👍' : rating < 0 ? 'Got it: fewer ideas like that' : 'Skipped', 'ok');
      renderRate();
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  els.rate.replaceChildren(
    h(
      'div',
      { class: 'rate' },
      h('span', { class: 'rate-emoji' }, p.icon),
      h(
        'div',
        { class: 'rate-text' },
        h('strong', {}, `How was “${p.title}”?`),
        h('span', {}, `You picked it ${p.ago}. Your answer tunes future picks.`),
      ),
      h(
        'div',
        { class: 'rate-actions' },
        h('button', { class: 'btn small', onclick: () => answer(1) }, '👍 Loved it'),
        h('button', { class: 'btn small', onclick: () => answer(-1) }, '👎 Not for me'),
        h('button', { class: 'btn small ghost', onclick: () => answer(0) }, 'Skip'),
      ),
    ),
  );
}
