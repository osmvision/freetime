use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// The city picked by the user (for the weather). Empty = no weather.
    pub city: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// Two-letter country code of the typed city.
    pub country: Option<String>,
    /// The "where are you?" question was answered or skipped: it isn't asked again.
    pub asked_for_city: bool,
    /// Topics used to find YouTube videos.
    pub interests: Vec<String>,
    pub steam: SteamConfig,
    pub youtube: YoutubeConfig,
    /// Nickname put in your friend code (see `party`). Never sent anywhere by itself.
    pub display_name: Option<String>,
    /// Avatar icon and color put in your friend code.
    pub avatar: crate::party::Avatar,
    /// The first-run welcome was finished or skipped: it isn't shown again.
    pub onboarded: bool,
    /// While signed in, check for new messages every minute and show a Windows notification.
    pub notify_messages: bool,
    /// Share the imported Steam game list (app ids only) and taste with online friends.
    pub share_library: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SteamConfig {
    /// SteamID64 typed in the settings. Empty = the account last logged in on this PC.
    pub steam_id: Option<String>,
}

/// API keys don't live here: see `keys` (environment, `.env` files, build time).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct YoutubeConfig {
    /// Extra channel IDs (UC…) whose new uploads are suggested. Works without an API key.
    pub channels: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            city: None,
            latitude: None,
            longitude: None,
            country: None,
            asked_for_city: false,
            interests: ["science explained", "history", "game design", "cooking", "travel"]
                .map(String::from)
                .to_vec(),
            steam: SteamConfig::default(),
            youtube: YoutubeConfig::default(),
            display_name: None,
            avatar: Default::default(),
            onboarded: false,
            notify_messages: true,
            share_library: false,
        }
    }
}

/// `FREETIME_HOME` puts config and data in one folder (handy for testing).
fn home_override() -> Option<PathBuf> {
    env::var_os("FREETIME_HOME").map(PathBuf::from)
}

/// `%APPDATA%\freetime` on Windows.
pub fn config_dir() -> PathBuf {
    home_override()
        .or_else(|| dirs::config_dir().map(|d| d.join("freetime")))
        .unwrap_or_else(|| PathBuf::from(".freetime"))
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

pub fn data_dir() -> PathBuf {
    home_override()
        .or_else(|| dirs::data_dir().map(|d| d.join("freetime")))
        .unwrap_or_else(|| PathBuf::from(".freetime"))
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
}
