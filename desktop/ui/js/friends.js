// Friends: online friends (signed in, added by friend tag) first; friend codes, which need no
// account and no server, folded away below.

import { api } from './api.js';
import { invitesPanel } from './together.js';
import { AVATAR_COLORS, AVATAR_ICONS, avatar } from './avatars.js';
import { btn, emptyState, errText, fill, h, icon, pageHead, toast } from './dom.js';
import { openCard, renderRanked } from './ranked.js';
import { renderFeed } from './feed.js';

let tab = 'feed';

/** "Friends" or "Ranking". */
function tabs(root, ctx) {
  return h(
    'div',
    { class: 'seg', role: 'tablist', 'aria-label': 'Friends' },
    [
      ['feed', 'Feed', 'sparkles'],
      ['friends', 'Friends', 'users'],
      ['ranked', 'Ranking', 'trophy'],
    ].map(([id, label, name]) =>
      h('button', { type: 'button', role: 'tab', class: 'seg-btn', 'aria-selected': String(tab === id), onclick: () => { if (tab !== id) { tab = id; render(root, ctx); } } }, icon(name), label),
    ),
  );
}

export async function render(root, ctx, { tab: wanted } = {}) {
  if (wanted) tab = wanted;
  const head = () =>
    tab === 'ranked'
      ? pageHead('Ranking', 'Earn points by doing things, climb a tier each month, and see who’s on top.', tabs(root, ctx))
      : tab === 'feed'
        ? pageHead('Feed', 'What you and your friends did lately. React with a tap.', tabs(root, ctx))
        : pageHead('Friends', 'Add friends by their tag, answer requests, and message them.', tabs(root, ctx));
  if (tab === 'ranked' || tab === 'feed') {
    const box = h('div');
    root.replaceChildren(head(), box);
    const status = await api.accountStatus().catch(() => ({ signed_in: false }));
    if (status.signed_in) return tab === 'feed' ? renderFeed(box, ctx) : renderRanked(box, ctx);
    return fill(
      box,
      h(
        'div',
        { class: 'strip' },
        icon('trophy'),
        tab === 'feed'
          ? h('div', { class: 'strip-text' }, h('strong', {}, 'Sign in to see what your friends are up to'), h('span', {}, 'Optional: your profile lives in Settings.'))
          : h('div', { class: 'strip-text' }, h('strong', {}, 'Sign in to join the ranking'), h('span', {}, 'Your points stay on this PC until you sign in.')),
        btn({ label: 'Go to profile', icon: 'log-in', small: true, onclick: () => ctx.goto('settings', { focus: 'profile' }) }),
      ),
    );
  }
  root.replaceChildren(head(), h('div', { class: 'ghost', style: 'height:300px' }));
  let status;
  let mine;
  let codeFriends;
  try {
    [status, mine, codeFriends] = await Promise.all([api.accountStatus().catch(() => ({ signed_in: false })), api.myFriendCode(), api.friends()]);
  } catch (e) {
    root.replaceChildren(head(), emptyState({ icon: 'triangle-alert', title: 'Could not load your friends', text: errText(e) }));
    return;
  }
  const online = h('div', { class: 'online-friends' });
  const codes = h(
    'details',
    { class: 'codes' },
    h('summary', {}, icon('ticket'), h('span', { class: 'codes-title' }, 'Pick together without an account'), h('span', { class: 'hint' }, 'friend codes · no server')),
    h('p', { class: 'section-desc' }, 'Swap codes over Discord or anywhere, then choose “With friends” on Discover to find games you both own.'),
    h('div', { class: 'friends-grid' }, myCodePanel(mine, ctx), addPanel(root, ctx)),
    friendsList(root, ctx, codeFriends),
  );
  root.replaceChildren(head(), online, codes);
  if (status.signed_in) {
    onlineSection(online, ctx);
  } else {
    codes.open = true;
    fill(
      online,
      h(
        'div',
        { class: 'strip' },
        icon('user'),
        h('div', { class: 'strip-text' }, h('strong', {}, 'Sign in to add friends and message them'), h('span', {}, 'Optional: your profile lives in Settings.')),
        btn({ label: 'Go to profile', icon: 'log-in', small: true, onclick: () => ctx.goto('settings', { focus: 'profile' }) }),
      ),
    );
  }
}

