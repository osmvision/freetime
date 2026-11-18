//! The freetime assistant: a chat with a Mistral model, opt-in.
//!
//! It only runs with a `MISTRAL_API_KEY` (see `keys`) and only when the user writes to it.
//! What is sent to Mistral: the conversation, plus a short context built here (the date, the
//! weather summary, the user's mood and interests, the ideas freetime would pick right now and
//! the last few picks with their ratings). Nothing else, and never the API keys.

use crate::{history::Entry, model::{Cost, Request, Suggestion}};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read},
    sync::Arc,
    time::Duration,
};

pub const API: &str = "https://api.mistral.ai/v1";

/// `FREETIME_MISTRAL_URL` points the assistant at another server with the same API
/// (a local fake for testing, or a proxy). Unset = Mistral itself.
fn api_base() -> String {
    std::env::var("FREETIME_MISTRAL_URL").ok().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| API.to_string())
}
/// Used until the user picks one in the settings: fast, cheap and good at short answers.
pub const DEFAULT_MODEL: &str = "mistral-small-latest";
/// Offered in the settings when the model list can't be fetched.
pub const KNOWN_MODELS: &[&str] = &[
    "mistral-small-latest",
    "mistral-medium-latest",
    "mistral-large-latest",
    "ministral-8b-latest",
    "ministral-3b-latest",
    "open-mistral-nemo",
];

/// Only the end of a long conversation is sent: enough to keep the thread, bounded in cost.
pub const MAX_TURNS: usize = 20;
pub const MAX_CHARS_PER_MESSAGE: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    /// "user" or "assistant". Anything else from the UI is dropped.
    pub role: String,
    pub content: String,
}

/// What the assistant knows about right now.
#[derive(Debug, Clone, Default)]
pub struct Context {
    /// "fr" or "en": the language of the app, which the answers follow.
    pub lang: String,
    /// e.g. "Wednesday 18 November 2026, 17:40".
    pub now: String,
    pub weather: Option<String>,
    pub mood: Option<String>,
    pub interests: Vec<String>,
    pub ideas: Vec<Suggestion>,
    pub recent: Vec<Entry>,
}

/// The instructions and context, as the system message.
pub fn system_prompt(ctx: &Context) -> String {
    let lang = if ctx.lang == "fr" { "French (use the informal \"tu\")" } else { "English" };
    let mut p = format!(
        "You are the assistant inside freetime, a desktop app that helps people choose what to do with their free time \
         (a game they own, a video, a sport, a recipe, something creative or new, alone or with friends).\n\
         Answer in {lang}. Be warm, short and concrete: a few sentences or a short list, no long essays. \
         Help the user decide; ask at most one question when you really need to.\n\
         You can't see the screen or change settings. If asked about the app: picks are on Discover, friends and messages \
         have their own tabs, History holds past picks and ratings, and Settings has the city, interests, Steam, YouTube, \
         display (text size, night mode, high contrast) and this assistant's Mistral key and model.\n\n\
         Right now: {}.\n",
        ctx.now
    );
    if let Some(w) = &ctx.weather {
        p.push_str(&format!("Weather: {w}.\n"));
    }
    if let Some(m) = &ctx.mood {
        p.push_str(&format!("What the user set on Discover: {m}.\n"));
    }
    if !ctx.interests.is_empty() {
        p.push_str(&format!("Their interests: {}.\n", ctx.interests.join(", ")));
    }
    if !ctx.recent.is_empty() {
        p.push_str("Their last picks: ");
        let items: Vec<String> = ctx
            .recent
            .iter()
            .map(|e| {
                let how = match e.rating {
                    Some(1) => " (loved it)",
                    Some(-1) => " (not for them)",
                    _ => "",
                };
                format!("{}{how}", e.title)
            })
            .collect();
        p.push_str(&items.join("; "));
        p.push_str(".\n");
    }
    if !ctx.ideas.is_empty() {
        p.push_str(
            "\nIdeas freetime has for them right now, best first. Prefer these when they fit: they are real \
             (games they own, real videos, curated ideas). To recommend one, write its marker exactly as shown, \
             e.g. [[idea:run-5k]], on its own line after a short sentence: the app turns it into a Start button. \
             Never invent a marker that isn't in this list.\n",
        );
        for s in &ctx.ideas {
            let detail: String = s.detail.chars().take(140).collect();
            p.push_str(&format!(
                "- [[{}]] {} ({}, {}, {}){}\n",
                s.id,
                s.title,
                s.category.label(),
                s.duration_label(),
                cost_label(s.cost),
                if detail.is_empty() { String::new() } else { format!(": {detail}") }
            ));
        }
    }
    p
}

