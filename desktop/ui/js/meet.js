// Meet: people on freetime who chose to be visible (the same switch as the global ranking), newest
// first, with a one-tap friend request. The server only lists opted-in people, never friends,
// blocked people or yourself, and never shows email, bio or status
// (supabase/migrations/*_meet_and_quiz_duels.sql).

import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, emptyState, errText, fill, h, icon, toast } from './dom.js';
import { openCard } from './ranked.js';
import { INVITE, myTag } from './share.js';

export async function renderMeet(box, ctx) {
  fill(box, h('div', { class: 'ghost', style: 'height:90px;margin-bottom:18px' }), h('div', { class: 'ghost', style: 'height:320px' }));
  let v;
  try {
    v = await api.meetPeople();
  } catch (e) {
    fill(box, emptyState({ icon: 'triangle-alert', title: 'Could not load people', text: errText(e), actions: [btn({ label: 'Try again', onclick: () => renderMeet(box, ctx) })] }));
    return;
  }
  const reload = () => renderMeet(box, ctx);
  fill(
    box,
    visibility(v.visible, reload),
    h(
      'section',
      { class: 'panel meet' },
      h('h2', {}, v.people.length ? `People on freetime · ${v.people.length}` : 'People on freetime'),
      v.people.length
        ? h('ul', { class: 'meet-grid' }, v.people.map((p) => personCard(p, ctx)))
        : h(
            'div',
            { class: 'duels-empty' },
            icon('users'),
            h('strong', {}, 'Nobody to meet yet'),
            h('span', {}, 'freetime is new: be one of the first to be visible, and invite your friends with your link.'),
            inviteButton(),
          ),
    ),
  );
}

/** The opt-in, with what it shows. Stands out while you're hidden. */
function visibility(visible, reload) {
  const box = h('input', { type: 'checkbox', checked: visible });
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await api.setGlobalRanking(box.checked);
      toast(box.checked ? 'Others can find you now' : 'You’re hidden again', 'ok');
      reload();
    } catch (e) {
      box.checked = !box.checked;
      toast(errText(e), 'error');
    } finally {
      box.disabled = false;
    }
  });
  return h(
    'div',
    { class: `strip global-switch${visible ? '' : ' meet-hidden'}` },
    icon(visible ? 'eye' : 'user-plus'),
    h(
      'div',
      { class: 'strip-text' },
      h('label', { class: 'check' }, box, h('strong', {}, 'Let others find me (here and on the global ranking)')),
      h('span', {}, 'Others can see your name, avatar, activity ranking and game results, and send you a friend request.'),
    ),
  );
}

function personCard(p, ctx) {
  const action = h('div', { class: 'meet-action' });
  const show = (state) => {
    if (state === 'sent') fill(action, h('span', { class: 'meet-sent' }, icon('check'), 'Request sent'));
    else if (state === 'friends') fill(action, h('span', { class: 'meet-sent' }, icon('user-check'), 'Friends'));
    else
      fill(
        action,
        btn({
          label: state === 'received' ? 'Accept' : 'Add',
          icon: state === 'received' ? 'user-check' : 'user-plus',
          kind: 'primary',
          small: true,
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const r = await api.requestFriend(p.user_id);
              toast(r === 'accepted' ? `You and ${p.display_name} are friends` : `Request sent to ${p.display_name}`, 'ok');
              show(r === 'accepted' ? 'friends' : 'sent');
              if (r === 'accepted') ctx.friendsChanged?.();
            } catch (err) {
              toast(errText(err), 'error', 5000);
              e.currentTarget.disabled = false;
            }
          },
        }),
      );
  };
  show(p.request);
  return h(
    'li',
    { class: 'meet-card' },
    h(
      'button',
      { type: 'button', class: 'meet-who', title: 'See their card', onclick: () => openCard(p.user_id, ctx) },
      avatar({ icon: p.avatar_icon, color: p.avatar_color, userId: p.user_id }, 'lg'),
      h('strong', { translate: 'no' }, p.display_name),
      h(
        'span',
        { class: 'meet-facts' },
        p.new ? h('span', { class: 'meet-new' }, 'New') : null,
        h('span', { class: 'figures' }, `${p.points} pts`),
        p.badges ? h('span', {}, p.badges === 1 ? '1 badge' : `${p.badges} badges`) : null,
      ),
      p.request === 'received' ? h('span', { class: 'meet-asked' }, 'asked to be your friend') : null,
    ),
    action,
  );
}

function inviteButton() {
  return btn({
    label: 'Copy my invite link',
    icon: 'link',
    small: true,
    onclick: async () => {
      const tag = await myTag();
      if (!tag) return toast('Sign in first', 'error');
      try {
        await navigator.clipboard.writeText(INVITE(tag));
        toast('Invite link copied', 'ok');
      } catch {
        toast(INVITE(tag), 'info', 8000);
      }
    },
  });
}
