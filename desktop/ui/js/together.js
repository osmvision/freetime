// Doing things together: who's free right now, "I'm free", and inviting friends to a pick.
// Everything here needs the online account; signed out, nothing is shown and nothing is sent.

import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, errText, fill, fmtMinutes, h, icon, toast } from './dom.js';
import { locale } from './i18n.js';

/** "21:30" in the user's language. */
export const clock = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

/** "today 21:00", "tomorrow 09:00" or "Friday 21:00". */
export function when(iso) {
  const d = new Date(iso);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  const label = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : d.toLocaleDateString(locale(), { weekday: 'long' });
  return `${label} ${clock(iso)}`;
}

/** Ids freetime can send: "steam:570", "idea:run-5k", "yt:abc" (not search links). */
export const invitable = (c) => /^[a-z]+:[A-Za-z0-9_.-]+$/.test(c.id ?? '') && c.id.length <= 80;

// ---------------------------------------------------------------- the "free now" strip

/**
 * Renders who's free and the "I'm free" button into `box`. `minutes()` gives the free time
 * picked on Discover. Returns { refresh, friends } so the caller can update it and reuse the list.
 */
export function freeStrip(box, minutes, onFriendsChanged = () => {}) {
  let mine = null;
  let friends = [];
  let known = 0;
  const changed = () => {
    if (friends.length !== known) {
      known = friends.length;
      onFriendsChanged(known);
    }
  };

  async function refresh() {
    let status;
    try {
      status = await api.accountStatus();
    } catch {
      status = { signed_in: false };
    }
    if (!status.signed_in) {
      box.replaceChildren();
      friends = [];
      return;
    }
    try {
      const [social, acc] = await Promise.all([api.socialOverview(), api.account()]);
      friends = social.friends.filter((f) => f.state === 'friend');
      mine = acc.profile.free_until && new Date(acc.profile.free_until) > new Date() ? acc.profile.free_until : null;
      draw();
      changed();
    } catch {
      // Offline or session ended: hide the strip rather than show an error on Discover.
      box.replaceChildren();
    }
  }

  function draw() {
    const free = friends.filter((f) => f.free_until && new Date(f.free_until) > new Date());
    const toggle = mine
      ? btn({
          label: `Free until ${clock(mine)} · Stop`,
          icon: 'check',
          small: true,
          onclick: () => set(0),
        })
      : btn({ label: `I’m free for ${fmtMinutes(minutes())}`, icon: 'zap', small: true, kind: 'primary', onclick: () => set(minutes()) });
    fill(
      box,
      h(
        'div',
        { class: 'free-strip' },
        icon('users'),
        free.length
          ? h(
              'div',
              { class: 'free-list' },
              h('span', { class: 'free-label' }, 'Free now'),
              free.map((f) => h('span', { class: 'free-friend', title: `Free until ${clock(f.free_until)}` }, avatar({ icon: f.avatar_icon, color: f.avatar_color }, 'sm'), h('span', { class: 'free-name', translate: 'no' }, f.display_name), h('span', { class: 'free-until' }, `until ${clock(f.free_until)}`))),
            )
          : h('span', { class: 'free-none' }, friends.length ? 'No friends are free right now.' : 'Add friends to see who’s free.'),
        toggle,
      ),
    );
  }

  async function set(m) {
    try {
      mine = await api.setFree(m);
      toast(mine ? `Your friends can see you’re free until ${clock(mine)}` : 'You’re no longer shown as free', 'ok');
      draw();
    } catch (e) {
      toast(errText(e), 'error');
    }
  }

  return { refresh, friends: () => friends };
}

// ---------------------------------------------------------------- inviting friends to a pick

