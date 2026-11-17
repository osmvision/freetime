use anyhow::{anyhow, Result};
use serde::de::DeserializeOwned;
use std::{sync::Arc, time::Duration};

pub fn agent() -> Result<ureq::Agent> {
    let tls = native_tls::TlsConnector::new()?;
    Ok(ureq::AgentBuilder::new()
        .tls_connector(Arc::new(tls))
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("freetime/", env!("CARGO_PKG_VERSION")))
        .build())
}

fn call(agent: &ureq::Agent, url: &str, query: &[(&str, &str)]) -> Result<ureq::Response> {
    let mut req = agent.get(url);
    for (k, v) in query {
        req = req.query(k, v);
    }
    // Errors are rebuilt by hand: ureq's own messages contain the full URL,
    // which would print API keys passed as query parameters.
    match req.call() {
        Ok(resp) => Ok(resp),
        Err(ureq::Error::Status(code, _)) => Err(anyhow!("HTTP {code}")),
        Err(ureq::Error::Transport(t)) => Err(anyhow!("network error: {}", t.kind())),
    }
}

pub fn get_json<T: DeserializeOwned>(agent: &ureq::Agent, url: &str, query: &[(&str, &str)]) -> Result<T> {
    call(agent, url, query)?
        .into_json::<T>()
        .map_err(|e| anyhow!("unexpected response: {e}"))
}

pub fn get_text(agent: &ureq::Agent, url: &str) -> Result<String> {
    call(agent, url, &[])?
        .into_string()
        .map_err(|e| anyhow!("unreadable response: {e}"))
}

pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_query_values() {
        assert_eq!(url_encode("game design"), "game+design");
        assert_eq!(url_encode("café & co"), "caf%C3%A9+%26+co");
    }
}
