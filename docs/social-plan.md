# freetime social: accounts, friends, chat and communities

Status: phase 1 (friend codes, no server) is built: see `core/src/party.rs` and the Friends tab.
Phases 0 and 2 onward are proposals. Read the decisions at the end before starting them.

## Goal

Let people use freetime together: find friends who are free at the same time, pick something
together (for example, Steam games you both own), invite each other, talk, and later join
communities. The solo app keeps working exactly as today, offline and without an account.

Non-goals for now: voice or video calls, file and image sharing in chat, a public directory of
users, ads, selling anything.

## Security principles (the rules every phase follows)

These come from the Kaspersky incident: the app was flagged because it did things the user did
not see. The social features must never repeat that.

1. **Opt-in and visible.** Nothing leaves the PC until the user signs in. Every network call
   matches something on screen. Signing out stops all of it.
2. **No account needed for the core app.** Accounts only unlock social features.
3. **Collect the minimum.** No email if a login provider gives us an ID; no real names; no
   location beyond what the user types; no Steam files read except through the existing
   opt-in import.
4. **No passwords.** Sign-in goes through Discord (and Steam for account linking). freetime
   never sees or stores a password.
5. **The server decides who sees what.** Every table is protected by database rules (Row Level
   Security). The desktop app is treated as untrusted: a modified client must not be able to
   read or write anything its user could not already see.
6. **No secrets in the app.** The app ships only the public project key, which is designed to
   be public. The admin ("service role") key exists only on the server.
7. **Untrusted content is text.** Messages, names and community posts are inserted as text
   nodes, never HTML (the UI already works this way). Links in chat open only after a
   confirmation, and only `https://` (the existing link rules).
8. **Users can leave.** Export and delete-my-account work from Settings, and deletion really
   deletes.

## Architecture

```
freetime desktop (Tauri)                         Supabase project (EU region)
 ├─ solo app: unchanged, local only               ├─ Auth: Discord OAuth sessions
 ├─ social module (Rust)  ── HTTPS / WSS ──────▶  ├─ Postgres + Row Level Security on every table
 │   ├─ sign-in in the system browser (PKCE)      ├─ Realtime: chat, invites, "free now" (RLS-checked)
 │   ├─ tokens in Windows Credential Manager      └─ Edge Functions: Steam linking, export,
 │   └─ only talks to the project URL                 delete account, reports, rate limits
 └─ UI: Friends, Chat, Communities tabs (only when signed in)
```

Why Supabase: managed Postgres with sign-in, row-level permissions and live updates built in,
an EU region, a free tier to start, and it is open source, so the backend can move to our own
server later without rewriting the data model.

### Sign-in flow (desktop)

- The app opens the **system browser** to Discord's login page (never an embedded web view, so
  freetime cannot see what the user types). It uses PKCE and a one-time loopback redirect on
  `127.0.0.1` with a random port (the standard for desktop apps, RFC 8252).
- The session tokens are stored in **Windows Credential Manager** (the `keyring` crate), not in
  `config.toml`. Refresh tokens rotate; signing out revokes them on the server.
- **Linking Steam** (optional, for "games we both own"): the user signs in on Steam's own page
  (Steam OpenID). An Edge Function verifies the answer with Steam and stores the proven
  SteamID on the profile. A pasted SteamID is never trusted for linking.

## Data model (first version)

| Table | What it holds | Who can read it |
| --- | --- | --- |
| `profiles` | id, display name, avatar choice, linked SteamID (optional), created_at | Friends; your own row |
| `friendships` | requester, addressee, status (pending, accepted, blocked) | The two people involved |
| `availability` | "free until" time, minutes, energy, visibility (friends / nobody) | Accepted friends, if visible |
| `invites` | a ticket (idea id, title, time) sent to friends, with answers | Sender and invitees |
| `conversations` | direct or group chat, created_by | Members only |
| `conversation_members` | conversation, user, role, muted | Members only |
| `messages` | conversation, sender, text (max 2,000 chars), created_at, edited, deleted | Members only |
| `communities` | name, description, visibility (invite-only first) | Members (invite-only) |
| `community_members` | community, user, role (owner, moderator, member) | Members |
| `reports` | who reported what, reason, status | The reporter and moderators |
| `blocks` | blocker, blocked | The blocker |

Every table gets RLS policies written **together with tests** (pgTAP, run with
`supabase test db`) that prove, for example, that a non-member cannot read a conversation and
that a blocked user cannot send a message or a friend request.

## Communication

- **v1 chat:** direct messages and small group chats (up to 20) between accepted friends only.
  Text only. Live updates through Supabase Realtime, which checks the same permissions.
- **Ticket invites in chat:** "Hades at 21:00, coming?" as a special message with
  Accept / Decline buttons.
