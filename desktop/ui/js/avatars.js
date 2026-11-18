// Profile avatars before accounts exist: an icon and a color, carried in the friend code as two
// small numbers. The ORDER of both lists is part of the code format: only ever append (and raise
// AVATAR_ICONS / AVATAR_COLORS in core/src/party.rs). Unknown numbers show the first entry.

import { h, icon } from './dom.js';

export const AVATAR_ICONS = [
  'ticket', 'gamepad-2', 'rocket', 'ghost', 'cat', 'dog', 'crown', 'star',
  'flame', 'mountain', 'bike', 'coffee', 'pizza', 'music', 'palette', 'leaf',
  'moon', 'sun', 'zap', 'heart', 'trophy', 'sword', 'dice-5', 'skull',
];

// All dark enough for a white icon on top (WCAG AA).
export const AVATAR_COLORS = [
  { name: 'Carrier navy', hex: '#0d1b3d' },
  { name: 'Carbon purple', hex: '#4b2e83' },
  { name: 'Ink blue', hex: '#1f4fa3' },
  { name: 'Teal', hex: '#0f5e63' },
  { name: 'Forest', hex: '#1f6b4a' },
  { name: 'Ochre', hex: '#8a5a00' },
  { name: 'Plum', hex: '#7a2e5e' },
  { name: 'Slate', hex: '#3b4866' },
];

export const avatarIcon = (a) => AVATAR_ICONS[a?.icon] ?? AVATAR_ICONS[0];
export const avatarColor = (a) => (AVATAR_COLORS[a?.color] ?? AVATAR_COLORS[0]).hex;

/** A round avatar. `size`: 'sm' (32px), default (44px) or 'lg' (72px). */
export function avatar(a, size = '') {
  return h('span', { class: size ? `avatar ${size}` : 'avatar', vars: { '--av': avatarColor(a) }, 'aria-hidden': 'true' }, icon(avatarIcon(a)));
}
