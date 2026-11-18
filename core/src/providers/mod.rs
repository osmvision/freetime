//! Everything that needs the network. Each source fails soft: a note, never a crash.

pub mod epic;
pub mod steam;
pub mod steam_import;
pub mod youtube;

use crate::{
    config::Config,
    keys::Keys,
    location::{self, Location},
    model::Suggestion,
    net::HttpNet,
    weather::{self, Weather},
};
use serde::Serialize;

/// Something worth telling the user about the online sources.
#[derive(Debug, Clone, Serialize)]
pub struct Note {
    /// A tip points to a setting that would make suggestions better; otherwise it's a problem.
    pub tip: bool,
    pub text: String,
}

impl Note {
    pub fn tip(text: impl Into<String>) -> Note {
        Note { tip: true, text: text.into() }
    }

    pub fn problem(text: impl Into<String>) -> Note {
        Note { tip: false, text: text.into() }
    }
}

#[derive(Default)]
pub struct Online {
    pub location: Location,
    pub weather: Option<Weather>,
    pub steam: steam::SteamStatus,
    pub items: Vec<Suggestion>,
    pub notes: Vec<Note>,
}

/// Startup network, all concurrent and visible in the UI: the Open-Meteo forecast for the picked
/// city, the Steam store lists (with the regional `cc`), the Epic Games Store's free games and the
/// YouTube channel feeds.
pub fn fetch_online(cfg: &Config) -> Online {
    let net = match HttpNet::shared() {
        Ok(net) => net,
        Err(e) => {
            return Online {
                notes: vec![Note::problem(format!("Online sources disabled: TLS setup failed ({e})."))],
                ..Default::default()
            }
        }
    };
    let keys = Keys::resolve();
    // Offline: the picked city and the OS regional settings.
    let location = location::current(cfg);
    std::thread::scope(|s| {
        let yt = s.spawn(|| {
            let mut notes = Vec::new();
            (youtube::suggestions(net.as_ref(), cfg, &keys, &mut notes), notes)
        });
        let w = s.spawn(|| {
            location.coords().map(|(lat, lon)| weather::fetch(net.as_ref(), lat, lon, &location.label()))
        });
        let st = s.spawn(|| {
            let mut notes = Vec::new();
            let (items, status) = steam::suggestions(net.as_ref(), &location, &mut notes);
            (items, notes, status)
        });
        let ep = s.spawn(|| {
            let mut notes = Vec::new();
            (epic::free_games(net.as_ref(), &location, chrono::Utc::now(), &mut notes), notes)
        });
        let weather = w.join().unwrap_or(None);
        let steam = st.join();

        let mut out = Online::default();
        match weather {
            Some(Ok(w)) => out.weather = Some(w),
            Some(Err(e)) => out.notes.push(Note::problem(format!("Weather unavailable ({e})."))),
            None => out.notes.push(Note::tip("Add your city to get weather-aware outdoor ideas.")),
        }
        if let Ok((items, notes, status)) = steam {
            out.items.extend(items);
            out.notes.extend(notes);
            out.steam = status;
        }
        if let Ok((items, notes)) = ep.join() {
            out.items.extend(items);
            out.notes.extend(notes);
        }
        if let Ok((items, notes)) = yt.join() {
            out.items.extend(items);
            out.notes.extend(notes);
        }
        out.location = location.clone();
        out
    })
}
