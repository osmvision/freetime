//! The ticket book screen: stamps, badges, the weekly challenge and the ticket of the day.
//! Everything comes from the history on this PC (core/src/book.rs); nothing goes online.

use crate::commands::{card, remember, AppState, Card};
use freetime_core::{book, catalog, history::History, model::Category, scoring::Ranked};
use serde::Serialize;
use tauri::State;

type Res<T> = Result<T, String>;

#[derive(Serialize)]
pub struct ShelfView {
    category: Category,
    label: &'static str,
    stamped: usize,
    total: usize,
    tickets: Vec<book::Stamp>,
}

#[derive(Serialize)]
pub struct BookView {
    stamped: usize,
    total: usize,
    games: usize,
    videos: usize,
    shelves: Vec<ShelfView>,
    badges: Vec<book::Badge>,
    challenge: book::Challenge,
    daily: Option<Card>,
    daily_done: bool,
}

/// The ticket of the day as a card, remembered so "Start" can record it like any other pick.
fn daily_card(state: &AppState, catalog: &[freetime_core::model::Suggestion], day: chrono::NaiveDate) -> Option<Card> {
    let s = book::daily(catalog, day)?.clone();
    let c = card(&Ranked { s, score: 0.0, reasons: vec!["Today's ticket: the same for everyone".into()] });
    remember(state, std::iter::once(&c));
    Some(c)
}

#[tauri::command(async)]
pub fn get_book(state: State<'_, AppState>) -> Res<BookView> {
    let now = chrono::Local::now();
    let catalog = catalog::load();
    let history = History::load();
    let b = book::book(&history, &catalog, now);
    Ok(BookView {
        stamped: b.stamped,
        total: b.total,
        games: b.games,
        videos: b.videos,
        shelves: b
            .shelves
            .into_iter()
            .map(|s| ShelfView { category: s.category, label: s.category.label(), stamped: s.stamped, total: s.total, tickets: s.tickets })
            .collect(),
        badges: b.badges,
        challenge: b.challenge,
        daily: daily_card(&state, &catalog, now.date_naive()),
        daily_done: book::daily_done(&history, &catalog, now.date_naive()),
    })
}

/// Just today's ticket and the weekly challenge, for the strip on Discover.
#[derive(Serialize)]
pub struct TodayView {
    daily: Option<Card>,
    daily_done: bool,
    challenge: book::Challenge,
    stamped: usize,
    total: usize,
}

#[tauri::command(async)]
pub fn get_today(state: State<'_, AppState>) -> Res<TodayView> {
    let now = chrono::Local::now();
    let catalog = catalog::load();
    let history = History::load();
    let b = book::book(&history, &catalog, now);
    Ok(TodayView {
        daily: daily_card(&state, &catalog, now.date_naive()),
        daily_done: book::daily_done(&history, &catalog, now.date_naive()),
        challenge: b.challenge,
        stamped: b.stamped,
        total: b.total,
    })
}
