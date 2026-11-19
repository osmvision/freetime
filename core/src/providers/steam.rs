//! Steam: games from the user's own import (freetime's cache: Steam's files are never read at
//! startup, see `steam_import`) and the public store front, priced with the regional `cc`.

use super::{
    steam_import::{self, Library, LibraryGame},
    Note,
};
use crate::{config, location::Location, model::*, net::{self, Net}};
use anyhow::{anyhow, Result};
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    fs,
};

/// Buying + downloading a new game eats time before you can play.
const STORE_MIN_MINUTES: u32 = 45;
/// appdetails is rate limited; results are cached so this only bites on the first runs.
const MAX_DETAIL_FETCHES: usize = 12;

/// What the UI shows about Steam.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SteamStatus {
    /// Games were imported (on request, see `steam_import`).
    pub imported: bool,
    pub games: usize,
    pub installed: usize,
    pub steam_id64: Option<String>,
    pub imported_at: Option<i64>,
    pub from_web_api: bool,
}

impl SteamStatus {
    pub fn of(library: Option<&Library>) -> SteamStatus {
        let Some(lib) = library else { return SteamStatus::default() };
        SteamStatus {
            imported: true,
            games: lib.games.len(),
            installed: lib.games.iter().filter(|g| g.installed).count(),
            steam_id64: Some(lib.steam_id64.clone()),
            imported_at: Some(lib.imported_at),
            from_web_api: lib.from_web_api,
        }
    }
}

/// Startup: no Steam file, no registry, no Web API call. Games come from the last import.
pub fn suggestions(net: &dyn Net, loc: &Location, notes: &mut Vec<Note>) -> (Vec<Suggestion>, SteamStatus) {
    let library = steam_import::load_library();
    let status = SteamStatus::of(library.as_ref());
    let mut items = match &library {
        Some(lib) => library_picks(lib, chrono::Utc::now().timestamp()),
        None => {
            notes.push(Note::tip("Import your Steam games in Settings to get picks from games you own."));
            Vec::new()
        }
    };
    let cc = loc.steam_cc();
    match store(net, cc.as_deref()) {
        Ok(v) => {
            let mine: HashSet<String> = items.iter().map(|s| s.id.clone()).collect();
            items.extend(v.into_iter().filter(|s| !mine.contains(&s.id)));
        }
        Err(e) => notes.push(Note::problem(format!("Steam store unavailable ({e})."))),
    }
    enrich(net, &mut items, cc.as_deref());
    (items, status)
}