/** The invite panel for a pick `c`. `friends` are accepted friends (free ones listed first). */
export function invitePanel(c, friends, onDone) {
  const chosen = new Set();
  const sorted = [...friends].sort((a, b) => Number(Boolean(b.free_until)) - Number(Boolean(a.free_until)) || a.display_name.localeCompare(b.display_name));
  const people = h('div', { class: 'invite-people', role: 'group', 'aria-label': 'Friends to invite' });
  const paintPeople = () =>
    fill(
      people,
      sorted.map((f) =>
        h(
          'button',
          {
            type: 'button',
            class: 'invite-person',
            'aria-pressed': String(chosen.has(f.user_id)),
            onclick: () => {
              if (chosen.has(f.user_id)) chosen.delete(f.user_id);
              else chosen.add(f.user_id);
              paintPeople();
            },
          },
          avatar({ icon: f.avatar_icon, color: f.avatar_color }, 'sm'),
          h('span', { translate: 'no' }, f.display_name),
          f.free_until ? h('span', { class: 'free-dot', title: `Free until ${clock(f.free_until)}` }) : null,
        ),
      ),
    );
  paintPeople();

  const groupPicker = h('select', { class: 'input', 'aria-label': 'Select friends from a group', hidden: true });
  if (sorted.length) {
    const accepted = new Set(sorted.map((f) => f.user_id));
    api.friendGroups().then((groups) => {
      const available = groups.map((group) => ({
        ...group, friends: group.members.map((member) => member.user_id).filter((id) => accepted.has(id)),
      })).filter((group) => group.friends.length);
      if (!available.length) return;
      fill(groupPicker, h('option', { value: '' }, 'Select friends from a group'),
        available.map((group) => h('option', { value: group.conversation_id, translate: 'no' }, group.name)));
      groupPicker.hidden = false;
      groupPicker.addEventListener('change', () => {
        const group = available.find((item) => item.conversation_id === groupPicker.value);
        for (const id of group?.friends ?? []) chosen.add(id);
        groupPicker.value = '';
        paintPeople();
      });
    }).catch(() => {});
  }

  const now = new Date();
  const tonight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 21, 0);
  const times = [
    ['Now', 0],
    ['In 30 min', 30],
    ['In 1 h', 60],
    ['In 2 h', 120],
    ...(tonight - now > 150 * 60000 ? [['Tonight 21:00', Math.round((tonight - now) / 60000)]] : []),
  ];
  let offset = 0;
  const timeBox = h('div', { class: 'reasons', role: 'group', 'aria-label': 'When' });
  const paintTimes = () =>
    fill(timeBox, times.map(([label, m]) => h('button', { type: 'button', 'aria-pressed': String(offset === m), onclick: () => { offset = m; paintTimes(); } }, label)));
  paintTimes();
  const note = h('input', { class: 'input', type: 'text', maxlength: 140, placeholder: 'A note (optional)', 'aria-label': 'Note' });

  const send = btn({
    label: 'Send invite',
    icon: 'send',
    kind: 'primary',
    small: true,
    onclick: async () => {
      if (!chosen.size) return toast('Pick at least one friend');
      send.disabled = true;
      const startsAt = new Date(Date.now() + offset * 60000).toISOString();
      try {
        const n = await api.sendInvites([...chosen].map((to) => ({ to_user: to, idea_id: c.id, title: c.title, category: c.category, starts_at: startsAt, note: note.value })));
        toast(n === 1 ? 'Invite sent' : `${n} invites sent`, 'ok');
        onDone?.();
      } catch (e) {
        toast(errText(e), 'error', 6000);
        send.disabled = false;
      }
    },
  });

  return h(
    'div',
    { class: 'invite-panel' },
    h('strong', {}, 'Invite friends to this'),
    groupPicker,
    sorted.length ? people : h('p', { class: 'hint' }, 'Add friends in the Friends tab to invite them.'),
    h('span', { class: 'field-label' }, 'When'),
    timeBox,
    note,
    h('div', { class: 'row' }, send, btn({ label: 'Cancel', kind: 'quiet', small: true, onclick: () => onDone?.() })),
  );
}

// ---------------------------------------------------------------- the invites list (Friends tab)

const linkFor = (id) => {
  const [kind, rest] = id.split(':');
  if (kind === 'steam' && /^\d+$/.test(rest)) return `steam://rungameid/${rest}`;
  if (kind === 'yt') return `https://youtu.be/${rest}`;
  return null;
};

/** Renders the invites panel (incoming and outgoing) into `box`; hides it when there are none. */
export async function invitesPanel(box, ctx, inviteId) {
  let list;
  try {
    list = await api.invites();
  } catch {
    box.replaceChildren();
    return;
  }
  const visible = list.filter((i) => !(i.status === 'cancelled' && i.direction === 'incoming'));
  ctx?.setInvites?.(list.filter((i) => i.direction === 'incoming' && i.status === 'pending').length);
  if (!visible.length) {
    box.replaceChildren();
    return;
  }
  const reload = () => invitesPanel(box, ctx);
  const act = async (promise, done) => {
    try {
      await promise;
      toast(done, 'ok');
      reload();
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  const statusText = { pending: 'waiting', accepted: 'accepted', declined: 'declined', cancelled: 'cancelled' };
  fill(
    box,
    h(
      'section',
      { class: 'panel people' },
      h('h2', {}, 'Invites'),
      visible.map((i) => {
        const incoming = i.direction === 'incoming';
        const link = linkFor(i.idea_id);
        const actions = incoming
          ? i.status === 'pending'
            ? [
                btn({ label: 'I’m in', icon: 'check', small: true, kind: 'primary', onclick: () => act(api.answerInvite(i.id, true), `See you ${when(i.starts_at)}`) }),
                btn({ label: 'Can’t make it', kind: 'quiet', small: true, onclick: () => act(api.answerInvite(i.id, false), 'Invite declined') }),
              ]
            : [
                h('span', { class: `invite-state ${i.status}` }, i.status === 'accepted' ? 'You’re in' : statusText[i.status]),
                i.status === 'accepted' && link ? btn({ label: 'Open', icon: 'play', small: true, onclick: () => api.open(link).catch((e) => toast(errText(e), 'error')) }) : null,
              ]
          : [
              h('span', { class: `invite-state ${i.status}` }, statusText[i.status]),
              i.status === 'pending' || i.status === 'accepted' ? btn({ label: 'Cancel', kind: 'quiet', small: true, onclick: () => act(api.cancelInvite(i.id), 'Invite cancelled') }) : null,
            ];
        return h(
          'div',
          { class: 'invite-row', id: `pick-invite-${i.id}`, tabindex: -1 },
          avatar({ icon: i.other_icon, color: i.other_color }),
          h(
            'div',
            { class: 'entry-main' },
            h('div', { class: 'entry-title' }, incoming ? `${i.other_name} invites you` : `You invited ${i.other_name}`),
            h('div', { class: 'invite-what' }, h('span', { class: 'invite-title', translate: 'no' }, i.title), ` · ${when(i.starts_at)}`),
            i.note ? h('div', { class: 'entry-sub', translate: 'no' }, `“${i.note}”`) : null,
          ),
          h('div', { class: 'person-actions' }, actions),
        );
      }),
    ),
  );
  if (inviteId && box.isConnected && !box.closest('[hidden]')) {
    document.getElementById(`pick-invite-${inviteId}`)?.focus();
  }
}
