use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub city: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// Two-letter country code, used for Steam store prices.
    pub country: String,
    /// Topics used to find YouTube videos.
    pub interests: Vec<String>,
    pub steam: SteamConfig,
    pub youtube: YoutubeConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SteamConfig {
    pub api_key: Option<String>,
    /// SteamID64 (17 digits).
    pub steam_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct YoutubeConfig {
    pub api_key: Option<String>,
    /// Channel IDs (UC…) whose new uploads are suggested. Works without an API key.
    pub channels: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            city: None,
            latitude: None,
            longitude: None,
            country: "us".into(),
            interests: ["science explained", "history", "game design", "cooking", "travel"]
                .map(String::from)
                .to_vec(),
            steam: SteamConfig::default(),
            youtube: YoutubeConfig::default(),
        }
    }
}

/// `FREETIME_HOME` puts config and data in one folder (handy for testing).
fn home_override() -> Option<PathBuf> {
    env::var_os("FREETIME_HOME").map(PathBuf::from)
}

pub fn config_path() -> PathBuf {
    home_override()
        .or_else(|| dirs::config_dir().map(|d| d.join("freetime")))
        .unwrap_or_else(|| PathBuf::from(".freetime"))
        .join("config.toml")
}

pub fn data_dir() -> PathBuf {
    home_override()
        .or_else(|| dirs::data_dir().map(|d| d.join("freetime")))
        .unwrap_or_else(|| PathBuf::from(".freetime"))
}

fn env_nonempty(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    pub fn load() -> Result<Config> {
        let path = config_path();
        if !path.exists() {
            return Ok(Config::default());
        }
        let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        toml::from_str(&text).with_context(|| format!("{} is not valid", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&path, toml::to_string_pretty(self)?).with_context(|| format!("writing {}", path.display()))
    }

    pub fn steam_key(&self) -> Option<String> {
        env_nonempty("STEAM_API_KEY").or_else(|| self.steam.api_key.clone().filter(|k| !k.trim().is_empty()))
    }

    pub fn youtube_key(&self) -> Option<String> {
        env_nonempty("YOUTUBE_API_KEY").or_else(|| self.youtube.api_key.clone().filter(|k| !k.trim().is_empty()))
    }

    pub fn location(&self) -> Option<(f64, f64, String)> {
        Some((
            self.latitude?,
            self.longitude?,
            self.city.clone().unwrap_or_else(|| "Your area".into()),
        ))
    }
}