#[derive(Deserialize)]
struct Owned {
    response: OwnedResp,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OwnedResp {
    games: Vec<OwnedGame>,
}

/// One game from the Web API's owned-games list.
#[derive(Debug, Clone, Deserialize)]
pub struct OwnedGame {
    pub appid: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub playtime_forever: u32,
    #[serde(default)]
    pub playtime_2weeks: u32,
    #[serde(default)]
    pub rtime_last_played: i64,
}

/// A game you can launch: the link starts it straight from Steam.
fn game(appid: u32, name: &str, detail: String, quality: f64, tag: &str) -> Suggestion {
    Suggestion {
        id: format!("steam:{appid}"),
        category: Category::Game,
        title: name.to_string(),
        detail,
        link: Some(format!("steam://rungameid/{appid}")),
        image: Some(format!("https://cdn.akamai.steamstatic.com/steam/apps/{appid}/header.jpg")),
        min_minutes: 30,
        max_minutes: 120,
        energy: Energy::Medium,
        outdoor: false,
        social: Social::Solo,
        cost: Cost::Free, // you already own it
        quality,
        tags: vec!["steam".into(), tag.into()],
    }
}

/// A game you and your friends all own (see `party`): something to play together.
pub fn together_pick(appid: u32, name: &str, detail: String) -> Suggestion {
    let mut s = game(appid, name, detail, 0.7, "together");
    s.social = Social::Either;
    s
}

/// Installed games: no download, ready the moment you sit down.
fn installed_picks(games: &[LibraryGame], skip: &HashSet<u32>, count: usize) -> Vec<Suggestion> {
    let mut pool: Vec<&LibraryGame> = games.iter().filter(|g| g.installed && !skip.contains(&g.appid)).collect();
    pool.shuffle(&mut rand::thread_rng());
    pool.into_iter()
        .take(count)
        .map(|g| {
            let mut s = game(g.appid, &g.name, "Installed · ready to play".into(), 0.62, "installed");
            s.min_minutes = 20;
            s
        })
        .collect()
}

/// The owned-games list (needs a key). Only called by an import the user started.
pub fn owned_games(net: &dyn Net, key: &str, steam_id: &str) -> Result<Vec<OwnedGame>> {
    let resp: Owned = net::get_json(
        net,
        "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/",
        &[
            ("key", key),
            ("steamid", steam_id),
            ("include_appinfo", "1"),
            ("include_played_free_games", "1"),
            ("format", "json"),
        ],
    )?;
    Ok(resp.response.games.into_iter().filter(|g| !g.name.is_empty()).collect())
}

/// Comfort picks, old favorites and the backlog when playtime is known; installed games get a
/// small boost (no download), and more installed games fill in.
pub fn library_picks(lib: &Library, now: i64) -> Vec<Suggestion> {
    if !lib.playtime_known {
        return installed_picks(&lib.games, &HashSet::new(), 10);
    }
    let pick = |g: &LibraryGame, detail: String, quality: f64, tag: &str| {
        let mut s = game(g.appid, &g.name, detail, quality, tag);
        if g.installed {
            s.detail.push_str(" · Installed");
            s.quality = (s.quality + 0.05).min(0.95);
            s.tags.push("installed".into());
        }
        s
    };
    let games = &lib.games;
    let mut out = Vec::new();

    let mut recent: Vec<&LibraryGame> = games.iter().filter(|g| g.playtime_2weeks > 0).collect();
    recent.sort_by_key(|g| Reverse(g.playtime_2weeks));
    for g in recent.iter().take(4) {
        let d = format!("Comfort pick: {} played in the last 2 weeks", fmt_minutes(g.playtime_2weeks));
        out.push(pick(g, d, 0.6, "comfort"));
    }

    let mut old: Vec<&LibraryGame> = games
        .iter()
        .filter(|g| g.playtime >= 600 && g.playtime_2weeks == 0 && g.last_played > 0 && now - g.last_played > 90 * 86_400)
        .collect();
    old.sort_by_key(|g| Reverse(g.playtime));
    for g in old.iter().take(4) {
        let months = (now - g.last_played) / (30 * 86_400);
        let d = format!("Old favorite: {}h played, last launched {months} months ago", g.playtime / 60);
        out.push(pick(g, d, 0.7, "rediscover"));
    }

    let mut backlog: Vec<&LibraryGame> = games.iter().filter(|g| g.playtime < 60).collect();
    backlog.shuffle(&mut rand::thread_rng());
    for g in backlog.iter().take(6) {
        let d = if g.playtime == 0 {
            "Backlog: you own it and never launched it".to_string()
        } else {
            format!("Backlog: you own it but only played {}", fmt_minutes(g.playtime))
        };
        out.push(pick(g, d, 0.72, "backlog"));
    }

    let mut seen = HashSet::new();
    out.retain(|s| seen.insert(s.id.clone()));
    let chosen: HashSet<u32> = out.iter().filter_map(|s| s.id.strip_prefix("steam:")?.parse().ok()).collect();
    out.extend(installed_picks(games, &chosen, 4));
    out
}

/// Query for a store.steampowered.com call: every one of them carries the user's country,
/// so prices come back in the local currency.
fn store_query<'a>(cc: Option<&'a str>, mut query: Vec<(&'a str, &'a str)>) -> Vec<(&'a str, &'a str)> {
    if let Some(cc) = cc {
        query.push(("cc", cc));
    }
    query
}

