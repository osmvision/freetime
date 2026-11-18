// The chat assistant: a bubble at the bottom right of every screen that opens a chat panel.
// Answers come from Mistral through the Rust side (the API key never reaches this page) and
// stream in as `assistant-delta` events. The conversation is kept on this computer only.
//
// Text from the model is never put in as HTML: renderRich() builds the few formats it
// understands (paragraphs, lists, bold, italic, code, links) out of text nodes.

import { api, listen } from './api.js';
import { currentLang, t } from './i18n.js';
import { categoryIcon, errText, fill, h, icon, toast } from './dom.js';

const STORE = 'freetime.assistant.v1';
const CONSENT = 'freetime.assistant.consent';
const MOOD_KEY = 'freetime.mood.v2';
const KEEP = 60;

const STARTERS = [
  'What should I do with 30 minutes?',
  'Something to do with friends tonight',
  'A game I haven’t played in a while',
  'Something relaxing, away from screens',
];

const state = {
  open: false,
  messages: load(),
  /** The id of the answer being streamed, or null. */
  busy: null,
  /** { key_set, key_from_env, model } once asked. */
  status: null,
};

let els = null;
let ctx = null;
/** The message being streamed and the element its text goes in. */
let live = null;
let frame = 0;

// ---------------------------------------------------------------- storage

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(saved) ? saved.filter((m) => m && (m.role === 'user' || m.role === 'assistant')) : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    const kept = state.messages.filter((m) => !m.pending).slice(-KEEP);
    localStorage.setItem(STORE, JSON.stringify(kept));
  } catch {}
}

function consented() {
  try {
    return localStorage.getItem(CONSENT) === 'yes';
  } catch {
    return false;
  }
}

/** What Discover is set to, as the Request the Rust side expects (null = defaults for now). */
function mood() {
  try {
    const m = JSON.parse(localStorage.getItem(MOOD_KEY) ?? 'null');
    if (!m || typeof m.minutes !== 'number') return null;
    const { minutes, energy, with_friends, can_go_out, budget, categories } = m;
    return { minutes, energy, with_friends: Boolean(with_friends), can_go_out: Boolean(can_go_out), budget, categories };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the formats the model writes

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\[[^\]\s]+\]\]|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|(?<![\w*])\*[^*\s][^*\n]*\*(?!\w)|(?<!\w)_[^_\s][^_\n]*_(?!\w))/g;

function inline(text, ideas) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
    else if (t.startsWith('`')) out.push(h('code', {}, t.slice(1, -1)));
    else if (t.startsWith('[[')) out.push(ideaChip(t.slice(2, -2), ideas) ?? '');
    else if (t.startsWith('[')) {
      const [, label, url] = t.match(/^\[([^\]]+)\]\((.+)\)$/);
      out.push(h('button', { type: 'button', class: 'link', onclick: () => api.open(url).catch((e) => toast(errText(e), 'error')) }, label));
    } else out.push(h('em', {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Text as blocks: paragraphs, bullet and numbered lists, code blocks, and idea cards. */
export function renderRich(text, ideas = []) {
  const blocks = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) blocks.push(h('p', {}, inline(para.join(' '), ideas)));
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list.el);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flushPara();
      flushList();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i]);
      blocks.push(h('pre', {}, h('code', {}, code.join('\n'))));
      continue;
    }
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const card = trimmed.match(/^\[\[([^\]\s]+)\]\]$/);
    if (card) {
      flushPara();
      flushList();
      const el = ideaCard(card[1], ideas);
      if (el) blocks.push(el);
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      blocks.push(h('p', { class: 'assistant-heading' }, inline(heading[1], ideas)));
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const number = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || number) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (!list || list.kind !== kind) {
        flushList();
        // A card between two items ends the list: the next one keeps its own number.
        list = { kind, el: h(kind, { start: number && number[1] !== '1' ? number[1] : null }) };
      }
      const body = bullet ? bullet[1] : number[2];
      // A marker alone in a list item still becomes a card.
      const only = body.trim().match(/^\[\[([^\]\s]+)\]\]$/);
      list.el.append(h('li', {}, only ? ideaCard(only[1], ideas) ?? '' : inline(body, ideas)));
      continue;
    }
    flushList();
    para.push(trimmed);
  }
  flushPara();
  flushList();
  return blocks;
}

