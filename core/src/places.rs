//! Real places near the user's city for ideas that happen somewhere: a park, a pool, a court.
//! Data from OpenStreetMap through the Overpass API.
//!
//! Privacy: nothing here runs at startup. A lookup happens only when the user asks for places
//! near an idea, and it sends only the coordinates of the city they picked (never their IP-based
//! or precise location). Results are cached, so the same question isn't asked twice in a month.

use crate::{config, net::Net};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};

pub const OVERPASS_URL: &str = "https://overpass-api.de/api/interpreter";
/// How far to look around the city's coordinates.
pub const RADIUS_M: u32 = 5000;
/// Places don't move: a month-old answer is still good.
pub const CACHE_SECS: i64 = 30 * 86_400;
/// The nearest few are enough to pick from.
pub const MAX_RESULTS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceKind {
    Park,
    Garden,
    Pool,
    Football,
    Basketball,
    Tennis,
    Volleyball,
    TableTennis,
    Boules,
    Skatepark,
    FitnessStation,
    Gym,
    SportsCentre,
    Climbing,
    Library,
    Museum,
    Viewpoint,
    Market,
    Bowling,
    Minigolf,
}

impl PlaceKind {
    /// What a place of this kind is called when it has no name ("a park").
    pub fn label(self) -> &'static str {
        match self {
            PlaceKind::Park => "Park",
            PlaceKind::Garden => "Garden",
            PlaceKind::Pool => "Swimming pool",
            PlaceKind::Football => "Football pitch",
            PlaceKind::Basketball => "Basketball court",
            PlaceKind::Tennis => "Tennis court",
            PlaceKind::Volleyball => "Volleyball court",
            PlaceKind::TableTennis => "Ping-pong table",
            PlaceKind::Boules => "Boules ground",
            PlaceKind::Skatepark => "Skatepark",
            PlaceKind::FitnessStation => "Outdoor fitness area",
            PlaceKind::Gym => "Gym",
            PlaceKind::SportsCentre => "Sports centre",
            PlaceKind::Climbing => "Climbing wall",
            PlaceKind::Library => "Library",
            PlaceKind::Museum => "Museum",
            PlaceKind::Viewpoint => "Viewpoint",
            PlaceKind::Market => "Market",
            PlaceKind::Bowling => "Bowling alley",
            PlaceKind::Minigolf => "Mini golf",
        }
    }

    /// Overpass QL selectors (without the area filter). Unnamed parks and gardens are mostly
    /// private lawns and squares, so those two kinds need a name.
    fn selectors(self) -> &'static [&'static str] {
        match self {
            PlaceKind::Park => &[r#"nwr["leisure"="park"]["name"]"#],
            PlaceKind::Garden => &[r#"nwr["leisure"="garden"]["name"]["access"!~"private|no"]"#],
            PlaceKind::Pool => &[
                r#"nwr["leisure"="sports_centre"]["sport"~"swimming"]"#,
                r#"nwr["leisure"="water_park"]"#,
                r#"nwr["amenity"="public_bath"]"#,
            ],
            PlaceKind::Football => &[r#"nwr["leisure"="pitch"]["sport"="soccer"]["access"!~"private|no"]"#],
            PlaceKind::Basketball => &[r#"nwr["leisure"="pitch"]["sport"="basketball"]["access"!~"private|no"]"#],
            PlaceKind::Tennis => &[r#"nwr["leisure"="pitch"]["sport"="tennis"]["access"!~"private|no"]"#],
            PlaceKind::Volleyball => &[r#"nwr["leisure"="pitch"]["sport"~"^(beach)?volleyball$"]["access"!~"private|no"]"#],
            PlaceKind::TableTennis => &[r#"nwr["leisure"="pitch"]["sport"="table_tennis"]["access"!~"private|no"]"#],
            PlaceKind::Boules => &[r#"nwr["leisure"="pitch"]["sport"="boules"]["access"!~"private|no"]"#],
            PlaceKind::Skatepark => &[r#"nwr["leisure"="pitch"]["sport"="skateboard"]"#],
            PlaceKind::FitnessStation => &[r#"nwr["leisure"="fitness_station"]"#],
            PlaceKind::Gym => &[r#"nwr["leisure"="fitness_centre"]"#],
            PlaceKind::SportsCentre => &[r#"nwr["leisure"="sports_centre"]["name"]"#],
            PlaceKind::Climbing => &[r#"nwr["sport"="climbing"]["leisure"~"sports_centre|pitch"]"#],
            PlaceKind::Library => &[r#"nwr["amenity"="library"]"#],
            PlaceKind::Museum => &[r#"nwr["tourism"="museum"]"#],
            PlaceKind::Viewpoint => &[r#"nwr["tourism"="viewpoint"]"#],
            PlaceKind::Market => &[r#"nwr["amenity"="marketplace"]"#],
            PlaceKind::Bowling => &[r#"nwr["leisure"="bowling_alley"]"#],
            PlaceKind::Minigolf => &[r#"nwr["leisure"="miniature_golf"]"#],
        }
    }
}

/// One place near the city, nearest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Place {
    pub name: String,
    /// False when OpenStreetMap has no name and `name` is the kind's label.
    pub named: bool,
    /// From the city's coordinates, in meters.
    pub distance_m: u32,
    pub lat: f64,
    pub lon: f64,
    /// The place on openstreetmap.org.
    pub link: String,
}

/// The Overpass query: every selector around the point, with a center for ways and relations.
pub fn query(kind: PlaceKind, lat: f64, lon: f64) -> String {
    let around = format!("(around:{RADIUS_M},{lat:.4},{lon:.4})");
    let parts: String = kind.selectors().iter().map(|s| format!("{s}{around};")).collect();
    format!("[out:json][timeout:10];({parts});out center tags 200;")
}

#[derive(Deserialize)]
struct Resp {
    #[serde(default)]
    elements: Vec<Element>,
}

#[derive(Deserialize)]
struct Element {
    #[serde(rename = "type")]
    kind: String,
    id: u64,
    lat: Option<f64>,
    lon: Option<f64>,
    center: Option<Center>,
    #[serde(default)]
    tags: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Center {
    lat: f64,
    lon: f64,
}

/// Great-circle distance in meters.
pub fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * a.sqrt().asin()
}

/// Turns an Overpass answer into the nearest places, named ones first when equally close.
pub fn parse(body: &str, kind: PlaceKind, lat: f64, lon: f64) -> Result<Vec<Place>> {
    let r: Resp = serde_json::from_str(body).map_err(|e| anyhow!("unexpected response: {e}"))?;
    let mut seen = std::collections::HashSet::new();
    let mut places: Vec<Place> = r
        .elements
        .into_iter()
        .filter_map(|e| {
            let (plat, plon) = match (e.lat, e.lon, &e.center) {
                (Some(a), Some(b), _) => (a, b),
                (_, _, Some(c)) => (c.lat, c.lon),
                _ => return None,
            };
            if !(plat.is_finite() && plon.is_finite()) || !matches!(e.kind.as_str(), "node" | "way" | "relation") {
                return None;
            }
            let name = e.tags.get("name").map(|n| n.trim()).filter(|n| !n.is_empty()).map(|n| n.chars().take(80).collect::<String>());
            Some(Place {
                named: name.is_some(),
                name: name.unwrap_or_else(|| kind.label().to_string()),
                distance_m: distance_m(lat, lon, plat, plon).round() as u32,
                lat: plat,
                lon: plon,
                link: format!("https://www.openstreetmap.org/{}/{}", e.kind, e.id),
            })
        })
        // The same pool mapped as a building and as a sports centre: keep one per name.
        .filter(|p| !p.named || seen.insert(p.name.to_lowercase()))
        .collect();
    places.sort_by_key(|p| (p.distance_m / 100, !p.named, p.distance_m));
    places.truncate(MAX_RESULTS);
    Ok(places)
}

/// Asks Overpass for the nearest places of `kind` around the city.
pub fn nearby(net: &dyn Net, kind: PlaceKind, lat: f64, lon: f64) -> Result<Vec<Place>> {
    if !(lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0) {
        return Err(anyhow!("invalid coordinates"));
    }
    let body = net.get_text(OVERPASS_URL, &[("data", &query(kind, lat, lon))])?;
    parse(&body, kind, lat, lon)
}

// ---------------------------------------------------------------- cache

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Cache {
    #[serde(default)]
    entries: Vec<CacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    kind: PlaceKind,
    /// The city's coordinates, rounded to about a kilometer: moving across town doesn't matter.
    lat: f64,
    lon: f64,
    ts: i64,
    places: Vec<Place>,
}

const MAX_CACHE: usize = 200;

fn round_coord(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

impl Cache {
    fn path() -> PathBuf {
        config::data_dir().join("places_cache.json")
    }

    pub fn load() -> Cache {
        fs::read_to_string(Self::path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, serde_json::to_string(self)?)?;
        Ok(())
    }

    pub fn get(&self, kind: PlaceKind, lat: f64, lon: f64, now: i64) -> Option<Vec<Place>> {
        let (lat, lon) = (round_coord(lat), round_coord(lon));
        self.entries
            .iter()
            .find(|e| e.kind == kind && e.lat == lat && e.lon == lon && now - e.ts < CACHE_SECS)
            .map(|e| e.places.clone())
    }

    pub fn put(&mut self, kind: PlaceKind, lat: f64, lon: f64, now: i64, places: Vec<Place>) {
        let (lat, lon) = (round_coord(lat), round_coord(lon));
        self.entries.retain(|e| !(e.kind == kind && e.lat == lat && e.lon == lon) && now - e.ts < CACHE_SECS);
        self.entries.push(CacheEntry { kind, lat, lon, ts: now, places });
        if self.entries.len() > MAX_CACHE {
            let extra = self.entries.len() - MAX_CACHE;
            self.entries.drain(..extra);
        }
    }
}

/// Cached first, then Overpass. Used by the desktop app and the terminal.
pub fn nearby_cached(net: &dyn Net, kind: PlaceKind, lat: f64, lon: f64, now: i64) -> Result<Vec<Place>> {
    let mut cache = Cache::load();
    if let Some(hit) = cache.get(kind, lat, lon, now) {
        return Ok(hit);
    }
    let places = nearby(net, kind, lat, lon)?;
    cache.put(kind, lat, lon, now, places.clone());
    let _ = cache.save(); // A cache that can't be written only costs a request next time.
    Ok(places)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::fake::FakeNet;

    const LYON: (f64, f64) = (45.7578, 4.8320);

    const BODY: &str = r#"{"elements":[
        {"type":"way","id":11,"center":{"lat":45.7745,"lon":4.8553},"tags":{"leisure":"park","name":"Parc de la Tête d'Or"}},
        {"type":"node","id":12,"lat":45.7580,"lon":4.8322,"tags":{"leisure":"park"}},
        {"type":"way","id":13,"center":{"lat":45.7600,"lon":4.8350},"tags":{"name":"Square Nearby"}},
        {"type":"relation","id":14,"center":{"lat":45.7601,"lon":4.8351},"tags":{"name":"square nearby"}},
        {"type":"way","id":15,"tags":{"name":"No position"}},
        {"type":"way","id":16,"center":{"lat":45.80,"lon":4.90},"tags":{"name":"Far Park"}}
    ]}"#;

    #[test]
    fn nearest_first_named_and_deduplicated() {
        let p = parse(BODY, PlaceKind::Park, LYON.0, LYON.1).unwrap();
        let names: Vec<&str> = p.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Park", "Square Nearby", "Parc de la Tête d'Or"]);
        assert!(!p[0].named && p[0].distance_m < 50);
        assert_eq!(p[1].link, "https://www.openstreetmap.org/way/13");
        assert!((2_000..3_500).contains(&p[2].distance_m), "{}", p[2].distance_m);
    }

    #[test]
    fn asks_overpass_only_around_the_city() {
        let net = FakeNet::new().on(OVERPASS_URL, BODY);
        let p = nearby(&net, PlaceKind::Pool, LYON.0, LYON.1).unwrap();
        assert_eq!(p.len(), 3);
        let call = &net.calls()[0];
        assert!(call.starts_with(OVERPASS_URL));
        assert!(call.contains("(around:5000,45.7578,4.8320)"));
        assert!(call.contains(r#"["sport"~"swimming"]"#) && call.contains("public_bath"));
        assert!(nearby(&net, PlaceKind::Park, 120.0, 0.0).is_err());
        assert!(nearby(&FakeNet::new().fail(OVERPASS_URL), PlaceKind::Park, LYON.0, LYON.1).is_err());
    }

    #[test]
    fn every_kind_has_a_query_and_a_label() {
        for kind in [
            PlaceKind::Park, PlaceKind::Garden, PlaceKind::Pool, PlaceKind::Football, PlaceKind::Basketball,
            PlaceKind::Tennis, PlaceKind::Volleyball, PlaceKind::TableTennis, PlaceKind::Boules,
            PlaceKind::Skatepark, PlaceKind::FitnessStation, PlaceKind::Gym, PlaceKind::SportsCentre,
            PlaceKind::Climbing, PlaceKind::Library, PlaceKind::Museum, PlaceKind::Viewpoint,
            PlaceKind::Market, PlaceKind::Bowling, PlaceKind::Minigolf,
        ] {
            let q = query(kind, 1.0, 2.0);
            assert!(q.starts_with("[out:json]") && q.contains("(around:5000,1.0000,2.0000)") && q.ends_with("out center tags 200;"));
            assert!(!kind.label().is_empty());
        }
    }

    #[test]
    fn cache_keeps_a_month_per_kind_and_area() {
        let mut c = Cache::default();
        let place = Place { name: "P".into(), named: true, distance_m: 10, lat: 0.0, lon: 0.0, link: String::new() };
        c.put(PlaceKind::Park, 45.7578, 4.832, 1_000, vec![place.clone()]);
        assert_eq!(c.get(PlaceKind::Park, 45.7581, 4.8318, 2_000), Some(vec![place.clone()]), "same area");
        assert_eq!(c.get(PlaceKind::Pool, 45.7578, 4.832, 2_000), None, "other kind");
        assert_eq!(c.get(PlaceKind::Park, 48.85, 2.35, 2_000), None, "other city");
        assert_eq!(c.get(PlaceKind::Park, 45.7578, 4.832, 1_000 + CACHE_SECS), None, "too old");
        c.put(PlaceKind::Park, 45.7578, 4.832, 3_000, vec![]);
        assert_eq!(c.entries.len(), 1, "replaced, not added");
    }
}
