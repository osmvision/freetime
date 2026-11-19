//! Ranked screen: this season's points, tier and boards (friends, global), and player cards.
//! Points are computed on this PC (core/src/ranked.rs) and sent only while signed in.

use crate::commands::{err, live_session, AppState};
use freetime_core::{account::{Client, Session}, history::History, quiz::QuizLog, ranked};
use tauri::State;

type Res<T> = Result<T, String>;

/// Sends today's and yesterday's points (yesterday catches what was finished late), returns
/// today's breakdown. The server keeps the best value of each day, so sending twice is fine.
fn sync(client: &Client, session: &Session, now: chrono::DateTime<chrono::Local>) -> Res<ranked::DayPoints> {
    ranked::sync_points(client, session, &History::load(), &QuizLog::load(), now).map_err(err)
}

/// After a pick, a rating or a quiz: send the new points. Quiet when signed out or offline.
#[tauri::command(async)]
pub fn sync_points(state: State<'_, AppState>) -> Res<()> {
    let Ok(s) = live_session(&state) else { return Ok(()) };
    let client = Client::new().map_err(err)?;
    sync(&client, &s, chrono::Local::now()).map(|_| ())
}

#[tauri::command(async)]
pub fn ranked_overview(state: State<'_, AppState>, scope: String) -> Res<ranked::RankedView> {
    let s = live_session(&state)?;
    let client = Client::new().map_err(err)?;
    let now = chrono::Local::now();
    let today = sync(&client, &s, now)?;
    ranked::overview(&client, &s, scope, today, now.date_naive()).map_err(err)
}

#[tauri::command(async)]
pub fn player_card(state: State<'_, AppState>, user_id: String) -> Res<ranked::CardView> {
    let s = live_session(&state)?;
    let client = Client::new().map_err(err)?;
    ranked::card(&client, &s, &user_id).map_err(err)
}

#[tauri::command(async)]
pub fn set_global_ranking(state: State<'_, AppState>, enabled: bool) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.set_show_in_global(&s, enabled).map_err(err)
}
