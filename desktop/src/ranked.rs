//! Ranked screen: this season's points, tier and boards (friends, global), and player cards.
//! Points are computed on this PC (core/src/ranked.rs) and sent only while signed in.

use crate::commands::{err, live_session, AppState};
use freetime_core::{account::{BoardRow, Client}, catalog, history::History, quiz::QuizLog, ranked};
use serde::Serialize;
use tauri::State;

type Res<T> = Result<T, String>;

/// Sends today's and yesterday's points (yesterday catches what was finished late), returns
/// today's breakdown. The server keeps the best value of each day, so sending twice is fine.
fn sync(client: &Client, s: &freetime_core::account::Session) -> Res<ranked::DayPoints> {
    let now = chrono::Local::now();
    let today = now.date_naive();
    let history = History::load();
    let catalog = catalog::load();
    let quizzes = QuizLog::load();
    let stats = ranked::stats(&history, &catalog, now);
    if let Some(y) = today.pred_opt() {
        let p = ranked::day_points(&history, &catalog, &quizzes, y);
        if p.total > 0 {
            client.submit_points(s, y, p.total, &stats).map_err(err)?;
        }
    }
    let p = ranked::day_points(&history, &catalog, &quizzes, today);
    client.submit_points(s, today, p.total, &stats).map_err(err)?;
    Ok(p)
}

/// After a pick, a rating or a quiz: send the new points. Quiet when signed out or offline.
#[tauri::command(async)]
pub fn sync_points(state: State<'_, AppState>) -> Res<()> {
    let Ok(s) = live_session(&state) else { return Ok(()) };
    let client = Client::new().map_err(err)?;
    sync(&client, &s).map(|_| ())
}

#[derive(Serialize)]
pub struct RankedView {
    /// "2026-11"
    season: String,
    days_left: u32,
    today: ranked::DayPoints,
    points: i64,
    tier: ranked::Tier,
    show_in_global: bool,
    global_rank: Option<i64>,
    global_players: i64,
    scope: String,
    rows: Vec<BoardRow>,
}

#[tauri::command(async)]
pub fn ranked_overview(state: State<'_, AppState>, scope: String) -> Res<RankedView> {
    use chrono::Datelike;
    let s = live_session(&state)?;
    let client = Client::new().map_err(err)?;
    let today = sync(&client, &s)?;
    let mine = client.my_ranking(&s).map_err(err)?;
    let rows = client.leaderboard(&s, &scope).map_err(err)?;
    let now = chrono::Local::now().date_naive();
    let next_month = if now.month() == 12 { chrono::NaiveDate::from_ymd_opt(now.year() + 1, 1, 1) } else { chrono::NaiveDate::from_ymd_opt(now.year(), now.month() + 1, 1) };
    Ok(RankedView {
        season: format!("{}-{:02}", now.year(), now.month()),
        days_left: next_month.map_or(0, |n| (n - now).num_days() as u32),
        today,
        points: mine.points,
        tier: ranked::tier(mine.points.max(0) as u32),
        show_in_global: mine.show_in_global,
        global_rank: mine.global_rank,
        global_players: mine.global_players,
        scope,
        rows,
    })
}

#[derive(Serialize)]
pub struct CardView {
    card: serde_json::Value,
    tier: ranked::Tier,
}

#[tauri::command(async)]
pub fn player_card(state: State<'_, AppState>, user_id: String) -> Res<CardView> {
    let s = live_session(&state)?;
    let card = Client::new()
        .map_err(err)?
        .player_card(&s, &user_id)
        .map_err(err)?
        .ok_or_else(|| "This player's card isn't visible to you.".to_string())?;
    let points = card.get("points").and_then(serde_json::Value::as_i64).unwrap_or(0);
    Ok(CardView { card, tier: ranked::tier(points.max(0) as u32) })
}

#[tauri::command(async)]
pub fn set_global_ranking(state: State<'_, AppState>, enabled: bool) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.set_show_in_global(&s, enabled).map_err(err)
}
