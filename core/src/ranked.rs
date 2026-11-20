//! Ranked: the points a day earns, from what happened that day on this PC. The server
//! (supabase/migrations/*_ranked.sql) sums them into monthly seasons and caps each day at 20.
//!
//! | what                                   | points          |
//! | -------------------------------------- | --------------- |
//! | daily quiz                             | 1 per right answer |
//! | ticket of the day done                 | 3               |
//! | a built-in idea done for the first time | 2 each          |
//! | weekly challenge completed that day    | 10              |
//! | badge earned that day                  | 5 each          |

use crate::{account::{BoardRow, Client, Session}, book, catalog};
use crate::history::{Entry, History};
use crate::model::Suggestion;
use crate::quiz::QuizLog;
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone};
use serde::Serialize;
use std::collections::HashSet;

pub const DAILY_CAP: u32 = 20;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct DayPoints {
    pub quiz: u32,
    pub daily: u32,
    pub new_ideas: u32,
    pub challenge: u32,
    pub badges: u32,
    /// The sum, capped at 20.
    pub total: u32,
    /// Before the cap, to tell the player when they hit it.
    pub uncapped: u32,
}

fn local_day(ts: i64) -> Option<NaiveDate> {
    Local.timestamp_opt(ts, 0).single().map(|d| d.date_naive())
}

/// The last second of a local day (as "now" for the book's functions).
fn end_of(day: NaiveDate) -> DateTime<Local> {
    let t = day.and_hms_opt(23, 59, 59).expect("valid time");
    Local.from_local_datetime(&t).earliest().unwrap_or_else(Local::now)
}

fn up_to(history: &History, last: Option<NaiveDate>) -> History {
    History {
        entries: history
            .entries
            .iter()
            .filter(|e| match (last, local_day(e.ts)) {
                (Some(l), Some(d)) => d <= l,
                _ => false,
            })
            .cloned()
            .collect::<Vec<Entry>>(),
        ..Default::default()
    }
}

pub fn day_points(history: &History, catalog: &[Suggestion], quizzes: &QuizLog, day: NaiveDate) -> DayPoints {
    let before = day.pred_opt();
    let until_day = up_to(history, Some(day));
    let until_before = up_to(history, before);

    let quiz = quizzes.get(day).map_or(0, |s| u32::from(s.score));
    let daily = if book::daily_done(history, catalog, day) { 3 } else { 0 };

    // Built-in ideas done for the first time that day.
    let seen_before: HashSet<&str> = until_before.entries.iter().filter(|e| book::done(e)).map(|e| e.id.as_str()).collect();
    let new_today: HashSet<&str> = until_day
        .entries
        .iter()
        .filter(|e| book::done(e) && e.id.starts_with("idea:") && local_day(e.ts) == Some(day) && !seen_before.contains(e.id.as_str()))
        .map(|e| e.id.as_str())
        .collect();
    let new_ideas = 2 * new_today.len() as u32;

    // The weekly challenge, if this is the day it got done.
    let now = end_of(day);
    let done_today = book::challenge(&until_day, catalog, now).done;
    let done_before = book::challenge(&until_before, catalog, now).done;
    let challenge = if done_today && !done_before { 10 } else { 0 };

    // Badges earned that day.
    let earned = |h: &History, at: DateTime<Local>| -> HashSet<&'static str> {
        book::book(h, catalog, at).badges.into_iter().filter(|b| b.earned).map(|b| b.id).collect()
    };
    let after = earned(&until_day, now);
    let prior = before.map(|b| earned(&until_before, end_of(b))).unwrap_or_default();
    let badges = 5 * after.difference(&prior).count() as u32;

    let uncapped = quiz + daily + new_ideas + challenge + badges;
    DayPoints { quiz, daily, new_ideas, challenge, badges, total: uncapped.min(DAILY_CAP), uncapped }
}

/// What a player card shows besides points.
#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub stamped: u32,
    pub badges: Vec<&'static str>,
    pub best_streak: u32,
}

pub fn stats(history: &History, catalog: &[Suggestion], now: DateTime<Local>) -> Stats {
    let b = book::book(history, catalog, now);
    Stats {
        stamped: b.stamped as u32,
        badges: b.badges.iter().filter(|x| x.earned).map(|x| x.id).collect(),
        best_streak: history.recap(now).best_streak,
    }
}

/// Retry yesterday's score in case the device was offline, then submit today's score.
pub fn sync_points(
    client: &Client,
    session: &Session,
    history: &History,
    quizzes: &QuizLog,
    now: DateTime<Local>,
) -> anyhow::Result<DayPoints> {
    let catalog = catalog::load();
    let day = now.date_naive();
    let stats = stats(history, &catalog, now);
    if let Some(yesterday) = day.pred_opt() {
        let points = day_points(history, &catalog, quizzes, yesterday);
        if points.total > 0 {
            client.submit_points(session, yesterday, points.total, &stats)?;
        }
    }
    let today = day_points(history, &catalog, quizzes, day);
    client.submit_points(session, day, today.total, &stats)?;
    Ok(today)
}

#[derive(Serialize)]
pub struct RankedView {
    season: String,
    days_left: u32,
    today: DayPoints,
    points: i64,
    tier: Tier,
    show_in_global: bool,
    global_rank: Option<i64>,
    global_players: i64,
    scope: String,
    rows: Vec<BoardRow>,
}

