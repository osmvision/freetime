//! Bakes STEAM_API_KEY and YOUTUBE_API_KEY from the workspace `.env` into the build, so
//! `cargo run` picks them up with no extra step (read at runtime with `option_env!`).
//! Only those two keys are read; nothing is printed except to cargo.

use std::{env, fs, path::PathBuf};

const KEYS: [&str; 2] = ["STEAM_API_KEY", "YOUTUBE_API_KEY"];

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("set by cargo"));
    let dotenv = manifest.parent().expect("core/ sits in the workspace").join(".env");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", dotenv.display());

    let Ok(text) = fs::read_to_string(&dotenv) else { return };
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if !KEYS.contains(&key) {
            continue;
        }
        let value = value.trim();
        let quoted = value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')));
        let value = if quoted { &value[1..value.len() - 1] } else { value.split(" #").next().unwrap_or("").trim() };
        if !value.is_empty() && !value.contains(['\n', '\r']) {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}
