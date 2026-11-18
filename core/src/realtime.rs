//! The live connection to Supabase Realtime: new messages and invites arrive the moment they are
//! saved, instead of on the next check.
//!
//! One websocket, only while signed in. The sign-in token goes in the join message (never in the
//! URL), and Realtime applies each table's Row Level Security to it, so the server only sends rows
//! this user may read: their own conversations' messages, and invites they sent or got.
//! Phoenix channel protocol (vsn 1.0.0): join, heartbeat every 25 s, access_token on refresh.

use crate::account::{Message, PROJECT_URL, PUBLISHABLE_KEY};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{
    io::ErrorKind,
    net::TcpStream,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{stream::MaybeTlsStream, Message as Frame, WebSocket};

const TOPIC: &str = "realtime:freetime";
const HEARTBEAT: Duration = Duration::from_secs(25);
const READ_TIMEOUT: Duration = Duration::from_secs(2);

/// What the live connection reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Subscribed: from now on, changes arrive live.
    Live,
    /// The connection dropped; it will retry.
    Down,
    Message(Message),
    /// An invite was created or answered: (id, its from_user, its to_user, status, title, starts_at).
    Invite { id: i64, from_user: String, to_user: String, status: String, title: String, starts_at: String, inserted: bool },
}

pub fn websocket_url() -> String {
    let host = PROJECT_URL.trim_start_matches("https://");
    format!("wss://{host}/realtime/v1/websocket?apikey={PUBLISHABLE_KEY}&vsn=1.0.0")
}

pub fn join_frame(token: &str, r#ref: u64) -> String {
    json!({
        "topic": TOPIC,
        "event": "phx_join",
        "payload": {
            "config": {
                "broadcast": { "self": false },
                "presence": { "key": "" },
                "postgres_changes": [
                    { "event": "INSERT", "schema": "public", "table": "messages" },
                    { "event": "*", "schema": "public", "table": "invites" }
                ],
                "private": false
            },
            "access_token": token
        },
        "ref": r#ref.to_string(),
        "join_ref": r#ref.to_string()
    })
    .to_string()
}

