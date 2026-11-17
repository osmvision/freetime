//! YouTube: Data API search (with a key), channel RSS feeds (no key), and search links (offline).

use super::Note;
use crate::{config::{self, Config}, http, model::*};
use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, fs};

/// Each search costs 100 of the 10,000 free daily quota units, so results are reused for a while.
const CACHE_SECS: i64 = 6 * 3600;
const MAX_INTERESTS: usize = 5;

pub fn suggestions(agent: &ureq::Agent, cfg: &Config, notes: &mut Vec<Note>) -> Vec<Suggestion> {
    let mut out = Vec::new();
    if let Some(key) = cfg.youtube_key() {
        match api_cached(agent, &key, &cfg.interests) {
            Ok(v) => out.extend(v),
            Err(e) => notes.push(Note::problem(format!("YouTube API unavailable ({e})."))),
        }
    }
    if !cfg.youtube.channels.is_empty() {
        let (v, failed) = channels(agent, &cfg.youtube.channels);
        out.extend(v);
        if failed > 0 {
            notes.push(Note::problem(format!(
                "YouTube: {failed} channel feed(s) failed. Check the channel IDs."
            )));
        }
    }
    if cfg.youtube_key().is_none() && cfg.youtube.channels.is_empty() {
        notes.push(Note::tip("Add a YouTube API key or channels you follow to get real video picks."));
    }
    out
}

fn thumbnail(id: &str) -> Option<String> {
    Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"))
}

#[derive(Serialize, Deserialize)]
struct Cache {
    ts: i64,
    interests: Vec<String>,
    items: Vec<Suggestion>,
}

fn api_cached(agent: &ureq::Agent, key: &str, interests: &[String]) -> Result<Vec<Suggestion>> {
    let path = config::data_dir().join("youtube_cache.json");
    let now = Utc::now().timestamp();
    let cached: Option<Cache> = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok());
    if let Some(c) = cached {
        if c.interests == interests && now - c.ts < CACHE_SECS {
            return Ok(c.items);
        }
    }
    let items = api(agent, key, interests)?;
    let _ = fs::create_dir_all(config::data_dir());
    let cache = Cache { ts: now, interests: interests.to_vec(), items: items.clone() };
    if let Ok(json) = serde_json::to_string(&cache) {
        let _ = fs::write(&path, json);
    }
    Ok(items)
}

fn api(agent: &ureq::Agent, key: &str, interests: &[String]) -> Result<Vec<Suggestion>> {
    let after = (Utc::now() - chrono::Duration::days(365)).to_rfc3339_opts(SecondsFormat::Secs, true);
    // (video id, title, channel, interest)
    let mut found: Vec<(String, String, String, String)> = Vec::new();
    for interest in interests.iter().take(MAX_INTERESTS) {
        let v: Value = http::get_json(
            agent,
            "https://www.googleapis.com/youtube/v3/search",
            &[
                ("part", "snippet"),
                ("type", "video"),
                ("maxResults", "6"),
                ("order", "relevance"),
                ("q", interest),
                ("publishedAfter", &after),
                ("key", key),
            ],
        )?;
        for it in v["items"].as_array().into_iter().flatten() {
            let Some(id) = it["id"]["videoId"].as_str() else { continue };
            if found.iter().any(|f| f.0 == id) {
                continue;
            }
            found.push((
                id.to_string(),
                unescape(it["snippet"]["title"].as_str().unwrap_or("")),
                unescape(it["snippet"]["channelTitle"].as_str().unwrap_or("")),
                interest.clone(),
            ));
        }
    }
    if found.is_empty() {
        return Ok(Vec::new());
    }

    let ids = found.iter().map(|f| f.0.as_str()).collect::<Vec<_>>().join(",");
    let v: Value = http::get_json(
        agent,
        "https://www.googleapis.com/youtube/v3/videos",
        &[("part", "contentDetails,statistics"), ("id", &ids), ("key", key)],
    )?;
    let num = |x: &Value| x.as_str().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let mut stats: HashMap<String, (u32, u64, u64)> = HashMap::new();
    for it in v["items"].as_array().into_iter().flatten() {
        let Some(id) = it["id"].as_str() else { continue };
        let secs = it["contentDetails"]["duration"].as_str().and_then(parse_iso_duration).unwrap_or(0);
        stats.insert(id.to_string(), (secs, num(&it["statistics"]["viewCount"]), num(&it["statistics"]["likeCount"])));
    }

    Ok(found
        .into_iter()
        .filter_map(|(id, title, channel, interest)| {
            let &(secs, views, likes) = stats.get(&id)?;
            if secs < 120 {
                return None; // Shorts and live streams
            }
            let minutes = secs.div_ceil(60);
            Some(Suggestion {
                id: format!("yt:{id}"),
                category: Category::Video,
                title,
                detail: format!("{channel} · {} views · for “{interest}”", compact(views)),
                link: Some(format!("https://youtu.be/{id}")),
                image: thumbnail(&id),
                min_minutes: minutes,
                max_minutes: minutes + 5,
                energy: Energy::Low,
                outdoor: false,
                social: Social::Either,
                cost: Cost::Free,
                quality: video_quality(views, likes),
                tags: vec!["youtube".into(), interest.to_lowercase()],
            })
        })
        .collect())
}