// ---------------------------------------------------------------- online friends

async function onlineSection(box, ctx) {
  fill(box, h('div', { class: 'ghost', style: 'height:200px;margin-bottom:18px' }));
  let data;
  try {
    data = await api.socialOverview();
  } catch (e) {
    fill(box, h('div', { class: 'strip' }, icon('triangle-alert'), h('div', { class: 'strip-text' }, h('strong', {}, 'Could not load your friends'), h('span', {}, errText(e))), btn({ label: 'Try again', small: true, onclick: () => onlineSection(box, ctx) })));
    return;
  }
  ctx.setUnread?.(data.conversations.reduce((n, c) => n + c.unread, 0));
  const reload = () => onlineSection(box, ctx);
  const friends = data.friends.filter((f) => f.state === 'friend');
  const incoming = data.friends.filter((f) => f.state === 'incoming');
  const outgoing = data.friends.filter((f) => f.state === 'outgoing');

  const invitesBox = h('div');
  invitesPanel(invitesBox, ctx);
  fill(
    box,
    invitesBox,
    addByTag(reload),
    incoming.length || outgoing.length
      ? h(
          'section',
          { class: 'panel people' },
          h('h2', {}, 'Requests'),
          incoming.map((f) =>
            person(f, 'wants to be your friend', [
              btn({ label: 'Accept', icon: 'user-check', small: true, onclick: () => act(api.acceptFriend(f.user_id), `You and ${f.display_name} are friends`, reload) }),
              btn({ label: 'Decline', kind: 'quiet', small: true, onclick: () => act(api.unfriend(f.user_id), 'Request declined', reload) }),
            ]),
          ),
          outgoing.map((f) => person(f, 'request sent', [btn({ label: 'Cancel', kind: 'quiet', small: true, onclick: () => act(api.unfriend(f.user_id), 'Request cancelled', reload) })])),
        )
      : null,
    h(
      'section',
      { class: 'panel people' },
      h('h2', {}, `Your friends${friends.length ? ` · ${friends.length}` : ''}`),
      friends.length
        ? friends.map((f) =>
            person(f, f.status_text || f.bio || '', [
              btn({ label: `${f.display_name}’s card`, icon: 'trophy', small: true, square: true, onclick: () => openCard(f.user_id, ctx) }),
              btn({ label: 'Message', icon: 'message-circle', small: true, onclick: () => ctx.openChat(f.user_id) }),
              confirmBtn(`Remove ${f.display_name}`, 'user-x', () => act(api.unfriend(f.user_id), `${f.display_name} removed`, reload)),
              confirmBtn(`Block ${f.display_name}`, 'ban', () => act(api.blockUser(f.user_id), `${f.display_name} blocked`, reload)),
            ]),
          )
        : h('p', { class: 'hint' }, 'No friends yet. Send your tag (Settings → Profile) to a friend, or add theirs above.'),
    ),
  );
}

