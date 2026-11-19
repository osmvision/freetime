//! Web transport for the shared Rust engine. Browser state arrives with each
//! request. Desktop files, credentials, process launching and updates stay local
//! to Tauri and are never exposed by this server.
mod engine;
mod social;
mod sources;

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const LIMIT: u64 = 2 * 1024 * 1024;

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid HTTP header")
}

fn respond(request: Request, code: u16, mime: &str, bytes: Vec<u8>) {
    let cache_policy = if request.url().starts_with("/api/") {
        "no-store"
    } else {
        "no-cache"
    };
    let response = Response::from_data(bytes).with_status_code(StatusCode(code))
        .with_header(header("Content-Type", mime))
        .with_header(header("Cache-Control", cache_policy))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "same-origin"))
        .with_header(header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com https://*.steamstatic.com https://*.epicgames.com https://*.unrealengine.com; font-src 'self'; connect-src 'self' https://tgvphbmbxfembnsfdxlp.supabase.co wss://tgvphbmbxfembnsfdxlp.supabase.co; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"));
    let _ = request.respond(response);
}

fn serve(mut request: Request, ui: &Path, public: &Path) {
    let url = request.url().split('?').next().unwrap_or("/").to_string();
    if request.method() == &Method::Get && url == "/auth/callback" {
        // Keep the PKCE code on this origin while returning to the root document,
        // whose relative script and stylesheet URLs resolve from /.
        let location = request
            .url()
            .split_once('?')
            .map(|(_, query)| format!("/?{query}"))
            .unwrap_or_else(|| "/".into());
        let response = Response::empty(StatusCode(303))
            .with_header(header("Location", &location))
            .with_header(header("Cache-Control", "no-store"));
        let _ = request.respond(response);
        return;
    }
    if request.method() == &Method::Post && url == "/api/invoke" {
        // JSON requests from other origins cannot spend a browser's session.
        let json = request.headers().iter().any(|h| {
            h.field.equiv("Content-Type") && h.value.as_str().starts_with("application/json")
        });
        if !json {
            respond(request, 415, "text/plain", b"JSON required".to_vec());
            return;
        }
        let mut body = String::new();
        let read = request
            .as_reader()
            .take(LIMIT + 1)
            .read_to_string(&mut body);
        if read.is_err() || body.len() as u64 > LIMIT {
            respond(request, 413, "text/plain", b"Request too large".to_vec());
            return;
        }
        let token = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .and_then(|h| h.value.as_str().strip_prefix("Bearer "))
            .map(str::to_string);
        let result = serde_json::from_str::<engine::Call>(&body)
            .map_err(anyhow::Error::from)
            .and_then(|call| engine::invoke(call, token.as_deref()));
        let (code, data) = match result {
            Ok(data) => (200, data),
            Err(e) => (400, serde_json::json!({"error": e.to_string()})),
        };
        respond(
            request,
            code,
            "application/json; charset=utf-8",
            data.to_string().into_bytes(),
        );
        return;
    }
    if request.method() != &Method::Get && request.method() != &Method::Head {
        respond(request, 405, "text/plain", b"Method not allowed".to_vec());
        return;
    }
    if url == "/api/config" {
        let config = serde_json::json!({"url": freetime_core::account::PROJECT_URL, "key": freetime_core::account::PUBLISHABLE_KEY});
        respond(
            request,
            200,
            "application/json",
            config.to_string().into_bytes(),
        );
        return;
    }
    let (base, relative) = match url.as_str() {
        "/" => (ui, "index.html"),
        "/web-auth.js" => (public, "../dist/auth.js"),
        "/manifest.webmanifest" => (public, "manifest.webmanifest"),
        "/sw.js" => (public, "../dist/sw.js"),
        "/precache.json" => (public, "../dist/precache.json"),
        "/offline.html" => (public, "offline.html"),
        "/icon-192.png" => (public, "icon-192.png"),
        "/icon-512.png" => (public, "icon-512.png"),
        _ => (ui, url.trim_start_matches('/')),
    };
    // Only serve public app assets, with canonical containment even for encoded,
    // Windows-style, or symlink paths. The repository and .env are outside ui/.
    if relative.contains('\\') || relative.contains('%') || relative.contains(':') {
        respond(request, 404, "text/plain", b"Not found".to_vec());
        return;
    }
    let path = base.join(relative).canonicalize();
    let allowed_base = if ["/web-auth.js", "/sw.js", "/precache.json"].contains(&url.as_str()) {
        public.parent().unwrap().join("dist")
    } else {
        base.to_path_buf()
    };
    let path = path
        .ok()
        .filter(|p| allowed_base.canonicalize().is_ok_and(|b| p.starts_with(b)) && p.is_file());
    let Some(path) = path else {
        respond(request, 404, "text/plain", b"Not found".to_vec());
        return;
    };
    let mime = match path.extension().and_then(|s| s.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json",
        "woff2" => "font/woff2",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        _ => "application/octet-stream",
    };
    match fs::read(&path) {
        Ok(bytes) => respond(request, 200, mime, bytes),
        Err(_) => respond(request, 404, "text/plain", b"Not found".to_vec()),
    }
}

fn main() -> anyhow::Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let ui = Arc::new(root.join("../desktop/ui").canonicalize()?);
    let public = Arc::new(root.join("public").canonicalize()?);
    let address = std::env::var("FREETIME_WEB_BIND").unwrap_or_else(|_| "127.0.0.1:4173".into());
    let server = Arc::new(Server::http(&address).map_err(|e| anyhow::anyhow!("{e}"))?);
    println!("freetime web listening on http://{address}");
    let mut workers = Vec::new();
    for _ in 0..8 {
        let (server, ui, public) = (server.clone(), ui.clone(), public.clone());
        workers.push(thread::spawn(move || {
            for request in server.incoming_requests() {
                serve(request, &ui, &public);
            }
        }));
    }
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}
