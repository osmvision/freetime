//! YouTube, best source first:
//! 1. a search on your interests (videos that fit your time): through freetime's search proxy
//!    (the `youtube-search` Edge Function, which holds the key), or straight to the Data API
//!    with your own YOUTUBE_API_KEY if you set one,
//! 2. the latest uploads of channels picked per idea category (public RSS feeds, no key),
//! 3. offline: search links, as a last resort (see `crate::candidates`).

use super::Note;
use crate::{config::{self, Config}, keys::Keys, model::*, net::{self, Net}};
use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, fs};

/// Each API search costs 100 of the 10,000 free daily quota units, so results are reused for a while.
const API_CACHE_SECS: i64 = 6 * 3600;
const MAX_INTERESTS: usize = 5;
/// Channel feeds are re-read at most this often.
const FEED_CACHE_SECS: i64 = 2 * 3600;
/// Older uploads aren't "new" anymore.
const MAX_VIDEO_AGE_SECS: i64 = 365 * 86_400;
const DEFAULT_CHANNELS: &str = include_str!("../../data/youtube_channels.toml");

pub fn suggestions(net: &dyn Net, cfg: &Config, keys: &Keys, notes: &mut Vec<Note>) -> Vec<Suggestion> {
    let mut out = Vec::new();
    let own_key = keys.youtube.as_ref().map(|k| k.value());
    match search_cached(net, own_key, &cfg.interests) {
        Ok(v) => out.extend(v),
        Err(e) if own_key.is_some() => notes.push(Note::problem(format!("YouTube API unavailable ({e})."))),
        // The shared search is a bonus (it may be out of quota for today): the channel feeds still fill in.
        Err(_) => {}
    }

    let mut channels = channel_config();
    let extra: Vec<String> = cfg.youtube.channels.iter().map(|c| c.trim().to_string()).filter(|c| is_channel_id(c)).collect();
    if !extra.is_empty() {
        channels.push((Category::Video, extra.clone()));
    }
    let ids: Vec<String> = channels.iter().flat_map(|(_, ids)| ids.iter().cloned()).collect();
    let now = Utc::now().timestamp();
    let (feeds, failed) = cached_feeds(net, &ids, now);
    out.extend(video_picks(&channels, &feeds, now));

    let failed_extra = extra.iter().filter(|id| failed.contains(id)).count();
    if failed_extra > 0 {
        notes.push(Note::problem(format!(
            "YouTube: {failed_extra} of your channel feeds couldn't be read. Check the channel IDs."
        )));
    }
    out
}

fn thumbnail(id: &str) -> Option<String> {
    Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"))
}

// ---------------------------------------------------------------- channels (no key)

/// A channel ID: "UC" + 22 characters.
pub fn is_channel_id(s: &str) -> bool {
    s.len() == 24 && s.starts_with("UC") && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The user's copy of `youtube_channels.toml` (created from the bundled one on first run).
pub fn channels_path() -> std::path::PathBuf {
    config::config_dir().join("youtube_channels.toml")
}

fn channel_config() -> Vec<(Category, Vec<String>)> {
    let path = channels_path();
    if !path.exists() {
        let _ = fs::create_dir_all(config::config_dir());
        let _ = fs::write(&path, DEFAULT_CHANNELS);
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|text| parse_channels(&text))
        .or_else(|| parse_channels(DEFAULT_CHANNELS))
        .unwrap_or_default()
}

/// `category = ["UC…", …]` per line; unknown categories and malformed IDs are skipped.
pub fn parse_channels(text: &str) -> Option<Vec<(Category, Vec<String>)>> {
    let table: toml::Table = toml::from_str(text).ok()?;
    let mut out = Vec::new();
    for (key, value) in table {
        let Some(category) = Category::from_id(&key) else { continue };
        let Some(list) = value.as_array() else { continue };
        let ids: Vec<String> = list
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| is_channel_id(s))
            .collect();
        out.push((category, ids));
    }
    Some(out)
}

