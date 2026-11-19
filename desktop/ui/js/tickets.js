// The admins' Tickets tab: problem reports sent with "Report a problem". Only accounts listed as
// admins in the database get any rows; the tab itself only shows up for them.

import { api } from './api.js';
import { btn, emptyState, errText, fill, h, icon, pageHead, toast } from './dom.js';

const FILTERS = [
  ['open', 'To handle'],
  ['in_progress', 'In progress'],
  ['closed', 'Closed'],
  [null, 'All'],
];
const STATUS = { open: 'To handle', in_progress: 'In progress', closed: 'Closed' };
const CATEGORY = { bug: 'Something doesn’t work', account: 'Account or sign-in', idea: 'An idea', other: 'Something else' };
const SCREEN = { discover: 'Discover', friends: 'Friends', messages: 'Messages', history: 'History', settings: 'Settings', tickets: 'Tickets' };

let filter = 'open';

/** The number of open tickets, for the tab's badge (0 when it can't be read). */
export async function openCount() {
  try {
    return (await api.supportTickets('open')).length;
  } catch {
    return 0;
  }
}

export async function render(root, ctx) {
  const list = h('div', { class: 'tickets', 'aria-live': 'polite' }, h('div', { class: 'ghost', style: 'height:240px' }));
  const tabs = h(
    'div',
    { class: 'seg', role: 'tablist', 'aria-label': 'Tickets' },
    FILTERS.map(([id, label]) =>
      h(
        'button',
        {
          type: 'button',
          class: 'seg-btn',
          role: 'tab',
          'aria-selected': String(filter === id),
          onclick: () => {
            filter = id;
            render(root, ctx);
          },
        },
        label,
      ),
    ),
  );
  fill(
    root,
    pageHead(
      'Tickets',
      'Problems people reported with “Report a problem”. Only admins see this tab.',
      btn({ label: 'Refresh', icon: 'refresh-cw', kind: 'quiet', small: true, onclick: () => render(root, ctx) }),
    ),
    tabs,
    list,
  );

  let tickets;
  try {
    tickets = await api.supportTickets(filter);
  } catch (e) {
    fill(list, emptyState({ icon: 'triangle-alert', title: 'Tickets couldn’t be loaded', text: errText(e) }));
    return;
  }
  ctx?.setTickets?.(filter === 'open' ? tickets.length : undefined);
  if (!tickets.length) {
    fill(list, emptyState({ icon: 'check', title: filter === 'open' ? 'No open tickets' : 'Nothing here', text: 'New reports show up here as soon as they are sent.' }));
    return;
  }
  fill(list, tickets.map((t) => ticketCard(t, () => render(root, ctx))));
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function ticketCard(t, reload) {
  const status = h(
    'select',
    { class: 'input ticket-status', 'aria-label': `Status of ticket ${t.id}` },
    Object.entries(STATUS).map(([id, label]) => h('option', { value: id, selected: t.status === id || null }, label)),
  );
  const note = h('textarea', {
    class: 'input ticket-note',
    rows: 2,
    maxlength: 2000,
    placeholder: 'Note for the other admin (not shown to the person)',
    'aria-label': `Note on ticket ${t.id}`,
  });
  note.value = t.admin_note ?? '';
  const save = btn({
    label: 'Save',
    icon: 'check',
    small: true,
    onclick: async () => {
      save.disabled = true;
      try {
        await api.updateSupportTicket(t.id, status.value, note.value);
        toast(`Ticket #${t.id} saved`, 'ok');
        reload();
      } catch (e) {
        toast(errText(e), 'error', 6000);
        save.disabled = false;
      }
    },
  });

  // Where it came from. Values (version, language) stay as they are; words are translated.
  const parts = [
    t.platform === 'web' ? h('span', {}, 'Web') : t.platform === 'desktop' ? h('span', {}, 'PC') : null,
    t.app_version ? h('span', { translate: 'no' }, t.app_version) : null,
    t.lang ? h('span', { translate: 'no' }, t.lang.toUpperCase()) : null,
    t.screen ? h('span', {}, SCREEN[t.screen] ?? t.screen) : null,
    h('span', {}, t.user_id ? 'Signed in' : 'Not signed in'),
  ].filter(Boolean);
  const meta = parts.flatMap((p, i) => (i ? [' · ', p] : [p]));

  return h(
    'article',
    { class: `ticket ticket-${t.status}` },
    h(
      'div',
      { class: 'ticket-head' },
      h('strong', {}, h('span', { translate: 'no' }, `#${t.id}`), ' · ', h('span', {}, CATEGORY[t.category] ?? t.category)),
      h('span', { class: `status ${t.status === 'closed' ? 'off' : 'on'}` }, STATUS[t.status] ?? t.status),
    ),
    h('div', { class: 'ticket-meta' }, icon('clock'), h('span', { translate: 'no' }, when(t.created_at)), ' · ', ...meta),
    // What the person wrote, as they wrote it.
    h('p', { class: 'ticket-message', translate: 'no' }, t.message),
    t.contact ? h('p', { class: 'ticket-contact' }, icon('message-circle'), h('span', {}, 'Answer at:'), ' ', h('span', { translate: 'no', class: 'ticket-contact-value' }, t.contact)) : null,
    h('div', { class: 'ticket-actions' }, status, note, save),
  );
}
