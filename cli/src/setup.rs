//! `freetime setup`: optional overrides. Everything is detected automatically; this only
//! changes what you want different.

use crate::{
    config::{self, Config},
    net,
    providers::{steam, steam_local},
    weather,
};
use anyhow::Result;
use console::style;
use dialoguer::{theme::ColorfulTheme, Confirm, Input, Password};
use freetime_core::keys::{self, Keys};

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

pub fn run() -> Result<()> {
    let theme = ColorfulTheme::default();
    let mut cfg = Config::load()?;
    let net = net::HttpNet::new()?;
    println!("{}", style("freetime setup").bold());
    println!(
        "{}\n",
        style("Everything is optional and detected automatically. Press Enter to keep the current value.").dim()
    );

    // Location: empty = detected from your connection.
    let city: String = Input::with_theme(&theme)
        .with_prompt("City (empty = detect automatically)")
        .default(cfg.city.clone().unwrap_or_default())
        .allow_empty(true)
        .interact_text()?;
    let city = city.trim();
    if city.is_empty() {
        cfg.city = None;
        cfg.country = None;
        cfg.latitude = None;
        cfg.longitude = None;
    } else if Some(city) != cfg.city.as_deref() || cfg.latitude.is_none() {
        match weather::geocode(&net, city) {
            Ok(Some(p)) => {
                println!("  {} {}", style("✓").green(), p.display());
                cfg.city = Some(p.name.clone());
                cfg.latitude = Some(p.latitude);
                cfg.longitude = Some(p.longitude);
                if !p.country_code.is_empty() {
                    cfg.country = Some(p.country_code.to_ascii_uppercase());
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

    // Steam: the account on this PC is used unless you pick another one.
    let local = steam_local::detect();
    match &local.account {
        Some(a) => println!("  Steam account on this PC: {} ({} games installed)", a.persona_name, local.installed.len()),
        None => println!("  {}", style("No Steam account found on this PC.").dim()),
    }
    let resolved = Keys::resolve();
    let key_state = |k: &Option<keys::Key>| k.as_ref().map_or("not set".to_string(), |k| format!("set ({})", k.source.label()));
    println!("  Steam Web API key: {}", key_state(&resolved.steam));
    println!("  YouTube API key: {}", key_state(&resolved.youtube));

    if Confirm::with_theme(&theme)
        .with_prompt("Add or change an API key? (optional: more personal picks)")
        .default(false)
        .interact()?
    {
        println!("  Steam: {}", style("https://steamcommunity.com/dev/apikey").cyan());
        let steam_key = Password::with_theme(&theme)
            .with_prompt("Steam Web API key (Enter to keep)")
            .allow_empty_password(true)
            .interact()?;
        if !steam_key.trim().is_empty() {
            keys::save_user_key(keys::STEAM, Some(&steam_key))?;
        }
        println!("  YouTube: {}", style("https://console.cloud.google.com/apis/library/youtube.googleapis.com").cyan());
        let youtube_key = Password::with_theme(&theme)
            .with_prompt("YouTube Data API key (Enter to keep)")
            .allow_empty_password(true)
            .interact()?;
        if !youtube_key.trim().is_empty() {
            keys::save_user_key(keys::YOUTUBE, Some(&youtube_key))?;
        }
        println!("  {} {}", style("Saved to").dim(), keys::user_env_path().display());
    }

    let who: String = Input::with_theme(&theme)
        .with_prompt("Another Steam profile (URL, name or SteamID64; empty = this PC's account)")
        .default(cfg.steam.steam_id.clone().unwrap_or_default())
        .allow_empty(true)
        .interact_text()?;
    let who = who.trim();
    if who.is_empty() {
        cfg.steam.steam_id = None;
    } else if cfg.steam.steam_id.as_deref() != Some(who) {
        match Keys::resolve().steam {
            Some(key) => match steam::resolve_steam_id(&net, key.value(), who) {
                Ok(id) => {
                    println!("  {} SteamID64 {id}", style("✓").green());
                    cfg.steam.steam_id = Some(id);
                }
                Err(e) => println!("  {} {e}", style("!").yellow()),
            },
            None => println!("  {}", style("A profile from another account needs a Steam Web API key.").yellow()),
        }
    }

    println!(
        "  {}",
        style("Extra channels work without a key. A channel ID starts with UC (channel page → About → Share → Copy channel ID).").dim()
    );
    let channels: String = Input::with_theme(&theme)
        .with_prompt("Extra YouTube channel IDs (comma separated)")
        .default(cfg.youtube.channels.join(", "))
        .allow_empty(true)
        .interact_text()?;
    cfg.youtube.channels = split_list(&channels);

    cfg.save()?;
    println!("\n{} Saved to {}", style("✓").green(), config::config_path().display());
    println!("  Now just run {}", style("freetime").cyan().bold());
    Ok(())
}
