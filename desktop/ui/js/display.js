// Display preferences, all kept on this computer:
// - low vision mode scales the whole interface (text, icons, spacing) like a browser zoom,
//   so layouts reflow instead of overflowing;
// - night mode and high contrast swap the colour tokens (see the top of styles.css).
// js/boot-display.js applies the colours before the first paint; this module keeps them in sync.

const KEYS = { size: 'freetime.textSize', theme: 'freetime.theme', contrast: 'freetime.contrast' };

export const TEXT_SIZES = [
  { id: 'normal', label: 'Normal', zoom: 1 },
  { id: 'large', label: 'Large', zoom: 1.25 },
  { id: 'xlarge', label: 'Extra large', zoom: 1.5 },
  { id: 'huge', label: 'Huge', zoom: 1.75 },
];

export const THEMES = [
  { id: 'light', label: 'Day', icon: 'sun' },
  { id: 'dark', label: 'Night', icon: 'moon' },
  { id: 'system', label: 'Like Windows', icon: 'monitor' },
];

const listeners = new Set();
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const phoneQuery = window.matchMedia('(max-width: 600px), (max-height: 600px) and (pointer: coarse)');

export function availableTextSizes() {
  return phoneQuery.matches ? TEXT_SIZES.slice(0, 2) : TEXT_SIZES;
}

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function currentTextSize() {
  const saved = TEXT_SIZES.find((s) => s.id === read(KEYS.size)) ?? TEXT_SIZES[0];
  return phoneQuery.matches && saved.zoom > 1.25 ? TEXT_SIZES[1] : saved;
}

export function currentTheme() {
  return THEMES.find((t) => t.id === read(KEYS.theme)) ?? THEMES[0];
}

export function highContrast() {
  return read(KEYS.contrast) === 'high';
}

/** What is on screen now: { size, theme, dark, contrast }. */
export function displayState() {
  const theme = currentTheme();
  const dark = theme.id === 'dark' || (theme.id === 'system' && darkQuery.matches);
  return { size: currentTextSize(), theme, dark, contrast: highContrast() };
}

function emit() {
  const state = displayState();
  for (const cb of listeners) cb(state);
}

/** Called whenever a display setting changes (from Settings, a shortcut or Windows). Returns an unsubscribe function. */
export function onDisplayChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---------------------------------------------------------------- text size

async function zoomTo(zoom) {
  const webview = window.__TAURI__?.webview?.getCurrentWebview?.();
  if (webview?.setZoom) {
    try {
      await webview.setZoom(zoom);
      document.documentElement.style.zoom = '';
      return;
    } catch {
      // Not allowed or not supported: fall back to CSS zoom below.
    }
  }
  document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
}

export async function setTextSize(id) {
  const size = availableTextSizes().find((s) => s.id === id) ?? currentTextSize();
  write(KEYS.size, size.id);
  document.documentElement.dataset.textSize = size.id;
  await zoomTo(size.zoom);
  document.documentElement.style.setProperty('--ui-zoom', document.documentElement.style.zoom || '1');
  emit();
  return size;
}

// ---------------------------------------------------------------- colours

function paint() {
  const { dark, contrast } = displayState();
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  if (contrast) root.dataset.contrast = 'high';
  else delete root.dataset.contrast;
  // The window's own title bar follows too.
  window.__TAURI__?.window?.getCurrentWindow?.().setTheme?.(dark ? 'dark' : 'light').catch(() => {});
}

export function setTheme(id) {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  write(KEYS.theme, theme.id);
  paint();
  emit();
}

export function setHighContrast(on) {
  write(KEYS.contrast, on ? 'high' : 'normal');
  paint();
  emit();
}

// ---------------------------------------------------------------- start

/** Applies the saved settings and wires Ctrl+Plus / Ctrl+Minus / Ctrl+0 and the Windows theme. */
export function initDisplay() {
  paint();
  // Keep a tablet/desktop preference when temporarily entering the phone layout.
  const applySize = async () => {
    const size = currentTextSize();
    document.documentElement.dataset.textSize = size.id;
    await zoomTo(size.zoom);
    document.documentElement.style.setProperty('--ui-zoom', document.documentElement.style.zoom || '1');
    emit();
  };
  applySize();
  phoneQuery.addEventListener('change', applySize);
  darkQuery.addEventListener('change', () => {
    if (currentTheme().id !== 'system') return;
    paint();
    emit();
  });
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const sizes = availableTextSizes();
    const i = sizes.indexOf(currentTextSize());
    let next = null;
    if (e.key === '+' || e.key === '=') next = sizes[Math.min(i + 1, sizes.length - 1)];
    else if (e.key === '-' || e.key === '_') next = sizes[Math.max(i - 1, 0)];
    else if (e.key === '0') next = sizes[0];
    if (!next) return;
    e.preventDefault();
    if (next !== sizes[i]) setTextSize(next.id);
  });
}
