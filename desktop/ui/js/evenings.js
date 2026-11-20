// Evenings that are easy to organise: one invite with up to two times and up to three things to
// do. Friends answer with a click (which times work, what they'd rather do); the host then settles
// on a time and an activity, which shows up in everyone's app with an optional reminder.
// The rules are checked by the database (supabase/migrations/*_evenings.sql).

import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, errText, fill, h, icon, toast } from './dom.js';
import { GAME_INFO, challenge } from './play/screen.js';
import { invitable, when } from './together.js';
import { t } from './i18n.js';

const MAX_GUESTS = 8;
const REMINDERS_KEY = 'freetime.evening-reminders.v1';
const REMIND_BEFORE_MS = 30 * 60000;

// ---------------------------------------------------------------- helpers

const chosenTime = (e) => (e.status === 'set' ? e.slots[e.chosen_slot] : null);
const chosenActivity = (e) => (e.status === 'set' ? e.activities[e.chosen_activity] : null);
const yesCount = (e, slot) => e.guests.filter((g) => g.slots?.[slot]).length;
const votes = (e, activity) => e.guests.filter((g) => g.activity === activity).length;
const names = (people) => people.map((p) => p.display_name).join(', ');

/** A value for <input type="datetime-local"> (local time). */
function localInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tonight at 21:00, or tomorrow when it's already late. */
function defaultTime(daysLater = 0) {
  const d = new Date();
  d.setHours(21, 0, 0, 0);
  if (d - Date.now() < 60 * 60000) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + daysLater);
  return d;
}

/** The link or action that starts an activity: a Steam game, a freetime game, a video... */
function startButton(a, e, me) {
  const [kind, rest] = a.idea_id.split(':');
  if (kind === 'steam' && /^\d+$/.test(rest)) {
    return btn({ label: 'Launch the game', icon: 'play', small: true, kind: 'primary', onclick: () => api.open(`steam://rungameid/${rest}`).catch((x) => toast(errText(x), 'error')) });
  }
  if (kind === 'yt') return btn({ label: 'Open', icon: 'play', small: true, kind: 'primary', onclick: () => api.open(`https://youtu.be/${rest}`).catch((x) => toast(errText(x), 'error')) });
  if (kind === 'play' && GAME_INFO[rest]) {
    // The host challenges each guest; a guest challenges the host.
    const others = e.mine ? e.guests.filter((g) => !g.me) : [e.host];
    return others.slice(0, 3).map((p) =>
      btn({ label: `Play with ${p.display_name}`, icon: 'swords', small: true, kind: 'primary', onclick: () => challenge(rest, { user_id: p.id, display_name: p.display_name }) }),
    );
  }
  return null;
}

// ---------------------------------------------------------------- reminders (kept on this device)

