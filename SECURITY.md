# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately instead:

1. Go to the [Security tab](https://github.com/osmvision/freetime/security) of this repository.
2. Click **Report a vulnerability** and describe what you found: what an attacker could do, the
   steps to reproduce it, and the version of freetime (desktop or web) you tested.

Only the maintainers see the report. We'll reply there as soon as we can, work on a fix with you,
and credit you when it's published if you'd like.

## Supported versions

| Version | Supported |
| ------- | --------- |
| Latest release (0.6.x) | Yes |
| Older releases | No: the desktop app updates itself, please update first |
| The web version | Yes (it always runs the current code) |

## What's in scope

- The desktop app (Tauri, Windows) and its updater.
- The web version.
- The Supabase backend in this repository: database migrations and their row-level security,
  and the Edge Functions (`supabase/functions`).

Things we care about in particular: another person's messages, games, friends or data being
readable or writable; an online move or score accepted against the rules; secrets or API keys
leaking; the app reading or sending more than [the privacy policy](docs/privacy.md) says.

Out of scope: problems in Steam, YouTube, Open-Meteo, OpenStreetMap, Supabase or GitHub
themselves (please report those to them), and attacks that need full control of the user's
own computer.
