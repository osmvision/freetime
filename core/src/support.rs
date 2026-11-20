//! "Report a problem": problem reports (tickets) sent to the freetime team, and what the admins
//! see. Sending goes through the `support` Edge Function (it works signed out too); reading and
//! handling tickets is for the accounts listed as admins in the database (see the migration
//! `support_tickets`). The calls themselves are on `account::Client`.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub const CATEGORIES: [&str; 4] = ["bug", "account", "idea", "other"];
pub const STATUSES: [&str; 3] = ["open", "in_progress", "closed"];
pub const MIN_MESSAGE: usize = 10;
pub const MAX_MESSAGE: usize = 4000;
pub const MAX_CONTACT: usize = 200;
pub const MAX_NOTE: usize = 2000;
pub const MAX_PHOTOS: usize = 3;
pub const MAX_PHOTO_LENGTH: usize = 400_000;

/// The columns an admin reads (not the address hash, which only serves the rate limit).
pub const TICKET_COLUMNS: &str = "id,created_at,updated_at,user_id,category,message,contact,app_version,platform,lang,screen,status,admin_note";

/// A report as the app sends it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewTicket {
    pub category: String,
    pub message: String,
    #[serde(default)]
    pub contact: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub screen: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub photos: Vec<String>,
}

/// Control characters out (line breaks and tabs stay), ends trimmed, at most `max` characters.
fn tidy(s: &str, max: usize) -> String {
    let kept: String = s.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect();
    kept.trim().chars().take(max).collect()
}

/// A short code-like value (language, screen): only letters, digits, `-` and `_`.
fn code(s: Option<&str>, max: usize) -> Option<String> {
    s.map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= max && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .map(str::to_string)
}

impl NewTicket {
    /// The report, cleaned up, or a readable error saying what to fix.
    pub fn checked(&self) -> Result<NewTicket> {
        if !CATEGORIES.contains(&self.category.as_str()) {
            bail!("Pick what the problem is about.");
        }
        let message = tidy(&self.message, MAX_MESSAGE + 1);
        if message.chars().count() < MIN_MESSAGE {
            bail!("Describe the problem in a few words (at least {MIN_MESSAGE} characters).");
        }
        if message.chars().count() > MAX_MESSAGE {
            bail!("That's a bit long: keep it under {MAX_MESSAGE} characters.");
        }
        if self.photos.len() > MAX_PHOTOS {
            bail!("You can attach up to 3 photos.");
        }
        if self.photos.iter().any(|image| image.len() > MAX_PHOTO_LENGTH || !image.starts_with("/9j/")) {
            bail!("One or more photos could not be attached.");
        }
        let contact = self.contact.as_deref().map(|c| tidy(c, MAX_CONTACT)).filter(|c| c.chars().count() >= 3);
        Ok(NewTicket {
            category: self.category.clone(),
            message,
            contact,
            app_version: self.app_version.as_deref().map(|v| tidy(v, 40)).filter(|v| !v.is_empty()),
            platform: self.platform.clone().filter(|p| p == "desktop" || p == "web"),
            lang: code(self.lang.as_deref(), 10),
            screen: code(self.screen.as_deref(), 40),
            photos: self.photos.clone(),
        })
    }
}

/// A ticket as an admin sees it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Ticket {
    pub id: i64,
    pub created_at: String,
    pub updated_at: String,
    pub user_id: Option<String>,
    pub category: String,
    pub message: String,
    pub contact: Option<String>,
    pub app_version: Option<String>,
    pub platform: Option<String>,
    pub lang: Option<String>,
    pub screen: Option<String>,
    pub status: String,
    pub admin_note: Option<String>,
    #[serde(default)]
    pub photo_count: u8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TicketPhoto {
    pub image: String,
}

/// A readable error for a failed send (the HTTP error from the server is in `e`).
pub fn send_error(e: &anyhow::Error) -> anyhow::Error {
    let text = e.to_string();
    if text.contains("(HTTP 429)") {
        anyhow::anyhow!("Too many reports were sent from here recently. Try again in an hour.")
    } else if text.contains("(HTTP 413)") {
        anyhow::anyhow!("The attached photos are too large.")
    } else if text.contains("(HTTP 422)") {
        anyhow::anyhow!("One or more photos could not be attached.")
    } else if text.contains("(HTTP 400)") {
        anyhow::anyhow!("Describe the problem in a few words (at least {MIN_MESSAGE} characters).")
    } else {
        anyhow::anyhow!("The report couldn't be sent. Check your connection and try again.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(category: &str, message: &str) -> NewTicket {
        NewTicket { category: category.into(), message: message.into(), ..Default::default() }
    }

    #[test]
    fn a_report_needs_a_category_and_a_real_message() {
        assert!(ticket("spam", "The quiz button does nothing").checked().is_err());
        assert!(ticket("bug", "   short   ").checked().is_err());
        assert!(ticket("bug", &"x".repeat(MAX_MESSAGE + 1)).checked().is_err());
        assert_eq!(ticket("bug", " The quiz\u{7} button does nothing \n").checked().unwrap().message, "The quiz button does nothing");
        assert!(ticket("bug", &"é".repeat(MAX_MESSAGE)).checked().is_ok(), "characters, not bytes");
    }

    #[test]
    fn extras_are_cleaned_or_dropped() {
        let t = NewTicket {
            category: "account".into(),
            message: "I can't sign in with Google".into(),
            contact: Some("  me@example.org ".into()),
            app_version: Some("0.3.1".into()),
            platform: Some("tablet".into()),
            lang: Some("fr; drop".into()),
            screen: Some("../etc".into()),
            photos: Vec::new(),
        }
        .checked()
        .unwrap();
        assert_eq!(t.contact.as_deref(), Some("me@example.org"));
        assert_eq!(t.app_version.as_deref(), Some("0.3.1"));
        assert_eq!((t.platform, t.lang, t.screen), (None, None, None));
        let short = NewTicket { contact: Some("x".into()), ..ticket("idea", "A dark mode that follows Windows") };
        assert_eq!(short.checked().unwrap().contact, None, "too short to be a way to answer");
    }

    #[test]
    fn send_errors_read_well() {
        assert!(send_error(&anyhow::anyhow!("too many tickets (HTTP 429)")).to_string().contains("an hour"));
        assert!(send_error(&anyhow::anyhow!("invalid (HTTP 400)")).to_string().contains("10 characters"));
        assert!(send_error(&anyhow::anyhow!("network error: Dns")).to_string().contains("connection"));
    }
}