pub fn store(net: &dyn Net, cc: Option<&str>) -> Result<Vec<Suggestion>> {
    let v: Value = net::get_json(
        net,
        "https://store.steampowered.com/api/featuredcategories",
        &store_query(cc, vec![("l", "english")]),
    )?;

    struct Featured<'a> {
        id: u64,
        name: &'a str,
        final_price: u64,
        discount: u64,
        image: Option<String>,
        key: &'static str,
        label: &'static str,
    }
    let mut featured = Vec::new();
    let mut seen = HashSet::new();
    // "new_releases" is left out on purpose: it's mostly unknown shovelware.
    for (key, label) in [("top_sellers", "Top seller"), ("specials", "On sale")] {
        let Some(items) = v.get(key).and_then(|c| c.get("items")).and_then(Value::as_array) else {
            continue;
        };
        for it in items {
            let Some(id) = it.get("id").and_then(Value::as_u64) else { continue };
            if it.get("type").and_then(Value::as_u64).unwrap_or(0) != 0 {
                continue; // bundles, packages
            }
            let name = it.get("name").and_then(Value::as_str).unwrap_or("").trim();
            if name.is_empty() || !seen.insert(id) {
                continue;
            }
            featured.push(Featured {
                id,
                name,
                final_price: it.get("final_price").and_then(Value::as_u64).unwrap_or(0),
                discount: it.get("discount_percent").and_then(Value::as_u64).unwrap_or(0),
                image: it.get("header_image").and_then(Value::as_str).map(String::from),
                key,
                label,
            });
        }
    }

    let ids: Vec<u64> = featured.iter().map(|f| f.id).collect();
    let prices = prices(net, &ids, cc);
    Ok(featured
        .into_iter()
        .map(|f| {
            let price = prices.get(&f.id);
            let final_minor = price.map_or(f.final_price, |p| p.final_minor);
            let discount = price.map_or(f.discount, |p| p.discount);
            Suggestion {
                id: format!("steam:{}", f.id),
                category: Category::Game,
                title: f.name.to_string(),
                detail: price_detail(f.label, price, final_minor, discount),
                link: Some(format!("https://store.steampowered.com/app/{}", f.id)),
                image: f.image,
                min_minutes: STORE_MIN_MINUTES,
                max_minutes: 180,
                energy: Energy::Medium,
                outdoor: false,
                social: Social::Either,
                cost: match final_minor {
                    0 => Cost::Free,
                    1..=1500 => Cost::Cheap,
                    _ => Cost::Paid,
                },
                quality: match f.key {
                    "top_sellers" => 0.58,
                    _ => (0.45 + discount as f64 / 300.0).min(0.75),
                },
                tags: vec!["steam".into(), "store".into(), f.key.into()],
            }
        })
        .collect())
}

/// A price as Steam formats it for the user's country ("13,49€", "$9.99", "¥1,980").
#[derive(Debug, Clone, PartialEq)]
struct Price {
    final_formatted: String,
    /// The price before the discount; empty when there is none.
    initial_formatted: String,
    discount: u64,
    final_minor: u64,
}

/// One appdetails call for all the apps: with `filters=price_overview`, Steam accepts a list.
fn prices(net: &dyn Net, appids: &[u64], cc: Option<&str>) -> HashMap<u64, Price> {
    if appids.is_empty() {
        return HashMap::new();
    }
    let ids = appids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
    let query = store_query(cc, vec![("appids", ids.as_str()), ("filters", "price_overview")]);
    net::get_json::<Value>(net, "https://store.steampowered.com/api/appdetails", &query)
        .map(|v| parse_prices(&v))
        .unwrap_or_default()
}

