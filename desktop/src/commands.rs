//! Tauri commands: the bridge between the web UI (`ui/`) and freetime-core.
//!
//! Commands marked `async` run on a worker thread, so network calls and disk access
//! never freeze the window.

use freetime_core::{
    config::{self, Config},
    history::{self, History},
    net::HttpNet,
    model::*,
    open,
    providers::{self, steam, Note, Online},
    scoring::{self, Ranked},
    weather::{self, Weather},
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

fn rank(cfg: &Config, req: &Request, online: &Online, exclude: &[String]) -> Vec<Ranked> {
    let prefs = History::load().prefs(history::now());
    let exclude: HashSet<String> = exclude.iter().cloned().collect();
    freetime_core::rank(cfg, req, online, &prefs, &exclude)
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
            steam: cfg.steam_key().is_some() && cfg.steam.steam_id.is_some(),
            youtube: cfg.youtube_key().is_some() || !cfg.youtube.channels.is_empty(),
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
) -> Res<Results> {
    let cfg = Config::load().map_err(err)?;
    let (online, partial) = current_online(&state, ONLINE_WAIT);
    let ranked = rank(&cfg, &req, &online, &exclude);
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
    let ranked = rank(&cfg, &Request::for_now(), &online, &exclude);
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
    country: String,
    interests: Vec<String>,
    steam_key_set: bool,
    steam_key_from_env: bool,
    steam_id: Option<String>,
    youtube_key_set: bool,
    youtube_key_from_env: bool,
    channels: Vec<String>,
    config_path: String,
    data_dir: String,
}

fn env_set(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.trim().is_empty())
}

fn settings_view(cfg: &Config) -> SettingsView {
    SettingsView {
        city: cfg.city.clone(),
        country: cfg.country.clone(),
        interests: cfg.interests.clone(),
        steam_key_set: cfg.steam_key().is_some(),
        steam_key_from_env: env_set("STEAM_API_KEY"),
        steam_id: cfg.steam.steam_id.clone(),
        youtube_key_set: cfg.youtube_key().is_some(),
        youtube_key_from_env: env_set("YOUTUBE_API_KEY"),
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
    city: String,
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

    let city = input.city.trim();
    if city.is_empty() {
        cfg.city = None;
        cfg.latitude = None;
        cfg.longitude = None;
    } else if !cfg.city.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(city)) || cfg.latitude.is_none() {
        match weather::geocode(&net, city) {
            Ok(Some(place)) => {
                say(true, format!("📍 Location set to {}", place.display()));
                if !place.country_code.is_empty() {
                    cfg.country = place.country_code.to_lowercase();
                }
                cfg.latitude = Some(place.latitude);
                cfg.longitude = Some(place.longitude);
                cfg.city = Some(place.name);
            }
            Ok(None) => say(false, format!("Couldn't find a place called “{city}”.")),
            Err(e) => say(false, format!("Location lookup failed ({e}).")),
        }
    }

    cfg.interests = clean_list(input.interests);

    if input.clear_steam_key {
        cfg.steam.api_key = None;
    } else if !input.steam_key.trim().is_empty() {
        cfg.steam.api_key = Some(input.steam_key.trim().to_string());
    }
    let profile = input.steam_profile.trim();
    if profile.is_empty() {
        cfg.steam.steam_id = None;
    } else if cfg.steam.steam_id.as_deref() != Some(profile) {
        match cfg.steam_key() {
            None => say(false, "Add a Steam Web API key to connect your profile.".into()),
            Some(key) => match steam::resolve_steam_id(&net, &key, profile) {
                Ok(id) => {
                    say(true, "🎮 Steam profile connected".into());
                    cfg.steam.steam_id = Some(id);
                }
                Err(e) => say(false, format!("Steam: {e}")),
            },
        }
    }

    if input.clear_youtube_key {
        cfg.youtube.api_key = None;
    } else if !input.youtube_key.trim().is_empty() {
        cfg.youtube.api_key = Some(input.youtube_key.trim().to_string());
    }
    cfg.youtube.channels = clean_list(input.channels);

    cfg.save().map_err(err)?;
    say(true, "Settings saved".into());
    refresh_in_background(&app);
    Ok(SaveReport { settings: settings_view(&cfg), messages })
}

#[tauri::command(async)]
pub fn open_data_dir() -> Res<()> {
    let dir = config::data_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    open::open_folder(&dir).map_err(err)
}
