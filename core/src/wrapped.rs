//! "Your month on freetime" (and your year): the figures for a shareable recap card. Computed
//! from the history and quiz log on this PC; the card is drawn and saved locally, never uploaded.

use crate::book;
use crate::history::History;
use crate::model::{Category, Suggestion};
use crate::quiz::QuizLog;
use chrono::{Local, NaiveDate, TimeZone};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct KindCount {
    pub category: Category,
    pub label: &'static str,
    pub picks: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TopIdea {
    pub id: String,
    pub title: String,
    pub category: Category,
    pub times: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct PeriodRecap {
    /// First day, and the day after the last one ("2026-11-01", "2026-12-01").
    pub from: String,
    pub until: String,
    pub picks: u32,
    pub minutes: u32,
    pub loved: u32,
    /// Built-in ideas done for the first time in the period.
    pub new_ideas: u32,
    /// Picks of outdoor ideas.
    pub outdoor: u32,
    pub quizzes: u32,
    pub quiz_right: u32,
    pub days_active: u32,
    pub kinds: Vec<KindCount>,
    pub top: Option<TopIdea>,
}

fn local_day(ts: i64) -> Option<NaiveDate> {
    Local.timestamp_opt(ts, 0).single().map(|d| d.date_naive())
}

/// Figures for the days `from` (included) to `until` (excluded).
pub fn period(history: &History, catalog: &[Suggestion], quizzes: &QuizLog, from: NaiveDate, until: NaiveDate) -> PeriodRecap {
    let by_id: HashMap<&str, &Suggestion> = catalog.iter().map(|s| (s.id.as_str(), s)).collect();
    let in_period = |ts: i64| local_day(ts).is_some_and(|d| d >= from && d < until);
    let done: Vec<_> = history.entries.iter().filter(|e| book::done(e)).collect();
    let before: HashSet<&str> = done.iter().filter(|e| local_day(e.ts).is_some_and(|d| d < from)).map(|e| e.id.as_str()).collect();
    let picks: Vec<_> = done.iter().filter(|e| in_period(e.ts)).collect();

    let mut kinds: HashMap<Category, u32> = HashMap::new();
    let mut times: HashMap<&str, (u32, i64)> = HashMap::new();
    let mut days = HashSet::new();
    let mut new_ideas = HashSet::new();
    let mut r = PeriodRecap { from: from.to_string(), until: until.to_string(), ..Default::default() };
    for e in &picks {
        r.picks += 1;
        r.minutes += e.minutes.unwrap_or(30);
        r.loved += u32::from(e.rating == Some(1));
        *kinds.entry(e.category).or_default() += 1;
        if let Some(d) = local_day(e.ts) {
            days.insert(d);
        }
        if e.id.starts_with("idea:") && !before.contains(e.id.as_str()) {
            new_ideas.insert(e.id.as_str());
        }
        if by_id.get(e.id.as_str()).is_some_and(|s| s.outdoor) {
            r.outdoor += 1;
        }
        if !e.id.starts_with("quiz:") && !e.id.starts_with("puzzle:") {
            let t = times.entry(e.id.as_str()).or_default();
            t.0 += 1;
            t.1 = t.1.max(e.ts);
        }
    }
    r.new_ideas = new_ideas.len() as u32;
    r.days_active = days.len() as u32;
    for (day, score) in &quizzes.days {
        if NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok_and(|d| d >= from && d < until) {
            r.quizzes += 1;
            r.quiz_right += u32::from(score.score);
        }
    }
    let mut kinds: Vec<KindCount> = kinds.into_iter().map(|(category, picks)| KindCount { category, label: category.label(), picks }).collect();
    kinds.sort_by(|a, b| b.picks.cmp(&a.picks).then(a.category.id().cmp(b.category.id())));
    r.kinds = kinds;
    // The idea done most often (the latest one wins a tie).
    r.top = times
        .into_iter()
        .max_by_key(|(_, (n, last))| (*n, *last))
        .and_then(|(id, (n, _))| picks.iter().find(|e| e.id == id).map(|e| TopIdea { id: e.id.clone(), title: e.title.clone(), category: e.category, times: n }));
    r
}

/// A PNG from the app (base64url, no padding): checked to really be a PNG, at most 15 MB.
pub fn png_bytes(b64url: &str) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(b64url.len() <= 20_000_000, "the image is too large");
    let bytes = crate::party::b64_decode(b64url.trim())?;
    anyhow::ensure!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "not a PNG image");
    Ok(bytes)
}

