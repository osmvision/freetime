//! Opens links and folders with the system's default handler.

use anyhow::{bail, Context, Result};
use std::{path::Path, process::Command};

/// Secure web pages, and Steam's "launch this game" links. Nothing else: the URLs come from
/// online sources (store data, video feeds), and the system would hand any other scheme, or a
/// Steam link that does something other than launching a game, to whatever program registered it.
pub fn is_allowed(url: &str) -> bool {
    if url.chars().any(char::is_control) {
        return false;
    }
    if let Some(rest) = url.strip_prefix("https://") {
        return rest.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    }
    url.strip_prefix("steam://rungameid/").is_some_and(|id| !id.is_empty() && id.len() <= 12 && id.bytes().all(|b| b.is_ascii_digit()))
}

/// Opens a link that passes [`is_allowed`] with the system's default handler.
pub fn open_link(url: &str) -> Result<()> {
    if !is_allowed(url) {
        bail!("refusing to open {url:?}: only https and Steam game links are allowed");
    }
    // rundll32 instead of `cmd /C start`: cmd would split URLs on `&`.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map(|_| ()).context("couldn't open the link")
}

pub fn open_folder(path: &Path) -> Result<()> {
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    Command::new(program).arg(path).spawn().map(|_| ()).context("couldn't open the folder")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_https_and_steam_game_links_only() {
        for ok in [
            "https://store.steampowered.com/app/570",
            "https://www.youtube.com/results?search_query=origami+tutorial&sp=EgIQAQ%3D%3D",
            "https://youtu.be/abc123DEF45",
            "steam://rungameid/570",
        ] {
            assert!(is_allowed(ok), "{ok}");
        }
        for bad in [
            "http://example.com",
            "HTTPS://example.com",
            "https://",
            "https:// space.example",
            "steam://install/570",
            "steam://run/570",
            "steam://rungameid/",
            "steam://rungameid/570/extra",
            "steam://rungameid/570 -applaunch",
            "steam://rungameid/1234567890123",
            "steam://",
            "file:///C:/Windows/System32/calc.exe",
            "ms-msdt:/id PCWDiagnostic",
            "javascript:alert(1)",
            "https://example.com/\nnext",
            "\\\\server\\share\\app.exe",
            "calc.exe",
            "",
        ] {
            assert!(!is_allowed(bad), "{bad:?}");
        }
    }

    #[test]
    fn open_link_refuses_before_running_anything() {
        let e = open_link("steam://install/570").unwrap_err().to_string();
        assert!(e.contains("only https and Steam game links"), "{e}");
    }
}
