//! freetime core: ideas, scoring, history and online sources. No UI code here:
//! the terminal app (`cli/`) and the desktop app (`desktop/`) are both built on it.

pub mod account;
pub mod assistant;
pub mod catalog;
pub mod config;
pub mod duel;
pub mod book;
pub mod history;
pub mod keys;
pub mod location;
pub mod net;
pub mod model;
pub mod mine;
pub mod open;
pub mod party;
pub mod places;
pub mod puzzles;
pub mod providers;
pub mod quiz;
pub mod ranked;
pub mod realtime;
pub mod region;
pub mod scoring;
pub mod streaks;
pub mod wrapped;
pub mod vdf;
pub mod weather;
pub mod support;

use config::Config;
use history::Prefs;
use model::{Request, Suggestion};
use providers::{youtube, Online};
use scoring::Ranked;
use std::collections::HashSet;

/// Everything that could be suggested right now: built-in ideas, online picks, YouTube searches.
pub fn candidates(cfg: &Config, minutes: u32, online: &Online) -> Vec<Suggestion> {
    let mut items = catalog::load();
    items.extend(cfg.my_ideas.iter().filter(|i| i.is_valid()).map(mine::MyIdea::to_suggestion));
    items.extend(online.items.iter().cloned());
    // Search links only as a last resort: when no real video could be found (offline, feeds down).
    if !online.items.iter().any(|s| s.id.starts_with("yt:")) {
        items.extend(youtube::search_links(cfg, minutes));
    }
    items
}

/// Ranks every candidate for this request, best first.
pub fn rank(cfg: &Config, req: &Request, online: &Online, prefs: &Prefs, exclude: &HashSet<String>) -> Vec<Ranked> {
    rank_together(cfg, req, online, prefs, exclude, None)
}

/// Same, with friends from their friend codes when the request is "with friends". Without a
/// party (or alone), this is exactly the solo ranking.
pub fn rank_together(
    cfg: &Config,
    req: &Request,
    online: &Online,
    prefs: &Prefs,
    exclude: &HashSet<String>,
    party: Option<&party::Party>,
) -> Vec<Ranked> {
    let party = party.filter(|p| req.with_friends && !p.is_empty());
    let mut items = candidates(cfg, req.minutes, online);
    if let Some(p) = party {
        p.prepare(&mut items);
    }
    let mut ranked = scoring::rank(&items, req, online.weather.as_ref(), prefs, exclude, &mut rand::thread_rng());
    if let Some(p) = party {
        p.adjust(&mut ranked);
    }
    ranked
}

/// "Shall we play now?": the Steam games you and these friends all own, best first for this
/// request (games only, together), and how many you share in all.
pub struct PlayNow {
    pub common: usize,
    pub picks: Vec<Ranked>,
}

pub fn play_now(cfg: &Config, req: &Request, online: &Online, prefs: &Prefs, party: &party::Party) -> PlayNow {
    let req = Request { categories: vec![model::Category::Game], with_friends: true, can_go_out: false, ..req.clone() };
    let ranked = rank_together(cfg, &req, online, prefs, &HashSet::new(), Some(party));
    let picks = ranked.into_iter().filter(|r| party.is_common(&r.s.id)).take(3).collect();
    PlayNow { common: party.common_games(), picks }
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
    fn your_own_ideas_are_ranked_too_but_not_tampered_ones() {
        let mut cfg = Config::default();
        let input = |title: &str| mine::MyIdeaInput {
            title: title.into(),
            detail: String::new(),
            category: model::Category::Social,
            minutes: 30,
            energy: model::Energy::Low,
            outdoor: false,
            social: model::Social::Either,
            cost: model::Cost::Free,
            link: None,
        };
        let ok = mine::add(&mut cfg.my_ideas, input("Feed the ducks")).unwrap();
        let mut bad = mine::add(&mut cfg.my_ideas, input("Bad")).unwrap();
        bad.link = Some("file:///etc/passwd".into());
        cfg.my_ideas[1] = bad.clone();
        let ids: Vec<String> = candidates(&cfg, 30, &Online::default()).into_iter().map(|s| s.id).collect();
        assert!(ids.contains(&ok.suggestion_id()));
        assert!(!ids.contains(&bad.suggestion_id()));
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
