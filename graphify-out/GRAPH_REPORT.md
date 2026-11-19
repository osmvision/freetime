# Graph Report - freetime  (2026-11-19)

## Corpus Check
- 247 files · ~128,499 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 26 file(s) not represented in the graph (top: .woff2 10, .toml 4, .example 2)

## Summary
- 1949 nodes · 5084 edges · 87 communities (79 shown, 8 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 130 edges (avg confidence: 0.71)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Photo fetching & site build
- Network layer & test doubles
- Assistant chat UI
- Play together (party & shared libraries)
- Discover screen
- Assistant engine (Mistral)
- YouTube provider
- Desktop commands: friends & account data
- Account & welcome screens
- Online account client
- Sign-in (PKCE)
- Scoring & ranking
- Steam import
- Desktop commands: state & bootstrap
- Ticket book & badges
- Daily quiz
- Settings, city & language
- Tauri configuration
- Ranked & friends feed
- Realtime messages
- Supabase tests & asset scripts
- API bridge & DOM helpers
- commands (auto)
- pages (auto)
- ci (auto)
- history (auto)
- release (auto)
- model (auto)
- keys (auto)
- assistant (auto)
- steam (auto)
- book (auto)
- DESIGN (auto)
- 20261118120000_profiles_friends (auto)
- app (auto)
- share (auto)
- 20261119120000_ranked (auto)
- ranked (auto)
- index (auto)
- config (auto)
- model (auto)
- package (auto)
- display (auto)
- cli (auto)
- location (auto)
- vdf (auto)
- ui (auto)
- wrapped (auto)
- messages (auto)
- feed (auto)
- steam (auto)
- commands (auto)
- ranked (auto)
- index (auto)
- social-plan (auto)
- 20261119140000_friends_feed (auto)
- 20261118150000_direct_messages (auto)
- 20261118170000_free_now_and_invites (auto)
- steam (auto)
- region (auto)
- setup (auto)
- epic (auto)
- quiz (auto)
- engagement-plan (auto)
- README (auto)
- account (auto)
- open (auto)
- book (auto)
- net (auto)
- 20261119000000_assistant_proxy (auto)
- share (auto)
- 20261118160000_privacy_and_reports (auto)
- keys (auto)
- default (auto)
- 20261118200000_youtube_search_proxy (auto)
- index (auto)
- commands (auto)
- invite (auto)
- main (auto)
- 20261118180000_shared_game_libraries (auto)
- account (auto)
- DESIGN (auto)
- Cargo (auto)

## God Nodes (most connected - your core abstractions)
1. `h()` - 156 edges
2. `icon()` - 98 edges
3. `errText()` - 88 edges
4. `toast()` - 79 edges
5. `btn()` - 71 edges
6. `AppState` - 66 edges
7. `fill()` - 57 edges
8. `Suggestion` - 54 edges
9. `Res` - 52 edges
10. `Category` - 47 edges

## Surprising Connections (you probably didn't know these)
- `Ticket book collection` --semantically_similar_to--> `Coupon (signature component)`  [INFERRED] [semantically similar]
  docs/engagement-plan.md → DESIGN.md
- `How it works: three ticket steps` --semantically_similar_to--> `Coupon (signature component)`  [INFERRED] [semantically similar]
  site/index.html → DESIGN.md
- `What it picks from: Steam, YouTube, Epic, 95 ideas, weather` --semantically_similar_to--> `freetime product definition`  [INFERRED] [semantically similar]
  site/index.html → PRODUCT.md
- `Privacy promises section` --semantically_similar_to--> `freetime privacy policy`  [INFERRED] [semantically similar]
  site/index.html → docs/privacy.md
- `Together with friends section` --semantically_similar_to--> `Chat and ticket invites`  [INFERRED] [semantically similar]
  site/index.html → docs/social-plan.md

## Import Cycles
- 1-file cycle: `core/src/open.rs -> core/src/open.rs`
- 1-file cycle: `core/src/net.rs -> core/src/net.rs`
- 2-file cycle: `core/src/providers/steam.rs -> core/src/providers/steam_import.rs -> core/src/providers/steam.rs`

## Hyperedges (group relationships)
- **Ticket wallet design language** — design_coupon, design_stamps, design_color_palette, design_typography, design_elevation_paper [EXTRACTED 1.00]
- **Release trust chain: signing, updater key, launch checklist** — docs_code_signing_release_pipeline, docs_code_signing_updater_key, docs_launch_auto_updates, docs_launch_signing_certificate_options, docs_code_signing_signpath_foundation [INFERRED 0.85]
- **Engagement features constrained by no-dark-patterns rules** — docs_engagement_plan_ticket_book, docs_engagement_plan_badges, docs_engagement_plan_ticket_of_the_day, docs_engagement_plan_activity_feed, docs_engagement_plan_free_together, docs_engagement_plan_no_dark_patterns [EXTRACTED 1.00]

## Communities (87 total, 8 thin omitted)

### Community 0 - "Photo fetching & site build"
Cohesion: 0.06
Nodes (31): contact_sheet(), fetch_one(), get(), main(), openverse(), origin_note(), pinned(), restamp() (+23 more)

### Community 1 - "Network layer & test doubles"
Cohesion: 0.05
Nodes (37): fake_net_routes_by_prefix(), FakeNet, get_json(), TIMEOUT, url_encode(), a_wildcard_saves_one_missed_week_a_month(), best_is_the_longest_run_ever(), counts_weeks_in_a_row_and_waits_for_this_week() (+29 more)

### Community 2 - "Assistant chat UI"
Cohesion: 0.06
Nodes (63): ask(), assistantAccountChanged(), assistantSettingsChanged(), bubble(), consented(), drawCompose(), drawLive(), drawLog() (+55 more)

### Community 3 - "Play together (party & shared libraries)"
Cohesion: 0.07
Nodes (43): a_big_library_stays_pasteable(), a_friend_without_a_game_list_does_not_hide_shared_games(), Avatar, AVATAR_COLORS, AVATAR_ICONS, avatars_travel_and_unknown_ones_fall_back(), B64, b64_decode() (+35 more)

### Community 4 - "Discover screen"
Cohesion: 0.08
Nodes (56): BUDGET, changed(), closeMenu(), COMPANY, coupon(), els, ENERGY, FARE (+48 more)

### Community 5 - "Assistant engine (Mistral)"
Cohesion: 0.06
Nodes (30): API, build_messages(), chat(), cleans_and_bounds_the_conversation(), DEFAULT_MODEL, FakeHttp, free_assistant_errors_read_well(), hosted_error() (+22 more)

### Community 6 - "YouTube provider"
Cohesion: 0.07
Nodes (44): api(), API_CACHE_SECS, ApiCache, cached_feeds(), channel_config(), channel_file_maps_categories(), channel_video(), channels_path() (+36 more)

### Community 7 - "Desktop commands: friends & account data"
Cohesion: 0.07
Nodes (45): ConversationEntry, FriendEntry, Invite, LocalAccount, Place, Boot, CategoryInfo, clean_list() (+37 more)

### Community 8 - "Account & welcome screens"
Cohesion: 0.12
Nodes (43): card(), copy(), editor(), notifications(), panel(), profileSection(), shareGames(), signedOut() (+35 more)

### Community 9 - "Online account client"
Cohesion: 0.12
Nodes (6): clean_message(), Client, ensure_uuid(), forget_refresh_token(), MyRanking, Session

### Community 10 - "Sign-in (PKCE)"
Cohesion: 0.07
Nodes (30): authorize_url(), authorize_url_asks_for_pkce_and_our_redirect(), Callback, Code, Error, Other, challenge_for(), entry() (+22 more)

### Community 11 - "Scoring & ranking"
Cohesion: 0.10
Nodes (24): describe_mood(), Prefs, candidates(), rank(), rank_together(), Request, Suggestion, fetch_online() (+16 more)

### Community 12 - "Steam import"
Cohesion: 0.11
Nodes (34): account_id(), accounts(), APPMANIFEST, fake_steam(), forbidden_files_cant_be_read_even_on_purpose(), forget_library(), from_owned(), has_parent_dir() (+26 more)

### Community 13 - "Desktop commands: state & bootstrap"
Cohesion: 0.16
Nodes (36): accept_friend(), account_status(), AccountView, answer_invite(), AppState, block_user(), bootstrap(), cancel_invite() (+28 more)

### Community 14 - "Ticket book & badges"
Cohesion: 0.16
Nodes (32): badgeCard(), challengeCard(), dailyCard(), daysLeft(), meter(), renderBook(), shelfSection(), shortDate() (+24 more)

### Community 15 - "Daily quiz"
Cohesion: 0.11
Nodes (20): answers_spread_over_positions(), bank_is_valid(), bonus_trivia_is_decoded_and_shuffled(), daily(), daily_is_stable_varied_and_keeps_the_right_answer(), DATA, day(), entry_id() (+12 more)

### Community 16 - "Settings, city & language"
Cohesion: 0.14
Nodes (33): openMeteoCredit(), onDisplayChange(), preferredLang(), setLang(), photoCredits(), assistantSection(), creditsSection(), dataSection() (+25 more)

### Community 17 - "Tauri configuration"
Cohesion: 0.06
Nodes (34): app, security, windows, withGlobalTauri, build, frontendDist, bundle, active (+26 more)

### Community 18 - "Ranked & friends feed"
Cohesion: 0.18
Nodes (33): notesBlock(), renderResults(), btn(), emptyState(), h(), renderFeed(), act(), addByTag() (+25 more)

### Community 19 - "Realtime messages"
Cohesion: 0.10
Nodes (22): Message, PROJECT_URL, PUBLISHABLE_KEY, Event, Down, Invite, Live, Message (+14 more)

### Community 20 - "Supabase tests & asset scripts"
Cohesion: 0.06
Nodes (16): FONTS, ICONS, missing, mods, out, root, @electric-sql/pglite, description (+8 more)

### Community 21 - "API bridge & DOM helpers"
Cohesion: 0.12
Nodes (26): api, inTauri, listen(), append(), CATEGORY_ICONS, hydrateIcons(), weatherIcon(), ICONS (+18 more)

### Community 22 - "commands (auto)"
Cohesion: 0.12
Nodes (19): BookView, daily_card(), get_book(), get_today(), Res, ShelfView, TodayView, Card (+11 more)

### Community 23 - "pages (auto)"
Cohesion: 0.07
Nodes (30): runs-on, steps, concurrency, cancel-in-progress, group, environment, needs, runs-on (+22 more)

### Community 24 - "ci (auto)"
Cohesion: 0.08
Nodes (29): name, runs-on, steps, name, runs-on, steps, defaults, name (+21 more)

### Community 25 - "history (auto)"
Cohesion: 0.11
Nodes (15): at(), entry(), GENERIC_TAGS, guess_minutes(), History, learns_likes_and_dislikes(), MAX_ENTRIES, Memory (+7 more)

### Community 26 - "release (auto)"
Cohesion: 0.07
Nodes (27): GITHUB_TOKEN, TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD, jobs, windows, name, on, push (+19 more)

### Community 27 - "model (auto)"
Cohesion: 0.09
Nodes (18): cost_label(), Activity, catalog_is_valid(), DATA, File, load(), Cost, Cheap (+10 more)

### Community 28 - "keys (auto)"
Cohesion: 0.12
Nodes (17): built_in(), debug_output_never_shows_the_value(), empty_values_count_as_unset(), Key, last_assignment_in_a_file_wins(), MISTRAL, parse_env(), read_env_file() (+9 more)

### Community 29 - "assistant (auto)"
Cohesion: 0.13
Nodes (15): ChatMessage, HostedStatus, Keys, assistant_models(), assistant_send(), assistant_status(), assistant_stop(), AssistantStatus (+7 more)

### Community 30 - "steam (auto)"
Cohesion: 0.13
Nodes (21): APPDETAILS_URL, detail(), every_store_call_carries_the_country(), FEATURED, FEATURED_URL, MAX_DETAIL_FETCHES, missing_prices_are_left_out_not_formatted_by_hand(), Owned (+13 more)

### Community 31 - "book (auto)"
Cohesion: 0.24
Nodes (19): at(), Badge, Book, book(), Challenge, challenge(), daily(), daily_done() (+11 more)

### Community 32 - "DESIGN (auto)"
Cohesion: 0.11
Nodes (19): Palette: carrier navy, jet red, carbon purple, lavender, stock white, Context selects, Coupon (signature component), Paper-on-desk elevation and perforations, freetime design system (ticket wallet), Leaves (secondary pick cards), Responsive layout breakpoints, VOID and VALIDATED stamps (+11 more)

### Community 33 - "20261118120000_profiles_friends (auto)"
Cohesion: 0.14
Nodes (19): blocks_end_friendship, friendships_addressee, friendships_one_per_pair, friendships_stamp, on_auth_user_created, profiles_touch, public.blocks, public.can_see_profile() (+11 more)

### Community 34 - "app (auto)"
Cohesion: 0.18
Nodes (10): ask_minutes(), ask_ratings(), build_request(), commit(), finish_fetch(), rate(), start_fetch(), suggest() (+2 more)

### Community 35 - "share (auto)"
Cohesion: 0.20
Nodes (20): photoFor(), C, cover(), dots(), drawRecap(), drawTicket(), fitText(), fontsReady() (+12 more)

### Community 36 - "20261119120000_ranked (auto)"
Cohesion: 0.19
Nodes (13): public.profiles, public.open_direct(), public.can_see_player(), public.daily_points, public.export_my_data(), public.leaderboard(), public.my_ranking(), public.player_card() (+5 more)

### Community 37 - "ranked (auto)"
Cohesion: 0.20
Nodes (15): a_day_counts_what_happened_that_day_and_is_capped(), at(), DAILY_CAP, day_points(), DayPoints, e(), end_of(), first_ticket_badge_counts_once() (+7 more)

### Community 38 - "index (auto)"
Cohesion: 0.16
Nodes (20): Code signing policy, Release build and signing flow (GitHub Actions), SignPath Foundation signing, Team roles: committers, reviewers, approvers, Updater minisign/ed25519 key, Signed auto-updates, Public launch checklist, Publishing the Google sign-in screen (+12 more)

### Community 39 - "config (auto)"
Cohesion: 0.17
Nodes (10): KEYS, AssistantConfig, Config, config_dir(), config_path(), data_dir(), home_override(), SteamConfig (+2 more)

### Community 40 - "model (auto)"
Cohesion: 0.11
Nodes (14): Context, entry(), Entry, Category, .ALL, Chill, Create, Food (+6 more)

### Community 41 - "package (auto)"
Cohesion: 0.13
Nodes (18): devDependencies, @fontsource/barlow@^5.3.0, @fontsource/barlow-condensed@^5.3.0, @fontsource/courier-prime@^5.3.0, lucide-static@^1.75.0, @tauri-apps/cli@^2, name, private (+10 more)

### Community 42 - "display (auto)"
Cohesion: 0.23
Nodes (18): currentTextSize(), currentTheme(), darkQuery, displayState(), emit(), highContrast(), initDisplay(), KEYS (+10 more)

### Community 43 - "cli (auto)"
Cohesion: 0.16
Nodes (8): Cli, Command, Paths, Rate, Setup, Suggest, Surprise, SuggestArgs

### Community 44 - "location (auto)"
Cohesion: 0.18
Nodes (11): a_picked_city_gives_the_weather_coordinates(), current(), from_parts(), Location, no_city_means_no_weather(), prices_follow_the_os_region_over_the_city(), region(), Source (+3 more)

### Community 45 - "vdf (auto)"
Cohesion: 0.24
Nodes (12): entries(), parse(), parses_nested_objects_and_escapes(), Tok, Close, Open, Str, tokenize() (+4 more)

### Community 46 - "ui (auto)"
Cohesion: 0.22
Nodes (10): Choice, Done, Pick, Shuffle, choose(), print_context(), print_headline(), print_lines() (+2 more)

### Community 47 - "wrapped (auto)"
Cohesion: 0.21
Nodes (10): a_month_in_figures(), bounds(), KindCount, local_day(), period(), PeriodRecap, png_bytes(), save_png() (+2 more)

### Community 48 - "messages (auto)"
Cohesion: 0.31
Nodes (16): toast(), append(), blockButton(), drawList(), els, onLive(), openFriend(), poll() (+8 more)

### Community 49 - "feed (auto)"
Cohesion: 0.26
Nodes (11): err(), delete_post(), friend_feed(), get_social_prefs(), NewPost, Res, set_social_prefs(), share_post() (+3 more)

### Community 50 - "steam (auto)"
Cohesion: 0.20
Nodes (16): app_cache_path(), app_details(), AppInfo, apply(), enrich(), load_app_cache(), modes_come_from_the_store_and_are_cached(), save_app_cache() (+8 more)

### Community 51 - "commands (auto)"
Cohesion: 0.21
Nodes (12): free_together(), friend_name(), lock(), on_live_event(), refresh(), refresh_in_background(), steam_forget(), steam_import() (+4 more)

### Community 52 - "ranked (auto)"
Cohesion: 0.29
Nodes (9): BoardRow, CardView, player_card(), ranked_overview(), RankedView, Res, set_global_ranking(), sync() (+1 more)

### Community 53 - "index (auto)"
Cohesion: 0.16
Nodes (8): db, ROLES, db, isoSeconds(), search(), unescape(), Video, youtube()

### Community 54 - "social-plan (auto)"
Cohesion: 0.19
Nodes (13): Friends' activity feed with reactions, Challenges, shared streaks and ranked seasons, posts and reactions tables, Messages not end-to-end encrypted, Optional online profile, Social plan: accounts, friends, chat, communities, Communities, channels and staff roles, Social data model with RLS (+5 more)

### Community 55 - "20261119140000_friends_feed (auto)"
Cohesion: 0.26
Nodes (9): posts_author_created, posts_expires, public.delete_post(), public.export_my_data(), public.friend_feed(), public.posts, public.reactions, public.toggle_reaction() (+1 more)

### Community 56 - "20261118150000_direct_messages (auto)"
Cohesion: 0.31
Nodes (13): conversation_members_user, messages_conversation, messages_rate, messages_sender_time, messages_touch, public.can_post(), public.conversation_members, public.conversations (+5 more)

### Community 57 - "20261118170000_free_now_and_invites (auto)"
Cohesion: 0.23
Nodes (11): invites_check, invites_from, invites_to, public.check_invite(), public.invites, public.my_friends(), public.my_invites(), public.set_free() (+3 more)

### Community 58 - "steam (auto)"
Cohesion: 0.22
Nodes (12): g(), game(), LibraryGame, installed_picks(), lib(), library_picks(), playtime_gives_comfort_backlog_and_old_favorites(), status_reflects_the_import() (+4 more)

### Community 59 - "region (auto)"
Cohesion: 0.27
Nodes (9): country_code(), currency_code(), current(), os_country(), os_currency(), reading_the_os_region_never_fails(), Region, region_of_locale() (+1 more)

### Community 60 - "setup (auto)"
Cohesion: 0.27
Nodes (4): ask_city(), import_steam(), run(), split_list()

### Community 61 - "epic (auto)"
Cohesion: 0.38
Nodes (7): FEED, free_games(), game(), now(), only_games_free_right_now_with_a_safe_store_link(), parse(), URL

### Community 62 - "quiz (auto)"
Cohesion: 0.32
Nodes (11): reducedMotion(), LETTERS, openBonus(), openQuiz(), close(), finish(), finishBonus(), onKey() (+3 more)

### Community 63 - "engagement-plan (auto)"
Cohesion: 0.20
Nodes (11): Engagement plan: reasons to come back, Badges, Free at the same time notifications, Mini-games idea (phase E), Notifications budget, Monthly and yearly recap cards, ticket cards, Ticket book collection, Ticket of the day (+3 more)

### Community 64 - "README (auto)"
Cohesion: 0.22
Nodes (9): Local data stays on PC, Third-party services contacted, Antivirus Steam-stealer flag incident, API keys read at runtime, never compiled in, freetime README, Repo layout: core, cli, desktop, Network at startup (Open-Meteo, Steam store, YouTube feeds), Steam import with allow-list reads (+1 more)

### Community 65 - "account (auto)"
Cohesion: 0.31
Nodes (4): first_profile(), NewInvite, OnlineProfile, ProfileEdit

### Community 67 - "book (auto)"
Cohesion: 0.25
Nodes (8): CHALLENGES, Goal, Category, Daily, Kinds, Minutes, NewIdeas, Outdoor

### Community 68 - "net (auto)"
Cohesion: 0.32
Nodes (3): HttpNet, Net, resolve_steam_id()

### Community 69 - "20261119000000_assistant_proxy (auto)"
Cohesion: 0.29
Nodes (3): private.assistant_usage, public.assistant_used(), auth.users

### Community 70 - "share (auto)"
Cohesion: 0.38
Nodes (3): period_recap(), Res, save_card()

### Community 71 - "20261118160000_privacy_and_reports (auto)"
Cohesion: 0.48
Nodes (5): public.check_report(), public.export_my_data(), public.reports, reports_check, reports_open

### Community 72 - "keys (auto)"
Cohesion: 0.33
Nodes (5): KeySource, BuildTime, Environment, UserEnvFile, WorkspaceEnvFile

### Community 73 - "default (auto)"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 74 - "20261118200000_youtube_search_proxy (auto)"
Cohesion: 0.40
Nodes (3): private.youtube_quota, private.youtube_searches, public.youtube_cache_get()

### Community 75 - "index (auto)"
Cohesion: 0.40
Nodes (5): Navy top bar with tabs and bar tags, Desktop app shell HTML, Nav tabs (Discover, Friends, Messages, History, Settings), View sections and toasts container, Desktop app (Tauri)

### Community 76 - "commands (auto)"
Cohesion: 0.70
Nodes (5): add_friend(), friend_views(), FriendView, get_friends(), remove_friend()

### Community 77 - "invite (auto)"
Cohesion: 0.40
Nodes (4): bad, box, ok, tag

### Community 79 - "20261118180000_shared_game_libraries (auto)"
Cohesion: 0.60
Nodes (3): public.export_my_data(), public.game_libraries, public.stop_sharing_library()

### Community 82 - "Cargo (auto)"
Cohesion: 0.67
Nodes (3): freetime, freetime-core, freetime-desktop

## Knowledge Gaps
- **75 isolated node(s):** `freetime`, `Suggest`, `Surprise`, `Setup`, `Rate` (+70 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 508 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Category` connect `model (auto)` to `book (auto)`, `Play together (party & shared libraries)`, `ranked (auto)`, `YouTube provider`, `Scoring & ranking`, `Daily quiz`, `wrapped (auto)`, `commands (auto)`, `history (auto)`, `model (auto)`, `book (auto)`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **What connects `freetime`, `Suggest`, `Surprise` to the rest of the system?**
  _75 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Photo fetching & site build` be split into smaller, more focused modules?**
  _Cohesion score 0.05970149253731343 - nodes in this community are weakly interconnected._
- **Why does `Suggestion` connect `Scoring & ranking` to `Play together (party & shared libraries)`, `Assistant engine (Mistral)`, `YouTube provider`, `config (auto)`, `model (auto)`, `ranked (auto)`, `wrapped (auto)`, `steam (auto)`, `history (auto)`, `steam (auto)`, `model (auto)`, `epic (auto)`, `steam (auto)`, `book (auto)`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Should `Network layer & test doubles` be split into smaller, more focused modules?**
  _Cohesion score 0.052214452214452214 - nodes in this community are weakly interconnected._
- **Why does `Session` connect `Online account client` to `account (auto)`, `Sign-in (PKCE)`, `Desktop commands: state & bootstrap`, `Desktop commands: friends & account data`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Should `Assistant chat UI` be split into smaller, more focused modules?**
  _Cohesion score 0.06340326340326341 - nodes in this community are weakly interconnected._