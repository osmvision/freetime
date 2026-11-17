// Small DOM helpers shared by every view.
// Text always goes in as text nodes, never as HTML, so titles from Steam or YouTube can't inject markup.

export const CAT_COLORS = {
  game: '#8b5cf6',
  video: '#ef4444',
  sport: '#22c55e',
  learn: '#3b82f6',
  create: '#ec4899',
  chill: '#14b8a6',
  social: '#f59e0b',
  food: '#f97316',
};

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

export const catVars = (category) => ({ '--c': CAT_COLORS[category] ?? '#7c5cff' });

export function fmtMinutes(m) {
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hours}h${String(rest).padStart(2, '0')}` : `${hours}h`;
}

export const errText = (e) => (typeof e === 'string' ? e : (e?.message ?? String(e)));
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function toast(text, kind = 'info', ms = 3400) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}` }, text);
  box.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

export function pageHead(title, subtitle, aside = null) {
  return h(
    'header',
    { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null),
    aside,
  );
}

export function emptyState({ emoji, title, text, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-emoji' }, emoji),
    h('h2', {}, title),
    text ? h('p', {}, text) : null,
    action ?? null,
  );
}

/** What the "open" button of an idea should say. */
export function linkLabel(item) {
  const link = item.link ?? '';
  if (link.startsWith('steam://')) return '▶ Launch in Steam';
  if (link.includes('youtu.be/')) return '▶ Watch on YouTube';
  if (link.includes('youtube.com/results')) return '🔎 Search YouTube';
  if (link.includes('store.steampowered.com')) return '🛒 View on Steam';
  return '↗ Open link';
}

// ---------------------------------------------------------------- modal

let current = null;

export function openModal(children) {
  closeModal(false);
  const panel = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  const backdrop = h('div', {
    class: 'modal-backdrop',
    onmousedown: (e) => {
      if (e.target === backdrop) closeModal();
    },
  });
  backdrop.append(panel);
  current = { backdrop, panel, focus: document.activeElement };
  document.body.append(backdrop);
  return setModal(children);
}

/** Replaces the content of the open modal (or opens one). */
export function setModal(children) {
  if (!current) return openModal(children);
  current.panel.replaceChildren();
  append(current.panel, children);
  const first = current.panel.querySelector('button.primary') ?? current.panel.querySelector('button');
  first?.focus({ preventScroll: true });
  return current.panel;
}

export function closeModal(restoreFocus = true) {
  if (!current) return;
  const { backdrop, focus } = current;
  current = null;
  backdrop.classList.add('leaving');
  setTimeout(() => backdrop.remove(), 160);
  if (restoreFocus) focus?.focus?.({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/** A little burst of emoji, for when you commit to something. */
export function confetti(emoji) {
  if (reducedMotion()) return;
  const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  const symbols = [emoji, '✨', '🎉', '⭐', emoji, '💫'];
  const count = 20;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.3;
    const dist = 110 + Math.random() * 150;
    layer.append(
      h(
        'span',
        {
          vars: {
            '--dx': `${Math.round(Math.cos(angle) * dist)}px`,
            '--dy': `${Math.round(Math.sin(angle) * dist - 40)}px`,
            '--rot': `${Math.round(Math.random() * 360 - 180)}deg`,
            '--delay': `${Math.round(Math.random() * 90)}ms`,
          },
        },
        symbols[i % symbols.length],
      ),
    );
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1600);
}
