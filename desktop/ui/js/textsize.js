// Low vision mode: scales the whole interface (text, icons, spacing) like a browser zoom,
// so layouts reflow instead of overflowing. The choice stays on this computer.

const KEY = 'freetime.textSize';

export const TEXT_SIZES = [
  { id: 'normal', label: 'Normal', zoom: 1 },
  { id: 'large', label: 'Large', zoom: 1.25 },
  { id: 'xlarge', label: 'Extra large', zoom: 1.5 },
  { id: 'huge', label: 'Huge', zoom: 1.75 },
];

const listeners = new Set();

export function currentTextSize() {
  let id = null;
  try {
    id = localStorage.getItem(KEY);
  } catch {}
  return TEXT_SIZES.find((s) => s.id === id) ?? TEXT_SIZES[0];
}

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
  const size = TEXT_SIZES.find((s) => s.id === id) ?? TEXT_SIZES[0];
  try {
    localStorage.setItem(KEY, size.id);
  } catch {}
  document.documentElement.dataset.textSize = size.id;
  await zoomTo(size.zoom);
  for (const cb of listeners) cb(size);
  return size;
}

/** Called when the size changes (from Settings or a shortcut). Returns an unsubscribe function. */
export function onTextSizeChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Applies the saved size and wires Ctrl+Plus / Ctrl+Minus / Ctrl+0. */
export function initTextSize() {
  setTextSize(currentTextSize().id);
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const i = TEXT_SIZES.indexOf(currentTextSize());
    let next = null;
    if (e.key === '+' || e.key === '=') next = TEXT_SIZES[Math.min(i + 1, TEXT_SIZES.length - 1)];
    else if (e.key === '-' || e.key === '_') next = TEXT_SIZES[Math.max(i - 1, 0)];
    else if (e.key === '0') next = TEXT_SIZES[0];
    if (!next) return;
    e.preventDefault();
    if (next !== TEXT_SIZES[i]) setTextSize(next.id);
  });
}