function addByTag(reload) {
  const input = h('input', { class: 'input', type: 'text', placeholder: 'Friend tag, like 7F3A9-C21DE', maxlength: 16, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Friend tag' });
  const status = h('div', { class: 'city-status', 'aria-live': 'polite' });
  const send = async () => {
    if (!input.value.trim()) return;
    send.button.disabled = true;
    try {
      const result = await api.friendRequest(input.value);
      toast(result === 'accepted' ? 'You are now friends' : 'Request sent', 'ok');
      reload();
    } catch (e) {
      status.className = 'city-status warn';
      status.textContent = errText(e);
      send.button.disabled = false;
    }
  };
  send.button = btn({ label: 'Send request', icon: 'user-plus', onclick: send });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  return h('section', { class: 'panel section add-tag' }, h('div', { class: 'section-top' }, icon('user-plus'), h('h2', {}, 'Add a friend')), h('div', { class: 'row' }, input, send.button), status);
}

function person(f, sub, actions) {
  return h(
    'div',
    { class: 'friend' },
    avatar({ icon: f.avatar_icon, color: f.avatar_color }),
    h('div', { class: 'entry-main' }, h('div', { class: 'entry-title' }, f.display_name), sub ? h('div', { class: 'entry-sub' }, sub) : null),
    h('div', { class: 'person-actions' }, actions),
  );
}

/** A small icon button that asks for a second click before acting. */
function confirmBtn(label, iconName, action) {
  const b = btn({ label, icon: iconName, kind: 'quiet', small: true, square: true });
  let armed = null;
  b.addEventListener('click', () => {
    if (armed) {
      clearTimeout(armed);
      armed = null;
      action();
      return;
    }
    b.classList.add('armed');
    b.setAttribute('aria-label', `${label}: click again to confirm`);
    b.title = 'Click again to confirm';
    armed = setTimeout(() => {
      armed = null;
      b.classList.remove('armed');
      b.setAttribute('aria-label', label);
      b.title = label;
    }, 4000);
  });
  return b;
}

async function act(promise, done, reload) {
  try {
    await promise;
    toast(done, 'ok');
    reload();
  } catch (e) {
    toast(errText(e), 'error', 6000);
  }
}

// ---------------------------------------------------------------- your code

function myCodePanel(mine, ctx) {
  const code = h('textarea', { class: 'code', readonly: true, rows: 4, spellcheck: 'false', 'aria-label': 'Your friend code' });
  code.value = mine.code;
  const inside = h('ul', { class: 'inside' });
  const paintInside = (m) =>
    inside.replaceChildren(
      h(
        'li',
        {},
        icon('gamepad-2'),
        m.games
          ? `The ids of your ${m.games} Steam games`
          : h('span', {}, 'No Steam games yet: ', h('button', { type: 'button', class: 'link', onclick: () => ctx.goto('settings') }, 'import them in Settings'), ' to find games you both own'),
      ),
      h('li', {}, icon('heart'), 'Your taste per kind of idea, learned from your ratings'),
      h('li', {}, icon('palette'), 'Your name, avatar icon and color'),
      h('li', {}, icon('check'), 'Nothing else: no SteamID, no history, no location, no account'),
    );
  paintInside(mine);

  const name = h('input', { class: 'input', type: 'text', value: mine.name, maxlength: 24, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Your name in the code' });
  let saved = mine.name;
  const rename = async () => {
    const value = name.value.trim();
    if (!value || value === saved) return;
    try {
      const m = await api.myFriendCode(value);
      saved = m.name;
      name.value = m.name;
      code.value = m.code;
      paintInside(m);
      toast('Your code now says ' + m.name, 'ok');
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  name.addEventListener('change', rename);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      name.blur();
    }
  });

  // Your look: an icon and a color, carried in the code so friends see it too.
  const look = { ...mine.avatar };
  const preview = h('div', { class: 'look-preview' });
  const icons = h('div', { class: 'look-icons', role: 'group', 'aria-label': 'Avatar icon' });
  const colors = h('div', { class: 'look-colors', role: 'group', 'aria-label': 'Avatar color' });
  const paintLook = () => {
    fill(preview, avatar(look, 'lg'));
    fill(
      icons,
      AVATAR_ICONS.map((name, i) =>
        h(
          'button',
          { type: 'button', class: 'look-icon', 'aria-pressed': String(look.icon === i), 'aria-label': name.replace(/-\d+$/, '').replace(/-/g, ' '), onclick: () => setLook({ icon: i }) },
          icon(name),
        ),
      ),
    );
    fill(
      colors,
      AVATAR_COLORS.map((c, i) =>
        h('button', { type: 'button', class: 'look-color', vars: { '--av': c.hex }, 'aria-pressed': String(look.color === i), 'aria-label': c.name, title: c.name, onclick: () => setLook({ color: i }) }, look.color === i ? icon('check') : null),
      ),
    );
  };
  let lookSeq = 0;
  const setLook = async (change) => {
    Object.assign(look, change);
    paintLook();
    const mine = ++lookSeq;
    try {
      const m = await api.myFriendCode(null, { ...look });
      if (mine === lookSeq) code.value = m.code;
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  paintLook();

  return h(
    'section',
    { class: 'panel section' },
    h('div', { class: 'section-top' }, icon('ticket'), h('h2', {}, 'Your friend code')),
    h('p', { class: 'section-desc' }, 'Send it to a friend. When they add it, freetime can pick things you can do together.'),
    h(
      'div',
      { class: 'look' },
      preview,
      h('label', { class: 'field look-name' }, h('span', { class: 'field-label' }, 'Your name in the code'), name),
    ),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Icon'), icons),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Color'), colors),
    code,
    h('div', { class: 'row' }, btn({ label: 'Copy code', icon: 'copy', kind: 'primary', onclick: () => copy(code) })),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'What the code contains'), inside),
  );
}

async function copy(textarea) {
  try {
    await navigator.clipboard.writeText(textarea.value);
  } catch {
    textarea.select();
    document.execCommand('copy');
  }
  toast('Code copied: paste it to your friend', 'ok');
}

// ---------------------------------------------------------------- add a friend

function addPanel(root, ctx) {
  const paste = h('textarea', {
    class: 'code',
    rows: 4,
    spellcheck: 'false',
    placeholder: 'Paste the code your friend sent you (it starts with FT1.)',
    'aria-label': 'Friend code to add',
  });
  const status = h('div', { class: 'city-status', 'aria-live': 'polite' });
  const add = btn({
    label: 'Add friend',
    icon: 'user-plus',
    onclick: async () => {
      if (!paste.value.trim()) {
        status.textContent = 'Paste a code first.';
        status.className = 'city-status warn';
        return;
      }
      add.disabled = true;
      try {
        const f = await api.addFriend(paste.value);
        toast(`${f.name} added${f.common ? `: ${f.common} games you both own` : ''}`, 'ok', 4500);
        ctx.friendsChanged?.();
        render(root, ctx);
      } catch (e) {
        status.textContent = errText(e);
        status.className = 'city-status warn';
        add.disabled = false;
      }
    },
  });
  return h(
    'section',
    { class: 'panel section' },
    h('div', { class: 'section-top' }, icon('users'), h('h2', {}, 'Add a friend')),
    h('p', { class: 'section-desc' }, 'Paste their code. It is checked before anything is saved; adding someone again with a new code updates them.'),
    paste,
    status,
    h('div', { class: 'row' }, add),
  );
}

// ---------------------------------------------------------------- the list

function friendsList(root, ctx, friends) {
  if (!friends.length) {
    return h(
      'div',
      { class: 'friends-empty' },
      emptyState({ icon: 'ticket', title: 'No codes added yet', text: 'Swap codes with someone, then pick “With friends” on Discover to find games you both own.' }),
    );
  }
  const remove = async (f) => {
    try {
      await api.removeFriend(f.name);
      toast(`${f.name} removed`, 'ok');
      ctx.friendsChanged?.();
      render(root, ctx);
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  return h(
    'section',
    { class: 'panel friends-list', 'aria-label': 'Your friends' },
    h('h2', {}, 'Added by code'),
    friends.map((f) =>
      h(
        'div',
        { class: 'friend' },
        avatar(f.avatar),
        h(
          'div',
          { class: 'entry-main' },
          h('div', { class: 'entry-title' }, f.name),
          h(
            'div',
            { class: 'entry-sub' },
            f.common
              ? `${f.games} Steam games · ${f.common} you both own`
              : f.games
                ? `${f.games} Steam games · import yours to see what you share`
                : 'No Steam games in their code',
          ),
        ),
        btn({ label: `Remove ${f.name}`, icon: 'trash-2', kind: 'quiet', small: true, square: true, onclick: () => remove(f) }),
      ),
    ),
  );
}
