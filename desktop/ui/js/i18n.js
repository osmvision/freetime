// Languages. The app's code stays in English; this layer watches the page and replaces the text
// it knows (whole strings, or patterns with blanks) with the chosen language. Text it doesn't
// know stays in English. People's own words (messages, names, bios, game titles) are never
// translated, except the built-in idea titles and a few fixed labels shown among them.

import * as FR from './i18n-fr.js';

const LANG_KEY = 'freetime.lang';

/** Where people's own words live: only `zone` entries, idea texts and details apply there. */
const PROTECTED = [
  '.bubble-text', '.chat-row-name', '.chat-row-preview', '.profile-name', '.profile-status', '.profile-bio',
  '.me-name', '.friend .entry-title', '.friend .entry-sub', '.chat-head .entry-title', '.chat-head .entry-sub',
  '.coupon-title', '.coupon-detail', '.leaf-title', '.leaf-detail', '.entry .entry-title', '.friend-tag',
  '.code', '.credits', '.credit', '.chip-tag', '.paths', '.suggest', '[translate="no"]',
  '.book-title', '.mini-ticket.daily strong', '.feed-what:not(.feed-badge)', '.share-title',
].join(', ');
const ATTRIBUTES = ['placeholder', 'title', 'aria-label'];

export function preferredLang() {
  try {
    return localStorage.getItem(LANG_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

export function currentLang() {
  const p = preferredLang();
  if (p === 'en' || p === 'fr') return p;
  return (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** Saves the choice and reloads the page in that language. */
export function setLang(value) {
  try {
    localStorage.setItem(LANG_KEY, value);
  } catch {
    // Not saved: the next start uses the automatic choice.
  }
  location.reload();
}

/** For dates and times. */
export const locale = () => (currentLang() === 'fr' ? 'fr-FR' : 'en-GB');

// ---------------------------------------------------------------- the dictionary

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "{0} owns it too" -> a regex with one capture per blank; {n0} only matches numbers. */
function compile(list) {
  return list.map(([from, to]) => {
    const slots = [];
    const source = from
      .split(/(\{n?\d\})/)
      .map((part) => {
        const m = part.match(/^\{(n?)(\d)\}$/);
        if (!m) return escapeRe(part);
        slots.push(Number(m[2]));
        return m[1] ? '([\\d.,\\s]+)' : '(.+?)';
      })
      .join('');
    return { re: new RegExp(`^${source}$`), slots, to };
  });
}

function build(source) {
  const ideas = {};
  for (const [en, [title, detail]] of Object.entries(source.ideas)) {
    ideas[en] = title;
  }
  // Descriptions: keyed by the English description of the same idea, read from the catalog side.
  return {
    exact: { ...source.exact, ...ideas },
    ideaTitles: ideas,
    ideaDetails: source.ideaDetails ?? {},
    patterns: compile(source.patterns),
    details: compile(source.details),
    joins: compile(source.joins),
    zoneExact: source.zone.exact,
    zonePatterns: compile(source.zone.patterns),
    special: source.special,
  };
}

let dict = null;

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function fill(p, m, translateBlank) {
  const values = {};
  p.slots.forEach((slot, i) => (values[slot] = translateBlank(m[i + 1])));
  return p.to.replace(/\{(\d)\}/g, (_, n) => values[n] ?? '');
}

/** Blanks: names joined with "and", then anything the dictionary knows, else unchanged. */
function blank(s, depth) {
  for (const p of dict.joins) {
    const m = s.match(p.re);
    if (m) return fill(p, m, (x) => x);
  }
  return lookup(s, depth + 1) ?? s;
}

function lookup(s, depth = 0) {
  if (depth > 4 || !s) return null;
  if (Object.hasOwn(dict.exact, s)) return dict.exact[s];
  const lower = s[0].toLowerCase() + s.slice(1);
  if (lower !== s && Object.hasOwn(dict.exact, lower)) return capitalize(dict.exact[lower]);
  for (const [re, fn] of dict.special) {
    const m = s.match(re);
    if (m) return fn(m, (x) => lookup(x, depth + 1) ?? x);
  }
  for (const list of [dict.patterns, dict.details]) {
    for (const p of list) {
      const m = s.match(p.re);
      if (m) return fill(p, m, (x) => blank(x, depth));
      if (lower !== s) {
        const ml = lower.match(p.re);
        if (ml) return capitalize(fill(p, ml, (x) => blank(x, depth)));
      }
    }
  }
  if (s.includes(' · ')) {
    const parts = s.split(' · ');
    const done = parts.map((x) => lookup(x, depth + 1));
    if (done.some((x) => x != null)) return parts.map((x, i) => done[i] ?? x).join(' · ');
  }
  return null;
}

/** In people's own words: only fixed labels, idea texts and game/video details. */
function lookupProtected(s) {
  if (Object.hasOwn(dict.zoneExact, s)) return dict.zoneExact[s];
  if (Object.hasOwn(dict.ideaTitles, s)) return dict.ideaTitles[s];
  if (Object.hasOwn(dict.ideaDetails, s)) return dict.ideaDetails[s];
  for (const p of dict.zonePatterns) {
    const m = s.match(p.re);
    if (m) return fill(p, m, (x) => x);
  }
  const detail = (x) => {
    for (const p of dict.details) {
      const m = x.match(p.re);
      if (m) return fill(p, m, (y) => y);
    }
    return Object.hasOwn(dict.exact, x) && /^(Installed|ready to play|Top seller|On sale|Free to play|YouTube|Backlog: .*)$/.test(x) ? dict.exact[x] : null;
  };
  if (s.includes(' · ')) {
    const parts = s.split(' · ');
    const done = parts.map(detail);
    if (done.some((x) => x != null)) return parts.map((x, i) => done[i] ?? x).join(' · ');
  }
  return detail(s);
}

/** Translates one string (keeps its surrounding spaces). */
export function t(text, isProtected = false) {
  if (!dict || typeof text !== 'string') return text;
  const core = text.trim();
  if (!core) return text;
  const out = isProtected ? lookupProtected(core) : lookup(core);
  if (out == null) return text;
  return text.slice(0, text.indexOf(core)) + out + text.slice(text.indexOf(core) + core.length);
}

// ---------------------------------------------------------------- watching the page

const done = new WeakMap(); // text node -> the text we wrote
const doneAttr = new WeakMap(); // element -> { attr: text we wrote }

function translateText(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest('script, style, textarea, svg')) return;
  if (done.get(node) === node.data) return;
  const out = t(node.data, Boolean(parent.closest(PROTECTED)));
  done.set(node, out);
  if (out !== node.data) node.data = out;
}

function translateAttrs(el) {
  let mine = doneAttr.get(el);
  for (const name of ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (value == null || mine?.[name] === value) continue;
    const out = t(value, false);
    mine ??= {};
    mine[name] = out;
    doneAttr.set(el, mine);
    if (out !== value) el.setAttribute(name, out);
  }
}

function walk(root) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.closest?.('svg')) return;
  translateAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeName === 'svg' || n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n);
    else translateAttrs(n);
  }
}

/** Starts translating the page (no-op in English). */
export function startI18n() {
  const lang = currentLang();
  document.documentElement.lang = lang;
  if (lang !== 'fr') return;
  dict = build(FR);
  walk(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateText(r.target);
      else if (r.type === 'attributes') translateAttrs(r.target);
      else r.addedNodes.forEach(walk);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
}
