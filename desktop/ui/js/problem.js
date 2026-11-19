// "Report a problem": a short form sent to the freetime team. Works signed out (people who
// can't sign in must be able to say so). The app adds its version, the language and the screen
// the person was on; nothing else about the PC or the account is sent.

import { api } from './api.js';
import { btn, errText, h, icon, toast } from './dom.js';
import { currentLang } from './i18n.js';

const CATEGORIES = [
  ['bug', 'Something doesn’t work'],
  ['account', 'Account or sign-in'],
  ['idea', 'An idea'],
  ['other', 'Something else'],
];
const MIN = 10;
const MAX = 4000;

/** Opens the form. `screen` is where the person was ("discover", "settings"…). */
export function openProblemReport(screen = document.body.dataset.view || 'other') {
  if (document.querySelector('.problem-form')) return;
  const previousFocus = document.activeElement;
  let category = null;

  const categories = h('div', { class: 'reasons', role: 'group', 'aria-label': 'What is it about?' });
  const paint = () =>
    categories.replaceChildren(
      ...CATEGORIES.map(([id, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(category === id), onclick: () => { category = id; paint(); } }, label),
      ),
    );
  paint();

  const count = h('span', { class: 'problem-count', 'aria-live': 'polite' });
  const message = h('textarea', {
    class: 'input problem-message',
    rows: 6,
    maxlength: MAX,
    placeholder: 'What happened? What did you expect instead?',
    'aria-label': 'Describe the problem',
    oninput: () => {
      const n = message.value.trim().length;
      count.textContent = n < MIN ? `${MIN - n} more characters` : `${n} / ${MAX}`;
    },
  });
  message.dispatchEvent(new Event('input'));
  const contact = h('input', {
    class: 'input',
    type: 'text',
    maxlength: 200,
    autocomplete: 'email',
    placeholder: 'Email or Discord, if you’d like an answer (optional)',
    'aria-label': 'How to reach you (optional)',
  });

  const send = btn({
    label: 'Send',
    icon: 'send',
    kind: 'primary',
    onclick: async () => {
      if (!category) return toast('Pick what the problem is about');
      if (message.value.trim().length < MIN) {
        message.focus();
        return toast(`Describe the problem in a few words (at least ${MIN} characters).`);
      }
      send.disabled = true;
      try {
        const id = await api.sendSupportTicket({
          category,
          message: message.value,
          contact: contact.value || null,
          lang: currentLang(),
          screen,
        });
        toast(`Thanks! Your report #${id} reached the freetime team.`, 'ok', 6000);
        close();
      } catch (e) {
        toast(errText(e), 'error', 6000);
        send.disabled = false;
      }
    },
  });

  const card = h(
    'section',
    { class: 'quiz problem-form', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'problem-title' },
    h(
      'div',
      { class: 'coupon-head' },
      h('span', { id: 'problem-title' }, 'Report a problem'),
      h('span', { class: 'quiz-head-end' }, h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close', onclick: close }, icon('x'))),
    ),
    h(
      'div',
      { class: 'problem-body' },
      h('div', { class: 'field' }, h('label', {}, 'What is it about?'), categories),
      h('div', { class: 'field' }, h('label', {}, 'Describe the problem'), message, count),
      h('div', { class: 'field' }, h('label', {}, 'How to reach you'), contact),
      h(
        'p',
        { class: 'hint' },
        'Sent to the freetime team with the app’s version, its language and the screen you were on. Only the team can read it.',
      ),
      h('div', { class: 'row problem-actions' }, send, btn({ label: 'Cancel', kind: 'quiet', onclick: close })),
    ),
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  }

  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  categories.querySelector('button')?.focus();
}
