//! freetime core: ideas, scoring, history and online sources. No UI code here:
//! the terminal app (`cli/`) and the desktop app (`desktop/`) are both built on it.

pub mod catalog;
pub mod config;
pub mod history;
pub mod location;
pub mod net;
pub mod model;
pub mod open;
pub mod providers;
pub mod scoring;
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
    // Real videos first, generic searches as a fallback.
    items.extend(youtube::search_links(cfg, minutes));
    items
}

/// Ranks every candidate for this request, best first.
pub fn rank(cfg: &Config, req: &Request, online: &Online, prefs: &Prefs, exclude: &HashSet<String>) -> Vec<Ranked> {
    let items = candidates(cfg, req.minutes, online);
    scoring::rank(&items, req, online.weather.as_ref(), prefs, exclude, &mut rand::thread_rng())
}
