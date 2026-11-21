// Profile avatars before accounts exist: an icon and a color, carried in the friend code as two
// small numbers. The ORDER of both lists is part of the code format: only ever append (and raise
// AVATAR_ICONS / AVATAR_COLORS in core/src/party.rs). Unknown numbers show the first entry.

import { h, icon } from './dom.js';
import { api } from './api.js';

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

const PHOTO_PREFIX = 'data:image/png;base64,';
const PHOTO_BATCH = 12;
const pendingPhotos = new Map();

export function loadProfilePhoto(id) {
  if (!id) return Promise.resolve(null);
  if (!pendingPhotos.size) queueMicrotask(readProfilePhotos);
  return new Promise((resolve, reject) => {
    const readers = pendingPhotos.get(id) ?? [];
    readers.push({ resolve, reject });
    pendingPhotos.set(id, readers);
  });
}

async function readProfilePhotos() {
  const batch = [...pendingPhotos];
  pendingPhotos.clear();
  for (let i = 0; i < batch.length; i += PHOTO_BATCH) {
    const entries = batch.slice(i, i + PHOTO_BATCH);
    try {
      const rows = await api.profilePhotos(entries.map(([id]) => id));
      const images = new Map(rows.map(({ user_id, image }) => [user_id, image]));
      for (const [id, readers] of entries) {
        for (const reader of readers) reader.resolve(images.get(id) ?? null);
      }
    } catch (err) {
      for (const [, readers] of entries) {
        for (const reader of readers) reader.reject(err);
      }
    }
  }
}

export async function prepareProfilePhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
    throw new Error('Choose a JPG, PNG or WebP image up to 12 MB');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    const crop = Math.min(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2,
      crop, crop, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/png');
    if (!data.startsWith(PHOTO_PREFIX)) throw new Error();
    return data.slice(PHOTO_PREFIX.length);
  } catch {
    throw new Error('Could not read this photo');
  } finally {
    bitmap?.close();
  }
}

/** A round avatar. `size`: 'sm' (32px), default (44px) or 'lg' (72px). */
export function avatar(a, size = '') {
  const node = h('span', { class: size ? `avatar ${size}` : 'avatar', vars: { '--av': avatarColor(a) }, 'aria-hidden': 'true' }, icon(avatarIcon(a)));
  const showPhoto = (image) => {
    if (!image) return;
    const photo = h('img', { class: 'avatar-photo', alt: '', decoding: 'async', onload: () => node.replaceChildren(photo) });
    photo.src = PHOTO_PREFIX + image;
  };
  if (a?.photo) showPhoto(a.photo);
  else if (a?.userId) loadProfilePhoto(a.userId).then(showPhoto).catch(() => {});
  return node;
}
