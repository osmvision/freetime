// Your profile (Settings): a compact card, with the editor only when you ask for it.
// Signing in is the only thing here that touches the network, and only when clicked.

import { api } from './api.js';
import { invalidatePrefs } from './feed.js';
import { forgetAssistantChat } from './assistant.js';
import { AVATAR_COLORS, AVATAR_ICONS, avatar } from './avatars.js';
import { btn, errText, fill, h, icon, toast } from './dom.js';

/** Renders the Profile section into `box`. `onChange()` runs after sign-in, sign-out or a save. */
export async function profileSection(box, onChange = () => {}) {
  let status;
  try {
    status = await api.accountStatus();
  } catch {
    status = { signed_in: false };
  }
  if (!status.signed_in) return signedOut(box, onChange);
  fill(box, panel(h('div', { class: 'ghost', style: 'height:96px' })));
  try {
    card(box, await api.account(), onChange);
  } catch (e) {
    // The saved session ended (or the network is down): offer to sign in again.
    signedOut(box, onChange, errText(e));
  }
}

function panel(...children) {
  return h('section', { class: 'panel section profile', id: 'profile' }, h('div', { class: 'section-top' }, icon('user'), h('h2', {}, 'Profile')), children);
}

/**
 * "Continue with Google", with the age and privacy tick that must come first, and a line for how it
 * goes. Returns the three elements to place. `before()` runs once the tick is given, just before the
 * browser opens (on the web, the page itself leaves); `onSignedIn(account)` runs once it worked.
 */
export function googleSignIn({ problem = null, kind = 'primary', before = null, onSignedIn }) {
  const status = h('div', { class: 'city-status' + (problem ? ' warn' : ''), 'aria-live': 'polite' }, problem ?? '');
  const age = h('input', { type: 'checkbox' });
  const go = btn({
    label: 'Continue with Google',
    icon: 'log-in',
    kind,
    onclick: async () => {
      if (!age.checked) {
        status.className = 'city-status warn';
        status.textContent = 'Online profiles are for people aged 15 and over.';
        return;
      }
      go.disabled = true;
      status.className = 'city-status';
      status.textContent = 'Finish signing in in your browser. This page updates by itself.';
      try {
        await before?.();
        const acc = await api.signIn('google');
        toast(`Signed in as ${acc.profile?.display_name ?? 'you'}`, 'ok');
        onSignedIn(acc);
      } catch (e) {
        status.className = 'city-status warn';
        status.textContent = errText(e);
        go.disabled = false;
      }
    },
  });
  return [
    h(
      'label',
      { class: 'check' },
      age,
      'I’m 15 or older and I accept the ',
      h('button', { type: 'button', class: 'link', onclick: () => api.open(PRIVACY_URL).catch(() => {}) }, 'privacy policy'),
    ),
    h('div', { class: 'row' }, go),
    status,
  ];
}

function signedOut(box, onChange, problem = null) {
  fill(
    box,
    panel(
      h('p', { class: 'section-desc' }, 'Optional. Sign in to add friends by tag and send them messages. Everything else in freetime works without an account.'),
      h(
        'ul',
        { class: 'inside' },
        h('li', {}, icon('check'), 'Opens your browser: freetime never sees your Google password'),
        h('li', {}, icon('check'), 'Your email stays private; others see only the name and avatar you choose'),
        h('li', {}, icon('check'), 'Nothing is sent until you click; signing out removes the session from this PC'),
      ),
      googleSignIn({
        problem,
        onSignedIn: (acc) => {
          card(box, acc, onChange);
          onChange();
        },
      }),
    ),
  );
}

