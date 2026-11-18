// Photos for the built-in ideas ship with the app (ui/img/ideas, free licenses from Wikimedia
// Commons, see scripts/fetch_photos.py). Steam and YouTube items bring their own artwork.

import { categoryIcon, h, icon } from './dom.js';

let credits = {};

/** Loads the bundled credits once; ideas without an entry fall back to their category icon. */
export async function loadPhotos() {
  try {
    const res = await fetch('img/ideas/credits.json');
    if (res.ok) credits = await res.json();
  } catch {
    credits = {};
  }
}

export const photoCredits = () => credits;

/** { src, credit } for an item, or null. */
export function photoFor(c) {
  if (c.image) return { src: c.image, credit: null, remote: true };
  const id = (c.id ?? '').startsWith('idea:') ? c.id.slice(5) : null;
  if (id && credits[id]) return { src: `img/ideas/${id}.jpg`, credit: credits[id], remote: false };
  return null;
}

export function creditLine(credit) {
  if (!credit) return null;
  return `Photo: ${credit.author} · ${credit.license}`;
}

/** An <img> that swaps itself for the category icon if it fails to load. */
export function photo(c, fallbackClass = 'fallback') {
  const fallback = () => h('div', { class: fallbackClass }, icon(categoryIcon(c.category)));
  const p = photoFor(c);
  if (!p) return fallback();
  const img = h('img', {
    src: p.src,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    draggable: 'false',
    referrerpolicy: p.remote ? 'no-referrer' : null,
  });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}
