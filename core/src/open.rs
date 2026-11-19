//! Opens links and folders with the system's default handler.

use anyhow::{bail, Context, Result};
use std::{path::Path, process::Command};

/// Whether a link may be opened: secure web pages, and "launch this Steam game" by number.
/// Nothing else: links can come from online sources (stores, videos, the assistant, a friend's
/// invite), and other schemes (file:, plain http:, other steam:// commands) could do more than
/// show a page.
pub fn allowed_link(url: &str) -> bool {
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) || url.len() > 2048 {
        return false;
    }
    if let Some(rest) = url.strip_prefix("https://") {
        // A host is required ("https:///x" or "https://" alone are not pages).
        return rest.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    }
    url.strip_prefix("steam://rungameid/").is_some_and(|id| !id.is_empty() && id.len() <= 12 && id.bytes().all(|b| b.is_ascii_digit()))
}

pub fn open_link(url: &str) -> Result<()> {
    if !allowed_link(url) {
        bail!("refusing to open {url:?}: only secure web pages and Steam games are allowed");
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
    use super::allowed_link;

    #[test]
    fn only_secure_pages_and_steam_games() {
        for ok in ["https://youtu.be/abc", "https://store.steampowered.com/app/620/", "steam://rungameid/570"] {
            assert!(allowed_link(ok), "{ok}");
        }
        for bad in [
            "http://example.com",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "steam://open/console",
            "steam://rungameid/570 -console",
            "steam://rungameid/",
            "steam://install/570",
            "https://",
            "https:///etc/passwd",
            "https://a.com/\nnext",
            "ms-settings:privacy",
            r"C:\Windows\notepad.exe",
        ] {
            assert!(!allowed_link(bad), "{bad}");
        }
    }
}
