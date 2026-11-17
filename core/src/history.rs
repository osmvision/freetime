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
/// Tags that every item of a source shares: they say nothing about taste.
const GENERIC_TAGS: [&str; 3] = ["steam", "store", "youtube"];

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct History {
    pub entries: Vec<Entry>,
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
}

#[derive(Debug, Default)]
pub struct Prefs {
    category: HashMap<Category, f64>,
    tags: HashMap<String, f64>,
    pub recent: HashSet<String>,
    pub disliked: HashSet<String>,
    pub liked: HashSet<String>,
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
        });
        if self.entries.len() > MAX_ENTRIES {
            let extra = self.entries.len() - MAX_ENTRIES;
            self.entries.drain(..extra);
        }
    }

    /// Indexes of picks that still need a rating, newest first.
    pub fn unrated(&self, now: i64, min_age_secs: i64, limit: usize) -> Vec<usize> {
        self.entries
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, e)| {
                let age = now - e.ts;
                e.rating.is_none() && age >= min_age_secs && age <= RATE_WINDOW_SECS
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
        // Shrink towards 0 so one rating doesn't swing everything.
        p.category = cat.into_iter().map(|(k, (s, n))| (k, s / (n + 2.0))).collect();
        p.tags = tag.into_iter().map(|(k, (s, n))| (k, s / (n + 2.0))).collect();
        p
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
        Entry { id: id.into(), category: cat, title: id.into(), tags: vec!["cardio".into()], ts, rating }
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
        };
        assert_eq!(h.unrated(now, 1800, 5), vec![2, 1]);
    }
}
