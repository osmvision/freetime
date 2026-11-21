//! The ticket book screen: stamps, badges, the weekly challenge and the ticket of the day.
//! Everything comes from the history on this PC (core/src/book.rs); nothing goes online.

use crate::commands::{card, remember, AppState, Card};
use freetime_core::{book, catalog, guess, history::History, model::Category, scoring::Ranked};
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
    quizzes: usize,
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

/// The idea offered when a game ends: the first of `ids` (built-in ideas) that isn't hidden with
/// "Never suggest this", remembered so "Try it" records it like any other pick.
#[tauri::command(async)]
pub fn game_idea(state: State<'_, AppState>, ids: Vec<String>) -> Option<Card> {
    let history = History::load();
    let catalog = catalog::load();
    let s = ids
        .iter()
        .filter(|id| !history.never.iter().any(|n| &n.id == *id))
        .find_map(|id| catalog.iter().find(|s| &s.id == id))?
        .clone();
    let c = card(&Ranked { s, score: 0.0, reasons: vec![] });
    remember(&state, std::iter::once(&c));
    Some(c)
}

/// One photo of today's Guess the activity: the idea (a card, so "Try it" can start it) and the
/// four titles to choose from.
#[derive(Serialize)]
pub struct GuessRound {
    idea: Card,
    choices: Vec<String>,
    answer: usize,
}

/// Today's Guess the activity, from the ideas that have a photo in the UI (`photos`: their ids).
#[tauri::command(async)]
pub fn guess_round(state: State<'_, AppState>, photos: Vec<String>) -> Vec<GuessRound> {
    let today = chrono::Local::now().date_naive();
    let rounds: Vec<GuessRound> = guess::daily(&catalog::load(), &photos, today)
        .into_iter()
        .map(|r| GuessRound { idea: card(&Ranked { s: r.idea, score: 0.0, reasons: vec![] }), choices: r.choices, answer: r.answer })
        .collect();
    remember(&state, rounds.iter().map(|r| &r.idea));
    rounds
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
        quizzes: b.quizzes,
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
