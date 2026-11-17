//! Everything that needs the network. Each source fails soft: a note, never a crash.

pub mod steam;
pub mod youtube;

use crate::{config::Config, model::Suggestion, net::HttpNet, weather::{self, Weather}};
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
    pub weather: Option<Weather>,
    pub items: Vec<Suggestion>,
    pub notes: Vec<Note>,
}

/// Fetches weather, Steam and YouTube in parallel.
pub fn fetch_online(cfg: &Config) -> Online {
    let net = match HttpNet::new() {
        Ok(a) => a,
        Err(e) => {
            return Online {
                notes: vec![Note::problem(format!("Online sources disabled: TLS setup failed ({e})."))],
                ..Default::default()
            }
        }
    };
    std::thread::scope(|s| {
        let w = s.spawn(|| cfg.location().map(|(lat, lon, place)| weather::fetch(&net, lat, lon, &place)));
        let st = s.spawn(|| {
            let mut notes = Vec::new();
            (steam::suggestions(&net, cfg, &mut notes), notes)
        });
        let yt = s.spawn(|| {
            let mut notes = Vec::new();
            (youtube::suggestions(&net, cfg, &mut notes), notes)
        });

        let mut out = Online::default();
        match w.join().unwrap_or(None) {
            Some(Ok(w)) => out.weather = Some(w),
            Some(Err(e)) => out.notes.push(Note::problem(format!("Weather unavailable ({e})."))),
            None => out.notes.push(Note::tip("Set your city so outdoor ideas follow the weather.")),
        }
        for handle in [st, yt] {
            if let Ok((items, notes)) = handle.join() {
                out.items.extend(items);
                out.notes.extend(notes);
            }
        }
        out
    })
}
