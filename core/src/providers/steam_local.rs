//! The Steam client installed on this PC: who's logged in and which games are installed.
//! Plain files, no API key needed.

use crate::vdf::{self, Vdf};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Account {
    pub steam_id64: String,
    pub persona_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstalledGame {
    pub appid: u32,
    pub name: String,
}

#[derive(Debug, Clone, Default)]
pub struct LocalSteam {
    /// Where Steam is installed, if it is.
    pub root: Option<PathBuf>,
    /// The account that logged in most recently.
    pub account: Option<Account>,
    pub installed: Vec<InstalledGame>,
}

pub fn detect() -> LocalSteam {
    let Some(root) = steam_root() else { return LocalSteam::default() };
    let account = fs::read_to_string(root.join("config").join("loginusers.vdf"))
        .ok()
        .and_then(|text| parse_loginusers(&text));
    let installed = installed_games(&root);
    LocalSteam { root: Some(root), account, installed }
}

/// The registry's SteamPath, else the default install folder.
pub fn steam_root() -> Option<PathBuf> {
    candidates()
        .into_iter()
        .find(|p| p.join("steamapps").is_dir() || p.join("config").join("loginusers.vdf").is_file())
}

fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        if let Some(p) = registry_steam_path() {
            out.push(p);
        }
        out.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    }
    #[cfg(not(windows))]
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".steam/steam"));
        out.push(home.join(".local/share/Steam"));
        out.push(home.join("Library/Application Support/Steam"));
    }
    out
}

#[cfg(windows)]
fn registry_steam_path() -> Option<PathBuf> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam").ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    let path = path.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// The user marked `MostRecent` = "1" (key matched in any case), else the latest `Timestamp`.
pub fn parse_loginusers(text: &str) -> Option<Account> {
    let root = vdf::parse(text).ok()?;
    let users: Vec<(&String, &Vdf)> = root
        .get("users")?
        .entries()
        .iter()
        .filter(|(id, _)| id.len() == 17 && id.bytes().all(|b| b.is_ascii_digit()))
        .map(|(id, user)| (id, user))
        .collect();
    let timestamp = |u: &Vdf| u.str("Timestamp").and_then(|t| t.trim().parse::<i64>().ok()).unwrap_or(0);
    let (id, user) = users
        .iter()
        .find(|(_, u)| u.str("MostRecent").map(str::trim) == Some("1"))
        .or_else(|| users.iter().max_by_key(|(_, u)| timestamp(u)))?;
    let persona = user
        .str("PersonaName")
        .or_else(|| user.str("AccountName"))
        .unwrap_or("Steam user")
        .to_string();
    Some(Account { steam_id64: id.to_string(), persona_name: persona })
}