fn cost_label(c: Cost) -> &'static str {
    match c {
        Cost::Free => "free",
        Cost::Cheap => "cheap",
        Cost::Paid => "costs money",
    }
}

/// The messages sent to the API: the system prompt, then the end of the conversation,
/// cleaned (known roles only, no empty turns, long ones cut).
pub fn build_messages(ctx: &Context, history: &[ChatMessage]) -> Vec<Value> {
    let mut out = vec![json!({ "role": "system", "content": system_prompt(ctx) })];
    let turns: Vec<&ChatMessage> = history
        .iter()
        .filter(|m| (m.role == "user" || m.role == "assistant") && !m.content.trim().is_empty())
        .collect();
    let start = turns.len().saturating_sub(MAX_TURNS);
    let mut turns = &turns[start..];
    // The API wants the conversation to open with the user.
    while turns.first().is_some_and(|m| m.role != "user") {
        turns = &turns[1..];
    }
    for m in turns {
        let content: String = m.content.chars().take(MAX_CHARS_PER_MESSAGE).collect();
        out.push(json!({ "role": m.role, "content": content }));
    }
    out
}

/// One `data:` line of the event stream: the text it adds, or None for the end marker.
/// Reasoning models send content as a list of parts; only the "text" parts are shown.
pub fn parse_stream_line(line: &str) -> StreamEvent {
    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
        return StreamEvent::Skip;
    };
    if data == "[DONE]" {
        return StreamEvent::Done;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return StreamEvent::Skip;
    };
    let delta = &v["choices"][0]["delta"]["content"];
    let text = match delta {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect(),
        _ => String::new(),
    };
    if text.is_empty() {
        StreamEvent::Skip
    } else {
        StreamEvent::Text(text)
    }
}

#[derive(Debug, PartialEq)]
pub enum StreamEvent {
    Text(String),
    Done,
    Skip,
}

/// A readable error for an HTTP status, with Mistral's own message when it gives one.
pub fn status_error(code: u16, body: &str) -> anyhow::Error {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["message"].as_str().or(v["detail"].as_str()).map(str::to_string))
        .map(|m| m.chars().take(200).collect::<String>());
    let base = match code {
        401 | 403 => "Mistral refused the API key. Check it in Settings → Assistant.".to_string(),
        429 => "Mistral says too many requests, or the credits ran out. Try again in a moment.".to_string(),
        400 | 404 | 422 => match &detail {
            Some(d) if d.to_lowercase().contains("model") => format!("Mistral doesn't know this model: {d}. Pick another one in Settings → Assistant."),
            Some(d) => format!("Mistral didn't accept the request: {d}"),
            None => "Mistral didn't accept the request.".to_string(),
        },
        500..=599 => "Mistral is having trouble right now. Try again in a moment.".to_string(),
        _ => format!("Mistral answered with an error (HTTP {code})."),
    };
    anyhow!(base)
}

/// The HTTP side. A trait so the streaming loop can be tested without the internet.
pub trait Transport: Send + Sync {
    /// POST JSON with the bearer key; Ok(reader over the body) or Err with status and body.
    fn post_stream(&self, url: &str, key: &str, body: &Value) -> Result<Box<dyn Read + Send>>;
    fn get_text(&self, url: &str, key: &str) -> Result<String>;
}

pub struct Mistral {
    agent: ureq::Agent,
}

impl Mistral {
    pub fn new() -> Result<Mistral> {
        let tls = native_tls::TlsConnector::new()?;
        let agent = ureq::AgentBuilder::new()
            .tls_connector(Arc::new(tls))
            .timeout_connect(Duration::from_secs(10))
            // A streamed answer sends a piece every few hundred ms; a minute of silence is a dead link.
            .timeout_read(Duration::from_secs(60))
            .user_agent(concat!("freetime/", env!("CARGO_PKG_VERSION")))
            .build();
        Ok(Mistral { agent })
    }
}

