// Friends without accounts: swap friend codes (over Discord or anywhere), then pick together.
// Nothing here talks to a server: the code is shown, the user copies and sends it themselves.

import { api } from './api.js';
import { btn, emptyState, errText, h, icon, pageHead, toast } from './dom.js';

const head = () =>
  pageHead(
    'Friends',
    'Pick together without accounts: swap friend codes over Discord or anywhere, then choose “With friends” on Discover.',
  );

export async function render(root, ctx) {
  root.replaceChildren(head(), h('div', { class: 'ghost', style: 'height:360px' }));
  try {
    const [mine, friends] = await Promise.all([api.myFriendCode(), api.friends()]);
    draw(root, ctx, mine, friends);
  } catch (e) {
    root.replaceChildren(head(), emptyState({ icon: 'triangle-alert', title: 'Could not load your friends', text: errText(e) }));
  }
}

function draw(root, ctx, mine, friends) {
  root.replaceChildren(
    head(),
    h('div', { class: 'friends-grid' }, myCodePanel(mine, ctx), addPanel(root, ctx)),
    friendsList(root, ctx, friends),
  );
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

  return h(
    'section',
    { class: 'panel section' },
    h('div', { class: 'section-top' }, icon('ticket'), h('h2', {}, 'Your friend code')),
    h('p', { class: 'section-desc' }, 'Send it to a friend. When they add it, freetime can pick things you can do together.'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Your name in the code'), name),
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
      emptyState({ icon: 'users', title: 'No friends yet', text: 'Swap codes with someone, then pick “With friends” on Discover to find games you both own.' }),
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
    h('h2', {}, 'Your friends'),
    friends.map((f) =>
      h(
        'div',
        { class: 'friend' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, f.name.slice(0, 1).toUpperCase()),
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
