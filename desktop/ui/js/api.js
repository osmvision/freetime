// Every call to the Rust side goes through here. Command names match desktop/src/commands.rs.

const tauri = window.__TAURI__;
export const inTauri = Boolean(tauri?.core?.invoke);

const invoke = (cmd, args) => tauri.core.invoke(cmd, args);

export const listen = (event, cb) => tauri.event.listen(event, (e) => cb(e.payload));

export const api = {
  bootstrap: () => invoke('bootstrap'),
  onlineStatus: () => invoke('online_status'),
  refresh: () => invoke('refresh'),
  suggest: (req, exclude = [], party = [], mates = []) => invoke('suggest', { req, exclude, perCategory: 4, party, mates }),
  surprise: (exclude = []) => invoke('surprise', { exclude }),
  pick: (id) => invoke('pick', { id }),
  open: (url) => invoke('open_link', { url }),
  rate: (id, ts, rating) => invoke('rate', { id, ts, rating }),
  history: () => invoke('get_history'),
  settings: () => invoke('get_settings'),
  saveSettings: (input) => invoke('save_settings', { input }),
  openDataDir: () => invoke('open_data_dir'),
  searchCities: (query) => invoke('search_cities', { query }),
  setCity: (place) => invoke('set_city', { place }),
  steamScan: () => invoke('steam_scan'),
  steamImport: (steamId64) => invoke('steam_import', { steamId64 }),
  steamForget: () => invoke('steam_forget'),
  finishWelcome: (interests = null) => invoke('finish_welcome', { interests }),
  // Friend codes: nothing is sent anywhere, the user shares the code themselves.
  myFriendCode: (name = null, avatar = null) => invoke('my_friend_code', { name, avatar }),
  friends: () => invoke('get_friends'),
  addFriend: (code) => invoke('add_friend', { code }),
  removeFriend: (name) => invoke('remove_friend', { name }),
  // Online account (opt-in). Nothing here runs until the user signs in.
  accountStatus: () => invoke('account_status'),
  signIn: (provider) => invoke('sign_in', { provider }),
  signOut: () => invoke('sign_out'),
  account: () => invoke('get_account'),
  saveProfile: (edit) => invoke('save_profile', { edit }),
  resetFriendTag: () => invoke('reset_friend_tag'),
  liveStatus: () => invoke('live_status'),
  recap: () => invoke('get_recap'),
  // The ticket book (local only): stamps, badges, challenge, ticket of the day.
  book: () => invoke('get_book'),
  today: () => invoke('get_today'),
  // The daily quiz (offline: questions ship with the app).
  quiz: () => invoke('get_quiz'),
  finishQuiz: (answers) => invoke('finish_quiz', { answers }),
  // Bonus round from Open Trivia DB (network, only when asked).
  bonusQuiz: () => invoke('bonus_quiz'),
  // Ranked (signed in): seasons, boards, player cards.
  rankedOverview: (scope) => invoke('ranked_overview', { scope }),
  playerCard: (userId) => invoke('player_card', { userId }),
  setGlobalRanking: (enabled) => invoke('set_global_ranking', { enabled }),
  syncPoints: () => invoke('sync_points'),
  getShareLibrary: () => invoke('get_share_library'),
  setShareLibrary: (enabled) => invoke('set_share_library', { enabled }),
  setFree: (minutes) => invoke('set_free', { minutes }),
  invites: () => invoke('get_invites'),
  sendInvites: (invites) => invoke('send_invites', { invites }),
  answerInvite: (id, accept) => invoke('answer_invite', { id, accept }),
  cancelInvite: (id) => invoke('cancel_invite', { id }),
  getNotifyMessages: () => invoke('get_notify_messages'),
  // Updates: GitHub releases, signed (src/updates.rs).
  updateStatus: () => invoke('update_status'),
  setAutoUpdate: (enabled) => invoke('set_auto_update', { enabled }),
  checkUpdate: () => invoke('check_update'),
  installUpdate: () => invoke('install_update'),
  setNotifyMessages: (enabled) => invoke('set_notify_messages', { enabled }),
  exportMyData: () => invoke('export_my_data'),
  deleteMyAccount: () => invoke('delete_my_account'),
  reportUser: (userId, reason, details, messageIds) => invoke('report_user', { userId, reason, details, messageIds }),
  socialOverview: () => invoke('social_overview'),
  friendRequest: (tag) => invoke('friend_request', { tag }),
  acceptFriend: (userId) => invoke('accept_friend', { userId }),
  unfriend: (userId) => invoke('unfriend', { userId }),
  blockUser: (userId) => invoke('block_user', { userId }),
  openChat: (friend) => invoke('open_chat', { friend }),
  chatMessages: (conversation, after = 0) => invoke('chat_messages', { conversation, after }),
  sendMessage: (conversation, body) => invoke('send_message', { conversation, body }),
  markRead: (conversation, upTo) => invoke('mark_read', { conversation, upTo }),
  // The chat assistant (Mistral, opt-in). The key never comes back to the UI.
  assistantStatus: () => invoke('assistant_status'),
  assistantModels: () => invoke('assistant_models'),
  assistantSend: (chat, messages, mood, lang) => invoke('assistant_send', { chat, messages, mood, lang }),
  assistantStop: (chat) => invoke('assistant_stop', { chat }),
};
