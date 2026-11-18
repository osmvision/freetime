//! Tauri commands: the bridge between the web UI (`ui/`) and freetime-core.
//!
//! Commands marked `async` run on a worker thread, so network calls and disk access
//! never freeze the window.

use freetime_core::{
    account::{self, Client, ConversationEntry, FriendEntry, Message as ChatMessage, OnlineProfile, ProfileEdit, Session},
    config::{self, Config},
    history::{self, History},
    keys::{self, KeySource, Keys},
    net::HttpNet,
    model::*,
    open,
    party::{self, Avatar, Friend},
    providers::{
        self,
        steam::{self, SteamStatus},
        steam_import::{self, LocalAccount},
        Note, Online,
    },
    region,
    scoring::{self, Ranked},
    weather::{self, Place, Weather},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How long a suggestion waits for Steam/YouTube/weather on startup before using offline ideas.
const ONLINE_WAIT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct AppState {
    online: Mutex<OnlineSlot>,
    /// Every suggestion sent to the UI, so `pick` can find it again by id.
    shown: Mutex<HashMap<String, Suggestion>>,
    /// The signed-in session (opt-in). Only in memory; the refresh token is in Credential Manager.
    account: Mutex<Option<Session>>,
}

#[derive(Default)]
struct OnlineSlot {
    data: Option<Arc<Online>>,
    loading: bool,
    /// A refresh was requested while one was running (e.g. settings saved): run again after.
    again: bool,
}

/// Re-fetches Steam, YouTube and the weather, then emits `online-updated` to the UI.
pub fn refresh_in_background(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut slot = lock(&state.online);
        if slot.loading {
            slot.again = true;
            return;
        }
        slot.loading = true;
    }
    let app = app.clone();
    thread::spawn(move || loop {
        let cfg = Config::load().unwrap_or_default();
        let online = Arc::new(providers::fetch_online(&cfg));
        let state = app.state::<AppState>();
        let again = {
            let mut slot = lock(&state.online);
            slot.data = Some(online);
            let again = std::mem::take(&mut slot.again);
            slot.loading = again;
            again
        };
        let _ = app.emit("online-updated", online_dto(&state));
        if !again {
            break;
        }
    });
}

