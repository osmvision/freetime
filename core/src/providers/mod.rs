//! Everything that needs the network. Each source fails soft: a note, never a crash.

pub mod steam;
pub mod steam_local;
pub mod youtube;

use crate::{
    config::Config,
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

/// Fetches everything concurrently: YouTube right away, the location meanwhile,
/// then the weather and Steam (which need the location) in parallel.
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
    let now = chrono::Utc::now().timestamp();
    std::thread::scope(|s| {
        let yt = s.spawn(|| {
            let mut notes = Vec::new();
            (youtube::suggestions(net.as_ref(), cfg, &mut notes), notes)
        });

        let location = location::resolve(&net, cfg, now);
        let (weather, steam) = std::thread::scope(|s2| {
            let w = s2.spawn(|| {
                location.coords().map(|(lat, lon)| weather::fetch(net.as_ref(), lat, lon, &location.label()))
            });
            let st = s2.spawn(|| {
                let mut notes = Vec::new();
                let (items, status) = steam::suggestions(net.as_ref(), cfg, &location, &mut notes);
                (items, notes, status)
            });
            (w.join().unwrap_or(None), st.join())
        });

        let mut out = Online::default();
        match weather {
            Some(Ok(w)) => out.weather = Some(w),
            Some(Err(e)) => out.notes.push(Note::problem(format!("Weather unavailable ({e})."))),
            None => out.notes.push(Note::tip("Couldn't detect your location: set your city to get the weather.")),
        }
        if let Ok((items, notes, status)) = steam {
            out.items.extend(items);
            out.notes.extend(notes);
            out.steam = status;
        }
        if let Ok((items, notes)) = yt.join() {
            out.items.extend(items);
            out.notes.extend(notes);
        }
        out.location = location;
        out
    })
}
