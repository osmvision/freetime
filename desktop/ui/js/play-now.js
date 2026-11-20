// "Shall we play now?": when a friend is free, freetime picks the best game you can play together
// right now. A Steam game you both own goes as an invite (they accept it from the invitation, then
// you both get the button to launch it); without one, a freetime game goes as a challenge.

import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, errText, fill, fmtMinutes, h, icon, toast } from './dom.js';
import { GAME_INFO, challenge } from './play/screen.js';

const KEEP_MS = 5 * 60000;
const SHOWN = 2;
const BUILT_IN = Object.keys(GAME_INFO);

/** Friends this session's "Not now" closed, until they're free again with a new end time. */
const closed = new Map();
/** play_now answers per friend, kept a few minutes: { at, until, view }. */
const cache = new Map();
/** Which pick each card shows (its "Another game" position). */
const turn = new Map();

const minutesLeft = (iso) => Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
const steamLink = (id) => (/^steam:\d+$/.test(id) ? `steam://rungameid/${id.slice(6)}` : null);

/**
 * Renders a card for up to two free friends into `box`. `friends` are accepted friends with their
 * `free_until`; `req` is Discover's context (energy and budget are kept, the time is the friend's).
 */
export async function renderPlayNow(box, friends, req) {
  const free = friends
    .filter((f) => f.free_until && minutesLeft(f.free_until) >= 10 && closed.get(f.user_id) !== f.free_until)
    .sort((a, b) => new Date(b.free_until) - new Date(a.free_until))
    .slice(0, SHOWN);
  if (!free.length) {
    box.replaceChildren();
    return;
  }
  let invites = [];
  try {
    invites = await api.invites();
  } catch {
    // Offline: the cards still show, without the invite's state.
  }
  const cards = await Promise.all(free.map((f) => card(f, req, invites, () => renderPlayNow(box, friends, req))));
  fill(box, h('div', { class: 'play-now-list' }, cards.filter(Boolean)));
}

async function suggestions(f, req) {
  const kept = cache.get(f.user_id);
  if (kept && kept.until === f.free_until && Date.now() - kept.at < KEEP_MS) return kept.view;
  const minutes = Math.min(240, Math.max(15, minutesLeft(f.free_until)));
  const view = await api.playNow({ ...req, minutes }, { id: f.user_id, name: f.display_name });
  cache.set(f.user_id, { at: Date.now(), until: f.free_until, view });
  return view;
}

async function card(f, req, invites, redraw) {
  let view;
  try {
    view = await suggestions(f, req);
  } catch {
    view = { common: 0, picks: [] };
  }
  const name = h('span', { translate: 'no' }, f.display_name);
  const left = minutesLeft(f.free_until);
  // An invite sent in the last hour to this friend for a game: its state replaces the proposal.
  const sent = invites.find(
    (i) => i.direction === 'outgoing' && i.other === f.user_id && i.category === 'game' && ['pending', 'accepted'].includes(i.status) &&
      Date.now() - new Date(i.created_at) < 3600000,
  );
  const head = h(
    'div',
    { class: 'play-now-head' },
    avatar({ userId: f.user_id, icon: f.avatar_icon, color: f.avatar_color }, 'sm'),
    h(
      'div',
      { class: 'play-now-text' },
      h('strong', {}, h('span', { class: 'play-now-ask' }, 'Shall we play now?'), ' ', name, ' ', h('span', {}, `is free for ${fmtMinutes(left)}.`)),
      h('span', { class: 'play-now-sub' }, view.common === 1 ? 'You have 1 game in common.' : view.common > 1 ? `You have ${view.common} games in common.` : 'No Steam game in common: play one of freetime’s games.'),
    ),
    btn({ label: 'Not now', icon: 'x', square: true, small: true, kind: 'quiet', onclick: () => { closed.set(f.user_id, f.free_until); redraw(); } }),
  );

  if (sent) {
    const link = steamLink(sent.idea_id);
    return h(
      'section',
      { class: 'play-now', 'aria-label': 'Shall we play now?' },
      head,
      sent.status === 'accepted'
        ? h(
            'div',
            { class: 'play-now-pick' },
            icon('check'),
            h('span', { class: 'play-now-label' }, h('span', { translate: 'no' }, f.display_name), ' ', h('span', {}, 'accepted:')),
            h('span', { class: 'play-now-title', translate: 'no' }, sent.title),
          )
        : h(
            'div',
            { class: 'play-now-pick' },
            icon('send'),
            h('span', { class: 'play-now-label' }, 'Invite sent:'),
            h('span', { class: 'play-now-title', translate: 'no' }, sent.title),
            h('span', { class: 'play-now-state' }, 'waiting for an answer'),
          ),
      h(
        'div',
        { class: 'row play-now-actions' },
        sent.status === 'accepted' && link ? btn({ label: 'Launch the game', icon: 'play', kind: 'primary', small: true, onclick: () => api.open(link).catch((e) => toast(errText(e), 'error')) }) : null,
        btn({ label: 'Refresh', icon: 'refresh-cw', small: true, kind: 'quiet', onclick: redraw }),
      ),
    );
  }

  const options = [
    ...view.picks.map((c) => ({ kind: 'steam', c })),
    // freetime's own games always work: you both have freetime.
    ...BUILT_IN.map((game) => ({ kind: 'built-in', game })),
  ];
  const i = (turn.get(f.user_id) ?? 0) % options.length;
  const o = options[i];
  const another = btn({ label: 'Another game', icon: 'refresh-cw', small: true, onclick: () => { turn.set(f.user_id, i + 1); redraw(); } });
  if (o.kind === 'steam') {
    const c = o.c;
    const invite = btn({
      label: 'Invite to play',
      icon: 'send',
      kind: 'primary',
      small: true,
      onclick: async () => {
        invite.disabled = true;
        try {
          await api.sendInvites([{ to_user: f.user_id, idea_id: c.id, title: c.title, category: 'game', starts_at: new Date().toISOString(), note: '' }]);
          toast('Invite sent: the game’s button appears here once they accept', 'ok', 4500);
          redraw();
        } catch (e) {
          toast(errText(e), 'error', 6000);
          invite.disabled = false;
        }
      },
    });
    return h(
      'section',
      { class: 'play-now', 'aria-label': 'Shall we play now?' },
      head,
      h(
        'div',
        { class: 'play-now-pick' },
        icon('gamepad-2'),
        h('span', { class: 'play-now-label' }, 'Best choice:'),
        h('span', { class: 'play-now-title', translate: 'no' }, c.title),
        c.reasons?.[0] ? h('span', { class: 'play-now-why' }, c.reasons[0]) : null,
      ),
      h('div', { class: 'row play-now-actions' }, invite, options.length > 1 ? another : null),
    );
  }
  const info = GAME_INFO[o.game];
  return h(
    'section',
    { class: 'play-now', 'aria-label': 'Shall we play now?' },
    head,
    h(
      'div',
      { class: 'play-now-pick' },
      icon(info.icon),
      h('span', { class: 'play-now-label' }, view.picks.length ? 'Or in freetime:' : 'Best choice:'),
      h('span', { class: 'play-now-title' }, info.name),
      h('span', { class: 'play-now-why' }, 'they accept from the invitation, then you play turn by turn'),
    ),
    h(
      'div',
      { class: 'row play-now-actions' },
      btn({ label: 'Challenge them', icon: 'swords', kind: 'primary', small: true, onclick: () => challenge(o.game, f) }),
      another,
    ),
  );
}
