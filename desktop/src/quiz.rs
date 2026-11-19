//! The daily quiz screen (core/src/quiz.rs). Offline: questions ship with the app, results stay
//! on this PC.

use freetime_core::{history::History, quiz};
use serde::Serialize;

type Res<T> = Result<T, String>;

#[derive(Serialize)]
pub struct QuizView {
    /// "2026-11-19"
    date: String,
    questions: Vec<quiz::Question>,
    /// Today's score once finished.
    result: Option<quiz::Score>,
    streak: u32,
}

#[tauri::command(async)]
pub fn get_quiz() -> Res<QuizView> {
    let today = chrono::Local::now().date_naive();
    let log = quiz::QuizLog::load();
    Ok(QuizView {
        date: today.to_string(),
        questions: quiz::daily(&quiz::load(), today),
        result: log.get(today),
        streak: log.streak(today),
    })
}

#[derive(Serialize)]
pub struct QuizDone {
    score: u8,
    total: u8,
    streak: u32,
}

/// Saves today's answers (indexes into each question's choices) and returns the score.
#[tauri::command(async)]
pub fn finish_quiz(answers: Vec<usize>) -> Res<QuizDone> {
    let today = chrono::Local::now().date_naive();
    let mut log = quiz::QuizLog::load();
    let mut history = History::load();
    let already = log.get(today).is_some();
    let s = quiz::finish(&quiz::load(), today, &answers, &mut log, &mut history).map_err(|e| e.to_string())?;
    if !already {
        log.save().map_err(|e| e.to_string())?;
        history.save().map_err(|e| e.to_string())?;
    }
    Ok(QuizDone { score: s.score, total: s.total, streak: log.streak(today) })
}

/// The bonus quiz: 5 questions from Open Trivia DB (English, CC BY-SA 4.0). Network, but only
/// when the user asks for it. Not recorded anywhere: it's just for fun.
#[tauri::command(async)]
pub fn bonus_quiz() -> Res<Vec<quiz::Trivia>> {
    let net = freetime_core::net::HttpNet::shared().map_err(|e| e.to_string())?;
    quiz::fetch_trivia(net.as_ref(), &mut rand::thread_rng()).map_err(|e| e.to_string())
}
