//! Where the user is, without asking. A city they typed always wins; otherwise the location of
//! their internet connection (ipapi.co, then ip-api.com), cached for 24 hours.

use crate::{
    config::{self, Config},
    net::{self, Net},
    weather,
};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Arc};

/// How long a detected location is trusted before it's looked up again.
pub const CACHE_SECS: i64 = 24 * 3600;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// A city the user typed.
    Manual,
    /// Looked up from the IP address.
    Detected,
    /// Nothing worked: no weather, and Steam picks the currency itself.
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Location {
    pub city: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// ISO 3166-1 alpha-2, upper case ("FR").
    pub country_code: Option<String>,
    /// ISO 4217 ("EUR").
    pub currency: Option<String>,
    pub source: Source,
    /// Unix time of the lookup.
    pub at: i64,
}

impl Location {
    pub fn unknown(now: i64) -> Location {
        Location { at: now, ..Default::default() }
    }

    pub fn coords(&self) -> Option<(f64, f64)> {
        Some((self.lat?, self.lon?))
    }

    /// What to call this place in the UI.
    pub fn label(&self) -> String {
        self.city.clone().unwrap_or_else(|| "Your area".to_string())
    }

    /// Steam's `cc` parameter for this location.
    pub fn steam_cc(&self) -> Option<String> {
        self.country_code.as_deref().and_then(steam_cc)
    }

    pub fn is_fresh(&self, now: i64) -> bool {
        (0..CACHE_SECS).contains(&(now - self.at))
    }
}

/// Country code → Steam store `cc` parameter: two ASCII letters, lower case.
pub fn steam_cc(country: &str) -> Option<String> {
    let c = country.trim();
    (c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic())).then(|| c.to_ascii_lowercase())
}

pub fn cache_path() -> PathBuf {
    config::config_dir().join("location.json")
}

fn load_cache() -> Option<Location> {
    serde_json::from_str(&fs::read_to_string(cache_path()).ok()?).ok()
}

fn save_cache(loc: &Location) {
    let _ = fs::create_dir_all(config::config_dir());
    if let Ok(json) = serde_json::to_string_pretty(loc) {
        let _ = fs::write(cache_path(), json);
    }
}

/// Never waits long: a manual city or a fresh cache answer at once, a stale cache answers at once
/// and refreshes in the background, and only the very first run waits for the lookup.
/// On failure: the last cached value, then an unknown location.
pub fn resolve(net: &Arc<dyn Net>, cfg: &Config, now: i64) -> Location {
    if let Some(loc) = manual(net.as_ref(), cfg, now) {
        return loc;
    }
    match load_cache().filter(|c| c.source == Source::Detected) {
        Some(cached) if cached.is_fresh(now) => cached,
        Some(stale) => {
            let net = Arc::clone(net);
            std::thread::spawn(move || {
                if let Ok(loc) = detect(net.as_ref(), now) {
                    save_cache(&loc);
                }
            });
            stale
        }
        None => match detect(net.as_ref(), now) {
            Ok(loc) => {
                save_cache(&loc);
                loc
            }
            Err(_) => Location::unknown(now),
        },
    }
}

/// The city the user typed, geocoded with Open-Meteo when its coordinates aren't saved yet.
pub fn manual(net: &dyn Net, cfg: &Config, now: i64) -> Option<Location> {
    let city = cfg.city.as_deref().map(str::trim).filter(|c| !c.is_empty())?;
    let mut loc = Location {
        city: Some(city.to_string()),
        lat: cfg.latitude,
        lon: cfg.longitude,
        country_code: cfg.country.as_deref().map(str::to_ascii_uppercase),
        currency: None,
        source: Source::Manual,
        at: now,
    };
    if loc.coords().is_none() {
        if let Ok(Some(place)) = weather::geocode(net, city) {
            loc.lat = Some(place.latitude);
            loc.lon = Some(place.longitude);
            if !place.country_code.is_empty() {
                loc.country_code = Some(place.country_code.to_ascii_uppercase());
            }
        }
    }
    loc.currency = loc.country_code.as_deref().and_then(currency_for).map(String::from);
    Some(loc)
}

