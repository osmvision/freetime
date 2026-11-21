# freetime privacy policy

Last updated: 19 November 2026. In plain words: what freetime stores, where, and how you stay in
control.

## The short version

- freetime works **without an account**. Used that way, your data stays on your PC.
- The **online profile is optional**. If you sign in, we store the minimum needed for friends and
  messages, in the European Union, and you can export or delete it from the app at any time.
- No ads. Your data is not sold, rented or used to profile you for anyone else.

## On your PC (always)

Settings, your picks history and ratings, your "not now" answers on Discover ("too long",
"already done", "another time"), your Discover shortcuts, imported Steam games, cached store and
video lists, evening reminders, and friends added by code are stored in your Windows user folders
(`%APPDATA%\freetime`). They never leave your PC unless you send something yourself. "Open data
folder" in Settings shows them; deleting that folder removes them.

To work, the app contacts these services, and only for what you see on screen:

| Service | Why | What it receives |
| --- | --- | --- |
| Open-Meteo | Weather and the city search | The coordinates of the city you chose, or what you type in the city box |
| OpenStreetMap (Overpass API: overpass-api.de, or overpass.kumi.systems when it is busy) | "Nearby" on an idea, only when you click it | The coordinates of the city you chose and the kind of place (a park, a pool...). Answers are kept on your PC for a month |
| Steam store | Store picks and prices | Your country code |
| Epic Games Store | This week's free games | Your country code |
| Open Trivia Database | The bonus quiz (English), only when you open it | Nothing about you: a plain request for 5 questions |
| YouTube (RSS) | Video picks | The channels in your settings |
| freetime's YouTube search (Supabase) | Videos for your interests | Your interests, one at a time, with no account or ID. Results are shared by everyone who likes the same topic |
| GitHub | Checking for a new version (Settings → Updates, can be turned off) | Nothing about you: a plain download of the version list |
| Steam on your PC | "Import my games", only when you click it | Read locally: your game list and playtime. No login data |
| Mistral AI | The assistant with your own API key, only when you write to it | Your messages and a short context: the date, the weather, what you set on Discover, your interests, the ideas on screen and your last few picks |

## Online profile (only if you sign in)

**What we store**

- From Google: an account ID and your email address. The email is only visible to you and is used
  to run your account. Your real name and Google photo are not copied.
- What you choose to share: display name, avatar icon and color, an optional profile photo, bio,
  status, and your friend tag. A profile photo is stored as a resized square image. You can replace
  or remove it in your profile settings.
- Your friend requests, friendships and blocks.
- Your messages and the conversations you are part of (including the names and memberships of
  private groups), with the reactions you and your friend put
  on them (which emoji, and who). You can edit a message you sent for 15 minutes; it then shows
  "edited", and its earlier versions are kept apart, readable only by the freetime team, so that
  a report can't be emptied by editing. They are deleted with the message or your account.
- Reports you make.
- Rarely, a surprise the freetime team leaves for your account only (shown once when you open the
  app): its words, if any, and when you opened it. It is part of your data export once opened, and
  deleted with your account.
- If you use the free assistant: how many messages you sent today, for the daily limit. Older
  days are deleted.
- For the ranking: your points per day (at most 20), how many tickets you stamped, the badges you
  earned and your best weekly streak. Your history itself stays on your PC.
- What you choose to share in the friends' feed (an idea you did, your quiz score), and your
  reactions to friends' posts. Posts are deleted automatically after 30 days, and you can delete
  them yourself at any time. By default the app asks before each share.
- Quiz duels you play with friends: who played, the questions, your answers and the scores.
  Duels older than 30 days no longer show in the app; they are part of your data export, and
  deleted with your account.
- Games you play with friends (Four in a row, Draughts, Chess, Torpedoes...): the board, whose turn it
  is and the result, and for Torpedoes where you placed your ships. Games against the computer
  stay on your PC. You can clear a finished game, or all of them, from your list: that hides them
  for you only (the other player keeps theirs); they are deleted with your account. At the end of
  a game, the app shows your record against that friend, counted from these same games.
