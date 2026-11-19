//! Sharing (phase D): the month or year recap figures, and saving a card image to Downloads.
//! The cards are drawn in the UI from local data and never uploaded.

use crate::commands::err;
use freetime_core::{catalog, history::History, quiz::QuizLog, wrapped};

type Res<T> = Result<T, String>;

/// This month's (or this year's) figures, from the history on this PC.
#[tauri::command(async)]
pub fn period_recap(year: bool) -> Res<wrapped::PeriodRecap> {
    let today = chrono::Local::now().date_naive();
    let (from, until) = wrapped::bounds(today, year);
    Ok(wrapped::period(&History::load(), &catalog::load(), &QuizLog::load(), from, until))
}

/// Saves a PNG card (base64url, as drawn by the UI) to the Downloads folder. Returns its path.
#[tauri::command(async)]
pub fn save_card(name: String, png: String) -> Res<String> {
    wrapped::save_png(&name, &png, chrono::Local::now())
        .map(|p| p.display().to_string())
        .map_err(err)
}
