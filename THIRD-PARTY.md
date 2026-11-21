# Third-party material

freetime's code is under the MIT License ([LICENSE](LICENSE)). These parts are not ours and keep
their own licences; if you reuse them, follow their terms, not the MIT License.

## Bundled with the app

| What | Where | Licence |
| ---- | ----- | ------- |
| Photos of the built-in ideas, from Wikimedia Commons | `desktop/ui/img/ideas/*.jpg` | Each photo's own: mostly CC BY 2.0 and CC BY-SA 2.0, some CC BY 2.5, CC BY-SA 4.0, CC0 or public domain. Author, source page and licence of every photo are in [`desktop/ui/img/ideas/credits.json`](desktop/ui/img/ideas/credits.json) and shown in the app (Settings, and under the photo in Guess the activity). CC BY-SA photos, changed or not, stay under CC BY-SA. |
| Fonts: Barlow, Barlow Condensed, Courier Prime | `desktop/ui/fonts/*.woff2` | SIL Open Font License 1.1, see [`desktop/ui/fonts/NOTICE.txt`](desktop/ui/fonts/NOTICE.txt) |
| Icons from Lucide | `desktop/ui/js/icons.js` (made by `desktop/scripts/vendor-assets.mjs`) | ISC License, © Lucide Contributors ([lucide.dev](https://lucide.dev/license)) |

## Fetched while the app runs (not in this repository)

| What | Licence and owner |
| ---- | ----------------- |
| Weather forecasts from [Open-Meteo](https://open-meteo.com/) | CC BY 4.0, credited in the app |
| Places nearby from [OpenStreetMap](https://www.openstreetmap.org/copyright), through Overpass | ODbL, © OpenStreetMap contributors, credited in the app |
| The bonus quiz from [Open Trivia Database](https://opentdb.com/) | CC BY-SA 4.0, credited in the app |
| Game covers, names and prices from Steam, video thumbnails from YouTube | Belong to their owners; shown as they are, never stored in this repository |

The Rust crates and npm packages the app is built with keep their own licences too (listed in
`Cargo.lock` and the `package-lock.json` files).

## The name

The MIT License covers the code, not the name "freetime" or its logo.
