//! The puzzles of the day: a Path and a Zones grid, the same for everyone. The puzzles ship with
//! the UI (desktop/ui/js/puzzles/days.js, made ahead of time by desktop/scripts/make-puzzles.mjs,
//! each with one solution) and are checked there. This side keeps what was solved and how fast,
//! in the quiz log, and records each solve in the history: a "Learn" pick, like the quiz, never
//! asked "how was it?", worth Ranked points.

use crate::history::{now, Entry, History};
use crate::model::Category;
use crate::quiz::QuizLog;
use anyhow::{bail, Result};
use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const KINDS: [&str; 2] = ["path", "zones"];

/// Ranked points for each puzzle solved on the day (still inside the daily cap).
pub const POINTS: u32 = 2;

/// A solved puzzle: how long it took, in seconds.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Solve {
    pub secs: u32,
}

fn title(kind: &str) -> &'static str {
    if kind == "path" {
        "Path of the day"
    } else {
        "Zones of the day"
    }
}

/// The history entry for a solved puzzle.
pub fn entry_id(kind: &str, day: NaiveDate) -> String {
    format!("puzzle:{kind}:{day}")
}

/// The puzzles solved on `day`, by kind.
pub fn solved(log: &QuizLog, day: NaiveDate) -> BTreeMap<String, Solve> {
    log.puzzles.get(&day.to_string()).cloned().unwrap_or_default()
}

/// Days in a row with a puzzle solved, ending today (or yesterday, while today's are still open).
/// Shown to the player only; missing a day just starts it again.
pub fn streak(log: &QuizLog, today: NaiveDate) -> u32 {
    let any = |d: NaiveDate| log.puzzles.get(&d.to_string()).is_some_and(|m| !m.is_empty());
    let mut d = if any(today) { today } else { today - Duration::days(1) };
    let mut n = 0;
    while any(d) {
        n += 1;
        d -= Duration::days(1);
    }
    n
}

/// Ranked points the puzzles earned on `day`.
pub fn day_points(log: &QuizLog, day: NaiveDate) -> u32 {
    POINTS * solved(log, day).len() as u32
}

/// Records today's `kind` puzzle as solved in `secs` seconds. Counts once a day: solving it again
/// returns the first time.
pub fn finish(kind: &str, day: NaiveDate, secs: u32, log: &mut QuizLog, history: &mut History) -> Result<Solve> {
    if !KINDS.contains(&kind) {
        bail!("unknown puzzle: {kind}");
    }
    let today = log.puzzles.entry(day.to_string()).or_default();
    if let Some(done) = today.get(kind) {
        return Ok(*done);
    }
    let solve = Solve { secs: secs.min(24 * 3600) };
    today.insert(kind.to_string(), solve);
    history.entries.push(Entry {
        id: entry_id(kind, day),
        category: Category::Learn,
        title: title(kind).to_string(),
        tags: vec!["puzzle".to_string()],
        ts: now(),
        rating: None,
        minutes: Some((solve.secs / 60).max(1)),
    });
    Ok(solve)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, d).unwrap()
    }

    #[test]
    fn a_puzzle_counts_once_a_day_with_its_first_time() {
        let mut log = QuizLog::default();
        let mut h = History::default();
        assert_eq!(finish("path", day(20), 95, &mut log, &mut h).unwrap(), Solve { secs: 95 });
        assert_eq!(finish("path", day(20), 30, &mut log, &mut h).unwrap(), Solve { secs: 95 });
        assert_eq!(h.entries.len(), 1);
        assert_eq!(h.entries[0].id, "puzzle:path:2026-11-20");
        assert_eq!(h.entries[0].category, Category::Learn);
        assert_eq!(day_points(&log, day(20)), 2);
        finish("zones", day(20), 200, &mut log, &mut h).unwrap();
        assert_eq!(day_points(&log, day(20)), 4);
        assert_eq!(day_points(&log, day(19)), 0);
        assert!(finish("sudoku", day(20), 10, &mut log, &mut h).is_err());
    }

    #[test]
    fn the_streak_counts_days_with_a_puzzle() {
        let mut log = QuizLog::default();
        let mut h = History::default();
        for d in [17, 18, 19] {
            finish("zones", day(d), 60, &mut log, &mut h).unwrap();
        }
        assert_eq!(streak(&log, day(19)), 3);
        assert_eq!(streak(&log, day(20)), 3, "today still open");
        assert_eq!(streak(&log, day(21)), 0, "a day missed");
    }

    #[test]
    fn older_quiz_files_still_load() {
        let log: QuizLog = serde_json::from_str(r#"{"days":{"2026-11-19":{"score":4,"total":5}}}"#).unwrap();
        assert!(log.puzzles.is_empty());
        assert_eq!(serde_json::to_string(&log).unwrap(), r#"{"days":{"2026-11-19":{"score":4,"total":5}}}"#);
    }
}
