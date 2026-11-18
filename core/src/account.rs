//! Signing in to freetime's online features (Supabase). Opt-in: nothing here runs until the user
//! clicks "Sign in", and signing out stops all of it.
//!
//! Sign-in happens in the system browser with PKCE (RFC 7636) and a one-time loopback redirect
//! (RFC 8252): freetime never sees the Google password, and an intercepted code is useless
//! without the verifier, which never leaves this process. The refresh token is kept in Windows
//! Credential Manager, not in a file; access tokens only live in memory.

use crate::{net::url_encode, party::b64_encode};
use anyhow::{anyhow, bail, Context, Result};
use rand::{distributions::Alphanumeric, rngs::OsRng, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{ErrorKind, Read, Write},
    net::TcpListener,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

/// The freetime Supabase project.
pub const PROJECT_URL: &str = "https://tgvphbmbxfembnsfdxlp.supabase.co";
/// Publishable key: public by design, it ships in every copy of the app. What protects the data
/// is the database's Row Level Security (see `supabase/migrations` and its tests).
pub const PUBLISHABLE_KEY: &str = "sb_publishable_gTUA-F13205g976wz9yqRQ_xqxo3Yt_";
/// The local address the browser comes back to after signing in. It must be listed in the
/// project's allowed redirect URLs (Authentication > URL Configuration).
pub const REDIRECT_PORT: u16 = 47821;
const REDIRECT_PATH: &str = "/auth/callback";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(180);
const TIMEOUT: Duration = Duration::from_secs(12);

pub fn redirect_url() -> String {
    format!("http://127.0.0.1:{REDIRECT_PORT}{REDIRECT_PATH}")
}

/// A signed-in session. The access token expires within the hour; `refresh` gets a new one.
#[derive(Clone, Debug)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix time.
    pub expires_at: i64,
    pub user_id: String,
    pub email: Option<String>,
}

impl Session {
    pub fn fresh(&self, now: i64) -> bool {
        self.expires_at - now > 60
    }
}

// ---------------------------------------------------------------- PKCE

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// A random verifier (64 characters from the OS random generator) and its S256 challenge.
pub fn pkce() -> Pkce {
    let verifier: String = OsRng.sample_iter(&Alphanumeric).take(64).map(char::from).collect();
    let challenge = challenge_for(&verifier);
    Pkce { verifier, challenge }
}

fn challenge_for(verifier: &str) -> String {
    b64_encode(&Sha256::digest(verifier.as_bytes()))
}

/// Where the browser goes to sign in with `provider` ("google").
pub fn authorize_url(provider: &str, challenge: &str) -> String {
    format!(
        "{PROJECT_URL}/auth/v1/authorize?provider={}&redirect_to={}&code_challenge={challenge}&code_challenge_method=s256",
        url_encode(provider),
        url_encode(&redirect_url()),
    )
}

// ---------------------------------------------------------------- the loopback redirect

#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    Error(String),
    /// Anything else (a favicon request, a page with the result in its #fragment).
    Other,
}