/// The latest online data, waiting a bit for the first fetch. `true` = offline ideas only.
fn current_online(state: &AppState, wait: Duration) -> (Arc<Online>, bool) {
    let start = Instant::now();
    loop {
        {
            let slot = lock(&state.online);
            if let Some(data) = &slot.data {
                return (data.clone(), false);
            }
            if !slot.loading {
                return (Arc::new(Online::default()), true);
            }
        }
        if start.elapsed() >= wait {
            return (Arc::new(Online::default()), true);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

// ---------------------------------------------------------------- data sent to the UI

#[derive(Serialize, Clone)]
pub struct WeatherDto {
    place: String,
    temp_c: f64,
    sky: &'static str,
    emoji: &'static str,
    is_day: bool,
    outdoor_ok: bool,
    summary: String,
}

fn weather_dto(w: &Weather) -> WeatherDto {
    WeatherDto {
        place: w.place.clone(),
        temp_c: w.temp_c,
        sky: w.sky(),
        emoji: w.emoji(),
        is_day: w.is_day,
        outdoor_ok: w.outdoor_factor(false) >= 0.6,
        summary: w.summary(),
    }
}

#[derive(Serialize, Clone)]
pub struct OnlineDto {
    ready: bool,
    loading: bool,
    weather: Option<WeatherDto>,
    notes: Vec<Note>,
    steam_games: usize,
    videos: usize,
}

fn online_dto(state: &AppState) -> OnlineDto {
    let slot = lock(&state.online);
    let data = slot.data.as_deref();
    let count = |prefix: &str| data.map_or(0, |d| d.items.iter().filter(|s| s.id.starts_with(prefix)).count());
    OnlineDto {
        ready: data.is_some(),
        loading: slot.loading,
        weather: data.and_then(|d| d.weather.as_ref()).map(weather_dto),
        notes: data.map(|d| d.notes.clone()).unwrap_or_default(),
        steam_games: count("steam:"),
        videos: count("yt:"),
    }
}

/// A suggestion plus the bits the UI displays.
#[derive(Serialize)]
pub struct Card {
    #[serde(flatten)]
    s: Suggestion,
    reasons: Vec<String>,
    duration: String,
    icon: &'static str,
    category_label: &'static str,
}

fn card(r: &Ranked) -> Card {
    Card {
        s: r.s.clone(),
        reasons: r.reasons.clone(),
        duration: r.s.duration_label(),
        icon: r.s.category.icon(),
        category_label: r.s.category.label(),
    }
}

fn remember<'a>(state: &AppState, cards: impl Iterator<Item = &'a Card>) {
    let mut shown = lock(&state.shown);
    for c in cards {
        shown.insert(c.s.id.clone(), c.s.clone());
    }
}

/// `party`: names of saved friends you're with (from their friend codes). Only used when the
/// request is "with friends"; otherwise this is the solo ranking.
fn rank(cfg: &Config, req: &Request, online: &Online, exclude: &[String], party: &[String]) -> Vec<Ranked> {
    let prefs = History::load().prefs(history::now());
    let exclude: HashSet<String> = exclude.iter().cloned().collect();
    if !req.with_friends || party.is_empty() {
        return freetime_core::rank(cfg, req, online, &prefs, &exclude);
    }
    let chosen: Vec<Friend> = party::load_friends()
        .into_iter()
        .filter(|f| party.iter().any(|n| n.eq_ignore_ascii_case(&f.name)))
        .collect();
    let party = party::Party::new(chosen, steam_import::load_library().as_ref());
    freetime_core::rank_together(cfg, req, online, &prefs, &exclude, Some(&party))
}

#[derive(Serialize)]
pub struct Pending {
    id: String,
    ts: i64,
    title: String,
    icon: &'static str,
    ago: String,
}

fn pending_list(h: &History) -> Vec<Pending> {
    let now = history::now();
    h.unrated(now, history::RATE_AFTER_SECS, 3)
        .into_iter()
        .map(|i| {
            let e = &h.entries[i];
            Pending {
                id: e.id.clone(),
                ts: e.ts,
                title: e.title.clone(),
                icon: e.category.icon(),
                ago: history::ago(now - e.ts),
            }
        })
        .collect()
}

// ---------------------------------------------------------------- startup

#[derive(Serialize)]
pub struct CategoryInfo {
    id: Category,
    label: &'static str,
    icon: &'static str,
}

#[derive(Serialize)]
pub struct SetupState {
    city: Option<String>,
    /// First launch: ask once where the user is (they can skip).
    needs_city: bool,
    /// The first-run welcome hasn't been finished or skipped yet.
    needs_welcome: bool,
    steam: bool,
    youtube: bool,
}

#[derive(Serialize)]
pub struct Boot {
    defaults: Request,
    categories: Vec<CategoryInfo>,
    online: OnlineDto,
    pending: Vec<Pending>,
    setup: SetupState,
}

#[tauri::command(async)]
pub fn bootstrap(state: State<'_, AppState>) -> Res<Boot> {
    let cfg = Config::load().map_err(err)?;
    Ok(Boot {
        defaults: Request::for_now(),
        categories: Category::ALL
            .iter()
            .map(|c| CategoryInfo { id: *c, label: c.label(), icon: c.icon() })
            .collect(),
        online: online_dto(&state),
        pending: pending_list(&History::load()),
        setup: SetupState {
            city: cfg.city.clone(),
            needs_city: cfg.city.is_none() && !cfg.asked_for_city,
            needs_welcome: !cfg.onboarded,
            steam: steam_import::load_library().is_some(),
            youtube: Keys::resolve().youtube.is_some() || !cfg.youtube.channels.is_empty(),
        },
    })
}

#[tauri::command(async)]
pub fn online_status(state: State<'_, AppState>) -> Res<OnlineDto> {
    Ok(online_dto(&state))
}

#[tauri::command]
pub fn refresh(app: AppHandle) {
    refresh_in_background(&app);
}

// ---------------------------------------------------------------- suggestions

#[derive(Serialize)]
pub struct Group {
    category: Category,
    label: &'static str,
    icon: &'static str,
    items: Vec<Card>,
}

#[derive(Serialize)]
pub struct Results {
    best: Option<Card>,
    groups: Vec<Group>,
    summary: String,
    /// Steam/YouTube/weather weren't ready: offline ideas only.
    partial: bool,
    notes: Vec<Note>,
}

#[tauri::command(async)]
pub fn suggest(
    state: State<'_, AppState>,
    req: Request,
    exclude: Vec<String>,
    per_category: Option<usize>,
    party: Option<Vec<String>>,
) -> Res<Results> {
    let cfg = Config::load().map_err(err)?;
    let (online, partial) = current_online(&state, ONLINE_WAIT);
    let ranked = rank(&cfg, &req, &online, &exclude, &party.unwrap_or_default());
    let per = per_category.unwrap_or(4).clamp(1, 12);

    let best = ranked.first().map(card);
    let groups: Vec<Group> = Category::ALL
        .into_iter()
        .filter(|c| req.wants(*c))
        .filter_map(|c| {
            let items: Vec<Card> = ranked.iter().skip(1).filter(|r| r.s.category == c).take(per).map(card).collect();
            (!items.is_empty()).then(|| Group { category: c, label: c.label(), icon: c.icon(), items })
        })
        .collect();
    remember(&state, best.iter().chain(groups.iter().flat_map(|g| g.items.iter())));

    Ok(Results { best, groups, summary: req.summary(), partial, notes: online.notes.clone() })
}

#[derive(Serialize)]
pub struct SurpriseView {
    pick: Option<Card>,
    alternatives: Vec<Card>,
}

/// One random pick among the best for right now, no questions asked.
#[tauri::command(async)]
pub fn surprise(state: State<'_, AppState>, exclude: Vec<String>) -> Res<SurpriseView> {
    let cfg = Config::load().map_err(err)?;
    let (online, _) = current_online(&state, ONLINE_WAIT);
    let ranked = rank(&cfg, &Request::for_now(), &online, &exclude, &[]);
    let Some(i) = scoring::weighted_pick(&ranked, 6) else {
        return Ok(SurpriseView { pick: None, alternatives: Vec::new() });
    };
    let pick = card(&ranked[i]);
    let alternatives: Vec<Card> =
        ranked.iter().enumerate().filter(|(j, _)| *j != i).take(2).map(|(_, r)| card(r)).collect();
    remember(&state, std::iter::once(&pick).chain(alternatives.iter()));
    Ok(SurpriseView { pick: Some(pick), alternatives })
}

#[derive(Serialize)]
pub struct Picked {
    title: String,
    icon: &'static str,
    link: Option<String>,
}

#[tauri::command(async)]
pub fn pick(state: State<'_, AppState>, id: String) -> Res<Picked> {
    let s = lock(&state.shown)
        .get(&id)
        .cloned()
        .ok_or_else(|| "That idea isn't available anymore. Refresh your picks.".to_string())?;
    let mut h = History::load();
    h.record_pick(&s);
    h.save().map_err(err)?;
    Ok(Picked { title: s.title, icon: s.category.icon(), link: s.link })
}

#[tauri::command(async)]
pub fn open_link(url: String) -> Res<()> {
    open::open_link(&url).map_err(err)
}

// ---------------------------------------------------------------- history

/// Sets the rating of one pick (1 loved, -1 not for me, 0 skipped) and returns what's left to rate.
#[tauri::command(async)]
pub fn rate(id: String, ts: i64, rating: i8) -> Res<Vec<Pending>> {
    let mut h = History::load();
    let entry = h
        .entries
        .iter_mut()
        .find(|e| e.id == id && e.ts == ts)
        .ok_or_else(|| "Couldn't find that pick in your history.".to_string())?;
    entry.rating = Some(rating.clamp(-1, 1));
    h.save().map_err(err)?;
    Ok(pending_list(&h))
}

#[derive(Serialize)]
pub struct HistoryItem {
    id: String,
    ts: i64,
    title: String,
    icon: &'static str,
    category: Category,
    category_label: &'static str,
    rating: Option<i8>,
    day: String,
    time: String,
}

#[derive(Serialize)]
pub struct Taste {
    category: Category,
    label: &'static str,
    icon: &'static str,
    affinity: f64,
}

#[derive(Serialize)]
pub struct Stats {
    picks: usize,
    liked: usize,
    disliked: usize,
}

#[derive(Serialize)]
pub struct HistoryView {
    entries: Vec<HistoryItem>,
    taste: Vec<Taste>,
    stats: Stats,
}

#[tauri::command(async)]
pub fn get_history() -> Res<HistoryView> {
    let h = History::load();
    let today = chrono::Local::now().date_naive();
    let entries = h
        .entries
        .iter()
        .rev()
        .take(200)
        .map(|e| {
            let at = chrono::DateTime::from_timestamp(e.ts, 0).unwrap_or_default().with_timezone(&chrono::Local);
            let date = at.date_naive();
            let day = if date == today {
                "Today".to_string()
            } else if Some(date) == today.pred_opt() {
                "Yesterday".to_string()
            } else {
                at.format("%A %d %B").to_string()
            };
            HistoryItem {
                id: e.id.clone(),
                ts: e.ts,
                title: e.title.clone(),
                icon: e.category.icon(),
                category: e.category,
                category_label: e.category.label(),
                rating: e.rating,
                day,
                time: at.format("%H:%M").to_string(),
            }
        })
        .collect();
    let prefs = h.prefs(history::now());
    let taste = Category::ALL
        .iter()
        .map(|c| Taste { category: *c, label: c.label(), icon: c.icon(), affinity: prefs.category_affinity(*c) })
        .collect();
    let stats = Stats {
        picks: h.entries.len(),
        liked: h.entries.iter().filter(|e| e.rating == Some(1)).count(),
        disliked: h.entries.iter().filter(|e| e.rating == Some(-1)).count(),
    };
    Ok(HistoryView { entries, taste, stats })
}

// ---------------------------------------------------------------- settings

/// Settings as shown to the UI. API keys never leave the backend: only whether one is set.
#[derive(Serialize)]
pub struct SettingsView {
    city: Option<String>,
    /// From the Windows regional settings: Steam prices follow it.
    region: region::Region,
    interests: Vec<String>,
    steam_key_set: bool,
    steam_key_from_env: bool,
    steam_id: Option<String>,
    /// The last import (freetime's own cache).
    steam: SteamStatus,
    youtube_key_set: bool,
    youtube_key_from_env: bool,
    channels: Vec<String>,
    config_path: String,
    data_dir: String,
}

fn settings_view(cfg: &Config) -> SettingsView {
    let keys = Keys::resolve();
    let from_env = |k: &Option<keys::Key>| k.as_ref().is_some_and(|k| k.source == KeySource::Environment);
    SettingsView {
        city: cfg.city.clone(),
        region: region::current(),
        interests: cfg.interests.clone(),
        steam_key_set: keys.steam.is_some(),
        steam_key_from_env: from_env(&keys.steam),
        steam_id: cfg.steam.steam_id.clone(),
        steam: SteamStatus::of(steam_import::load_library().as_ref()),
        youtube_key_set: keys.youtube.is_some(),
        youtube_key_from_env: from_env(&keys.youtube),
        channels: cfg.youtube.channels.clone(),
        config_path: config::config_path().display().to_string(),
        data_dir: config::data_dir().display().to_string(),
    }
}

#[tauri::command(async)]
pub fn get_settings() -> Res<SettingsView> {
    Ok(settings_view(&Config::load().map_err(err)?))
}

#[derive(Deserialize)]
pub struct SettingsInput {
    interests: Vec<String>,
    /// Empty = keep the saved key.
    steam_key: String,
    clear_steam_key: bool,
    steam_profile: String,
    youtube_key: String,
    clear_youtube_key: bool,
    channels: Vec<String>,
}

#[derive(Serialize)]
pub struct Msg {
    ok: bool,
    text: String,
}

#[derive(Serialize)]
pub struct SaveReport {
    settings: SettingsView,
    messages: Vec<Msg>,
}

fn clean_list(items: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim().to_string();
        if !item.is_empty() && !out.iter().any(|x| x.eq_ignore_ascii_case(&item)) {
            out.push(item);
        }
    }
    out
}

#[tauri::command(async)]
pub fn save_settings(app: AppHandle, input: SettingsInput) -> Res<SaveReport> {
    let mut cfg = Config::load().map_err(err)?;
    let net = HttpNet::new().map_err(err)?;
    let mut messages = Vec::new();
    let mut say = |ok: bool, text: String| messages.push(Msg { ok, text });

    cfg.interests = clean_list(input.interests);

    // Keys typed here go to %APPDATA%\freetime\.env, never to config.toml.
    if input.clear_steam_key {
        keys::save_user_key(keys::STEAM, None).map_err(err)?;
    } else if !input.steam_key.trim().is_empty() {
        keys::save_user_key(keys::STEAM, Some(&input.steam_key)).map_err(err)?;
    }
    if input.clear_youtube_key {
        keys::save_user_key(keys::YOUTUBE, None).map_err(err)?;
    } else if !input.youtube_key.trim().is_empty() {
        keys::save_user_key(keys::YOUTUBE, Some(&input.youtube_key)).map_err(err)?;
    }
    // A pasted SteamID64 or /profiles/ URL is read locally; only a custom /id/ name needs the API.
    let profile = input.steam_profile.trim();
    if profile.is_empty() {
        cfg.steam.steam_id = None;
    } else if cfg.steam.steam_id.as_deref() != Some(profile) {
        match (steam_import::parse_steam_id(profile), Keys::resolve().steam) {
            (Some(id), _) => cfg.steam.steam_id = Some(id),
            (None, Some(key)) => match steam::resolve_steam_id(&net, key.value(), profile) {
                Ok(id) => cfg.steam.steam_id = Some(id),
                Err(e) => say(false, format!("Steam: {e}")),
            },
            (None, None) => say(
                false,
                "Paste a SteamID64 or a steamcommunity.com/profiles/… URL (custom /id/ names need a Steam Web API key).".into(),
            ),
        }
    }

    cfg.youtube.channels = clean_list(input.channels);

    cfg.save().map_err(err)?;
    say(true, "Settings saved".into());
    refresh_in_background(&app);
    Ok(SaveReport { settings: settings_view(&cfg), messages })
}

// ---------------------------------------------------------------- Steam import (opt-in)

#[derive(Serialize)]
pub struct SteamScan {
    /// Steam's folder was found (registry SteamPath or the default folder).
    found: bool,
    /// Accounts from the folder names under userdata\ (no file is opened).
    accounts: Vec<LocalAccount>,
    /// A SteamID typed in the settings, used instead of asking.
    chosen: Option<String>,
}

/// First half of "Import my games from Steam on this PC": which accounts used Steam here.
#[tauri::command(async)]
pub fn steam_scan() -> Res<SteamScan> {
    let cfg = Config::load().map_err(err)?;
    let root = steam_import::steam_root();
    Ok(SteamScan {
        found: root.is_some(),
        accounts: root.as_deref().map(steam_import::accounts).unwrap_or_default(),
        chosen: cfg.steam.steam_id,
    })
}

#[derive(Serialize)]
pub struct SteamImported {
    status: SteamStatus,
    notes: Vec<String>,
}

/// Second half: imports that account's games and saves them to freetime's cache.
#[tauri::command(async)]
pub fn steam_import(app: AppHandle, steam_id64: String) -> Res<SteamImported> {
    let net = HttpNet::new().map_err(err)?;
    let key = Keys::resolve().steam;
    let now = chrono::Utc::now().timestamp();
    let (library, notes) =
        steam_import::run_import(&net, key.as_ref().map(|k| k.value()), &steam_id64, now).map_err(err)?;
    refresh_in_background(&app);
    Ok(SteamImported { status: SteamStatus::of(Some(&library)), notes })
}

/// Deletes the imported list (freetime's cache only; Steam's files are never touched).
#[tauri::command(async)]
pub fn steam_forget(app: AppHandle) -> Res<()> {
    steam_import::forget_library().map_err(err)?;
    refresh_in_background(&app);
    Ok(())
}

/// City autocomplete (Open-Meteo geocoding). Only runs while the user types.
#[tauri::command(async)]
pub fn search_cities(query: String) -> Res<Vec<Place>> {
    let net = HttpNet::new().map_err(err)?;
    weather::search_places(&net, &query, 6).map_err(err)
}

/// Saves the picked city (None = skip / remove). Either way the question isn't asked again.
#[tauri::command(async)]
pub fn set_city(app: AppHandle, place: Option<Place>) -> Res<SettingsView> {
    let mut cfg = Config::load().map_err(err)?;
    cfg.asked_for_city = true;
    match place {
        Some(p) => {
            cfg.country = region::country_code(&p.country_code);
            cfg.latitude = Some(p.latitude);
            cfg.longitude = Some(p.longitude);
            cfg.city = Some(p.name);
        }
        None => {
            cfg.city = None;
            cfg.country = None;
            cfg.latitude = None;
            cfg.longitude = None;
        }
    }
    cfg.save().map_err(err)?;
    refresh_in_background(&app);
    Ok(settings_view(&cfg))
}

// ---------------------------------------------------------------- first-run welcome

/// Ends the welcome (finished or skipped). `interests`, if given, become the YouTube topics.
#[tauri::command(async)]
pub fn finish_welcome(interests: Option<Vec<String>>) -> Res<()> {
    let mut cfg = Config::load().map_err(err)?;
    if let Some(list) = interests {
        let mut clean: Vec<String> = Vec::new();
        for i in list {
            let t: String = i.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(40).collect();
            if !t.is_empty() && !clean.iter().any(|c| c.eq_ignore_ascii_case(&t)) {
                clean.push(t);
            }
        }
        clean.truncate(12);
        if !clean.is_empty() {
            cfg.interests = clean;
        }
    }
    cfg.onboarded = true;
    cfg.save().map_err(err)
}

// ---------------------------------------------------------------- account (opt-in, Supabase)

#[derive(Serialize)]
pub struct AccountView {
    signed_in: bool,
    email: Option<String>,
    profile: Option<OnlineProfile>,
}

/// A usable session: the one in memory if still fresh, else refreshed from the saved token.
/// The lock is held during the refresh so two calls can't both spend the (rotating) token.
fn live_session(state: &AppState) -> Res<Session> {
    let now = history::now();
    let mut slot = lock(&state.account);
    if let Some(s) = slot.as_ref().filter(|s| s.fresh(now)) {
        return Ok(s.clone());
    }
    let token = slot
        .as_ref()
        .map(|s| s.refresh_token.clone())
        .or_else(account::stored_refresh_token)
        .ok_or_else(|| "you're not signed in".to_string())?;
    let client = Client::new().map_err(err)?;
    match client.refresh(&token, now) {
        Ok(s) => {
            *slot = Some(s.clone());
            Ok(s)
        }
        Err(e) if e.to_string().contains("(HTTP 4") => {
            // Revoked or expired: forget it rather than retrying forever.
            *slot = None;
            let _ = account::forget_refresh_token();
            Err("your session has ended: sign in again".to_string())
        }
        Err(e) => Err(err(e)),
    }
}

/// Signed in or not, without touching the network.
#[tauri::command(async)]
pub fn account_status(state: State<'_, AppState>) -> Res<AccountView> {
    let slot = lock(&state.account);
    Ok(AccountView {
        signed_in: slot.is_some() || account::has_saved_session(),
        email: slot.as_ref().and_then(|s| s.email.clone()),
        profile: None,
    })
}

/// Opens the browser to sign in, waits for it to come back (up to 3 minutes), then loads the
/// online profile. The first time, the name and avatar chosen in the app are copied to it.
#[tauri::command(async)]
pub fn sign_in(state: State<'_, AppState>, provider: String) -> Res<AccountView> {
    if provider != "google" {
        return Err("unknown sign-in provider".to_string());
    }
    let client = Client::new().map_err(err)?;
    let session = client.sign_in(&provider, |url| open::open_link(url), history::now).map_err(err)?;
    *lock(&state.account) = Some(session.clone());

    let mut profile = client.profile(&session).map_err(err)?;
    let untouched = profile.display_name == "Friend" && profile.avatar_icon == 0 && profile.avatar_color == 0 && profile.bio.is_empty();
    let cfg = Config::load().map_err(err)?;
    if untouched && (cfg.display_name.is_some() || cfg.avatar != Default::default()) {
        let edit = ProfileEdit {
            display_name: cfg.display_name.clone().unwrap_or_else(|| "Friend".to_string()),
            avatar_icon: cfg.avatar.icon as i16,
            avatar_color: cfg.avatar.color as i16,
            bio: String::new(),
            status_text: String::new(),
        };
        if let Ok(p) = client.update_profile(&session, &edit) {
            profile = p;
        }
    }
    Ok(AccountView { signed_in: true, email: session.email.clone(), profile: Some(profile) })
}

#[tauri::command(async)]
pub fn sign_out(state: State<'_, AppState>) -> Res<()> {
    let session = lock(&state.account).take();
    Client::new().map_err(err)?.sign_out(session.as_ref()).map_err(err)
}

/// The online profile (refreshes the session if needed).
#[tauri::command(async)]
pub fn get_account(state: State<'_, AppState>) -> Res<AccountView> {
    let session = live_session(&state)?;
    let profile = Client::new().map_err(err)?.profile(&session).map_err(err)?;
    Ok(AccountView { signed_in: true, email: session.email.clone(), profile: Some(profile) })
}

/// Saves the online profile, and keeps the friend code's name and avatar in step with it.
#[tauri::command(async)]
pub fn save_profile(state: State<'_, AppState>, edit: ProfileEdit) -> Res<OnlineProfile> {
    let session = live_session(&state)?;
    let profile = Client::new().map_err(err)?.update_profile(&session, &edit).map_err(err)?;
    let mut cfg = Config::load().map_err(err)?;
    cfg.display_name = Some(party::clean_name(&profile.display_name));
    cfg.avatar = Avatar { icon: profile.avatar_icon.clamp(0, 255) as u8, color: profile.avatar_color.clamp(0, 255) as u8 }.checked();
    cfg.save().map_err(err)?;
    Ok(profile)
}

/// A new friend tag, if the old one was shared too widely.
#[tauri::command(async)]
pub fn reset_friend_tag(state: State<'_, AppState>) -> Res<String> {
    let session = live_session(&state)?;
    Client::new().map_err(err)?.reset_friend_tag(&session).map_err(err)
}

// ---------------------------------------------------------------- message notifications

/// While signed in (and if enabled), checks for new messages every minute: updates the unread
/// badge, and shows a Windows notification for messages that arrived since the last check,
/// unless the freetime window is in front. The first check after starting only takes note of
/// what's already there.
pub fn watch_messages(app: AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    thread::spawn(move || {
        let mut seen: HashMap<String, String> = HashMap::new();
        let mut baseline = true;
        thread::sleep(Duration::from_secs(8));
        loop {
            let enabled = Config::load().map(|c| c.notify_messages).unwrap_or(false);
            let state = app.state::<AppState>();
            let signed_in = lock(&state.account).is_some() || account::has_saved_session();
            if !enabled || !signed_in {
                seen.clear();
                baseline = true;
            } else if let (Ok(s), Ok(client)) = (live_session(&state), Client::new()) {
                if let Ok(convs) = client.conversations(&s) {
                    let _ = app.emit("unread-updated", convs.iter().map(|c| c.unread).sum::<i64>());
                    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
                    let mut fresh = Vec::new();
                    for c in &convs {
                        let last = c.last_at.clone().unwrap_or_default();
                        let before = seen.insert(c.conversation_id.clone(), last.clone());
                        let from_them = c.last_sender.as_deref().is_some_and(|who| who != s.user_id);
                        if !baseline && !focused && c.unread > 0 && from_them && before.as_deref() != Some(last.as_str()) {
                            fresh.push(c.clone());
                        }
                    }
                    if !fresh.is_empty() {
                        let names: HashMap<String, String> =
                            client.friends(&s).unwrap_or_default().into_iter().map(|f| (f.user_id, f.display_name)).collect();
                        for c in fresh.iter().take(3) {
                            let who = names.get(&c.friend).cloned().unwrap_or_else(|| "A friend".to_string());
                            let preview: String = c.last_body.clone().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
                            let preview: String = if preview.chars().count() > 120 { preview.chars().take(117).collect::<String>() + "…" } else { preview };
                            let _ = app.notification().builder().title(format!("{who} on freetime")).body(preview).show();
                        }
                    }
                    baseline = false;
                }
            }
            thread::sleep(Duration::from_secs(60));
        }
    });
}

#[tauri::command(async)]
pub fn set_notify_messages(enabled: bool) -> Res<()> {
    let mut cfg = Config::load().map_err(err)?;
    cfg.notify_messages = enabled;
    cfg.save().map_err(err)
}

#[tauri::command(async)]
pub fn get_notify_messages() -> Res<bool> {
    Ok(Config::load().map_err(err)?.notify_messages)
}

// ---------------------------------------------------------------- your data (GDPR) and reports

/// Saves everything stored about you online to Downloads; returns the file path.
#[tauri::command(async)]
pub fn export_my_data(state: State<'_, AppState>) -> Res<String> {
    let s = live_session(&state)?;
    let data = Client::new().map_err(err)?.export_my_data(&s).map_err(err)?;
    let path = account::save_export(&data, chrono::Local::now()).map_err(err)?;
    Ok(path.display().to_string())
}

/// Deletes the online account for good. The solo app and its data on this PC stay.
#[tauri::command(async)]
pub fn delete_my_account(state: State<'_, AppState>) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.delete_my_account(&s).map_err(err)?;
    *lock(&state.account) = None;
    Ok(())
}

#[tauri::command(async)]
pub fn report_user(state: State<'_, AppState>, user_id: String, reason: String, details: String, message_ids: Vec<i64>) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.report(&s, &user_id, &reason, &details, &message_ids).map_err(err)
}

// ---------------------------------------------------------------- online friends and messages

#[derive(Serialize)]
pub struct SocialView {
    /// Your account id, so the UI knows which messages are yours.
    me: String,
    friends: Vec<FriendEntry>,
    conversations: Vec<ConversationEntry>,
}

#[tauri::command(async)]
pub fn social_overview(state: State<'_, AppState>) -> Res<SocialView> {
    let s = live_session(&state)?;
    let client = Client::new().map_err(err)?;
    Ok(SocialView { me: s.user_id.clone(), friends: client.friends(&s).map_err(err)?, conversations: client.conversations(&s).map_err(err)? })
}

#[tauri::command(async)]
pub fn friend_request(state: State<'_, AppState>, tag: String) -> Res<String> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.send_friend_request(&s, &tag).map_err(err)
}

#[tauri::command(async)]
pub fn accept_friend(state: State<'_, AppState>, user_id: String) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.accept_friend(&s, &user_id).map_err(err)
}

/// Unfriend, decline a request or cancel yours.
#[tauri::command(async)]
pub fn unfriend(state: State<'_, AppState>, user_id: String) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.remove_friend(&s, &user_id).map_err(err)
}

#[tauri::command(async)]
pub fn block_user(state: State<'_, AppState>, user_id: String) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.block(&s, &user_id).map_err(err)
}

#[tauri::command(async)]
pub fn open_chat(state: State<'_, AppState>, friend: String) -> Res<String> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.open_direct(&s, &friend).map_err(err)
}

#[tauri::command(async)]
pub fn chat_messages(state: State<'_, AppState>, conversation: String, after: i64) -> Res<Vec<ChatMessage>> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.messages(&s, &conversation, after).map_err(err)
}

#[tauri::command(async)]
pub fn send_message(state: State<'_, AppState>, conversation: String, body: String) -> Res<ChatMessage> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.send_message(&s, &conversation, &body).map_err(err)
}

#[tauri::command(async)]
pub fn mark_read(state: State<'_, AppState>, conversation: String, up_to: i64) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.mark_read(&s, &conversation, up_to).map_err(err)
}

// ---------------------------------------------------------------- friends (friend codes, no server)

#[derive(Serialize)]
pub struct FriendView {
    name: String,
    avatar: Avatar,
    games: usize,
    /// Steam games you both own (0 until your own games are imported).
    common: usize,
    added: i64,
}

fn friend_views(friends: &[Friend]) -> Vec<FriendView> {
    let lib = steam_import::load_library();
    friends
        .iter()
        .map(|f| FriendView {
            name: f.name.clone(),
            avatar: f.avatar.checked(),
            games: f.games.len(),
            common: lib.as_ref().map_or(0, |l| l.games.iter().filter(|g| f.owns(g.appid)).count()),
            added: f.added,
        })
        .collect()
}

#[derive(Serialize)]
pub struct MyCode {
    name: String,
    avatar: Avatar,
    code: String,
    /// How many Steam game ids the code carries (0 = not imported yet).
    games: usize,
}

/// Your friend code. `name` and `avatar` (optional) update what's put in it. Nothing is sent:
/// the user copies the code and shares it themselves.
#[tauri::command(async)]
pub fn my_friend_code(name: Option<String>, avatar: Option<Avatar>) -> Res<MyCode> {
    let mut cfg = Config::load().map_err(err)?;
    if name.is_some() || avatar.is_some() {
        if let Some(n) = name {
            cfg.display_name = Some(party::clean_name(&n));
        }
        if let Some(a) = avatar {
            cfg.avatar = a.checked();
        }
        cfg.save().map_err(err)?;
    }
    let name = cfg.display_name.clone().unwrap_or_else(|| "Friend".to_string());
    let me = Friend::mine(&name, cfg.avatar, steam_import::load_library().as_ref(), &History::load().taste());
    Ok(MyCode { name: me.name.clone(), avatar: me.avatar, code: me.encode(), games: me.games.len() })
}

#[tauri::command(async)]
pub fn get_friends() -> Res<Vec<FriendView>> {
    Ok(friend_views(&party::load_friends()))
}

/// Adds (or refreshes) a friend from the code they sent. The code is parsed as untrusted input.
#[tauri::command(async)]
pub fn add_friend(code: String) -> Res<FriendView> {
    let mut friend = Friend::decode(&code).map_err(err)?;
    friend.added = history::now();
    let mut friends = party::load_friends();
    party::upsert(&mut friends, friend.clone()).map_err(err)?;
    party::save_friends(&friends).map_err(err)?;
    friend_views(&[friend]).pop().ok_or_else(|| "could not add the friend".to_string())
}

#[tauri::command(async)]
pub fn remove_friend(name: String) -> Res<Vec<FriendView>> {
    let mut friends = party::load_friends();
    friends.retain(|f| !f.name.eq_ignore_ascii_case(&name));
    party::save_friends(&friends).map_err(err)?;
    Ok(friend_views(&friends))
}

#[tauri::command(async)]
pub fn open_data_dir() -> Res<()> {
    let dir = config::data_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    open::open_folder(&dir).map_err(err)
}
