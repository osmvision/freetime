import { api, inTauri, listen } from './api.js';
import { errText, h, hydrateIcons, icon, toast, weatherIcon } from './dom.js';
import { loadPhotos } from './photos.js';
import { loadSupport } from './support.js';
import * as discover from './discover.js';
import * as friendsView from './friends.js';
import * as historyView from './history.js';
import * as messagesView from './messages.js';
import { avatar } from './avatars.js';
import { runWelcome } from './welcome.js';
import { startI18n } from './i18n.js';
import * as settingsView from './settings.js';
import { initDisplay } from './display.js';
import { initViewport } from './viewport.js';
import { assistantAccountChanged, assistantSettingsChanged, mountAssistant } from './assistant.js';
import { watchUpdates } from './updates.js';
import * as ticketsView from './tickets.js';
import * as gamesView from './games.js';
import { watchGameInvites } from './game-invites.js';
import { watchReminders } from './evenings.js';
import { checkSurprise } from './surprise.js';

initDisplay();
initViewport();

const views = {
  discover: document.getElementById('view-discover'),
  games: document.getElementById('view-games'),
  friends: document.getElementById('view-friends'),
  messages: document.getElementById('view-messages'),
  history: document.getElementById('view-history'),
  settings: document.getElementById('view-settings'),
  tickets: document.getElementById('view-tickets'),
};
const main = document.getElementById('main');
const tags = document.getElementById('bar-tags');

let lastOnline = null;
/** The live connection (Realtime) is up: chats don't need to check every few seconds. */
let live = false;
let city = null;

const ctx = {
  goto,
  // Start an idea from outside Discover (the ticket book's ticket of the day).
  startIdea: (c) => discover.startIdea(c),
  friendsChanged: () => discover.friendsChanged(),
  accountChanged: () => {
    renderMe();
    assistantAccountChanged();
    refreshAdmin();
    gamesView.refreshDuelDot();
    gamesView.refreshMatchDot();
  },
  isLive: () => live,
  openChat: (friendId) => goto('messages', { friend: friendId }),
  setInvites: (n) => {
    const badge = document.getElementById('invites-badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  },
  // Open tickets, on the admins' Tickets tab (undefined: leave it as it is).
  setTickets: (n) => {
    if (n === undefined) return;
    const badge = document.getElementById('tickets-badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  },
  setUnread: (n) => {
    const badge = document.getElementById('unread-badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  },
  settingsSaved: () => {
    discover.settingsChanged();
    assistantSettingsChanged();
    api.bootstrap().then((b) => {
      city = b.setup.city;
      renderTags(lastOnline);
    }).catch(() => {});
  },
};

function goto(view, options = {}) {
  if (!views[view]) return;
  if (view !== 'messages') messagesView.stop();
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  // The assistant bubble moves out of the way of the message box on Messages.
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll('.nav-item')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  main.scrollTop = 0;
  if (view === 'games') gamesView.render(views.games, ctx, options);
  if (view === 'friends') friendsView.render(views.friends, ctx, options);
  if (view === 'messages') messagesView.render(views.messages, ctx, options);
  if (view === 'history') historyView.render(views.history, ctx, options);
  if (view === 'settings') settingsView.render(views.settings, ctx, options);
  if (view === 'tickets') ticketsView.render(views.tickets, ctx);
}

for (const button of document.querySelectorAll('.nav-item[data-view]')) {
  button.addEventListener('click', () => goto(button.dataset.view));
}

// Alt+1 to Alt+5 switch screens, Alt+Q opens Games.
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key.toLowerCase() === 'q' && !document.querySelector('.quiz-backdrop')) {
    e.preventDefault();
    goto('games');
    return;
  }
  const view = { 1: 'discover', 2: 'friends', 3: 'messages', 4: 'history', 5: 'settings' }[e.key];
  if (view) {
    e.preventDefault();
    goto(view);
  }
});

// ---------------------------------------------------------------- your profile chip

const meChip = document.getElementById('me-chip');
meChip.addEventListener('click', () => goto('settings', { focus: 'profile' }));
let meRender = 0;

async function renderMe() {
  const run = ++meRender;
  try {
    const [status, mine] = await Promise.all([api.accountStatus(), api.myFriendCode()]);
    if (run !== meRender) return;
    meChip.replaceChildren();
    if (status.signed_in) {
      meChip.append(avatar(mine.avatar, 'sm'), h('span', { class: 'me-name' }, mine.name));
      meChip.title = 'Your profile';
      meChip.setAttribute('aria-label', `Your profile: ${mine.name}`);
      api.account().then(({ profile }) => {
        if (run !== meRender || !profile) return;
        meChip.replaceChildren(
          avatar({ icon: profile.avatar_icon, color: profile.avatar_color, userId: profile.id }, 'sm'),
          h('span', { class: 'me-name' }, profile.display_name),
        );
        meChip.setAttribute('aria-label', `Your profile: ${profile.display_name}`);
      }).catch(() => {});
    } else {
      ctx.setInvites(0);
      meChip.append(icon('log-in'), h('span', { class: 'me-name' }, 'Sign in'));
      meChip.title = 'Sign in to add friends and send messages';
      meChip.setAttribute('aria-label', 'Sign in');
    }
    meChip.hidden = false;
  } catch {
    if (run === meRender) meChip.hidden = true;
  }
}

// ---------------------------------------------------------------- the tags on the right of the top bar

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
      h('span', { class: 'tag-label' }, w.place),
      h('span', { class: 'tag-value' }, `${Math.round(w.temp_c)}°C`),
    );
  } else if (!city && online.ready) {
    // Hidden on Discover while its own "Where are you?" strip asks the same thing.
    weather = h(
      'button',
      { type: 'button', class: 'tag tag-city', title: 'Your city is used for the weather and, when you ask, places nearby', 'aria-label': 'Set your city', onclick: () => goto('settings') },
      icon('map-pin'),
      h('span', { class: 'tag-value' }, 'Set your city'),
    );
  } else {
    weather = h(
      'div',
      { class: 'tag', title: 'Weather' },
      icon('cloud-sun'),
      h('span', { class: 'tag-value' }, busy ? 'Checking' : 'No weather'),
    );
  }

  const counts = [
    online.steam_games ? `${online.steam_games} Steam games` : null,
    online.videos ? `${online.videos} videos` : null,
  ].filter(Boolean);
  // One small refresh button: it spins while the sources load, its tooltip says what it found.
  const sync = h(
    'button',
    {
      type: 'button',
      class: 'tag tag-sync',
      title: busy ? 'Checking Steam, YouTube and the weather' : `Up to date: ${counts.join(', ') || 'built-in ideas only'}`,
      'aria-label': busy ? 'Syncing' : 'Refresh online sources',
      'aria-busy': String(busy),
      disabled: busy,
      onclick: refresh,
    },
    icon(busy ? 'loader-circle' : 'refresh-cw', busy ? 'spin' : ''),
  );
  tags.replaceChildren(weather, sync);
}

