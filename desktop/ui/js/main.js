import { api, inTauri, listen } from './api.js';
import { emptyState, errText, h, hydrateIcons, icon, toast, weatherIcon } from './dom.js';
import { loadPhotos } from './photos.js';
import * as discover from './discover.js';
import * as historyView from './history.js';
import * as settingsView from './settings.js';

const views = {
  discover: document.getElementById('view-discover'),
  history: document.getElementById('view-history'),
  settings: document.getElementById('view-settings'),
};
const main = document.getElementById('main');
const tags = document.getElementById('rail-tags');

let lastOnline = null;
let city = null;

const ctx = {
  goto,
  settingsSaved: () => {
    discover.settingsChanged();
    api.bootstrap().then((b) => {
      city = b.setup.city;
      renderTags(lastOnline);
    }).catch(() => {});
  },
};

function goto(view) {
  if (!views[view]) return;
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  for (const button of document.querySelectorAll('.nav-item')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  main.scrollTop = 0;
  if (view === 'history') historyView.render(views.history, ctx);
  if (view === 'settings') settingsView.render(views.settings, ctx);
}

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => goto(button.dataset.view));
}

// Alt+1/2/3 switch screens.
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const view = { 1: 'discover', 2: 'history', 3: 'settings' }[e.key];
  if (view) {
    e.preventDefault();
    goto(view);
  }
});

// ---------------------------------------------------------------- the tags at the bottom of the rail

function renderTags(online) {
  if (!online) return;
  lastOnline = online;
  const busy = online.loading || !online.ready;
  const w = online.weather;

  let weather;
  if (w) {
    weather = h(
      'div',
      { class: 'tag', title: w.summary },
      icon(weatherIcon(w)),
      h('span', {}, h('span', { class: 'tag-label' }, w.place), h('span', { class: 'tag-value' }, `${Math.round(w.temp_c)}°C ${w.sky}`)),
    );
  } else if (!city && online.ready) {
    weather = h(
      'button',
      { type: 'button', class: 'tag clickable', onclick: () => goto('settings') },
      icon('map-pin'),
      h('span', {}, h('span', { class: 'tag-label' }, 'Weather'), h('span', { class: 'tag-value' }, 'Set your city')),
    );
  } else {
    weather = h(
      'div',
      { class: 'tag' },
      icon('cloud-sun'),
      h('span', {}, h('span', { class: 'tag-label' }, 'Weather'), h('span', { class: 'tag-value' }, busy ? 'Checking' : 'Unavailable')),
    );
  }

  const counts = [
    online.steam_games ? `${online.steam_games} games` : null,
    online.videos ? `${online.videos} videos` : null,
  ].filter(Boolean);
  const sync = h(
    'div',
    { class: 'tag', title: counts.join(', ') || 'Built-in ideas only' },
    icon(busy ? 'loader-circle' : 'check', busy ? 'spin' : ''),
    h(
      'span',
      {},
      h('span', { class: 'tag-label' }, busy ? 'Syncing' : 'Up to date'),
      h('span', { class: 'tag-value' }, online.ready ? counts.join(' · ') || 'Built-in ideas' : 'Steam · YouTube'),
    ),
    busy
      ? null
      : h(
          'button',
          { type: 'button', class: 'tag-action', title: 'Refresh Steam, YouTube and the weather', 'aria-label': 'Refresh online sources', onclick: refresh },
          icon('refresh-cw'),
        ),
  );
  tags.replaceChildren(weather, sync);
}

function refresh() {
  renderTags({ ...lastOnline, loading: true });
  api.refresh().catch((e) => toast(errText(e), 'error'));
}

window.addEventListener('error', (e) => toast(`Something broke: ${e.message}`, 'error', 6000));
window.addEventListener('unhandledrejection', (e) => toast(errText(e.reason), 'error', 6000));

async function start() {
  hydrateIcons();
  if (!inTauri) {
    views.discover.append(
      emptyState({ icon: 'info', title: 'Open freetime from the desktop app', text: 'This page needs the Tauri runtime.' }),
    );
    return;
  }
  await loadPhotos();
  const boot = await api.bootstrap();
  city = boot.setup.city;
  renderTags(boot.online);
  discover.init(views.discover, boot, ctx);
  await listen('online-updated', (online) => {
    renderTags(online);
    discover.onOnline(online);
  });
  // The first sync may have finished before we started listening.
  const online = await api.onlineStatus();
  renderTags(online);
  discover.onOnline(online);
}

start().catch((e) => toast(errText(e), 'error', 8000));
