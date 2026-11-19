//! The ticket book: what you've done, as a collection of stamped tickets, plus badges, the ticket
//! of the day and the weekly challenge. Everything is computed from the history on this PC:
//! nothing here touches the network.

use crate::history::{Entry, History};
use crate::model::{Category, Suggestion};
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// A pick counts as done unless it was marked "didn't do it" (rating 0).
pub fn done(e: &Entry) -> bool {
    e.rating != Some(0)
}

#[derive(Debug, Clone, Serialize)]
pub struct Book {
    pub stamped: usize,
    pub total: usize,
    pub shelves: Vec<Shelf>,
    pub badges: Vec<Badge>,
    pub challenge: Challenge,
    /// Done picks that aren't built-in ideas (games, videos): they count, but aren't collected.
    pub games: usize,
    pub videos: usize,
}

/// One category of built-in ideas.
#[derive(Debug, Clone, Serialize)]
pub struct Shelf {
    pub category: Category,
    pub stamped: usize,
    pub total: usize,
    pub tickets: Vec<Stamp>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stamp {
    pub id: String,
    pub title: String,
    /// When it was first done (unix seconds), or None while it's still to collect.
    pub first: Option<i64>,
    pub times: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Badge {
    pub id: &'static str,
    pub icon: &'static str,
    pub title: &'static str,
    pub how: &'static str,
    pub progress: u32,
    pub target: u32,
    pub earned: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Challenge {
    pub id: &'static str,
    pub title: &'static str,
    pub progress: u32,
    pub target: u32,
    pub done: bool,
    /// ISO week, like "2026-W47".
    pub week: String,
    /// Days left, today included.
    pub days_left: u32,
}

// ---------------------------------------------------------------- ticket of the day

/// FNV-1a: tiny, stable across versions and platforms (std's hasher isn't).
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The same built-in idea for everyone on a given day: chosen from the date alone, so every copy
/// of freetime agrees without asking a server.
pub fn daily<'a>(catalog: &'a [Suggestion], day: NaiveDate) -> Option<&'a Suggestion> {
    let mut ideas: Vec<&Suggestion> = catalog.iter().filter(|s| s.id.starts_with("idea:")).collect();
    if ideas.is_empty() {
        return None;
    }
    ideas.sort_by(|a, b| a.id.cmp(&b.id));
    let i = (fnv1a(&format!("freetime-daily-{day}")) % ideas.len() as u64) as usize;
    Some(ideas[i])
}

fn local_day(ts: i64) -> Option<NaiveDate> {
    Local.timestamp_opt(ts, 0).single().map(|d| d.date_naive())
}

/// Whether this pick was the ticket of the day it was picked on.
fn was_daily(e: &Entry, catalog: &[Suggestion]) -> bool {
    local_day(e.ts).and_then(|d| daily(catalog, d)).is_some_and(|s| s.id == e.id)
}

/// Whether the ticket of `day` was done that day.
pub fn daily_done(history: &History, catalog: &[Suggestion], day: NaiveDate) -> bool {
    let Some(s) = daily(catalog, day) else { return false };
    history.entries.iter().any(|e| e.id == s.id && done(e) && local_day(e.ts) == Some(day))
}

// ---------------------------------------------------------------- weekly challenge

#[derive(Clone, Copy)]
enum Goal {
    Outdoor,
    NewIdeas,
    Kinds,
    Minutes,
    Category(Category),
    Daily,
}

const CHALLENGES: [(&str, &str, Goal, u32); 10] = [
    ("outdoor-3", "Do 3 things outdoors", Goal::Outdoor, 3),
    ("new-2", "Try 2 ideas you've never done", Goal::NewIdeas, 2),
    ("kinds-3", "Pick from 3 different kinds", Goal::Kinds, 3),
    ("minutes-180", "Spend 3 hours on your picks", Goal::Minutes, 180),
    ("food-2", "Cook twice", Goal::Category(Category::Food), 2),
    ("sport-2", "Move twice", Goal::Category(Category::Sport), 2),
    ("learn-1", "Learn something new", Goal::Category(Category::Learn), 1),
    ("create-1", "Make something", Goal::Category(Category::Create), 1),
    ("social-1", "Do something with friends", Goal::Category(Category::Social), 1),
    ("daily-3", "Do 3 tickets of the day", Goal::Daily, 3),
];

fn week_key(d: NaiveDate) -> (i32, u32) {
    (d.iso_week().year(), d.iso_week().week())
}

/// This week's challenge (the same for everyone: chosen from the ISO week) and your progress.
pub fn challenge(history: &History, catalog: &[Suggestion], now: DateTime<Local>) -> Challenge {
    let today = now.date_naive();
    let (year, week) = week_key(today);
    let (id, title, goal, target) = CHALLENGES[(fnv1a(&format!("freetime-week-{year}-{week}")) % CHALLENGES.len() as u64) as usize];
    let by_id: HashMap<&str, &Suggestion> = catalog.iter().map(|s| (s.id.as_str(), s)).collect();
    let in_week = |e: &&Entry| local_day(e.ts).is_some_and(|d| week_key(d) == (year, week));
    let this_week: Vec<&Entry> = history.entries.iter().filter(|e| done(e)).filter(in_week).collect();

    let progress = match goal {
        Goal::Outdoor => this_week.iter().filter(|e| by_id.get(e.id.as_str()).is_some_and(|s| s.outdoor)).count() as u32,
        Goal::NewIdeas => {
            let before: HashSet<&str> = history
                .entries
                .iter()
                .filter(|e| done(e) && local_day(e.ts).is_some_and(|d| week_key(d) < (year, week)))
                .map(|e| e.id.as_str())
                .collect();
            this_week.iter().map(|e| e.id.as_str()).filter(|id| !before.contains(id)).collect::<HashSet<_>>().len() as u32
        }
        Goal::Kinds => this_week.iter().map(|e| e.category).collect::<HashSet<_>>().len() as u32,
        Goal::Minutes => this_week.iter().map(|e| e.minutes.unwrap_or(30)).sum(),
        Goal::Category(c) => this_week.iter().filter(|e| e.category == c).count() as u32,
        Goal::Daily => this_week.iter().filter(|e| was_daily(e, catalog)).count() as u32,
    };
    Challenge {
        id,
        title,
        progress: progress.min(target),
        target,
        done: progress >= target,
        week: format!("{year}-W{week:02}"),
        days_left: 7 - today.weekday().num_days_from_monday(),
    }
}

// ---------------------------------------------------------------- the book and badges

pub fn book(history: &History, catalog: &[Suggestion], now: DateTime<Local>) -> Book {
    let did: Vec<&Entry> = history.entries.iter().filter(|e| done(e)).collect();

    // First time and number of times each id was done.
    let mut seen: HashMap<&str, (i64, u32)> = HashMap::new();
    for e in &did {
        let s = seen.entry(e.id.as_str()).or_insert((e.ts, 0));
        s.0 = s.0.min(e.ts);
        s.1 += 1;
    }

    let mut shelves: Vec<Shelf> = Category::ALL
        .iter()
        .filter_map(|&c| {
            let mut tickets: Vec<Stamp> = catalog
                .iter()
                .filter(|s| s.category == c && s.id.starts_with("idea:"))
                .map(|s| {
                    let hit = seen.get(s.id.as_str());
                    Stamp { id: s.id.clone(), title: s.title.clone(), first: hit.map(|h| h.0), times: hit.map_or(0, |h| h.1) }
                })
                .collect();
            if tickets.is_empty() {
                return None;
            }
            // Collected first (oldest first), then the rest in catalog order.
            tickets.sort_by_key(|t| (t.first.is_none(), t.first.unwrap_or(0)));
            let stamped = tickets.iter().filter(|t| t.first.is_some()).count();
            Some(Shelf { category: c, stamped, total: tickets.len(), tickets })
        })
        .collect();
    shelves.sort_by(|a, b| b.stamped.cmp(&a.stamped).then(a.category.id().cmp(b.category.id())));

    let stamped = shelves.iter().map(|s| s.stamped).sum();
    let total = shelves.iter().map(|s| s.total).sum();
    let count = |c: Category| did.iter().filter(|e| e.category == c).count() as u32;
    let by_id: HashMap<&str, &Suggestion> = catalog.iter().map(|s| (s.id.as_str(), s)).collect();
    let outdoor = did.iter().filter(|e| by_id.get(e.id.as_str()).is_some_and(|s| s.outdoor)).count() as u32;
    let night = did.iter().filter(|e| e.tags.iter().any(|t| t == "night")).count() as u32;
    let kinds = did.iter().map(|e| e.category).collect::<HashSet<_>>().len() as u32;
    let full_sets = shelves.iter().filter(|s| s.stamped == s.total).count() as u32;
    let dailies = did.iter().filter(|e| was_daily(e, catalog)).count() as u32;
    let best_streak = history.recap(now).best_streak;

    let b = |id, icon, title, how, progress: u32, target: u32| Badge { id, icon, title, how, progress: progress.min(target), target, earned: progress >= target };
    let mut badges = vec![
        b("first", "ticket", "First ticket", "Do your first pick", did.len() as u32, 1),
        b("explorer", "compass", "Explorer", "Do picks from 5 different kinds", kinds, 5),
        b("collector", "stamp", "Collector", "Stamp 25 tickets in your book", stamped as u32, 25),
        b("full-set", "award", "Full set", "Complete one kind in your book", full_sets, 1),
        b("outdoors", "tree-pine", "Fresh air", "Do 10 outdoor ideas", outdoor, 10),
        b("athlete", "activity", "Athlete", "Do 10 sport picks", count(Category::Sport), 10),
        b("chef", "utensils", "Chef", "Cook 5 times", count(Category::Food), 5),
        b("curious", "graduation-cap", "Curious mind", "Do 5 learning picks", count(Category::Learn), 5),
        b("maker", "palette", "Maker", "Make something 5 times", count(Category::Create), 5),
        b("social", "users", "Good company", "Do 5 things with friends", count(Category::Social), 5),
        b("gamer", "gamepad-2", "Player", "Play 10 game picks", count(Category::Game), 10),
        b("night-owl", "moon", "Night owl", "Do a night idea, like stargazing", night, 1),
        b("daily", "calendar-check", "Daily habit", "Do 7 tickets of the day", dailies, 7),
        b("regular", "flame", "Regular", "Keep a 4-week streak", best_streak, 4),
    ];
    // Earned first, then the closest to being earned.
    badges.sort_by(|a, b| b.earned.cmp(&a.earned).then((b.progress * 100 / b.target).cmp(&(a.progress * 100 / a.target))));

    Book {
        stamped,
        total,
        shelves,
        badges,
        challenge: challenge(history, catalog, now),
        games: count(Category::Game) as usize,
        videos: count(Category::Video) as usize,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;

    fn entry(id: &str, cat: Category, ts: i64, rating: Option<i8>) -> Entry {
        Entry { id: id.into(), category: cat, title: id.into(), tags: vec![], ts, rating, minutes: Some(30) }
    }

    fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, 0, 0).single().unwrap()
    }