fn transport_error(e: ureq::Error) -> anyhow::Error {
    // Rebuilt by hand, like in `net`: never echo request details.
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            status_error(code, &body)
        }
        ureq::Error::Transport(t) => anyhow!("Can't reach Mistral ({}). Check your connection.", t.kind()),
    }
}

impl Transport for Mistral {
    fn post_stream(&self, url: &str, key: &str, body: &Value) -> Result<Box<dyn Read + Send>> {
        let resp = self
            .agent
            .post(url)
            .set("Authorization", &format!("Bearer {key}"))
            .set("Accept", "text/event-stream")
            .send_json(body.clone())
            .map_err(transport_error)?;
        Ok(Box::new(resp.into_reader()))
    }

    fn get_text(&self, url: &str, key: &str) -> Result<String> {
        let resp = self.agent.get(url).set("Authorization", &format!("Bearer {key}")).call().map_err(transport_error)?;
        resp.into_string().map_err(|e| anyhow!("unreadable response: {e}"))
    }
}

/// Sends the conversation and streams the answer: `on_text` gets each piece and returns
/// false to stop early (the user pressed Stop). Returns the whole answer.
pub fn chat(
    http: &dyn Transport,
    key: &str,
    model: &str,
    ctx: &Context,
    history: &[ChatMessage],
    mut on_text: impl FnMut(&str) -> bool,
) -> Result<String> {
    let body = json!({
        "model": model,
        "messages": build_messages(ctx, history),
        "stream": true,
        "temperature": 0.6,
        "max_tokens": 900,
    });
    let reader = http.post_stream(&format!("{}/chat/completions", api_base()), key, &body)?;
    let mut answer = String::new();
    for line in BufReader::new(reader).lines() {
        let line = line.map_err(|e| anyhow!("The answer was cut off ({e}). Try again."))?;
        match parse_stream_line(&line) {
            StreamEvent::Text(t) => {
                answer.push_str(&t);
                if !on_text(&t) {
                    break;
                }
            }
            StreamEvent::Done => break,
            StreamEvent::Skip => {}
        }
    }
    Ok(answer)
}

/// The chat models this key can use, sorted, or the built-in list when the call fails.
pub fn models(http: &dyn Transport, key: &str) -> Vec<String> {
    let fetched = http.get_text(&format!("{}/models", api_base()), key).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let mut list: Vec<String> = fetched
        .as_ref()
        .and_then(|v| v["data"].as_array())
        .map(|items| {
            items
                .iter()
                .filter(|m| m["capabilities"]["completion_chat"].as_bool().unwrap_or(true))
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .filter(|id| !id.contains("embed") && !id.contains("moderation") && !id.contains("ocr"))
                .collect()
        })
        .unwrap_or_default();
    if list.is_empty() {
        return KNOWN_MODELS.iter().map(|s| s.to_string()).collect();
    }
    list.sort();
    list.dedup();
    list
}

/// The ideas to put in the context: the best few, at most `per_category` of each kind so the
/// assistant sees some variety.
pub fn pick_ideas(ranked: &[Suggestion], total: usize, per_category: usize) -> Vec<Suggestion> {
    let mut out: Vec<Suggestion> = Vec::new();
    for s in ranked {
        if out.len() >= total {
            break;
        }
        if out.iter().filter(|o| o.category == s.category).count() < per_category {
            out.push(s.clone());
        }
    }
    out
}