fn video_quality(views: u64, likes: u64) -> f64 {
    let reach = 0.3 + 0.07 * ((views.max(1)) as f64).log10();
    let love = if views > 0 { (likes as f64 / views as f64 * 3.0).min(0.15) } else { 0.0 };
    (reach + love).min(0.95)
}

fn channels(agent: &ureq::Agent, ids: &[String]) -> (Vec<Suggestion>, usize) {
    let now = Utc::now();
    std::thread::scope(|s| {
        let handles: Vec<_> = ids
            .iter()
            .take(10)
            .map(|id| {
                s.spawn(move || {
                    let url = format!(
                        "https://www.youtube.com/feeds/videos.xml?channel_id={}",
                        http::url_encode(id.trim())
                    );
                    http::get_text(agent, &url).map(|xml| parse_feed(&xml, now))
                })
            })
            .collect();
        let mut out = Vec::new();
        let mut failed = 0;
        for h in handles {
            match h.join() {
                Ok(Ok(items)) => out.extend(items.into_iter().take(3)),
                _ => failed += 1,
            }
        }
        (out, failed)
    })
}

fn between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = s.find(start)? + start.len();
    let len = s[from..].find(end)?;
    Some(&s[from..from + len])
}

fn parse_feed(xml: &str, now: DateTime<Utc>) -> Vec<Suggestion> {
    xml.split("<entry>")
        .skip(1)
        .filter_map(|entry| {
            if entry.contains("/shorts/") {
                return None;
            }
            let id = between(entry, "<yt:videoId>", "</yt:videoId>")?;
            let title = unescape(between(entry, "<title>", "</title>")?);
            let channel = between(entry, "<name>", "</name>").map(unescape).unwrap_or_default();
            let published = DateTime::parse_from_rfc3339(between(entry, "<published>", "</published>")?).ok()?;
            let age_days = (now - published.with_timezone(&Utc)).num_days().max(0);
            if age_days > 45 {
                return None;
            }
            let views = between(entry, "<media:statistics views=\"", "\"")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            let freshness = match age_days {
                0..=3 => 0.2,
                4..=10 => 0.1,
                _ => 0.0,
            };
            let when = match age_days {
                0 => "today".to_string(),
                1 => "yesterday".to_string(),
                d => format!("{d} days ago"),
            };
            Some(Suggestion {
                id: format!("yt:{id}"),
                category: Category::Video,
                title,
                detail: format!("New from {channel} · {when} · {} views", compact(views)),
                link: Some(format!("https://youtu.be/{id}")),
                image: thumbnail(id),
                min_minutes: 5,
                max_minutes: 40,
                energy: Energy::Low,
                outdoor: false,
                social: Social::Either,
                cost: Cost::Free,
                quality: (0.55 + freshness + 0.02 * (views.max(1) as f64).log10()).min(0.95),
                tags: vec!["youtube".into(), "subscriptions".into()],
            })
        })
        .collect()
}

