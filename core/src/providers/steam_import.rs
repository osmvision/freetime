//! "Import my games from Steam on this PC": runs only when the user asks, never at startup.
//!
//! The only things it touches:
//! - the registry value `HKCU\Software\Valve\Steam\SteamPath` (else the default install folder),
//! - the folder names under `<Steam>\userdata\` (account IDs: the folders are not opened),
//! - `<Steam>\steamapps\libraryfolders.vdf`,
//! - `<library>\steamapps\appmanifest_<appid>.acf` (installed games),
//! - `<Steam>\userdata\<accountId>\config\localconfig.vdf` (playtime only).
//!
//! Nothing in `<Steam>\config\` and no `ssfn*` file is ever opened: every read goes through
//! [`read_allowed`], which checks [`is_allowed`]. The result is saved to freetime's own cache, so
//! later launches never touch Steam's files again (re-import on demand).

use super::steam::OwnedGame;
use crate::{
    config,
    net::Net,
    vdf::{self, Vdf},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

/// SteamID64 = account ID + this.
pub const STEAMID64_BASE: u64 = 76_561_197_960_265_728;

/// An account that used Steam on this PC (from its `userdata` folder name).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalAccount {
    pub account_id: u32,
    pub steam_id64: String,
    /// When the account's folder last changed (Unix time), to help pick the right one.
    pub last_used: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryGame {
    pub appid: u32,
    pub name: String,
    pub installed: bool,
    /// Minutes played, all time.
    pub playtime: u32,
    /// Minutes played in the last two weeks.
    pub playtime_2weeks: u32,
    /// Unix time, 0 = unknown or never.
    pub last_played: i64,
}

/// What was imported, saved in freetime's own cache (`steam_library.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Library {
    pub steam_id64: String,
    pub games: Vec<LibraryGame>,
    /// Unix time of the import.
    pub imported_at: i64,
    /// Playtime came with the import (localconfig.vdf or the Web API).
    pub playtime_known: bool,
    /// The game list came from the Steam Web API (needs a key), not just this PC.
    pub from_web_api: bool,
}

// ---------------------------------------------------------------- where Steam is

/// The registry's SteamPath, else the default install folder.
pub fn steam_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Some(p) = registry_steam_path() {
            candidates.push(p);
        }
        candidates.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    }
    #[cfg(not(windows))]
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".steam/steam"));
        candidates.push(home.join(".local/share/Steam"));
        candidates.push(home.join("Library/Application Support/Steam"));
    }
    candidates.into_iter().find(|p| p.join("steamapps").is_dir())
}

#[cfg(windows)]
fn registry_steam_path() -> Option<PathBuf> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam").ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    let path = path.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Accounts from the folder names under `<Steam>\userdata\`, most recently used first.
pub fn accounts(root: &Path) -> Vec<LocalAccount> {
    let Ok(entries) = list_allowed(root, &root.join("userdata")) else { return Vec::new() };
    let mut out: Vec<LocalAccount> = entries
        .into_iter()
        .filter(|(_, is_dir)| *is_dir)
        .filter_map(|(path, _)| {
            let account_id: u32 = path.file_name()?.to_str()?.parse().ok().filter(|id| *id > 0)?;
            let last_used = fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            Some(LocalAccount { account_id, steam_id64: steam_id64(account_id), last_used })
        })
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.last_used));
    out
}

pub fn steam_id64(account_id: u32) -> String {
    (account_id as u64 + STEAMID64_BASE).to_string()
}

/// SteamID64 → the account ID used for the `userdata` folder.
pub fn account_id(steam_id64: &str) -> Option<u32> {
    let id: u64 = steam_id64.trim().parse().ok()?;
    u32::try_from(id.checked_sub(STEAMID64_BASE)?).ok()
}

/// A pasted SteamID64 or `steamcommunity.com/profiles/<id>` URL. Custom `/id/<name>` URLs need
/// the Web API to resolve, so they return None here.
pub fn parse_steam_id(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('/');
    let candidate = match s.find("/profiles/") {
        Some(i) => s[i + "/profiles/".len()..].split(['/', '?', '#']).next()?,
        None => s,
    };
    (candidate.len() == 17 && candidate.starts_with("7656119") && candidate.bytes().all(|b| b.is_ascii_digit()))
        .then(|| candidate.to_string())
}

// ---------------------------------------------------------------- the allow-list

