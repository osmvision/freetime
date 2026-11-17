//! Opens links and folders with the system's default handler.

use anyhow::{bail, Context, Result};
use std::{path::Path, process::Command};

/// Only web pages and Steam links: the desktop UI passes URLs that came from online sources.
pub fn open_link(url: &str) -> Result<()> {
    if !["https://", "http://", "steam://"].iter().any(|p| url.starts_with(p)) {
        bail!("refusing to open {url:?}: only web and Steam links are allowed");
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
