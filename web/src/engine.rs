use anyhow::{bail, Context as _, Result};
use chrono::{Datelike, Local, TimeZone};
use freetime_core::{
    account, assistant, book, catalog,
    config::Config,
    history::{self, History},
    location, mine, places,
    model::*,
    net::HttpNet,
    party::{self, Avatar, Friend, Party},
    providers::{self, steam, steam_import::Library, youtube, Online},
    quiz::{self, QuizLog},
    region::Region,
    scoring::Ranked,
    weather::{self, Place, Weather},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

type AssistantJobs = std::collections::HashMap<String, Arc<AtomicBool>>;
static ASSISTANT_JOBS: OnceLock<Mutex<AssistantJobs>> = OnceLock::new();

/// Places near a city, shared by every browser (the server keeps no per-user data).
static PLACES_CACHE: OnceLock<Mutex<places::Cache>> = OnceLock::new();

fn assistant_jobs() -> std::sync::MutexGuard<'static, AssistantJobs> {
    ASSISTANT_JOBS
        .get_or_init(|| Mutex::new(AssistantJobs::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BrowserState {
    config: Config,
    history: History,
    quiz: QuizLog,
    friends: Vec<Friend>,
    library: Option<Library>,
    shown: Vec<Suggestion>,
    online: Vec<Suggestion>,
    weather: Option<Weather>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct BrowserKeys {
    pub steam: String,
    pub youtube: String,
    pub mistral: String,
}

#[derive(Deserialize)]
pub struct Call {
    cmd: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    state: BrowserState,
    #[serde(default)]
    keys: BrowserKeys,
}

pub fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .with_context(|| format!("Invalid {name}"))
}

fn card(s: &Suggestion, reasons: &[String]) -> Value {
    let mut value = serde_json::to_value(s).expect("serializable suggestion");
    value["duration"] = json!(s.duration_label());
    value["category_label"] = json!(s.category.label());
    value["icon"] = json!(s.category.icon());
    value["reasons"] = json!(reasons);
    value["place"] = json!(catalog::place_of(&s.id));
    value
}

fn categories() -> Value {
    json!(Category::ALL.map(|c| json!({
        "id": c,
        "label": c.label(),
        "icon": c.icon()
    } )))
}

fn pending(state: &BrowserState) -> Value {
    json!(state
        .history
        .unrated(history::now(), history::RATE_AFTER_SECS, 5)
        .iter()
        .map(|&i| {
            let e = &state.history.entries[i];
            json!({
            "id": e.id,
            "ts": e.ts,
            "title": e.title,
            "category": e.category,
            "category_label": e.category.label(),
            "icon": e.category.icon(),
            "ago": history::ago(history::now()-e.ts)
        } )
        })
        .collect::<Vec<_>>())
}

fn online_status(state: &BrowserState) -> Value {
    let weather = state.weather.as_ref().map(|w| {
        json!({
            "place": w.place,
            "temp_c": w.temp_c,
            "sky": w.sky(),
            "summary": w.summary(),
            "is_day": w.is_day
        })
    });
    json!({
        "ready": true,
        "loading": false,
        "weather": weather,
        "steam_games": state.library.as_ref().map_or(0, |l| l.games.len()),
        "videos": state.online.iter().filter(|s| s.category==Category::Video).count(),
        "notes": []
    })
}

fn settings(state: &BrowserState, keys: &BrowserKeys) -> Value {
    json!({
        "city": state.config.city,
        "region": {
            "country": state.config.country,
            "currency": null
        } ,
        "interests": state.config.interests,
        "channels": state.config.youtube.channels,
        "steam": steam::SteamStatus::of(state.library.as_ref()),
        "steam_id": state.config.steam.steam_id,
        "steam_key_set": !keys.steam.is_empty(),
        "steam_key_from_env": false,
        "youtube_key_set": !keys.youtube.is_empty(),
        "youtube_key_from_env": false,
        "mistral_key_set": !keys.mistral.is_empty(),
        "mistral_key_from_env": false,
        "assistant_model": state.config.assistant.model.as_deref().unwrap_or(assistant::DEFAULT_MODEL),
        "config_path": "Browser storage",
        "data_dir": "Browser storage"
    })
}

fn request(args: &Value) -> Result<Request> {
    let mut req = args
        .get("req")
        .or_else(|| args.get("mood"))
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value::<Request>(v.clone()))
        .transpose()?
        .unwrap_or_else(Request::for_now);
    req.minutes = req.minutes.clamp(5, 600);
    Ok(req)
}

fn ranked(state: &BrowserState, args: &Value) -> Result<Vec<Ranked>> {
    let req = request(args)?;
    let online = Online {
        items: state.online.clone(),
        weather: state.weather.clone(),
        ..Default::default()
    };
    let exclude: Vec<String> = args
        .get("exclude")
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()?
        .unwrap_or_default();
    let names: Vec<String> = args
        .get("party")
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()?
        .unwrap_or_default();
    let party = Party::new(
        state
            .friends
            .iter()
            .filter(|f| names.contains(&f.name))
            .cloned()
            .collect(),
        state.library.as_ref(),
    );
    Ok(freetime_core::rank_together(
        &state.config,
        &req,
        &online,
        &state.history.prefs(history::now()),
        &exclude.into_iter().collect::<HashSet<_>>(),
        Some(&party),
    ))
}

fn history_view(state: &BrowserState) -> Value {
    let now = Local::now();
    let prefs = state.history.prefs(history::now());
    let entries: Vec<_> = state
        .history
        .entries
        .iter()
        .rev()
        .take(200)
        .map(|e| {
            let at = Local.timestamp_opt(e.ts, 0).single().unwrap_or(now);
            let day = if at.date_naive() == now.date_naive() {
                "Today".into()
            } else if Some(at.date_naive()) == now.date_naive().pred_opt() {
                "Yesterday".into()
            } else {
                at.format("%A %d %B").to_string()
            };
            json!({
                "id": e.id,
                "ts": e.ts,
                "title": e.title,
                "category": e.category,
                "category_label": e.category.label(),
                "rating": e.rating,
                "day": day,
                "time": at.format("%H:%M").to_string()
            })
        })
        .collect();
    json!({
        "entries": entries,
        "taste": Category::ALL.map(|c| json!({
            "category": c,
            "label": c.label(),
            "icon": c.icon(),
            "affinity": prefs.category_affinity(c)
        } )),
        "stats": {
            "picks": state.history.entries.len(),
            "liked": state.history.entries.iter().filter(|e| e.rating==Some(1)).count(),
            "disliked": state.history.entries.iter().filter(|e| e.rating==Some(-1)).count()
        }
    })
}

fn book_view(state: &mut BrowserState) -> Value {
    let now = Local::now();
    let catalog = catalog::load();
    let b = book::book(&state.history, &catalog, now);
    let daily = book::daily(&catalog, now.date_naive())
        .map(|s| card(s, &["Today's ticket: the same for everyone".into()]));
    let shelves: Vec<_> = b
        .shelves
        .iter()
        .map(|s| {
            json!({
                "category": s.category,
                "label": s.category.label(),
                "stamped": s.stamped,
                "total": s.total,
                "tickets": s.tickets
            })
        })
        .collect();
    json!({
        "stamped": b.stamped,
        "total": b.total,
        "games": b.games,
        "videos": b.videos,
        "quizzes": b.quizzes,
        "shelves": shelves,
        "badges": b.badges,
        "challenge": b.challenge,
        "daily": daily,
        "daily_done": book::daily_done(&state.history, &catalog, now.date_naive())
    })
}

fn refresh(state: &mut BrowserState, keys: &BrowserKeys) -> Result<Value> {
    let net = HttpNet::shared()?;
    let loc = location::from_parts(&state.config, Region::default());
    let mut notes = Vec::new();
    let (videos, store, epic, weather) = std::thread::scope(|scope| {
        let videos =
            scope.spawn(|| super::sources::videos(net.as_ref(), &state.config, &keys.youtube));
        let store = scope.spawn(|| steam::store(net.as_ref(), loc.steam_cc().as_deref()));
        let epic = scope.spawn(|| {
            providers::epic::free_games(net.as_ref(), &loc, chrono::Utc::now(), &mut Vec::new())
        });
        let weather = scope.spawn(|| match (state.config.latitude, state.config.longitude) {
            (Some(lat), Some(lon))
                if lat.is_finite()
                    && lon.is_finite()
                    && lat.abs() <= 90.0
                    && lon.abs() <= 180.0 =>
            {
                weather::fetch(
                    net.as_ref(),
                    lat,
                    lon,
                    state.config.city.as_deref().unwrap_or(""),
                )
                .ok()
            }
            _ => None,
        });
        (videos.join(), store.join(), epic.join(), weather.join())
    });
    state.online.clear();
    if let Ok(items) = videos {
        state.online.extend(items);
    }
    if let Ok(Ok(items)) = store {
        state.online.extend(items);
    }
    if let Ok(items) = epic {
        state.online.extend(items);
    }
    state.weather = weather.unwrap_or(None);
    if let Some(library) = &state.library {
        state
            .online
            .extend(steam::library_picks(library, history::now()));
    }
    if state.online.is_empty() {
        notes.push(json!({
            "tip": false,
            "text": "Online sources are unavailable. Built-in ideas are ready."
        }));
    }
    let mut status = online_status(state);
    status["notes"] = json!(notes);
    Ok(status)
}

pub fn invoke(call: Call, token: Option<&str>) -> Result<Value> {
    let Call {
        cmd,
        mut args,
        mut state,
        keys,
    } = call;
    if state.history.entries.len() > 500
        || state.history.passes.len() > history::MAX_PASSES
        || state.history.never.len() > history::MAX_NEVER
        || state.config.my_ideas.len() > mine::MAX_IDEAS
        || state.config.my_ideas.iter().any(|i| !i.is_valid())
        || state.history.dismissals.len() > 300
        || state.friends.len() > 50
        || state.online.len() > 1000
        || state.shown.len() > 1000
        || state.config.interests.len() > 12
        || state.config.youtube.channels.len() > 30
        || state
            .library
            .as_ref()
            .is_some_and(|l| l.games.len() > 10000)
    {
        bail!("Browser data exceeds the supported size");
    }
    if state
        .history
        .entries
        .iter()
        .any(|e| e.minutes.is_some_and(|m| m > 600) || e.ts < 0 || e.ts > 4_102_444_800)
        || state.history.passes.iter().any(|p| p.ts < 0 || p.ts > 4_102_444_800 || p.id.len() > 300)
        || state.history.never.iter().any(|n| n.ts < 0 || n.ts > 4_102_444_800 || n.id.len() > 300 || n.title.len() > 400)
        || state.history.dismissals.iter().any(|d| d.ts < 0 || d.ts > 4_102_444_800 || d.idea_minutes > 1440 || d.free_minutes > 600 || d.id.len() > 200)
        || state
            .online
            .iter()
            .chain(state.shown.iter())
            .any(|s| s.min_minutes > 600 || s.max_minutes > 1440)
        || state.quiz.days.len() > 36500
    {
        bail!("Invalid browser history or activity duration");
    }
    let mut patch = json!({});
    if let ("suggest", Some(token)) = (cmd.as_str(), token) {
        add_online_party(&mut state, &mut args, token)?;
    }
    let now = Local::now();
    let day = now.date_naive();
    let value = match cmd.as_str() {
        "bootstrap" => json!({
            "defaults": Request::for_now(),
            "categories": categories(),
            "online": online_status(&state),
            "pending": pending(&state),
            "setup": {
                "city": state.config.city,
                "needs_city": !state.config.asked_for_city,
                "needs_welcome": !state.config.onboarded,
                "steam": state.library.is_some(),
                "youtube": true
            }
        }),
        "online_status" => online_status(&state),
        "refresh" => {
            let value = refresh(&mut state, &keys)?;
            patch["online"] = json!(state.online);
            patch["weather"] = json!(state.weather);
            value
        }
        "suggest" | "surprise" => {
            let list = ranked(&state, &args)?;
            let best = if cmd == "surprise" {
                freetime_core::scoring::weighted_pick(&list, 12).unwrap_or(0)
            } else {
                0
            };
            let pick = list.get(best).map(|r| card(&r.s, &r.reasons));
            state.shown = list.iter().take(200).map(|r| r.s.clone()).collect();
            patch["shown"] = json!(state.shown);
            if cmd == "surprise" {
                json!({
                    "pick": pick,
                    "alternatives": list.iter().enumerate().filter(|(i, _)|*i!=best).take(3).map(|(_, r)|card(&r.s, &r.reasons)).collect::<Vec<_>>()
                })
            } else {
                json!({
                    "best": pick,
                    "groups": Category::ALL.iter().map(|c| json!({
                        "category": c,
                        "label": c.label(),
                        "items": list.iter().skip(1).filter(|r| r.s.category==*c).take(4).map(|r|card(&r.s, &r.reasons)).collect::<Vec<_>>()
                    } )).collect::<Vec<_>>(),
                    "summary": "Ideas matched to your time, mood and interests.",
                    "partial": false,
                    "notes": []
                })
            }
        }
        "pick" => {
            let id: String = arg(&args, "id")?;
            let item = state
                .shown
                .iter()
                .chain(state.online.iter())
                .find(|s| s.id == id)
                .cloned()
                .or_else(|| catalog::load().into_iter().find(|s| s.id == id))
                .context("Refresh your picks to find this idea")?;
            state.history.record_pick(&item);
            patch["history"] = json!(state.history);
            json!({
                "title": item.title,
                "icon": item.category.icon(),
                "link": item.link
            })
        }
        "my_ideas" => json!(state.config.my_ideas),
        "add_my_idea" => {
            let input: mine::MyIdeaInput = arg(&args, "input")?;
            mine::add(&mut state.config.my_ideas, input)?;
            patch["config"] = json!(state.config);
            json!(state.config.my_ideas)
        }
        "remove_my_idea" => {
            let id: String = arg(&args, "id")?;
            if mine::remove(&mut state.config.my_ideas, &id) {
                patch["config"] = json!(state.config);
            }
            json!(state.config.my_ideas)
        }
        "nearby_places" => {
            let id: String = arg(&args, "id")?;
            let kind = catalog::place_of(&id).context("This idea doesn't happen in a particular place.")?;
            match (state.config.latitude, state.config.longitude) {
                (Some(lat), Some(lon)) => {
                    let now = history::now();
                    let cache = PLACES_CACHE.get_or_init(|| Mutex::new(places::Cache::default()));
                    let hit = cache.lock().ok().and_then(|c| c.get(kind, lat, lon, now));
                    let found = match hit {
                        Some(found) => found,
                        None => {
                            let found = places::nearby(HttpNet::shared()?.as_ref(), kind, lat, lon)
                                .context("Couldn't reach OpenStreetMap. Try again in a moment.")?;
                            if let Ok(mut c) = cache.lock() {
                                c.put(kind, lat, lon, now, found.clone());
                            }
                            found
                        }
                    };
                    json!({ "city": state.config.city, "label": kind.label(), "places": found })
                }
                _ => json!({ "city": null, "label": kind.label(), "places": [] }),
            }
        }
        "pass_idea" => {
            let id: String = arg(&args, "id")?;
            if state.history.record_pass(&id, history::now()) {
                patch["history"] = json!(state.history);
            }
            Value::Null
        }
        "hide_idea" => {
            let id: String = arg(&args, "id")?;
            let item = state
                .shown
                .iter()
                .chain(state.online.iter())
                .find(|s| s.id == id)
                .cloned()
                .or_else(|| catalog::load().into_iter().find(|s| s.id == id))
                .context("Refresh your picks to find this idea")?;
            state.history.hide(&item, history::now());
            patch["history"] = json!(state.history);
            Value::Null
        }
        "unhide_idea" | "hidden_ideas" => {
            if cmd == "unhide_idea" {
                let id: String = arg(&args, "id")?;
                if state.history.unhide(&id) {
                    patch["history"] = json!(state.history);
                }
            }
            let now = history::now();
            json!(state.history.never.iter().rev().map(|n| json!({
                "id": n.id,
                "title": n.title,
                "category": n.category,
                "category_label": n.category.label(),
                "ago": history::ago(now - n.ts)
            })).collect::<Vec<_>>())
        }
        "rate" => {
            let id: String = arg(&args, "id")?;
            let ts: i64 = arg(&args, "ts")?;
            let rating: i8 = arg(&args, "rating")?;
            state
                .history
                .entries
                .iter_mut()
                .find(|e| e.id == id && e.ts == ts)
                .context("Pick not found")?
                .rating = Some(rating.clamp(-1, 1));
            patch["history"] = json!(state.history);
            pending(&state)
        }
        "get_history" => history_view(&state),
        "get_book" | "get_today" => book_view(&mut state),
        "game_idea" => {
            let ids: Vec<String> = arg(&args, "ids")?;
            let catalog = catalog::load();
            let hidden = |id: &String| state.history.never.iter().any(|n| &n.id == id);
            json!(ids.iter().filter(|id| !hidden(id)).find_map(|id| catalog.iter().find(|s| &s.id == id)).map(|s| card(s, &[])))
        }
        "get_recap" => {
            let r = state.history.recap(now);
            let mut v = serde_json::to_value(&r)?;
            v["week"] = json!(format!( "{}-W{:02}", now.iso_week().year(), now.iso_week().week() ));
            v["kinds"] = json!(r .week_by_category .iter() .map(|(c, n)| json!({
                "category": c,
                "label": c.label(),
                "picks": n
            } )) .collect::<Vec<_>>());
            v["memories"] = json!(r .memories .iter() .map(|m| json!({
                "when": m.when,
                "title": m.title,
                "category": m.category,
                "label": m.category.label(),
                "loved": m.loved
            } )) .collect::<Vec<_>>());
            v
        }
        "get_quiz" => json!({
            "date": day.to_string(),
            "questions": quiz::daily(&quiz::load(), day),
            "result": state.quiz.get(day),
            "streak": state.quiz.streak(day)
        }),
        "finish_quiz" => {
            let answers: Vec<usize> = arg(&args, "answers")?;
            let score = quiz::finish(
                &quiz::load(),
                day,
                &answers,
                &mut state.quiz,
                &mut state.history,
            )?;
            state.history.entries = state
                .history
                .entries
                .into_iter()
                .rev()
                .take(500)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            patch["quiz"] = json!(state.quiz);
            patch["history"] = json!(state.history);
            json!({
                "score": score.score,
                "total": score.total,
                "streak": state.quiz.streak(day)
            })
        }
        "bonus_quiz" => json!(quiz::fetch_trivia( HttpNet::shared()?.as_ref(), &mut rand::thread_rng() )?),
        "get_settings" => settings(&state, &keys),
        "save_settings" => {
            let input = &args["input"];
            state.config.interests = arg::<Vec<String>>(input, "interests")?
                .into_iter()
                .take(12)
                .map(|s| s.chars().take(40).collect())
                .collect();
            state.config.youtube.channels = arg::<Vec<String>>(input, "channels")?
                .into_iter()
                .filter(|s| youtube::is_channel_id(s))
                .take(30)
                .collect();
            state.config.steam.steam_id = input["steam_profile"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string);
            state.config.assistant.model = input["assistant_model"].as_str().map(str::to_string);
            patch["config"] = json!(state.config);
            json!({
                "settings": settings(&state, &keys),
                "messages": [
                    {
                        "ok": true,
                        "text": "Settings saved"
                    }
                ]
            })
        }
        "search_cities" => json!(weather::search_places( HttpNet::shared()?.as_ref(), &arg::<String>(&args, "query")?, 6 )?),
        "set_city" => {
            let place: Option<Place> = arg(&args, "place")?;
            state.config.city = place.as_ref().map(|p| p.name.clone());
            state.config.latitude = place.as_ref().map(|p| p.latitude);
            state.config.longitude = place.as_ref().map(|p| p.longitude);
            state.config.country = place.map(|p| p.country_code);
            state.config.asked_for_city = true;
            state.weather = None;
            patch["weather"] = Value::Null;
            patch["config"] = json!(state.config);
            settings(&state, &keys)
        }
        "finish_welcome" => {
            if let Some(interests) = args["interests"].as_array() {
                state.config.interests = interests
                    .iter()
                    .filter_map(Value::as_str)
                    .take(12)
                    .map(|s| s.chars().take(40).collect())
                    .collect();
            }
            state.config.onboarded = true;
            patch["config"] = json!(state.config);
            Value::Null
        }
        "my_friend_code" => {
            if let Some(name) = args["name"].as_str() {
                state.config.display_name = Some(party::clean_name(name));
            }
            if !args["avatar"].is_null() {
                state.config.avatar = arg::<Avatar>(&args, "avatar")?.checked();
            }
            let taste = Category::ALL
                .map(|c| (c, state.history.prefs(history::now()).category_affinity(c)));
            let mine = Friend::mine(
                state.config.display_name.as_deref().unwrap_or("Friend"),
                state.config.avatar,
                state.library.as_ref(),
                &taste,
            );
            patch["config"] = json!(state.config);
            json!({
                "name": mine.name,
                "avatar": mine.avatar,
                "code": mine.encode(),
                "games": mine.games.len()
            })
        }
        "get_friends" => json!(state .friends .iter() .map(|f| json!({
            "name": f.name,
            "avatar": f.avatar,
            "games": f.games.len(),
            "common": state.library.as_ref().map_or(0, |l|l.games.iter().filter(|g|f.owns(g.appid)).count()),
            "added": f.added
        } )) .collect::<Vec<_>>()),
        "add_friend" => {
            let friend = Friend::decode(&arg::<String>(&args, "code")?)?;
            let name = friend.name.clone();
            party::upsert(&mut state.friends, friend)?;
            patch["friends"] = json!(state.friends);
            json!({
                "name": name
            })
        }
        "remove_friend" => {
            let name: String = arg(&args, "name")?;
            state.friends.retain(|f| f.name != name);
            patch["friends"] = json!(state.friends);
            Value::Null
        }
        "steam_import" => {
            if keys.steam.is_empty() {
                bail!("Add a Steam Web API key for this browser session to import your public library");
            }
            let net = HttpNet::shared()?;
            let input = args["steamId64"]
                .as_str()
                .or(state.config.steam.steam_id.as_deref())
                .context("Enter your Steam profile in Settings")?;
            let id = steam::resolve_steam_id(net.as_ref(), &keys.steam, input)?;
            let owned = steam::owned_games(net.as_ref(), &keys.steam, &id)?;
            let library = providers::steam_import::from_owned(&id, owned, None, history::now());
            let count = library.games.len();
            state.library = Some(library);
            patch["library"] = json!(state.library);
            json!({
                "games": count,
                "status": steam::SteamStatus::of(state.library.as_ref()),
                "notes": [],
                "settings": settings(&state, &keys)
            })
        }
        "steam_forget" => {
            state.library = None;
            state.online.retain(|s| !s.id.starts_with("steam:"));
            patch["library"] = Value::Null;
            patch["online"] = json!(state.online);
            Value::Null
        }
        "get_notify_messages" => json!(state.config.notify_messages),
        "set_notify_messages" => {
            state.config.notify_messages = arg(&args, "enabled")?;
            patch["config"] = json!(state.config);
            Value::Null
        }
        "get_share_library" => json!({
            "enabled": state.config.share_library,
            "games": state.library.as_ref().map_or(0, |l|l.games.len())
        }),
        "set_share_library" => {
            let enabled: bool = arg(&args, "enabled")?;
            let client = account::Client::new()?;
            let session =
                client.browser_session(token.context("Sign in first")?, history::now())?;
            if enabled {
                let ids = state
                    .library
                    .as_ref()
                    .map(|l| l.games.iter().map(|g| g.appid).collect::<Vec<_>>())
                    .unwrap_or_default();
                let prefs = state.history.prefs(history::now());
                let taste = Category::ALL.map(|category| (prefs.category_affinity(category) * 100.0).clamp(-100.0,100.0) as i8);
                client.share_library(&session, &ids, &taste)?;
            } else {
                client.stop_sharing_library(&session)?;
            }
            state.config.share_library = enabled;
            patch["config"] = json!(state.config);
            json!({
                "enabled": enabled,
                "games": state.library.as_ref().map_or(0, |l|l.games.len())
            })
        }
        // "Shall we play now?": the Steam games you and a free friend both own.
        "play_now" => {
            let mate = args.get("mate").cloned().context("Pick a friend")?;
            args["mates"] = json!([mate]);
            args["party"] = json!([]);
            add_online_party(&mut state, &mut args, token.context("Sign in first")?)?;
            let names: Vec<String> = arg(&args, "party")?;
            let together = Party::new(state.friends.iter().filter(|f| names.contains(&f.name)).cloned().collect(), state.library.as_ref());
            let online = Online { items: state.online.clone(), weather: state.weather.clone(), ..Default::default() };
            let found = freetime_core::play_now(&state.config, &request(&args)?, &online, &state.history.prefs(history::now()), &together);
            for r in &found.picks {
                if !state.shown.iter().any(|s| s.id == r.s.id) {
                    state.shown.push(r.s.clone());
                }
            }
            if state.shown.len() > 400 {
                state.shown.drain(..state.shown.len() - 400);
            }
            patch["shown"] = json!(state.shown);
            json!({ "common": found.common, "picks": found.picks.iter().map(|r| card(&r.s, &r.reasons)).collect::<Vec<_>>() })
        }
        // "Too long", "already done", "another time" about an idea on screen.
        "not_now" => {
            let id: String = arg(&args, "id")?;
            // The answer comes after "Not this one" has already drawn new picks without this idea,
            // so it is usually no longer in `shown`: fall back to the catalog, like "pick" does.
            let item = state
                .shown
                .iter()
                .chain(state.online.iter())
                .find(|s| s.id == id)
                .cloned()
                .or_else(|| catalog::load().into_iter().find(|s| s.id == id))
                .context("Refresh your picks to find this idea")?;
            let reason: history::NotNow = arg(&args, "reason")?;
            state.history.not_now(&item, reason, arg(&args, "minutes")?, history::now());
            patch["history"] = json!(state.history);
            Value::Null
        }
        // Preferences on all your devices, only when asked: shortcuts and context come from the page,
        // what tunes the picks from the history kept in this browser.
        "save_preferences" => {
            let client = account::Client::new()?;
            let session = client.browser_session(token.context("Sign in first")?, history::now())?;
            let extra: Value = args.get("extra").cloned().unwrap_or(Value::Null);
            json!(client.save_my_preferences(&session, &json!({ "version": 1, "extra": extra, "tuning": state.history.tuning() }))?)
        }
        "load_preferences" => {
            let client = account::Client::new()?;
            let session = client.browser_session(token.context("Sign in first")?, history::now())?;
            let saved = client.my_preferences(&session)?;
            if saved.is_null() {
                Value::Null
            } else {
                let tuning: history::Tuning = serde_json::from_value(saved["data"]["tuning"].clone()).unwrap_or_default();
                let added = state.history.merge_tuning(tuning);
                patch["history"] = json!(state.history);
                json!({ "extra": saved["data"]["extra"], "saved_at": saved["saved_at"], "added": added })
            }
        }
        "assistant_models" => json!(assistant::KNOWN_MODELS),
        "assistant_stop" => {
            if let Some(job) = assistant_jobs().get(&arg::<String>(&args, "chat")?) {
                job.store(true, Ordering::Relaxed);
            }
            Value::Null
        },
        "assistant_status" => assistant_call(&cmd, &state, &args, &keys, token)?,
        "assistant_send" => {
            let reply = assistant_call(&cmd, &state, &args, &keys, token)?;
            let ideas: Vec<Suggestion> = arg(&reply, "ideas")?;
            state.shown.extend(ideas);
            if state.shown.len() > 400 {
                state.shown.drain(..state.shown.len()-400);
            }
            patch["shown"] = json!(state.shown);
            reply
        },
        // "Report a problem" works signed out; signed in, the ticket is linked to the account.
        "send_support_ticket" => {
            let client = freetime_core::account::Client::new()?;
            let session = token.and_then(|t| client.browser_session(t, freetime_core::history::now()).ok());
            let ticket: freetime_core::support::NewTicket = arg(&args, "ticket")?;
            let ticket = freetime_core::support::NewTicket {
                platform: Some("web".into()),
                app_version: Some(concat!("web ", env!("CARGO_PKG_VERSION")).into()),
                ..ticket
            };
            json!(client.send_ticket(session.as_ref(), &ticket)?)
        }
        "support_is_admin" => {
            let admin = token.and_then(|t| {
                let client = freetime_core::account::Client::new().ok()?;
                let session = client.browser_session(t, freetime_core::history::now()).ok()?;
                client.is_admin(&session).ok()
            });
            json!(admin.unwrap_or(false))
        }
        _ => super::social::invoke(&cmd, &args, token, &state.history, &state.quiz, now)?,
    };
    Ok(json!({
        "value": value,
        "patch": patch
    }))
}

fn add_online_party(state: &mut BrowserState, args: &mut Value, token: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct Mate {
        id: String,
        name: String,
    }
    let mates: Vec<Mate> = args
        .get("mates")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()?
        .unwrap_or_default();
    if mates.is_empty() {
        return Ok(());
    }
    if mates.len() > 20 {
        bail!("Choose at most 20 online friends");
    }
    let client = account::Client::new()?;
    let session = client.browser_session(token, history::now())?;
    let libraries = client.libraries(
        &session,
        &mates.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
    )?;
    let mut names: Vec<String> = arg(args, "party")?;
    state.friends.retain(|friend| names.contains(&friend.name));
    for library in libraries {
        let Some(mate) = mates.iter().find(|mate| mate.id == library.user_id) else {
            continue;
        };
        let name = party::clean_name(&mate.name);
        let mut taste = [0i8; 8];
        for (target, value) in taste.iter_mut().zip(&library.taste) {
            *target = (*value).clamp(-100, 100) as i8;
        }
        state.friends.push(Friend {
            name: name.clone(),
            games: library.app_ids,
            taste,
            added: 0,
            avatar: Avatar::default(),
        });
        names.push(name);
    }
    args["party"] = json!(names);
    Ok(())
}

fn assistant_call(
    cmd: &str,
    state: &BrowserState,
    args: &Value,
    keys: &BrowserKeys,
    token: Option<&str>,
) -> Result<Value> {
    let own = !keys.mistral.is_empty();
    let http = if own {
        assistant::Mistral::new()?
    } else {
        assistant::Mistral::hosted()?
    };
    let model = state
        .config
        .assistant
        .model
        .as_deref()
        .unwrap_or(assistant::DEFAULT_MODEL);
    if cmd == "assistant_status" {
        let free = if !own {
            token
                .map(|t| assistant::hosted_status(&http, t))
                .transpose()
        } else {
            Ok(None)
        };
        let (free, error) = match free {
            Ok(f) => (f, None),
            Err(e) => (None, Some(e.to_string())),
        };
        return Ok(json!({
            "ready": own||free.as_ref().is_some_and(|f|f.available),
            "key_set": own,
            "key_from_env": false,
            "model": model,
            "signed_in": token.is_some(),
            "free": free,
            "free_error": error
        }));
    }
    let key = if own {
        keys.mistral.as_str()
    } else {
        token.context("Sign in to use the assistant")?
    };
    let req = request(args)?;
    let list = ranked(
        state,
        &json!({
            "req": req
        }),
    )?;
    let choices: Vec<_> = list.iter().map(|r| r.s.clone()).collect();
    let ideas = assistant::pick_ideas(&choices, 14, 3);
    let context = assistant::Context {
        lang: args["lang"].as_str().unwrap_or("en").into(),
        now: Local::now().to_rfc3339(),
        weather: state.weather.as_ref().map(Weather::summary),
        mood: Some(assistant::describe_mood(&req)),
        interests: state.config.interests.clone(),
        ideas: ideas.clone(),
        recent: state
            .history
            .entries
            .iter()
            .rev()
            .take(5)
            .cloned()
            .collect(),
    };
    let messages: Vec<assistant::ChatMessage> = arg(args, "messages")?;
    let chat: String = arg(args, "chat")?;
    if chat.len() != 36 || !chat.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        bail!("Invalid chat id");
    }
    let stopped = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = assistant_jobs();
        if jobs.len() >= 100 || jobs.contains_key(&chat) {
            bail!("Assistant is busy. Try again shortly.");
        }
        jobs.insert(chat.clone(), stopped.clone());
    }
    let text = assistant::chat(
        &http,
        &if own {
            assistant::own_url()
        } else {
            assistant::hosted_url()
        },
        key,
        model,
        &context,
        &messages,
        |_| !stopped.load(Ordering::Relaxed),
    );
    assistant_jobs().remove(&chat);
    let text = text?;
    Ok(json!({
        "text": text,
        "ideas": ideas.iter().map(|s|card(s, &[])).collect::<Vec<_>>(),
        "stopped": stopped.load(Ordering::Relaxed),
        "model": model
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(cmd: &str, args: Value, state: Value) -> Result<Value> {
        invoke(
            serde_json::from_value(json!({
                "cmd": cmd,
                "args": args,
                "state": state
            }))?,
            None,
        )
    }
    #[test]
    fn game_idea_is_the_first_one_not_hidden() {
        let ids = json!({ "ids": ["idea:chess-puzzles", "idea:chess-blitz"] });
        let first = call("game_idea", ids.clone(), json!({})).unwrap();
        assert_eq!(first["value"]["id"], "idea:chess-puzzles");
        assert!(first["value"]["title"].as_str().is_some_and(|t| !t.is_empty()));
        let hidden = call("hide_idea", json!({ "id": "idea:chess-puzzles" }), json!({})).unwrap();
        let next = call("game_idea", ids, hidden["patch"].clone()).unwrap();
        assert_eq!(next["value"]["id"], "idea:chess-blitz");
        let none = call("game_idea", json!({ "ids": ["no-such-idea"] }), json!({})).unwrap();
        assert!(none["value"].is_null());
    }

    #[test]
    fn browser_history_and_quiz_round_trip_without_desktop_storage() {
        let boot = call("bootstrap", json!({}), json!({})).unwrap();
        assert!(boot["value"]["setup"]["needs_welcome"].as_bool().unwrap());
        let daily = call("get_today", json!({}), json!({})).unwrap();
        let id = daily["value"]["daily"]["id"].clone();
        let picked = call(
            "pick",
            json!({
                "id": id
            }),
            json!({}),
        )
        .unwrap();
        let state = picked["patch"].clone();
        let view = call("get_history", json!({}), state.clone()).unwrap();
        assert_eq!(view["value"]["stats"]["picks"], 1);
        assert_eq!(view["patch"], json!({}));
        let quiz = call("get_quiz", json!({}), state.clone()).unwrap();
        let answers: Vec<_> = quiz["value"]["questions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| q["answer"].clone())
            .collect();
        let done = call(
            "finish_quiz",
            json!({
                "answers": answers
            }),
            state,
        )
        .unwrap();
        assert_eq!(done["value"]["score"], 5);
        let again = call(
            "finish_quiz",
            json!({
                "answers": answers
            }),
            done["patch"].clone(),
        )
        .unwrap();
        assert_eq!(done["patch"]["history"], again["patch"]["history"]);
        assert_eq!(done["value"], again["value"]);
    }
    #[test]
    fn rejects_desktop_commands_and_invalid_browser_state() {
        for command in ["open_data_dir", "steam_scan", "open_link", "install_update"] {
            assert!(call(command, json!({}), json!({})).is_err());
        }
        assert!(call(
            "get_history",
            json!({}),
            json!({
                "history": {
                    "entries": [
                        {
                            "id": "idea:test",
                            "category": "chill",
                            "title": "test",
                            "ts": 0,
                            "minutes": u32::MAX
                        }
                    ]
                }
            })
        )
        .is_err());
    }
    #[test]
    fn friend_codes_remain_compatible_with_the_desktop_format() {
        let mine = call(
            "my_friend_code",
            json!({
                "name": "Mobile",
                "avatar": {
                    "icon": 2,
                    "color": 3
                }
            }),
            json!({}),
        )
        .unwrap();
        let code = mine["value"]["code"].as_str().unwrap();
        let decoded = Friend::decode(code).unwrap();
        assert_eq!(decoded.name, "Mobile");
        assert_eq!(decoded.avatar.icon, 2);
    }
}