function findIdea(id, ideas) {
  return ideas.find((i) => i.id === id) ?? null;
}

async function startIdea(idea, button) {
  button.disabled = true;
  try {
    await api.pick(idea.id);
    toast('Enjoy. Next time freetime will ask how it went.', 'ok', 4200);
    if (idea.link) await api.open(idea.link);
  } catch (e) {
    toast(errText(e), 'error');
  } finally {
    button.disabled = false;
  }
}

function ideaCard(id, ideas) {
  const idea = findIdea(id, ideas);
  if (!idea) return null;
  // The bubble is kept out of the translation layer (it's the model's own words), so the
  // card's fixed labels are translated here.
  const go = h('button', { type: 'button', class: 'btn small primary' }, icon('play'), t('Start'));
  go.addEventListener('click', () => startIdea(idea, go));
  return h(
    'div',
    { class: 'assistant-idea' },
    h('span', { class: 'assistant-idea-icon' }, icon(categoryIcon(idea.category))),
    h('span', { class: 'assistant-idea-text' }, h('span', { class: 'assistant-idea-title', translate: 'no' }, idea.title), h('span', { class: 'assistant-idea-meta' }, `${t(idea.category_label)} · ${t(idea.duration)}`)),
    go,
  );
}

/** A marker in the middle of a sentence: just the title, as a link that starts it. */
function ideaChip(id, ideas) {
  const idea = findIdea(id, ideas);
  if (!idea) return null;
  const b = h('button', { type: 'button', class: 'link', translate: 'no' }, idea.title);
  b.addEventListener('click', () => startIdea(idea, b));
  return b;
}

// ---------------------------------------------------------------- drawing

function bubble(m, index) {
  if (m.role === 'user') {
    return h('div', { class: 'assistant-msg mine' }, h('div', { class: 'assistant-bubble', translate: 'no' }, m.content));
  }
  const body = h('div', { class: 'assistant-bubble rich', translate: 'no' });
  if (m.content) fill(body, renderRich(m.content, m.ideas ?? []));
  else if (m.pending) fill(body, h('span', { class: 'assistant-typing', 'aria-label': 'Writing' }, h('i'), h('i'), h('i')));
  const tools = [];
  if (!m.pending && m.content) {
    tools.push(
      h(
        'button',
        {
          type: 'button',
          class: 'assistant-tool',
          title: 'Copy',
          'aria-label': 'Copy the answer',
          onclick: () => navigator.clipboard.writeText(m.content).then(() => toast('Copied', 'ok', 1600)).catch(() => {}),
        },
        icon('copy'),
      ),
    );
  }
  if (m.error && index === state.messages.length - 1) {
    tools.push(h('button', { type: 'button', class: 'btn small', onclick: retry }, icon('rotate-ccw'), 'Try again'));
  }
  return h(
    'div',
    { class: 'assistant-msg' },
    m.content || m.pending ? body : null,
    m.stopped ? h('span', { class: 'assistant-note' }, 'Stopped') : null,
    m.error ? h('p', { class: 'assistant-error', role: 'alert' }, icon('triangle-alert'), h('span', {}, m.error)) : null,
    tools.length ? h('div', { class: 'assistant-tools' }, tools) : null,
  );
}