pub fn heartbeat_frame(r#ref: u64) -> String {
    json!({ "topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": r#ref.to_string() }).to_string()
}

pub fn token_frame(token: &str, r#ref: u64) -> String {
    json!({ "topic": TOPIC, "event": "access_token", "payload": { "access_token": token }, "ref": r#ref.to_string() }).to_string()
}

/// Reads one frame from the server. Only well-formed changes of the two tables come out.
pub fn parse(text: &str) -> Option<Event> {
    let v: Value = serde_json::from_str(text).ok()?;
    let event = v.get("event")?.as_str()?;
    let payload = v.get("payload")?;
    if event == "phx_reply" && v.get("topic")?.as_str()? == TOPIC {
        let ok = payload.get("status").and_then(Value::as_str) == Some("ok");
        // The join reply lists the subscriptions the server accepted.
        let subscribed = payload.pointer("/response/postgres_changes").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
        return (ok && subscribed).then_some(Event::Live);
    }
    if event != "postgres_changes" {
        return None;
    }
    let data = payload.get("data")?;
    let record = data.get("record")?;
    let text_of = |k: &str| record.get(k).and_then(Value::as_str).map(str::to_string);
    match (data.get("table")?.as_str()?, data.get("type")?.as_str()?) {
        ("messages", "INSERT") => Some(Event::Message(Message {
            id: record.get("id")?.as_i64()?,
            sender: text_of("sender")?,
            body: text_of("body")?,
            created_at: text_of("created_at")?,
            conversation_id: text_of("conversation_id"),
        })),
        ("invites", kind @ ("INSERT" | "UPDATE")) => Some(Event::Invite {
            id: record.get("id")?.as_i64()?,
            from_user: text_of("from_user")?,
            to_user: text_of("to_user")?,
            status: text_of("status")?,
            title: text_of("title").unwrap_or_default(),
            starts_at: text_of("starts_at").unwrap_or_default(),
            inserted: kind == "INSERT",
        }),
        _ => None,
    }
}

fn set_read_timeout(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>, t: Duration) {
    let stream = match ws.get_mut() {
        MaybeTlsStream::Plain(s) => s,
        MaybeTlsStream::NativeTls(s) => s.get_mut(),
        _ => return,
    };
    let _ = stream.set_read_timeout(Some(t));
}

/// One connection, until it drops, `stop` is set, or there is no token any more (signed out).
fn session(token: &dyn Fn() -> Option<String>, on_event: &dyn Fn(Event), stop: &AtomicBool) -> Result<()> {
    let mut current = token().ok_or_else(|| anyhow!("signed out"))?;
    let (mut ws, _) = tungstenite::connect(websocket_url()).map_err(|e| anyhow!("realtime: {e}"))?;
    set_read_timeout(&mut ws, READ_TIMEOUT);
    let mut r#ref = 1u64;
    ws.send(Frame::Text(join_frame(&current, r#ref)))?;
    let mut last_beat = Instant::now();
    let mut last_token_check = Instant::now();
    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = ws.close(None);
            return Ok(());
        }
        if last_beat.elapsed() >= HEARTBEAT {
            r#ref += 1;
            ws.send(Frame::Text(heartbeat_frame(r#ref)))?;
            last_beat = Instant::now();
        }
        // A refreshed sign-in token is handed over so the subscription keeps its rights.
        if last_token_check.elapsed() >= Duration::from_secs(60) {
            last_token_check = Instant::now();
            match token() {
                Some(t) if t != current => {
                    current = t;
                    r#ref += 1;
                    ws.send(Frame::Text(token_frame(&current, r#ref)))?;
                }
                Some(_) => {}
                None => {
                    let _ = ws.close(None);
                    return Ok(());
                }
            }
        }
        match ws.read() {
            Ok(Frame::Text(text)) => {
                if let Some(e) = parse(&text) {
                    on_event(e);
                }
            }
            Ok(Frame::Close(_)) => return Err(anyhow!("realtime: closed by the server")),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return Err(anyhow!("realtime: {e}")),
        }
    }
}

/// Keeps a live connection while `token()` gives a sign-in token, reconnecting with a growing
/// pause (2 s up to 60 s) when it drops. Returns when `stop` is set.
pub fn run(token: impl Fn() -> Option<String>, on_event: impl Fn(Event), stop: &AtomicBool) {
    let mut pause = Duration::from_secs(2);
    while !stop.load(Ordering::Relaxed) {
        if token().is_none() {
            thread::sleep(Duration::from_secs(10));
            continue;
        }
        let started = Instant::now();
        let result = session(&token, &on_event, stop);
        on_event(Event::Down);
        if result.is_ok() || started.elapsed() > Duration::from_secs(120) {
            pause = Duration::from_secs(2);
        }
        if stop.load(Ordering::Relaxed) {
            return;
        }
        thread::sleep(pause);
        pause = (pause * 2).min(Duration::from_secs(60));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_goes_in_the_join_message_not_the_url() {
        let url = websocket_url();
        assert!(url.starts_with("wss://tgvphbmbxfembnsfdxlp.supabase.co/realtime/v1/websocket?apikey=sb_publishable_"));
        assert!(!url.contains("access_token"));
        let join: Value = serde_json::from_str(&join_frame("TOKEN", 1)).unwrap();
        assert_eq!(join["event"], "phx_join");
        assert_eq!(join["payload"]["access_token"], "TOKEN");
        assert_eq!(join["payload"]["config"]["postgres_changes"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn reads_a_new_message() {
        let frame = r#"{"topic":"realtime:freetime","event":"postgres_changes","payload":{"data":{"table":"messages","type":"INSERT","schema":"public","record":{"id":42,"conversation_id":"3f0c1a2b-1111-4222-8333-444455556666","sender":"00000000-0000-4000-8000-00000000000a","body":"hi","created_at":"2026-11-18T19:00:00+00:00"}},"ids":[1]},"ref":null}"#;
        match parse(frame) {
            Some(Event::Message(m)) => {
                assert_eq!((m.id, m.body.as_str()), (42, "hi"));
                assert_eq!(m.conversation_id.as_deref(), Some("3f0c1a2b-1111-4222-8333-444455556666"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reads_invites_and_the_join_reply() {
        let invite = r#"{"topic":"realtime:freetime","event":"postgres_changes","payload":{"data":{"table":"invites","type":"UPDATE","record":{"id":7,"from_user":"a","to_user":"b","status":"accepted","title":"Hades","starts_at":"2026-11-18T21:00:00+00:00"}}}}"#;
        assert!(matches!(parse(invite), Some(Event::Invite { id: 7, inserted: false, .. })));
        let joined = r#"{"topic":"realtime:freetime","event":"phx_reply","payload":{"status":"ok","response":{"postgres_changes":[{"id":1},{"id":2}]}},"ref":"1"}"#;
        assert_eq!(parse(joined), Some(Event::Live));
        let refused = r#"{"topic":"realtime:freetime","event":"phx_reply","payload":{"status":"error","response":{"reason":"bad token"}},"ref":"1"}"#;
        assert_eq!(parse(refused), None);
    }

    #[test]
    fn ignores_everything_else() {
        for frame in ["not json", "{}", r#"{"event":"presence_state","payload":{}}"#, r#"{"topic":"phoenix","event":"phx_reply","payload":{"status":"ok"}}"#,
            r#"{"event":"postgres_changes","payload":{"data":{"table":"profiles","type":"UPDATE","record":{}}}}"#,
            r#"{"event":"postgres_changes","payload":{"data":{"table":"messages","type":"INSERT","record":{"id":"x"}}}}"#] {
            assert_eq!(parse(frame), None, "{frame}");
        }
    }
}