/** The compact view: who you are, your tag, and two buttons. */
function card(box, acc, onChange) {
  const p = acc.profile;
  const tag = h('span', { class: 'figures friend-tag' }, p.friend_tag);
  fill(
    box,
    panel(
      h(
        'div',
        { class: 'profile-card' },
        avatar({ icon: p.avatar_icon, color: p.avatar_color }, 'lg'),
        h(
          'div',
          { class: 'profile-who' },
          h('div', { class: 'profile-name' }, p.display_name),
          p.status_text ? h('div', { class: 'profile-status' }, p.status_text) : null,
          p.bio ? h('div', { class: 'profile-bio' }, p.bio) : null,
          acc.email ? h('div', { class: 'hint' }, `Signed in as ${acc.email} (only you see this)`) : null,
        ),
        h(
          'div',
          { class: 'profile-actions' },
          btn({ label: 'Edit profile', icon: 'pencil', small: true, onclick: () => editor(box, acc, onChange) }),
          btn({
            label: 'Sign out',
            icon: 'log-out',
            kind: 'quiet',
            small: true,
            onclick: async () => {
              try {
                await api.signOut();
                toast('Signed out', 'ok');
                signedOut(box, onChange);
                onChange();
              } catch (e) {
                toast(errText(e), 'error');
              }
            },
          }),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'Your friend tag'),
        h(
          'div',
          { class: 'row tag-row' },
          tag,
          btn({ label: 'Copy', icon: 'copy', small: true, onclick: () => copy(tag.textContent, 'Friend tag copied') }),
          btn({
            label: 'New tag',
            icon: 'refresh-cw',
            small: true,
            kind: 'quiet',
            title: 'Get a new tag if the old one was shared too widely. Friends stay friends.',
            onclick: async () => {
              try {
                tag.textContent = await api.resetFriendTag();
                toast('New friend tag: the old one no longer works', 'ok');
              } catch (e) {
                toast(errText(e), 'error');
              }
            },
          }),
        ),
        h('span', { class: 'hint' }, 'Friends add you with this tag in the Friends tab.'),
      ),
      notifications(),
      shareGames(),
      yourData(box, onChange),
    ),
  );
}

/** Opt-in: share your Steam game list (ids only) and taste with friends, for picks together. */
function shareGames() {
  const box = h('input', { type: 'checkbox' });
  const hint = h('span', { class: 'hint' });
  const paint = (v) => {
    box.checked = v.enabled;
    hint.textContent = v.games
      ? v.enabled
        ? `Your friends can see the ids of your ${v.games} Steam games, so freetime can find what you can play together.`
        : `Shares the ids of your ${v.games} Steam games and your taste, with your friends only. Turning it off deletes them.`
      : 'Import your Steam games below first.';
    box.disabled = !v.games && !v.enabled;
  };
  api.getShareLibrary().then(paint).catch(() => {});
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      const v = await api.setShareLibrary(box.checked);
      paint(v);
      toast(v.enabled ? 'Your game list is shared with your friends' : 'Your game list is no longer shared', 'ok');
    } catch (e) {
      box.checked = !box.checked;
      box.disabled = false;
      toast(errText(e), 'error');
    }
  });
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label' }, 'Play together'),
    h('label', { class: 'check' }, box, 'Share my Steam game list with friends'),
    hint,
  );
}

/** The new-message notifications switch. */
/** Notifications, quiet hours and sharing: all in config.toml on this PC. */
function notifications() {
  const boxes = {
    notify_messages: ['Messages from friends'],
    notify_invites: ['Invites from friends'],
    notify_free_together: ['A friend is free at the same time as you (at most 3 a day)'],
    quiet_hours: ['Quiet hours: no friend notifications from 22:00 to 09:00 (messages and invites still come)'],
  };
  const inputs = Object.fromEntries(Object.keys(boxes).map((k) => [k, h('input', { type: 'checkbox' })]));
  const share = h(
    'select',
    { class: 'input share-select', 'aria-label': 'After a 👍' },
    h('option', { value: 'ask' }, 'Ask me each time'),
    h('option', { value: 'always' }, 'Always share with my friends'),
    h('option', { value: 'never' }, 'Never share'),
  );
  let prefs = null;
  api
    .socialPrefs()
    .then((p) => {
      prefs = p;
      for (const [k, el] of Object.entries(inputs)) el.checked = Boolean(p[k]);
      share.value = p.share_activity;
    })
    .catch(() => {});
  const save = async (undo) => {
    if (!prefs) return;
    const next = { ...prefs, share_activity: share.value };
    for (const [k, el] of Object.entries(inputs)) next[k] = el.checked;
    try {
      prefs = await api.setSocialPrefs(next);
      invalidatePrefs();
      toast('Saved', 'ok');
    } catch (e) {
      undo();
      toast(errText(e), 'error');
    }
  };
  for (const el of Object.values(inputs)) el.addEventListener('change', () => save(() => (el.checked = !el.checked)));
  share.addEventListener('change', () => save(() => (share.value = prefs.share_activity)));
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label' }, 'Notifications'),
    Object.entries(boxes).map(([k, [label]]) => h('label', { class: 'check' }, inputs[k], label)),
    h('span', { class: 'field-label' }, 'After a 👍, share it with my friends'),
    share,
  );
}

const PRIVACY_URL = 'https://github.com/osmvision/freetime/blob/main/docs/privacy.md';

