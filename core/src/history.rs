//! What the user picked and how they rated it. Drives taste learning.

use crate::{config, model::*};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
};

/// Ask how a pick went once at least this much time has passed.
pub const RATE_AFTER_SECS: i64 = 30 * 60;
const MAX_ENTRIES: usize = 500;
const RECENT_SECS: i64 = 3 * 86_400;
const RATE_WINDOW_SECS: i64 = 14 * 86_400;
/// Passes older than this no longer count: tastes and moods change.
const PASS_WINDOW_SECS: i64 = 21 * 86_400;
/// The same idea passed twice within this gap counts once ("Other picks" pressed twice in a row).
const PASS_DEBOUNCE_SECS: i64 = 3600;
pub const MAX_PASSES: usize = 600;
pub const MAX_NEVER: usize = 1000;
/// How much a "never" weighs on the taste of its category and tags (a 👎 weighs 1).
const NEVER_WEIGHT: f64 = 0.5;
/// Tags that every item of a source shares: they say nothing about taste.
const GENERIC_TAGS: [&str; 6] = ["steam", "store", "youtube", "epic", "free-week", crate::mine::TAG];

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct History {
    pub entries: Vec<Entry>,
    /// Ideas shown first and passed over without starting them: a light signal that fades.
    #[serde(default)]
    pub passes: Vec<Pass>,
    /// Ideas the user asked never to see again ("Never suggest this"). Undone from Settings.
    #[serde(default)]
    pub never: Vec<Never>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pass {
    pub id: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Never {
    pub id: String,
    pub category: Category,
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub category: Category,
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub ts: i64,
    /// 1 = liked, -1 = disliked, 0 = skipped / didn't do it, None = not asked yet.
    #[serde(default)]
    pub rating: Option<i8>,
    /// Typical length of the pick, in minutes (absent in history written before it was kept).
    #[serde(default)]
    pub minutes: Option<u32>,
}

/// The weekly recap: this week so far, last week, the streak and a few memories.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Recap {
    pub week_picks: usize,
    pub week_minutes: u32,
    pub week_loved: usize,
    /// Picks per kind of idea this week, most first.
    pub week_by_category: Vec<(Category, usize)>,
    pub last_week_picks: usize,
    pub last_week_minutes: u32,
    /// Weeks in a row with at least one pick, up to this week (or last week, while this one is
    /// still young): a weekly rhythm, not a daily chore.
    pub streak_weeks: u32,
    pub best_streak: u32,
    pub this_week_active: bool,
    pub memories: Vec<Memory>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Memory {
    /// "a year ago" or "a month ago".
    pub when: String,
    pub id: String,
    pub title: String,
    pub category: Category,
    pub loved: bool,
}

/// Picks before minutes were kept: a sensible guess per kind of idea.
fn guess_minutes(c: Category) -> u32 {
    match c {
        Category::Game => 60,
        Category::Video => 20,
        Category::Sport => 45,
        Category::Learn => 30,
        Category::Create => 40,
        Category::Chill => 30,
        Category::Social => 90,
        Category::Food => 45,
    }
}

#[derive(Debug, Default)]
pub struct Prefs {
    category: HashMap<Category, f64>,
    tags: HashMap<String, f64>,
    pub recent: HashSet<String>,
    pub disliked: HashSet<String>,
    pub liked: HashSet<String>,
    /// Ideas the user never wants to see again.
    pub never: HashSet<String>,
    /// How many times each idea was passed over lately (within `PASS_WINDOW_SECS`).
    pub passed: HashMap<String, u32>,
}

impl Prefs {
    /// -1..1, how much the user liked this category so far.
    pub fn category_affinity(&self, c: Category) -> f64 {
        self.category.get(&c).copied().unwrap_or(0.0)
    }

    /// -1..1, mean affinity over the tags we have an opinion on.
    pub fn tag_affinity(&self, tags: &[String]) -> f64 {
        let known: Vec<f64> = tags.iter().filter_map(|t| self.tags.get(t).copied()).collect();
        if known.is_empty() {
            0.0
        } else {
            known.iter().sum::<f64>() / known.len() as f64
        }
    }
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// "just now", "12 min ago", "yesterday"...
pub fn ago(secs: i64) -> String {
    match secs {
        s if s < 120 => "just now".into(),
        s if s < 3600 => format!("{} min ago", s / 60),
        s if s < 86_400 => format!("{} h ago", s / 3600),
        s if s < 2 * 86_400 => "yesterday".into(),
        s => format!("{} days ago", s / 86_400),
    }
}

impl History {
    fn path() -> PathBuf {
        config::data_dir().join("history.json")
    }

    pub fn load() -> History {
        fs::read_to_string(Self::path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn record_pick(&mut self, s: &Suggestion) {
        self.entries.push(Entry {
            id: s.id.clone(),
            category: s.category,
            title: s.title.clone(),
            tags: s.tags.clone(),
            ts: now(),
            rating: None,
            minutes: Some(((s.min_minutes + s.max_minutes) / 2).clamp(5, 240)),
        });
        if self.entries.len() > MAX_ENTRIES {
            let extra = self.entries.len() - MAX_ENTRIES;
            self.entries.drain(..extra);
        }
    }

    /// The idea was shown first and passed over ("Not this one", "Other picks"). Returns false
    /// when it was already counted within the last hour.
    pub fn record_pass(&mut self, id: &str, now: i64) -> bool {
        if id.is_empty() || self.passes.iter().any(|p| p.id == id && (now - p.ts).abs() < PASS_DEBOUNCE_SECS) {
            return false;
        }
        self.passes.retain(|p| now - p.ts < PASS_WINDOW_SECS);
        self.passes.push(Pass { id: id.to_string(), ts: now });
        if self.passes.len() > MAX_PASSES {
            let extra = self.passes.len() - MAX_PASSES;
            self.passes.drain(..extra);
        }
        true
    }

    /// "Never suggest this": the idea stops coming back until the user undoes it.
    pub fn hide(&mut self, s: &Suggestion, now: i64) {
        if self.never.iter().any(|n| n.id == s.id) {
            return;
        }
        self.never.push(Never { id: s.id.clone(), category: s.category, title: s.title.clone(), tags: s.tags.clone(), ts: now });
        if self.never.len() > MAX_NEVER {
            let extra = self.never.len() - MAX_NEVER;
            self.never.drain(..extra);
        }
    }

    /// Undoes `hide`, and forgets the passes so the idea comes back on equal terms.
    /// Returns false when the idea wasn't hidden.
    pub fn unhide(&mut self, id: &str) -> bool {
        let before = self.never.len();
        self.never.retain(|n| n.id != id);
        self.passes.retain(|p| p.id != id);
        self.never.len() != before
    }

    /// Indexes of picks that still need a rating, newest first.
    pub fn unrated(&self, now: i64, min_age_secs: i64, limit: usize) -> Vec<usize> {
        self.entries
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, e)| {
                let age = now - e.ts;
                // A finished quiz isn't asked "how was it?": you just played it in freetime.
                e.rating.is_none() && !e.id.starts_with("quiz:") && age >= min_age_secs && age <= RATE_WINDOW_SECS
            })
            .map(|(i, _)| i)
            .take(limit)
            .collect()
    }

    pub fn prefs(&self, now: i64) -> Prefs {
        let mut p = Prefs::default();
        let mut cat: HashMap<Category, (f64, f64)> = HashMap::new();
        let mut tag: HashMap<String, (f64, f64)> = HashMap::new();
        for e in &self.entries {
            if now - e.ts < RECENT_SECS {
                p.recent.insert(e.id.clone());
            }
            let r = match e.rating {
                Some(r) if r != 0 => r as f64,
                _ => continue,
            };
            if r > 0.0 {
                p.liked.insert(e.id.clone());
                p.disliked.remove(&e.id);
            } else {
                p.disliked.insert(e.id.clone());
                p.liked.remove(&e.id);
            }
            let c = cat.entry(e.category).or_default();
            c.0 += r;
            c.1 += 1.0;
            for t in e.tags.iter().filter(|t| !GENERIC_TAGS.contains(&t.as_str())) {
                let t = tag.entry(t.clone()).or_default();
                t.0 += r;
                t.1 += 1.0;
            }
        }
        // "Never" is a half-weight 👎 on the taste, and the idea itself never comes back.
        for n in &self.never {
            p.never.insert(n.id.clone());
            let c = cat.entry(n.category).or_default();
            c.0 -= NEVER_WEIGHT;
            c.1 += NEVER_WEIGHT;
            for t in n.tags.iter().filter(|t| !GENERIC_TAGS.contains(&t.as_str())) {
                let t = tag.entry(t.clone()).or_default();
                t.0 -= NEVER_WEIGHT;
                t.1 += NEVER_WEIGHT;
            }
        }
        // Passes only touch the idea itself: skipping a game tonight says little about games.
        for pass in self.passes.iter().filter(|p| now - p.ts < PASS_WINDOW_SECS) {
            *p.passed.entry(pass.id.clone()).or_default() += 1;
        }
        // Shrink towards 0 so one rating doesn't swing everything.
        p.category = cat.into_iter().map(|(k, (s, n))| (k, s / (n + 2.0))).collect();
        p.tags = tag.into_iter().map(|(k, (s, n))| (k, s / (n + 2.0))).collect();
        p
    }

    /// This week, last week, the weekly streak and memories, in local time.
    pub fn recap(&self, now: chrono::DateTime<chrono::Local>) -> Recap {
        use chrono::{Datelike, Local, Months, TimeZone};
        let week_of = |ts: i64| Local.timestamp_opt(ts, 0).single().map(|d| d.iso_week()).map(|w| (w.year(), w.week()));
        let this_week = (now.iso_week().year(), now.iso_week().week());
        let last_week = {
            let d = now - chrono::Duration::days(7);
            (d.iso_week().year(), d.iso_week().week())
        };
        let minutes = |e: &Entry| e.minutes.unwrap_or_else(|| guess_minutes(e.category));

        let mut r = Recap {
            week_picks: 0,
            week_minutes: 0,
            week_loved: 0,
            week_by_category: Vec::new(),
            last_week_picks: 0,
            last_week_minutes: 0,
            streak_weeks: 0,
            best_streak: 0,
            this_week_active: false,
            memories: Vec::new(),
        };
        let mut by_cat: HashMap<Category, usize> = HashMap::new();
        let mut active: HashSet<(i32, u32)> = HashSet::new();
        for e in &self.entries {
            let Some(w) = week_of(e.ts) else { continue };
            active.insert(w);
            if w == this_week {
                r.week_picks += 1;
                r.week_minutes += minutes(e);
                r.week_loved += usize::from(e.rating == Some(1));
                *by_cat.entry(e.category).or_default() += 1;
            } else if w == last_week {
                r.last_week_picks += 1;
                r.last_week_minutes += minutes(e);
            }
        }
        r.week_by_category = by_cat.into_iter().collect();
        r.week_by_category.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.id().cmp(b.0.id())));
        r.this_week_active = active.contains(&this_week);

        // Streak: count back week by week (Monday to Monday) from this week, or from last week
        // while this one has no pick yet.
        let monday = now.date_naive() - chrono::Duration::days(now.weekday().num_days_from_monday() as i64);
        let key = |d: chrono::NaiveDate| (d.iso_week().year(), d.iso_week().week());
        let mut d = if r.this_week_active { monday } else { monday - chrono::Duration::days(7) };
        while active.contains(&key(d)) {
            r.streak_weeks += 1;
            d -= chrono::Duration::days(7);
        }
        // Best streak ever: walk every active week in order.
        let mut weeks: Vec<chrono::NaiveDate> = active
            .iter()
            .filter_map(|(y, w)| chrono::NaiveDate::from_isoywd_opt(*y, *w, chrono::Weekday::Mon))
            .collect();
        weeks.sort();
        let mut run = 0u32;
        let mut prev: Option<chrono::NaiveDate> = None;
        for w in weeks {
            run = if prev.is_some_and(|p| w - p == chrono::Duration::days(7)) { run + 1 } else { 1 };
            r.best_streak = r.best_streak.max(run);
            prev = Some(w);
        }

        // Memories: what you picked on this day a year ago and a month ago.
        let today = now.date_naive();
        let targets = [
            (today.checked_sub_months(Months::new(12)), "a year ago"),
            (today.checked_sub_months(Months::new(1)), "a month ago"),
        ];
        for (day, label) in targets {
            let Some(day) = day else { continue };
            if let Some(e) = self.entries.iter().rev().find(|e| Local.timestamp_opt(e.ts, 0).single().is_some_and(|d| d.date_naive() == day)) {
                r.memories.push(Memory { when: label.to_string(), id: e.id.clone(), title: e.title.clone(), category: e.category, loved: e.rating == Some(1) });
            }
        }
        r
    }

    /// Category affinities, best first, for the history screen.
    pub fn taste(&self) -> Vec<(Category, f64)> {
        let p = self.prefs(now());
        let mut v: Vec<(Category, f64)> = p.category.into_iter().collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, cat: Category, rating: Option<i8>, ts: i64) -> Entry {
        Entry { id: id.into(), category: cat, title: id.into(), tags: vec!["cardio".into()], ts, rating, minutes: None }
    }

    fn at(y: i32, m: u32, d: u32, h: u32) -> chrono::DateTime<chrono::Local> {
        use chrono::TimeZone;
        chrono::Local.with_ymd_and_hms(y, m, d, h, 0, 0).single().unwrap()
    }

    #[test]
    fn weekly_recap_streak_and_memories() {
        // Wednesday 18 November 2026; ISO weeks start on Monday 16 November.
        let now = at(2026, 11, 18, 20);
        let mut h = History::default();
        let mut add = |when: chrono::DateTime<chrono::Local>, cat, rating, minutes| {
            let mut e = entry("x", cat, rating, when.timestamp());
            e.minutes = minutes;
            h.entries.push(e);
        };
        add(at(2026, 11, 17, 19), Category::Sport, Some(1), Some(40)); // this week
        add(at(2026, 11, 18, 9), Category::Game, None, None); // this week, minutes guessed (60)
        add(at(2026, 11, 12, 21), Category::Food, None, Some(30)); // last week
        add(at(2026, 11, 3, 21), Category::Food, None, Some(30)); // two weeks ago
        // A gap (week of 26 October), then an older 3-week run.
        add(at(2026, 10, 14, 21), Category::Chill, None, None);
        add(at(2026, 10, 7, 21), Category::Chill, None, None);
        add(at(2026, 9, 30, 21), Category::Chill, None, None);
        add(at(2026, 9, 23, 21), Category::Chill, None, None);
        // Memories.
        add(at(2025, 11, 18, 12), Category::Sport, Some(1), None);
        add(at(2026, 10, 18, 12), Category::Learn, None, None);
        let r = h.recap(now);
        assert_eq!((r.week_picks, r.week_minutes, r.week_loved), (2, 100, 1));
        assert_eq!((r.last_week_picks, r.last_week_minutes), (1, 30));
        assert!(r.this_week_active);
        assert_eq!(r.streak_weeks, 3, "this week, last week, the week before");
        assert_eq!(r.best_streak, 4, "the September-October run");
        assert_eq!(r.memories.iter().map(|m| m.when.as_str()).collect::<Vec<_>>(), ["a year ago", "a month ago"]);
        assert!(r.memories[0].loved);
    }

    #[test]
    fn the_streak_survives_until_the_week_is_over() {
        let monday = at(2026, 11, 16, 8);
        let mut h = History::default();
        h.entries.push(entry("a", Category::Sport, None, at(2026, 11, 11, 20).timestamp()));
        let r = h.recap(monday);
        assert!(!r.this_week_active);
        assert_eq!(r.streak_weeks, 1, "last week still counts on Monday morning");
        assert_eq!(History::default().recap(monday).streak_weeks, 0);
    }

    #[test]
    fn learns_likes_and_dislikes() {
        let now = 1_000_000;
        let h = History {
            entries: vec![
                entry("a", Category::Sport, Some(1), now - 10 * 86_400),
                entry("b", Category::Sport, Some(1), now - 9 * 86_400),
                entry("c", Category::Food, Some(-1), now - 100),
            ],
            ..Default::default()
        };
        let p = h.prefs(now);
        assert!(p.category_affinity(Category::Sport) > 0.4);
        assert!(p.category_affinity(Category::Food) < 0.0);
        assert!(p.liked.contains("a") && p.disliked.contains("c"));
        assert!(p.recent.contains("c") && !p.recent.contains("a"));
    }

    #[test]
    fn unrated_newest_first() {
        let now = 1_000_000;
        let h = History {
            entries: vec![
                entry("old", Category::Sport, None, now - 20 * 86_400),
                entry("a", Category::Sport, None, now - 7200),
                entry("b", Category::Sport, None, now - 3600),
                entry("fresh", Category::Sport, None, now - 60),
            ],
            ..Default::default()
        };
        assert_eq!(h.unrated(now, 1800, 5), vec![2, 1]);
    }

    fn idea(id: &str, cat: Category) -> Suggestion {
        Suggestion {
            id: id.into(),
            category: cat,
            title: id.into(),
            detail: String::new(),
            link: None,
            image: None,
            min_minutes: 10,
            max_minutes: 30,
            energy: Energy::Medium,
            outdoor: false,
            social: Social::Solo,
            cost: Cost::Free,
            quality: 0.5,
            tags: vec!["knitting".into(), "steam".into()],
        }
    }

    #[test]
    fn passes_count_once_an_hour_and_fade() {
        let now = 10_000_000;
        let mut h = History::default();
        assert!(h.record_pass("a", now - 22 * 86_400), "an old pass");
        assert!(h.record_pass("a", now - 7200));
        assert!(!h.record_pass("a", now - 7000), "Other picks twice in a row counts once");
        assert!(h.record_pass("a", now));
        assert!(h.record_pass("b", now));
        assert!(!h.record_pass("", now));
        let p = h.prefs(now);
        assert_eq!(p.passed.get("a"), Some(&2), "the 22-day-old pass no longer counts");
        assert_eq!(p.passed.get("b"), Some(&1));
        assert_eq!(h.passes.len(), 3, "faded passes are dropped when a new one comes");
    }

    #[test]
    fn never_hides_the_idea_and_nudges_its_taste() {
        let now = 10_000_000;
        let mut h = History::default();
        h.hide(&idea("knit", Category::Create), now);
        h.hide(&idea("knit", Category::Create), now);
        h.record_pass("knit", now);
        assert_eq!(h.never.len(), 1, "hiding twice keeps one entry");
        let p = h.prefs(now);
        assert!(p.never.contains("knit"));
        assert!(p.category_affinity(Category::Create) < 0.0);
        assert!(p.tag_affinity(&["knitting".into()]) < 0.0);
        assert_eq!(p.tag_affinity(&["steam".into()]), 0.0, "source tags say nothing about taste");

        assert!(h.unhide("knit"));
        assert!(!h.unhide("knit"));
        let p = h.prefs(now);
        assert!(!p.never.contains("knit") && p.passed.is_empty(), "back on equal terms");
        assert_eq!(p.category_affinity(Category::Create), 0.0);
    }

    #[test]
    fn history_without_passes_or_never_still_loads() {
        let old = r#"{"entries":[{"id":"a","category":"sport","title":"A","ts":1}]}"#;
        let h: History = serde_json::from_str(old).unwrap();
        assert!(h.passes.is_empty() && h.never.is_empty() && h.entries.len() == 1);
    }
}