pub fn overview(
    client: &Client,
    session: &Session,
    scope: String,
    today: DayPoints,
    day: NaiveDate,
) -> anyhow::Result<RankedView> {
    let mine = client.my_ranking(session)?;
    let rows = client.leaderboard(session, &scope)?;
    let next_month = day.with_day(1).and_then(|first| first.checked_add_months(chrono::Months::new(1)));
    Ok(RankedView {
        season: day.format("%Y-%m").to_string(),
        days_left: next_month.map_or(0, |next| (next - day).num_days() as u32),
        today,
        points: mine.points,
        tier: tier(mine.points.max(0) as u32),
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
    tier: Tier,
}

pub fn card(client: &Client, session: &Session, user_id: &str) -> anyhow::Result<CardView> {
    let card = client.player_card(session, user_id)?
        .ok_or_else(|| anyhow::anyhow!("This player's card isn't visible to you."))?;
    let points = card.get("points").and_then(serde_json::Value::as_i64).unwrap_or(0);
    Ok(CardView { card, tier: tier(points.max(0) as u32) })
}

// ---------------------------------------------------------------- tiers

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Tier {
    pub id: &'static str,
    pub label: &'static str,
    /// Points where this tier starts, and where the next one starts (None at the top).
    pub from: u32,
    pub next: Option<u32>,
}

/// Season tiers, from the month's points. A month has at most about 600 (20 a day).
const TIERS: [(&str, &str, u32); 5] = [("bronze", "Bronze", 0), ("silver", "Silver", 50), ("gold", "Gold", 120), ("platinum", "Platinum", 220), ("diamond", "Diamond", 350)];

pub fn tier(points: u32) -> Tier {
    let i = TIERS.iter().rposition(|t| points >= t.2).unwrap_or(0);
    Tier { id: TIERS[i].0, label: TIERS[i].1, from: TIERS[i].2, next: TIERS.get(i + 1).map(|t| t.2) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{catalog, model::Category, quiz};

    fn at(y: i32, m: u32, d: u32, h: u32) -> i64 {
        Local.with_ymd_and_hms(y, m, d, h, 0, 0).single().unwrap().timestamp()
    }

    fn e(id: &str, cat: Category, ts: i64) -> Entry {
        Entry { id: id.into(), category: cat, title: id.into(), tags: vec![], ts, rating: Some(1), minutes: Some(30) }
    }

    #[test]
    fn a_day_counts_what_happened_that_day_and_is_capped() {
        let cat = catalog::load();
        let day = NaiveDate::from_ymd_opt(2026, 11, 18).unwrap();
        let daily = book::daily(&cat, day).unwrap().clone();
        let mut h = History {
            entries: vec![
                e("idea:run-5k", Category::Sport, at(2026, 11, 10, 9)), // older: not new on the 18th
                e("idea:run-5k", Category::Sport, at(2026, 11, 18, 9)),
                e("idea:aglio-olio", Category::Food, at(2026, 11, 18, 12)), // new: +2
                e(&daily.id, daily.category, at(2026, 11, 18, 18)), // ticket of the day: +3 (and +2 if new)
            ],
            ..Default::default()
        };
        let mut log = QuizLog::default();
        log.days.insert(day.to_string(), quiz::Score { score: 4, total: 5 });
        let p = day_points(&h, &cat, &log, day);
        assert_eq!(p.quiz, 4);
        assert_eq!(p.daily, 3);
        let daily_is_new = daily.id != "idea:run-5k" && daily.id != "idea:aglio-olio";
        assert_eq!(p.new_ideas, if daily_is_new { 4 } else { 2 });
        assert_eq!(p.total, p.uncapped.min(20));

        // The day before earned nothing from these.
        let before = day_points(&h, &cat, &QuizLog::default(), day.pred_opt().unwrap());
        assert_eq!((before.quiz, before.daily, before.new_ideas), (0, 0, 0));

        // Lots of new ideas in one day: capped at 20.
        for (i, s) in cat.iter().filter(|s| s.id.starts_with("idea:")).take(15).enumerate() {
            h.entries.push(e(&s.id, s.category, at(2026, 11, 18, 20) + i as i64));
        }
        let busy = day_points(&h, &cat, &log, day);
        assert_eq!(busy.total, 20);
        assert!(busy.uncapped > 20);
    }

    #[test]
    fn first_ticket_badge_counts_once() {
        let cat = catalog::load();
        let d1 = NaiveDate::from_ymd_opt(2026, 11, 16).unwrap();
        let h = History { entries: vec![e("idea:hike", Category::Sport, at(2026, 11, 16, 10)), e("idea:swim", Category::Sport, at(2026, 11, 17, 10))], ..Default::default() };
        let p1 = day_points(&h, &cat, &QuizLog::default(), d1);
        assert_eq!(p1.badges, 5, "First ticket, earned on the 16th: {p1:?}");
        let p2 = day_points(&h, &cat, &QuizLog::default(), d1.succ_opt().unwrap());
        assert_eq!(p2.badges, 0, "not earned again on the 17th");
    }

    #[test]
    fn tiers_follow_points() {
        assert_eq!(tier(0).id, "bronze");
        assert_eq!(tier(49).next, Some(50));
        assert_eq!(tier(50).id, "silver");
        assert_eq!(tier(130).id, "gold");
        assert_eq!(tier(400), Tier { id: "diamond", label: "Diamond", from: 350, next: None });
    }
}
