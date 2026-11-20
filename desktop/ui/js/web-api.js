// Browser transport. Each device owns its local state. The Rust web engine is
// stateless and authenticates account calls using this browser's access token.
const STORE = 'freetime.web.v1';
const KEY_STORE = 'freetime.web.keys';
const listeners = new Map();
const controllers = new Map();
let memory = {};
let auth;
let ready;
let channel;
let queue = Promise.resolve();
let refreshGeneration = 0;
let refreshTask;
let refreshKey;
let refreshedAt = 0;
let lastOnlineStatus;

function read() {
  try { return JSON.parse(localStorage.getItem(STORE) || 'null') ?? memory; }
  catch { return memory; }
}

function save(patch) {
  memory = { ...read(), ...patch };
  localStorage.setItem(STORE, JSON.stringify(memory));
}

function keys() {
  try { return JSON.parse(sessionStorage.getItem(KEY_STORE) || '{}'); }
  catch { return {}; }
}

function emit(name, payload) {
  for (const listener of listeners.get(name) ?? []) listener(payload);
}

const notifyInvites = () => read().config?.notify_invites !== false;

export function listen(name, callback) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(callback);
  return () => listeners.get(name)?.delete(callback);
}

async function initialize() {
  const config = await fetch('/api/config').then((r) => {
    if (!r.ok) throw new Error('The web server is unavailable. Reload to reconnect.');
    return r.json();
  });
  const { createClient } = await import('/web-auth.js');
  auth = createClient(config.url, config.key, {
    auth: { flowType: 'pkce', detectSessionInUrl: true, autoRefreshToken: true, persistSession: true },
  });
  auth.auth.onAuthStateChange((event, session) => {
    // Supabase's auth callback must finish before calling other client methods.
    setTimeout(() => connectRealtime(session), 0);
  });
  const { error } = await auth.auth.getSession();
  if (error) throw new Error(error.message);
  if (new URL(location.href).searchParams.has('code')) history.replaceState(null, '', '/');
}

