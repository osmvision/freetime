// Messages with friends and private groups. Conversations on the left, the open chat on the right.
// While a chat is open and the window is visible, new messages are fetched every 3 seconds;
// nothing is fetched when you leave this screen. Messages are always shown as plain text.

import { api } from './api.js';
import { locale, t } from './i18n.js';
import { avatar } from './avatars.js';
import { btn, emptyState, errText, fill, h, icon, pageHead, toast } from './dom.js';
import { groupAvatar, groupEditor, groupMembers } from './message-groups.js';

const POLL_MS = 3000;
const LIST_MS = 20000;

let timer = null;
let listTimer = null;
let ctxRef = null;
let state = null; // { me, friends: Map, conversations, groups, current }
let els = {};

let active = false;
let viewRun = 0;
let openRun = 0;
let listRun = 0;

/** Leaving the screen stops all polling. */
export function stop() {
  viewRun++;
  stopChat();
  clearInterval(listTimer);
  listTimer = null;
  active = false;
}

function stopChat() {
  openRun++;
  clearInterval(timer);
  timer = null;
  if (state) state.current = null;
}

const allConversations = () => [...state.conversations, ...state.groups];
const byTime = (a, b) => (b?.last_at ?? '').localeCompare(a?.last_at ?? '');

/**
 * A message from the live connection. Returns false when this screen isn't showing (the caller
 * then updates the badge). Duplicates (your own message, already shown) are skipped by id.
 */
export function onLive({ message: m, mine }) {
  if (!active || !state) return false;
  const conv = allConversations().find((c) => c.conversation_id === m.conversation_id);
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
  drawList();
  updateBadge();
  return true;
}

export async function render(root, ctx, options = {}) {
  stop();
  const run = viewRun;
  ctxRef = ctx;
  const status = await api.accountStatus().catch(() => ({ signed_in: false }));
  if (run !== viewRun) return;
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
  let data, groups;
  try {
    [data, groups] = await Promise.all([api.socialOverview(), api.friendGroups().catch(() => [])]);
  } catch (e) {
    if (run !== viewRun) return;
    root.replaceChildren(pageHead('Messages'), emptyState({ icon: 'triangle-alert', title: 'Could not load your messages', text: errText(e), actions: [btn({ label: 'Try again', onclick: () => render(root, ctx, options) })] }));
    return;
  }
  if (run !== viewRun) return;
  state = {
    me: data.me,
    friends: new Map(data.friends.filter((f) => f.state === 'friend').map((f) => [f.user_id, f])),
    conversations: data.conversations,
    groups,
    current: null,
  };
  els = {
    list: h('nav', { class: 'chat-list', 'aria-label': 'Conversations' }),
    pane: h('section', { class: 'chat-pane' }),
  };
  root.replaceChildren(h('div', { class: 'chat-layout' }, els.list, els.pane));
  active = true;
  drawList();
  updateBadge();

  if (options.friend && state.friends.has(options.friend)) {
    openFriend(options.friend);
  } else {
    showEmpty();
  }
  listTimer = setInterval(refreshList, LIST_MS);
}

function showEmpty() {
  fill(els.pane, state.friends.size || state.groups.length
    ? h('div', { class: 'chat-empty' }, icon('message-circle'), h('p', {}, 'Pick a friend or a group to start talking.'))
    : emptyState({ icon: 'users', title: 'No friends to message yet', text: 'Add a friend by their tag first.',
      actions: [btn({ label: 'Go to Friends', icon: 'user-plus', onclick: () => ctxRef.goto('friends') })] }));
}

// ---------------------------------------------------------------- the list

