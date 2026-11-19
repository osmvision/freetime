// Friends' feed: what you and your friends shared in the last 7 days, with quick reactions.
// Sharing is on purpose: after a 👍 the app asks (or always/never, in Settings). Friends only;
// posts disappear after 30 days; reaction counts are shown to the author only.

import { api } from './api.js';
import { avatar } from './avatars.js';
import { btn, categoryIcon, emptyState, errText, fill, h, icon, toast } from './dom.js';
import { locale } from './i18n.js';
import { photo } from './photos.js';

const EMOJI = [
  ['fire', '🔥'],
  ['laugh', '😂'],
  ['eyes', '👀'],
  ['clap', '🙌'],
];

const KIND = {
  pick: ['ticket', 'Did an idea'],
  quiz: ['graduation-cap', 'Today’s quiz'],
  badge: ['award', 'New badge'],
};

function ago(iso) {
  const secs = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  for (const [unit, n] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(secs) >= n) return rtf.format(Math.round(secs / n), unit);
  }
  return rtf.format(0, 'minute');
}

function reactions(p) {
  if (p.own) {
    const counts = EMOJI.filter(([id]) => p.counts?.[id]).map(([id, e]) => h('span', { class: 'react-count' }, e, h('b', { class: 'figures' }, String(p.counts[id]))));
    return h('div', { class: 'reactions' }, counts.length ? counts : h('span', { class: 'mini-sub' }, 'No reactions yet'));
  }
  const mine = new Set(p.mine ?? []);
  return h(
    'div',
    { class: 'reactions', role: 'group', 'aria-label': 'React' },
    EMOJI.map(([id, e]) => {
      const b = h('button', { type: 'button', class: 'react', 'aria-pressed': String(mine.has(id)), 'aria-label': id }, e);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const on = await api.toggleReaction(p.id, id);
          b.setAttribute('aria-pressed', String(on));
        } catch (err) {
          toast(errText(err), 'error');
        } finally {
          b.disabled = false;
        }
      });
      return b;
    }),
  );
}

function postCard(p, ctx, reload) {
  const [kindIcon, kindLabel] = KIND[p.kind] ?? KIND.pick;
  const thumb = p.idea_id?.startsWith('idea:') ? h('div', { class: 'feed-photo' }, photo({ id: p.idea_id, category: p.category, title: p.title })) : h('div', { class: 'feed-photo feed-icon' }, icon(p.kind === 'pick' ? categoryIcon(p.category) : kindIcon));
  return h(
    'li',
    { class: `feed-post${p.own ? ' own' : ''}` },
    h(
      'div',
      { class: 'feed-head' },
      avatar({ icon: p.avatar_icon, color: p.avatar_color }, 'sm'),
      h('span', { class: 'feed-who', translate: 'no' }, p.own ? '' : p.display_name),
      p.own ? h('span', { class: 'feed-who' }, 'You') : null,
      h('span', { class: 'feed-when' }, ago(p.created_at)),
      p.own
        ? btn({
            label: 'Delete this post',
            icon: 'trash-2',
            kind: 'quiet',
            small: true,
            square: true,
            onclick: async () => {
              try {
                await api.deletePost(p.id);
                reload();
              } catch (e) {
                toast(errText(e), 'error');
              }
            },
          })
        : null,
    ),
    h(
      'div',
      { class: 'feed-body' },
      thumb,
      h(
        'div',
        { class: 'feed-text' },
        h('span', { class: 'mini-k' }, icon(kindIcon), kindLabel),
        // Idea titles go through the ideas dictionary (protected); badge titles through the normal one.
        h('strong', { class: p.kind === 'badge' ? 'feed-what feed-badge' : 'feed-what' }, p.title),
        p.detail ? h('span', { class: 'feed-detail figures' }, p.detail) : null,
      ),
    ),
    reactions(p),
  );
}

export async function renderFeed(box, ctx) {
  fill(box, h('div', { class: 'ghost', style: 'height:160px;margin-bottom:14px' }), h('div', { class: 'ghost', style: 'height:160px' }));
  let posts;
  try {
    posts = await api.friendFeed();
  } catch (e) {
    fill(box, emptyState({ icon: 'triangle-alert', title: 'Could not load the feed', text: errText(e), actions: [btn({ label: 'Try again', onclick: () => renderFeed(box, ctx) })] }));
    return;
  }
  const reload = () => renderFeed(box, ctx);
  if (!posts.length) {
    fill(
      box,
      emptyState({
        icon: 'sparkles',
        title: 'Nothing new yet',
        text: 'When you love a pick (👍) or finish the quiz, share it: your friends see it here, and you see theirs.',
        actions: [btn({ label: 'Find something to do', icon: 'compass', kind: 'primary', onclick: () => ctx.goto('discover') })],
      }),
    );
    return;
  }
  fill(
    box,
    h('ol', { class: 'feed' }, posts.map((p) => postCard(p, ctx, reload))),
    h('p', { class: 'feed-end' }, icon('check'), 'You’re up to date. The feed shows the last 7 days.'),
  );
}

// ---------------------------------------------------------------- sharing

let prefs = null;
let prompt = null;

export const invalidatePrefs = () => (prefs = null);

async function share(item, quiet = false) {
  try {
    await api.sharePost(item);
    if (!quiet) toast('Shared with your friends', 'ok');
  } catch (e) {
    toast(errText(e), 'error');
  }
}

/** After a 👍: share with friends, depending on Settings (ask, always, never). Signed in only. */
export async function offerShare(item) {
  try {
    const status = await api.accountStatus();
    if (!status.signed_in) return;
    prefs ??= await api.socialPrefs();
  } catch {
    return;
  }
  if (prefs.share_activity === 'never') return;
  if (prefs.share_activity === 'always') return share(item, false);
  prompt?.remove();
  const close = () => prompt?.remove();
  prompt = h(
    'aside',
    { class: 'update-notice share-prompt', role: 'status' },
    icon('sparkles'),
    h(
      'div',
      { class: 'update-text' },
      h('strong', {}, 'Share it with your friends?'),
      h('span', { class: 'share-title' }, item.title),
      h(
        'div',
        { class: 'row' },
        btn({ label: 'Share', icon: 'send', kind: 'primary', small: true, onclick: () => { close(); share(item); } }),
        btn({ label: 'Not this time', kind: 'quiet', small: true, onclick: close }),
        btn({
          label: 'Always share',
          kind: 'quiet',
          small: true,
          onclick: async () => {
            close();
            try {
              prefs = await api.setSocialPrefs({ ...prefs, share_activity: 'always' });
            } catch {
              // Kept as "ask".
            }
            share(item);
          },
        }),
      ),
    ),
  );
  document.body.append(prompt);
  setTimeout(close, 20000);
}
