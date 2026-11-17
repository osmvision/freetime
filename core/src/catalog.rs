//! Built-in ideas that work offline. Edit `data/activities.toml` to add your own.

use crate::model::*;
use serde::Deserialize;

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
}

fn default_quality() -> f64 {
    0.6
}

pub fn load() -> Vec<Suggestion> {
    let file: File = toml::from_str(DATA).expect("built-in catalog is valid (checked by tests)");
    file.activity
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
        assert!(items.len() > 40);
        let mut ids = HashSet::new();
        for s in &items {
            assert!(ids.insert(&s.id), "duplicate id {}", s.id);
            assert!(s.min_minutes <= s.max_minutes, "{}: min > max", s.id);
            assert!((0.0..=1.0).contains(&s.quality), "{}: quality out of range", s.id);
        }
        for c in Category::ALL.iter().filter(|c| **c != Category::Video) {
            assert!(items.iter().any(|s| s.category == *c), "no built-in idea for {c:?}");
        }
    }
}
