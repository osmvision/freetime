//! Steam: your own library (with a Web API key) and the public store front.

use super::Note;
use crate::{config::{self, Config}, location::Location, model::*, net::{self, Net}};
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

pub fn suggestions(net: &dyn Net, cfg: &Config, loc: &Location, notes: &mut Vec<Note>) -> Vec<Suggestion> {
    let mut items = Vec::new();
    let steam_id = cfg.steam.steam_id.as_deref().filter(|s| !s.trim().is_empty());
    match (cfg.steam_key(), steam_id) {
        (Some(key), Some(id)) => match library(net, &key, id) {
            Ok(v) if v.is_empty() => notes.push(Note::problem(
                "Steam returned no games: set your Steam profile's Privacy → Game details to Public.",
            )),
            Ok(v) => items = v,
            Err(e) => notes.push(Note::problem(format!("Steam library unavailable ({e})."))),
        },
        _ => notes.push(Note::tip("Connect your Steam library to get picks from games you already own.")),
    }
    match store(net, loc.steam_cc().as_deref()) {
        Ok(v) => {
            let owned: HashSet<String> = items.iter().map(|s| s.id.clone()).collect();
            items.extend(v.into_iter().filter(|s| !owned.contains(&s.id)));
        }
        Err(e) => notes.push(Note::problem(format!("Steam store unavailable ({e})."))),
    }
    enrich(net, &mut items);
    items
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

fn owned(g: &OwnedGame, detail: String, quality: f64, tag: &str) -> Suggestion {
    Suggestion {
        id: format!("steam:{}", g.appid),
        category: Category::Game,
        title: g.name.clone(),
        detail,
        // Launches the game straight from Steam.
        link: Some(format!("steam://rungameid/{}", g.appid)),
        image: Some(format!("https://cdn.akamai.steamstatic.com/steam/apps/{}/header.jpg", g.appid)),
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

fn library(net: &dyn Net, key: &str, steam_id: &str) -> Result<Vec<Suggestion>> {
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
    let now = chrono::Utc::now().timestamp();
    let games: Vec<OwnedGame> = resp.response.games.into_iter().filter(|g| !g.name.is_empty()).collect();
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
    Ok(out)
}

fn store(net: &dyn Net, cc: Option<&str>) -> Result<Vec<Suggestion>> {
    let mut query = vec![("l", "english")];
    if let Some(cc) = cc {
        query.push(("cc", cc));
    }
    let v: Value = net::get_json(
        net,
        "https://store.steampowered.com/api/featuredcategories",
        &query,
    )?;
    let mut out = Vec::new();
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
            let final_price = it.get("final_price").and_then(Value::as_u64).unwrap_or(0);
            let discount = it.get("discount_percent").and_then(Value::as_u64).unwrap_or(0);
            let currency = it.get("currency").and_then(Value::as_str).unwrap_or("");
            let price = if final_price == 0 {
                "free to play".to_string()
            } else {
                format!("{:.2} {currency}", final_price as f64 / 100.0)
            };
            let detail = if discount > 0 {
                format!("{label} · -{discount}% → {price}")
            } else {
                format!("{label} · {price}")
            };
            let quality = match key {
                "top_sellers" => 0.58,
                _ => (0.45 + discount as f64 / 300.0).min(0.75),
            };
            out.push(Suggestion {
                id: format!("steam:{id}"),
                category: Category::Game,
                title: name.to_string(),
                detail,
                link: Some(format!("https://store.steampowered.com/app/{id}")),
                image: it.get("header_image").and_then(Value::as_str).map(String::from),
                min_minutes: STORE_MIN_MINUTES,
                max_minutes: 180,
                energy: Energy::Medium,
                outdoor: false,
                social: Social::Either,
                cost: match final_price {
                    0 => Cost::Free,
                    1..=1500 => Cost::Cheap,
                    _ => Cost::Paid,
                },
                quality,
                tags: vec!["steam".into(), "store".into(), key.into()],
            });
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AppInfo {
    genres: Vec<String>,
    categories: Vec<String>,
    metacritic: Option<u32>,
}

/// Uses genres to guess session length, energy and whether it's multiplayer.
fn enrich(net: &dyn Net, items: &mut [Suggestion]) {
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
            match app_details(net, &appid) {
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

fn app_details(net: &dyn Net, appid: &str) -> Result<AppInfo> {
    let v: Value = net::get_json(
        net,
        "https://store.steampowered.com/api/appdetails",
        &[("appids", appid), ("filters", "genres,categories,metacritic")],
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
