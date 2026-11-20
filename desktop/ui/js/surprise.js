// A surprise for one person: a gift that opens on a bouquet of roses with a ring in the middle,
// then a message. The server only ever sends it to the account it was made for
// (supabase/migrations/*_surprise.sql); it shows once, and is marked seen when it's opened.
// The drawing is built here with SVG elements (no images, nothing fetched); the words come from
// the server and are always shown as plain text.

import { api } from './api.js';
import { h, reducedMotion, wait } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';

/** An SVG element. */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

function gradients() {
  return s(
    'defs',
    {},
    s('linearGradient', { id: 'sp-box', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#c0264b' }), s('stop', { offset: 1, 'stop-color': '#8e1736' })),
    s('linearGradient', { id: 'sp-lid', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#de3a60' }), s('stop', { offset: 1, 'stop-color': '#b01f43' })),
    s('linearGradient', { id: 'sp-ribbon', x1: 0, y1: 0, x2: 1, y2: 0 }, s('stop', { offset: 0, 'stop-color': '#f6d27a' }), s('stop', { offset: 0.5, 'stop-color': '#fff1c4' }), s('stop', { offset: 1, 'stop-color': '#e2b24c' })),
    s('linearGradient', { id: 'sp-gold', x1: 0, y1: 0, x2: 1, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#fff3c2' }), s('stop', { offset: 0.45, 'stop-color': '#e9b949' }), s('stop', { offset: 1, 'stop-color': '#a8741a' })),
    s('linearGradient', { id: 'sp-gem', x1: 0, y1: 0, x2: 1, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#ffffff' }), s('stop', { offset: 0.5, 'stop-color': '#d9f1ff' }), s('stop', { offset: 1, 'stop-color': '#9fd3f5' })),
    s('linearGradient', { id: 'sp-paper', x1: 0, y1: 0, x2: 1, y2: 0 }, s('stop', { offset: 0, 'stop-color': '#f3e3c8' }), s('stop', { offset: 0.5, 'stop-color': '#fbf1df' }), s('stop', { offset: 1, 'stop-color': '#e6cfa8' })),
    s('radialGradient', { id: 'sp-rose', cx: 0.4, cy: 0.35, r: 0.75 }, s('stop', { offset: 0, 'stop-color': '#ff5f7e' }), s('stop', { offset: 0.6, 'stop-color': '#d81f45' }), s('stop', { offset: 1, 'stop-color': '#8c0d2a' })),
    s('radialGradient', { id: 'sp-satin', cx: 0.4, cy: 0.3, r: 0.8 }, s('stop', { offset: 0, 'stop-color': '#ffffff' }), s('stop', { offset: 0.6, 'stop-color': '#ffe1e8' }), s('stop', { offset: 1, 'stop-color': '#f6b7c7' })),
    s('radialGradient', { id: 'sp-glow', cx: 0.5, cy: 0.5, r: 0.5 }, s('stop', { offset: 0, 'stop-color': '#fff6d6', 'stop-opacity': 0.95 }), s('stop', { offset: 1, 'stop-color': '#fff6d6', 'stop-opacity': 0 })),
  );
}

/** One rose seen from above: a round head with petals curling in. */
function rose(x, y, r, delay) {
  // The position stays on the outer group: the animation (on the inner one) would replace it.
  return s(
    'g',
    { transform: `translate(${x} ${y})` },
    s(
      'g',
      { class: 'sp-rose', style: `--d:${delay}s` },
      // Outer petals, a little darker, peeking out around the head.
      [0, 72, 144, 216, 288].map((a) =>
        s('ellipse', { cx: 0, cy: -r * 0.62, rx: r * 0.55, ry: r * 0.5, fill: '#b3123a', transform: `rotate(${a})` }),
      ),
      s('circle', { r: r * 0.92, fill: 'url(#sp-rose)' }),
      // The petals curling in: a spiral, as on a rose seen from above.
      s('path', { d: spiral(r * 0.16), fill: 'none', stroke: '#7a0a24', 'stroke-width': Math.max(1.3, r * 0.08), 'stroke-linecap': 'round', opacity: 0.75 }),
      s('circle', { cx: -r * 0.32, cy: -r * 0.38, r: r * 0.16, fill: '#ff8fa5', opacity: 0.55 }),
    ),
  );
}

/** A spiral of three turns growing outwards, `k` setting its size. */
function spiral(k) {
  const f = (n) => n.toFixed(2);
  return [
    `M 0 0`,
    `a ${f(k)} ${f(k)} 0 1 1 ${f(k * 1.6)} ${f(k * 0.4)}`,
    `a ${f(k * 2.2)} ${f(k * 2.2)} 0 1 1 ${f(-k * 3.6)} ${f(-k * 0.9)}`,
    `a ${f(k * 3.4)} ${f(k * 3.4)} 0 1 1 ${f(k * 5.4)} ${f(k * 1.4)}`,
  ].join(' ');
}

function leaf(x, y, angle, size = 1) {
  return s('path', {
    d: 'M 0 0 Q 14 -10 30 0 Q 14 10 0 0 Z',
    transform: `translate(${x} ${y}) rotate(${angle}) scale(${size})`,
    fill: '#2f8a4c',
    stroke: '#1f6436',
    'stroke-width': 1,
  });
}

/** A four-point twinkle. */
function sparkle(x, y, size, delay) {
  return s('path', {
    class: 'sp-sparkle',
    d: `M ${x} ${y - size} Q ${x} ${y} ${x + size} ${y} Q ${x} ${y} ${x} ${y + size} Q ${x} ${y} ${x - size} ${y} Q ${x} ${y} ${x} ${y - size} Z`,
    fill: '#fffbe8',
    style: `--d:${delay}s`,
  });
}

/** The bouquet: paper cone, leaves, a crown of roses, and the ring in the middle. */
function bouquet() {
  const cx = 150;
  const cy = 128;
  const ring = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 - Math.PI / 2;
    ring.push(rose(cx + Math.cos(a) * 46, cy + Math.sin(a) * 40, 19, 0.05 * i));
  }
  const outer = [
    [cx - 78, cy + 8, 15],
    [cx + 78, cy + 8, 15],
    [cx - 60, cy - 42, 14],
    [cx + 60, cy - 42, 14],
    [cx, cy - 78, 15],
  ].map(([x, y, r], i) => rose(x, y, r, 0.5 + 0.06 * i));
  return s(
    'g',
    { class: 'sp-bouquet' },
    // Stems and paper.
    s('path', { d: 'M 96 170 L 150 300 L 204 170 Z', fill: 'url(#sp-paper)', stroke: '#cfae7c', 'stroke-width': 1.5 }),
    s('path', { d: 'M 150 300 L 132 182 M 150 300 L 168 182', stroke: '#d8bd91', 'stroke-width': 1.2 }),
    leaf(86, 150, 200, 1.1),
    leaf(214, 150, -20, 1.1),
    leaf(92, 108, 220),
    leaf(208, 108, -40),
    leaf(122, 58, 250, 0.9),
    leaf(178, 58, -70, 0.9),
    outer,
    ring,
    // A small satin heart in the middle, a soft light, then the ring resting on the heart.
    s('path', {
      d: `M ${cx} ${cy + 30} C ${cx - 36} ${cy + 8} ${cx - 30} ${cy - 26} ${cx} ${cy - 10} C ${cx + 30} ${cy - 26} ${cx + 36} ${cy + 8} ${cx} ${cy + 30} Z`,
      fill: 'url(#sp-satin)',
      stroke: '#f3b8c6',
      'stroke-width': 1,
    }),
    s('circle', { class: 'sp-glow', cx, cy: cy - 4, r: 30, fill: 'url(#sp-glow)' }),
    s(
      'g',
      { class: 'sp-ring' },
      s('ellipse', { cx, cy: cy + 8, rx: 15, ry: 15, fill: 'none', stroke: 'url(#sp-gold)', 'stroke-width': 5 }),
      s('ellipse', { cx, cy: cy + 8, rx: 15, ry: 15, fill: 'none', stroke: '#fff7d1', 'stroke-width': 1, opacity: 0.6, 'stroke-dasharray': '12 80' }),
      s('path', { d: `M ${cx - 6} ${cy - 7} L ${cx + 6} ${cy - 7} L ${cx + 4} ${cy - 3} L ${cx - 4} ${cy - 3} Z`, fill: 'url(#sp-gold)' }),
      s('path', { class: 'sp-gem', d: `M ${cx - 9} ${cy - 15} L ${cx - 5} ${cy - 20} L ${cx + 5} ${cy - 20} L ${cx + 9} ${cy - 15} L ${cx} ${cy - 6} Z`, fill: 'url(#sp-gem)', stroke: '#7fb8dc', 'stroke-width': 0.8 }),
      s('path', { d: `M ${cx - 9} ${cy - 15} L ${cx + 9} ${cy - 15} M ${cx - 5} ${cy - 20} L ${cx - 2} ${cy - 15} L ${cx} ${cy - 6} L ${cx + 2} ${cy - 15} L ${cx + 5} ${cy - 20}`, fill: 'none', stroke: '#ffffff', 'stroke-width': 0.7, opacity: 0.9 }),
    ),
    sparkle(cx - 22, cy - 22, 6, 0),
    sparkle(cx + 24, cy - 14, 4.5, 0.6),
    sparkle(cx + 14, cy + 26, 3.5, 1.1),
    sparkle(cx - 26, cy + 14, 3, 1.5),
  );
}

/** The gift box: base, ribbon, and a lid with a bow that flies off. */
function giftBox() {
  return [
    s(
      'g',
      { class: 'sp-box' },
      s('rect', { x: 88, y: 232, width: 124, height: 96, rx: 6, fill: 'url(#sp-box)' }),
      s('rect', { x: 141, y: 232, width: 18, height: 96, fill: 'url(#sp-ribbon)' }),
      s('rect', { x: 88, y: 232, width: 124, height: 10, fill: '#000', opacity: 0.18 }),
    ),
    s(
      'g',
      { class: 'sp-lid' },
      s('rect', { x: 80, y: 208, width: 140, height: 28, rx: 5, fill: 'url(#sp-lid)' }),
      s('rect', { x: 141, y: 208, width: 18, height: 28, fill: 'url(#sp-ribbon)' }),
      s('path', { d: 'M 150 206 C 120 176 104 196 124 208 Z', fill: 'url(#sp-ribbon)', stroke: '#c9973a', 'stroke-width': 1.2 }),
      s('path', { d: 'M 150 206 C 180 176 196 196 176 208 Z', fill: 'url(#sp-ribbon)', stroke: '#c9973a', 'stroke-width': 1.2 }),
      s('circle', { cx: 150, cy: 206, r: 7, fill: '#f0c25f', stroke: '#c9973a', 'stroke-width': 1.2 }),
    ),
  ];
}

/** Falling petals, once the gift is open. */
function petals() {
  return Array.from({ length: 14 }, (_, i) =>
    h('span', { class: 'sp-petal', style: `--x:${(i * 37) % 100}%;--d:${(i % 7) * 0.45}s;--t:${5 + (i % 4)}s;--r:${(i * 53) % 360}deg` }),
  );
}

/**
 * Shows the surprise `{ id, title, message }` over the app. Resolves once it's closed.
 * `preview: true` shows it without telling the server it was seen.
 */
export function showSurprise(surprise, { preview = false } = {}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    let opened = false;
    const art = s('svg', { class: 'sp-art', viewBox: '0 0 300 340', role: 'img', 'aria-label': 'A gift box' }, gradients(), bouquet(), giftBox());
    const words = h(
      'div',
      { class: 'sp-words', 'aria-live': 'polite' },
      // Both are optional: without words, the gift speaks for itself.
      surprise.title ? h('h2', { class: 'sp-title', translate: 'no' }, surprise.title) : null,
      surprise.message ? h('p', { class: 'sp-message', translate: 'no' }, surprise.message) : null,
    );
    const close = () => {
      backdrop.classList.add('sp-leaving');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => backdrop.remove(), reducedMotion() ? 0 : 400);
      previousFocus?.focus?.();
      resolve();
    };
    const closeBtn = h('button', { type: 'button', class: 'btn primary sp-close', onclick: close }, '❤');
    closeBtn.setAttribute('aria-label', 'Close');
    const open = async () => {
      if (opened) return;
      opened = true;
      if (!preview) api.surpriseSeen(surprise.id).catch(() => {});
      stage.classList.add('sp-open');
      art.setAttribute('aria-label', 'A bouquet of roses with a ring in the middle');
      openBtn.remove();
      if (!reducedMotion()) await wait(1900);
      stage.classList.add('sp-done');
      closeBtn.focus();
    };
    const openBtn = h('button', { type: 'button', class: 'btn primary sp-open-btn', onclick: open }, 'Open your gift');
    const stage = h(
      'section',
      { class: 'sp-stage', role: 'dialog', 'aria-modal': 'true', 'aria-label': surprise.title || 'A surprise' },
      h('button', { type: 'button', class: 'sp-gift', 'aria-label': 'Open your gift', onclick: open }, art),
      openBtn,
      words,
      h('div', { class: 'sp-actions' }, closeBtn),
    );
    const onKey = (e) => {
      if (e.key === 'Escape' && opened) close();
    };
    const backdrop = h('div', { class: 'sp-backdrop' }, h('div', { class: 'sp-petals', 'aria-hidden': 'true' }, petals()), stage);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    openBtn.focus();
  });
}

/** At start: if a surprise is waiting for this account, show it (once). */
export async function checkSurprise() {
  let surprise = null;
  try {
    surprise = await api.mySurprise();
  } catch {
    return; // Signed out or offline: nothing to show.
  }
  if (surprise) await showSurprise(surprise);
}
