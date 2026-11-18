//! Network access behind a trait, so every provider can be tested without the internet.

use anyhow::{anyhow, Result};
use serde::de::DeserializeOwned;
use std::{sync::Arc, time::Duration};

/// Every request gives up after this long: a slow source never holds up the others.
pub const TIMEOUT: Duration = Duration::from_secs(5);

pub trait Net: Send + Sync {
    /// GET `url` with `query` parameters (URL-encoded for you) and return the body as text.
    fn get_text(&self, url: &str, query: &[(&str, &str)]) -> Result<String>;
}

/// GET and parse JSON.
pub fn get_json<T: DeserializeOwned>(net: &dyn Net, url: &str, query: &[(&str, &str)]) -> Result<T> {
    let text = net.get_text(url, query)?;
    serde_json::from_str(&text).map_err(|e| anyhow!("unexpected response: {e}"))
}

/// The real network: ureq with the OS TLS stack.
pub struct HttpNet {
    agent: ureq::Agent,
}

impl HttpNet {
    pub fn new() -> Result<HttpNet> {
        let tls = native_tls::TlsConnector::new()?;
        let agent = ureq::AgentBuilder::new()
            .tls_connector(Arc::new(tls))
            .timeout(TIMEOUT)
            .user_agent(concat!("freetime/", env!("CARGO_PKG_VERSION")))
            .build();
        Ok(HttpNet { agent })
    }

    /// A shareable handle, for work that outlives the caller (background refreshes).
    pub fn shared() -> Result<Arc<dyn Net>> {
        Ok(Arc::new(HttpNet::new()?))
    }
}

impl Net for HttpNet {
    fn get_text(&self, url: &str, query: &[(&str, &str)]) -> Result<String> {
        let mut req = self.agent.get(url);
        for (k, v) in query {
            req = req.query(k, v);
        }
        // Errors are rebuilt by hand: ureq's own messages contain the full URL,
        // which would print API keys passed as query parameters.
        match req.call() {
            Ok(resp) => resp.into_string().map_err(|e| anyhow!("unreadable response: {e}")),
            Err(ureq::Error::Status(code, _)) => Err(anyhow!("HTTP {code}")),
            Err(ureq::Error::Transport(t)) => Err(anyhow!("network error: {}", t.kind())),
        }
    }
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

/// A fake network for tests: canned bodies by URL prefix, everything else fails like a dead connection.
#[cfg(test)]
pub mod fake {
    use super::Net;
    use anyhow::{anyhow, Result};
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeNet {
        routes: Vec<(String, Result<String, String>)>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeNet {
        pub fn new() -> FakeNet {
            FakeNet::default()
        }

        /// Requests whose URL starts with `prefix` get `body`.
        pub fn on(mut self, prefix: &str, body: &str) -> FakeNet {
            self.routes.push((prefix.to_string(), Ok(body.to_string())));
            self
        }

        /// Requests whose URL starts with `prefix` fail.
        pub fn fail(mut self, prefix: &str) -> FakeNet {
            self.routes.push((prefix.to_string(), Err("HTTP 503".to_string())));
            self
        }

        /// Every URL requested so far, with its query string.
        pub fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Net for FakeNet {
        fn get_text(&self, url: &str, query: &[(&str, &str)]) -> Result<String> {
            let full = if query.is_empty() {
                url.to_string()
            } else {
                let q: Vec<String> = query.iter().map(|(k, v)| format!("{k}={v}")).collect();
                format!("{url}?{}", q.join("&"))
            };
            self.calls.lock().unwrap().push(full);
            match self.routes.iter().find(|(prefix, _)| url.starts_with(prefix.as_str())) {
                Some((_, Ok(body))) => Ok(body.clone()),
                Some((_, Err(e))) => Err(anyhow!(e.clone())),
                None => Err(anyhow!("network error: no route to {url}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_query_values() {
        assert_eq!(url_encode("game design"), "game+design");
        assert_eq!(url_encode("café & co"), "caf%C3%A9+%26+co");
    }

    #[test]
    fn fake_net_routes_by_prefix() {
        let net = fake::FakeNet::new().on("https://a.test/", "{\"ok\":true}").fail("https://b.test/");
        let v: serde_json::Value = get_json(&net, "https://a.test/x", &[("k", "v")]).unwrap();
        assert_eq!(v["ok"], true);
        assert!(net.get_text("https://b.test/", &[]).is_err());
        assert!(net.get_text("https://c.test/", &[]).is_err());
        assert_eq!(net.calls()[0], "https://a.test/x?k=v");
    }
}