/** Export, privacy policy, and account deletion (with a typed confirmation). */
function yourData(box, onChange) {
  const confirmBox = h('div', { class: 'danger-zone', hidden: true });
  const exportBtn = btn({
    label: 'Export my data',
    icon: 'download',
    small: true,
    onclick: async () => {
      exportBtn.disabled = true;
      try {
        const path = await api.exportMyData();
        toast(`Saved to ${path}`, 'ok', 7000);
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        exportBtn.disabled = false;
      }
    },
  });

  const typed = h('input', { class: 'input', type: 'text', placeholder: 'Type DELETE', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Type DELETE to confirm' });
  const really = btn({
    label: 'Delete for good',
    icon: 'trash-2',
    kind: 'primary',
    onclick: async () => {
      if (typed.value.trim() !== 'DELETE') return;
      really.disabled = true;
      try {
        await api.deleteMyAccount();
        forgetAssistantChat();
        toast('Your online account is deleted', 'ok', 6000);
        profileSection(box, onChange);
        onChange();
      } catch (e) {
        toast(errText(e), 'error', 6000);
        really.disabled = false;
      }
    },
  });
  really.disabled = true;
  typed.addEventListener('input', () => (really.disabled = typed.value.trim() !== 'DELETE'));
  confirmBox.append(
    h('p', {}, 'This deletes your online profile, friends, requests, blocks and the messages you sent, for good. Your picks and history on this PC stay.'),
    h('div', { class: 'row' }, typed, really, btn({ label: 'Cancel', kind: 'quiet', onclick: () => (confirmBox.hidden = true) })),
  );

  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label' }, 'Your data'),
    h(
      'div',
      { class: 'row' },
      exportBtn,
      btn({ label: 'Privacy policy', icon: 'shield', small: true, kind: 'quiet', onclick: () => api.open(PRIVACY_URL).catch((e) => toast(errText(e), 'error')) }),
      btn({
        label: 'Delete my account',
        icon: 'trash-2',
        small: true,
        kind: 'quiet',
        onclick: () => {
          confirmBox.hidden = false;
          typed.focus();
        },
      }),
    ),
    confirmBox,
  );
}

/** The full editor, opened from the card. */
function editor(box, acc, onChange) {
  const p = acc.profile;
  const look = { icon: p.avatar_icon, color: p.avatar_color };
  const name = h('input', { class: 'input', type: 'text', value: p.display_name, maxlength: 24, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Display name' });
  const bio = h('input', { class: 'input', type: 'text', value: p.bio, maxlength: 160, placeholder: 'A line about you (optional)', 'aria-label': 'Bio' });
  const statusText = h('input', { class: 'input', type: 'text', value: p.status_text, maxlength: 60, placeholder: 'e.g. Free tonight', 'aria-label': 'Status' });
  const preview = h('div', { class: 'look-preview' });
  const icons = h('div', { class: 'look-icons', role: 'group', 'aria-label': 'Avatar icon' });
  const colors = h('div', { class: 'look-colors', role: 'group', 'aria-label': 'Avatar color' });
  const paint = () => {
    fill(preview, avatar(look, 'lg'));
    fill(icons, AVATAR_ICONS.map((n, i) => h('button', { type: 'button', class: 'look-icon', 'aria-pressed': String(look.icon === i), 'aria-label': n.replace(/-\d+$/, '').replace(/-/g, ' '), onclick: () => { look.icon = i; paint(); } }, icon(n))));
    fill(colors, AVATAR_COLORS.map((c, i) => h('button', { type: 'button', class: 'look-color', vars: { '--av': c.hex }, 'aria-pressed': String(look.color === i), 'aria-label': c.name, title: c.name, onclick: () => { look.color = i; paint(); } }, look.color === i ? icon('check') : null)));
  };
  paint();

  const save = btn({
    label: 'Save',
    icon: 'check',
    kind: 'primary',
    onclick: async () => {
      save.disabled = true;
      try {
        const profile = await api.saveProfile({ display_name: name.value, avatar_icon: look.icon, avatar_color: look.color, bio: bio.value, status_text: statusText.value });
        toast('Profile saved', 'ok');
        card(box, { ...acc, profile }, onChange);
        onChange();
      } catch (e) {
        toast(errText(e), 'error', 6000);
        save.disabled = false;
      }
    },
  });

  fill(
    box,
    panel(
      h('div', { class: 'look' }, preview, h('label', { class: 'field look-name' }, h('span', { class: 'field-label' }, 'Display name'), name)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Icon'), icons),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Color'), colors),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Bio'), bio),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Status'), statusText),
      h('div', { class: 'row' }, save, btn({ label: 'Cancel', kind: 'quiet', onclick: () => card(box, acc, onChange) })),
    ),
  );
  name.focus();
}

export async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'ok');
  } catch {
    toast('Could not copy', 'error');
  }
}
