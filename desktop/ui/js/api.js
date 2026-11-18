// Every call to the Rust side goes through here. Command names match desktop/src/commands.rs.

const tauri = window.__TAURI__;
export const inTauri = Boolean(tauri?.core?.invoke);

const invoke = (cmd, args) => tauri.core.invoke(cmd, args);

export const listen = (event, cb) => tauri.event.listen(event, (e) => cb(e.payload));

export const api = {
  bootstrap: () => invoke('bootstrap'),
  onlineStatus: () => invoke('online_status'),
  refresh: () => invoke('refresh'),
  suggest: (req, exclude = [], party = []) => invoke('suggest', { req, exclude, perCategory: 4, party }),
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
};