function refresh() {
  renderTags({ ...lastOnline, loading: true });
  api.refresh().catch((e) => toast(errText(e), 'error'));
}

window.addEventListener('error', (e) => toast(`Something broke: ${e.message}`, 'error', 6000));
window.addEventListener('unhandledrejection', (e) => toast(errText(e.reason), 'error', 6000));

/** Shows the Tickets tab to admins only (the database decides who is one), with its count. */
async function refreshAdmin() {
  const tab = document.getElementById('tickets-tab');
  let admin = false;
  try {
    admin = await api.supportIsAdmin();
  } catch {
    admin = false;
  }
  tab.hidden = !admin;
  if (!admin) {
    if (document.body.dataset.view === 'tickets') goto('discover');
    return;
  }
  ctx.setTickets(await ticketsView.openCount());
}

async function start() {
  startI18n();
  hydrateIcons();
  await watchGameInvites(({ kind, id }) => {
    if (kind === 'pick') goto('friends', { tab: 'friends', inviteId: id });
    else goto('games', { invitation: { kind, id } });
  });
  // Evening reminders you asked for (kept on this device, checked while the app is open).
  watchReminders();
  if (!inTauri) await (await import('./web-app.js')).initWebApp();
  await Promise.all([loadPhotos(), loadSupport()]);
  renderMe();
  let boot = await api.bootstrap();
  let after = 'discover';
  if (boot.setup.needs_welcome) {
    after = await runWelcome(boot, ctx);
    boot = await api.bootstrap();
    renderMe();
  }
  city = boot.setup.city;
  renderTags(boot.online);
  discover.init(views.discover, boot, ctx);
  document.body.dataset.view = 'discover';
  mountAssistant(ctx);
  refreshAdmin();
  // A surprise left for this account (shown once, over the app).
  checkSurprise();
  if (after === 'profile') goto('settings', { focus: 'profile' });
  await listen('unread-updated', (n) => ctx.setUnread(n));
  // The live connection: messages and invites as soon as they're saved.
  await listen('live-status', (on) => (live = on));
  api.liveStatus().then((on) => (live = on)).catch(() => {});
  // A message was edited or got a reaction.
  await listen('message-changed', (e) => messagesView.onChanged(e));
  await listen('message-new', (e) => {
    if (messagesView.onLive(e)) return;
    if (!e.mine) {
      const badge = document.getElementById('unread-badge');
      ctx.setUnread((parseInt(badge.textContent, 10) || 0) + 1);
    }
  });
  const refreshInvites = async () => {
    if (!views.friends.hidden && friendsView.refreshInvites(views.friends, ctx)) return;
    try {
      const list = await api.invites();
      ctx.setInvites(list.filter((i) => i.direction === 'incoming' && i.status === 'pending').length);
    } catch {
      // The next check catches up.
    }
  };
  await listen('invites-changed', refreshInvites);
  await listen('invites-updated', (n) => ctx.setInvites(n));
  refreshInvites();
  await listen('friend-free-changed', () => discover.friendFreeChanged());
  // Quiz duels: a friend challenged you or played their side.
  gamesView.refreshDuelDot();
  const duelsChanged = () => gamesView.refreshGameList(views.games, ctx, 'duel');
  await listen('duels-changed', duelsChanged);
  document.addEventListener('duel-played', () => gamesView.refreshDuelDot());
  // Games with friends: an open game window follows along; the list and the dot catch up.
  gamesView.refreshMatchDot();
  await listen('matches-changed', () => {
    document.dispatchEvent(new CustomEvent('matches-changed'));
    gamesView.refreshGameList(views.games, ctx, 'match');
  });
  await listen('game-ranking-changed', (game) => {
    if (!views.games.hidden) {
      views.games.querySelector('.game-ranking')?.dispatchEvent(new CustomEvent('game-ranking-changed', { detail: game }));
    }
  });
  await watchUpdates();
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
