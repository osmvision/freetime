//! Meet (people who chose to be visible), quiz duels and turn-based games with friends. Everything is checked on the
//! server (supabase/migrations/*_meet_and_quiz_duels.sql); this side shows the duel's questions
//! from the bank shipped with the app (core/src/duel.rs).

use crate::commands::{err, live_session, AppState};
use freetime_core::{
    account::{Client, Duel, DuelResult, MeetRow},
    duel, quiz,
};
use serde::Serialize;
use tauri::State;

type Res<T> = Result<T, String>;

#[derive(Serialize)]
pub struct MeetView {
    /// Whether you can be found (the same switch as the global ranking).
    visible: bool,
    people: Vec<MeetRow>,
}

#[tauri::command(async)]
pub fn meet_people(state: State<'_, AppState>) -> Res<MeetView> {
    let s = live_session(&state)?;
    let client = Client::new().map_err(err)?;
    let visible = client.my_ranking(&s).map_err(err)?.show_in_global;
    Ok(MeetView { visible, people: client.meet_people(&s).map_err(err)? })
}

#[tauri::command(async)]
pub fn request_friend(state: State<'_, AppState>, user_id: String) -> Res<String> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.request_friend(&s, &user_id).map_err(err)
}

#[tauri::command(async)]
pub fn my_duels(state: State<'_, AppState>) -> Res<Vec<Duel>> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.my_duels(&s).map_err(err)
}

#[tauri::command(async)]
pub fn create_duel(state: State<'_, AppState>, friend: String) -> Res<String> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.create_duel(&s, &friend).map_err(err)
}

/// The duel's questions, ready to show (choices shuffled for this duel).
#[tauri::command(async)]
pub fn duel_questions(id: String, questions: Vec<String>) -> Res<Vec<quiz::Question>> {
    duel::questions(&quiz::load(), &id, &questions).map_err(err)
}

/// Plays your side. `answers` are the choices picked on screen; the result's `key` comes back in
/// the same on-screen order.
#[tauri::command(async)]
pub fn play_duel(state: State<'_, AppState>, id: String, questions: Vec<String>, answers: Vec<usize>) -> Res<DuelResult> {
    let s = live_session(&state)?;
    let bank = quiz::load();
    let sent = duel::bank_answers(&bank, &id, &questions, &answers).map_err(err)?;
    let mut r = Client::new().map_err(err)?.play_duel(&s, &id, &sent).map_err(err)?;
    r.key = duel::questions(&bank, &id, &questions).map_err(err)?.iter().map(|q| q.answer).collect();
    Ok(r)
}

#[tauri::command(async)]
pub fn drop_duel(state: State<'_, AppState>, id: String) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.drop_duel(&s, &id).map_err(err)
}

// ---------------------------------------------------------------- turn-based games

/// Starts a game or plays a move (checked on the server by the games Edge Function).
#[tauri::command(async)]
pub fn game_action(state: State<'_, AppState>, request: serde_json::Value) -> Res<serde_json::Value> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.game_action(&s, &request).map_err(err)
}

#[tauri::command(async)]
pub fn my_matches(state: State<'_, AppState>) -> Res<serde_json::Value> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.my_matches(&s).map_err(err)
}

#[tauri::command(async)]
pub fn leave_match(state: State<'_, AppState>, id: String) -> Res<String> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.leave_match(&s, &id).map_err(err)
}

#[tauri::command(async)]
pub fn hide_match(state: State<'_, AppState>, id: String) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.hide_match(&s, &id).map_err(err)
}

#[tauri::command(async)]
pub fn hide_finished_matches(state: State<'_, AppState>) -> Res<u32> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.hide_finished_matches(&s).map_err(err)
}