/// Reads the request target of the browser's redirect: `/auth/callback?code=...`.
fn parse_callback(target: &str) -> Callback {
    let Some(rest) = target.strip_prefix(REDIRECT_PATH) else { return Callback::Other };
    let query = rest.strip_prefix('?').unwrap_or("");
    let mut code = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = url_decode(v);
        match k {
            "code" => code = Some(v),
            "error_description" => error = Some(v),
            "error" if error.is_none() => error = Some(v),
            _ => {}
        }
    }
    match (code, error) {
        (_, Some(e)) => Callback::Error(e.chars().filter(|c| !c.is_control()).take(200).collect()),
        // Supabase's codes are UUIDs: anything else isn't one of ours.
        (Some(c), None) if !c.is_empty() && c.len() <= 128 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') => {
            Callback::Code(c)
        }
        _ => Callback::Other,
    }
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => {
                        out.push(b);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>freetime</title>
<body style="font:16px system-ui;background:#f2f2f0;color:#0d1b3d;display:grid;place-items:center;height:90vh">
<div style="text-align:center"><h1 style="font-size:28px">{TITLE}</h1><p>{TEXT}</p></div>
<script>if(location.hash.length>1&&!location.search){location.replace(location.pathname+'?'+location.hash.slice(1))}</script>"#;

fn page(title: &str, text: &str) -> String {
    PAGE.replace("{TITLE}", title).replace("{TEXT}", text)
}

fn respond(stream: &mut impl Write, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Waits for the browser to come back with a code, answering it with a small page.
fn wait_for_code(listener: &TcpListener, deadline: Instant) -> Result<String> {
    listener.set_nonblocking(true)?;
    loop {
        match listener.accept() {
            Ok((mut stream, addr)) => {
                if !addr.ip().is_loopback() {
                    continue;
                }
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let target = request.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
                match parse_callback(target) {
                    Callback::Code(code) => {
                        respond(&mut stream, "200 OK", &page("You're signed in", "You can close this tab and go back to freetime."));
                        return Ok(code);
                    }
                    Callback::Error(e) => {
                        respond(&mut stream, "200 OK", &page("Sign-in didn't finish", "Go back to freetime and try again."));
                        bail!("sign-in was cancelled or refused ({e})");
                    }
                    Callback::Other if target.starts_with(REDIRECT_PATH) => {
                        respond(&mut stream, "200 OK", &page("Finishing sign-in…", ""));
                    }
                    Callback::Other => respond(&mut stream, "404 Not Found", ""),
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    bail!("sign-in timed out: try again");
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

// ---------------------------------------------------------------- talking to Supabase

pub struct Client {
    agent: ureq::Agent,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    user: UserResp,
}

#[derive(Deserialize)]
struct UserResp {
    id: String,
    #[serde(default)]
    email: Option<String>,
}

impl Client {
    pub fn new() -> Result<Client> {
        let tls = native_tls::TlsConnector::new()?;
        let agent = ureq::AgentBuilder::new()
            .tls_connector(Arc::new(tls))
            .timeout(TIMEOUT)
            .user_agent(concat!("freetime/", env!("CARGO_PKG_VERSION")))
            .build();
        Ok(Client { agent })
    }

    /// One request to the project. Tokens only ever travel in headers, and error messages are
    /// rebuilt from the response body so they never echo a token or a full URL.
    fn call(&self, method: &str, path: &str, bearer: Option<&str>, body: Option<&Value>, prefer: Option<&str>) -> Result<Value> {
        let mut req = self
            .agent
            .request(method, &format!("{PROJECT_URL}{path}"))
            .set("apikey", PUBLISHABLE_KEY)
            .set("Accept", "application/json");
        if let Some(token) = bearer {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        if let Some(p) = prefer {
            req = req.set("Prefer", p);
        }
        let resp = match body {
            Some(b) => req.send_json(b.clone()),
            None => req.call(),
        };
        match resp {
            Ok(r) => {
                let text = r.into_string().map_err(|e| anyhow!("unreadable response: {e}"))?;
                if text.trim().is_empty() {
                    Ok(Value::Null)
                } else {
                    serde_json::from_str(&text).map_err(|e| anyhow!("unexpected response: {e}"))
                }
            }
            Err(ureq::Error::Status(code, r)) => {
                let detail: Value = r.into_json().unwrap_or(Value::Null);
                let msg = ["msg", "message", "error_description", "error"]
                    .iter()
                    .find_map(|k| detail.get(*k).and_then(Value::as_str))
                    .unwrap_or("request refused");
                Err(anyhow!("{msg} (HTTP {code})"))
            }
            Err(ureq::Error::Transport(t)) => Err(anyhow!("network error: {}", t.kind())),
        }
    }

    fn session_from(v: Value, now: i64) -> Result<Session> {
        let t: TokenResp = serde_json::from_value(v).context("unexpected sign-in response")?;
        ensure_uuid(&t.user.id)?;
        Ok(Session { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now + t.expires_in, user_id: t.user.id, email: t.user.email })
    }

    /// The whole browser sign-in. `open` opens a URL in the system browser.
    pub fn sign_in(&self, provider: &str, open: impl Fn(&str) -> Result<()>, now: impl Fn() -> i64) -> Result<Session> {
        let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
            .map_err(|_| anyhow!("port {REDIRECT_PORT} on this PC is in use (is another sign-in open?): close it and try again"))?;
        let p = pkce();
        open(&authorize_url(provider, &p.challenge))?;
        let code = wait_for_code(&listener, Instant::now() + SIGN_IN_TIMEOUT)?;
        drop(listener);
        let v = self.call("POST", "/auth/v1/token?grant_type=pkce", None, Some(&json!({ "auth_code": code, "code_verifier": p.verifier })), None)?;
        let session = Self::session_from(v, now())?;
        store_refresh_token(&session.refresh_token)?;
        Ok(session)
    }

    /// A new access token from the refresh token (which rotates: the new one is stored).
    pub fn refresh(&self, refresh_token: &str, now: i64) -> Result<Session> {
        let v = self.call("POST", "/auth/v1/token?grant_type=refresh_token", None, Some(&json!({ "refresh_token": refresh_token })), None)?;
        let session = Self::session_from(v, now)?;
        store_refresh_token(&session.refresh_token)?;
        Ok(session)
    }

    /// Ends this session on the server and forgets it here.
    pub fn sign_out(&self, session: Option<&Session>) -> Result<()> {
        if let Some(s) = session {
            // Best effort: the local copy is removed even if the network is down.
            let _ = self.call("POST", "/auth/v1/logout?scope=local", Some(&s.access_token), None, None);
        }
        forget_refresh_token()
    }

    pub fn profile(&self, s: &Session) -> Result<OnlineProfile> {
        ensure_uuid(&s.user_id)?;
        let v = self.call("GET", &format!("/rest/v1/profiles?id=eq.{}&select={PROFILE_COLUMNS}", s.user_id), Some(&s.access_token), None, None)?;
        first_profile(v)
    }

    pub fn update_profile(&self, s: &Session, edit: &ProfileEdit) -> Result<OnlineProfile> {
        ensure_uuid(&s.user_id)?;
        let body = serde_json::to_value(edit.checked()?)?;
        let v = self.call(
            "PATCH",
            &format!("/rest/v1/profiles?id=eq.{}&select={PROFILE_COLUMNS}", s.user_id),
            Some(&s.access_token),
            Some(&body),
            Some("return=representation"),
        )?;
        first_profile(v)
    }

    pub fn reset_friend_tag(&self, s: &Session) -> Result<String> {
        let v = self.call("POST", "/rest/v1/rpc/reset_friend_tag", Some(&s.access_token), Some(&json!({})), None)?;
        v.as_str().map(str::to_string).ok_or_else(|| anyhow!("unexpected response"))
    }
}

fn ensure_uuid(id: &str) -> Result<()> {
    let ok = id.len() == 36 && id.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() });
    if ok {
        Ok(())
    } else {
        bail!("unexpected account id")
    }
}

// ---------------------------------------------------------------- the online profile

const PROFILE_COLUMNS: &str = "display_name,avatar_icon,avatar_color,bio,status_text,friend_tag";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OnlineProfile {
    pub display_name: String,
    pub avatar_icon: i16,
    pub avatar_color: i16,
    pub bio: String,
    pub status_text: String,
    pub friend_tag: String,
}

fn first_profile(v: Value) -> Result<OnlineProfile> {
    let mut list: Vec<OnlineProfile> = serde_json::from_value(v).context("unexpected profile response")?;
    if list.is_empty() {
        bail!("your online profile wasn't found");
    }
    Ok(list.remove(0))
}

/// What the user may change. The same limits as the database, checked here first for clear
/// messages (the database enforces them anyway).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileEdit {
    pub display_name: String,
    pub avatar_icon: i16,
    pub avatar_color: i16,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub status_text: String,
}

impl ProfileEdit {
    pub fn checked(&self) -> Result<ProfileEdit> {
        let clean = |s: &str| s.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
        let name = clean(&self.display_name);
        let bio = clean(&self.bio);
        let status = clean(&self.status_text);
        if name.is_empty() || name.chars().count() > 24 {
            bail!("your name needs 1 to 24 characters");
        }
        if bio.chars().count() > 160 {
            bail!("the bio is limited to 160 characters");
        }
        if status.chars().count() > 60 {
            bail!("the status is limited to 60 characters");
        }
        if !(0..24).contains(&self.avatar_icon) || !(0..8).contains(&self.avatar_color) {
            bail!("unknown avatar");
        }
        Ok(ProfileEdit { display_name: name, avatar_icon: self.avatar_icon, avatar_color: self.avatar_color, bio, status_text: status })
    }
}

// ---------------------------------------------------------------- Windows Credential Manager

#[cfg(windows)]
fn entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new("freetime", "supabase-session")?)
}

/// Whether a session is saved (no network, no token returned).
pub fn has_saved_session() -> bool {
    stored_refresh_token().is_some()
}

pub fn stored_refresh_token() -> Option<String> {
    #[cfg(windows)]
    {
        entry().ok()?.get_password().ok().filter(|t| !t.is_empty())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn store_refresh_token(token: &str) -> Result<()> {
    #[cfg(windows)]
    {
        entry()?.set_password(token).context("could not save the session in Windows Credential Manager")
    }
    #[cfg(not(windows))]
    {
        let _ = token;
        bail!("signing in is only supported on Windows for now")
    }
}

pub fn forget_refresh_token() -> Result<()> {
    #[cfg(windows)]
    {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(anyhow!("could not remove the saved session: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_the_rfc_example() {
        // RFC 7636, appendix B.
        assert_eq!(challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let a = pkce();
        let b = pkce();
        assert_eq!(a.verifier.len(), 64);
        assert_ne!(a.verifier, b.verifier);
    }

    #[test]
    fn authorize_url_asks_for_pkce_and_our_redirect() {
        let url = authorize_url("google", "abc");
        assert!(url.starts_with("https://tgvphbmbxfembnsfdxlp.supabase.co/auth/v1/authorize?provider=google&"));
        assert!(url.contains("redirect_to=http%3A%2F%2F127.0.0.1%3A47821%2Fauth%2Fcallback"));
        assert!(url.contains("code_challenge=abc&code_challenge_method=s256"));
    }

    #[test]
    fn callback_parsing() {
        assert_eq!(parse_callback("/auth/callback?code=3f0c1a2b-1111-4222-8333-444455556666"), Callback::Code("3f0c1a2b-1111-4222-8333-444455556666".into()));
        assert_eq!(parse_callback("/auth/callback?error=access_denied&error_description=User+cancelled"), Callback::Error("User cancelled".into()));
        assert_eq!(parse_callback("/favicon.ico"), Callback::Other);
        assert_eq!(parse_callback("/auth/callback"), Callback::Other);
        assert_eq!(parse_callback("/auth/callback?code=<script>"), Callback::Other, "not a code we issued");
        assert_eq!(parse_callback("/auth/callbackX?code=abc"), Callback::Other);
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(url_decode("a%20b+c%2Fd%"), "a b c/d%");
        assert_eq!(url_decode("caf%C3%A9"), "café");
    }

    #[test]
    fn profile_edits_are_checked() {
        let ok = ProfileEdit { display_name: "  Osm\n ".into(), avatar_icon: 2, avatar_color: 1, bio: String::new(), status_text: "Free tonight".into() };
        assert_eq!(ok.checked().unwrap().display_name, "Osm");
        assert!(ProfileEdit { display_name: "".into(), ..ok.clone() }.checked().is_err());
        assert!(ProfileEdit { display_name: "x".repeat(25), ..ok.clone() }.checked().is_err());
        assert!(ProfileEdit { avatar_icon: 24, ..ok.clone() }.checked().is_err());
        assert!(ProfileEdit { bio: "b".repeat(161), ..ok.clone() }.checked().is_err());
    }

    #[test]
    fn ids_must_be_uuids() {
        assert!(ensure_uuid("3f0c1a2b-1111-4222-8333-444455556666").is_ok());
        assert!(ensure_uuid("3f0c1a2b-1111-4222-8333-44445555666&x=1").is_err());
        assert!(ensure_uuid("").is_err());
    }

    #[test]
    fn the_loopback_waits_for_a_real_code() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let t = thread::spawn(move || {
            for target in ["/favicon.ico", "/auth/callback", "/auth/callback?code=3f0c1a2b-1111-4222-8333-444455556666"] {
                let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(s, "GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
                let mut out = String::new();
                let _ = s.read_to_string(&mut out);
            }
        });
        let code = wait_for_code(&listener, Instant::now() + Duration::from_secs(10)).unwrap();
        t.join().unwrap();
        assert_eq!(code, "3f0c1a2b-1111-4222-8333-444455556666");
    }
}
