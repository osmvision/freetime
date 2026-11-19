//! Friends' feed: what you and your friends shared in the last 7 days, with reactions, and the
//! social settings (notifications, quiet hours, sharing). Signed in only for the feed.

use crate::commands::{err, live_session, AppState};
use freetime_core::{account::Client, config::Config};
use serde::{Deserialize, Serialize};
use tauri::State;

type Res<T> = Result<T, String>;

#[tauri::command(async)]
pub fn friend_feed(state: State<'_, AppState>) -> Res<serde_json::Value> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.friend_feed(&s).map_err(err)
}

#[derive(Deserialize)]
pub struct NewPost {
    kind: String,
    idea_id: Option<String>,
    title: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    detail: String,
}

#[tauri::command(async)]
pub fn share_post(state: State<'_, AppState>, post: NewPost) -> Res<i64> {
    let s = live_session(&state)?;
    // Only ids the app itself makes: built-in ideas, Steam games, videos, Epic games, quizzes.
    let idea = post.idea_id.filter(|id| {
        id.len() <= 90 && id.split_once(':').is_some_and(|(p, rest)| matches!(p, "idea" | "steam" | "yt" | "epic" | "quiz") && !rest.is_empty())
    });
    Client::new()
        .map_err(err)?
        .share_post(&s, &post.kind, idea.as_deref(), &post.title, &post.category, &post.detail)
        .map_err(err)
}

#[tauri::command(async)]
pub fn delete_post(state: State<'_, AppState>, id: i64) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.delete_post(&s, id).map_err(err)
}

#[tauri::command(async)]
pub fn toggle_reaction(state: State<'_, AppState>, post: i64, emoji: String) -> Res<bool> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.toggle_reaction(&s, post, &emoji).map_err(err)
}

#[derive(Serialize, Deserialize)]
pub struct SocialPrefs {
    notify_messages: bool,
    notify_invites: bool,
    notify_free_together: bool,
    quiet_hours: bool,
    /// "ask", "always" or "never"
    share_activity: String,
}

#[tauri::command(async)]
pub fn get_social_prefs() -> Res<SocialPrefs> {
    let c = Config::load().map_err(err)?;
    Ok(SocialPrefs {
        notify_messages: c.notify_messages,
        notify_invites: c.notify_invites,
        notify_free_together: c.notify_free_together,
        quiet_hours: c.quiet_hours,
        share_activity: c.share_activity,
    })
}

#[tauri::command(async)]
pub fn set_social_prefs(prefs: SocialPrefs) -> Res<SocialPrefs> {
    let mut c = Config::load().map_err(err)?;
    c.notify_messages = prefs.notify_messages;
    c.notify_invites = prefs.notify_invites;
    c.notify_free_together = prefs.notify_free_together;
    c.quiet_hours = prefs.quiet_hours;
    c.share_activity = match prefs.share_activity.as_str() {
        "always" | "never" => prefs.share_activity,
        _ => "ask".to_string(),
    };
    c.save().map_err(err)?;
    get_social_prefs()
}

/// Streaks together with each friend (weeks in a row with an accepted invite, one wildcard a
/// month). Keyed by friend id; friends with nothing together yet are left out.
#[tauri::command(async)]
pub fn together_streaks(state: State<'_, AppState>) -> Res<std::collections::HashMap<String, freetime_core::streaks::Streak>> {
    let s = live_session(&state)?;
    let weeks = Client::new().map_err(err)?.together_weeks(&s).map_err(err)?;
    let today = chrono::Local::now().date_naive();
    let mut by_friend: std::collections::HashMap<String, Vec<chrono::NaiveDate>> = std::collections::HashMap::new();
    for (friend, week) in weeks {
        by_friend.entry(friend).or_default().push(week);
    }
    Ok(by_friend
        .into_iter()
        .map(|(friend, w)| (friend, freetime_core::streaks::streak(&w, today)))
        .filter(|(_, s)| s.best > 0)
        .collect())
}
