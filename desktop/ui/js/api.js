// Every call to the Rust side goes through here. Command names match desktop/src/commands.rs.

const tauri = window.__TAURI__;
export const inTauri = Boolean(tauri?.core?.invoke);

const web = () => import('./web-api.js');
const invoke = (cmd, args) => inTauri ? tauri.core.invoke(cmd, args) : web().then((w) => w.invoke(cmd, args));

export const listen = (event, cb) => inTauri ? tauri.event.listen(event, (e) => cb(e.payload)) : web().then((w) => w.listen(event, cb));

export const api = {
  bootstrap: () => invoke('bootstrap'),
  onlineStatus: () => invoke('online_status'),
  refresh: () => invoke('refresh'),
  suggest: (req, exclude = [], party = [], mates = []) => invoke('suggest', { req, exclude, perCategory: 4, party, mates }),
  surprise: (exclude = []) => invoke('surprise', { exclude }),
  pick: (id) => invoke('pick', { id }),
  // Passed over for now (a light, fading signal) / never again (undone from Settings).
  passIdea: (id) => invoke('pass_idea', { id }),
  hideIdea: (id) => invoke('hide_idea', { id }),
  unhideIdea: (id) => invoke('unhide_idea', { id }),
  hiddenIdeas: () => invoke('hidden_ideas'),
  // Your own ideas (Settings): stored with the settings, ranked with the built-in ones.
  myIdeas: () => invoke('my_ideas'),
  addMyIdea: (input) => invoke('add_my_idea', { input }),
  removeMyIdea: (id) => invoke('remove_my_idea', { id }),
  // Real places near your city for an idea (OpenStreetMap, only when asked).
  nearbyPlaces: (id) => invoke('nearby_places', { id }),
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
  profilePhotos: (ids) => invoke('profile_photos', { ids }),
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
  // Meet (people who chose to be visible) and quiz duels with friends.
  meetPeople: () => invoke('meet_people'),
  requestFriend: (userId) => invoke('request_friend', { userId }),
  myDuels: () => invoke('my_duels'),
  createDuel: (friend) => invoke('create_duel', { friend }),
  duelQuestions: (id, questions) => invoke('duel_questions', { id, questions }),
  playDuel: (id, questions, answers) => invoke('play_duel', { id, questions, answers }),
  dropDuel: (id) => invoke('drop_duel', { id }),
  // Two-player games with friends (moves are checked on the server).
  gameAction: (request) => invoke('game_action', { request }),
  myMatches: () => invoke('my_matches'),
  gameLeaderboard: (game, scope) => invoke('game_leaderboard', { game, scope }),
  leaveMatch: (id) => invoke('leave_match', { id }),
  hideMatch: (id) => invoke('hide_match', { id }),
  hideFinishedMatches: () => invoke('hide_finished_matches'),
  playNow: (req, mate) => invoke('play_now', { req, mate }),
  headToHead: (other, game = null) => invoke('head_to_head', { other, game }),
  // Evenings: two times, up to three things to do, answers in one click.
  myEvenings: () => invoke('my_evenings'),
  createEvening: (evening) => invoke('create_evening', { evening }),
  answerEvening: (id, slots, activity = null) => invoke('answer_evening', { id, slots, activity }),
  settleEvening: (id, slot, activity) => invoke('settle_evening', { id, slot, activity }),
  cancelEvening: (id) => invoke('cancel_evening', { id }),
  remind: (title, body) => invoke('remind', { title, body }),
  // "Too long" / "already done" / "another time" about an idea on Discover.
  notNow: (id, reason, minutes) => invoke('not_now', { id, reason, minutes }),
  // Preferences on all your devices, only when asked.
  savePreferences: (extra) => invoke('save_preferences', { extra }),
  loadPreferences: () => invoke('load_preferences'),
  preferencesStatus: () => invoke('preferences_status'),
  forgetPreferences: () => invoke('forget_preferences'),
  // Friends' feed and social settings.
  friendFeed: () => invoke('friend_feed'),
  sharePost: (post) => invoke('share_post', { post }),
  deletePost: (id) => invoke('delete_post', { id }),
  toggleReaction: (post, emoji) => invoke('toggle_reaction', { post, emoji }),
  socialPrefs: () => invoke('get_social_prefs'),
  setSocialPrefs: (prefs) => invoke('set_social_prefs', { prefs }),
  togetherStreaks: () => invoke('together_streaks'),
  // Shareable cards (drawn locally, saved to Downloads).
  periodRecap: (year) => invoke('period_recap', { year }),
  saveCard: (name, png) => invoke('save_card', { name, png }),
  getShareLibrary: () => invoke('get_share_library'),
  setShareLibrary: (enabled) => invoke('set_share_library', { enabled }),
  setFree: (minutes) => invoke('set_free', { minutes }),
  invites: () => invoke('get_invites'),
  sendInvites: (invites) => invoke('send_invites', { invites }),
  answerInvite: (id, accept) => invoke('answer_invite', { id, accept }),
  cancelInvite: (id) => invoke('cancel_invite', { id }),
  getNotifyMessages: () => invoke('get_notify_messages'),
  getNotifyInvites: () => invoke('get_notify_invites'),
  setNotifyInvites: (enabled) => invoke('set_notify_invites', { enabled }),
  // Updates: GitHub releases, signed (src/updates.rs).
  updateStatus: () => invoke('update_status'),
  setAutoUpdate: (enabled) => invoke('set_auto_update', { enabled }),
  checkUpdate: () => invoke('check_update'),
  installUpdate: () => invoke('install_update'),
  setNotifyMessages: (enabled) => invoke('set_notify_messages', { enabled }),
  exportMyData: () => invoke('export_my_data'),
  deleteMyAccount: () => invoke('delete_my_account'),
  reportUser: (userId, reason, details, messageIds) => invoke('report_user', { userId, reason, details, messageIds }),
  // "Report a problem" (works signed out) and the admins' Tickets tab.
  sendSupportTicket: (ticket) => invoke('send_support_ticket', { ticket }),
  supportIsAdmin: () => invoke('support_is_admin'),
  supportTickets: (status = null) => invoke('support_tickets', { status }),
  supportTicketPhotos: (id) => invoke('support_ticket_photos', { id }),
  updateSupportTicket: (id, status, note) => invoke('update_support_ticket', { id, status, note }),
  socialOverview: () => invoke('social_overview'),
  friendRequest: (tag) => invoke('friend_request', { tag }),
  acceptFriend: (userId) => invoke('accept_friend', { userId }),
  unfriend: (userId) => invoke('unfriend', { userId }),
  blockUser: (userId) => invoke('block_user', { userId }),
  openChat: (friend) => invoke('open_chat', { friend }),
  friendGroups: () => invoke('friend_groups'),
  manageFriendGroup: (edit) => invoke('manage_friend_group', { edit }),
  chatMessages: (conversation, after = 0) => invoke('chat_messages', { conversation, after }),
  sendMessage: (conversation, body) => invoke('send_message', { conversation, body }),
  // A surprise made for this account only (shown once).
  mySurprise: () => invoke('my_surprise'),
  surpriseSeen: (id) => invoke('surprise_seen', { id }),
  changedMessages: (conversation, since) => invoke('changed_messages', { conversation, since }),
  reactToMessage: (id, emoji) => invoke('react_to_message', { id, emoji }),
  editMessage: (id, body) => invoke('edit_message', { id, body }),
  markRead: (conversation, upTo) => invoke('mark_read', { conversation, upTo }),
  // The chat assistant (Mistral, opt-in). The key never comes back to the UI.
  assistantStatus: () => invoke('assistant_status'),
  assistantModels: () => invoke('assistant_models'),
  assistantSend: (chat, messages, mood, lang) => invoke('assistant_send', { chat, messages, mood, lang }),
  assistantStop: (chat) => invoke('assistant_stop', { chat }),
};