- **Limits:** message length cap, rate limit per user (for example 30 messages per minute),
  new accounts limited until they have a friend, no attachments (no malware or illegal-image
  handling needed in v1).
- **Safety:** block (hides them everywhere and stops their requests and messages), mute,
  report message or user, delete your own messages.
- **Retention:** messages kept 12 months by default, then removed automatically. Deleted
  messages are removed from the database, not just hidden.

### Encryption

- Always: TLS on every connection, encryption at rest by the provider.
- **Not end-to-end in v1.** That means whoever runs the server could technically read
  messages. The privacy policy must say so plainly.
- **Phase 5 option:** end-to-end encrypted direct messages (keys generated and kept on each
  PC; the server stores only ciphertext). Trade-offs: harder multi-device support, reports
  must include the reported messages sent by the reporter, and lost keys mean lost history.

## Threats and how we handle them

| Threat | Mitigation |
| --- | --- |
| Someone reads another user's data through a missing permission | RLS on every table, deny by default, pgTAP tests in CI, review of every policy change |
| Admin key leaks | It never ships in the app; stored only in Supabase and GitHub secrets; rotate on any doubt |
| Token stolen from the PC | Tokens in Credential Manager, short-lived access tokens, rotation, revoke on sign-out and from Settings ("sign out everywhere") |
| Account takeover | No passwords; Discord handles 2FA; new-device sign-in shown in Settings |
| Malicious content in chat (script injection) | Text nodes only, strict CSP (already in place), links confirmed and https-only |
| Spam and harassment | Friends-only chat, rate limits, block and report, new-account limits |
| Scraping users or friend lists | No public search or directory; profiles visible to friends only; friend requests by invite code or Discord/Steam ID |
| Cost or denial-of-service on the backend | Rate limits in Edge Functions, Supabase usage alerts, spending cap |
| Antivirus flags the app again | No background network before sign-in, every call visible, signed release builds (code-signing certificate) |
| Supply-chain attack through dependencies | `cargo audit` and `npm audit` in CI, Dependabot, locked versions, review before upgrading |

## Privacy and the law (France / EU)

- Host the project in an **EU region** (Frankfurt or Paris).
- Write a short **privacy policy** and **terms** before the first outside user: what is
  stored, why, how long, who can see it, how to delete it.
- **Export my data** and **delete my account** in Settings (an Edge Function), working in
  one click and completing within 30 days at most (the GDPR limit; ours should be immediate).
- **Minimum age 15** for accounts (the age of digital consent in France); ask at sign-up.
- Keep a list of the processors (Supabase, Discord as login provider).

## Moderation

- Friends and private groups: users protect themselves with block, mute and leave.
- Communities start **invite-only**, with owner and moderator roles, rules shown on joining,
  member removal and bans, and a report queue that moderators see in the app.
- Before any public community: an admin review screen, written rules, and a person who
  answers reports.

## Phases

Each phase ends with a security gate: RLS tests pass, no secret in the app binary (the existing
canary check), a manual check of the threat table, and a release that antivirus does not flag.

| Phase | What ships | Server? |
| --- | --- | --- |
| 0. Foundations | Supabase project (EU), schema + RLS + tests, CI with audits and secret scanning, branch protection on GitHub | Set up, not used by the app yet |
| 1. Pick with a friend | Paste a friend's SteamID or share a code: games you both own, ideas that suit both | No |
| 2. Accounts + friends | Discord sign-in, Steam linking, profiles, friend requests by code, block, "who's free tonight", privacy page, export and delete | Yes |
| 3. Chat + invites | Direct and group chat between friends, ticket invites, report and mute, retention | Yes |
| 4. Communities | Invite-only communities, roles, shared idea lists, planned sessions, report queue | Yes |
| 5. Optional | End-to-end encrypted direct messages, public communities with an admin team | Yes |

## Working on it together

- Protect `main` on GitHub: changes go through pull requests that the other person reviews.
- Secrets (Supabase admin key, code-signing certificate) live in GitHub secrets and the
  Supabase dashboard, never in the repo or in chat messages.
- Both of you use 2FA on GitHub, Discord and Supabase.
- Database changes are migrations in the repo (`supabase/migrations`), reviewed like code.

## Decisions to confirm

The plan assumes these defaults; change any of them before phase 0:

1. **Audience:** friends and people they invite first (invite-only), public later. A public
   launch adds moderation and legal work.
2. **Backend:** Supabase, EU region, free tier. Someone has to watch usage alerts and reports.
3. **Login:** Discord to sign in, Steam to link games. Steam-only sign-in is possible but
   needs a custom bridge.
4. **Chat encryption:** not end-to-end in v1 (said clearly in the privacy policy), with
   end-to-end direct messages as phase 5.
