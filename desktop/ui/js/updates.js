// New versions: a small notice when one is ready, and the "Updates" settings.
// Rust does the work (src/updates.rs): it checks GitHub, verifies the signature, installs.

import { api, inTauri, listen } from './api.js';
import { btn, errText, h, icon, toast } from './dom.js';

let notice = null;
let dismissed = null;

/** Downloads, installs and restarts. The button shows the progress. */
async function install(button) {
  button.disabled = true;
  const label = button.querySelector('.label') ?? button;
  label.textContent = 'Downloading…';
  const stop = await listen('update-progress', (pct) => (label.textContent = `Downloading… ${pct}%`));
  try {
    await api.installUpdate(); // Restarts the app when it's done.
  } catch (e) {
    toast(errText(e), 'error', 6000);
    label.textContent = 'Install and restart';
    button.disabled = false;
  } finally {
    stop();
  }
}

function installButton(small = false) {
  const b = btn({ label: 'Install and restart', icon: 'download', kind: 'primary', small });
  // A span around the text so the progress can replace it without losing the icon.
  const text = [...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
  if (text) text.replaceWith(h('span', { class: 'label' }, text.textContent));
  b.addEventListener('click', () => install(b));
  return b;
}

/** The corner notice. Shown once per version; "Later" hides it until the next start. */
function showNotice(info) {
  if (dismissed === info.version || notice?.isConnected) return;
  notice = h(
    'aside',
    { class: 'update-notice', role: 'status' },
    icon('download'),
    h(
      'div',
      { class: 'update-text' },
      h('strong', {}, `freetime ${info.version} is ready`),
      h('span', {}, 'It installs in a few seconds, then freetime opens again.'),
      h(
        'div',
        { class: 'row' },
        installButton(true),
        btn({
          label: 'Later',
          kind: 'quiet',
          small: true,
          onclick: () => {
            dismissed = info.version;
            notice.remove();
          },
        }),
      ),
    ),
  );
  document.body.append(notice);
}

export async function watchUpdates() {
  await listen('update-available', showNotice);
}

/** Settings → Updates: the version, the automatic check, and "Check now". */
export function updatesBody() {
  if (!inTauri) return [
    h('p', { class: 'hint' }, 'Reopen freetime to use the latest web version.'),
    !window.matchMedia('(display-mode: standalone)').matches ? btn({ label: 'Install freetime', icon: 'download', small: true,
      onclick: async () => (await import('./web-app.js')).installApp() }) : null,
    btn({ label: 'Reload freetime', icon: 'refresh-cw', small: true, onclick: async () => {
      const registration = await navigator.serviceWorker?.getRegistration();
      await registration?.update();
      registration?.waiting?.postMessage('activate');
      location.reload();
    } }),
  ];
  const version = h('span', { translate: 'no' }, '…');
  const box = h('input', { type: 'checkbox' });
  const result = h('div', { class: 'update-result' });
  api
    .updateStatus()
    .then((s) => {
      version.textContent = s.current;
      box.checked = s.auto;
    })
    .catch(() => {});
  box.addEventListener('change', async () => {
    try {
      await api.setAutoUpdate(box.checked);
    } catch (e) {
      box.checked = !box.checked;
      toast(errText(e), 'error');
    }
  });
  const check = btn({
    label: 'Check now',
    icon: 'refresh-cw',
    small: true,
    onclick: async () => {
      check.disabled = true;
      result.replaceChildren(h('span', { class: 'hint' }, 'Checking…'));
      try {
        const info = await api.checkUpdate();
        result.replaceChildren(
          info
            ? h('div', { class: 'row' }, h('span', {}, `Version ${info.version} is available.`), installButton(true))
            : h('span', { class: 'hint' }, 'You have the latest version.'),
        );
      } catch (e) {
        result.replaceChildren(h('span', { class: 'hint' }, errText(e)));
      } finally {
        check.disabled = false;
      }
    },
  });
  return [
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Version'), h('div', { class: 'row update-version' }, version, check)),
    result,
    h('label', { class: 'check' }, box, 'Check for updates automatically (asks before installing)'),
  ];
}
