//! freetime core: ideas, scoring, history and online sources. No UI code here:
//! the terminal app (`cli/`) and the desktop app (`desktop/`) are both built on it.

pub mod catalog;
pub mod config;
pub mod history;
pub mod keys;
pub mod location;
pub mod net;
pub mod model;
pub mod open;
pub mod providers;
pub mod region;
pub mod scoring;
pub mod vdf;
pub mod weather;

use config::Config;
use history::Prefs;
use model::{Request, Suggestion};
use providers::{youtube, Online};
use scoring::Ranked;
use std::collections::HashSet;

/// Everything that could be suggested right now: built-in ideas, online picks, YouTube searches.
pub fn candidates(cfg: &Config, minutes: u32, online: &Online) -> Vec<Suggestion> {
    let mut items = catalog::load();
    items.extend(online.items.iter().cloned());
    // Search links only as a last resort: when no real video could be found (offline, feeds down).
    if !online.items.iter().any(|s| s.id.starts_with("yt:")) {
        items.extend(youtube::search_links(cfg, minutes));
    }
    items
}

/// Ranks every candidate for this request, best first.
pub fn rank(cfg: &Config, req: &Request, online: &Online, prefs: &Prefs, exclude: &HashSet<String>) -> Vec<Ranked> {
    let items = candidates(cfg, req.minutes, online);
    scoring::rank(&items, req, online.weather.as_ref(), prefs, exclude, &mut rand::thread_rng())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_links_are_a_last_resort() {
        let cfg = Config::default();
        let is_search = |s: &Suggestion| s.id.starts_with("ytsearch:");
        assert!(candidates(&cfg, 30, &Online::default()).iter().any(is_search));

        let mut video = catalog::load().remove(0);
        video.id = "yt:abc123DEF45".into();
        let online = Online { items: vec![video], ..Default::default() };
        assert!(!candidates(&cfg, 30, &online).iter().any(is_search));
    }

    #[test]
    fn category_ids_round_trip() {
        for c in model::Category::ALL {
            assert_eq!(model::Category::from_id(c.id()), Some(c));
        }
        assert_eq!(model::Category::from_id("Relax"), Some(model::Category::Chill));
        assert_eq!(model::Category::from_id("nope"), None);
    }
}
