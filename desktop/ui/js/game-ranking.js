import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, emptyState, fill, h } from './dom.js';
import { GAME_INFO } from './play/screen.js';
import { globalSwitch } from './ranked.js';

const games = [...Object.entries(GAME_INFO).map(([id, game]) => [id, game.name]), ['quiz-duel', 'Quiz duel']];
let game = games[0][0];
let scope = 'friends';

function boardRow(row) {
  const stat = (label, value) => h('span', {}, h('span', {}, label), ' ', h('b', { class: 'figures' }, value));
  return h(
    'li',
    { class: `board-row${row.me ? ' me' : ''}` },
    h('span', { class: `place${row.rank <= 3 ? ` place-${row.rank}` : ''}` }, row.rank),
    avatar({ icon: row.avatar_icon, color: row.avatar_color }, 'sm'),
    h('div', { class: 'game-board-player' },
      h('div', { class: 'game-board-name' },
        h('span', { class: 'board-name', translate: 'no' }, row.display_name),
        row.me ? h('span', { class: 'board-you' }, 'You') : null),
      h('div', { class: 'game-board-stats' }, stat('Wins', row.wins), stat('Draws', row.draws), stat('Losses', row.losses))),
    h('span', { class: 'board-points figures' }, `${row.points} pts`),
  );
}

export async function renderGameRanking(box, ctx) {
  let request = 0;
  let displayed = false;
  const gameSelect = h('select', { class: 'input', 'aria-label': 'Game', onchange: () => {
    game = gameSelect.value;
    load();
  } }, games.map(([id, label]) => h('option', { value: id }, label)));
  gameSelect.value = game;
  const scopeTabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Ranking' },
    [['friends', 'Friends'], ['global', 'Worldwide']].map(([id, label]) => h('button', {
      class: 'seg-btn', type: 'button', 'aria-pressed': String(id === scope), onclick: (event) => {
        if (scope === id) return;
        scope = id;
        for (const button of scopeTabs.children) button.setAttribute('aria-pressed', String(button === event.currentTarget));
        load();
      },
    }, label)),
  );
  const controls = h('div', { class: 'game-board-controls', hidden: true }, gameSelect, scopeTabs,
    btn({ label: 'Refresh', icon: 'refresh-cw', small: true, square: true, onclick: () => load() }));
  const body = h('div', { class: 'game-board-body' }, h('p', { class: 'hint', role: 'status' }, 'Loading…'));
  fill(box,
    h('div', { class: 'board-head' }, h('h2', { tabindex: -1 }, 'Game rankings'), controls),
    body,
  );

  async function load({ quiet = false } = {}) {
    const current = ++request;
    const selection = scope;
    quiet &&= displayed;
    if (!quiet) {
      displayed = false;
      fill(body, h('p', { class: 'hint', role: 'status' }, 'Loading…'));
    }
    try {
      const view = await api.gameLeaderboard(game, selection);
      if (current !== request || !box.isConnected) return;
      displayed = true;
      fill(body,
        selection === 'global' ? globalSwitch(view, () => load({ quiet: true }),
          'Your name, avatar and results appear in global game rankings. This setting also enables the activity ranking and Meet.') : null,
        view.rows.length
          ? h('ol', { class: 'board game-board' }, view.rows.map(boardRow))
          : h('p', { class: 'hint', role: 'status' }, 'No completed games in this ranking yet.'),
        h('p', { class: 'hint game-board-rule' }, 'Online games against other players count. A win earns 3 points and a draw earns 1.'),
      );
    } catch {
      if (current !== request || !box.isConnected || quiet) return;
      fill(body, emptyState({ icon: 'triangle-alert', title: 'Could not load the game ranking', actions: [
        btn({ label: 'Try again', small: true, onclick: () => load() }),
      ] }));
    }
  }

  try {
    const { signed_in } = await api.accountStatus();
    if (!box.isConnected) return;
    if (!signed_in) {
      fill(body, emptyState({ icon: 'trophy', title: 'Sign in to see game rankings',
        actions: [btn({ label: 'Go to profile', icon: 'log-in', small: true, onclick: () => ctx.goto('settings', { focus: 'profile' }) })] }));
      return;
    }
  } catch {
    fill(body, emptyState({ icon: 'triangle-alert', title: 'Could not load the game ranking',
      actions: [btn({ label: 'Try again', small: true, onclick: () => renderGameRanking(box, ctx) })] }));
    return;
  }
  controls.hidden = false;
  box.addEventListener('game-ranking-changed', (event) => {
    if (event.detail === game) load({ quiet: true });
  });
  await load();
}