fn norm(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// `..` anywhere, whatever the separator: such a path could point anywhere.
fn has_parent_dir(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir)) || norm(path).split('/').any(|seg| seg == "..")
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// The only files the import may open (`root` is the Steam folder).
pub fn is_allowed(root: &Path, path: &Path) -> bool {
    if has_parent_dir(path) {
        return false;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_lowercase) else { return false };
    let full = norm(path);
    let root = norm(root);
    if name.starts_with("ssfn") || full.starts_with(&format!("{root}/config/")) {
        return false;
    }
    let parent = path.parent().map(norm).unwrap_or_default();
    if name == "libraryfolders.vdf" {
        return parent == format!("{root}/steamapps");
    }
    if let Some(id) = name.strip_prefix("appmanifest_").and_then(|r| r.strip_suffix(".acf")) {
        return is_digits(id) && parent.ends_with("/steamapps");
    }
    if name == "localconfig.vdf" {
        let Some(rest) = parent.strip_prefix(&format!("{root}/userdata/")) else { return false };
        return rest.strip_suffix("/config").is_some_and(is_digits);
    }
    false
}

/// The only folders the import may list: `<Steam>\userdata` and a library's `steamapps`.
pub fn is_allowed_dir(root: &Path, dir: &Path) -> bool {
    if has_parent_dir(dir) {
        return false;
    }
    let d = norm(dir);
    let root = norm(root);
    d == format!("{root}/userdata") || (d.ends_with("/steamapps") && !d.starts_with(&format!("{root}/config/")))
}

