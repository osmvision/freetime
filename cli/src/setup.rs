use crate::{config::{self, Config}, http, providers::steam, weather};
use anyhow::Result;
use console::style;
use dialoguer::{theme::ColorfulTheme, Confirm, Input, Password};

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

pub fn run() -> Result<()> {
    let theme = ColorfulTheme::default();
    let mut cfg = Config::load()?;
    let agent = http::agent()?;
    println!("{}", style("freetime setup").bold());
    println!("{}\n", style("Press Enter to keep the current value. Everything is optional.").dim());

    // City → weather-aware outdoor ideas.
    let city: String = Input::with_theme(&theme)
        .with_prompt("Your city (for weather-aware outdoor ideas)")
        .default(cfg.city.clone().unwrap_or_default())
        .allow_empty(true)
        .interact_text()?;
    let city = city.trim();
    if city.is_empty() {
        cfg.city = None;
        cfg.latitude = None;
        cfg.longitude = None;
    } else if Some(city) != cfg.city.as_deref() || cfg.latitude.is_none() {
        match weather::geocode(&agent, city) {
            Ok(Some(p)) => {
                println!("  {} {}", style("✓").green(), p.display());
                cfg.city = Some(p.name.clone());
                cfg.latitude = Some(p.latitude);
                cfg.longitude = Some(p.longitude);
                if !p.country_code.is_empty() {
                    cfg.country = p.country_code.to_lowercase();
                }
            }
            Ok(None) => println!("  {} couldn't find '{city}', keeping the previous location", style("!").yellow()),
            Err(e) => println!("  {} location lookup failed ({e})", style("!").yellow()),
        }
    }

    let interests: String = Input::with_theme(&theme)
        .with_prompt("Topics you like on YouTube (comma separated)")
        .default(cfg.interests.join(", "))
        .interact_text()?;
    cfg.interests = split_list(&interests);

    // Steam library.
    if Confirm::with_theme(&theme)
        .with_prompt("Connect your Steam library? (needs a free Steam Web API key)")
        .default(cfg.steam.api_key.is_some())
        .interact()?
    {
        println!("  Get a key at {}", style("https://steamcommunity.com/dev/apikey").cyan());
        let key = Password::with_theme(&theme)
            .with_prompt("Steam Web API key (Enter to keep the current one)")
            .allow_empty_password(true)
            .interact()?;
        if !key.trim().is_empty() {
            cfg.steam.api_key = Some(key.trim().to_string());
        }
        let who: String = Input::with_theme(&theme)
            .with_prompt("Your Steam profile URL, custom URL name or SteamID64")
            .default(cfg.steam.steam_id.clone().unwrap_or_default())
            .allow_empty(true)
            .interact_text()?;
        if let (false, Some(key)) = (who.trim().is_empty(), cfg.steam_key()) {
            match steam::resolve_steam_id(&agent, &key, &who) {
                Ok(id) => {
                    println!("  {} SteamID64 {id}", style("✓").green());
                    cfg.steam.steam_id = Some(id);
                }
                Err(e) => println!("  {} {e}", style("!").yellow()),
            }
        }
        println!(
            "  {}",
            style("Your profile's Privacy → Game details must be Public for this to work.").dim()
        );
    }

    // YouTube.
    if Confirm::with_theme(&theme)
        .with_prompt("Use the YouTube Data API for video picks? (free key from Google Cloud)")
        .default(cfg.youtube.api_key.is_some())
        .interact()?
    {
        println!(
            "  Enable \"YouTube Data API v3\" and create an API key: {}",
            style("https://console.cloud.google.com/apis/library/youtube.googleapis.com").cyan()
        );
        let key = Password::with_theme(&theme)
            .with_prompt("YouTube API key (Enter to keep the current one)")
            .allow_empty_password(true)
            .interact()?;
        if !key.trim().is_empty() {
            cfg.youtube.api_key = Some(key.trim().to_string());
        }
    }
    println!(
        "  {}",
        style("Channels you follow work without a key. A channel ID starts with UC (channel page → About → Share → Copy channel ID).").dim()
    );
    let channels: String = Input::with_theme(&theme)
        .with_prompt("YouTube channel IDs for new uploads (comma separated)")
        .default(cfg.youtube.channels.join(", "))
        .allow_empty(true)
        .interact_text()?;
    cfg.youtube.channels = split_list(&channels);

    cfg.save()?;
    println!("\n{} Saved to {}", style("✓").green(), config::config_path().display());
    println!(
        "  {}",
        style("API keys are stored in plain text there. You can use the STEAM_API_KEY / YOUTUBE_API_KEY env vars instead.").dim()
    );
    println!("  Now just run {}", style("freetime").cyan().bold());
    Ok(())
}
