import { api, inTauri, listen } from './api.js';
import { emptyState, errText, h, toast } from './dom.js';
import * as discover from './discover.js';
import * as historyView from './history.js';
import * as settingsView from './settings.js';

const views = {
  discover: document.getElementById('view-discover'),
  history: document.getElementById('view-history'),
  settings: document.getElementById('view-settings'),
};
const main = document.getElementById('main');

const ctx = {
  goto,
  settingsSaved: () => discover.settingsChanged(),
};

function goto(view) {
  if (!views[view]) return;
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  for (const button of document.querySelectorAll('.nav-item')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  main.scrollTop = 0;
  if (view === 'history') historyView.render(views.history, ctx);
  if (view === 'settings') settingsView.render(views.settings, ctx);
}

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => goto(button.dataset.view));
}

function renderSync(online) {
  const busy = online.loading || !online.ready;
  const counts = [
    online.steam_games ? `${online.steam_games} Steam games` : null,
    online.videos ? `${online.videos} videos` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  document.getElementById('sync').replaceChildren(
    h(
      'div',
      { class: 'sync-line' },
      busy ? h('span', { class: 'spinner' }) : h('span', { class: 'dot' }),
      h('span', { class: 'sync-label' }, busy ? 'Syncing…' : 'Up to date'),
      busy
        ? null
        : h(
            'button',
            {
              class: 'icon-btn',
              title: 'Refresh Steam, YouTube and the weather',
              'aria-label': 'Refresh online sources',
              onclick: refresh,
            },
            '↻',
          ),
    ),
    h('div', { class: 'sync-sub' }, online.ready ? counts || 'Built-in ideas only' : 'Steam · YouTube · weather'),
  );
}

function refresh() {
  renderSync({ loading: true, ready: false });
  api.refresh().catch((e) => toast(errText(e), 'error'));
}

window.addEventListener('error', (e) => toast(`Something broke: ${e.message}`, 'error', 6000));
window.addEventListener('unhandledrejection', (e) => toast(errText(e.reason), 'error', 6000));

async function start() {
  if (!inTauri) {
    views.discover.append(
      emptyState({ emoji: '🖥️', title: 'Open freetime from the desktop app', text: 'This page needs the Tauri runtime.' }),
    );
    return;
  }
  const boot = await api.bootstrap();
  renderSync(boot.online);
  discover.init(views.discover, boot, ctx);
  await listen('online-updated', (online) => {
    renderSync(online);
    discover.onOnline(online);
  });
  // The first sync may have finished before we started listening.
  const online = await api.onlineStatus();
  renderSync(online);
  discover.onOnline(online);
}

start().catch((e) => toast(errText(e), 'error', 8000));
