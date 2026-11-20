// Messages: direct chats with friends. Conversations on the left, the open chat on the right.
// While a chat is open and the window is visible, new messages are fetched every 3 seconds;
// nothing is fetched when you leave this screen. Messages are always shown as plain text.

import { api } from './api.js';
import { locale } from './i18n.js';
import { avatar } from './avatars.js';
import { btn, emptyState, errText, fill, h, icon, pageHead, toast } from './dom.js';

const POLL_MS = 3000;
const LIST_MS = 20000;

let timer = null;
let listTimer = null;
let ctxRef = null;
let state = null; // { me, friends: Map, conversations: [], current: { conversation, friend, lastId, seen:Set } }
let els = {};

let active = false;

/** Leaving the screen stops all polling. */
export function stop() {
  clearInterval(timer);
  clearInterval(listTimer);
  timer = null;
  listTimer = null;
  active = false;
  if (state) state.current = null;
}

/**
 * A message from the live connection. Returns false when this screen isn't showing (the caller
 * then updates the badge). Duplicates (your own message, already shown) are skipped by id.
 */
export function onLive({ message: m, mine }) {
  if (!active || !state) return false;
  const conv = state.conversations.find((c) => c.conversation_id === m.conversation_id);
  if (!conv) {
    // A conversation this list doesn't know yet (a friend's first message): reload the list.
    refreshList();
    return true;
  }
  if (state.current?.conversation === m.conversation_id) {
    append([m]);
  } else if (!mine) {
    conv.unread += 1;
  }
  Object.assign(conv, { last_body: m.body, last_sender: m.sender, last_at: m.created_at });
  state.conversations.sort((a, b) => (b.last_at ?? '').localeCompare(a.last_at ?? ''));
  drawList();
  updateBadge();
  return true;
}

export async function render(root, ctx, options = {}) {
  stop();
  ctxRef = ctx;
  const status = await api.accountStatus().catch(() => ({ signed_in: false }));
  if (!status.signed_in) {
    root.replaceChildren(
      pageHead('Messages', 'Talk with your friends.'),
      emptyState({
        icon: 'message-circle',
        title: 'Sign in to message your friends',
        text: 'Messages need an online profile. It is optional, and everything else works without it.',
        actions: [btn({ label: 'Go to profile', icon: 'log-in', kind: 'primary', onclick: () => ctx.goto('settings', { focus: 'profile' }) })],
      }),
    );
    return;
  }
  root.replaceChildren(h('div', { class: 'ghost', style: 'height:480px' }));
  let data;
  try {
    data = await api.socialOverview();
  } catch (e) {
    root.replaceChildren(pageHead('Messages'), emptyState({ icon: 'triangle-alert', title: 'Could not load your messages', text: errText(e), actions: [btn({ label: 'Try again', onclick: () => render(root, ctx, options) })] }));
    return;
  }
  state = {
    me: data.me,
    friends: new Map(data.friends.filter((f) => f.state === 'friend').map((f) => [f.user_id, f])),
    conversations: data.conversations,
    current: null,
  };
  els = {
    list: h('nav', { class: 'chat-list', 'aria-label': 'Conversations' }),
    pane: h('section', { class: 'chat-pane' }),
  };
  root.replaceChildren(h('div', { class: 'chat-layout' }, els.list, els.pane));
  drawList();
  updateBadge();

  if (!state.friends.size) {
    fill(els.pane, emptyState({ icon: 'users', title: 'No friends to message yet', text: 'Add a friend by their tag first.', actions: [btn({ label: 'Go to Friends', icon: 'user-plus', onclick: () => ctx.goto('friends') })] }));
  } else if (options.friend && state.friends.has(options.friend)) {
    openFriend(options.friend);
  } else {
    fill(els.pane, h('div', { class: 'chat-empty' }, icon('message-circle'), h('p', {}, 'Pick a friend to start talking.')));
  }
  listTimer = setInterval(refreshList, LIST_MS);
  active = true;
}

// ---------------------------------------------------------------- the list