function reminders() {
  try {
    const v = JSON.parse(localStorage.getItem(REMINDERS_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function saveReminders(v) {
  try {
    localStorage.setItem(REMINDERS_KEY, JSON.stringify(v));
  } catch {
    // Storage unavailable: the reminder just won't be kept.
  }
}

function setReminder(e, on) {
  const all = reminders();
  if (on) {
    const a = chosenActivity(e);
    // The notification is outside the page: freetime's own game names are translated here.
    const title = a.idea_id.startsWith('play:') ? t(a.title) : a.title;
    all[e.id] = { at: chosenTime(e), title, with: names(e.mine ? e.guests : [e.host, ...e.guests.filter((g) => !g.me)]), done: false };
  } else {
    delete all[e.id];
  }
  saveReminders(all);
}

/** Checks every minute for a reminder that's due, while the app is open. */
export function watchReminders() {
  const tick = () => {
    const all = reminders();
    let changed = false;
    for (const [id, r] of Object.entries(all)) {
      const at = new Date(r.at).getTime();
      if (!Number.isFinite(at) || Date.now() > at + 6 * 3600000) {
        delete all[id];
        changed = true;
      } else if (!r.done && Date.now() >= at - REMIND_BEFORE_MS) {
        r.done = true;
        changed = true;
        const body = `${t(when(r.at))} · ${r.with}`;
        api.remind(r.title, body).catch(() => toast(`${r.title} · ${body}`, 'ok', 10000));
      }
    }
    if (changed) saveReminders(all);
  };
  tick();
  setInterval(tick, 60000);
}

// ---------------------------------------------------------------- planning one

/**
 * The "Plan an evening" window. `friends`: accepted friends; `activities`: ideas to start with
 * ({ idea_id, title, category }); `ideas`: more to offer as one-click additions.
 */
export function planEvening({ friends, activities = [], ideas = [], onDone }) {
  const previousFocus = document.activeElement;
  const guests = new Set();
  const picked = activities.slice(0, 3);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();

  const people = h('div', { class: 'invite-people', role: 'group', 'aria-label': 'Friends to invite' });
  const paintPeople = () =>
    fill(
      people,
      friends.map((f) =>
        h(
          'button',
          {
            type: 'button',
            class: 'invite-person',
            'aria-pressed': String(guests.has(f.user_id)),
            onclick: () => {
              if (guests.has(f.user_id)) guests.delete(f.user_id);
              else if (guests.size >= MAX_GUESTS) return toast(`Up to ${MAX_GUESTS} friends`);
              else guests.add(f.user_id);
              paintPeople();
            },
          },
          avatar({ userId: f.user_id, icon: f.avatar_icon, color: f.avatar_color }, 'sm'),
          h('span', { translate: 'no' }, f.display_name),
        ),
      ),
    );
  paintPeople();

  const first = h('input', { class: 'input', type: 'datetime-local', value: localInput(defaultTime()), 'aria-label': 'First time' });
  const second = h('input', { class: 'input', type: 'datetime-local', value: localInput(defaultTime(1)), 'aria-label': 'Second time' });
  const secondRow = h('div', { class: 'evening-time', hidden: true }, second, btn({ label: 'Remove this time', icon: 'x', square: true, small: true, kind: 'quiet', onclick: () => { secondRow.hidden = true; addTime.hidden = false; } }));
  const addTime = btn({ label: 'Add another time', icon: 'plus', small: true, kind: 'quiet', onclick: () => { secondRow.hidden = false; addTime.hidden = true; second.focus(); } });

  const chosen = h('ul', { class: 'evening-picked' });
  const offer = h('div', { class: 'reasons evening-offer', role: 'group', 'aria-label': 'Ideas' });
  const own = h('input', { class: 'input', type: 'text', maxlength: 80, placeholder: 'Your own idea (pizza at mine, a walk…)', 'aria-label': 'Your own idea' });
  const addOwn = () => {
    const title = own.value.trim();
    if (!title) return;
    if (picked.length >= 3) return toast('Up to three things to do');
    picked.push({ idea_id: `custom:${Date.now().toString(36)}`, title, category: 'social' });
    own.value = '';
    paintActivities();
  };
  own.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addOwn();
    }
  });
  const paintActivities = () => {
    fill(
      chosen,
      picked.length
        ? picked.map((a, i) =>
            h(
              'li',
              {},
              h('span', { translate: a.idea_id.startsWith('play:') ? null : 'no' }, a.title),
              btn({ label: `Remove ${a.title}`, icon: 'x', square: true, small: true, kind: 'quiet', onclick: () => { picked.splice(i, 1); paintActivities(); } }),
            ),
          )
        : h('li', { class: 'hint' }, 'Pick up to three things to do below.'),
    );
    const left = ideas.filter((x) => !picked.some((p) => p.idea_id === x.idea_id)).slice(0, 8);
    fill(
      offer,
      left.map((x) =>
        h(
          'button',
          {
            type: 'button',
            disabled: picked.length >= 3,
            onclick: () => {
              picked.push(x);
              paintActivities();
            },
          },
          icon('plus'),
          h('span', { translate: x.idea_id.startsWith('play:') ? null : 'no' }, x.title),
        ),
      ),
    );
  };
  paintActivities();

  const note = h('input', { class: 'input', type: 'text', maxlength: 140, placeholder: 'A note (optional)', 'aria-label': 'Note' });
  const error = h('p', { class: 'hint problem-error', role: 'alert', hidden: true });
  const send = btn({
    label: 'Send the invitation',
    icon: 'send',
    kind: 'primary',
    onclick: async () => {
      const slots = [first.value, secondRow.hidden ? '' : second.value].filter(Boolean).map((v) => new Date(v));
      const problem = !guests.size
        ? 'Pick at least one friend.'
        : !slots.length || slots.some((d) => Number.isNaN(d.getTime()))
          ? 'Pick a time.'
          : slots.some((d) => d < Date.now() - 5 * 60000 || d - Date.now() > 14 * 86400000)
            ? 'Pick times between now and two weeks from now.'
            : slots.length === 2 && slots[0].getTime() === slots[1].getTime()
              ? 'Pick two different times.'
              : !picked.length
                ? 'Pick at least one thing to do.'
                : null;
      error.hidden = !problem;
      error.textContent = problem ?? '';
      if (problem) return;
      send.disabled = true;
      try {
        await api.createEvening({ slots: slots.map((d) => d.toISOString()), activities: picked, note: note.value, guests: [...guests] });
        toast(guests.size === 1 ? 'Invitation sent' : `Invitation sent to ${guests.size} friends`, 'ok');
        close();
        onDone?.();
      } catch (e) {
        error.hidden = false;
        error.textContent = errText(e);
        send.disabled = false;
      }
    },
  });

  const card = h(
    'section',
    { class: 'quiz problem-form evening-form', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'evening-title' },
    h(
      'div',
      { class: 'coupon-head' },
      h('span', { id: 'evening-title' }, 'Plan an evening'),
      h('span', { class: 'quiz-head-end' }, h('button', { type: 'button', class: 'quiz-close', 'aria-label': 'Close', onclick: close }, icon('x'))),
    ),
    h(
      'div',
      { class: 'problem-body' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Who'), friends.length ? people : h('p', { class: 'hint' }, 'Add friends in the Friends tab to invite them.')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'When (one or two times)'), h('div', { class: 'evening-time' }, first), secondRow, addTime),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'What (up to three)'), chosen, offer, h('div', { class: 'row' }, own, btn({ label: 'Add', icon: 'plus', small: true, onclick: addOwn }))),
      note,
      h('p', { class: 'hint' }, 'Your friends say which times work and what they’d rather do. Then you choose.'),
      error,
      h('div', { class: 'row problem-actions' }, send, btn({ label: 'Cancel', kind: 'quiet', onclick: close })),
    ),
  );
  const backdrop = h('div', { class: 'quiz-backdrop', onclick: (e) => e.target === backdrop && close() }, card);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  card.querySelector('.quiz-close').focus();
}

/** Ideas to offer in "Plan an evening": freetime's games, then picks that suit a group. */
export async function eveningIdeas() {
  const games = ['four', 'chess', 'torpedoes'].map((g) => ({ idea_id: `play:${g}`, title: GAME_INFO[g].name, category: 'game' }));
  try {
    const boot = await api.bootstrap();
    const res = await api.suggest({ ...boot.defaults, minutes: 120, with_friends: true, can_go_out: true, budget: 'cheap', categories: boot.categories.map((c) => c.id) }, [], [], []);
    const picks = [res.best, ...res.groups.flatMap((g) => g.items)].filter((c) => c && invitable(c) && c.social !== 'solo');
    return [...games, ...picks.slice(0, 6).map((c) => ({ idea_id: c.id, title: c.title, category: c.category }))];
  } catch {
    return games;
  }
}

// ---------------------------------------------------------------- the list (Friends tab)

/** Renders the evenings you host or were invited to into `box` (with "Plan an evening"). */
export async function eveningsPanel(box, { friends }) {
  let list;
  try {
    list = await api.myEvenings();
  } catch {
    box.replaceChildren();
    return;
  }
  const reload = () => eveningsPanel(box, { friends });
  const plan = btn({
    label: 'Plan an evening',
    icon: 'calendar',
    small: true,
    kind: list.length ? '' : 'primary',
    onclick: async () => planEvening({ friends, ideas: await eveningIdeas(), onDone: reload }),
  });
  fill(
    box,
    h(
      'section',
      { class: 'panel people evenings' },
      h('div', { class: 'evenings-head' }, h('h2', {}, 'Evenings'), plan),
      list.length ? list.map((e) => evening(e, reload)) : h('p', { class: 'hint' }, 'Propose two times and up to three things to do: your friends answer in one click.'),
    ),
  );
}

function evening(e, reload) {
  const act = async (promise, done) => {
    try {
      await promise;
      if (done) toast(done, 'ok');
      reload();
    } catch (x) {
      toast(errText(x), 'error');
    }
  };
  const meAsGuest = e.guests.find((g) => g.me);
  const title = e.mine ? h('span', {}, 'Your evening') : h('span', {}, h('span', { translate: 'no' }, e.host.display_name), ' ', h('span', {}, 'invites you to an evening'));
  const who = h('span', { class: 'entry-sub', translate: 'no' }, names(e.mine ? e.guests : [e.host, ...e.guests.filter((g) => !g.me)]));

  if (e.status === 'cancelled') {
    return h('div', { class: 'evening' }, h('div', { class: 'entry-title' }, title), h('span', { class: 'invite-state cancelled' }, 'cancelled'));
  }

  if (e.status === 'set') {
    const a = chosenActivity(e);
    const at = chosenTime(e);
    const soon = new Date(at) - Date.now() < 60 * 60000;
    const remind = h('input', { type: 'checkbox', checked: Boolean(reminders()[e.id]) });
    remind.addEventListener('change', () => {
      setReminder(e, remind.checked);
      toast(remind.checked ? 'You’ll get a reminder 30 minutes before' : 'Reminder off', 'ok');
    });
    return h(
      'div',
      { class: 'evening set' },
      h('div', { class: 'entry-title' }, title),
      h('div', { class: 'evening-final' }, icon('calendar-check'), h('strong', {}, when(at)), ' · ', h('strong', { translate: a.idea_id.startsWith('play:') ? null : 'no' }, a.title)),
      who,
      h(
        'div',
        { class: 'row evening-actions' },
        h('label', { class: 'check' }, remind, 'Remind me 30 minutes before'),
        soon ? startButton(a, e) : null,
        e.mine ? btn({ label: 'Cancel the evening', kind: 'quiet', small: true, onclick: () => act(api.cancelEvening(e.id), 'Evening cancelled') }) : null,
      ),
    );
  }

  // Open: guests answer, the host chooses.
  // The host's choice starts at the most popular time and activity.
  const best = (n, count) => [...Array(n).keys()].reduce((b, i) => (count(i) > count(b) ? i : b), 0);
  const pick = { slot: best(e.slots.length, (i) => yesCount(e, i)), activity: best(e.activities.length, (i) => votes(e, i)) };
  const answered = e.guests.filter((g) => g.answered).length;
  const times = h(
    'div',
    { class: 'evening-options', role: 'group', 'aria-label': 'Times' },
    e.slots.map((s, i) => {
      const count = h('span', { class: 'evening-count' }, `${yesCount(e, i)}/${e.guests.length}`);
      if (meAsGuest) {
        const mine = Boolean(meAsGuest.slots?.[i]);
        return h(
          'button',
          {
            type: 'button',
            class: 'evening-option',
            'aria-pressed': String(mine),
            title: mine ? 'This time works for you' : 'Click if this time works for you',
            onclick: () => {
              const slots = e.slots.map((_, j) => (j === i ? !mine : Boolean(meAsGuest.slots?.[j])));
              act(api.answerEvening(e.id, slots, meAsGuest.activity), 'Answer saved');
            },
          },
          icon(mine ? 'check' : 'clock'),
          h('span', {}, when(s)),
          count,
        );
      }
      return h('button', { type: 'button', class: 'evening-option', 'aria-pressed': String(pick.slot === i), onclick: () => { pick.slot = i; repaint(); } }, icon('clock'), h('span', {}, when(s)), count);
    }),
  );
  const things = h(
    'div',
    { class: 'evening-options', role: 'group', 'aria-label': 'Things to do' },
    e.activities.map((a, i) => {
      const n = votes(e, i);
      const label = h('span', { translate: a.idea_id.startsWith('play:') ? null : 'no' }, a.title);
      if (meAsGuest) {
        const mine = meAsGuest.activity === i;
        return h(
          'button',
          {
            type: 'button',
            class: 'evening-option',
            'aria-pressed': String(mine),
            title: mine ? 'Your favourite' : 'Click if you’d rather do this',
            onclick: () => act(api.answerEvening(e.id, e.slots.map((_, j) => Boolean(meAsGuest.slots?.[j])), mine ? null : i), 'Answer saved'),
          },
          icon(mine ? 'check' : 'sparkles'),
          label,
          n ? h('span', { class: 'evening-count' }, `${n}`) : null,
        );
      }
      return h('button', { type: 'button', class: 'evening-option', 'aria-pressed': String(pick.activity === i), onclick: () => { pick.activity = i; repaint(); } }, icon('sparkles'), label, n ? h('span', { class: 'evening-count' }, `${n}`) : null);
    }),
  );

  const repaint = () => {
    times.querySelectorAll('.evening-option').forEach((b, i) => b.setAttribute('aria-pressed', String(pick.slot === i)));
    things.querySelectorAll('.evening-option').forEach((b, i) => b.setAttribute('aria-pressed', String(pick.activity === i)));
  };

  return h(
    'div',
    { class: 'evening' },
    h('div', { class: 'entry-title' }, title),
    who,
    e.note ? h('div', { class: 'entry-sub', translate: 'no' }, `“${e.note}”`) : null,
    h('span', { class: 'field-label' }, meAsGuest ? 'Which times work for you?' : 'Times'),
    times,
    h('span', { class: 'field-label' }, meAsGuest ? 'What would you rather do? (optional)' : 'Things to do'),
    things,
    e.mine
      ? h(
          'div',
          { class: 'row evening-actions' },
          h('span', { class: 'hint' }, `${answered}/${e.guests.length} answered`),
          btn({ label: 'Confirm this choice', icon: 'check', small: true, kind: 'primary', onclick: () => act(api.settleEvening(e.id, pick.slot, pick.activity), 'Evening confirmed: your friends can see it') }),
          btn({ label: 'Cancel the evening', kind: 'quiet', small: true, onclick: () => act(api.cancelEvening(e.id), 'Evening cancelled') }),
        )
      : h('p', { class: 'hint' }, meAsGuest?.answered ? 'Your answer is saved. You can change it until the time is chosen.' : 'One click per answer: it’s saved right away.'),
  );
}

// ---------------------------------------------------------------- Discover: coming up

/** One line per evening that's decided (next 24 h) or waiting for your answer. */
export async function comingUp(box, ctx) {
  let list;
  try {
    list = await api.myEvenings();
  } catch {
    box.replaceChildren();
    return;
  }
  const soon = list.filter((e) => e.status === 'set' && new Date(chosenTime(e)) - Date.now() < 24 * 3600000);
  const toAnswer = list.filter((e) => e.status === 'open' && e.guests.some((g) => g.me && !g.answered));
  if (!soon.length && !toAnswer.length) {
    box.replaceChildren();
    return;
  }
  const open = () => ctx.goto('friends', { tab: 'friends' });
  fill(
    box,
    h(
      'div',
      { class: 'coming-up' },
      soon.map((e) => {
        const a = chosenActivity(e);
        return h(
          'div',
          { class: 'strip' },
          icon('calendar-check'),
          h('div', { class: 'strip-text' }, h('strong', {}, when(chosenTime(e)), ' · ', h('span', { translate: a.idea_id.startsWith('play:') ? null : 'no' }, a.title)), h('span', { translate: 'no' }, names(e.mine ? e.guests : [e.host, ...e.guests.filter((g) => !g.me)]))),
          h(
            'div',
            { class: 'strip-actions' },
            // The button to start it shows in the last hour before, as on the Friends tab.
            new Date(chosenTime(e)) - Date.now() < 60 * 60000 ? startButton(a, e) : null,
            btn({ label: 'See the evening', small: true, kind: 'quiet', onclick: open }),
          ),
        );
      }),
      toAnswer.map((e) =>
        h(
          'div',
          { class: 'strip' },
          icon('calendar'),
          h('div', { class: 'strip-text' }, h('strong', {}, h('span', { translate: 'no' }, e.host.display_name), ' ', h('span', {}, 'invites you to an evening')), h('span', {}, 'Say which times work for you: one click.')),
          h('div', { class: 'strip-actions' }, btn({ label: 'Answer', icon: 'check', small: true, kind: 'primary', onclick: open })),
        ),
      ),
    ),
  );
}
