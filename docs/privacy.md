# freetime privacy policy

Last updated: 18 November 2026. In plain words: what freetime stores, where, and how you stay in
control.

## The short version

- freetime works **without an account**. Used that way, your data stays on your PC.
- The **online profile is optional**. If you sign in, we store the minimum needed for friends and
  messages, in the European Union, and you can export or delete it from the app at any time.
- No ads. Your data is not sold, rented or used to profile you for anyone else.

## On your PC (always)

Settings, your picks history and ratings, imported Steam games, cached store and video lists, and
friends added by code are stored in your Windows user folders (`%APPDATA%\freetime`). They never
leave your PC unless you send something yourself. "Open data folder" in Settings shows them;
deleting that folder removes them.

To work, the app contacts these services, and only for what you see on screen:

| Service | Why | What it receives |
| --- | --- | --- |
| Open-Meteo | Weather and the city search | The coordinates of the city you chose, or what you type in the city box |
| Steam store | Store picks and prices | Your country code |
| Epic Games Store | This week's free games | Your country code |
| Open Trivia Database | The bonus quiz (English), only when you open it | Nothing about you: a plain request for 5 questions |
| YouTube (RSS) | Video picks | The channels and topics in your settings |
| GitHub | Checking for a new version (Settings → Updates, can be turned off) | Nothing about you: a plain download of the version list |
| Steam on your PC | "Import my games", only when you click it | Read locally: your game list and playtime. No login data |
| Mistral AI | The assistant with your own API key, only when you write to it | Your messages and a short context: the date, the weather, what you set on Discover, your interests, the ideas on screen and your last few picks |

## Online profile (only if you sign in)

**What we store**

- From Google: an account ID and your email address. The email is only visible to you and is used
  to run your account. Your real name and Google photo are not copied.
- What you choose to share: display name, avatar icon and color, bio, status, and your friend tag.
- Your friend requests, friendships and blocks.
- Your messages and the conversations you are part of.
- Reports you make.
- If you use the free assistant: how many messages you sent today, for the daily limit. Older
  days are deleted.
- For the ranking: your points per day (at most 20), how many tickets you stamped, the badges you
  earned and your best weekly streak. Your history itself stays on your PC.

**The free assistant**

Signed in and without your own Mistral key, the assistant goes through our server: your messages
and the short context above are forwarded to Mistral AI (France) to write the answer, then
streamed back to you. We don't store the messages or the answers; the conversation is only kept
on your PC.

**Who sees what**

- Your friends, and people you have a pending request with, see your name, avatar, bio and status.
- Your friends see your ranking card: points this season, tier, tickets stamped, badges and best
  streak.
- **Only if you turn on "Show me on the global ranking"**, which is off by default: anyone signed in sees
  your name, avatar, tier, points and badges, and can send you a friend request. Never your
  email, bio or status. Turning it off removes you from the board right away.
- Only the two people in a conversation can read it. Messages are encrypted in transit and stored
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
