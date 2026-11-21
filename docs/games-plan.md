# freetime games plan: better games, new games

Status: in progress, November 2026 (see "Order and progress" at the end). Builds on [engagement-plan.md](engagement-plan.md) (phase E,
mini-games) and what already ships: six turn-based games (`desktop/ui/js/play/`), the daily quiz,
quiz duels, game leaderboards, head-to-head records and rematches.

## Why these features

What already works elsewhere, and what we take from it:

- **One shared daily puzzle** (Wordle, NYT Games: 11.2 billion solves in 2025). The streak is light
  and missing a day costs nothing, and the result can be shared without spoilers.
- **Logic puzzles beat word puzzles** (LinkedIn Games: Zip, Queens and Tango lead, the word games
  trail).
- **Post-game review** (NYT Crossplay's bot, Chess.com Game Review): "here is the move you missed".
- **Turn-based play inside a chat, never forced live** (GamePigeon). The top complaint there is
  that long games (chess) drag on, so we offer short formats.
- **Timed runs that get harder** (Chess.com Puzzle Rush: 3 or 5 minutes, three misses and out).

## Rules every phase follows

1. **The fun happens off-screen** (engagement plan). Every game ends on a real idea to do.
2. **No dark patterns**: streaks are private and light, nothing nags, no fake notifications.
3. **Works offline and with nothing configured.** Network only when the user opens a feature that
   needs it, and listed in [privacy.md](privacy.md).
4. **Only original or classic public-domain games**, never another app's names, art or levels.
5. **Front constraints**: plain JS modules built with `h()` from `dom.js`, strict CSP (no remote
   scripts, fonts or images except Steam and YouTube thumbnails), no emoji in the UI, WCAG AA,
   44 px targets, every animation off under `prefers-reduced-motion`.
6. **Every new string** gets its French text in `desktop/ui/js/i18n-fr.js`.
7. **Rules stay in one place**: edit `desktop/ui/js/play/rules.js`, then run
   `node desktop/scripts/sync-game-rules.mjs` (the test in `supabase/tests/games.test.mjs` fails
   while the two copies differ).
8. **Old app versions**: a game, variant or puzzle unknown to an older app shows "update freetime to
   play this" (as `core/src/duel.rs` already does), never a broken board.

## Phases at a glance

| Phase | What | Server change | Size |
| ----- | ---- | ------------- | ---- |
| 1 | Game feel: animations, sound, "your turn", ends on an idea | none | M |
| 2 | Move log, replay, post-game review, nudge a friend | 1 migration | M |
| 3 | Variants of current games (sizes, swap opening, salvo) | rules only | S–M |
| 4 | Puzzle of the day (path, placement, "win in N") | none (points via Ranked) | L |
| 5 | Games only freetime can do (Steam price, guess the idea) | none | M |
| 6 | New classic games: Reversi, Awalé (mancala), Ultimate tic-tac-toe | 1 migration each | M each |
| 7 | Group games, 3 to 8 friends (evening vote, live quiz) | new tables | L, to decide |

Phases 1 to 3 improve what exists and can ship one by one. Phase 4 is the habit feature. Phases 5
and 6 add content. Phase 7 waits until we see how 1 to 5 are used.

---

## Phase 1 — Game feel (UI only)

Branch: `games-feel`. No rules or server changes, so nothing to sync.

### 1.1 Move animations — `desktop/ui/js/play/fx.js` (new)

Boards are rebuilt on every draw (`board()` in `boards.js`), so animate with **FLIP**: before the
redraw, note the screen rect of the moving piece's square; after it, start the new piece at the old
position with a `transform` and let it slide to zero.

- `fx.slide(boardEl, fromIndex, toIndex)`: chess, draughts (one step per square of `last.path`,
  about 120 ms each, so multi-captures can be followed).
- `fx.drop(cellEl, rows)`: Four in a row disc falling from the top, with the distance set through a
  CSS variable, about 250 ms with ease-in and one small bounce.
- `fx.pop(cellEl)`: gomoku stone or dots line appearing (scale 0.6 to 1, 120 ms).
- `fx.winLine(cells)`: the existing `.win` cells light up one after another (60 ms stagger).
- Torpedoes: a ring on "hit", the whole ship darkens on "sunk", and "Sunk!" in the status line.
- Captured piece: a short fade (chess, draughts).
- Keep them fast: under 300 ms per move, input never waits for an animation, and
  `prefers-reduced-motion` turns them all off (one guard in `fx.js` plus one CSS block).

Where: called from `draw()` in `screen.js` (`playComputer` and `playOnline`) by comparing the
previous `state.last` with the new one, so the animations work the same for both modes.

### 1.2 Sound — `desktop/ui/js/play/sound.js` (new)

- Synthesised with Web Audio (short oscillator and noise envelopes), so there are no audio files to
  bundle and the CSP needs no change.
- Sounds: move, capture, check, box closed, hit, sunk, win, loss.
- **Off by default.** A speaker toggle in the game window header, saved with the synced preferences
  (`20261120122000_synced_preferences.sql`) and also in Settings.

### 1.3 "Your turn" is unmissable

- When it's your move, a strong band above the board ("Your move", in accent colour) instead of only
  the status text.
- A quiet idle cue: after 10 s without a move, pulse the pieces you can move (that information already
  exists as `movable` in chess and draughts).
- In the games list: "your turn" rows first, with their own section heading.
- The window title gets a `(1)` prefix while a friend's move is waiting.

### 1.4 Per-game touches

- **Four in a row**: a ghost disc above the hovered or focused column.
- **Chess**: captured pieces beside each name and the material balance (`+3`).
- **Draughts**: highlight that a capture is compulsory ("You must capture") when it is.
- **Dots and boxes**: the score of each player fills as boxes close.
- **Torpedoes**: count of ships left on each side.

### 1.5 Every game ends on an idea

In `gameEnd()` (`screen.js`) and at the end of a game against the computer, add one line under the
result: an idea from the catalogue that fits, opened with the existing pick flow.

- A small map from game to idea ids: chess → `chess-puzzles` / `chess-blitz`; the others →
  `board-games` / `tiny-game`. Skip ideas the user hid or passed (reuse `hidden_ideas`).
- One line with a "Try it" button, nothing more.

**Done when**: every board animates and gives feedback in all six games, the sound toggle stays
off until switched on, reduced motion shows no animation, and the Playwright suite (`e2e/`) still
passes. Add one e2e check that a computer game ends with an idea card.

---

## Phase 2 — Move log, replay, review, nudge

Branch: `games-review`.

### 2.1 Move log

- **Solo games**: keep `moves` next to `state` in the local save (`store` in `screen.js`).
- **Online games**: new migration `…_match_moves.sql` with `match_moves(match_id, ply, player,
  move jsonb, created_at)`, primary key `(match_id, ply)`. It is written only by the games Edge
  Function (`handler.js`) in the same transaction as the move, readable by the two players (same RLS
  as `matches`), and deleted with the match. The `matches.state` size limit is not affected.
- Games finished before this migration have no log: show the final board only.

### 2.2 Replay — `desktop/ui/js/play/replay.js` (new)

- Rebuild every position from `newGame()` plus `play()` for each move, then step with buttons and
  the arrow keys (first, back, forward, last).
- Opened from a finished game's row and from the end screen ("Watch again").

### 2.3 Post-game review (chess, four in a row, draughts)

- Run the existing `ai.js` evaluation on each position in a **Web Worker** (`play/review-worker.js`)
  so the window doesn't freeze. Check that the CSP allows `worker-src 'self'`, and add it if not.
- Show three things only: **your best move**, **your biggest mistake** (the largest drop in
  evaluation, with the better move drawn on the board), and **"Replay from here"**, which opens a
  computer game from that position.
- The review runs only on the user's device and is never sent anywhere.

### 2.4 Nudge a friend

- A "Nudge" button on a game where the friend has not moved for 24 h: one nudge per game per 24 h,
  enforced on the server (`last_nudged_at` on `matches`, new `nudge` action in `handler.js`).
- It arrives through the existing game invite toast (`game-invites.js`), with the wording "Your move
  in Chess with Sam". No push notification spam and no repeats.

**Done when**: an online chess game can be replayed move by move on both players' devices, the
review points to a real mistake in a test game, and a second nudge within 24 h is refused by the
server (test in `supabase/tests/games.test.mjs`).

---

## Phase 3 — Variants of current games

Branch: `games-variants`. Rules change, so sync them and update the server tests.

- `newGame(game, first, options)` with `state.options`. A missing `options` means today's defaults, so
  current games and older apps keep working.
- **Dots and boxes**: size 3 (about 2 minutes), 5 (default) or 7.
- **Giant tic-tac-toe**: board 11 (default) or 15, plus an optional **swap opening**: the first
  player places 3 stones (2 of theirs, 1 of the other's) and the second player then picks a colour.
  This balances free gomoku, where the first player has a big edge.
- **Torpedoes**: an optional **salvo** mode, with as many shots per turn as you have ships afloat.
- The Edge Function validates `options` against a fixed list, and the AI reads the size from the
  state (fix the hard-coded `DOTS.size` and `GOMOKU.size` lookups in `rules.js`, `ai.js` and
  `boards.js`).
- The challenge dialog shows the options only for games that have them, and the defaults are
  pre-selected so it stays one tap.
- Leaderboards: variants count for their game, so no change.

**Done when**: each variant plays to the end against the computer and online, and the server
refuses an unknown size.

---

## Phase 4 — Puzzle of the day

Branch: `daily-puzzles`. The habit feature, built like the daily quiz.

### 4.1 Puzzle types

1. **Path**: a 6×6 or 7×7 grid with some numbered cells. Draw one line through every cell, passing
   the numbers in order. Drag or arrow keys to play.
2. **Placement**: a 7×7 grid split into 7 coloured zones. Place one marker per row, column and zone,
   and no two may touch, even diagonally. Click to cycle empty, cross and marker.
3. **Win in N**: a position from one of our games with the line "White to play, mate in 2" or "Win in
   3 moves". It uses the existing boards and rules in a "puzzle" mode.

Path and Placement have no colour-only cues (the zones also have patterns or borders, for colour
blindness) and both work with the keyboard.

### 4.2 Generation: ahead of time, not at runtime

- `desktop/scripts/make-puzzles.mjs` generates a year of puzzles into
  `desktop/ui/data/puzzles-2027.json` (a few hundred KB at most). Each puzzle is checked to have
  **exactly one solution** by a solver in the same script.
  - Path: random Hamiltonian path (backtracking with Warnsdorff's order), keep a few numbers, and
    add numbers until the solver finds a single solution.
  - Placement: random valid placement, grow 7 zones around the markers, and keep the layout only if
    it has a single solution.
  - Win in N, Four in a row: random mid-game positions searched with `ai.js` negamax for a forced win
    in 2 to 3. Chess: check the license of any outside source before using it (the Lichess puzzle
    database is published as CC0), or generate our own with the chess engine, and keep only positions
    with one winning first move.
- Difficulty follows the week: easy on Monday, hardest on the weekend.
- The day's puzzle = the entry for the local date, the same on every device, with no network.
- A unit test re-solves every bundled puzzle and checks it has one solution.

### 4.3 Results, sharing, points

- Record time and mistakes in a `PuzzleLog`, like `QuizLog` in `core/src/quiz.rs` (new
  `core/src/puzzles.rs`), with Tauri commands in `desktop/src/` and the same in `web/src/`.
- **Share**: spoiler-free text through `share.js`, for example
  `freetime · Path #47 · 1:42 · no mistakes`.
- **Ranked**: add `puzzles` to `DayPoints` in `core/src/ranked.rs`: 2 points per puzzle solved that
  day, still inside the cap of 20 a day. Update the table at the top of the file and the rules text
  in the Ranked screen.
- **Friends**: "3 friends solved today's Path" on the Games page, with their times, only for
  friends who share their results (opt-in, like the friends feed).
- **Streak**: shown privately on the puzzle card, never used in a notification, and missing a day
  only resets it.

### 4.4 Puzzle run (later)

Once 4.1 to 4.3 work, add a 3-minute run of Win-in-N puzzles that get harder, which ends after three
misses. It uses the same puzzle data with a separate pool, and the best score is kept on the device.

**Done when**: a new puzzle appears each day offline, the bundled year passes the single-solution
test, a solved puzzle gives Ranked points once, and the shared text has no spoiler.

---

## Phase 5 — Games only freetime can do

Branch: `freetime-games`. These games use the real data the app already loads.

### 5.1 Higher or lower: Steam prices (dropped for now: most users have no Steam account)

- Two games from the Steam store lists already fetched at startup (`providers/steam.rs` has
  `final_minor` and the discount). Pick the more expensive one, or the one with more reviews in
  another mode. One mistake ends the run, and the best score is kept on the device.
- New core function and command `store_pairs` that returns title, app id, cover and price from the
  **cached** list. It makes no new network call, and the game is hidden when there is no list.
- The end screen links to the store page through the existing open flow, and to a "free game"
  idea when a free one appeared.
- Later: a duel on the same seeded sequence for two friends, built on the quiz duel model.

### 5.2 Guess the idea

- A photo from `desktop/ui/img/ideas/` (96 bundled photos) starts zoomed at about 6×, a CSS
  `transform` only, and zooms out over 10 s. Pick the idea among 4 choices, and answering faster
  scores more. A round is 5 photos, the same set for everyone each day.
- The end card shows the five ideas, each with "Try it", and the **photo credits** from
  `credits.json` (the licences require them).
- When reduced motion is on, the photo shows in three fixed steps instead of a zoom.

### 5.3 Warmer or colder (optional)

Two cities, and you guess which one is warmer right now. It needs extra Open-Meteo calls, so they
happen **only when the game is opened**, never at startup, and the call is added to `privacy.md`.
Do it after 5.1 and 5.2.

**Done when**: 5.1 works offline from the cached list, 5.2 shows credits, and neither adds a
network call at startup.

---

## Phase 6 — New classic games

One branch per game. Each is a public-domain classic with an original look.

| Game | Why |
| ---- | --- |
| **Reversi** (8×8) | Quick, readable, a big swing at the end. The AI is a simple minimax with positional weights. |
| **Awalé** (mancala family, 2×6 pits) | Different from everything we have, calm, and the counting is satisfying to animate. |
| **Ultimate tic-tac-toe** (9 small grids) | Games of a few minutes with real depth, and the rules fit in one line. |

Checklist for each new game (the same files Chess touched):

1. `rules.js`: `init`, `moves`, `play`, `scores`, and the export in `GAMES` and `RULES`. Then
   `node desktop/scripts/sync-game-rules.mjs`.
2. `ai.js`: easy and hard levels, so every returned move comes from `legalMoves()`.
3. `boards.js`: the board, keyboard play and `last` highlight, plus the Phase 1 animations.
4. `screen.js`: `GAME_INFO` (name, Lucide icon, one-line rule).
5. `styles.css` and `i18n-fr.js`.
6. Migration `…_<game>.sql`: add the name to `matches_game_check`, `private.game_leaderboard`, and
   both name lists in `game_rematch.sql` (head-to-head and rematch).
7. `supabase/tests/games.test.mjs`: legal and illegal moves, the end of the game, and the
   server-side check.
8. `evenings.js`: add it to the game list if it suits an evening.

---

## Phase 7 — Group games, 3 to 8 friends (to decide)

Built on friend groups (`…_friend_groups.sql`) and Realtime.

1. **"What are we doing tonight?"**: freetime draws 5 ideas that fit the group, everyone votes
   privately, and the votes are revealed together. The top idea becomes an evening
   (`evenings.js`). It is a game and a real decision at once, and the closest to what freetime is for.
2. **Live group quiz**: the quiz duel extended to a group, with 5 questions, 15 s each, and the
   scores shown after each question.

New tables (`group_rounds`, `group_votes`) with RLS limited to the group's members, and rounds that
expire after 24 h. Plan this phase once phases 1 to 5 have been used for a few weeks.

---

## Order and progress

1. **Phase 1 — done** (branch `games-feel`).
2. **Phase 4 — done** (branches `daily-puzzles`, `games-more`): Path and Zones every day, and the
   problem of the day ("Win in N": chess mate in 2, Four in a row win in 2 or 3, made by
   `desktop/scripts/make-problems.mjs`, one winning first move each). Ranked points, a private
   streak, spoiler-free sharing. Still open: friends' times (4.3) and the puzzle run (4.4).
3. **Phase 5.2 — done** (`games-more`): Guess the activity, five photos a day.
4. **Phase 5.1 (Steam higher or lower): dropped for now.** Most freetime users don't have a
   Steam account.
5. **UI polish of the games** (`games-more`, with the impeccable skill): one shared game window,
   real boards on the game tiles, drawn marks instead of unicode glyphs, one red per screen.
6. Then phases 2 (replay and review), 3 and 6 in any order, and phase 7 last.

## Sources

- Wordle design: https://webflow.com/blog/wordle-design ·
  https://www.moengage.com/blog/wordle-viral-growth-story/
- NYT Games 2025 numbers and Crossplay:
  https://wtop.com/consumer-news/2026/01/this-just-in-from-the-new-york-times-its-first-2-player-game-and-an-evolving-business-model/
- LinkedIn Games' shift to logic puzzles:
  https://gamesbeat.com/how-linkedins-new-game-patches-demonstrates-its-shift-away-from-word-games/
- GamePigeon reviews: https://apps.apple.com/us/app/id1124197642
- Chess.com Puzzle Rush and Game Review: https://www.chess.com/article/view/chesscom-features
- Game feel in turn-based games:
  https://krystman.itch.io/pico-checkmate/devlog/34246/making-chess-for-pico-8-2-juicyness