function intro() {
  const st = state.status;
  if (st && !st.key_set) {
    return h(
      'div',
      { class: 'assistant-intro' },
      icon('sparkles', 'assistant-intro-icon'),
      h('h3', {}, 'Your free-time assistant'),
      h('p', {}, 'Ask what to do, compare two ideas, or plan an evening with friends. It knows your picks, your mood and the weather.'),
      h('p', {}, 'To turn it on, add a Mistral API key in Settings.'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          // The panel would cover the section it opens.
          onclick: () => {
            setOpen(false);
            ctx?.goto('settings', { focus: 'assistant' });
          },
        },
        icon('sliders-horizontal'),
        'Open Settings',
      ),
    );
  }
  return h(
    'div',
    { class: 'assistant-intro' },
    icon('sparkles', 'assistant-intro-icon'),
    h('h3', {}, 'What would you like to do?'),
    h('p', {}, 'Ask anything about your free time. Ideas it recommends come with a Start button.'),
    h(
      'div',
      { class: 'assistant-starters' },
      // Sends the text as shown, so it goes out in the app's language.
      STARTERS.map((q) => h('button', { type: 'button', class: 'assistant-starter', onclick: (e) => send(e.currentTarget.textContent) }, q)),
    ),
  );
}

function notice() {
  if (consented() || (state.status && !state.status.key_set)) return null;
  return h(
    'div',
    { class: 'assistant-notice', role: 'note' },
    icon('info'),
    h(
      'p',
      {},
      'Your messages are sent to Mistral AI to answer, with a short context: the date, the weather, what you set on Discover, your interests and your current picks. Nothing is sent until you write.',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn small',
        onclick: () => {
          try {
            localStorage.setItem(CONSENT, 'yes');
          } catch {}
          drawLog();
          els.input.focus();
        },
      },
      'Got it',
    ),
  );
}

function nearBottom() {
  const l = els.log;
  return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
}

function drawLog() {
  const stick = nearBottom();
  live = null;
  const items = state.messages.map((m, i) => {
    const el = bubble(m, i);
    if (m.pending) live = { m, body: el.querySelector('.assistant-bubble') };
    return el;
  });
  fill(els.log, state.messages.length ? items : intro(), notice());
  if (!state.messages.length) els.log.scrollTop = 0;
  else if (stick || state.busy) els.log.scrollTop = els.log.scrollHeight;
  drawCompose();
}

function drawCompose() {
  const ready = state.status?.key_set;
  els.input.disabled = !ready;
  els.input.placeholder = ready ? 'Ask about your free time…' : 'Add a Mistral key in Settings first';
  fill(els.send, icon(state.busy ? 'square' : 'send'));
  els.send.setAttribute('aria-label', state.busy ? 'Stop' : 'Send');
  els.send.title = state.busy ? 'Stop' : 'Send (Enter)';
  els.send.classList.toggle('stop', Boolean(state.busy));
  els.send.disabled = !ready;
  els.reset.disabled = !state.messages.length || Boolean(state.busy);
  els.model.textContent = ready ? state.status.model : '';
}

/** Redraws only the answer being written, at most once a frame. */
function drawLive() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!live) return;
    const stick = nearBottom();
    fill(live.body, renderRich(live.m.content, live.m.ideas ?? []));
    if (stick) els.log.scrollTop = els.log.scrollHeight;
  });
}

