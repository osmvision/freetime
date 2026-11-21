// The window every game and puzzle opens in: a navy coupon head (icon, name, then who or which
// number in figures), a status line, the play area, the rule, and the buttons. Escape, the close
// button and a click outside close it; focus goes back where it was.

import { h, icon } from './dom.js';

/**
 * Opens a game window. `head`: what follows the name (a node or text, e.g. "vs Sam" or "#6");
 * `actions`: extra buttons before the close button; `onClose` runs once it's closed.
 * Returns { card, status, area, tools, close, isOpen }.
 */
export function gameWindow({ name, label = name, iconName, head = null, rule = null, className = '', actions = [], onClose = null }) {
  const previousFocus = document.activeElement;
  const status = h('div', { class: 'game-status', 'aria-live': 'polite' });
  const area = h('div', { class: 'game-area' });
  const tools = h('div', { class: 'game-tools' });
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const closeBtn = h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close', onclick: close }, icon('x'));
  const card = h(
    'section',
    { class: `quiz game-window ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
    h(
      'div',
      { class: 'coupon-head' },
      h('span', { class: 'game-title' }, icon(iconName), h('span', {}, name), head ? h('span', { class: 'game-vs' }, head) : null),
      h('span', { class: 'game-head-actions' }, actions, closeBtn),
    ),
    h('div', { class: 'quiz-body game-body' }, status, area, rule ? h('p', { class: 'game-rule' }, rule) : null, tools),
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  closeBtn.focus();
  return { card, status, area, tools, close, isOpen: () => open };
}
