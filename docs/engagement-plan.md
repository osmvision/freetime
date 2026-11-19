# freetime engagement plan: reasons to come back

Status: proposal, November 2026. Builds on [social-plan.md](social-plan.md) (accounts, friends,
messages, invites, "free now").

## Goal

People open freetime because it's useful (a good idea for their free hour) and fun with friends.
They should come back because something new is waiting: a friend did something, a ticket is
missing from their collection, a challenge is almost done. They shouldn't come back because the
app tricks them into it.

Three rules every feature below follows:

1. **The fun happens off-screen.** freetime's job is to get people doing things. A feature that
   keeps them scrolling inside the app works against the product.
2. **No dark patterns.** No infinite feed, no public like counts, no guilt-tripping streaks, no
   fake or bulk notifications, no random paid rewards. The EU Digital Services Act forbids
   manipulative design, and users can be 15 or older.
3. **Private by default.** History stays on the PC. Anything shared with friends is opt-in,
   friends-only, expires on its own, and is included in "Export my data" and "Delete my account".

## The features

### 1. Ticket book (collection) — local, no server

- Every pick rated 👍 or marked "done" stamps its ticket in a **ticket book**: a grid of the 95
  built-in ideas by category ("Cooking 7/12"), plus a "games played" and "videos watched" count.
- Unstamped tickets show as a faded outline with the photo blurred: an invitation, not a lock.
- A completed category gets a special stamp. Rare ideas (stargazing, a new sport) stamp in gold.
- It's built from the existing local history (`history.json`), so nothing is sent anywhere.

### 2. Badges — local

- A small fixed set, earned from history: "First run", "10 evenings with friends",
  "Explorer: 5 categories", "Night owl: stargazing", "Chef: 5 recipes".
- Each badge shows how it's earned. There are no hidden or random rewards.
- They're shown on your own profile and, if you share activity, on friends' feeds when earned.

### 3. Ticket of the day — no server needed

- One surprise idea per day, the same for everyone. It's picked from the built-in ideas by a hash
  of the date, so every copy of freetime agrees without a server.
- It gets its own stamp in the ticket book. Friends see "Julien did today's ticket" if he shares
  activity. That gives people something to talk about.

### 4. Friends' activity feed — server, opt-in

- After a pick is rated 👍, one tap: "Share with your friends?" There's also a setting to always
  share or never share. The default is to ask.
- The feed shows friends' recent activity: "Sam tried pasta aglio e olio 👍", "Julien stamped
  his 10th cooking ticket 🔥", "Nora earned Explorer".
- **Reactions only** at first, from a fixed set (🔥 😂 👀 🙌). Counts are shown to the author only.
  Short comments can come later, rate-limited, through the existing message rules.
- The feed **ends**: the last 7 days, then "You're up to date". It's not infinite.
- Posts are deleted automatically after 30 days.

### 5. "Free at the same time" — server

- When you mark yourself free and a friend is free too, or becomes free, you both get a
  notification with an idea for the two of you: "Julien is free for 1h30. Hades in co-op?"
  It uses the shared game lists and co-op detection that already exist.
- One tap sends an invite, using the invites that already exist.
- At most one notification per friend per evening.

### 6. Challenges and shared streaks

- **Weekly challenge**, solo, local: "3 outdoor activities this week" or "try 2 new ideas". A new
  one comes each Monday from a fixed list in `core/data`.
- **Streak together**, server: the number of weeks in a row you and a friend did at least one
  accepted invite together. It's computed from the `invites` table.
  - One **freeze per month** keeps a missed week from breaking it.
  - It never sends a "you'll lose everything" message.
- **Friends leaderboard**, opt-in, friends only, monthly: hours outdoors or new ideas tried.
  There's no global leaderboard.

### 7. Shareable moments (growth)

- **Monthly and yearly recap**, in the style of Spotify Wrapped, as an image card: "42 h outdoors,
  3 new recipes, your category: sport". It's made on the PC and saved or copied. Nothing is
  uploaded.
- **Ticket cards**: share a pick as an image with an invite link (step 4 of the roadmap).

## Notifications budget

- Each type has its own switch: messages, invites, free together, friends' activity, challenges.
- At most 3 social notifications a day, across all types except direct messages and invites.
- Quiet hours from 22:00 to 09:00 by default, and the user can change them.
- Never "we miss you" notifications.

## Data model (server part)

All tables have RLS, explicit grants and rate limits, like the existing ones, with PGlite tests
for every rule.

| Table | Columns | Who can read | Who can write |
| --- | --- | --- | --- |
| `posts` | id, author, kind (pick, badge, daily, stamp), idea_id, title, category, minutes, created_at, expires_at (30 days) | the author and their friends, not blocked users | the author, at most 20 a day |
| `reactions` | post_id, user_id, emoji (fixed set), created_at, one row per user, post and emoji | whoever can see the post | yourself, on posts you can see |

- The streak together is a `security definer` function over `invites`, so there's no new table.
- "Free together" adds a Realtime subscription on friends' `profiles.free_until` (RLS already
  limits it to friends).
- `export_my_data` and `delete_my_account` include `posts` and `reactions`.
- A daily cron (pg_cron) deletes expired posts.

## How we'll know it works, without tracking users

freetime has no analytics, and that stays true. We'll only look at counts on the server, such as
posts per week, reactions and invites accepted. We never look at individual behaviour.

## Phases

| Phase | Content | Server? | Size |
| --- | --- | --- | --- |
| A | Ticket book, badges, ticket of the day, weekly solo challenge | no | ~2–3 days |
| B | Activity feed with reactions, "free at the same time", notification settings and budget | yes | ~1 week |
| C | Streak together with freeze, friends leaderboard | yes | ~3–4 days |
| D | Monthly and yearly recap cards, ticket cards and invite links | no (links: small) | ~1 week |
| E | Mini-games (see below), only if A–D work | yes | to decide |

Phase A first: it needs no server, carries no privacy risk and makes the app more fun straight
away, even without friends.

## Mini-games? (idea, phase E)

The idea: small games to play with friends inside freetime, like party-game apps on phones.

**For it:** it's social, it gives a reason to open the app with friends, and short games
fit "I have 10 minutes".

**Against, for now:**
- It turns freetime into one more screen to stay on, while its point is to get people doing things.
- Real-time multiplayer is a lot of work: syncing, disconnections, cheating and moderation of
  in-game chat.
- That kind of app lives on phones, and freetime is desktop-only for now.

**A version that fits freetime:**
- A few **turn-based** games played inside a conversation, using the Realtime messages that
  already exist: tic-tac-toe, four-in-a-row, a quick quiz about the ideas, "guess the activity
  from the photo". They take minutes, end on their own and need no new server type.
- **Duel of the day**: the same short quiz for all friends, with scores compared at the end of
  the day.
- Each game ends with an idea: "You both like quizzes: try the free online lecture?"
- Only original or classic public-domain games, never copies of another app's games, names
  or art.

Our suggestion is to decide after phase B, once friends are actually using freetime together.

## Decisions to confirm

1. Should sharing default to "ask after each 👍", or "off until turned on"?
2. Is the ticket of the day the same for everyone, or different per friend group?
3. Should the friends leaderboard exist at all, or is the streak together enough?
4. Mini-games: wait until after phase B?
