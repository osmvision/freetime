import { api, listen } from './api.js';
import { avatar } from './avatars.js';
import { btn, h, icon } from './dom.js';
import { GAME_INFO } from './play/screen.js';
import { when } from './together.js';

async function details({ kind, id }) {
  if (kind === 'pick') {
    const invite = (await api.invites()).find((i) =>
      String(i.id) === id && i.direction === 'incoming' && i.status === 'pending');
    return invite && {
      name: invite.other_name, game: invite.title, time: when(invite.starts_at),
      who: { id: invite.other, icon: invite.other_icon, color: invite.other_color },
    };
  }
  if (kind === 'match') {
    const match = (await api.myMatches()).find((m) => m.id === id && m.me === 1 && m.phase !== 'over' && !m.b_moved);
    const game = GAME_INFO[match?.game];
    return game && {
      name: match.other.display_name, game: game.name,
      who: { id: match.other.id, icon: match.other.avatar_icon, color: match.other.avatar_color },
    };
  }
  const duel = (await api.myDuels()).find((d) => d.id === id && !d.challenger && d.state === 'your_turn');
  return duel && {
    name: duel.other.display_name, game: 'Quiz duel',
    who: { id: duel.other.id, icon: duel.other.avatar_icon, color: duel.other.avatar_color },
  };
}

export function watchGameInvites(open) {
  const box = document.getElementById('toasts');
  const seen = new Set();
  const pending = [];
  let loading = false;
  let card;
  let timer;
  const canShow = () => !document.hidden && !document.querySelector('body > .quiz-backdrop');

  function dismiss() {
    clearTimeout(timer);
    card?.remove();
    card = undefined;
    showNext();
  }

  function updateTimer() {
    clearTimeout(timer);
    if (card && canShow() && !card.matches(':hover, :focus-within')) {
      timer = setTimeout(dismiss, 9000);
    }
  }

  async function showNext() {
    if (card || loading || !pending.length || !canShow()) return;
    const invitation = pending.shift();
    loading = true;
    const info = await details(invitation).catch(() => null);
    loading = false;
    if (!canShow()) {
      if (info) pending.unshift(invitation);
      return;
    }
    if (!info) {
      showNext();
      return;
    }
    card = h(
      'div',
      { class: 'toast game-invite-toast', onpointerenter: updateTimer, onpointerleave: updateTimer,
        onfocusin: updateTimer, onfocusout: () => queueMicrotask(updateTimer) },
      info.who ? avatar(info.who, 'sm') : h('span', { class: 'game-invite-icon' }, icon('gamepad-2')),
      h('div', { class: 'game-invite-copy' },
        h('strong', {}, h('span', { translate: 'no' }, info.name), ' ', h('span', {}, 'invites you to play')),
        h('div', { class: 'game-invite-detail' },
          h('span', { translate: invitation.kind === 'pick' ? 'no' : null }, info.game),
          info.time ? [' · ', h('span', {}, info.time)] : null),
        btn({
          label: 'View invitation', small: true, onclick: () => {
            open(invitation);
            dismiss();
          },
        }),
      ),
      btn({ label: 'Close', icon: 'x', square: true, small: true, kind: 'quiet', onclick: dismiss }),
    );
    box.append(card);
    updateTimer();
  }

  const resume = () => {
    updateTimer();
    showNext();
  };
  document.addEventListener('visibilitychange', resume);
  new MutationObserver(resume).observe(document.body, { childList: true });
  return listen('game-invite-new', (invitation) => {
    const key = `${invitation.kind}:${invitation.id}`;
    if (seen.has(key)) return;
    if (seen.size === 100) seen.delete(seen.values().next().value);
    seen.add(key);
    pending.push(invitation);
    showNext();
  });
}
