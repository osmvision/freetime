//! Built-in ideas that work offline. Edit `data/activities.toml` to add your own.

use crate::{model::*, places::PlaceKind};
use serde::Deserialize;
use std::collections::HashMap;

const DATA: &str = include_str!("../data/activities.toml");

#[derive(Deserialize)]
struct File {
    activity: Vec<Activity>,
}

#[derive(Deserialize)]
struct Activity {
    id: String,
    category: Category,
    title: String,
    detail: String,
    min: u32,
    max: u32,
    energy: Energy,
    #[serde(default)]
    outdoor: bool,
    social: Social,
    cost: Cost,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    link: Option<String>,
    #[serde(default = "default_quality")]
    quality: f64,
    /// Where it happens, to look up real places nearby (OpenStreetMap, on request only).
    #[serde(default)]
    place: Option<PlaceKind>,
}

fn default_quality() -> f64 {
    0.6
}

fn file() -> File {
    toml::from_str(DATA).expect("built-in catalog is valid (checked by tests)")
}

/// The kind of place each built-in idea happens in, by suggestion id ("idea:swim" -> pool).
pub fn places() -> HashMap<String, PlaceKind> {
    file().activity.into_iter().filter_map(|a| a.place.map(|p| (format!("idea:{}", a.id), p))).collect()
}

pub fn load() -> Vec<Suggestion> {
    file()
        .activity
        .into_iter()
        .map(|a| Suggestion {
            id: format!("idea:{}", a.id),
            category: a.category,
            title: a.title,
            detail: a.detail,
            link: a.link,
            image: None,
            min_minutes: a.min,
            max_minutes: a.max,
            energy: a.energy,
            outdoor: a.outdoor,
            social: a.social,
            cost: a.cost,
            quality: a.quality,
            tags: a.tags,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_is_valid() {
        let items = load();
        assert!(items.len() >= 200, "{} ideas", items.len());
        let mut ids = HashSet::new();
        for s in &items {
            assert!(ids.insert(&s.id), "duplicate id {}", s.id);
            assert!(s.min_minutes <= s.max_minutes, "{}: min > max", s.id);
            assert!((0.0..=1.0).contains(&s.quality), "{}: quality out of range", s.id);
        }
        for c in Category::ALL.iter().filter(|c| **c != Category::Video) {
            let n = items.iter().filter(|s| s.category == *c).count();
            assert!(n >= 25, "only {n} built-in ideas for {c:?}: keep the kinds balanced");
        }
        let places = places();
        assert!(places.len() >= 30);
        assert!(places.keys().all(|id| items.iter().any(|s| &s.id == id)));
    }
}
