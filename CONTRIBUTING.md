# Contributing to freetime

Thanks for wanting to help! freetime is made by two people in their free time, so small, focused
contributions are the easiest to take in.

## Before you start

- **A bug?** Open an [issue](https://github.com/osmvision/freetime/issues/new/choose) with what you
  did, what you expected and what happened.
- **An idea, or a bigger change?** Start a thread in
  [Discussions → Ideas](https://github.com/osmvision/freetime/discussions/categories/ideas) first,
  so we can agree on it before you spend time on code.
- **A security problem?** Don't open an issue: see [SECURITY.md](SECURITY.md).
- Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting it running

You need Rust (stable) and Node.js. See the [README](README.md) for details and for the Windows
toolchain notes.

```sh
cargo run -p freetime-desktop        # the desktop app
cd desktop && npm install && npm run dev   # with live reload of the UI
cargo run                            # the terminal version
```

## Where things are

| | |
| --- | --- |
| `core/` | The Rust core: ranking, history, quiz, puzzles, Ranked points. Shared by every app. |
| `desktop/` | The Tauri app; its UI is plain HTML, CSS and JS modules in `desktop/ui/`. |
| `web/` | The web version: the same UI, served by a small Rust server. |
| `cli/` | The terminal version. |
| `supabase/` | Accounts and everything social: migrations, Edge Functions, their tests. |
| `e2e/` | UI tests with Playwright, run against the web version. |

## Tests

Run the ones that cover what you changed:

```sh
cargo test -p freetime-core                  # the core
cargo test -p freetime-web                   # the web engine
cd supabase/tests && npm ci && npm test      # database permissions and the game rules
cd e2e && npm ci && npx playwright test      # the UI (builds and starts the web version)
```

The CI runs all of them on every pull request.

## A few rules of the house

- **Product and design**: read [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md). In short: one
  clear answer beats a long list; real things over decoration; no emoji or unicode symbols in the
  UI (icons come from Lucide, through `desktop/scripts/vendor-assets.mjs`); red only for the one
  main action; it must work offline and with nothing set up.
- **Privacy**: the app never reads or sends more than [docs/privacy.md](docs/privacy.md) says, and
  nothing new happens at startup on the network. If your change touches that, update the policy.
- **Every new string** shown in the UI needs its French in `desktop/ui/js/i18n-fr.js`.
- **Accessibility**: keyboard, labels, 44 px targets, reduced motion. See
  [ACCESSIBILITY.md](ACCESSIBILITY.md).
- **Game rules** live in `desktop/ui/js/play/rules.js`. After changing them, run
  `node desktop/scripts/sync-game-rules.mjs` so the server checks moves with the same file.
- **Database**: a change is a new migration in `supabase/migrations/` (never edit an applied one),
  with row-level security, and a test in `supabase/tests/`.
- **Commits**: one change per commit, with a message that says what it does for the user
  ("Puzzles of the day: a Path and a Zones grid every day"), not just which files changed.

## Pull requests

Keep a pull request to one subject, fill in the template, and add a screenshot when the UI changes.
We review as soon as we can; we may ask for changes, and we may say no to something that doesn't
fit the product, but we'll always say why.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE), like the rest of the code.
