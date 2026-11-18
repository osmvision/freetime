//! Where the user is, without any network lookup:
//! - the city (for the weather) is one the user picked, asked once and editable in the settings;
//! - the country and currency (for Steam prices) come from the OS regional settings.

use crate::{config::Config, region::{self, Region}};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// A city the user picked.
    Manual,
    /// No city yet: no weather.
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
}

impl Location {
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
}

/// The location right now: instant, offline.
pub fn current(cfg: &Config) -> Location {
    from_parts(cfg, region::current())
}

/// Prices follow the OS region (closest to the Steam store country); the picked city's country
/// is the fallback.
pub fn from_parts(cfg: &Config, region: Region) -> Location {
    let city = cfg.city.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(String::from);
    let country_code = region.country.or_else(|| cfg.country.as_deref().and_then(region::country_code));
    let currency = region
        .currency
        .or_else(|| country_code.as_deref().and_then(currency_for).map(String::from));
    Location {
        source: if city.is_some() { Source::Manual } else { Source::Unknown },
        lat: city.as_ref().and(cfg.latitude),
        lon: city.as_ref().and(cfg.longitude),
        city,
        country_code,
        currency,
    }
}

/// Country code → Steam store `cc` parameter: two ASCII letters, lower case.
pub fn steam_cc(country: &str) -> Option<String> {
    let c = country.trim();
    (c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic())).then(|| c.to_ascii_lowercase())
}

/// Currency of a country, when the OS doesn't say.
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

    fn region(country: &str, currency: &str) -> Region {
        Region { country: Some(country.into()), currency: Some(currency.into()) }
    }

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
    fn a_picked_city_gives_the_weather_coordinates() {
        let cfg = Config {
            city: Some("Lyon".into()),
            latitude: Some(45.75),
            longitude: Some(4.85),
            country: Some("FR".into()),
            ..Default::default()
        };
        let loc = from_parts(&cfg, region("FR", "EUR"));
        assert_eq!(loc.source, Source::Manual);
        assert_eq!(loc.coords(), Some((45.75, 4.85)));
        assert_eq!(loc.steam_cc().as_deref(), Some("fr"));
        assert_eq!(loc.currency.as_deref(), Some("EUR"));
    }

    #[test]
    fn prices_follow_the_os_region_over_the_city() {
        let cfg = Config { city: Some("Tokyo".into()), country: Some("JP".into()), ..Default::default() };
        let loc = from_parts(&cfg, region("CA", "CAD"));
        assert_eq!(loc.steam_cc().as_deref(), Some("ca"));
        assert_eq!(loc.currency.as_deref(), Some("CAD"));
    }

    #[test]
    fn without_a_region_the_city_country_is_used() {
        let cfg = Config { city: Some("Tokyo".into()), country: Some("JP".into()), ..Default::default() };
        let loc = from_parts(&cfg, Region::default());
        assert_eq!(loc.steam_cc().as_deref(), Some("jp"));
        assert_eq!(loc.currency.as_deref(), Some("JPY"));
    }

    #[test]
    fn no_city_means_no_weather() {
        let cfg = Config { latitude: Some(1.0), longitude: Some(2.0), ..Default::default() };
        let loc = from_parts(&cfg, Region::default());
        assert_eq!(loc.source, Source::Unknown);
        assert_eq!(loc.coords(), None);
        assert_eq!(loc.steam_cc(), None);
    }
}
