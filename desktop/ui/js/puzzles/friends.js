// Friends' times on the games of the day. Opt-in and both ways: switch "Show my times to my
// friends" on, and you see theirs next to yours (friends who share only). Switching off deletes
// what you shared. The rules live in the database (supabase/migrations/*_daily_results.sql).

import { api } from '../api.js';
import { avatar } from '../avatars.js';
import { errText, fill, h, icon, toast } from '../dom.js';

const KEY = 'freetime.daily.share';
const KINDS = [
  ['path', 'Path'],
  ['zones', 'Zones'],
  ['guess', 'Guess'],
  ['problem', 'Problem'],
];

export function sharingOn() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function setSharing(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Not kept: asked again next time.
  }
}

/** Sends one result, if the player shares and is signed in (quietly: offline means not now). */
export async function shareResult(day, kind, secs, score = null) {
  if (!sharingOn()) return;
  try {
    await api.shareDailyResult(day, kind, secs, score);
  } catch {
    // Signed out or offline: the result stays on this device.
  }
}

const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
const shown = (r) => (r.kind === 'guess' ? `${r.score ?? 0}/50` : clock(r.secs));
const better = (a, b) => (a.kind === 'guess' ? (a.score ?? 0) > (b.score ?? 0) : a.secs < b.secs);

/** The panel under the games of the day (nothing when signed out). */
export async function renderFriendsToday(box, view) {
  const status = await api.accountStatus().catch(() => ({ signed_in: false }));
  if (!status.signed_in) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const again = () => renderFriendsToday(box, view);

  // The same switch as High contrast in Settings.
  const toggle = h(
    'button',
    { type: 'button', class: 'mode-choice switch', role: 'switch', 'aria-checked': String(sharingOn()) },
    icon('users'),
    h('span', { class: 'switch-label' }, 'Show my times to my friends'),
    h('span', { class: 'switch-state' }, sharingOn() ? 'On' : 'Off'),
  );
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      if (sharingOn()) {
        await api.stopSharingDaily();
        setSharing(false);
      } else {
        setSharing(true);
        // Today's results so far go too.
        for (const [kind, solve] of Object.entries(view.solved)) await api.shareDailyResult(view.date, kind, solve.secs, solve.score ?? null);
      }
    } catch (e) {
      toast(errText(e), 'error', 5000);
    }
    again();
  });
  const head = h('div', { class: 'friends-today-head' }, h('h3', {}, 'Friends today'), toggle);

  if (!sharingOn()) {
    fill(box, head, h('p', { class: 'hint' }, 'Switch it on to see your times next to your friends’ (only friends who share theirs). Switching off deletes what you shared.'));
    return;
  }
  let rows;
  try {
    rows = await api.friendsDaily(view.date);
  } catch (e) {
    fill(box, head, h('p', { class: 'hint' }, errText(e)));
    return;
  }
  const others = rows.filter((r) => !r.me);
  if (!others.length) {
    fill(box, head, h('p', { class: 'hint' }, 'None of your friends has shared a result today yet.'));
    return;
  }
  // One row per person, one column per game; the best of each column stands out.
  const people = new Map();
  for (const r of rows) {
    if (!people.has(r.user_id)) people.set(r.user_id, { ...r, results: {} });
    people.get(r.user_id).results[r.kind] = r;
  }
  const best = {};
  for (const r of rows) if (!best[r.kind] || better(r, best[r.kind])) best[r.kind] = r;
  fill(
    box,
    head,
    h(
      'table',
      { class: 'friends-today' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', 'aria-label': 'Friend' }), KINDS.map(([, name]) => h('th', { scope: 'col' }, name)))),
      h(
        'tbody',
        {},
        [...people.values()].map((p) =>
          h(
            'tr',
            { class: p.me ? 'me' : '' },
            h('th', { scope: 'row' }, h('span', { class: 'friends-today-who' }, avatar({ icon: p.avatar_icon, color: p.avatar_color, userId: p.user_id }), p.me ? h('span', {}, 'You') : h('span', { translate: 'no' }, p.display_name))),
            KINDS.map(([kind]) => {
              const r = p.results[kind];
              if (!r) return h('td', { class: 'none' }, h('span', { 'aria-label': 'Not played' }, '–'));
              const top = best[kind] === r;
              return h('td', { class: top ? 'best' : '' }, top ? icon('trophy') : null, h('span', { class: 'figures' }, shown(r)));
            }),
          ),
        ),
      ),
    ),
  );
}
