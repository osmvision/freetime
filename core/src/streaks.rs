//! Streaks together: weeks in a row you and a friend did something together (an accepted invite
//! whose time came, from the server's `together_weeks()`). One wildcard a month saves a single
//! missed week, so one busy week doesn't wipe out a long streak. The current week only counts once
//! it happens: until then, the streak still stands.

use chrono::{Datelike, Duration, NaiveDate};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Streak {
    /// Weeks in a row, up to this week (or last week while this one hasn't happened yet).
    pub weeks: u32,
    pub best: u32,
    /// Something together this week already.
    pub this_week: bool,
    /// This month's wildcard is still there.
    pub wildcard_left: bool,
    /// The week a wildcard saved in the current streak, if any (its Monday).
    pub saved_week: Option<String>,
}

/// The Monday of a date's week.
pub fn monday(d: NaiveDate) -> NaiveDate {
    d - Duration::days(i64::from(d.weekday().num_days_from_monday()))
}

fn month(d: NaiveDate) -> (i32, u32) {
    (d.year(), d.month())
}

/// Walks back from `start` (a Monday): active weeks count, one gap per month can be bridged by a
/// wildcard if the week before it is active. Returns (weeks, wildcard months used, saved weeks).
fn walk(active: &HashSet<NaiveDate>, start: NaiveDate) -> (u32, HashSet<(i32, u32)>, Vec<NaiveDate>) {
    let mut weeks = 0;
    let mut used = HashSet::new();
    let mut saved = Vec::new();
    let mut d = start;
    loop {
        if active.contains(&d) {
            weeks += 1;
        } else if !used.contains(&month(d)) && active.contains(&(d - Duration::days(7))) && (weeks > 0 || d == start) {
            used.insert(month(d));
            saved.push(d);
        } else {
            break;
        }
        d -= Duration::days(7);
    }
    (weeks, used, saved)
}

pub fn streak(weeks: &[NaiveDate], today: NaiveDate) -> Streak {
    let active: HashSet<NaiveDate> = weeks.iter().map(|w| monday(*w)).collect();
    let this_monday = monday(today);
    let this_week = active.contains(&this_monday);
    let start = if this_week { this_monday } else { this_monday - Duration::days(7) };
    let (current, used, saved) = walk(&active, start);
    let best = active.iter().map(|w| walk(&active, *w).0).max().unwrap_or(0).max(current);
    Streak {
        weeks: current,
        best,
        this_week,
        wildcard_left: !used.contains(&month(this_monday)),
        saved_week: if current > 0 { saved.first().map(|d| d.to_string()) } else { None },
    }
}

pub fn by_friend(weeks: Vec<(String, NaiveDate)>, today: NaiveDate) -> HashMap<String, Streak> {
    let mut by_friend: HashMap<String, Vec<NaiveDate>> = HashMap::new();
    for (friend, week) in weeks {
        by_friend.entry(friend).or_default().push(week);
    }
    by_friend
        .into_iter()
        .map(|(friend, weeks)| (friend, streak(&weeks, today)))
        .filter(|(_, result)| result.best > 0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn counts_weeks_in_a_row_and_waits_for_this_week() {
        // Thursday 19 November 2026; Mondays: 16 Nov (this week), 9, 2 Nov, 26 Oct.
        let today = d(2026, 11, 19);
        let s = streak(&[d(2026, 11, 10), d(2026, 11, 4), d(2026, 10, 27)], today);
        assert_eq!((s.weeks, s.this_week), (3, false), "this week hasn't happened yet: the streak still stands");
        let s = streak(&[d(2026, 11, 18), d(2026, 11, 10)], today);
        assert_eq!((s.weeks, s.this_week), (2, true));
        assert_eq!(streak(&[], today), Streak { wildcard_left: true, ..Default::default() });
    }

    #[test]
    fn a_wildcard_saves_one_missed_week_a_month() {
        let today = d(2026, 11, 19);
        // Active: this week, (9 Nov missed), 2 Nov, 26 Oct.
        let s = streak(&[d(2026, 11, 17), d(2026, 11, 3), d(2026, 10, 26)], today);
        assert_eq!(s.weeks, 3, "the missed week is saved");
        assert_eq!(s.saved_week.as_deref(), Some("2026-11-09"));
        assert!(!s.wildcard_left, "November's wildcard is used");
        // Two missed weeks in a row: no rescue.
        let s = streak(&[d(2026, 11, 17), d(2026, 10, 27)], today);
        assert_eq!(s.weeks, 1);
        // Two missed weeks in the same month, apart: only one is saved.
        let s = streak(&[d(2026, 11, 17), d(2026, 11, 3), d(2026, 10, 20), d(2026, 10, 13)], today);
        // 16 Nov ✓, 9 Nov saved (Nov), 2 Nov ✓, 26 Oct missed → October's wildcard, 19 Oct ✓, 12 Oct ✓
        assert_eq!(s.weeks, 4);
        assert!(!s.wildcard_left);
    }

    #[test]
    fn best_is_the_longest_run_ever() {
        let today = d(2026, 11, 19);
        let old_run = [d(2026, 6, 1), d(2026, 6, 8), d(2026, 6, 15), d(2026, 6, 22), d(2026, 6, 29)];
        let mut weeks = old_run.to_vec();
        weeks.push(d(2026, 11, 18));
        let s = streak(&weeks, today);
        assert_eq!((s.weeks, s.best), (1, 5));
    }
}
