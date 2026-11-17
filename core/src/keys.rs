//! API keys, found without asking. Lookup order for each key:
//! 1. the process environment,
//! 2. a `.env` file: the workspace's, then the one in the config folder (`%APPDATA%\freetime`),
//! 3. the value baked in at build time (`build.rs` reads the workspace `.env`).
//!
//! Key values are never logged or shown: `Debug` redacts them and the UI only gets "set" / "not set".

use crate::config;
use anyhow::Result;
use serde::Serialize;
use std::{
    fmt, fs,
    path::{Path, PathBuf},
};

pub const STEAM: &str = "STEAM_API_KEY";
pub const YOUTUBE: &str = "YOUTUBE_API_KEY";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    Environment,
    WorkspaceEnvFile,
    UserEnvFile,
    BuildTime,
}

impl KeySource {
    pub fn label(self) -> &'static str {
        match self {
            KeySource::Environment => "environment variable",
            KeySource::WorkspaceEnvFile => "project .env file",
            KeySource::UserEnvFile => "saved in freetime",
            KeySource::BuildTime => "built into this copy",
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct Key {
    value: String,
    pub source: KeySource,
}

impl Key {
    pub fn new(value: impl Into<String>, source: KeySource) -> Key {
        Key { value: value.into(), source }
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Key").field("value", &"<redacted>").field("source", &self.source).finish()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Keys {
    pub steam: Option<Key>,
    pub youtube: Option<Key>,
}

impl Keys {
    pub fn resolve() -> Keys {
        let workspace = read_env_file(&workspace_env_path());
        let user = read_env_file(&user_env_path());
        let files = [(KeySource::WorkspaceEnvFile, workspace.as_slice()), (KeySource::UserEnvFile, user.as_slice())];
        let pick = |name: &str| resolve_key(name, std::env::var(name).ok(), &files, built_in(name));
        Keys { steam: pick(STEAM), youtube: pick(YOUTUBE) }
    }
}

/// The `.env` at the root of the workspace this copy was built from.
pub fn workspace_env_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap_or(Path::new(".")).join(".env")
}

/// `%APPDATA%\freetime\.env`: where keys typed in the settings are saved.
pub fn user_env_path() -> PathBuf {
    config::config_dir().join(".env")
}

fn built_in(name: &str) -> Option<&'static str> {
    match name {
        STEAM => option_env!("STEAM_API_KEY"),
        YOUTUBE => option_env!("YOUTUBE_API_KEY"),
        _ => None,
    }
}

/// The first non-empty value: environment, then each `.env` file in order, then build time.
/// An empty value (`STEAM_API_KEY=`) counts as unset.
pub fn resolve_key(
    name: &str,
    env: Option<String>,
    files: &[(KeySource, &[(String, String)])],
    built: Option<&str>,
) -> Option<Key> {
    let clean = |v: &str| Some(v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(v) = env.as_deref().and_then(clean) {
        return Some(Key::new(v, KeySource::Environment));
    }
    for (source, vars) in files {
        // The last assignment in a file wins, like a shell would read it.
        if let Some(v) = vars.iter().rev().find(|(k, _)| k == name).and_then(|(_, v)| clean(v)) {
            return Some(Key::new(v, *source));
        }
    }
    built.and_then(clean).map(|v| Key::new(v, KeySource::BuildTime))
}

/// `KEY=value` lines; `#` comments, `export` prefixes and quotes are handled.
pub fn parse_env(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let line = line.strip_prefix("export ").unwrap_or(line);
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            let value = value.trim();
            let quoted = value.len() >= 2
                && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')));
            let value = if quoted {
                &value[1..value.len() - 1]
            } else {
                value.split(" #").next().unwrap_or("").trim()
            };
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

fn read_env_file(path: &Path) -> Vec<(String, String)> {
    fs::read_to_string(path).map(|t| parse_env(&t)).unwrap_or_default()
}

/// Saves a key typed in the settings to `%APPDATA%\freetime\.env` (None removes it).
pub fn save_user_key(name: &str, value: Option<&str>) -> Result<()> {
    let path = user_env_path();
    let text = fs::read_to_string(&path).unwrap_or_default();
    fs::create_dir_all(config::config_dir())?;
    fs::write(&path, upsert(&text, name, value))?;
    Ok(())
}

/// Replaces (or removes) one assignment and keeps every other line as it was.
fn upsert(text: &str, name: &str, value: Option<&str>) -> String {
    let mut lines: Vec<&str> = text
        .lines()
        .filter(|line| {
            let t = line.trim();
            let t = t.strip_prefix("export ").unwrap_or(t);
            !t.split_once('=').is_some_and(|(k, _)| k.trim() == name)
        })
        .collect();
    let assignment = value.map(str::trim).filter(|v| !v.is_empty()).map(|v| format!("{name}={v}"));
    if let Some(a) = &assignment {
        lines.push(a);
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(text: &str) -> Vec<(String, String)> {
        parse_env(text)
    }

    #[test]
    fn parses_env_files() {
        let v = vars("# keys\nexport STEAM_API_KEY = \"abc 123\"\nYOUTUBE_API_KEY=xyz # inline comment\nEMPTY=\n=nokey\nnot a line\n");
        assert_eq!(
            v,
            vec![
                ("STEAM_API_KEY".to_string(), "abc 123".to_string()),
                ("YOUTUBE_API_KEY".to_string(), "xyz".to_string()),
                ("EMPTY".to_string(), String::new()),
            ]
        );
    }

    #[test]
    fn resolution_order_env_then_files_then_build_time() {
        let workspace = vars("STEAM_API_KEY=from-workspace");
        let user = vars("STEAM_API_KEY=from-user");
        let files = [(KeySource::WorkspaceEnvFile, workspace.as_slice()), (KeySource::UserEnvFile, user.as_slice())];

        let k = resolve_key(STEAM, Some("from-env".into()), &files, Some("from-build")).unwrap();
        assert_eq!((k.value(), k.source), ("from-env", KeySource::Environment));

        let k = resolve_key(STEAM, None, &files, Some("from-build")).unwrap();
        assert_eq!((k.value(), k.source), ("from-workspace", KeySource::WorkspaceEnvFile));

        let k = resolve_key(STEAM, None, &files[1..], Some("from-build")).unwrap();
        assert_eq!((k.value(), k.source), ("from-user", KeySource::UserEnvFile));

        let k = resolve_key(STEAM, None, &[], Some("from-build")).unwrap();
        assert_eq!((k.value(), k.source), ("from-build", KeySource::BuildTime));

        assert_eq!(resolve_key(STEAM, None, &[], None), None);
    }

    #[test]
    fn empty_values_count_as_unset() {
        let example = vars("STEAM_API_KEY=\nYOUTUBE_API_KEY=");
        let user = vars("STEAM_API_KEY=real");
        let files = [(KeySource::WorkspaceEnvFile, example.as_slice()), (KeySource::UserEnvFile, user.as_slice())];
        let k = resolve_key(STEAM, Some("  ".into()), &files, Some("")).unwrap();
        assert_eq!(k.source, KeySource::UserEnvFile);
        assert_eq!(resolve_key(YOUTUBE, None, &files, Some("")), None);
    }

    #[test]
    fn last_assignment_in_a_file_wins() {
        let file = vars("STEAM_API_KEY=old\nSTEAM_API_KEY=new");
        let k = resolve_key(STEAM, None, &[(KeySource::UserEnvFile, file.as_slice())], None).unwrap();
        assert_eq!(k.value(), "new");
    }

    #[test]
    fn debug_output_never_shows_the_value() {
        let k = Key::new("super-secret", KeySource::Environment);
        let shown = format!("{k:?} {:?}", Keys { steam: Some(k.clone()), youtube: None });
        assert!(!shown.contains("super-secret"), "{shown}");
    }

    #[test]
    fn saving_keeps_other_lines() {
        let text = "# mine\nOTHER=1\nSTEAM_API_KEY=old\n";
        assert_eq!(upsert(text, STEAM, Some(" new ")), "# mine\nOTHER=1\nSTEAM_API_KEY=new\n");
        assert_eq!(upsert(text, STEAM, None), "# mine\nOTHER=1\n");
        assert_eq!(upsert("", YOUTUBE, Some("k")), "YOUTUBE_API_KEY=k\n");
        assert_eq!(upsert("", YOUTUBE, Some("  ")), "");
    }
}