function drawList() {
  const byFriend = new Map(state.conversations.map((c) => [c.friend, c]));
  const rows = [
    ...[...state.friends.values()].map((f) => ({
      conv: byFriend.get(f.user_id), name: f.display_name,
      selected: state.current?.friend === f.user_id, open: () => openFriend(f.user_id),
      look: avatar({ icon: f.avatar_icon, color: f.avatar_color, userId: f.user_id }, 'sm'),
    })),
    ...state.groups.map((g) => ({
      conv: g, name: g.name,
      selected: state.current?.group === g.conversation_id, open: () => openGroup(g.conversation_id),
      look: groupAvatar('sm'), group: true,
    })),
  ].sort((a, b) => byTime(a.conv, b.conv) || a.name.localeCompare(b.name));
  fill(
    els.list,
    h('div', { class: 'chat-list-head' },
      h('h2', { class: 'chat-list-title' }, 'Messages'),
      btn({ label: 'New group', icon: 'users', small: true, onclick: () => editGroup() }),
    ),
    rows.map(({ conv, selected, look, name, open, group }) => {
      const unread = selected ? 0 : (conv?.unread ?? 0);
      const preview = conv?.last_body
        ? `${conv.last_sender === state.me ? 'You: ' : ''}${conv.last_body.replace(/\s+/g, ' ')}`
        : group ? 'Group chat' : 'Say hi';
      return h(
        'button',
        { type: 'button', class: 'chat-row', 'aria-current': selected ? 'true' : null, onclick: open },
        look,
        h('span', { class: 'chat-row-text' }, h('span', { class: 'chat-row-name', translate: 'no' }, name), h('span', { class: 'chat-row-preview' }, preview)),
        unread ? h('span', { class: 'chat-unread', 'aria-label': `${unread} unread` }, unread > 99 ? '99+' : String(unread)) : null,
      );
    }),
  );
}

async function refreshList() {
  if (document.hidden || !state) return;
  const original = state;
  const run = ++listRun;
  try {
    const [data, groups] = await Promise.all([api.socialOverview(), api.friendGroups().catch(() => null)]);
    if (!active || state !== original || listRun !== run) return;
    state.me = data.me;
    state.friends = new Map(data.friends.filter((f) => f.state === 'friend').map((f) => [f.user_id, f]));
    state.conversations = data.conversations;
    if (groups) {
      state.groups = groups;
      if (state.current?.group) {
        const current = groups.find((g) => g.conversation_id === state.current.group);
        if (current) {
          els.chatTitle.textContent = current.name;
          els.groupEdit.hidden = !current.owned;
        } else {
          stopChat();
          showEmpty();
        }
      }
    }
    drawList();
    updateBadge();
  } catch {
    // Next round.
  }
}

function updateBadge() {
  const total = allConversations().filter((c) => c.conversation_id !== state.current?.conversation)
    .reduce((n, c) => n + c.unread, 0);
  ctxRef?.setUnread?.(total);
}

// ---------------------------------------------------------------- the open chat

async function openFriend(friendId) {
  const friend = state.friends.get(friendId);
  if (!friend) return;
  stopChat();
  const run = openRun;
  let conversation = state.conversations.find((c) => c.friend === friendId)?.conversation_id;
  try {
    conversation ??= await api.openChat(friendId);
  } catch (e) {
    if (run === openRun) {
      toast(errText(e), 'error');
      showEmpty();
    }
    return;
  }
  if (run === openRun) openConversation(conversation, { friend });
}

function openGroup(id) {
  const group = state.groups.find((g) => g.conversation_id === id);
  if (!group) return;
  stopChat();
  openConversation(id, { group });
}

function editGroup(group) {
  stopChat();
  drawList();
  const original = state;
  const run = openRun;
  fill(els.pane, groupEditor({
    group, friends: [...state.friends.values()], me: state.me,
    saved: async (id) => {
      await refreshList();
      if (!active || state !== original || openRun !== run) return;
      if (state.groups.some((g) => g.conversation_id === id)) openGroup(id);
      else {
        showEmpty();
        toast('Group saved', 'ok');
      }
    },
    cancel: () => {
      if (group && state.groups.some((g) => g.conversation_id === group.conversation_id)) openGroup(group.conversation_id);
      else showEmpty();
    },
  }));
  els.pane.querySelector('input')?.focus();
}

function groupActions(group, toggleMembers) {
  const latest = () => state.groups.find((g) => g.conversation_id === group.conversation_id);
  els.groupEdit = btn({ label: 'Edit group', icon: 'pencil', kind: 'quiet', small: true, square: true,
    onclick: () => { const current = latest(); if (current?.owned) editGroup(current); } });
  els.groupEdit.hidden = !group.owned;
  return [
    btn({ label: 'Group members', icon: 'users', kind: 'quiet', small: true, square: true, onclick: toggleMembers }),
    els.groupEdit,
    btn({ label: 'Leave group', icon: 'log-out', kind: 'quiet', small: true, square: true, onclick: async (event) => {
      if (!confirm(t('Leave this group?'))) return;
      const button = event.currentTarget;
      const original = state;
      button.disabled = true;
      try {
        await api.manageFriendGroup({ action: 'leave', id: group.conversation_id });
        if (!active || state !== original) return;
        listRun++;
        state.groups = state.groups.filter((g) => g.conversation_id !== group.conversation_id);
        if (state.current?.group === group.conversation_id) {
          stopChat();
          showEmpty();
        }
        drawList();
        updateBadge();
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        button.disabled = false;
      }
    } }),
  ];
}