function grow() {
  const t = els.input;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

// ---------------------------------------------------------------- talking

async function ask(answer) {
  const chat = crypto.randomUUID();
  state.busy = chat;
  answer.chat = chat;
  drawLog();
  const history = state.messages
    .filter((m) => m !== answer && !m.error && m.content)
    .map(({ role, content }) => ({ role, content }));
  try {
    const reply = await api.assistantSend(chat, history, mood(), currentLang());
    // The full text from the Rust side is the reference (events can arrive after the reply).
    answer.content = reply.text || answer.content;
    answer.ideas = reply.ideas;
    answer.stopped = reply.stopped;
    if (!answer.content && !reply.stopped) answer.error = 'No answer came back. Try again.';
  } catch (e) {
    answer.error = errText(e);
  } finally {
    answer.pending = false;
    delete answer.chat;
    state.busy = null;
    save();
    drawLog();
  }
}

function send(text) {
  const q = text.trim();
  if (!q || state.busy || !state.status?.key_set) return;
  try {
    localStorage.setItem(CONSENT, 'yes');
  } catch {}
  state.messages.push({ role: 'user', content: q });
  const answer = { role: 'assistant', content: '', ideas: [], pending: true };
  state.messages.push(answer);
  els.input.value = '';
  grow();
  ask(answer);
}

function retry() {
  const last = state.messages[state.messages.length - 1];
  if (!last?.error || state.busy) return;
  Object.assign(last, { content: '', error: null, stopped: false, pending: true });
  ask(last);
}

function stop() {
  if (state.busy) api.assistantStop(state.busy).catch(() => {});
}

function reset() {
  if (state.busy) return;
  state.messages = [];
  save();
  drawLog();
  els.input.focus();
}

// ---------------------------------------------------------------- opening and closing

async function refreshStatus() {
  try {
    state.status = await api.assistantStatus();
  } catch {
    state.status = { key_set: false, model: '' };
  }
  if (state.open) drawLog();
}

function setOpen(open) {
  const was = state.open;
  state.open = open;
  els.panel.hidden = !open;
  els.fab.setAttribute('aria-expanded', String(open));
  els.fab.setAttribute('aria-label', open ? 'Close the assistant' : 'Open the assistant');
  els.fab.title = open ? 'Close the assistant (Alt+A)' : 'Assistant (Alt+A)';
  fill(els.fab, icon(open ? 'x' : 'sparkles'));
  document.querySelector('.app')?.classList.toggle('assistant-open', open);
  if (open) {
    drawLog();
    refreshStatus().then(() => {
      if (state.open && !els.input.disabled) els.input.focus();
    });
  } else if (was) {
    els.fab.focus();
  }
}

/** Adds the bubble and the panel to the app. `context.goto` opens a screen. */
export function mountAssistant(context) {
  ctx = context;
  const app = document.querySelector('.app');
  const fab = h('button', { type: 'button', class: 'assistant-fab', 'aria-controls': 'assistant-panel', 'aria-expanded': 'false' });
  const input = h('textarea', { class: 'assistant-input', rows: 1, maxlength: 4000, 'aria-label': 'Message to the assistant' });
  const sendBtn = h('button', { type: 'submit', class: 'assistant-send' });
  const resetBtn = h('button', { type: 'button', class: 'assistant-tool', title: 'New chat', 'aria-label': 'New chat', onclick: reset }, icon('message-square-plus'));
  const model = h('span', { class: 'assistant-model', translate: 'no' });
  const log = h('div', { class: 'assistant-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with the assistant' });
  const form = h(
    'form',
    {
      class: 'assistant-compose',
      onsubmit: (e) => {
        e.preventDefault();
        if (state.busy) stop();
        else send(input.value);
      },
    },
    input,
    sendBtn,
  );
  const panel = h(
    'section',
    { class: 'assistant-panel', id: 'assistant-panel', role: 'dialog', 'aria-label': 'Assistant', hidden: true },
    h(
      'header',
      { class: 'assistant-head' },
      h('span', { class: 'assistant-mark' }, icon('sparkles')),
      h('div', { class: 'assistant-title' }, h('h2', {}, 'Assistant'), model),
      resetBtn,
      h('button', { type: 'button', class: 'assistant-tool', title: 'Close', 'aria-label': 'Close the assistant', onclick: () => setOpen(false) }, icon('x')),
    ),
    log,
    form,
  );
  els = { fab, panel, input, send: sendBtn, reset: resetBtn, model, log };

  fab.addEventListener('click', () => setOpen(!state.open));
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.busy) send(input.value);
    }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (state.busy) stop();
      else setOpen(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setOpen(!state.open);
    }
  });

  listen('assistant-delta', ({ chat, text }) => {
    const m = state.messages.find((x) => x.chat === chat);
    if (!m) return;
    m.content += text;
    drawLive();
  });
  listen('assistant-ideas', ({ chat, ideas }) => {
    const m = state.messages.find((x) => x.chat === chat);
    if (m) m.ideas = ideas;
  });

  app.append(fab, panel);
  setOpen(false);
  refreshStatus();
}

/** Settings were saved: the key or the model may have changed. */
export function assistantSettingsChanged() {
  if (els) refreshStatus();
}
