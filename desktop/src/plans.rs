//! Doing things together, part two: your record against a friend after a game, evenings with
//! two times and up to three things to do, "not now" answers on Discover, and your preferences on
//! all your devices (only when you ask). The rules live in the database
//! (supabase/migrations/*_game_rematch.sql, *_evenings.sql, *_synced_preferences.sql).

use crate::commands::{card, current_online, err, live_session, lock, party_for, remember, AppState, Card, OnlineMate, ONLINE_WAIT};
use freetime_core::{
    account::{Client, NewEvening},
    config::Config,
    history::{self, History, NotNow, Tuning},
    model::Request,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

type Res<T> = Result<T, String>;

// ---------------------------------------------------------------- "shall we play now?"

#[derive(Serialize)]
pub struct PlayNowView {
    /// Steam games you both own.
    common: usize,
    /// The best of those for right now (at most three).
    picks: Vec<Card>,
}

/// A friend is free: the Steam games you both own, best first for the time you both have.
#[tauri::command(async)]
pub fn play_now(state: State<'_, AppState>, req: Request, mate: OnlineMate) -> Res<PlayNowView> {
    let cfg = Config::load().map_err(err)?;
    let (online, _) = current_online(&state, ONLINE_WAIT);
    let together = party_for(&state, &[], std::slice::from_ref(&mate));
    let prefs = History::load().prefs(history::now());
    let found = freetime_core::play_now(&cfg, &req, &online, &prefs, &together);
    let picks: Vec<Card> = found.picks.iter().map(card).collect();
    remember(&state, picks.iter());
    Ok(PlayNowView { common: found.common, picks })
}

// ---------------------------------------------------------------- end of a game

#[tauri::command(async)]
pub fn head_to_head(state: State<'_, AppState>, other: String, game: Option<String>) -> Res<Value> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.head_to_head(&s, &other, game.as_deref()).map_err(err)
}

// ---------------------------------------------------------------- friends' times on the games of the day

#[tauri::command(async)]
pub fn share_daily_result(state: State<'_, AppState>, day: String, kind: String, secs: u32, score: Option<u32>) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.share_daily_result(&s, &day, &kind, secs, score).map_err(err)
}

#[tauri::command(async)]
pub fn stop_sharing_daily_results(state: State<'_, AppState>) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.stop_sharing_daily_results(&s).map_err(err)
}

#[tauri::command(async)]
pub fn friends_daily_results(state: State<'_, AppState>, day: String) -> Res<Value> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.friends_daily_results(&s, &day).map_err(err)
}

// ---------------------------------------------------------------- evenings

#[tauri::command(async)]
pub fn create_evening(state: State<'_, AppState>, evening: NewEvening) -> Res<i64> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.create_evening(&s, &evening).map_err(err)
}

#[tauri::command(async)]
pub fn answer_evening(state: State<'_, AppState>, id: i64, slots: Vec<bool>, activity: Option<u8>) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.answer_evening(&s, id, &slots, activity).map_err(err)
}

#[tauri::command(async)]
pub fn settle_evening(state: State<'_, AppState>, id: i64, slot: u8, activity: u8) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.settle_evening(&s, id, slot, activity).map_err(err)
}

#[tauri::command(async)]
pub fn cancel_evening(state: State<'_, AppState>, id: i64) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.cancel_evening(&s, id).map_err(err)
}

#[tauri::command(async)]
pub fn my_evenings(state: State<'_, AppState>) -> Res<Value> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.my_evenings(&s).map_err(err)
}

/// The optional reminder before an evening: a Windows notification (the app asks for it when the
/// time comes; nothing is scheduled outside the app).
#[tauri::command]
pub fn remind(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let clip = |t: &str, n: usize| t.chars().filter(|c| !c.is_control()).take(n).collect::<String>();
    let _ = app.notification().builder().title(clip(&title, 80)).body(clip(&body, 160)).show();
}

// ---------------------------------------------------------------- "not now" on Discover

/// "Too long", "already done" or "another time" about an idea on screen. Tunes the next picks.
#[tauri::command(async)]
pub fn not_now(state: State<'_, AppState>, id: String, reason: NotNow, minutes: u32) -> Res<()> {
    let s = lock(&state.shown)
        .get(&id)
        .cloned()
        .ok_or_else(|| "That idea isn't available anymore. Refresh your picks.".to_string())?;
    let mut h = History::load();
    h.not_now(&s, reason, minutes, history::now());
    h.save().map_err(err)
}

// ---------------------------------------------------------------- preferences on all your devices

/// What the interface keeps itself (Discover shortcuts, the usual context), sent along as is.
#[derive(Deserialize, Serialize)]
pub struct Saved {
    #[serde(default)]
    extra: Value,
    #[serde(default)]
    tuning: Tuning,
}

/// Saves your shortcuts, usual context and what tunes the picks to your account.
#[tauri::command(async)]
pub fn save_preferences(state: State<'_, AppState>, extra: Value) -> Res<String> {
    let s = live_session(&state)?;
    let data = json!({ "version": 1, "extra": extra, "tuning": History::load().tuning() });
    Client::new().map_err(err)?.save_my_preferences(&s, &data).map_err(err)
}

/// Brings the saved preferences here: merges what tunes the picks into this device's history and
/// returns the rest for the interface. Null when nothing was saved.
#[tauri::command(async)]
pub fn load_preferences(state: State<'_, AppState>) -> Res<Value> {
    let s = live_session(&state)?;
    let v = Client::new().map_err(err)?.my_preferences(&s).map_err(err)?;
    if v.is_null() {
        return Ok(Value::Null);
    }
    let saved: Saved = serde_json::from_value(v["data"].clone()).map_err(|_| "Those saved preferences can't be read.".to_string())?;
    let mut h = History::load();
    let added = h.merge_tuning(saved.tuning);
    h.save().map_err(err)?;
    Ok(json!({ "extra": saved.extra, "saved_at": v["saved_at"], "added": added }))
}

/// When preferences were last saved to your account (or null), without changing anything here.
#[tauri::command(async)]
pub fn preferences_status(state: State<'_, AppState>) -> Res<Value> {
    let s = live_session(&state)?;
    let v = Client::new().map_err(err)?.my_preferences(&s).map_err(err)?;
    Ok(if v.is_null() { Value::Null } else { json!({ "saved_at": v["saved_at"] }) })
}

#[tauri::command(async)]
pub fn forget_preferences(state: State<'_, AppState>) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.forget_my_preferences(&s).map_err(err)
}
