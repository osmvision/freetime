# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Anyone with a block of free time (fifteen minutes to an afternoon) who doesn't know what to do with it
and doesn't want to spend that time deciding. They open freetime in the moment, say how much time and
energy they have, whether they're alone or with friends, whether they'll go out and what they'll spend,
and want one good answer fast. freetime is meant to be shared and published as a real consumer product,
not a personal tool.

## Product Purpose

freetime picks the best thing to do right now and explains why. It ranks ideas from several sources in
one list: games from the user's own Steam library, YouTube videos that fit the time available, sports
that suit the live weather, and offline ideas (learn, create, relax, cook, see friends). Success is the
user starting something within a minute of opening the app, and coming back because the picks get
better as they rate them.

## Positioning

One ranked pick across everything the user could do, built from their own context: their games, their
weather, their time, their energy and their past ratings. Not a feed to scroll, not a list to browse.
It runs on the user's machine and respects privacy: no IP geolocation, Steam's files are read only when
the user asks for an import, and API keys are never compiled in.

## Operating Context

- A desktop app (Tauri, Windows first) with a terminal version sharing the same core.
- Opened at the moment free time appears; the decision should take seconds.
- Picks lead somewhere real: launching a Steam game, opening a YouTube video, or doing an activity.
- After a pick, the app asks later how it went, and ratings tune future picks.

## Capabilities and Constraints

- Works with nothing configured: built-in ideas, the Steam store's top sellers and deals, and YouTube
  channel feeds. Optional upgrades: a city (weather), a Steam import, API keys.
- Startup network is limited to the Open-Meteo forecast, the Steam store lists, and YouTube RSS feeds.
  An antivirus once flagged the app as a Steam stealer; startup must never read Steam's files or look
  up the IP address.
- The UI is static HTML/CSS/JS served by Tauri with a strict CSP: fonts and images must be bundled
  locally; remote images are limited to Steam and YouTube thumbnails.
- Filters: free time, energy (low, steady, pumped), with whom (solo, friends), indoors or outdoors,
  budget (free, cheap, any), and mood categories (games, videos, sport, learn, create, relax, social,
  food).
- Recommendation logic lives in the Rust core; UI work does not change the ranking.

## Brand Commitments

- Name: "freetime", written in lower case.
- Existing app icon (clock with a smile and a sparkle) exists but is not binding: the visual direction
  is open (the user asked for a fresh direction and explicitly no emoji in the UI).

## Evidence on Hand

- Real content: Steam cover art and YouTube thumbnails from the online sources; the built-in idea
  catalog (`core/data/activities.toml`).
- Photography: free-license stock photos, bundled in the app and credited.
- No users, testimonials, ratings or press exist yet. Do not invent any.

## Product Principles

1. One clear answer beats a long list: the best pick leads, everything else supports it.
2. Real things over decoration: real games, real videos, real places and real weather.
3. Respect the user's machine and privacy; never surprise them with what the app reads or sends.
4. Every screen works offline and with nothing configured.
5. The app learns quietly from ratings instead of asking the user to configure taste.

## Accessibility & Inclusion

WCAG AA contrast for all text, visible focus, keyboard use (shortcuts for start, skip and shuffle),
touch-size targets of at least 44 px, and respect for reduced motion.