function drawList() {
  const byFriend = new Map(state.conversations.map((c) => [c.friend, c]));
  const rows = [...state.friends.values()].sort((a, b) => {
    const ca = byFriend.get(a.user_id);
    const cb = byFriend.get(b.user_id);
    return (cb?.last_at ?? '').localeCompare(ca?.last_at ?? '') || a.display_name.localeCompare(b.display_name);
  });
  fill(
    els.list,
    h('h2', { class: 'chat-list-title' }, 'Messages'),
    rows.map((f) => {
      const c = byFriend.get(f.user_id);
      const active = state.current?.friend === f.user_id;
      const unread = active ? 0 : (c?.unread ?? 0);
      const preview = c?.last_body ? `${c.last_sender === state.me ? 'You: ' : ''}${c.last_body.replace(/\s+/g, ' ')}` : 'Say hi';
      return h(
        'button',
        { type: 'button', class: 'chat-row', 'aria-current': active ? 'true' : null, onclick: () => openFriend(f.user_id) },
        avatar({ icon: f.avatar_icon, color: f.avatar_color, userId: f.user_id }, 'sm'),
        h('span', { class: 'chat-row-text' }, h('span', { class: 'chat-row-name' }, f.display_name), h('span', { class: 'chat-row-preview' }, preview)),
        unread ? h('span', { class: 'chat-unread', 'aria-label': `${unread} unread` }, unread > 99 ? '99+' : String(unread)) : null,
      );
    }),
  );
}

async function refreshList() {
  if (document.hidden || !state) return;
  try {
    const data = await api.socialOverview();
    state.me = data.me;
    state.friends = new Map(data.friends.filter((f) => f.state === 'friend').map((f) => [f.user_id, f]));
    state.conversations = data.conversations;
    drawList();
    updateBadge();
  } catch {
    // Next round.
  }
}

function updateBadge() {
  const total = state.conversations.filter((c) => c.friend !== state.current?.friend).reduce((n, c) => n + c.unread, 0);
  ctxRef?.setUnread?.(total);
}

// ---------------------------------------------------------------- the open chat

async function openFriend(friendId) {
  clearInterval(timer);
  const friend = state.friends.get(friendId);
  if (!friend) return;
  let conversation = state.conversations.find((c) => c.friend === friendId)?.conversation_id;
  try {
    conversation ??= await api.openChat(friendId);
  } catch (e) {
    toast(errText(e), 'error');
    return;
  }
  state.current = { conversation, friend: friendId, lastId: 0, seen: new Set(), lastDay: null, theirs: [] };
  const conv = state.conversations.find((c) => c.conversation_id === conversation);
  if (conv) conv.unread = 0;
  drawList();
  updateBadge();

  els.log = h('div', { class: 'chat-messages', role: 'log', 'aria-live': 'polite', 'aria-label': `Messages with ${friend.display_name}` });
  els.input = h('textarea', { class: 'chat-input', rows: 1, maxlength: 2000, placeholder: `Message ${friend.display_name}`, 'aria-label': `Message ${friend.display_name}` });
  els.send = btn({ label: 'Send', icon: 'send', kind: 'primary', onclick: send });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
  });
  const reportForm = reportBox(friend);
  fill(
    els.pane,
    h(
      'header',
      { class: 'chat-head' },
      avatar({ icon: friend.avatar_icon, color: friend.avatar_color, userId: friend.user_id }),
      h('div', { class: 'entry-main' }, h('div', { class: 'entry-title' }, friend.display_name), friend.status_text ? h('div', { class: 'entry-sub' }, friend.status_text) : null),
      h(
        'div',
        { class: 'head-tools' },
        btn({
          label: `Report ${friend.display_name}`,
          icon: 'flag',
          kind: 'quiet',
          small: true,
          square: true,
          onclick: () => {
            reportForm.hidden = !reportForm.hidden;
          },
        }),
        blockButton(friend),
      ),
    ),
    reportForm,
    els.log,
    h('div', { class: 'chat-compose' }, els.input, els.send),
  );
  els.input.focus();

  try {
    append(await api.chatMessages(conversation, 0));
    if (!state.current.seen.size) fill(els.log, h('div', { class: 'chat-empty' }, h('p', {}, `This is the start of your chat with ${friend.display_name}.`)));
  } catch (e) {
    fill(els.log, h('p', { class: 'hint' }, errText(e)));
  }
  timer = setInterval(poll, POLL_MS);
}

async function poll() {
  const cur = state?.current;
  if (!cur || document.hidden) return;
  // With the live connection up, messages arrive by themselves: only a safety check every 30 s.
  if (ctxRef?.isLive?.() && Date.now() - (cur.lastPoll ?? 0) < 30000) return;
  cur.lastPoll = Date.now();
  try {
    const fresh = await api.chatMessages(cur.conversation, cur.lastId);
    if (state.current === cur) append(fresh);
  } catch {
    // Next round.
  }
}

