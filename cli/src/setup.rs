//! `freetime setup`: everything here is optional.

use crate::{
    config::{self, Config},
    net,
    providers::{steam, steam_import},
    weather,
};
use anyhow::Result;
use console::style;
use dialoguer::{theme::ColorfulTheme, Confirm, Input, Password, Select};
use freetime_core::{
    keys::{self, Keys},
    net::Net,
    region,
};

/// Asks for the city with a search (Open-Meteo geocoding). Enter skips, "-" removes it.
/// Either way the question isn't asked again on its own.
pub fn ask_city(theme: &ColorfulTheme, net: &dyn Net, cfg: &mut Config) -> Result<()> {
    cfg.asked_for_city = true;
    let prompt = if cfg.city.is_some() {
        "Change city (Enter to keep, - to remove)"
    } else {
        "Your city, for weather-aware ideas (Enter to skip)"
    };
    let query: String = Input::with_theme(theme).with_prompt(prompt).allow_empty(true).interact_text()?;
    let query = query.trim();
    if query.is_empty() {
        return Ok(());
    }
    if query == "-" {
        cfg.city = None;
        cfg.country = None;
        cfg.latitude = None;
        cfg.longitude = None;
        return Ok(());
    }
    match weather::search_places(net, query, 6) {
        Ok(places) if places.is_empty() => println!("  {} couldn't find '{query}'", style("!").yellow()),
        Ok(places) => {
            let mut labels: Vec<String> = places.iter().map(weather::Place::display).collect();
            labels.push("None of these".into());
            let i = Select::with_theme(theme).with_prompt("Which one?").items(&labels).default(0).interact()?;
            if let Some(p) = places.into_iter().nth(i) {
                println!("  {} {}", style("✓").green(), p.display());
                cfg.country = region::country_code(&p.country_code);
                cfg.latitude = Some(p.latitude);
                cfg.longitude = Some(p.longitude);
                cfg.city = Some(p.name);
            }
        }
        Err(e) => println!("  {} city search failed ({e})", style("!").yellow()),
    }
    println!("  {}", style("Weather data by Open-Meteo.com").dim());
    Ok(())
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// Opt-in: only now are Steam's folder and the allowed files read (see `steam_import`).
fn import_steam(theme: &ColorfulTheme, net: &dyn Net, cfg: &Config) -> Result<()> {
    let id = match &cfg.steam.steam_id {
        Some(id) => id.clone(),
        None => {
            let Some(root) = steam_import::steam_root() else {
                println!("  {}", style("Steam isn't installed on this PC.").yellow());
                return Ok(());
            };
            let accounts = steam_import::accounts(&root);
            match accounts.len() {
                0 => {
                    println!("  {}", style("No Steam account has used this PC yet.").yellow());
                    return Ok(());
                }
                1 => accounts[0].steam_id64.clone(),
                _ => {
                    let labels: Vec<String> = accounts
                        .iter()
                        .map(|a| match a.last_used.and_then(|t| chrono::DateTime::from_timestamp(t, 0)) {
                            Some(d) => format!("{} (last used {})", a.steam_id64, d.format("%d %b %Y")),
                            None => a.steam_id64.clone(),
                        })
                        .collect();
                    let i = Select::with_theme(theme).with_prompt("Which Steam account?").items(&labels).default(0).interact()?;
                    accounts[i].steam_id64.clone()
                }
            }
        }
    };
    let key = Keys::resolve().steam;
    let now = chrono::Utc::now().timestamp();
    match steam_import::run_import(net, key.as_ref().map(|k| k.value()), &id, now) {
        Ok((lib, notes)) => {
            let installed = lib.games.iter().filter(|g| g.installed).count();
            println!("  {} {} games imported ({installed} installed)", style("✓").green(), lib.games.len());
            for note in notes {
                println!("  {}", style(note).yellow());
            }
        }
        Err(e) => println!("  {} {e}", style("!").yellow()),
    }
    Ok(())
}

pub fn run() -> Result<()> {
    let theme = ColorfulTheme::default();
    let mut cfg = Config::load()?;
    let net = net::HttpNet::new()?;
    println!("{}", style("freetime setup").bold());
    println!(
        "{}\n",
        style("Everything is optional. Press Enter to keep the current value.").dim()
    );

    // Country and currency come from Windows; the city is only for the weather.
    let region = region::current();
    match (&region.country, &region.currency) {
        (Some(country), Some(currency)) => println!("  Region (from Windows): {country} · {currency}"),
        (Some(country), None) => println!("  Region (from Windows): {country}"),
        _ => println!("  {}", style("No Windows region found: Steam picks the currency.").dim()),
    }
    match &cfg.city {
        Some(city) => println!("  City: {city}"),
        None => println!("  City: not set (no weather)"),
    }
    ask_city(&theme, &net, &mut cfg)?;

    let interests: String = Input::with_theme(&theme)
        .with_prompt("Topics you like on YouTube (comma separated)")
        .default(cfg.interests.join(", "))
        .interact_text()?;
    cfg.interests = split_list(&interests);

    // Steam: nothing of Steam's is read unless you ask for an import.
    match steam_import::load_library() {
        Some(lib) => println!("  Steam: {} games imported", lib.games.len()),
        None => println!("  Steam: no games imported yet"),
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
        .with_prompt("Your SteamID64 or steamcommunity.com/profiles/… URL (optional)")
        .default(cfg.steam.steam_id.clone().unwrap_or_default())
        .allow_empty(true)
        .interact_text()?;
    let who = who.trim();
    if who.is_empty() {
        cfg.steam.steam_id = None;
    } else if cfg.steam.steam_id.as_deref() != Some(who) {
        match (steam_import::parse_steam_id(who), Keys::resolve().steam) {
            (Some(id), _) => cfg.steam.steam_id = Some(id),
            (None, Some(key)) => match steam::resolve_steam_id(&net, key.value(), who) {
                Ok(id) => {
                    println!("  {} SteamID64 {id}", style("✓").green());
                    cfg.steam.steam_id = Some(id);
                }
                Err(e) => println!("  {} {e}", style("!").yellow()),
            },
            (None, None) => println!("  {}", style("Paste a SteamID64 or a /profiles/ URL (custom /id/ names need a key).").yellow()),
        }
    }

    if Confirm::with_theme(&theme)
        .with_prompt("Import your games from Steam on this PC now?")
        .default(steam_import::load_library().is_none())
        .interact()?
    {
        import_steam(&theme, &net, &cfg)?;
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
