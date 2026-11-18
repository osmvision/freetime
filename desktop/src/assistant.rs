//! Tauri commands for the chat assistant (Mistral). The key stays here: the UI only learns
//! whether one is set. Answers stream to the UI as `assistant-delta` events.

use crate::commands::{card, current_online, err, lock, rank, remember, AppState, Res, ONLINE_WAIT};
use freetime_core::{
    assistant::{self, ChatMessage, Context, Mistral},
    config::Config,
    history::History,
    keys::{KeySource, Keys},
    model::Request,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// The model to use: the one picked in the settings, else the default.
pub fn model_of(cfg: &Config) -> String {
    cfg.assistant.model.clone().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| assistant::DEFAULT_MODEL.to_string())
}

#[derive(Serialize)]
pub struct AssistantStatus {
    key_set: bool,
    key_from_env: bool,
    model: String,
}

#[tauri::command(async)]
pub fn assistant_status() -> AssistantStatus {
    let key = Keys::resolve().mistral;
    let cfg = Config::load().unwrap_or_default();
    AssistantStatus {
        key_from_env: key.as_ref().is_some_and(|k| k.source == KeySource::Environment),
        key_set: key.is_some(),
        model: model_of(&cfg),
    }
}

/// Chat models this key can use (the built-in list without a key or offline).
#[tauri::command(async)]
pub fn assistant_models() -> Res<Vec<String>> {
    let Some(key) = Keys::resolve().mistral else {
        return Ok(assistant::KNOWN_MODELS.iter().map(|s| s.to_string()).collect());
    };
    let http = Mistral::new().map_err(err)?;
    Ok(assistant::models(&http, key.value()))
}

/// An idea the assistant may recommend, so the UI can draw its Start button.
#[derive(Serialize, Clone)]
pub struct IdeaRef {
    id: String,
    title: String,
    /// The category id ("game", "sport"…): the UI picks the icon from it.
    category: freetime_core::model::Category,
    category_label: &'static str,
    duration: String,
    link: Option<String>,
}

#[derive(Serialize, Clone)]
struct Delta<'a> {
    chat: &'a str,
    text: &'a str,
}

#[derive(Serialize, Clone)]
struct IdeasEvent<'a> {
    chat: &'a str,
    ideas: &'a [IdeaRef],
}

#[derive(Serialize)]
pub struct Reply {
    text: String,
    ideas: Vec<IdeaRef>,
    stopped: bool,
    model: String,
}

/// Sends the conversation to Mistral with freetime's context and streams the answer.
/// `chat` names this answer (for events and Stop); `mood` is what Discover is set to.
#[tauri::command(async)]
pub fn assistant_send(
    app: AppHandle,
    state: State<'_, AppState>,
    chat: String,
    messages: Vec<ChatMessage>,
    mood: Option<Request>,
    lang: Option<String>,
) -> Res<Reply> {
    let key = Keys::resolve()
        .mistral
        .ok_or_else(|| "Add a Mistral API key in Settings → Assistant to start chatting.".to_string())?;
    let cfg = Config::load().unwrap_or_default();
    let model = model_of(&cfg);

    // What freetime would pick right now, so the assistant recommends real things.
    let req = mood.unwrap_or_else(Request::for_now);
    let (online, _) = current_online(&state, ONLINE_WAIT);
    let ranked = rank(&state, &cfg, &req, &online, &[], &[], &[]);
    let cards: Vec<_> = {
        let best: Vec<_> = ranked.iter().map(|r| r.s.clone()).collect();
        let chosen = assistant::pick_ideas(&best, 14, 3);
        chosen.iter().filter_map(|s| ranked.iter().find(|r| r.s.id == s.id)).map(card).collect()
    };
    // Start buttons in the chat go through `pick`, which looks ideas up here.
    remember(&state, cards.iter());
    let ideas: Vec<IdeaRef> = cards
        .iter()
        .map(|c| IdeaRef {
            id: c.s.id.clone(),
            title: c.s.title.clone(),
            category: c.s.category,
            category_label: c.category_label,
            duration: c.duration.clone(),
            link: c.s.link.clone(),
        })
        .collect();
    let _ = app.emit("assistant-ideas", IdeasEvent { chat: &chat, ideas: &ideas });

    let history = History::load();
    let recent = history.entries.iter().rev().take(5).cloned().collect();
    let ctx = Context {
        lang: lang.unwrap_or_else(|| "en".into()),
        now: chrono::Local::now().format("%A %d %B %Y, %H:%M").to_string(),
        weather: online.weather.as_ref().map(|w| w.summary()),
        mood: Some(assistant::describe_mood(&req)),
        interests: cfg.interests.clone(),
        ideas: cards.iter().map(|c| c.s.clone()).collect(),
        recent,
    };

    lock(&state.assistant_stop).remove(&chat);
    let mut stopped = false;
    let http = Mistral::new().map_err(err)?;
    let text = assistant::chat(&http, key.value(), &model, &ctx, &messages, |piece| {
        if lock(&state.assistant_stop).remove(&chat) {
            stopped = true;
            return false;
        }
        let _ = app.emit("assistant-delta", Delta { chat: &chat, text: piece });
        true
    })
    .map_err(err)?;
    Ok(Reply { text, ideas, stopped, model })
}

/// Stops the answer being streamed for `chat` (it keeps what was already written).
#[tauri::command]
pub fn assistant_stop(state: State<'_, AppState>, chat: String) {
    lock(&state.assistant_stop).insert(chat);
}