function append(messages) {
  const cur = state.current;
  const news = messages.filter((m) => !cur.seen.has(m.id));
  if (!news.length) return;
  if (!cur.seen.size) els.log.replaceChildren();
  const atBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80;
  for (const m of news) {
    cur.seen.add(m.id);
    cur.lastId = Math.max(cur.lastId, m.id);
    const when = new Date(m.created_at);
    const day = when.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
    if (day !== cur.lastDay) {
      cur.lastDay = day;
      els.log.append(h('div', { class: 'chat-day' }, day));
    }
    const mine = m.sender === state.me;
    if (!mine) cur.theirs.push(m.id);
    els.log.append(
      h(
        'div',
        { class: mine ? 'bubble mine' : 'bubble' },
        h('div', { class: 'bubble-text' }, m.body),
        h('div', { class: 'bubble-time' }, when.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })),
      ),
    );
  }
  if (atBottom || news.some((m) => m.sender === state.me)) els.log.scrollTop = els.log.scrollHeight;
  api.markRead(cur.conversation, cur.lastId).catch(() => {});
}

// ---------------------------------------------------------------- report and block

const REASONS = [
  ['harassment', 'Harassment'],
  ['spam', 'Spam'],
  ['hate', 'Hate'],
  ['sexual', 'Sexual content'],
  ['violence', 'Violence or threats'],
  ['self_harm', 'Self-harm'],
  ['impersonation', 'Pretending to be someone'],
  ['other', 'Something else'],
];

/** The report form: a reason, optional details, and optionally their last messages. */
function reportBox(friend) {
  let reason = null;
  const reasons = h('div', { class: 'reasons', role: 'group', 'aria-label': 'Reason' });
  const paint = () =>
    reasons.replaceChildren(
      ...REASONS.map(([id, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(reason === id), onclick: () => { reason = id; paint(); } }, label),
      ),
    );
  paint();
  const details = h('input', { class: 'input', type: 'text', maxlength: 500, placeholder: 'What happened? (optional)', 'aria-label': 'Details' });
  const attach = h('input', { type: 'checkbox', checked: true });
  const box = h(
    'div',
    { class: 'report-form', hidden: true },
    h('strong', {}, `Report ${friend.display_name} to the freetime team`),
    reasons,
    details,
    h('label', { class: 'check' }, attach, 'Attach their last 10 messages from this chat, so the team can see what happened'),
    h(
      'div',
      { class: 'row' },
      btn({
        label: 'Send report',
        icon: 'flag',
        kind: 'primary',
        small: true,
        onclick: async () => {
          if (!reason) return toast('Pick a reason first');
          const ids = attach.checked ? state.current?.theirs.slice(-10) ?? [] : [];
          try {
            await api.reportUser(friend.user_id, reason, details.value, ids);
            toast('Report sent. Thank you: the freetime team will look at it.', 'ok', 6000);
            box.hidden = true;
          } catch (e) {
            toast(errText(e), 'error', 6000);
          }
        },
      }),
      btn({ label: 'Cancel', kind: 'quiet', small: true, onclick: () => (box.hidden = true) }),
    ),
    h('span', { class: 'hint' }, `${friend.display_name} isn’t told who reported them. You can also block them.`),
  );
  return box;
}

/** Block, with a second click to confirm. Ends the friendship and stops messages both ways. */
function blockButton(friend) {
  const b = btn({ label: `Block ${friend.display_name}`, icon: 'ban', kind: 'quiet', small: true, square: true });
  let armed = null;
  b.addEventListener('click', async () => {
    if (!armed) {
      b.classList.add('armed');
      b.title = 'Click again to block';
      armed = setTimeout(() => {
        armed = null;
        b.classList.remove('armed');
        b.title = `Block ${friend.display_name}`;
      }, 4000);
      return;
    }
    clearTimeout(armed);
    try {
      await api.blockUser(friend.user_id);
      toast(`${friend.display_name} is blocked`, 'ok');
      clearInterval(timer);
      state.current = null;
      fill(els.pane, h('div', { class: 'chat-empty' }, icon('ban'), h('p', {}, `${friend.display_name} is blocked. You won’t get their messages or requests.`)));
      refreshList();
    } catch (e) {
      toast(errText(e), 'error');
    }
  });
  return b;
}

async function send() {
  const cur = state?.current;
  const body = els.input.value;
  if (!cur || !body.trim()) return;
  els.send.disabled = true;
  try {
    const m = await api.sendMessage(cur.conversation, body);
    els.input.value = '';
    els.input.style.height = 'auto';
    if (state.current === cur) append([m]);
    const conv = state.conversations.find((c) => c.conversation_id === cur.conversation);
    if (conv) Object.assign(conv, { last_body: m.body, last_sender: state.me, last_at: m.created_at });
    else state.conversations.unshift({ conversation_id: cur.conversation, friend: cur.friend, last_body: m.body, last_sender: state.me, last_at: m.created_at, unread: 0 });
    drawList();
  } catch (e) {
    const text = errText(e);
    toast(/row-level security/.test(text) ? 'You can’t message this person any more.' : text, 'error', 6000);
  } finally {
    els.send.disabled = false;
    els.input.focus();
  }
}