/// Looks the connection up: ipapi.co first, ip-api.com if that fails.
pub fn detect(net: &dyn Net, now: i64) -> Result<Location> {
    ipapi_co(net, now).or_else(|first| {
        ip_api_com(net, now).map_err(|second| anyhow!("ipapi.co: {first}; ip-api.com: {second}"))
    })
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[derive(Deserialize)]
struct IpapiCo {
    #[serde(default)]
    error: bool,
    reason: Option<String>,
    city: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    country_code: Option<String>,
    currency: Option<String>,
}

fn ipapi_co(net: &dyn Net, now: i64) -> Result<Location> {
    let r: IpapiCo = net::get_json(net, "https://ipapi.co/json/", &[])?;
    if r.error {
        bail!("{}", r.reason.unwrap_or_else(|| "lookup refused".into()));
    }
    let (Some(lat), Some(lon)) = (r.latitude, r.longitude) else { bail!("no coordinates") };
    Ok(Location {
        city: clean(r.city),
        lat: Some(lat),
        lon: Some(lon),
        country_code: clean(r.country_code).map(|c| c.to_ascii_uppercase()),
        currency: clean(r.currency),
        source: Source::Detected,
        at: now,
    })
}

#[derive(Deserialize)]
struct IpApiCom {
    status: String,
    city: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    #[serde(rename = "countryCode")]
    country_code: Option<String>,
    currency: Option<String>,
}

fn ip_api_com(net: &dyn Net, now: i64) -> Result<Location> {
    let r: IpApiCom = net::get_json(
        net,
        "http://ip-api.com/json/",
        &[("fields", "status,city,lat,lon,countryCode,currency")],
    )?;
    if r.status != "success" {
        bail!("lookup failed");
    }
    let (Some(lat), Some(lon)) = (r.lat, r.lon) else { bail!("no coordinates") };
    Ok(Location {
        city: clean(r.city),
        lat: Some(lat),
        lon: Some(lon),
        country_code: clean(r.country_code).map(|c| c.to_ascii_uppercase()),
        currency: clean(r.currency),
        source: Source::Detected,
        at: now,
    })
}

/// Currency for a typed city's country (IP lookups already include it).
pub fn currency_for(country: &str) -> Option<&'static str> {
    const EURO: [&str; 27] = [
        "AD", "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MC",
        "ME", "MT", "NL", "PT", "SI", "SK", "SM", "VA", "XK", "BL",
    ];
    let c = country.trim().to_ascii_uppercase();
    if EURO.contains(&c.as_str()) {
        return Some("EUR");
    }
    Some(match c.as_str() {
        "US" => "USD",
        "GB" => "GBP",
        "CA" => "CAD",
        "AU" => "AUD",
        "NZ" => "NZD",
        "CH" | "LI" => "CHF",
        "JP" => "JPY",
        "CN" => "CNY",
        "KR" => "KRW",
        "IN" => "INR",
        "BR" => "BRL",
        "MX" => "MXN",
        "AR" => "ARS",
        "CL" => "CLP",
        "CO" => "COP",
        "PE" => "PEN",
        "SE" => "SEK",
        "NO" => "NOK",
        "DK" => "DKK",
        "PL" => "PLN",
        "CZ" => "CZK",
        "HU" => "HUF",
        "RO" => "RON",
        "TR" => "TRY",
        "UA" => "UAH",
        "RU" => "RUB",
        "IL" => "ILS",
        "AE" => "AED",
        "SA" => "SAR",
        "ZA" => "ZAR",
        "MA" => "MAD",
        "DZ" => "DZD",
        "TN" => "TND",
        "EG" => "EGP",
        "SG" => "SGD",
        "HK" => "HKD",
        "TW" => "TWD",
        "TH" => "THB",
        "VN" => "VND",
        "ID" => "IDR",
        "MY" => "MYR",
        "PH" => "PHP",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::fake::FakeNet;

    const IPAPI_CO: &str = include_str!("../fixtures/ipapi_co.json");
    const IP_API_COM: &str = include_str!("../fixtures/ip_api_com.json");

    #[test]
    fn country_to_steam_cc() {
        assert_eq!(steam_cc("FR").as_deref(), Some("fr"));
        assert_eq!(steam_cc(" de ").as_deref(), Some("de"));
        assert_eq!(steam_cc("gb").as_deref(), Some("gb"));
        assert_eq!(steam_cc("FRA"), None);
        assert_eq!(steam_cc(""), None);
        assert_eq!(steam_cc("1x"), None);
    }

    #[test]
    fn detects_with_ipapi_co() {
        let net = FakeNet::new().on("https://ipapi.co/", IPAPI_CO);
        let loc = detect(&net, 100).unwrap();
        assert_eq!(loc.city.as_deref(), Some("Lyon"));
        assert_eq!(loc.country_code.as_deref(), Some("FR"));
        assert_eq!(loc.currency.as_deref(), Some("EUR"));
        assert_eq!(loc.coords(), Some((45.7485, 4.8467)));
        assert_eq!(loc.source, Source::Detected);
        assert_eq!(net.calls().len(), 1);
    }

    #[test]
    fn falls_back_to_ip_api_com() {
        let net = FakeNet::new().fail("https://ipapi.co/").on("http://ip-api.com/", IP_API_COM);
        let loc = detect(&net, 100).unwrap();
        assert_eq!(loc.city.as_deref(), Some("Montreal"));
        assert_eq!(loc.country_code.as_deref(), Some("CA"));
        assert_eq!(loc.currency.as_deref(), Some("CAD"));
        assert!(net.calls()[1].contains("fields=status,city,lat,lon,countryCode,currency"));
    }

    #[test]
    fn rate_limited_ipapi_falls_back_too() {
        let net = FakeNet::new()
            .on("https://ipapi.co/", r#"{"error": true, "reason": "RateLimited"}"#)
            .on("http://ip-api.com/", IP_API_COM);
        assert_eq!(detect(&net, 100).unwrap().city.as_deref(), Some("Montreal"));
    }

    #[test]
    fn both_providers_down_is_an_error() {
        let net = FakeNet::new();
        assert!(detect(&net, 100).is_err());
    }

    #[test]
    fn manual_city_wins_and_is_geocoded() {
        let net = FakeNet::new().on(
            "https://geocoding-api.open-meteo.com/",
            r#"{"results":[{"name":"Tokyo","latitude":35.6895,"longitude":139.69171,"country":"Japan","country_code":"JP"}]}"#,
        );
        let cfg = Config { city: Some("Tokyo".into()), ..Default::default() };
        let loc = manual(&net, &cfg, 5).unwrap();
        assert_eq!(loc.source, Source::Manual);
        assert_eq!(loc.coords(), Some((35.6895, 139.69171)));
        assert_eq!(loc.steam_cc().as_deref(), Some("jp"));
        assert_eq!(loc.currency.as_deref(), Some("JPY"));

        let no_city = Config::default();
        assert!(manual(&net, &no_city, 5).is_none());
    }

    #[test]
    fn cache_expires_after_a_day() {
        let loc = Location { at: 1_000, source: Source::Detected, ..Default::default() };
        assert!(loc.is_fresh(1_000 + CACHE_SECS - 1));
        assert!(!loc.is_fresh(1_000 + CACHE_SECS));
        assert!(!loc.is_fresh(999), "a cache from the future is not trusted");
    }
}