fn parse_prices(v: &Value) -> HashMap<u64, Price> {
    let mut out = HashMap::new();
    let Some(apps) = v.as_object() else { return out };
    for (id, entry) in apps {
        let Ok(id) = id.parse::<u64>() else { continue };
        let Some(p) = entry.get("data").and_then(|d| d.get("price_overview")) else { continue };
        let text = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let final_formatted = text("final_formatted");
        if final_formatted.is_empty() {
            continue;
        }
        out.insert(
            id,
            Price {
                final_formatted,
                initial_formatted: text("initial_formatted"),
                discount: p.get("discount_percent").and_then(Value::as_u64).unwrap_or(0),
                final_minor: p.get("final").and_then(Value::as_u64).unwrap_or(0),
            },
        );
    }
    out
}

/// "On sale · -40% · 11,99€ (was 19,99€)": prices are Steam's own strings, never formatted here.
fn price_detail(label: &str, price: Option<&Price>, final_minor: u64, discount: u64) -> String {
    match price {
        Some(p) if discount > 0 && !p.initial_formatted.is_empty() => {
            format!("{label} · -{discount}% · {} (was {})", p.final_formatted, p.initial_formatted)
        }
        Some(p) if discount > 0 => format!("{label} · -{discount}% · {}", p.final_formatted),
        Some(p) => format!("{label} · {}", p.final_formatted),
        None if final_minor == 0 => format!("{label} · Free to play"),
        None if discount > 0 => format!("{label} · -{discount}%"),
        None => label.to_string(),
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AppInfo {
    genres: Vec<String>,
    categories: Vec<String>,
    /// Steam's category ids (stable across languages); empty in caches written before they were kept.
    #[serde(default)]
    category_ids: Vec<u32>,
    metacritic: Option<u32>,
}

fn app_cache_path() -> std::path::PathBuf {
    config::data_dir().join("steam_apps.json")
}

fn load_app_cache() -> HashMap<String, AppInfo> {
    fs::read_to_string(app_cache_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_app_cache(cache: &HashMap<String, AppInfo>) {
    let _ = fs::create_dir_all(config::data_dir());
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = fs::write(app_cache_path(), json);
    }
}

/// How a game can be played together, from its Steam store categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Together {
    /// Co-op (online, LAN or split screen): play on the same side.
    Coop,
    /// Multiplayer, but against each other (or an MMO).
    Versus,
    /// Single-player only: owning it together doesn't help.
    Solo,
    Unknown,
}

fn together_of(info: &AppInfo) -> Together {
    // Steam category ids: 9 Co-op, 38 Online Co-op, 48 LAN Co-op, 39 Shared/Split Screen Co-op,
    // 1 Multi-player, 36 Online PvP, 49 PvP, 47 LAN PvP, 20 MMO, 27 Cross-Platform Multiplayer,
    // 24 Shared/Split Screen, 2 Single-player.
    let ids = &info.category_ids;
    let has_id = |list: &[u32]| ids.iter().any(|i| list.contains(i));
    let has_name = |needle: &str| info.categories.iter().any(|c| c.to_lowercase().contains(needle));
    if has_id(&[9, 38, 48, 39]) || has_name("co-op") {
        Together::Coop
    } else if has_id(&[1, 36, 49, 47, 20, 27, 24]) || has_name("multi-player") || has_name("pvp") || has_name("mmo") {
        Together::Versus
    } else if has_id(&[2]) || has_name("single-player") {
        Together::Solo
    } else {
        Together::Unknown
    }
}

/// Co-op / versus / solo for these games, from the cache, fetching at most `max_fetch` missing
/// ones from the store (in parallel, each with the usual timeout). Results are cached for good.
pub fn together_modes(net: &dyn Net, appids: &[u32], max_fetch: usize) -> HashMap<u32, Together> {
    let mut cache = load_app_cache();
    let (modes, changed) = together_modes_in(net, appids, max_fetch, &mut cache);
    if changed {
        save_app_cache(&cache);
    }
    modes
}

/// The same, on a given cache (returns whether it was filled in).
fn together_modes_in(net: &dyn Net, appids: &[u32], max_fetch: usize, cache: &mut HashMap<String, AppInfo>) -> (HashMap<u32, Together>, bool) {
    let missing: Vec<String> = appids
        .iter()
        .map(|a| a.to_string())
        .filter(|a| cache.get(a).map_or(true, |i| i.category_ids.is_empty() && i.categories.is_empty()))
        .take(max_fetch)
        .collect();
    let mut changed = false;
    if !missing.is_empty() {
        let fetched: Vec<(String, AppInfo)> = std::thread::scope(|scope| {
            let handles: Vec<_> = missing
                .iter()
                .map(|id| scope.spawn(move || app_details(net, id, None).ok().map(|info| (id.clone(), info))))
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
        });
        changed = !fetched.is_empty();
        cache.extend(fetched);
    }
    let modes = appids.iter().map(|a| (*a, cache.get(&a.to_string()).map_or(Together::Unknown, together_of))).collect();
    (modes, changed)
}

/// Uses genres to guess session length, energy and whether it's multiplayer.
fn enrich(net: &dyn Net, items: &mut [Suggestion], cc: Option<&str>) {
    let mut cache = load_app_cache();
    let mut fetched = 0;
    for s in items.iter_mut() {
        let appid = s.id.trim_start_matches("steam:").to_string();
        if !cache.contains_key(&appid) {
            if fetched >= MAX_DETAIL_FETCHES {
                continue;
            }
            fetched += 1;
            match app_details(net, &appid, cc) {
                Ok(info) => {
                    cache.insert(appid.clone(), info);
                }
                Err(_) => continue,
            }
        }
        apply(s, &cache[&appid]);
    }
    if fetched > 0 {
        save_app_cache(&cache);
    }
}

fn app_details(net: &dyn Net, appid: &str, cc: Option<&str>) -> Result<AppInfo> {
    let v: Value = net::get_json(
        net,
        "https://store.steampowered.com/api/appdetails",
        &store_query(cc, vec![("appids", appid), ("filters", "genres,categories,metacritic")]),
    )?;
    // `data` is an object, or `[]` when none of the filtered fields exist.
    let data = v.get(appid).and_then(|e| e.get("data"));
    let names = |key: &str| -> Vec<String> {
        data.and_then(|d| d.get(key))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.get("description").and_then(Value::as_str).map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let category_ids = data
        .and_then(|d| d.get("categories"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("id").and_then(Value::as_u64)).map(|x| x as u32).collect())
        .unwrap_or_default();
    Ok(AppInfo {
        genres: names("genres"),
        categories: names("categories"),
        category_ids,
        metacritic: data
            .and_then(|d| d.get("metacritic"))
            .and_then(|m| m.get("score"))
            .and_then(Value::as_u64)
            .map(|x| x as u32),
    })
}

fn apply(s: &mut Suggestion, info: &AppInfo) {
    let has = |list: &[String], needle: &str| list.iter().any(|x| x.to_lowercase().contains(needle));
    let g = &info.genres;
    let profile = if has(g, "massively") {
        Some((Energy::Medium, 60, 240))
    } else if has(g, "strategy") || has(g, "rpg") || has(g, "simulation") {
        Some((Energy::Medium, 45, 180))
    } else if has(g, "action") || has(g, "racing") || has(g, "sports") {
        Some((Energy::High, 20, 90))
    } else if has(g, "casual") {
        Some((Energy::Low, 10, 60))
    } else if has(g, "adventure") {
        Some((Energy::Low, 30, 120))
    } else {
        None
    };
    if let Some((energy, min, max)) = profile {
        s.energy = energy;
        s.min_minutes = if s.has_tag("store") { min.max(STORE_MIN_MINUTES) } else { min };
        s.max_minutes = max.max(s.min_minutes);
    }
    let c = &info.categories;
    if !c.is_empty() {
        let multi = has(c, "multi-player") || has(c, "co-op") || has(c, "pvp");
        s.social = match (multi, has(c, "single-player")) {
            (true, true) => Social::Either,
            (true, false) => Social::Group,
            _ => Social::Solo,
        };
    }
    if let Some(score) = info.metacritic {
        s.quality = (s.quality * 0.5 + score as f64 / 200.0).min(0.95);
        s.detail.push_str(&format!(" · Metacritic {score}"));
    }
    for genre in g.iter().take(3) {
        let tag = genre.to_lowercase();
        if !s.has_tag(&tag) {
            s.tags.push(tag);
        }
    }
}

/// A custom profile name (`steamcommunity.com/id/<name>`) → SteamID64, with the Web API.
/// SteamID64s and `/profiles/<id>` URLs are read locally, without a call.
pub fn resolve_steam_id(net: &dyn Net, key: &str, input: &str) -> Result<String> {
    if let Some(id) = steam_import::parse_steam_id(input) {
        return Ok(id);
    }
    let s = input.trim().trim_end_matches('/');
    let s = s.rsplit('/').next().unwrap_or(s);
    let v: Value = net::get_json(
        net,
        "https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/",
        &[("key", key), ("vanityurl", s)],
    )?;
    v["response"]["steamid"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| anyhow!("Steam couldn't find a profile named '{s}'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::fake::FakeNet;

    const FEATURED: &str = include_str!("../../fixtures/steam_featuredcategories.json");
    const PRICES: &str = include_str!("../../fixtures/steam_prices.json");
    const FEATURED_URL: &str = "https://store.steampowered.com/api/featuredcategories";
    const APPDETAILS_URL: &str = "https://store.steampowered.com/api/appdetails";

    #[test]
    fn how_games_are_played_together() {
        let info = |ids: &[u32], names: &[&str]| AppInfo {
            category_ids: ids.to_vec(),
            categories: names.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        assert_eq!(together_of(&info(&[2, 1, 38], &[])), Together::Coop, "online co-op wins over the rest");
        assert_eq!(together_of(&info(&[2, 1, 36], &[])), Together::Versus);
        assert_eq!(together_of(&info(&[2], &[])), Together::Solo);
        assert_eq!(together_of(&info(&[], &[])), Together::Unknown);
        // Caches from before ids were kept: the English names still work.
        assert_eq!(together_of(&info(&[], &["Single-player", "Online Co-op"])), Together::Coop);
        assert_eq!(together_of(&info(&[], &["Single-player"])), Together::Solo);
    }

    #[test]
    fn modes_come_from_the_store_and_are_cached() {
        let body = r#"{"620":{"success":true,"data":{"categories":[{"id":2,"description":"Single-player"},{"id":9,"description":"Co-op"}]}}}"#;
        let net = FakeNet::new().on(APPDETAILS_URL, body);
        let mut cache = HashMap::new();
        let (modes, changed) = together_modes_in(&net, &[620], 5, &mut cache);
        assert_eq!(modes[&620], Together::Coop);
        assert!(changed && cache.contains_key("620"));
        // Second time: from the cache, no request.
        let offline = FakeNet::new();
        let (again, changed) = together_modes_in(&offline, &[620], 5, &mut cache);
        assert_eq!((again[&620], changed), (Together::Coop, false));
        assert!(offline.calls().is_empty());
    }

    fn detail(items: &[Suggestion], id: &str) -> String {
        items.iter().find(|s| s.id == id).unwrap().detail.clone()
    }

    #[test]
    fn store_prices_are_steams_own_local_strings() {
        let net = FakeNet::new().on(FEATURED_URL, FEATURED).on(APPDETAILS_URL, PRICES);
        let items = store(&net, Some("fr")).unwrap();
        assert_eq!(items.len(), 3, "bundles and duplicates are skipped");
        assert_eq!(detail(&items, "steam:1145360"), "Top seller · 24,50€");
        assert_eq!(detail(&items, "steam:413150"), "On sale · -40% · 8,99€ (was 14,99€)");
        assert_eq!(detail(&items, "steam:730"), "Top seller · Free to play");
        let stardew = items.iter().find(|s| s.id == "steam:413150").unwrap();
        assert_eq!(stardew.cost, Cost::Cheap);
    }

    #[test]
    fn every_store_call_carries_the_country() {
        let net = FakeNet::new().on(FEATURED_URL, FEATURED).on(APPDETAILS_URL, PRICES);
        store(&net, Some("fr")).unwrap();
        let calls = net.calls();
        assert_eq!(calls.len(), 2, "one featured call, one batched price call: {calls:?}");
        for call in calls {
            assert!(call.contains("cc=fr"), "{call}");
        }
    }

    #[test]
    fn unknown_country_lets_steam_decide() {
        let net = FakeNet::new().on(FEATURED_URL, FEATURED).on(APPDETAILS_URL, PRICES);
        store(&net, None).unwrap();
        assert!(net.calls().iter().all(|c| !c.contains("cc=")));
    }

    #[test]
    fn missing_prices_are_left_out_not_formatted_by_hand() {
        let net = FakeNet::new().on(FEATURED_URL, FEATURED).fail(APPDETAILS_URL);
        let items = store(&net, Some("fr")).unwrap();
        assert_eq!(detail(&items, "steam:1145360"), "Top seller");
        assert_eq!(detail(&items, "steam:413150"), "On sale · -40%");
        assert_eq!(detail(&items, "steam:730"), "Top seller · Free to play");
    }
}

#[cfg(test)]
mod library_tests {
    use super::*;

    fn g(appid: u32, name: &str, installed: bool, playtime: u32, two_weeks: u32, last_played: i64) -> LibraryGame {
        LibraryGame { appid, name: name.into(), installed, playtime, playtime_2weeks: two_weeks, last_played }
    }

    fn lib(games: Vec<LibraryGame>, playtime_known: bool) -> Library {
        Library {
            steam_id64: "76561198012345678".into(),
            games,
            imported_at: 1,
            playtime_known,
            from_web_api: false,
        }
    }

    #[test]
    fn without_playtime_installed_games_are_ready_to_play() {
        let l = lib(vec![g(570, "Dota 2", true, 0, 0, 0), g(413150, "Stardew Valley", true, 0, 0, 0)], false);
        let picks = library_picks(&l, 1_000_000_000);
        assert_eq!(picks.len(), 2);
        assert!(picks.iter().all(|s| s.detail == "Installed · ready to play"));
        assert!(picks.iter().all(|s| s.link.as_deref().unwrap().starts_with("steam://rungameid/")));
    }

    #[test]
    fn playtime_gives_comfort_backlog_and_old_favorites() {
        let now = 1_731_100_000;
        let l = lib(
            vec![
                g(570, "Dota 2", true, 4200, 95, now - 86_400),
                g(10, "Counter-Strike", false, 3000, 0, now - 200 * 86_400),
                g(1145360, "Hades", true, 0, 0, 0),
            ],
            true,
        );
        let picks = library_picks(&l, now);
        let detail = |id: &str| picks.iter().find(|s| s.id == id).unwrap().detail.clone();
        assert!(detail("steam:570").starts_with("Comfort pick"));
        assert!(detail("steam:570").ends_with("· Installed"));
        assert!(detail("steam:10").starts_with("Old favorite"));
        assert!(!detail("steam:10").ends_with("· Installed"));
        assert_eq!(detail("steam:1145360"), "Backlog: you own it and never launched it · Installed");
    }

    #[test]
    fn status_reflects_the_import() {
        assert!(!SteamStatus::of(None).imported);
        let l = lib(vec![g(570, "Dota 2", true, 0, 0, 0), g(10, "CS", false, 0, 0, 0)], true);
        let s = SteamStatus::of(Some(&l));
        assert!(s.imported);
        assert_eq!((s.games, s.installed), (2, 1));
        assert_eq!(s.steam_id64.as_deref(), Some("76561198012345678"));
    }
}
