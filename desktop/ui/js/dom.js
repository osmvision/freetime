// Small DOM helpers shared by every view.
// Text always goes in as text nodes, never as HTML, so titles from Steam or YouTube can't inject markup.
// The one exception is icons.js: static, trusted SVG generated at build time.

import { ICONS } from './icons.js';

/** h('button', { class: 'btn', onclick }, 'Label') */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'vars') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, String(v));
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Like el.replaceChildren(), but skips null/false and flattens arrays (the native one stringifies them). */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/** A Lucide icon. Decorative: the text next to it (or an aria-label on the button) carries the meaning. */
export function icon(name, cls = '') {
  const el = document.createElement('span');
  el.className = cls ? `icon ${cls}` : 'icon';
  el.setAttribute('aria-hidden', 'true');
  // The only innerHTML in the app: static SVG from icons.js, looked up by own key only (a name
  // like "constructor" must not reach anything but the fallback).
  const svg = typeof name === 'string' && Object.hasOwn(ICONS, name) ? ICONS[name] : ICONS.info;
  el.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg>`;
  return el;
}

/** Fills every <span data-icon="name"> in static markup. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (!el.firstChild) el.append(icon(el.dataset.icon));
  }
}

const CATEGORY_ICONS = {
  game: 'gamepad-2',
  video: 'circle-play',
  sport: 'activity',
  learn: 'graduation-cap',
  create: 'palette',
  chill: 'leaf',
  social: 'users',
  food: 'utensils',
};
export const categoryIcon = (category) => CATEGORY_ICONS[category] ?? 'ticket';

/** Weather icon from the sky text the core sends ("clear sky", "rain showers", ...). */
export function weatherIcon(w) {
  const sky = w?.sky ?? '';
  if (sky.includes('thunder')) return 'cloud-lightning';
  if (sky.includes('snow')) return 'snowflake';
  if (sky.includes('rain') || sky.includes('drizzle')) return 'cloud-rain';
  if (sky.includes('fog')) return 'cloud-fog';
  if (sky.includes('overcast')) return 'cloud';
  if (sky.includes('partly')) return w.is_day ? 'cloud-sun' : 'cloud';
  if (sky.includes('clear')) return w.is_day ? 'sun' : 'moon';
  return 'cloud-sun';
}

export function fmtMinutes(m) {
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hours}h${String(rest).padStart(2, '0')}` : `${hours}h`;
}

/** A readable error: the "(HTTP 500)" the backend adds for the logs means nothing to a person. */
export const errText = (e) => (typeof e === 'string' ? e : (e?.message ?? String(e))).replace(/\s*\(HTTP \d{3}\)$/, '');
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A short message. `action` ({ label, onclick }) adds one button, like "Undo"; the toast closes
    when it's used. */
export function toast(text, kind = 'info', ms = 3400, action = null) {
  const box = document.getElementById('toasts');
  const name = kind === 'error' ? 'triangle-alert' : kind === 'ok' ? 'check' : 'info';
  const leave = () => {
    if (el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  };
  const el = h(
    'div',
    { class: `toast ${kind}` },
    icon(name),
    h('span', {}, text),
    action
      ? h('button', { type: 'button', class: 'toast-action', onclick: () => { leave(); action.onclick(); } }, action.label)
      : null,
  );
  box.append(el);
  setTimeout(leave, ms);
}

export function pageHead(title, subtitle, aside = null) {
  return h(
    'header',
    { class: 'page-head' },
    h('div', {}, h('h1', { class: 'page-title' }, title), subtitle ? h('p', { class: 'page-sub' }, subtitle) : null),
    aside,
  );
}

export function emptyState({ icon: name = 'ticket', title, text, actions = [] }) {
  return h(
    'div',
    { class: 'empty' },
    icon(name),
    h('h2', {}, title),
    text ? h('p', {}, text) : null,
    actions.length ? h('div', { class: 'strip-actions' }, actions) : null,
  );
}

/** A button: btn({ label, icon, kind: 'primary' | 'quiet', small, onclick, title }) */
export function btn({ label, icon: name, kind = '', small = false, square = false, onclick, title, type = 'button' }) {
  const cls = ['btn', kind, small ? 'small' : '', square ? 'square' : ''].filter(Boolean).join(' ');
  return h(
    'button',
    { type, class: cls, onclick, title: title ?? (square ? label : null), 'aria-label': square ? label : null },
    name ? icon(name) : null,
    square ? null : label,
  );
}

/** What the "open" button of an idea should say, and its icon. */
export function linkLabel(item) {
  const link = item.link ?? '';
  if (link.startsWith('steam://')) return { text: 'Launch in Steam', icon: 'play' };
  if (link.includes('youtu.be/') || link.includes('youtube.com/watch')) return { text: 'Watch on YouTube', icon: 'circle-play' };
  if (link.includes('youtube.com/results')) return { text: 'Search YouTube', icon: 'search' };
  if (link.includes('store.steampowered.com')) return { text: 'View on Steam', icon: 'external-link' };
  if (link.startsWith('https://store.epicgames.com/')) return { text: 'Get it free on Epic', icon: 'external-link' };
  return { text: 'Open link', icon: 'external-link' };
}

/** Where an item comes from, for the stub and the photo tag. */
export function sourceLabel(c) {
  const id = c.id ?? '';
  if (id.startsWith('steam:')) return c.tags?.includes('store') ? 'Steam store' : 'Your Steam library';
  if (id.startsWith('epic:')) return 'Epic Games Store';
  if (id.startsWith('yt:')) return 'YouTube';
  if (id.startsWith('ytsearch:')) return 'YouTube search';
  return 'freetime idea';
}