async function connectRealtime(session) {
  if (channel) { await auth.removeChannel(channel); channel = null; }
  emit('live-status', false);
  if (!session) return;
  const me = session.user.id;
  const invite = (kind, { eventType, new: row }, incoming) => {
    if (eventType === 'INSERT' && incoming(row) && notifyInvites()) {
      emit('game-invite-new', { kind, id: String(row.id) });
    }
  };
  channel = auth.channel(`freetime-${me}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: message }) => {
      emit('message-new', { message, mine: message.sender === session.user.id });
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, ({ new: message }) => {
      emit('message-changed', { message, mine: message.sender === session.user.id });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'invites' }, (change) => {
      invite('pick', change, (row) => row.to_user === me && row.status === 'pending' && row.category === 'game');
      emit('invites-changed', null);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'duels' }, (change) => {
      invite('duel', change, (row) => row.opponent === me && row.status === 'open');
      emit('duels-changed', null);
      if (change.eventType === 'UPDATE' && change.new.status === 'done') emit('game-ranking-changed', 'quiz-duel');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, (change) => {
      invite('match', change, (row) => row.player_b === me && row.status === 'active');
      emit('matches-changed', null);
      if (change.eventType === 'UPDATE' && change.new.status === 'done') emit('game-ranking-changed', change.new.game);
    })
    .subscribe((status) => emit('live-status', status === 'SUBSCRIBED'));
}

async function session() {
  const { data, error } = await auth.auth.getSession();
  if (error) throw new Error(error.message);
  return data.session;
}

async function rpc(cmd, args = {}, signal, applyPatch = true) {
  const current = await session();
  const headers = { 'Content-Type': 'application/json' };
  if (current) headers.Authorization = `Bearer ${current.access_token}`;
  const ticket = cmd === 'send_support_ticket';
  const response = await fetch('/api/invoke', {
    method: 'POST', headers, signal,
    body: JSON.stringify({ cmd, args, state: ticket ? {} : read(), keys: ticket ? {} : keys() }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed. Try again.');
  if (!applyPatch) return result;
  if (result.patch && Object.keys(result.patch).length) save(result.patch);
  return result.value;
}

function serialized(work) {
  const run = () => navigator.locks ? navigator.locks.request(STORE, work) : work();
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

function download(value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `freetime-export-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return link.download;
}

const MUTATIONS = new Set(['pick', 'rate', 'finish_quiz', 'save_settings', 'set_city', 'finish_welcome',
  'my_friend_code', 'add_friend', 'remove_friend', 'steam_import', 'steam_forget', 'set_share_library', 'set_notify_messages', 'set_notify_invites',
  'not_now', 'load_preferences']);

async function dispatch(cmd, args) {
  if (cmd === 'get_notify_invites') return notifyInvites();
  if (cmd === 'set_notify_invites') {
    save({ config: { ...read().config, notify_invites: args.enabled } });
    return;
  }
  if (cmd === 'account_status') return { signed_in: Boolean(await session()) };
  if (cmd === 'sign_in') {
    if (!window.isSecureContext) throw new Error('Open the HTTPS test link to sign in.');
    const { error } = await auth.auth.signInWithOAuth({ provider: args.provider, options: { redirectTo: `${location.origin}/auth/callback` } });
    if (error) throw new Error(error.message);
    return new Promise(() => {}); // The browser continues on the provider's page.
  }
  if (cmd === 'sign_out') {
    const { error } = await auth.auth.signOut();
    if (error) throw new Error(error.message);
    return;
  }
  if (cmd === 'open_link') {
    const url = new URL(args.url);
    if (!['https:', 'http:', 'steam:'].includes(url.protocol)) throw new Error('Unsupported link');
    window.open(url.href, '_blank', 'noopener,noreferrer');
    return;
  }
  if (cmd === 'remind') {
    // The browser's own notification when allowed; otherwise the app shows a message itself.
    if ('Notification' in window && Notification.permission === 'granted') new Notification(args.title, { body: args.body });
    else throw new Error('notifications are off');
    return;
  }
  if (cmd === 'live_status') return false; // Polling also covers reconnects and tab suspension.
  if (cmd === 'steam_scan') throw new Error('Enter your Steam profile and a Web API key to import your public library.');
  if (cmd === 'open_data_dir') return download(read());
  if (cmd === 'update_status') return { current: 'Web', auto: true, available: null };
  if (cmd === 'check_update' || cmd === 'install_update') { await navigator.serviceWorker?.getRegistration().then((r) => r?.update()); return null; }
  if (cmd === 'set_auto_update') return;
  if (cmd === 'assistant_stop') {
    const cancelled = rpc(cmd, args).catch(() => {});
    controllers.get(args.chat)?.abort();
    await cancelled;
    return;
  }
  if (cmd === 'assistant_send') {
    const controller = new AbortController();
    controllers.set(args.chat, controller);
    try {
      const reply = await rpc(cmd, args, controller.signal);
      emit('assistant-ideas', { chat: args.chat, ideas: reply.ideas });
      return reply;
    } catch (error) {
      if (error.name === 'AbortError') return { text: '', ideas: [], stopped: true };
      throw error;
    } finally { controllers.delete(args.chat); }
  }
  if (cmd === 'assistant_status') {
    const value = await rpc(cmd, args);
    value.account = (await session())?.user.id ?? null;
    return value;
  }
  if (cmd === 'save_settings') {
    const secrets = keys();
    for (const name of ['steam', 'youtube', 'mistral']) {
      if (args.input[`clear_${name}_key`]) delete secrets[name];
      if (args.input[`${name}_key`]?.trim()) secrets[name] = args.input[`${name}_key`].trim();
    }
    sessionStorage.setItem(KEY_STORE, JSON.stringify(secrets));
  }
  if (cmd === 'surprise') args.req = JSON.parse(localStorage.getItem('freetime.mood.v2') || 'null');
  if (cmd === 'refresh') {
    const state = read();
    const key = JSON.stringify([state.config, state.library?.imported_at, keys()]);
    if (refreshTask && key === refreshKey) return refreshTask;
    refreshKey = key;
    const generation = ++refreshGeneration;
    if (lastOnlineStatus) emit('online-updated', { ...lastOnlineStatus, loading: true });
    refreshTask = (async () => {
      const result = await rpc(cmd, args, undefined, false);
      if (generation === refreshGeneration) {
        save(result.patch);
        refreshedAt = Date.now();
        lastOnlineStatus = result.value;
        emit('online-updated', result.value);
      }
      return result.value;
    })().finally(() => { if (generation === refreshGeneration) refreshTask = null; });
    return refreshTask;
  }
  const value = await rpc(cmd, args);
  if (cmd === 'bootstrap') lastOnlineStatus = value.online;
  if (cmd === 'bootstrap' && Date.now() - refreshedAt > 600000) setTimeout(() => invoke('refresh').catch(() => {}), 0);
  if (cmd === 'export_my_data') return download(value);
  if (cmd === 'delete_my_account') await auth.auth.signOut({ scope: 'local' });
  if (cmd === 'set_city' || cmd === 'save_settings' || cmd === 'steam_import' || cmd === 'steam_forget') {
    setTimeout(() => invoke('refresh').catch(() => {}), 0);
  }
  return value;
}

export async function invoke(cmd, args = {}) {
  ready ??= initialize().catch((error) => { ready = null; throw error; });
  await ready;
  if (MUTATIONS.has(cmd)) return serialized(() => dispatch(cmd, args));
  return dispatch(cmd, args);
}