/// Saves a card to the Downloads folder as freetime-<name>-<time>.png; `name` keeps only
/// lowercase letters, digits and dashes. Returns where it went.
pub fn save_png(name: &str, b64url: &str, now: chrono::DateTime<Local>) -> anyhow::Result<std::path::PathBuf> {
    let bytes = png_bytes(b64url)?;
    let clean: String = name.to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    let dir = dirs::download_dir().unwrap_or_else(crate::config::data_dir);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("freetime-{}-{}.png", if clean.is_empty() { "card" } else { &clean }, now.format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// The current month, or the current year.
pub fn bounds(today: NaiveDate, year: bool) -> (NaiveDate, NaiveDate) {
    use chrono::Datelike;
    if year {
        (NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap(), NaiveDate::from_ymd_opt(today.year() + 1, 1, 1).unwrap())
    } else {
        let start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap();
        let next = if today.month() == 12 { NaiveDate::from_ymd_opt(today.year() + 1, 1, 1) } else { NaiveDate::from_ymd_opt(today.year(), today.month() + 1, 1) };
        (start, next.unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{catalog, history::Entry, quiz::Score};

    fn at(m: u32, d: u32) -> i64 {
        Local.with_ymd_and_hms(2026, m, d, 18, 0, 0).single().unwrap().timestamp()
    }

    fn e(id: &str, cat: Category, ts: i64, rating: Option<i8>) -> Entry {
        Entry { id: id.into(), category: cat, title: id.into(), tags: vec![], ts, rating, minutes: Some(40) }
    }

    #[test]
    fn a_month_in_figures() {
        let h = History { dismissals: Vec::new(),
            entries: vec![
                e("idea:run-5k", Category::Sport, at(10, 20), Some(1)), // October: before
                e("idea:run-5k", Category::Sport, at(11, 2), Some(1)),
                e("idea:run-5k", Category::Sport, at(11, 9), None),
                e("idea:aglio-olio", Category::Food, at(11, 9), Some(1)),
                e("idea:hike", Category::Sport, at(11, 15), Some(0)), // didn't do it
                e("steam:620", Category::Game, at(11, 16), None),
                e("idea:swim", Category::Sport, at(12, 1), Some(1)), // December: after
            ],
            ..Default::default()
        };
        let mut quizzes = QuizLog::default();
        quizzes.days.insert("2026-11-03".into(), Score { score: 4, total: 5 });
        quizzes.days.insert("2026-10-30".into(), Score { score: 5, total: 5 });
        let (from, until) = bounds(NaiveDate::from_ymd_opt(2026, 11, 19).unwrap(), false);
        let r = period(&h, &catalog::load(), &quizzes, from, until);
        assert_eq!((r.from.as_str(), r.until.as_str()), ("2026-11-01", "2026-12-01"));
        assert_eq!((r.picks, r.minutes, r.loved), (4, 160, 2));
        assert_eq!(r.new_ideas, 1, "only aglio-olio is new; run-5k was done in October");
        assert_eq!(r.days_active, 3);
        assert_eq!((r.quizzes, r.quiz_right), (1, 4));
        assert_eq!(r.kinds[0].category, Category::Sport);
        assert_eq!(r.top.as_ref().map(|t| (t.id.as_str(), t.times)), Some(("idea:run-5k", 2)));
        assert!(r.outdoor >= 2, "the runs are outdoors");
    }

    #[test]
    fn only_real_pngs_are_saved() {
        let png = crate::party::b64_encode(b"\x89PNG\r\n\x1a\nrest of the file");
        assert!(png_bytes(&png).is_ok());
        assert!(png_bytes(&crate::party::b64_encode(b"MZ\x90\x00 an exe")).is_err());
        assert!(png_bytes("not base64 !").is_err());
    }

    #[test]
    fn year_bounds_and_an_empty_period() {
        let (from, until) = bounds(NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(), true);
        assert_eq!((from.to_string(), until.to_string()), ("2026-01-01".into(), "2027-01-01".into()));
        let (m_from, m_until) = bounds(NaiveDate::from_ymd_opt(2026, 12, 5).unwrap(), false);
        assert_eq!(m_until.to_string(), "2027-01-01");
        let r = period(&History::default(), &catalog::load(), &QuizLog::default(), m_from, m_until);
        assert_eq!((r.picks, r.top), (0, None));
    }
}