    #[test]
    fn daily_is_stable_and_changes_by_day() {
        let cat = catalog::load();
        let d1 = NaiveDate::from_ymd_opt(2026, 11, 19).unwrap();
        let a = daily(&cat, d1).unwrap().id.clone();
        assert_eq!(a, daily(&cat, d1).unwrap().id, "same day, same ticket");
        let week: HashSet<String> = (0..7).map(|i| daily(&cat, d1 + chrono::Duration::days(i)).unwrap().id.clone()).collect();
        assert!(week.len() >= 4, "a week of dailies should mostly differ: {week:?}");
        assert!(a.starts_with("idea:"));
    }

    #[test]
    fn stamps_count_done_picks_only() {
        let cat = catalog::load();
        let now = at(2026, 11, 19, 20);
        let t = now.timestamp();
        let h = History {
            entries: vec![
                entry("idea:run-5k", Category::Sport, t - 3600, Some(1)),
                entry("idea:run-5k", Category::Sport, t - 7200, None),
                entry("idea:aglio-olio", Category::Food, t - 100, Some(0)), // didn't do it
                entry("idea:hike", Category::Sport, t - 50, Some(-1)),      // did it, didn't like it
                entry("steam:620", Category::Game, t - 10, None),
            ],
        };
        let b = book(&h, &cat, now);
        assert_eq!(b.stamped, 2, "run-5k and hike");
        let sport = b.shelves.iter().find(|s| s.category == Category::Sport).unwrap();
        assert_eq!(sport.stamped, 2);
        let run = sport.tickets.iter().find(|t| t.id == "idea:run-5k").unwrap();
        assert_eq!((run.times, run.first), (2, Some(t - 7200)));
        assert!(b.shelves.iter().find(|s| s.category == Category::Food).unwrap().tickets.iter().all(|t| t.first.is_none()));
        assert_eq!(b.games, 1);
        assert!(b.badges.iter().any(|x| x.id == "first" && x.earned));
        assert!(b.badges.iter().any(|x| x.id == "explorer" && !x.earned && x.progress == 2));
        assert_eq!(b.total, cat.iter().filter(|s| s.category != Category::Video).count());
    }

