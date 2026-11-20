//! Tauri commands: the bridge between the web UI (`ui/`) and freetime-core.
//!
//! Commands marked `async` run on a worker thread, so network calls and disk access
//! never freeze the window.

use freetime_core::{
    account::{self, Client, ConversationEntry, FriendEntry, Invite, Message as ChatMessage, NewInvite, OnlineProfile, ProfileEdit, Session},
    config::{self, Config},
    history::{self, History},
    keys::{self, KeySource, Keys},
    net::HttpNet,
    model::*,
    realtime,
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

pub(crate) type Res<T> = Result<T, String>;

pub(crate) fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How long a suggestion waits for Steam/YouTube/weather on startup before using offline ideas.
pub(crate) const ONLINE_WAIT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct AppState {
    online: Mutex<OnlineSlot>,
    /// Every suggestion sent to the UI, so `pick` can find it again by id.
    pub(crate) shown: Mutex<HashMap<String, Suggestion>>,
    /// The signed-in session (opt-in). Only in memory; the refresh token is in Credential Manager.
    pub(crate) account: Mutex<Option<Session>>,
    /// Friends' shared game lists (None = they don't share), with when they were fetched.
    libraries: Mutex<HashMap<String, (Instant, Option<account::SharedLibrary>)>>,
    /// Assistant chats whose answer should stop streaming (the user pressed Stop).
    pub(crate) assistant_stop: Mutex<HashSet<String>>,
    /// The live connection (Realtime) is up: changes arrive instantly.
    live: std::sync::atomic::AtomicBool,
    /// Friends' display names by id, for notifications from the live connection.
    names: Mutex<HashMap<String, String>>,
    /// Invitations recently announced, keyed by their kind and id.
    announced_invites: Mutex<HashMap<(&'static str, String), Instant>>,
    /// Your own "free until" (RFC 3339), as last set or seen live. None = not free / unknown.
    my_free_until: Mutex<Option<String>>,
    /// Social notifications sent today: (day, how many, friends already told about).
    social: Mutex<(Option<chrono::NaiveDate>, u32, HashSet<String>)>,
}

/// At most this many social notifications ("free together") a day; messages and invites don't count.
const SOCIAL_NOTIFICATIONS_A_DAY: u32 = 3;

/// Whether a "free until" time is still ahead.
fn still_free(until: Option<&str>) -> bool {
    until
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .is_some_and(|t| t > chrono::Utc::now())
}

/// A friend just became free: notify if you're free too, within the daily budget, outside quiet
/// hours, once per friend a day, and only when the window isn't in front of you.
fn free_together(app: &AppHandle, state: &AppState, me: &str, id: &str, name: &str, until: Option<&str>) {
    use chrono::Timelike;
    use tauri_plugin_notification::NotificationExt;
    if id == me {
        *lock(&state.my_free_until) = until.map(str::to_string);
        return;
    }
    if !still_free(until) {
        return;
    }
    let cfg = Config::load().unwrap_or_default();
    let hour = chrono::Local::now().hour();
    if !cfg.notify_free_together || (cfg.quiet_hours && (hour >= 22 || hour < 9)) {
        return;
    }
    if !still_free(lock(&state.my_free_until).as_deref()) {
        return;
    }
    if app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false) {
        return;
    }
    {
        let today = chrono::Local::now().date_naive();
        let mut budget = lock(&state.social);
        if budget.0 != Some(today) {
            *budget = (Some(today), 0, HashSet::new());
        }
        if budget.1 >= SOCIAL_NOTIFICATIONS_A_DAY || !budget.2.insert(id.to_string()) {
            return;
        }
        budget.1 += 1;
    }
    let at = until
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_default();
    let who = if name.trim().is_empty() { friend_name(state, id) } else { name.to_string() };
    let _ = app
        .notification()
        .builder()
        .title(format!("{who} is free too"))
        .body(format!("Until {at}. Open freetime to find something to do together."))
        .show();
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
pub(crate) fn current_online(state: &AppState, wait: Duration) -> (Arc<Online>, bool) {
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
    pub(crate) s: Suggestion,
    reasons: Vec<String>,
    pub(crate) duration: String,
    pub(crate) icon: &'static str,
    pub(crate) category_label: &'static str,
}

pub(crate) fn card(r: &Ranked) -> Card {
    Card {
        s: r.s.clone(),
        reasons: r.reasons.clone(),
        duration: r.s.duration_label(),
        icon: r.s.category.icon(),
        category_label: r.s.category.label(),
    }
}

pub(crate) fn remember<'a>(state: &AppState, cards: impl Iterator<Item = &'a Card>) {
    let mut shown = lock(&state.shown);
    for c in cards {
        shown.insert(c.s.id.clone(), c.s.clone());
    }
}

/// An online friend picked in "Playing with": their id, and the name to show in reasons.
#[derive(Deserialize, Clone)]
pub struct OnlineMate {
    pub(crate) id: String,
    pub(crate) name: String,
}

/// Shared game lists of online friends, kept 10 minutes so re-ranking doesn't refetch them.
fn friend_libraries(state: &AppState, mates: &[OnlineMate]) -> HashMap<String, account::SharedLibrary> {
    const KEEP: Duration = Duration::from_secs(600);
    let mut out = HashMap::new();
    let missing: Vec<String> = {
        let cache = lock(&state.libraries);
        mates
            .iter()
            .filter(|m| match cache.get(&m.id) {
                Some((at, lib)) if at.elapsed() < KEEP => {
                    if let Some(l) = lib {
                        out.insert(m.id.clone(), l.clone());
                    }
                    false
                }
                _ => true,
            })
            .map(|m| m.id.clone())
            .collect()
    };
    if missing.is_empty() {
        return out;
    }
    let (Ok(s), Ok(client)) = (live_session(state), Client::new()) else { return out };
    if let Ok(libs) = client.libraries(&s, &missing) {
        let mut cache = lock(&state.libraries);
        for id in &missing {
            let lib = libs.iter().find(|l| &l.user_id == id).cloned();
            if let Some(l) = &lib {
                out.insert(id.clone(), l.clone());
            }
            cache.insert(id.clone(), (Instant::now(), lib));
        }
    }
    out
}

/// `party`: names of friends added by code; `mates`: online friends. Only used when the request
/// is "with friends"; otherwise this is the solo ranking. Games everyone owns are looked up on
/// the Steam store (cached) to tell co-op from versus and single-player.
pub(crate) fn rank(state: &AppState, cfg: &Config, req: &Request, online: &Online, exclude: &[String], party: &[String], mates: &[OnlineMate]) -> Vec<Ranked> {
    let prefs = History::load().prefs(history::now());
    let exclude: HashSet<String> = exclude.iter().cloned().collect();
    if !req.with_friends || (party.is_empty() && mates.is_empty()) {
        return freetime_core::rank(cfg, req, online, &prefs, &exclude);
    }
    let together = party_for(state, party, mates);
    freetime_core::rank_together(cfg, req, online, &prefs, &exclude, Some(&together))
}

/// The friends you're with (by code and online), the games you all own, and how those can be
/// played together (looked up on the Steam store, cached).
pub(crate) fn party_for(state: &AppState, party: &[String], mates: &[OnlineMate]) -> party::Party {
    let mut chosen: Vec<Friend> = party::load_friends()
        .into_iter()
        .filter(|f| party.iter().any(|n| n.eq_ignore_ascii_case(&f.name)))
        .collect();
    if !mates.is_empty() {
        let libs = friend_libraries(state, mates);
        for m in mates.iter().take(20) {
            let lib = libs.get(&m.id);
            let mut taste = [0i8; 8];
            if let Some(l) = lib {
                for (slot, v) in taste.iter_mut().zip(&l.taste) {
                    *slot = (*v).clamp(-100, 100) as i8;
                }
            }
            let mut games = lib.map(|l| l.app_ids.clone()).unwrap_or_default();
            games.sort_unstable();
            games.dedup();
            chosen.push(Friend { name: party::clean_name(&m.name), games, taste, added: 0, avatar: Default::default() });
        }
    }
    let mut together = party::Party::new(chosen, steam_import::load_library().as_ref());
    let shared = together.common_ids(24);
    if !shared.is_empty() {
        if let Ok(net) = HttpNet::new() {
            together.set_modes(steam::together_modes(&net, &shared, 24));
        }
    }
    together
}

// ---------------------------------------------------------------- sharing your game list (opt-in)

#[derive(Serialize)]
pub struct ShareView {
    enabled: bool,
    /// How many Steam games would be (or are) shared: the imported ones.
    games: usize,
}

#[tauri::command(async)]
pub fn get_share_library() -> Res<ShareView> {
    let cfg = Config::load().map_err(err)?;
    let games = steam_import::load_library().map_or(0, |l| l.games.len());
    Ok(ShareView { enabled: cfg.share_library, games })
}

/// Uploads your Steam app ids and taste (or deletes them) and remembers the choice.
fn upload_library(client: &Client, s: &Session) -> Res<usize> {
    let cfg = Config::load().map_err(err)?;
    let me = Friend::mine(cfg.display_name.as_deref().unwrap_or("Friend"), cfg.avatar, steam_import::load_library().as_ref(), &History::load().taste());
    client.share_library(s, &me.games, &me.taste).map_err(err)?;
    Ok(me.games.len())
}

#[tauri::command(async)]
pub fn set_share_library(state: State<'_, AppState>, enabled: bool) -> Res<ShareView> {
    let s = live_session(&state)?;
    let client = Client::new().map_err(err)?;
    if enabled {
        upload_library(&client, &s)?;
    } else {
        client.stop_sharing_library(&s).map_err(err)?;
    }
    let mut cfg = Config::load().map_err(err)?;
    cfg.share_library = enabled;
    cfg.save().map_err(err)?;
    get_share_library()
}

/// After a Steam import: refresh the shared list if sharing is on (best effort).
fn refresh_shared_library(state: &AppState) {
    if Config::load().map(|c| c.share_library).unwrap_or(false) {
        if let (Ok(s), Ok(client)) = (live_session(state), Client::new()) {
            let _ = upload_library(&client, &s);
        }
    }
}

#[derive(Serialize)]
pub struct Pending {
    id: String,
    ts: i64,
    title: String,
    icon: &'static str,
    category: Category,
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
                category: e.category,
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
    mates: Option<Vec<OnlineMate>>,
) -> Res<Results> {
    let cfg = Config::load().map_err(err)?;
    let (online, partial) = current_online(&state, ONLINE_WAIT);
    let ranked = rank(&state, &cfg, &req, &online, &exclude, &party.unwrap_or_default(), &mates.unwrap_or_default());
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
    let ranked = rank(&state, &cfg, &Request::for_now(), &online, &exclude, &[], &[]);
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
    mistral_key_set: bool,
    mistral_key_from_env: bool,
    /// The model the assistant uses (the default when none was picked).
    assistant_model: String,
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
        mistral_key_set: keys.mistral.is_some(),
        mistral_key_from_env: from_env(&keys.mistral),
        assistant_model: crate::assistant::model_of(cfg),
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
    #[serde(default)]
    mistral_key: String,
    #[serde(default)]
    clear_mistral_key: bool,
    /// Empty or None = the default model.
    #[serde(default)]
    assistant_model: Option<String>,
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
    if input.clear_mistral_key {
        keys::save_user_key(keys::MISTRAL, None).map_err(err)?;
    } else if !input.mistral_key.trim().is_empty() {
        keys::save_user_key(keys::MISTRAL, Some(&input.mistral_key)).map_err(err)?;
    }
    if let Some(model) = input.assistant_model {
        let model = model.trim();
        cfg.assistant.model = (!model.is_empty()).then(|| model.to_string());
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
    // Sharing is on: friends get the new list too.
    refresh_shared_library(&app.state::<AppState>());
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
pub(crate) fn live_session(state: &AppState) -> Res<Session> {
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
            photo: None,
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

#[tauri::command(async)]
pub fn profile_photos(state: State<'_, AppState>, ids: Vec<String>) -> Res<Vec<account::ProfilePhoto>> {
    let session = live_session(&state)?;
    Client::new().map_err(err)?.profile_photos(&session, &ids).map_err(err)
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

// ---------------------------------------------------------------- weekly recap (local only)

#[derive(Serialize)]
pub struct KindCount {
    category: Category,
    label: &'static str,
    picks: usize,
}

#[derive(Serialize)]
pub struct MemoryView {
    when: String,
    title: String,
    category: Category,
    label: &'static str,
    loved: bool,
}

#[derive(Serialize)]
pub struct RecapView {
    week_picks: usize,
    week_minutes: u32,
    week_loved: usize,
    last_week_picks: usize,
    last_week_minutes: u32,
    streak_weeks: u32,
    best_streak: u32,
    this_week_active: bool,
    /// "2026-W47": which week this is, so the UI can remember a dismissed recap.
    week: String,
    kinds: Vec<KindCount>,
    memories: Vec<MemoryView>,
}

/// This week, last week, the streak and memories, from the history on this PC (no network).
#[tauri::command(async)]
pub fn get_recap() -> Res<RecapView> {
    use chrono::Datelike;
    let now = chrono::Local::now();
    let r = History::load().recap(now);
    Ok(RecapView {
        week_picks: r.week_picks,
        week_minutes: r.week_minutes,
        week_loved: r.week_loved,
        last_week_picks: r.last_week_picks,
        last_week_minutes: r.last_week_minutes,
        streak_weeks: r.streak_weeks,
        best_streak: r.best_streak,
        this_week_active: r.this_week_active,
        week: format!("{}-W{:02}", now.iso_week().year(), now.iso_week().week()),
        kinds: r.week_by_category.into_iter().map(|(category, picks)| KindCount { category, label: category.label(), picks }).collect(),
        memories: r
            .memories
            .into_iter()
            .map(|m| MemoryView { when: m.when, title: m.title, category: m.category, label: m.category.label(), loved: m.loved })
            .collect(),
    })
}

// ---------------------------------------------------------------- the live connection (instant)

#[derive(Serialize, Clone)]
struct LiveMessage {
    message: ChatMessage,
    /// Sent by the signed-in user (from this or another device).
    mine: bool,
}

/// A friend's display name, from the cache or the friends list (fetched once when missing).
fn friend_name(state: &AppState, id: &str) -> String {
    if let Some(n) = lock(&state.names).get(id) {
        return n.clone();
    }
    if let (Ok(s), Ok(client)) = (live_session(state), Client::new()) {
        if let Ok(friends) = client.friends(&s) {
            let mut names = lock(&state.names);
            for f in friends {
                names.insert(f.user_id, f.display_name);
            }
        }
    }
    lock(&state.names).get(id).cloned().unwrap_or_else(|| "A friend".to_string())
}

fn main_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false)
}

const INVITE_REMINDER_DELAY: Duration = Duration::from_secs(120);

fn remember_invite(state: &AppState, kind: &'static str, id: &str) -> bool {
    let mut recent = lock(&state.announced_invites);
    recent.retain(|_, sent| sent.elapsed() < INVITE_REMINDER_DELAY);
    recent.insert((kind, id.to_owned()), Instant::now()).is_none()
}

fn show_game_invite(app: &AppHandle, kind: &str, id: &str, native: impl FnOnce()) {
    if main_focused(app) {
        let _ = app.emit("game-invite-new", serde_json::json!({ "kind": kind, "id": id }));
    } else {
        native();
    }
}

fn show_pick_invite(app: &AppHandle, id: i64, category: &str, title: &str, starts_at: &str, who: impl FnOnce() -> String) {
    use tauri_plugin_notification::NotificationExt;
    let state = app.state::<AppState>();
    let id = id.to_string();
    if !remember_invite(&state, "pick", &id) {
        return;
    }
    let native = || {
        let at = chrono::DateTime::parse_from_rfc3339(starts_at)
            .map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string())
            .unwrap_or_default();
        let _ = app.notification().builder().title(format!("{} invites you", who())).body(format!("{title} · {at}")).show();
    };
    if category == "game" {
        show_game_invite(app, "pick", &id, native);
    } else if !main_focused(app) {
        native();
    }
}

fn on_live_event(app: &AppHandle, event: realtime::Event) {
    use std::sync::atomic::Ordering;
    use tauri_plugin_notification::NotificationExt;
    let state = app.state::<AppState>();
    let me = lock(&state.account).as_ref().map(|s| s.user_id.clone()).unwrap_or_default();
    let notify = || {
        Config::load().map(|c| c.notify_messages).unwrap_or(false)
            && !main_focused(app)
    };
    let notify_invites = || {
        Config::load().map(|c| c.notify_invites).unwrap_or(false)
    };
    match event {
        realtime::Event::Live => {
            state.live.store(true, Ordering::Relaxed);
            let _ = app.emit("live-status", true);
        }
        realtime::Event::Down => {
            state.live.store(false, Ordering::Relaxed);
            let _ = app.emit("live-status", false);
        }
        realtime::Event::Message(m) => {
            let mine = m.sender == me;
            if !mine && notify() {
                let preview: String = m.body.split_whitespace().collect::<Vec<_>>().join(" ");
                let preview = if preview.chars().count() > 120 { preview.chars().take(117).collect::<String>() + "…" } else { preview };
                let _ = app.notification().builder().title(format!("{} on freetime", friend_name(&state, &m.sender))).body(preview).show();
            }
            let _ = app.emit("message-new", LiveMessage { message: m, mine });
        }
        realtime::Event::Invite { id, from_user, to_user, title, category, starts_at, inserted, status } => {
            if inserted && to_user == me && status == "pending" && notify_invites() {
                show_pick_invite(app, id, &category, &title, &starts_at, || friend_name(&state, &from_user));
            }
            let _ = app.emit("invites-changed", ());
        }
        realtime::Event::Profile { id, display_name, free_until } => {
            free_together(app, &state, &me, &id, &display_name, free_until.as_deref());
            // Discover's "free now" strip refreshes right away.
            let _ = app.emit("friend-free-changed", ());
        }
        realtime::Event::Duel { id, challenger, opponent, status, inserted } => {
            // A friend challenged you, or played their side of your duel.
            if notify_invites() {
                if inserted && opponent == me && status == "open" && remember_invite(&state, "duel", &id) {
                    show_game_invite(app, "duel", &id, || {
                        let _ = app.notification().builder().title(format!("{} challenges you", friend_name(&state, &challenger))).body("A quiz duel: 5 questions, your turn").show();
                    });
                } else if !inserted && status == "done" && !main_focused(app) {
                    let other = if challenger == me { &opponent } else { &challenger };
                    let _ = app.notification().builder().title("Quiz duel finished").body(format!("See who won against {}", friend_name(&state, other))).show();
                }
            }
            let _ = app.emit("duels-changed", ());
            if !inserted && status == "done" {
                let _ = app.emit("game-ranking-changed", "quiz-duel");
            }
        }
        realtime::Event::Match { id, game, player_a, player_b, turn, status, b_moved, inserted } => {
            // A friend started a game with you, or played: your turn.
            let mine = if player_a == me { Some(0) } else if player_b == me { Some(1) } else { None };
            if let Some(me_idx) = mine {
                let other = if me_idx == 0 { &player_b } else { &player_a };
                let name = match game.as_str() {
                    "four" => "Four in a row",
                    "gomoku" => "Giant tic-tac-toe",
                    "draughts" => "Draughts",
                    "dots" => "Dots and boxes",
                    "chess" => "Chess",
                    "torpedoes" => "Torpedoes",
                    _ => "A game",
                };
                if status == "active" && notify_invites() {
                    if inserted && me_idx == 1 && remember_invite(&state, "match", &id) {
                        show_game_invite(app, "match", &id, || {
                            let _ = app.notification().builder().title(format!("{} challenges you", friend_name(&state, other))).body(name).show();
                        });
                    } else if !inserted && turn == Some(me_idx) && !main_focused(app) {
                        // The challenger can play immediately after inviting you.
                        let just_invited = me_idx == 1 && !b_moved
                            && lock(&state.announced_invites).get(&("match", id))
                                .is_some_and(|sent| sent.elapsed() < INVITE_REMINDER_DELAY);
                        if !just_invited {
                            let _ = app.notification().builder().title(format!("Your turn against {}", friend_name(&state, other))).body(name).show();
                        }
                    }
                }
            }
            let _ = app.emit("matches-changed", ());
            if !inserted && status == "done" {
                let _ = app.emit("game-ranking-changed", game);
            }
        }
    }
}

/// Keeps the live connection while signed in (nothing at all while signed out).
pub fn watch_live(app: AppHandle) {
    thread::spawn(move || {
        let stop = std::sync::atomic::AtomicBool::new(false);
        let for_token = app.clone();
        let for_events = app.clone();
        realtime::run(
            move || {
                let state = for_token.state::<AppState>();
                let signed_in = lock(&state.account).is_some() || account::has_saved_session();
                if !signed_in {
                    return None;
                }
                live_session(&state).ok().map(|s| s.access_token)
            },
            move |e| on_live_event(&for_events, e),
            &stop,
        );
    });
}

#[tauri::command]
pub fn live_status(state: State<'_, AppState>) -> bool {
    state.live.load(std::sync::atomic::Ordering::Relaxed)
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
        let mut seen_invites: HashSet<i64> = HashSet::new();
        let mut baseline = true;
        let mut invite_account = None;
        thread::sleep(Duration::from_secs(8));
        loop {
            let config = Config::load().ok();
            let messages_enabled = config.as_ref().is_some_and(|c| c.notify_messages);
            let invites_enabled = config.as_ref().is_some_and(|c| c.notify_invites);
            let state = app.state::<AppState>();
            let signed_in = lock(&state.account).is_some() || account::has_saved_session();
            if !signed_in || !messages_enabled {
                seen.clear();
                baseline = true;
            }
            if !signed_in {
                if invite_account.take().is_some() {
                    let _ = app.emit("invites-updated", 0);
                }
                seen_invites.clear();
            } else if let (Ok(s), Ok(client)) = (live_session(&state), Client::new()) {
                if let Ok(invites) = client.invites(&s) {
                    let first_check = invite_account.as_deref() != Some(s.user_id.as_str());
                    if first_check {
                        seen_invites.clear();
                        invite_account = Some(s.user_id.clone());
                    }
                    let waiting: Vec<&Invite> = invites.iter().filter(|i| i.direction == "incoming" && i.status == "pending").collect();
                    let _ = app.emit("invites-updated", waiting.len());
                    let announce = !first_check && invites_enabled
                        && !state.live.load(std::sync::atomic::Ordering::Relaxed);
                    for i in waiting {
                        if seen_invites.insert(i.id) && announce {
                            show_pick_invite(&app, i.id, &i.category, &i.title, &i.starts_at, || i.other_name.clone());
                        }
                    }
                }
                if let Some(convs) = messages_enabled.then(|| client.conversations(&s).ok()).flatten() {
                    let _ = app.emit("unread-updated", convs.iter().map(|c| c.unread).sum::<i64>());
                    // Quiet while the window is in front, or while the live connection already notified.
                    let focused = main_focused(&app)
                        || state.live.load(std::sync::atomic::Ordering::Relaxed);
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

// ---------------------------------------------------------------- free now and invites

/// "I'm free for N minutes" (0 = not any more). Returns when it ends.
#[tauri::command(async)]
pub fn set_free(state: State<'_, AppState>, minutes: u32) -> Res<Option<String>> {
    let s = live_session(&state)?;
    let until = Client::new().map_err(err)?.set_free(&s, minutes).map_err(err)?;
    *lock(&state.my_free_until) = until.clone();
    Ok(until)
}

#[tauri::command(async)]
pub fn get_invites(state: State<'_, AppState>) -> Res<Vec<Invite>> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.invites(&s).map_err(err)
}

/// Sends one pick to several friends. Returns how many invites went out.
#[tauri::command(async)]
pub fn send_invites(state: State<'_, AppState>, invites: Vec<NewInvite>) -> Res<usize> {
    if invites.len() > 20 {
        return Err("invite at most 20 friends at once".to_string());
    }
    let s = live_session(&state)?;
    let client = Client::new().map_err(err)?;
    let mut sent = 0;
    for invite in &invites {
        client.send_invite(&s, invite).map_err(err)?;
        sent += 1;
    }
    Ok(sent)
}

#[tauri::command(async)]
pub fn answer_invite(state: State<'_, AppState>, id: i64, accept: bool) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.answer_invite(&s, id, accept).map_err(err)
}

#[tauri::command(async)]
pub fn cancel_invite(state: State<'_, AppState>, id: i64) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.cancel_invite(&s, id).map_err(err)
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