/// One upload from a channel's feed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FeedVideo {
    pub id: String,
    pub title: String,
    pub channel: String,
    /// Unix time.
    pub published: i64,
    pub views: u64,
    pub short: bool,
}

/// Parses a channel's Atom feed (`youtube.com/feeds/videos.xml?channel_id=…`).
pub fn parse_feed(xml: &str) -> Result<Vec<FeedVideo>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut out = Vec::new();
    let mut current: Option<FeedVideo> = None;
    let mut path: Vec<Vec<u8>> = Vec::new();
    loop {
        match reader.read_event()? {
            Event::Start(e) => {
                if e.name().as_ref() == b"entry" {
                    current = Some(FeedVideo::default());
                }
                if let Some(video) = current.as_mut() {
                    read_attributes(&e, video);
                }
                path.push(e.name().as_ref().to_vec());
            }
            Event::Empty(e) => {
                if let Some(video) = current.as_mut() {
                    read_attributes(&e, video);
                }
            }
            Event::Text(t) => {
                let (Some(video), Some(element)) = (current.as_mut(), path.last()) else { continue };
                let parent = path.len().checked_sub(2).map(|i| path[i].as_slice());
                let text = t.unescape()?.into_owned();
                match element.as_slice() {
                    b"yt:videoId" => video.id = text,
                    // entry/title, not media:group/media:title
                    b"title" if parent == Some(b"entry") => video.title = text,
                    b"name" if parent == Some(b"author") => video.channel = text,
                    b"published" if parent == Some(b"entry") => {
                        video.published = DateTime::parse_from_rfc3339(&text).map(|d| d.timestamp()).unwrap_or(0)
                    }
                    _ => {}
                }
            }
            Event::End(e) => {
                if e.name().as_ref() == b"entry" {
                    if let Some(video) = current.take().filter(|v| !v.id.is_empty() && !v.title.is_empty()) {
                        out.push(video);
                    }
                }
                path.pop();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}

fn read_attributes(e: &BytesStart, video: &mut FeedVideo) {
    let attr = |key: &[u8]| {
        e.attributes()
            .flatten()
            .find(|a| a.key.as_ref() == key)
            .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
    };
    match e.name().as_ref() {
        b"link" if attr(b"rel").as_deref() == Some("alternate") => {
            video.short |= attr(b"href").is_some_and(|h| h.contains("/shorts/"));
        }
        b"media:statistics" => video.views = attr(b"views").and_then(|v| v.parse().ok()).unwrap_or(0),
        _ => {}
    }
}

/// Fetches feeds concurrently (8 at a time). Returns what was read, and the IDs that failed.
fn fetch_feeds(net: &dyn Net, ids: &[String]) -> (HashMap<String, Vec<FeedVideo>>, Vec<String>) {
    let mut feeds = HashMap::new();
    let mut failed = Vec::new();
    for batch in ids.chunks(8) {
        let results: Vec<(String, Result<Vec<FeedVideo>>)> = std::thread::scope(|s| {
            let handles: Vec<_> = batch
                .iter()
                .map(|id| {
                    s.spawn(move || {
                        let xml = net.get_text("https://www.youtube.com/feeds/videos.xml", &[("channel_id", id)]);
                        (id.clone(), xml.and_then(|x| parse_feed(&x)))
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        for (id, result) in results {
            match result {
                Ok(videos) => {
                    feeds.insert(id, videos);
                }
                Err(_) => failed.push(id),
            }
        }
    }
    (feeds, failed)
}

#[derive(Default, Serialize, Deserialize)]
struct FeedCache {
    feeds: HashMap<String, (i64, Vec<FeedVideo>)>,
}

/// Feeds read in the last two hours come from disk; the rest from the network.
/// A feed that fails keeps its last copy.
fn cached_feeds(net: &dyn Net, ids: &[String], now: i64) -> (HashMap<String, Vec<FeedVideo>>, Vec<String>) {
    let path = config::data_dir().join("youtube_feeds.json");
    let mut cache: FeedCache = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let stale: Vec<String> = ids
        .iter()
        .filter(|id| !cache.feeds.get(*id).is_some_and(|(at, _)| (0..FEED_CACHE_SECS).contains(&(now - at))))
        .cloned()
        .collect();
    let (fresh, failed) = fetch_feeds(net, &stale);
    if !fresh.is_empty() {
        for (id, videos) in fresh {
            cache.feeds.insert(id, (now, videos));
        }
        let _ = fs::create_dir_all(config::data_dir());
        if let Ok(json) = serde_json::to_string(&cache) {
            let _ = fs::write(&path, json);
        }
    }
    let feeds = ids.iter().filter_map(|id| Some((id.clone(), cache.feeds.get(id)?.1.clone()))).collect();
    (feeds, failed)
}

/// The newest real uploads (no Shorts) of each channel, in the category its channel belongs to.
pub fn video_picks(
    channels: &[(Category, Vec<String>)],
    feeds: &HashMap<String, Vec<FeedVideo>>,
    now: i64,
) -> Vec<Suggestion> {
    let mut out: Vec<Suggestion> = Vec::new();
    for (category, ids) in channels {
        let per_channel = if matches!(category, Category::Video | Category::Learn) { 2 } else { 1 };
        for id in ids {
            let Some(videos) = feeds.get(id) else { continue };
            let fresh = videos.iter().filter(|v| !v.short && v.published > 0 && now - v.published <= MAX_VIDEO_AGE_SECS);
            for v in fresh.take(per_channel) {
                if !out.iter().any(|s| s.id == format!("yt:{}", v.id)) {
                    out.push(channel_video(v, *category, now));
                }
            }
        }
    }
    out
}

fn channel_video(v: &FeedVideo, category: Category, now: i64) -> Suggestion {
    let age_days = ((now - v.published) / 86_400).max(0);
    let when = match age_days {
        0 => "today".to_string(),
        1 => "yesterday".to_string(),
        d if d < 30 => format!("{d} days ago"),
        d if d < 60 => "last month".to_string(),
        d => format!("{} months ago", d / 30),
    };
    let freshness = match age_days {
        0..=3 => 0.2,
        4..=10 => 0.12,
        11..=30 => 0.06,
        _ => 0.0,
    };
    // Follow-along videos for doing things; plain watching otherwise.
    let (energy, min, max) = match category {
        Category::Sport => (Energy::High, 10, 45),
        Category::Learn | Category::Create => (Energy::Medium, 10, 40),
        Category::Food => (Energy::Medium, 10, 30),
        Category::Chill => (Energy::Low, 15, 120),
        _ => (Energy::Low, 8, 30),
    };
    Suggestion {
        id: format!("yt:{}", v.id),
        category,
        title: v.title.clone(),
        detail: format!("{} · {when} · YouTube", v.channel),
        link: Some(format!("https://youtu.be/{}", v.id)),
        image: thumbnail(&v.id),
        min_minutes: min,
        max_minutes: max,
        energy,
        outdoor: false,
        social: Social::Either,
        cost: Cost::Free,
        quality: (0.5 + freshness + 0.02 * (v.views.max(1) as f64).log10()).min(0.9),
        tags: vec!["youtube".into(), "channel".into(), category.id().into()],
    }
}

// ---------------------------------------------------------------- search on your interests

/// freetime's search proxy: one topic per call, results shared by everyone (see
/// `supabase/functions/youtube-search`).
pub fn proxy_url() -> String {
    format!("{}/functions/v1/youtube-search", crate::account::PROJECT_URL)
}

/// A search result, before it becomes a suggestion. Also the proxy's reply format.
#[derive(Debug, Clone, PartialEq, Deserialize)]
struct Found {
    id: String,
    title: String,
    channel: String,
    seconds: u32,
    views: u64,
    likes: u64,
}

#[derive(Serialize, Deserialize)]
struct ApiCache {
    ts: i64,
    interests: Vec<String>,
    /// Results from your own key or from the proxy: switching source starts over.
    #[serde(default)]
    own_key: bool,
    items: Vec<Suggestion>,
}

fn search_cached(net: &dyn Net, own_key: Option<&str>, interests: &[String]) -> Result<Vec<Suggestion>> {
    let path = config::data_dir().join("youtube_cache.json");
    let now = Utc::now().timestamp();
    let cached: Option<ApiCache> = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok());
    if let Some(c) = cached {
        if c.interests == interests && c.own_key == own_key.is_some() && now - c.ts < API_CACHE_SECS {
            return Ok(c.items);
        }
    }
    let (items, complete) = search(net, own_key, interests)?;
    // A topic that failed (proxy out of quota for today) is tried again next time, not in 6 hours.
    if complete {
        let _ = fs::create_dir_all(config::data_dir());
        let cache = ApiCache { ts: now, interests: interests.to_vec(), own_key: own_key.is_some(), items: items.clone() };
        if let Ok(json) = serde_json::to_string(&cache) {
            let _ = fs::write(&path, json);
        }
    }
    Ok(items)
}

/// Videos for your first interests, and whether every topic answered.
fn search(net: &dyn Net, own_key: Option<&str>, interests: &[String]) -> Result<(Vec<Suggestion>, bool)> {
    let topics: Vec<&String> = interests.iter().filter(|i| !i.trim().is_empty()).take(MAX_INTERESTS).collect();
    let (found, complete) = match own_key {
        Some(key) => (api(net, key, &topics)?, true),
        None => proxy(net, &topics)?,
    };
    Ok((to_suggestions(found), complete))
}

/// Each topic through the proxy. Fails only if no topic answered.
fn proxy(net: &dyn Net, topics: &[&String]) -> Result<(Vec<(Found, String)>, bool)> {
    #[derive(Deserialize)]
    struct Reply {
        items: Vec<Found>,
    }
    let url = proxy_url();
    let mut found: Vec<(Found, String)> = Vec::new();
    let mut last_error = None;
    for topic in topics {
        match net::get_json::<Reply>(net, &url, &[("q", topic.as_str())]) {
            Ok(reply) => {
                for f in reply.items {
                    if !found.iter().any(|(g, _)| g.id == f.id) {
                        found.push((f, (*topic).clone()));
                    }
                }
            }
            Err(e) => last_error = Some(e),
        }
    }
    match last_error {
        Some(e) if found.is_empty() => Err(e),
        e => Ok((found, e.is_none())),
    }
}

/// Straight to the YouTube Data API with your own key.
fn api(net: &dyn Net, key: &str, topics: &[&String]) -> Result<Vec<(Found, String)>> {
    let after = (Utc::now() - chrono::Duration::days(365)).to_rfc3339_opts(SecondsFormat::Secs, true);
    // (video id, title, channel, interest)
    let mut found: Vec<(String, String, String, String)> = Vec::new();
    for interest in topics.iter().copied() {
        let v: Value = net::get_json(
            net,
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
    let v: Value = net::get_json(
        net,
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
            let &(seconds, views, likes) = stats.get(&id)?;
            Some((Found { id, title, channel, seconds, views, likes }, interest))
        })
        .collect())
}

fn to_suggestions(found: Vec<(Found, String)>) -> Vec<Suggestion> {
    found
        .into_iter()
        .filter_map(|(f, interest)| {
            if f.seconds < 120 {
                return None; // Shorts and live streams
            }
            let minutes = f.seconds.div_ceil(60);
            Some(Suggestion {
                id: format!("yt:{}", f.id),
                category: Category::Video,
                detail: format!("{} · {} views · for “{interest}”", f.channel, compact(f.views)),
                link: Some(format!("https://youtu.be/{}", f.id)),
                image: thumbnail(&f.id),
                title: f.title,
                min_minutes: minutes,
                max_minutes: minutes + 5,
                energy: Energy::Low,
                outdoor: false,
                social: Social::Either,
                cost: Cost::Free,
                quality: video_quality(f.views, f.likes),
                tags: vec!["youtube".into(), interest.to_lowercase()],
            })
        })
        .collect()
}

fn video_quality(views: u64, likes: u64) -> f64 {
    let reach = 0.3 + 0.07 * ((views.max(1)) as f64).log10();
    let love = if views > 0 { (likes as f64 / views as f64 * 3.0).min(0.15) } else { 0.0 };
    (reach + love).min(0.95)
}

// ---------------------------------------------------------------- search links (last resort)

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
                net::url_encode(i)
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
    use crate::net::fake::FakeNet;

    const FEED: &str = include_str!("../../fixtures/youtube_feed.xml");
    const FIRESHIP: &str = "UCsBjURrPoezykLs9EqgamOA";

    fn ts(rfc3339: &str) -> i64 {
        DateTime::parse_from_rfc3339(rfc3339).unwrap().timestamp()
    }

    #[test]
    fn durations() {
        assert_eq!(parse_iso_duration("PT1H2M3S"), Some(3723));
        assert_eq!(parse_iso_duration("PT12M"), Some(720));
        assert_eq!(parse_iso_duration("P0D"), Some(0));
        assert_eq!(parse_iso_duration("nope"), None);
    }

    #[test]
    fn parses_a_channel_feed() {
        let videos = parse_feed(FEED).unwrap();
        assert_eq!(videos.len(), 4);
        assert_eq!(
            videos[0],
            FeedVideo {
                id: "abc123DEF45".into(),
                title: "Rust in 100 Seconds & more".into(),
                channel: "Fireship".into(),
                published: ts("2026-11-15T16:00:00+00:00"),
                views: 1_234_567,
                short: false,
            }
        );
        assert!(videos[1].short, "the /shorts/ link marks a Short");
        assert_eq!(videos[3].title, "It's fine");
        assert!(parse_feed("<feed><entry><title>x</broken></feed>").is_err());
    }

    #[test]
    fn picks_skip_shorts_and_old_uploads() {
        let now = ts("2026-11-17T12:00:00+00:00");
        let feeds = HashMap::from([(FIRESHIP.to_string(), parse_feed(FEED).unwrap())]);
        let picks = video_picks(&[(Category::Learn, vec![FIRESHIP.into()])], &feeds, now);
        let ids: Vec<&str> = picks.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["yt:abc123DEF45", "yt:quote000001"]);
        let first = &picks[0];
        assert_eq!(first.category, Category::Learn);
        assert_eq!(first.detail, "Fireship · yesterday · YouTube");
        assert_eq!(first.link.as_deref(), Some("https://youtu.be/abc123DEF45"));
        assert_eq!(first.image.as_deref(), Some("https://i.ytimg.com/vi/abc123DEF45/mqdefault.jpg"));

        let sport = video_picks(&[(Category::Sport, vec![FIRESHIP.into()])], &feeds, now);
        assert_eq!(sport.len(), 1, "one upload per channel outside videos and learning");
        assert_eq!(sport[0].energy, Energy::High);
    }

    #[test]
    fn feeds_come_from_the_network_without_a_key() {
        let net = FakeNet::new()
            .on("https://www.youtube.com/feeds/videos.xml", FEED);
        let (feeds, failed) = fetch_feeds(&net, &[FIRESHIP.to_string()]);
        assert!(failed.is_empty());
        assert_eq!(feeds[FIRESHIP].len(), 4);
        assert!(net.calls()[0].contains(&format!("channel_id={FIRESHIP}")));

        let dead = FakeNet::new();
        let (feeds, failed) = fetch_feeds(&dead, &[FIRESHIP.to_string()]);
        assert!(feeds.is_empty());
        assert_eq!(failed, vec![FIRESHIP.to_string()]);
    }

    const PROXY_CHESS: &str = r#"{"items":[
        {"id":"chess000001","title":"Learn chess &amp; win","channel":"GothamChess","seconds":1260,"views":250000,"likes":9000},
        {"id":"chessShort1","title":"Mate in 1","channel":"GothamChess","seconds":45,"views":900000,"likes":1000}
    ],"cached":true}"#;

    fn topics(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn without_a_key_searches_go_through_the_proxy() {
        let net = FakeNet::new().on(&proxy_url(), PROXY_CHESS);
        let (items, complete) = search(&net, None, &topics(&["Chess", " ", "Chess"])).unwrap();
        assert!(complete);
        assert_eq!(items.len(), 1, "Shorts are dropped, duplicates kept once");
        let v = &items[0];
        assert_eq!(v.id, "yt:chess000001");
        assert_eq!(v.title, "Learn chess &amp; win", "the proxy already unescapes titles");
        assert_eq!(v.detail, "GothamChess · 250k views · for “Chess”");
        assert_eq!((v.min_minutes, v.max_minutes), (21, 26));
        assert_eq!(v.tags, vec!["youtube".to_string(), "chess".to_string()]);
        let calls = net.calls();
        assert_eq!(calls.len(), 2, "blank topics are skipped");
        assert!(calls[0].starts_with("https://tgvphbmbxfembnsfdxlp.supabase.co/functions/v1/youtube-search?q=Chess"));
        assert!(calls.iter().all(|c| !c.contains("key=")), "no key ever goes to the proxy");
    }

    #[test]
    fn proxy_failures_are_partial_or_errors() {
        let dead = FakeNet::new().fail(&proxy_url());
        assert!(search(&dead, None, &topics(&["chess"])).is_err());
        let (items, complete) = search(&dead, None, &[]).unwrap();
        assert!(items.is_empty() && complete, "no interests, no calls");
    }

    #[test]
    fn your_own_key_goes_straight_to_youtube() {
        let net = FakeNet::new()
            .on("https://www.googleapis.com/youtube/v3/search", r#"{"items":[{"id":{"videoId":"own00000001"},"snippet":{"title":"Knots &#39;n&#39; ropes","channelTitle":"Sailor"}}]}"#)
            .on("https://www.googleapis.com/youtube/v3/videos", r#"{"items":[{"id":"own00000001","contentDetails":{"duration":"PT10M"},"statistics":{"viewCount":"1200","likeCount":"50"}}]}"#);
        let (items, complete) = search(&net, Some("my-key"), &topics(&["knots"])).unwrap();
        assert!(complete);
        assert_eq!(items[0].title, "Knots 'n' ropes");
        assert_eq!(items[0].min_minutes, 10);
        assert!(net.calls().iter().all(|c| !c.contains("supabase.co")));
    }

    #[test]
    fn channel_file_maps_categories() {
        let parsed = parse_channels(DEFAULT_CHANNELS).unwrap();
        assert!(parsed.iter().any(|(c, ids)| *c == Category::Chill && !ids.is_empty()), "relax = chill");
        assert!(parsed.iter().all(|(_, ids)| ids.iter().all(|id| is_channel_id(id))));
        assert!(parsed.iter().map(|(_, ids)| ids.len()).sum::<usize>() >= 20);

        let custom = parse_channels("sport = [\"UCFKE7WVJfvaHW5q283SxchA\", \"not-an-id\"]\nnope = [\"UCFKE7WVJfvaHW5q283SxchA\"]").unwrap();
        assert_eq!(custom, vec![(Category::Sport, vec!["UCFKE7WVJfvaHW5q283SxchA".to_string()])]);
        assert_eq!(parse_channels("this is = not toml ["), None);
    }
}