/// Reads a file only if [`is_allowed`] says so.
fn read_allowed(root: &Path, path: &Path) -> Result<String> {
    if !is_allowed(root, path) {
        bail!("refusing to read {}", path.display());
    }
    fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

/// Lists a folder only if [`is_allowed_dir`] says so: (path, is_dir) for each entry.
fn list_allowed(root: &Path, dir: &Path) -> Result<Vec<(PathBuf, bool)>> {
    if !is_allowed_dir(root, dir) {
        bail!("refusing to list {}", dir.display());
    }
    Ok(fs::read_dir(dir)?
        .flatten()
        .map(|e| (e.path(), e.file_type().map(|t| t.is_dir()).unwrap_or(false)))
        .collect())
}

// ---------------------------------------------------------------- the import

/// Installed games and their playtime for one account of this PC.
pub fn import_local(root: &Path, account_id: u32, now: i64) -> Result<Library> {
    let mut libraries = vec![root.to_path_buf()];
    if let Ok(text) = read_allowed(root, &root.join("steamapps").join("libraryfolders.vdf")) {
        for lib in parse_libraryfolders(&text) {
            if !libraries.iter().any(|l| norm(l) == norm(&lib)) {
                libraries.push(lib);
            }
        }
    }

    let mut games: Vec<LibraryGame> = Vec::new();
    for lib in &libraries {
        let Ok(entries) = list_allowed(root, &lib.join("steamapps")) else { continue };
        for (path, is_dir) in entries {
            if is_dir || !is_allowed(root, &path) {
                continue;
            }
            let Some((appid, name)) = read_allowed(root, &path).ok().and_then(|t| parse_appmanifest(&t)) else {
                continue;
            };
            if !games.iter().any(|g| g.appid == appid) {
                games.push(LibraryGame { appid, name, installed: true, playtime: 0, playtime_2weeks: 0, last_played: 0 });
            }
        }
    }

    let localconfig = root.join("userdata").join(account_id.to_string()).join("config").join("localconfig.vdf");
    let playtime = read_allowed(root, &localconfig).ok().map(|t| parse_localconfig(&t));
    if let Some(playtime) = &playtime {
        for game in &mut games {
            if let Some(p) = playtime.get(&game.appid) {
                game.playtime = p.minutes;
                game.playtime_2weeks = p.two_weeks;
                game.last_played = p.last_played;
            }
        }
    }
    games.sort_by_key(|g| g.name.to_lowercase());
    Ok(Library {
        steam_id64: steam_id64(account_id),
        games,
        imported_at: now,
        playtime_known: playtime.is_some(),
        from_web_api: false,
    })
}

/// The owned-games list from the Web API (needs a key), with "installed" taken from a local import.
pub fn from_owned(steam_id64: &str, owned: Vec<OwnedGame>, local: Option<&Library>, now: i64) -> Library {
    let installed = |appid: u32| local.is_some_and(|l| l.games.iter().any(|g| g.appid == appid && g.installed));
    let mut games: Vec<LibraryGame> = owned
        .into_iter()
        .map(|g| LibraryGame {
            installed: installed(g.appid),
            appid: g.appid,
            name: g.name,
            playtime: g.playtime_forever,
            playtime_2weeks: g.playtime_2weeks,
            last_played: g.rtime_last_played,
        })
        .collect();
    games.sort_by_key(|g| g.name.to_lowercase());
    Library { steam_id64: steam_id64.to_string(), games, imported_at: now, playtime_known: true, from_web_api: true }
}

/// Every library folder listed in `libraryfolders.vdf` (old and new formats).
pub fn parse_libraryfolders(text: &str) -> Vec<PathBuf> {
    let Ok(root) = vdf::parse(text) else { return Vec::new() };
    let Some(folders) = root.get("libraryfolders") else { return Vec::new() };
    folders
        .entries()
        .iter()
        .filter(|(key, _)| is_digits(key))
        .filter_map(|(_, v)| match v {
            Vdf::Str(path) => Some(path.clone()),
            Vdf::Obj(_) => v.str("path").map(String::from),
        })
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

/// (appid, name) of an installed game; tools like redistributables and Proton are skipped.
pub fn parse_appmanifest(text: &str) -> Option<(u32, String)> {
    let root = vdf::parse(text).ok()?;
    let app = root.get("AppState")?;
    let appid: u32 = app.str("appid")?.trim().parse().ok()?;
    let name = app.str("name")?.trim().to_string();
    if name.is_empty() || is_tool(appid, &name) {
        return None;
    }
    Some((appid, name))
}

fn is_tool(appid: u32, name: &str) -> bool {
    const TOOLS: [u32; 2] = [228980, 1070560];
    TOOLS.contains(&appid)
        || ["Proton", "Steam Linux Runtime", "Steamworks", "SteamVR", "Steam Audio"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Playtime {
    pub minutes: u32,
    pub two_weeks: u32,
    pub last_played: i64,
}

/// Playtime per app: `UserLocalConfigStore/Software/Valve/Steam/apps/<appid>`. Nothing else is kept.
pub fn parse_localconfig(text: &str) -> HashMap<u32, Playtime> {
    let Ok(root) = vdf::parse(text) else { return HashMap::new() };
    let apps = ["UserLocalConfigStore", "Software", "Valve", "Steam", "apps"]
        .iter()
        .try_fold(&root, |node, key| node.get(key));
    let Some(apps) = apps else { return HashMap::new() };
    let num = |app: &Vdf, key: &str| app.str(key).and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
    apps.entries()
        .iter()
        .filter_map(|(id, app)| {
            let appid: u32 = id.parse().ok()?;
            let p = Playtime {
                minutes: num(app, "Playtime").max(0) as u32,
                two_weeks: num(app, "Playtime2wks").max(0) as u32,
                last_played: num(app, "LastPlayed"),
            };
            (p != Playtime::default()).then_some((appid, p))
        })
        .collect()
}

/// What "Import my games" does for one account: the games installed on this PC (with playtime),
/// plus the full owned list from the Web API when a key is set. Saved to freetime's cache.
pub fn run_import(net: &dyn Net, key: Option<&str>, steam_id64: &str, now: i64) -> Result<(Library, Vec<String>)> {
    let account = account_id(steam_id64).context("that isn't a SteamID64")?;
    let local = match steam_root() {
        Some(root) => Some(import_local(&root, account, now)?),
        None => None,
    };
    let mut notes = Vec::new();
    if let Some(key) = key {
        match super::steam::owned_games(net, key, steam_id64) {
            Ok(owned) if !owned.is_empty() => {
                let library = from_owned(steam_id64, owned, local.as_ref(), now);
                save_library(&library)?;
                return Ok((library, notes));
            }
            Ok(_) => notes.push(
                "Your Steam game details are private, so only the games installed on this PC were imported (Steam: Profile → Privacy).".to_string(),
            ),
            Err(e) => notes.push(format!("Steam Web API unavailable ({e}): only the games installed on this PC were imported.")),
        }
    }
    let library = local.context(
        "Steam isn't installed on this PC. With a Steam Web API key, your games can be imported from your account instead.",
    )?;
    save_library(&library)?;
    Ok((library, notes))
}

// ---------------------------------------------------------------- freetime's own cache

pub fn library_path() -> PathBuf {
    config::data_dir().join("steam_library.json")
}

pub fn load_library() -> Option<Library> {
    serde_json::from_str(&fs::read_to_string(library_path()).ok()?).ok()
}

pub fn save_library(lib: &Library) -> Result<()> {
    fs::create_dir_all(config::data_dir())?;
    fs::write(library_path(), serde_json::to_string_pretty(lib)?)?;
    Ok(())
}

pub fn forget_library() -> Result<()> {
    match fs::remove_file(library_path()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARYFOLDERS: &str = include_str!("../../fixtures/libraryfolders.vdf");
    const APPMANIFEST: &str = include_str!("../../fixtures/appmanifest_570.acf");
    const LOCALCONFIG: &str = include_str!("../../fixtures/localconfig.vdf");

    #[test]
    fn only_the_listed_files_are_allowed() {
        let root = Path::new(r"C:\Program Files (x86)\Steam");
        let allowed = [
            r"C:\Program Files (x86)\Steam\steamapps\libraryfolders.vdf",
            r"C:\Program Files (x86)\Steam\steamapps\appmanifest_570.acf",
            r"D:\SteamLibrary\steamapps\appmanifest_1145360.acf",
            r"C:\Program Files (x86)\Steam\userdata\12345678\config\localconfig.vdf",
            r"c:/program files (x86)/steam/userdata/12345678/config/localconfig.vdf",
        ];
        let refused = [
            r"C:\Program Files (x86)\Steam\config\loginusers.vdf",
            r"C:\Program Files (x86)\Steam\config\config.vdf",
            r"C:\Program Files (x86)\Steam\config\DialogConfig.vdf",
            r"C:\Program Files (x86)\Steam\config\steamapps\appmanifest_570.acf",
            r"C:\Program Files (x86)\Steam\ssfn1234567890",
            r"C:\Program Files (x86)\Steam\steamapps\ssfn_appmanifest_1.acf",
            r"C:\Program Files (x86)\Steam\userdata\12345678\7\remote\sharedconfig.vdf",
            r"C:\Program Files (x86)\Steam\userdata\12345678\config\shortcuts.vdf",
            r"C:\Program Files (x86)\Steam\userdata\abc\config\localconfig.vdf",
            r"C:\Program Files (x86)\Steam\userdata\12345678\..\..\config\loginusers.vdf",
            r"C:\Program Files (x86)\Steam\steamapps\appmanifest_x.acf",
            r"C:\Program Files (x86)\Steam\steamapps\common\Game\appmanifest_1.acf",
            r"D:\SteamLibrary\libraryfolders.vdf",
            r"C:\Program Files (x86)\Steam\registry.vdf",
        ];
        for p in allowed {
            assert!(is_allowed(root, Path::new(p)), "should be allowed: {p}");
        }
        for p in refused {
            assert!(!is_allowed(root, Path::new(p)), "should be refused: {p}");
        }
        assert!(is_allowed_dir(root, &root.join("userdata")));
        assert!(is_allowed_dir(root, Path::new(r"D:\SteamLibrary\steamapps")));
        assert!(!is_allowed_dir(root, &root.join("config")));
        assert!(!is_allowed_dir(root, root));
        assert!(!is_allowed_dir(root, &root.join("userdata").join("123")));
    }

    #[test]
    fn steam_ids_from_folder_names_and_pasted_text() {
        assert_eq!(steam_id64(52079950), "76561198012345678");
        assert_eq!(account_id("76561198012345678"), Some(52079950));
        assert_eq!(account_id("123"), None);
        assert_eq!(parse_steam_id(" 76561198012345678 ").as_deref(), Some("76561198012345678"));
        assert_eq!(
            parse_steam_id("https://steamcommunity.com/profiles/76561198012345678/").as_deref(),
            Some("76561198012345678")
        );
        assert_eq!(parse_steam_id("https://steamcommunity.com/id/someone"), None);
        assert_eq!(parse_steam_id("12345"), None);
    }

    #[test]
    fn parses_steam_files() {
        assert_eq!(
            parse_libraryfolders(LIBRARYFOLDERS),
            vec![PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"D:\SteamLibrary")]
        );
        let old = r#""LibraryFolders" { "TimeNextStatsReport" "1" "1" "E:\\Games\\Steam" }"#;
        assert_eq!(parse_libraryfolders(old), vec![PathBuf::from(r"E:\Games\Steam")]);
        assert_eq!(parse_appmanifest(APPMANIFEST), Some((570, "Dota 2".to_string())));
        assert_eq!(parse_appmanifest(r#""AppState" { "appid" "228980" "name" "Steamworks Common Redistributables" }"#), None);

        let playtime = parse_localconfig(LOCALCONFIG);
        assert_eq!(playtime[&570], Playtime { minutes: 4200, two_weeks: 95, last_played: 1_731_000_000 });
        assert_eq!(playtime[&413150].minutes, 30);
        assert!(!playtime.contains_key(&999), "apps without playtime are left out");
    }

    /// A fake Steam folder with a trap: files the import must never open.
    fn fake_steam(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("freetime-import-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("Steam");
        let second = base.join("SteamLibrary");
        for dir in [
            root.join("steamapps"),
            root.join("config"),
            root.join("userdata/52079950/config"),
            root.join("userdata/0"),
            root.join("userdata/anonymous"),
            second.join("steamapps"),
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        let escaped = |p: &Path| p.display().to_string().replace('\\', "\\\\");
        let folders = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}",
            escaped(&root),
            escaped(&second)
        );
        fs::write(root.join("steamapps/libraryfolders.vdf"), folders).unwrap();
        fs::write(root.join("steamapps/appmanifest_570.acf"), APPMANIFEST).unwrap();
        fs::write(second.join("steamapps/appmanifest_413150.acf"), r#""AppState" { "appid" "413150" "name" "Stardew Valley" }"#).unwrap();
        fs::write(root.join("userdata/52079950/config/localconfig.vdf"), LOCALCONFIG).unwrap();
        fs::write(root.join("config/loginusers.vdf"), "TRAP").unwrap();
        fs::write(root.join("ssfn123"), "TRAP").unwrap();
        (base, root)
    }

    #[test]
    fn imports_installed_games_with_playtime() {
        let (base, root) = fake_steam("games");
        let accounts = accounts(&root);
        let library = import_local(&root, 52079950, 1_731_100_000).unwrap();
        let _ = fs::remove_dir_all(&base);

        assert_eq!(accounts.len(), 1, "0 and non-numeric folders aren't accounts");
        assert_eq!(accounts[0].steam_id64, "76561198012345678");
        assert_eq!(library.steam_id64, "76561198012345678");
        assert!(library.playtime_known);
        let names: Vec<&str> = library.games.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["Dota 2", "Stardew Valley"]);
        assert_eq!(library.games[0].playtime, 4200);
        assert!(library.games.iter().all(|g| g.installed));
    }

    #[test]
    fn forbidden_files_cant_be_read_even_on_purpose() {
        let (base, root) = fake_steam("trap");
        let trap = read_allowed(&root, &root.join("config/loginusers.vdf"));
        let ssfn = read_allowed(&root, &root.join("ssfn123"));
        let listing = list_allowed(&root, &root.join("config"));
        let _ = fs::remove_dir_all(&base);
        assert!(trap.is_err() && ssfn.is_err() && listing.is_err());
    }

    #[test]
    fn web_api_list_keeps_installed_flags() {
        let local = Library {
            steam_id64: "76561198012345678".into(),
            games: vec![LibraryGame { appid: 570, name: "Dota 2".into(), installed: true, playtime: 0, playtime_2weeks: 0, last_played: 0 }],
            imported_at: 1,
            playtime_known: false,
            from_web_api: false,
        };
        let owned = vec![
            OwnedGame { appid: 570, name: "Dota 2".into(), playtime_forever: 4200, playtime_2weeks: 0, rtime_last_played: 5 },
            OwnedGame { appid: 10, name: "Counter-Strike".into(), playtime_forever: 0, playtime_2weeks: 0, rtime_last_played: 0 },
        ];
        let lib = from_owned("76561198012345678", owned, Some(&local), 2);
        assert!(lib.from_web_api && lib.playtime_known);
        assert!(lib.games.iter().find(|g| g.appid == 570).unwrap().installed);
        assert!(!lib.games.iter().find(|g| g.appid == 10).unwrap().installed);
    }
}