/// Works offline: a YouTube search per interest, pre-filtered to a length that fits.
pub fn search_links(cfg: &Config, minutes: u32) -> Vec<Suggestion> {
    let (sp, label) = if minutes < 12 {
        ("EgIYAQ%253D%253D", "under 4 min")
    } else if minutes <= 30 {
        ("EgIYAw%253D%253D", "4–20 min")
    } else {
        ("EgIYAg%253D%253D", "20+ min")
    };
    cfg.interests
        .iter()
        .filter(|i| !i.trim().is_empty())
        .map(|i| Suggestion {
            id: format!("ytsearch:{}", i.to_lowercase()),
            category: Category::Video,
            title: format!("Browse YouTube for “{i}”"),
            detail: format!("Opens a search filtered to {label} videos"),
            link: Some(format!(
                "https://www.youtube.com/results?search_query={}&sp={sp}",
                http::url_encode(i)
            )),
            image: None,
            min_minutes: 1,
            max_minutes: 600,
            energy: Energy::Low,
            outdoor: false,
            social: Social::Either,
            cost: Cost::Free,
            quality: 0.3,
            tags: vec!["youtube".into(), i.to_lowercase()],
        })
        .collect()
}

/// `PT1H2M3S` → 3723 seconds.
pub fn parse_iso_duration(s: &str) -> Option<u32> {
    let rest = s.strip_prefix('P')?;
    let (date, time) = rest.split_once('T').unwrap_or((rest, ""));
    let mut secs = 0u32;
    let mut num = String::new();
    for (part, is_time) in [(date, false), (time, true)] {
        for c in part.chars() {
            if c.is_ascii_digit() {
                num.push(c);
                continue;
            }
            let n: u32 = num.parse().ok()?;
            num.clear();
            secs += match (c, is_time) {
                ('W', false) => n * 7 * 86_400,
                ('D', false) => n * 86_400,
                ('H', true) => n * 3600,
                ('M', true) => n * 60,
                ('S', true) => n,
                _ => 0,
            };
        }
    }
    Some(secs)
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn compact(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => format!("{:.0}k", n as f64 / 1e3),
        _ => format!("{:.1}M", n as f64 / 1e6),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_iso_duration("PT1H2M3S"), Some(3723));
        assert_eq!(parse_iso_duration("PT12M"), Some(720));
        assert_eq!(parse_iso_duration("P0D"), Some(0));
        assert_eq!(parse_iso_duration("nope"), None);
    }

    #[test]
    fn reads_channel_feed() {
        let now = DateTime::parse_from_rfc3339("2026-11-17T12:00:00+00:00").unwrap().with_timezone(&Utc);
        let xml = r#"<feed><title>Chan</title>
<entry><yt:videoId>abc123</yt:videoId><title>Rust &amp; you</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/>
<author><name>Chan</name></author><published>2026-11-15T10:00:00+00:00</published>
<media:statistics views="12345"/></entry>
<entry><yt:videoId>short1</yt:videoId><title>A short</title>
<link rel="alternate" href="https://www.youtube.com/shorts/short1"/>
<published>2026-11-16T10:00:00+00:00</published></entry>
<entry><yt:videoId>old</yt:videoId><title>Old</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=old"/>
<published>2025-01-01T10:00:00+00:00</published></entry></feed>"#;
        let items = parse_feed(xml, now);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Rust & you");
        assert_eq!(items[0].id, "yt:abc123");
        assert!(items[0].detail.contains("2 days ago"));
    }
}
