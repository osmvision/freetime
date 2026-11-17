//! Current weather from Open-Meteo (free, no API key).

use crate::http;
use anyhow::Result;
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct Weather {
    pub place: String,
    pub temp_c: f64,
    pub precip_mm: f64,
    pub code: u32,
    pub wind_kmh: f64,
    pub is_day: bool,
}

#[derive(Deserialize)]
struct Resp {
    current: Current,
}

#[derive(Deserialize)]
struct Current {
    temperature_2m: f64,
    precipitation: f64,
    weather_code: u32,
    wind_speed_10m: f64,
    is_day: u8,
}

pub fn fetch(agent: &ureq::Agent, lat: f64, lon: f64, place: &str) -> Result<Weather> {
    let (lat, lon) = (lat.to_string(), lon.to_string());
    let r: Resp = http::get_json(
        agent,
        "https://api.open-meteo.com/v1/forecast",
        &[
            ("latitude", &lat),
            ("longitude", &lon),
            ("current", "temperature_2m,precipitation,weather_code,wind_speed_10m,is_day"),
        ],
    )?;
    Ok(Weather {
        place: place.to_string(),
        temp_c: r.current.temperature_2m,
        precip_mm: r.current.precipitation,
        code: r.current.weather_code,
        wind_kmh: r.current.wind_speed_10m,
        is_day: r.current.is_day == 1,
    })
}

impl Weather {
    pub fn sky(&self) -> &'static str {
        match self.code {
            0 => "clear sky",
            1 | 2 => "partly cloudy",
            3 => "overcast",
            45 | 48 => "fog",
            51..=57 => "drizzle",
            61..=67 => "rain",
            71..=77 => "snow",
            80..=82 => "rain showers",
            85 | 86 => "snow showers",
            95..=99 => "thunderstorm",
            _ => "mixed weather",
        }
    }

    pub fn emoji(&self) -> &'static str {
        match self.code {
            0 if self.is_day => "☀️",
            0 => "🌙",
            1 | 2 if self.is_day => "⛅",
            1..=3 => "☁️",
            45 | 48 => "🌫️",
            51..=67 | 80..=82 => "🌧️",
            71..=77 | 85 | 86 => "❄️",
            95..=99 => "⛈️",
            _ => "🌡️",
        }
    }

    /// 1.0 = perfect for being outside, close to 0 = stay in.
    /// `night_ok` is for things that are meant for the dark (stargazing).
    pub fn outdoor_factor(&self, night_ok: bool) -> f64 {
        let mut f = 1.0;
        if self.code >= 95 {
            f *= 0.05;
        } else if (51..=86).contains(&self.code) || self.precip_mm > 0.2 {
            f *= 0.25;
        } else if self.code == 45 || self.code == 48 {
            f *= 0.8;
        }
        if self.temp_c < 0.0 {
            f *= 0.4;
        } else if self.temp_c < 6.0 {
            f *= 0.7;
        } else if self.temp_c > 32.0 {
            f *= 0.5;
        }
        if self.wind_kmh > 45.0 {
            f *= 0.5;
        }
        if !self.is_day && !night_ok {
            f *= 0.5;
        }
        f
    }

    pub fn summary(&self) -> String {
        format!(
            "{}: {:.0}°C, {}{}{}",
            self.place,
            self.temp_c,
            self.sky(),
            if self.wind_kmh > 30.0 { ", windy" } else { "" },
            if self.is_day { "" } else { ", dark outside" }
        )
    }
}

#[derive(Deserialize)]
struct GeoResp {
    #[serde(default)]
    results: Vec<Place>,
}

#[derive(Debug, Deserialize)]
pub struct Place {
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub country_code: String,
    #[serde(default)]
    pub admin1: Option<String>,
}

impl Place {
    pub fn display(&self) -> String {
        let mut parts = vec![self.name.clone()];
        if let Some(a) = self.admin1.as_ref().filter(|a| **a != self.name) {
            parts.push(a.clone());
        }
        if !self.country.is_empty() {
            parts.push(self.country.clone());
        }
        parts.join(", ")
    }
}

pub fn geocode(agent: &ureq::Agent, name: &str) -> Result<Option<Place>> {
    let r: GeoResp = http::get_json(
        agent,
        "https://geocoding-api.open-meteo.com/v1/search",
        &[("name", name), ("count", "1"), ("language", "en"), ("format", "json")],
    )?;
    Ok(r.results.into_iter().next())
}
