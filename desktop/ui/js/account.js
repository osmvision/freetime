// The online account panel (opt-in): sign in with Google, then edit the online profile.
// Signing in is the only thing here that touches the network, and only when clicked.

import { api } from './api.js';
import { AVATAR_COLORS, AVATAR_ICONS, avatar } from './avatars.js';
import { btn, errText, fill, h, icon, toast } from './dom.js';

/** Renders into `box`; `onChange()` runs after sign-in, sign-out or a profile save. */
export async function accountPanel(box, onChange = () => {}) {
  let status;
  try {
    status = await api.accountStatus();
  } catch {
    status = { signed_in: false };
  }
  if (!status.signed_in) return signedOut(box, onChange);
  fill(box, panel('Online profile', h('div', { class: 'ghost', style: 'height:120px' })));
  try {
    signedIn(box, await api.account(), onChange);
  } catch (e) {
    // The saved session ended (or the network is down): offer to sign in again.
    signedOut(box, onChange, errText(e));
  }
}

function panel(title, ...children) {
  return h('section', { class: 'panel section account' }, h('div', { class: 'section-top' }, icon('user'), h('h2', {}, title)), children);
}

function signedOut(box, onChange, problem = null) {
  const status = h('div', { class: 'city-status' + (problem ? ' warn' : ''), 'aria-live': 'polite' }, problem ?? '');
  const go = btn({
    label: 'Continue with Google',
    icon: 'user',
    kind: 'primary',
    onclick: async () => {
      go.disabled = true;
      status.className = 'city-status';
      status.textContent = 'Finish signing in in your browser. This page updates by itself.';
      try {
        const acc = await api.signIn('google');
        toast(`Signed in${acc.profile ? ` as ${acc.profile.display_name}` : ''}`, 'ok');
        signedIn(box, acc, onChange);
        onChange();
      } catch (e) {
        status.className = 'city-status warn';
        status.textContent = errText(e);
        go.disabled = false;
      }
    },
  });
  fill(
    box,
    panel(
      'Online profile',
      h('p', { class: 'section-desc' }, 'Optional. Sign in to get an online profile with a friend tag; friends, chat and communities build on it. Everything else in freetime works without an account.'),
      h(
        'ul',
        { class: 'inside' },
        h('li', {}, icon('check'), 'Opens your browser: freetime never sees your Google password'),
        h('li', {}, icon('check'), 'Your email stays private; others see only the name and avatar you choose'),
        h('li', {}, icon('check'), 'Nothing is sent until you click, and signing out removes the session from this PC'),
      ),
      h('div', { class: 'row' }, go),
      status,
    ),
  );
}

function signedIn(box, acc, onChange) {
  const p = acc.profile;
  const look = { icon: p.avatar_icon, color: p.avatar_color };
  const name = h('input', { class: 'input', type: 'text', value: p.display_name, maxlength: 24, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Display name' });
  const bio = h('input', { class: 'input', type: 'text', value: p.bio, maxlength: 160, placeholder: 'A line about you (optional)', 'aria-label': 'Bio' });
  const statusText = h('input', { class: 'input', type: 'text', value: p.status_text, maxlength: 60, placeholder: 'e.g. Free tonight', 'aria-label': 'Status' });
  const preview = h('div', { class: 'look-preview' });
  const icons = h('div', { class: 'look-icons', role: 'group', 'aria-label': 'Avatar icon' });
  const colors = h('div', { class: 'look-colors', role: 'group', 'aria-label': 'Avatar color' });
  const tag = h('span', { class: 'figures friend-tag' }, p.friend_tag);

  const paint = () => {
    fill(preview, avatar(look, 'lg'));
    fill(icons, AVATAR_ICONS.map((n, i) => h('button', { type: 'button', class: 'look-icon', 'aria-pressed': String(look.icon === i), 'aria-label': n.replace(/-\d+$/, '').replace(/-/g, ' '), onclick: () => { look.icon = i; paint(); } }, icon(n))));
    fill(colors, AVATAR_COLORS.map((c, i) => h('button', { type: 'button', class: 'look-color', vars: { '--av': c.hex }, 'aria-pressed': String(look.color === i), 'aria-label': c.name, title: c.name, onclick: () => { look.color = i; paint(); } }, look.color === i ? icon('check') : null)));
  };
  paint();

  const save = btn({
    label: 'Save profile',
    icon: 'check',
    kind: 'primary',
    onclick: async () => {
      save.disabled = true;
      try {
        await api.saveProfile({ display_name: name.value, avatar_icon: look.icon, avatar_color: look.color, bio: bio.value, status_text: statusText.value });
        toast('Profile saved', 'ok');
        onChange();
      } catch (e) {
        toast(errText(e), 'error', 6000);
      } finally {
        save.disabled = false;
      }
    },
  });

  fill(
    box,
    panel(
      'Online profile',
      h('p', { class: 'section-desc' }, `Signed in${acc.email ? ` as ${acc.email} (only you see this)` : ''}. Friends see your name, avatar, bio and status.`),
      h('div', { class: 'look' }, preview, h('label', { class: 'field look-name' }, h('span', { class: 'field-label' }, 'Display name'), name)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Icon'), icons),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Color'), colors),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Bio'), bio),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Status'), statusText),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'Your friend tag'),
        h(
          'div',
          { class: 'row tag-row' },
          tag,
          btn({ label: 'Copy', icon: 'copy', small: true, onclick: () => navigator.clipboard.writeText(tag.textContent).then(() => toast('Friend tag copied', 'ok')).catch(() => toast('Could not copy', 'error')) }),
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
        h('span', { class: 'hint' }, 'Share it with friends so they can send you a request. Adding friends by tag comes next.'),
      ),
      h(
        'div',
        { class: 'row' },
        save,
        btn({
          label: 'Sign out',
          kind: 'quiet',
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
  );
}