    #[test]
    fn weekly_challenge_counts_this_week_only() {
        let cat = catalog::load();
        // Wednesday 18 November 2026: Monday is the 16th.
        let now = at(2026, 11, 18, 12);
        let mon = at(2026, 11, 16, 10).timestamp();
        let last_week = at(2026, 11, 12, 10).timestamp();
        let daily_today = daily(&cat, now.date_naive()).unwrap().clone();
        let h = History {
            entries: vec![
                entry("idea:run-5k", Category::Sport, last_week, Some(1)),
                entry("idea:run-5k", Category::Sport, mon, Some(1)),
                entry("idea:hike", Category::Sport, mon + 60, Some(1)),
                entry("idea:aglio-olio", Category::Food, mon + 120, Some(1)),
                entry(&daily_today.id, daily_today.category, now.timestamp() - 60, None),
            ],
        };
        let c = challenge(&h, &cat, now);
        assert_eq!(c.week, "2026-W47");
        assert_eq!(c.days_left, 5);
        assert!(c.progress <= c.target);
        // Every kind of goal can be checked by hand against this history:
        let all_this_week: Vec<&Entry> = h.entries.iter().skip(1).collect();
        match c.id {
            "kinds-3" => assert_eq!(c.progress, all_this_week.iter().map(|e| e.category).collect::<HashSet<_>>().len().min(3) as u32),
            "sport-2" => assert_eq!(c.progress, 2),
            "food-2" => assert_eq!(c.progress, 1),
            "daily-3" => assert_eq!(c.progress, 1),
            "minutes-180" => assert_eq!(c.progress, 120),
            _ => {}
        }
        assert!(daily_done(&h, &cat, now.date_naive()));
    }

    #[test]
    fn every_challenge_and_badge_has_text() {
        for (id, title, _, target) in CHALLENGES {
            assert!(!id.is_empty() && !title.is_empty() && target > 0);
        }
        let b = book(&History { entries: vec![] }, &catalog::load(), at(2026, 1, 5, 9));
        assert!(b.badges.iter().all(|x| !x.earned && x.target > 0 && !x.how.is_empty()));
        assert_eq!(b.stamped, 0);
    }
}
