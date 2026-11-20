// Discover shortcuts ("I have 20 minutes", "Quiet evening", "With my friends", and your own), and
// what "Save to my account" carries to your other devices besides the history: the shortcuts and
// the usual context. Both live in this device's storage; nothing is sent unless you ask.

export const MOOD_KEY = 'freetime.mood.v2';
const SHORTCUTS_KEY = 'freetime.shortcuts.v1';
export const MAX_SHORTCUTS = 6;

/** Built in: each sets a few parts of the context and leaves the rest as it is. */
export const BUILT_IN = [
  { id: 'twenty', label: 'I have 20 minutes', icon: 'timer', set: { minutes: 20 } },
  { id: 'quiet', label: 'Quiet evening', icon: 'moon', set: { minutes: 120, energy: 'low', can_go_out: false } },
  { id: 'friends', label: 'With my friends', icon: 'users', set: { with_friends: true } },
];

const ENERGIES = ['low', 'medium', 'high'];
const BUDGETS = ['free', 'cheap', 'paid'];

/** Keeps only what a context may hold, so storage edited by hand (or another device) can't break Discover. */
export function cleanContext(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  if (Number.isFinite(v.minutes) && v.minutes >= 5 && v.minutes <= 300) out.minutes = Math.round(v.minutes);
  if (ENERGIES.includes(v.energy)) out.energy = v.energy;
  if (typeof v.with_friends === 'boolean') out.with_friends = v.with_friends;
  if (typeof v.can_go_out === 'boolean') out.can_go_out = v.can_go_out;
  if (BUDGETS.includes(v.budget)) out.budget = v.budget;
  if (Array.isArray(v.categories)) out.categories = v.categories.filter((c) => typeof c === 'string' && /^[a-z]{2,12}$/.test(c)).slice(0, 12);
  return out;
}

function cleanShortcut(s) {
  if (!s || typeof s !== 'object' || typeof s.label !== 'string') return null;
  const label = s.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  const set = cleanContext(s.set);
  return label && Object.keys(set).length ? { id: typeof s.id === 'string' ? s.id.slice(0, 40) : `mine-${Date.now()}`, label, set } : null;
}

const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

/** Your own shortcuts, oldest first. */
export function myShortcuts() {
  const list = read(SHORTCUTS_KEY);
  return Array.isArray(list) ? list.map(cleanShortcut).filter(Boolean).slice(0, MAX_SHORTCUTS) : [];
}

export function saveShortcuts(list) {
  return write(SHORTCUTS_KEY, list.map(cleanShortcut).filter(Boolean).slice(0, MAX_SHORTCUTS));
}

/** What "Save to my account" sends besides the history. */
export function localExtra() {
  return { shortcuts: myShortcuts(), mood: read(MOOD_KEY) };
}

/** Puts back what another device saved, then tells Discover to pick it up. */
export function applyExtra(extra) {
  if (!extra || typeof extra !== 'object') return;
  if (Array.isArray(extra.shortcuts)) saveShortcuts(extra.shortcuts);
  if (extra.mood && typeof extra.mood === 'object') {
    const mood = cleanContext(extra.mood);
    if (Array.isArray(extra.mood.party)) mood.party = extra.mood.party.filter((n) => typeof n === 'string').slice(0, 50);
    write(MOOD_KEY, mood);
  }
  document.dispatchEvent(new CustomEvent('preferences-loaded'));
}