async function openConversation(conversation, { friend, group }) {
  const current = {
    conversation, friend: friend?.user_id, group: group?.conversation_id,
    lastId: 0, seen: new Set(), lastDay: null, theirs: [],
  };
  state.current = current;
  const conv = allConversations().find((c) => c.conversation_id === conversation);
  if (conv) conv.unread = 0;
  drawList();
  updateBadge();

  const title = friend?.display_name ?? group.name;
  els.chatTitle = h('div', { class: 'entry-title', translate: 'no' }, title);
  const label = group ? 'Message the group' : `Message ${title}`;
  els.log = h('div', { class: 'chat-messages', role: 'log', 'aria-live': 'polite', 'aria-label': group ? 'Group chat' : `Messages with ${title}` });
  els.input = h('textarea', { class: 'chat-input', rows: 1, maxlength: 2000, placeholder: label, 'aria-label': label });
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
  let extras = friend ? reportBox(friend) : groupMembers(group);
  const actions = friend ? [
    btn({ label: `Report ${title}`, icon: 'flag', kind: 'quiet', small: true, square: true, onclick: () => { extras.hidden = !extras.hidden; } }),
    blockButton(friend),
  ] : groupActions(group, () => {
    if (!extras.hidden) {
      extras.hidden = true;
      return;
    }
    const latest = state.groups.find((g) => g.conversation_id === conversation);
    if (!latest) return;
    const members = groupMembers(latest);
    members.hidden = false;
    extras.replaceWith(members);
    extras = members;
  });
  fill(
    els.pane,
    h(
      'header',
      { class: 'chat-head' },
      friend ? avatar({ icon: friend.avatar_icon, color: friend.avatar_color, userId: friend.user_id }) : groupAvatar(),
      h('div', { class: 'entry-main' }, els.chatTitle,
        friend?.status_text ? h('div', { class: 'entry-sub' }, friend.status_text) : null),
      h('div', { class: 'head-tools' }, actions),
    ),
    extras,
    els.log,
    h('div', { class: 'chat-compose' }, els.input, els.send),
  );
  els.input.focus();

  try {
    const messages = await api.chatMessages(conversation, 0);
    if (state.current !== current) return;
    append(messages);
    if (!current.seen.size) fill(els.log, h('div', { class: 'chat-empty' },
      h('p', {}, group ? 'This is the start of your group chat.' : `This is the start of your chat with ${title}.`)));
  } catch (e) {
    if (state.current !== current) return;
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
  const group = state.groups.find((g) => g.conversation_id === cur.group);
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
    const sender = group && !mine ? group.members.find((member) => member.user_id === m.sender) : null;
    els.log.append(
      h(
        'div',
        { class: mine ? 'bubble mine' : 'bubble' },
        group && !mine ? h('div', { class: 'bubble-author', translate: sender ? 'no' : null }, sender?.display_name ?? 'Group member') : null,
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
  const { input, send: button } = els;
  if (!cur || button.disabled || !input.value.trim()) return;
  const body = input.value;
  const original = state;
  button.disabled = true;
  try {
    const m = await api.sendMessage(cur.conversation, body);
    if (!active || state !== original) return;
    input.value = '';
    input.style.height = 'auto';
    if (state.current === cur) append([m]);
    const conv = allConversations().find((c) => c.conversation_id === cur.conversation);
    if (conv) Object.assign(conv, { last_body: m.body, last_sender: state.me, last_at: m.created_at });
    else if (cur.friend) state.conversations.unshift({ conversation_id: cur.conversation, friend: cur.friend, last_body: m.body, last_sender: state.me, last_at: m.created_at, unread: 0 });
    drawList();
  } catch (e) {
    const text = errText(e);
    toast(/row-level security/.test(text)
      ? (cur.group ? 'You can’t send messages to this group any more.' : 'You can’t message this person any more.')
      : text, 'error', 6000);
  } finally {
    button.disabled = false;
    if (state.current === cur) input.focus();
  }
}
