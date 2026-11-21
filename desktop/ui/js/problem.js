// "Report a problem": a short form sent to the freetime team. Works signed out (people who
// can't sign in must be able to say so). The app adds its version, the language and the screen
// the person was on. Photos are chosen by the person sending the report.

import { api } from './api.js';
import { btn, errText, fill, h, icon, toast } from './dom.js';
import { currentLang } from './i18n.js';
import { MAX_TICKET_PHOTOS, prepareTicketPhoto, ticketPhotoSrc } from './support-photos.js';

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
  const photos = [];
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, hidden: true });
  const thumbs = h('div', { class: 'problem-photos' });
  const photoStatus = h('p', { class: 'hint', role: 'status', hidden: true });
  const submissionError = h('p', { class: 'hint problem-error', role: 'alert', hidden: true });
  const add = btn({ label: 'Add photos', icon: 'folder-open', small: true, onclick: () => file.click() });
  function photoMessage(text) {
    photoStatus.textContent = text;
    photoStatus.hidden = !text;
  }
  function paintPhotos() {
    add.disabled = photos.length >= MAX_TICKET_PHOTOS;
    fill(thumbs, photos.map((image, index) => h('div', { class: 'problem-photo' },
      h('img', { src: ticketPhotoSrc(image), alt: '' }),
      btn({ label: 'Remove photo', icon: 'x', square: true, small: true, onclick: () => {
        photos.splice(index, 1);
        photoMessage('');
        paintPhotos();
        add.focus();
      } }),
    )));
  }

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
      add.disabled = true;
      thumbs.inert = true;
      submissionError.hidden = true;
      try {
        const id = await api.sendSupportTicket({
          category,
          message: message.value,
          contact: contact.value || null,
          lang: currentLang(),
          screen,
          photos,
        });
        toast(`Thanks! Your report #${id} reached the freetime team.`, 'ok', 6000);
        close();
      } catch (e) {
        submissionError.textContent = errText(e);
        submissionError.hidden = false;
        send.disabled = false;
        add.disabled = photos.length >= MAX_TICKET_PHOTOS;
        thumbs.inert = false;
      }
    },
  });
  file.addEventListener('change', async () => {
    const selected = Array.from(file.files);
    file.value = '';
    if (!selected.length) return;
    if (photos.length + selected.length > MAX_TICKET_PHOTOS) {
      photoMessage('You can attach up to 3 photos.');
      return;
    }
    add.disabled = send.disabled = true;
    thumbs.inert = true;
    photoMessage('Preparing photos…');
    try {
      const prepared = [];
      for (const item of selected) prepared.push(await prepareTicketPhoto(item));
      photos.push(...prepared);
      photoMessage('');
    } catch (e) {
      photoMessage(errText(e));
    } finally {
      send.disabled = thumbs.inert = false;
      paintPhotos();
    }
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
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Photos (optional)'),
        h('div', { class: 'row' }, file, add),
        thumbs,
        h('span', { class: 'hint' }, 'Up to 3 photos in JPG, PNG or WebP, 12 MB each.'),
        photoStatus,
      ),
      h(
        'p',
        { class: 'hint' },
        'Sent to the freetime team with the app’s version, its language and the screen you were on. Only the team can read it.',
      ),
      submissionError,
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
