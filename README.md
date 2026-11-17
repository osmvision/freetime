# freetime

Got free time? freetime picks the best thing to do with it: a game from your Steam library,
a YouTube video that fits the time you have, a sport that suits the weather, or something new
(learn, create, chill, cook, see friends).

Tell it how much time you have, your energy, who's with you, whether you'll go outside and your
budget. It ranks ideas from every source, explains why, and learns from your 👍 / 👎.

## Desktop app (Tauri)

```sh
cargo run -p freetime-desktop          # build and open the app
```

For live reload while editing the UI (`desktop/ui/`), use the Tauri CLI:

```sh
cd desktop
npm install
npm run dev        # tauri dev
npm run build      # installer in target/release/bundle
```

## Terminal app

```sh
cargo run                              # asks a few questions
cargo run -- -m 45 -e high --quick     # flags, no questions
cargo run -- surprise                  # one pick, no questions
cargo run -- setup                     # city, interests, Steam, YouTube
cargo run -- history
```

## Connect your accounts (optional)

Everything works offline with built-in ideas. Connecting sources makes the picks personal:

| Source | What you get | How |
| --- | --- | --- |
| City | Outdoor ideas follow the live weather (Open-Meteo, no key) | Settings → Location |
| Steam | Backlog, old favorites and comfort picks from games you own | [Steam Web API key](https://steamcommunity.com/dev/apikey) + your profile. Game details must be public. |
| YouTube | Real videos that fit your time, from your interests | [YouTube Data API v3 key](https://console.cloud.google.com/apis/library/youtube.googleapis.com) |
| YouTube channels | New uploads from channels you follow | Channel IDs (`UC…`), no key needed |

Keys are stored in plain text in the config file (`freetime paths` shows where).
`STEAM_API_KEY` and `YOUTUBE_API_KEY` environment variables work too.

## Layout

```
core/      shared logic: ideas catalog, scoring, history, Steam, YouTube, weather
  data/activities.toml   built-in ideas, add your own
cli/       terminal app
desktop/   Tauri app
  src/commands.rs        commands the UI calls
  ui/                    HTML, CSS and JS (no build step)
```

## Building on Windows

The Rust toolchain used here is `stable-x86_64-pc-windows-gnu` with MinGW-w64 (WinLibs) on the PATH,
so no Visual Studio install is needed.

MinGW's `windres` (which embeds the app icon) breaks on paths with spaces, so `.cargo/config.toml`
sends build output to `a build folder without spaces` instead of `target/`. The built apps are
there, e.g. `debug\freetime-desktop.exe`. If the project moves to a path without spaces, that file
can be deleted.
