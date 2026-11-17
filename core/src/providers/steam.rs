//! Steam: the client on this PC (account and installed games, no key needed), the owned-games
//! list (with a Web API key) and the public store front.

use super::{
    steam_local::{self, Account, InstalledGame, LocalSteam},
    Note,
};
use crate::{config::{self, Config}, keys::Keys, location::Location, model::*, net::{self, Net}};
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
    /// The Steam client is installed on this PC.
    pub found: bool,
    /// The account that logged in last on this PC.
    pub account: Option<Account>,
    pub installed: usize,
    /// Games on the account, when a Web API key could list them.
    pub owned: Option<usize>,
}

pub fn suggestions(
    net: &dyn Net,
    cfg: &Config,
    keys: &Keys,
    loc: &Location,
    notes: &mut Vec<Note>,
) -> (Vec<Suggestion>, SteamStatus) {
    let local = steam_local::detect();
    let (mut items, status) = library(net, cfg, keys, &local, notes);
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

/// Games you can play: owned games when a key can list them, merged with what's installed.
/// Without a key (or with private game details), the installed games stand in for the library.
fn library(
    net: &dyn Net,
    cfg: &Config,
    keys: &Keys,
    local: &LocalSteam,
    notes: &mut Vec<Note>,
) -> (Vec<Suggestion>, SteamStatus) {
    let mut status = SteamStatus {
        found: local.root.is_some(),
        account: local.account.clone(),
        installed: local.installed.len(),
        owned: None,
    };
    let steam_id = cfg
        .steam
        .steam_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| local.account.as_ref().map(|a| a.steam_id64.clone()));
    if let (Some(key), Some(id)) = (&keys.steam, steam_id) {
        match owned_games(net, key.value(), &id) {
            Ok(games) if games.is_empty() => notes.push(Note::problem(
                "Your Steam game details are private, so only installed games are suggested (Steam: Profile → Privacy).",
            )),
            Ok(games) => {
                status.owned = Some(games.len());
                let now = chrono::Utc::now().timestamp();
                return (owned_picks(&games, &local.installed, now), status);
            }
            Err(e) => notes.push(Note::problem(format!("Steam library unavailable ({e})."))),
        }
    }
    (installed_picks(&local.installed, &HashSet::new(), 10), status)
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

#[derive(Deserialize)]
struct OwnedGame {
    appid: u32,
    #[serde(default)]
    name: String,
    #[serde(default)]
    playtime_forever: u32,
    #[serde(default)]
    playtime_2weeks: u32,
    #[serde(default)]
    rtime_last_played: i64,
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

/// Installed games: no download, ready the moment you sit down.
fn installed_picks(installed: &[InstalledGame], skip: &HashSet<u32>, count: usize) -> Vec<Suggestion> {
    let mut pool: Vec<&InstalledGame> = installed.iter().filter(|g| !skip.contains(&g.appid)).collect();
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

fn owned_games(net: &dyn Net, key: &str, steam_id: &str) -> Result<Vec<OwnedGame>> {
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

/// Comfort picks, old favorites and the backlog from the owned list. Installed games get a
/// small boost (no download), and a few more installed games fill in.
fn owned_picks(games: &[OwnedGame], installed: &[InstalledGame], now: i64) -> Vec<Suggestion> {
    let is_installed: HashSet<u32> = installed.iter().map(|g| g.appid).collect();
    let owned = |g: &OwnedGame, detail: String, quality: f64, tag: &str| {
        let mut s = game(g.appid, &g.name, detail, quality, tag);
        if is_installed.contains(&g.appid) {
            s.detail.push_str(" · Installed");
            s.quality = (s.quality + 0.05).min(0.95);
            s.tags.push("installed".into());
        }
        s
    };
    let mut out = Vec::new();

    let mut recent: Vec<&OwnedGame> = games.iter().filter(|g| g.playtime_2weeks > 0).collect();
    recent.sort_by_key(|g| Reverse(g.playtime_2weeks));
    for g in recent.iter().take(4) {
        let d = format!("Comfort pick: {} played in the last 2 weeks", fmt_minutes(g.playtime_2weeks));
        out.push(owned(g, d, 0.6, "comfort"));
    }

    let mut old: Vec<&OwnedGame> = games
        .iter()
        .filter(|g| {
            g.playtime_forever >= 600
                && g.playtime_2weeks == 0
                && g.rtime_last_played > 0
                && now - g.rtime_last_played > 90 * 86_400
        })
        .collect();
    old.sort_by_key(|g| Reverse(g.playtime_forever));
    for g in old.iter().take(4) {
        let months = (now - g.rtime_last_played) / (30 * 86_400);
        let d = format!(
            "Old favorite: {}h played, last launched {months} months ago",
            g.playtime_forever / 60
        );
        out.push(owned(g, d, 0.7, "rediscover"));
    }

    let mut backlog: Vec<&OwnedGame> = games.iter().filter(|g| g.playtime_forever < 60).collect();
    backlog.shuffle(&mut rand::thread_rng());
    for g in backlog.iter().take(6) {
        let d = if g.playtime_forever == 0 {
            "Backlog: you own it and never launched it".to_string()
        } else {
            format!("Backlog: you own it but only played {}", fmt_minutes(g.playtime_forever))
        };
        out.push(owned(g, d, 0.72, "backlog"));
    }

    let mut seen = HashSet::new();
    out.retain(|s| seen.insert(s.id.clone()));
    let chosen: HashSet<u32> = out.iter().filter_map(|s| s.id.strip_prefix("steam:")?.parse().ok()).collect();
    out.extend(installed_picks(installed, &chosen, 4));
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

fn store(net: &dyn Net, cc: Option<&str>) -> Result<Vec<Suggestion>> {
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
    metacritic: Option<u32>,
}

/// Uses genres to guess session length, energy and whether it's multiplayer.
fn enrich(net: &dyn Net, items: &mut [Suggestion], cc: Option<&str>) {
    let path = config::data_dir().join("steam_apps.json");
    let mut cache: HashMap<String, AppInfo> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
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
        let _ = fs::create_dir_all(config::data_dir());
        if let Ok(json) = serde_json::to_string(&cache) {
            let _ = fs::write(&path, json);
        }
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
    Ok(AppInfo {
        genres: names("genres"),
        categories: names("categories"),
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

/// Accepts a SteamID64, a profile URL, or a custom URL name.
pub fn resolve_steam_id(net: &dyn Net, key: &str, input: &str) -> Result<String> {
    let s = input.trim().trim_end_matches('/');
    let s = s.rsplit('/').next().unwrap_or(s);
    if s.len() == 17 && s.chars().all(|c| c.is_ascii_digit()) {
        return Ok(s.to_string());
    }
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
    use crate::{
        keys::{Key, KeySource},
        net::fake::FakeNet,
    };
    use std::path::PathBuf;

    const OWNED_URL: &str = "https://api.steampowered.com/IPlayerService/GetOwnedGames";

    fn local_with(installed: &[(u32, &str)]) -> LocalSteam {
        LocalSteam {
            root: Some(PathBuf::from("C:/Steam")),
            account: Some(Account { steam_id64: "76561198012345678".into(), persona_name: "Player".into() }),
            installed: installed.iter().map(|(id, n)| InstalledGame { appid: *id, name: n.to_string() }).collect(),
        }
    }

    fn key() -> Keys {
        Keys { steam: Some(Key::new("secret", KeySource::Environment)), youtube: None }
    }

    #[test]
    fn without_a_key_installed_games_are_the_library() {
        let net = FakeNet::new();
        let mut notes = Vec::new();
        let local = local_with(&[(570, "Dota 2"), (413150, "Stardew Valley")]);
        let (items, status) = library(&net, &Config::default(), &Keys::default(), &local, &mut notes);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|s| s.detail == "Installed · ready to play"));
        assert!(items.iter().all(|s| s.link.as_deref().unwrap().starts_with("steam://rungameid/")));
        assert!(status.found);
        assert_eq!(status.installed, 2);
        assert_eq!(status.owned, None);
        assert_eq!(status.account.unwrap().persona_name, "Player");
        assert!(net.calls().is_empty(), "no key, no Web API call");
        assert!(notes.is_empty());
    }

    #[test]
    fn with_a_key_owned_games_use_the_detected_account() {
        let owned = r#"{"response":{"game_count":2,"games":[
            {"appid":570,"name":"Dota 2","playtime_forever":30,"playtime_2weeks":0},
            {"appid":1145360,"name":"Hades","playtime_forever":0}]}}"#;
        let net = FakeNet::new().on(OWNED_URL, owned);
        let (items, status) = library(&net, &Config::default(), &key(), &local_with(&[(570, "Dota 2")]), &mut Vec::new());
        assert_eq!(status.owned, Some(2));
        assert!(net.calls()[0].contains("steamid=76561198012345678"));
        assert!(net.calls()[0].contains("include_appinfo=1"));
        assert!(net.calls()[0].contains("include_played_free_games=1"));
        let dota = items.iter().find(|s| s.id == "steam:570").unwrap();
        assert!(dota.detail.ends_with("· Installed"), "{}", dota.detail);
        assert!(items.iter().any(|s| s.id == "steam:1145360"));
    }

    #[test]
    fn a_typed_steam_id_overrides_the_detected_one() {
        let net = FakeNet::new().on(OWNED_URL, r#"{"response":{"games":[{"appid":10,"name":"CS"}]}}"#);
        let mut cfg = Config::default();
        cfg.steam.steam_id = Some("76561197960287930".into());
        library(&net, &cfg, &key(), &local_with(&[]), &mut Vec::new());
        assert!(net.calls()[0].contains("steamid=76561197960287930"));
    }

    #[test]
    fn private_profile_keeps_installed_games_with_a_hint() {
        let net = FakeNet::new().on(OWNED_URL, r#"{"response":{}}"#);
        let mut notes = Vec::new();
        let (items, status) = library(&net, &Config::default(), &key(), &local_with(&[(570, "Dota 2")]), &mut notes);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].detail, "Installed · ready to play");
        assert_eq!(status.owned, None);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].text.contains("private"));
    }
}
