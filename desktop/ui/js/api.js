// Every call to the Rust side goes through here. Command names match desktop/src/commands.rs.

const tauri = window.__TAURI__;
export const inTauri = Boolean(tauri?.core?.invoke);

const invoke = (cmd, args) => tauri.core.invoke(cmd, args);

export const listen = (event, cb) => tauri.event.listen(event, (e) => cb(e.payload));

export const api = {
  bootstrap: () => invoke('bootstrap'),
  onlineStatus: () => invoke('online_status'),
  refresh: () => invoke('refresh'),
  suggest: (req, exclude = []) => invoke('suggest', { req, exclude, perCategory: 4 }),
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
};