- Evenings you organise or are invited to: the one or two times, the things to do (up to three),
  your note, who is invited, each guest's answer (which times work, what they'd rather do) and the
  final choice. They show in the app until a few hours after the evening; they are part of your
  data export and deleted with your account. The optional reminder stays on your PC.
- Only if you press "Save to my account" (Settings → On all your devices): a copy of your Discover
  shortcuts, your usual Discover context, your rated picks and your "not now" answers, so another
  device can bring them back. Nothing is sent otherwise. You can delete this copy at any time; it
  is part of your data export and deleted with your account.

**The free assistant**

Signed in and without your own Mistral key, the assistant goes through our server: your messages
and the short context above are forwarded to Mistral AI (France) to write the answer, then
streamed back to you. We don't store the messages or the answers; the conversation is only kept
on your PC.

**Problem reports**

"Report a problem" (in Settings) works with or without an account. A report holds what you write,
the way to answer you if you leave one, the app's version, its language and the screen you were
on, any photos you choose to attach, and your account if you are signed in. Attached images are
resized and saved with the report. Only the two freetime admins can read reports and their photos. To limit
abuse, your network address is kept as a one-way keyed fingerprint for one day, never in clear.
Closed reports and their photos are deleted after one year. Deleting your account unlinks your reports from it.

**Who sees what**

- Your friends, and people you have a pending request with, see your name, avatar, bio and status.
- Your profile photo follows the same visibility as your avatar.
- Your friends see what you share in the feed, and which reactions you gave. Only you see how
  many reactions your posts got.
- Your friends see your ranking card: points this season, tier, tickets stamped, badges and best
  streak.
- **Only if you turn on "Let others find me"** (the same switch as "Show me on the global
  ranking"), which is off by default: anyone signed in sees your name, avatar, tier, points and
  badges on the global ranking and in Meet, sees that you joined recently (the last 14 days, never
  the date), and can send you a friend request. Never your email, bio or status, and only friends
  can message you. Turning it off removes you from both right away.
- In a quiz duel, you and your friend see each other's score. Your answers are never shown to the
  other player.
- In a game with a friend, you both see the board. In Torpedoes, the other player never sees your
  ships, only where their own shots landed.
- In an evening, the host and every guest see who is invited and each guest's answers. Nobody
  else sees it. The copy made by "Save to my account" is seen by you only.
- Only participants can read a conversation. In groups, members receive messages from the time
  they join. Messages are encrypted in transit and stored
  encrypted on disk by our hosting provider, but they are **not end-to-end encrypted**: the people
  who run freetime could technically access them. We only do so to handle a report you or the other
  person made, or when the law requires it.
- Reports are read only by the freetime team. The reported person is not told who reported them.

**Where**

Data is hosted by Supabase in the European Union (Ireland). Sign-in goes through Google. The free
assistant's answers are written by Mistral AI, in the European Union. All three act as our
processors.

**Legal basis**

Running the service you asked for (your account, friends and messages), and our legitimate interest
in keeping the service safe (reports, rate limits, blocking).

**How long**

As long as your account exists. Deleting a message removes it. Deleting your account removes your
login, profile, friendships, blocks, the messages you sent and your assistant count, immediately. Reports are kept for up
to one year after they are handled.

## Your rights

You can, from the app (Settings → Profile):

- **Export your data** as a file (right of access and portability).
- **Edit your profile** (right to rectification).
- **Delete your account** (right to erasure).

For anything else, including objecting to a use of your data, open an issue at
https://github.com/osmvision/freetime/issues or contact the maintainers. You can also complain to
your data protection authority (in France, the CNIL: https://www.cnil.fr).

## Age

Online profiles are for people aged 15 and over.

## Security

Sign-in happens in your own browser: freetime never sees your Google password. Your session is kept
in Windows Credential Manager. Every table in the database is protected by access rules that are
tested automatically. If you find a security problem, please report it privately to the
maintainers rather than in a public issue.

## Changes

If this policy changes in a way that matters, the app will tell you before it applies.