/// A Request read from the UI, described for the prompt.
pub fn describe_mood(req: &Request) -> String {
    req.summary()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;
    use std::{io::Cursor, sync::Mutex};

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.into(), content: content.into() }
    }

    #[test]
    fn reads_text_deltas_and_the_end() {
        let line = r#"data: {"choices":[{"index":0,"delta":{"content":"Salut"}}]}"#;
        assert_eq!(parse_stream_line(line), StreamEvent::Text("Salut".into()));
        assert_eq!(parse_stream_line("data: [DONE]"), StreamEvent::Done);
        assert_eq!(parse_stream_line(""), StreamEvent::Skip);
        assert_eq!(parse_stream_line(": keep-alive"), StreamEvent::Skip);
        let role_only = r#"data: {"choices":[{"delta":{"role":"assistant","content":""}}]}"#;
        assert_eq!(parse_stream_line(role_only), StreamEvent::Skip);
    }

    #[test]
    fn keeps_only_the_text_of_reasoning_models() {
        let line = r#"data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"hmm"}]},{"type":"text","text":"Go run"}]}}]}"#;
        assert_eq!(parse_stream_line(line), StreamEvent::Text("Go run".into()));
    }

    #[test]
    fn cleans_and_bounds_the_conversation() {
        let mut history = vec![msg("assistant", "Hi! (welcome text, not sent first)"), msg("system", "ignore me")];
        for i in 0..30 {
            history.push(msg("user", &format!("q{i}")));
            history.push(msg("assistant", &format!("a{i}")));
        }
        history.push(msg("user", &"x".repeat(9000)));
        let out = build_messages(&Context::default(), &history);
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[1]["role"], "user", "the conversation opens with the user");
        assert!(out.len() <= MAX_TURNS + 1);
        assert!(out.iter().all(|m| m["content"] != "ignore me"));
        assert_eq!(out.last().unwrap()["content"].as_str().unwrap().chars().count(), MAX_CHARS_PER_MESSAGE);
    }

    #[test]
    fn the_prompt_carries_the_context_and_markers() {
        let ideas = pick_ideas(&catalog::load(), 6, 2);
        let ctx = Context {
            lang: "fr".into(),
            now: "Wednesday 18 November 2026, 17:40".into(),
            weather: Some("Lyon: 12°C, cloudy".into()),
            mood: Some("1h · medium energy".into()),
            interests: vec!["chess".into()],
            ideas: ideas.clone(),
            recent: vec![],
        };
        let p = system_prompt(&ctx);
        assert!(p.contains("French"));
        assert!(p.contains("Lyon: 12°C"));
        assert!(p.contains("chess"));
        assert!(p.contains(&format!("[[{}]]", ideas[0].id)));
    }

    #[test]
    fn variety_in_the_ideas() {
        let all = catalog::load();
        let picked = pick_ideas(&all, 10, 2);
        assert!(picked.len() <= 10);
        for s in &picked {
            assert!(picked.iter().filter(|o| o.category == s.category).count() <= 2);
        }
    }

    #[test]
    fn readable_errors() {
        assert!(status_error(401, "").to_string().contains("API key"));
        assert!(status_error(429, "").to_string().contains("credits"));
        let e = status_error(400, r#"{"message":"Invalid model: mistral-nope"}"#).to_string();
        assert!(e.contains("model") && e.contains("mistral-nope"));
    }

    struct FakeHttp {
        body: String,
        sent: Mutex<Option<Value>>,
    }

    impl Transport for FakeHttp {
        fn post_stream(&self, _url: &str, _key: &str, body: &Value) -> Result<Box<dyn Read + Send>> {
            *self.sent.lock().unwrap() = Some(body.clone());
            Ok(Box::new(Cursor::new(self.body.clone().into_bytes())))
        }
        fn get_text(&self, _url: &str, _key: &str) -> Result<String> {
            Err(anyhow!("offline"))
        }
    }

    #[test]
    fn streams_an_answer_and_can_stop() {
        let stream = [
            r#"data: {"choices":[{"delta":{"content":"Une "}}]}"#,
            "",
            r#"data: {"choices":[{"delta":{"content":"balade "}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"?"}}]}"#,
            "data: [DONE]",
        ]
        .join("\n");
        let http = FakeHttp { body: stream, sent: Mutex::new(None) };
        let history = [msg("user", "idée ?")];
        let mut pieces = Vec::new();
        let all = chat(&http, "k", "mistral-small-latest", &Context::default(), &history, |t| {
            pieces.push(t.to_string());
            true
        })
        .unwrap();
        assert_eq!(all, "Une balade ?");
        assert_eq!(pieces.len(), 3);
        let sent = http.sent.lock().unwrap().clone().unwrap();
        assert_eq!(sent["model"], "mistral-small-latest");
        assert_eq!(sent["stream"], true);

        let stopped = chat(&http, "k", "m", &Context::default(), &history, |_| false).unwrap();
        assert_eq!(stopped, "Une ");
    }

    #[test]
    fn falls_back_to_known_models() {
        let http = FakeHttp { body: String::new(), sent: Mutex::new(None) };
        assert_eq!(models(&http, "k")[0], KNOWN_MODELS[0]);
    }
}