/// Every library folder listed in `steamapps/libraryfolders.vdf` (old and new formats).
pub fn parse_libraryfolders(text: &str) -> Vec<PathBuf> {
    let Ok(root) = vdf::parse(text) else { return Vec::new() };
    let Some(folders) = root.get("libraryfolders") else { return Vec::new() };
    folders
        .entries()
        .iter()
        .filter(|(key, _)| key.bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|(_, v)| match v {
            Vdf::Str(path) => Some(path.clone()),
            Vdf::Obj(_) => v.str("path").map(String::from),
        })
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

pub fn parse_appmanifest(text: &str) -> Option<InstalledGame> {
    let root = vdf::parse(text).ok()?;
    let app = root.get("AppState")?;
    let appid: u32 = app.str("appid")?.trim().parse().ok()?;
    let name = app.str("name")?.trim().to_string();
    if name.is_empty() || is_tool(appid, &name) {
        return None;
    }
    Some(InstalledGame { appid, name })
}

/// Redistributables, Proton and runtimes are installed like games, but nobody plays them.
fn is_tool(appid: u32, name: &str) -> bool {
    const TOOLS: [u32; 2] = [228980, 1070560];
    TOOLS.contains(&appid)
        || ["Proton", "Steam Linux Runtime", "Steamworks", "SteamVR", "Steam Audio"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

pub fn installed_games(root: &Path) -> Vec<InstalledGame> {
    let mut libraries = vec![root.to_path_buf()];
    if let Ok(text) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for lib in parse_libraryfolders(&text) {
            if !libraries.iter().any(|l| same_path(l, &lib)) {
                libraries.push(lib);
            }
        }
    }
    let mut games: Vec<InstalledGame> = Vec::new();
    for lib in libraries {
        let Ok(dir) = fs::read_dir(lib.join("steamapps")) else { continue };
        for entry in dir.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if !(file.starts_with("appmanifest_") && file.ends_with(".acf")) {
                continue;
            }
            let Some(game) = fs::read_to_string(entry.path()).ok().and_then(|t| parse_appmanifest(&t)) else {
                continue;
            };
            if !games.iter().any(|g| g.appid == game.appid) {
                games.push(game);
            }
        }
    }
    games.sort_by_key(|g| g.name.to_lowercase());
    games
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOGINUSERS: &str = include_str!("../../fixtures/loginusers.vdf");
    const LIBRARYFOLDERS: &str = include_str!("../../fixtures/libraryfolders.vdf");
    const APPMANIFEST: &str = include_str!("../../fixtures/appmanifest_570.acf");

    #[test]
    fn most_recent_user_matches_the_key_in_any_case() {
        let account = parse_loginusers(LOGINUSERS).unwrap();
        assert_eq!(account.steam_id64, "76561198012345678");
        assert_eq!(account.persona_name, "Player \"One\"");
    }

    #[test]
    fn without_most_recent_the_latest_login_wins() {
        let text = r#""users" {
            "76561197960287930" { "PersonaName" "Older" "Timestamp" "1600000000" }
            "76561197960287931" { "PersonaName" "Newer" "Timestamp" "1700000000" }
            "not-a-steam-id" { "PersonaName" "Nope" "MostRecent" "1" }
        }"#;
        assert_eq!(parse_loginusers(text).unwrap().persona_name, "Newer");
        assert_eq!(parse_loginusers("\"users\" {}"), None);
        assert_eq!(parse_loginusers("garbage {"), None);
    }

    #[test]
    fn library_folders_new_and_old_formats() {
        let paths = parse_libraryfolders(LIBRARYFOLDERS);
        assert_eq!(paths, vec![PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"D:\SteamLibrary")]);

        let old = r#""LibraryFolders" { "TimeNextStatsReport" "1" "ContentStatsID" "2" "1" "E:\\Games\\Steam" }"#;
        assert_eq!(parse_libraryfolders(old), vec![PathBuf::from(r"E:\Games\Steam")]);
    }

    #[test]
    fn app_manifest_gives_id_and_name() {
        assert_eq!(parse_appmanifest(APPMANIFEST), Some(InstalledGame { appid: 570, name: "Dota 2".into() }));
        let redist = r#""AppState" { "appid" "228980" "name" "Steamworks Common Redistributables" }"#;
        assert_eq!(parse_appmanifest(redist), None);
        let proton = r#""AppState" { "appid" "2805730" "name" "Proton 9.0" }"#;
        assert_eq!(parse_appmanifest(proton), None);
    }

    #[test]
    fn walks_every_library_folder() {
        let base = std::env::temp_dir().join(format!("freetime-steam-test-{}", std::process::id()));
        let root = base.join("Steam");
        let second = base.join("SteamLibrary");
        fs::create_dir_all(root.join("steamapps")).unwrap();
        fs::create_dir_all(second.join("steamapps")).unwrap();
        let libraries = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}",
            root.display().to_string().replace('\\', "\\\\"),
            second.display().to_string().replace('\\', "\\\\"),
        );
        fs::write(root.join("steamapps/libraryfolders.vdf"), libraries).unwrap();
        fs::write(root.join("steamapps/appmanifest_570.acf"), APPMANIFEST).unwrap();
        fs::write(
            second.join("steamapps/appmanifest_413150.acf"),
            r#""AppState" { "appid" "413150" "name" "Stardew Valley" }"#,
        )
        .unwrap();
        fs::write(second.join("steamapps/not_a_manifest.txt"), "x").unwrap();

        let games = installed_games(&root);
        let _ = fs::remove_dir_all(&base);
        let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["Dota 2", "Stardew Valley"]);
    }
}
