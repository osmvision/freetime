//! The user's own ideas, typed in Settings. They join the built-in ones in the ranking and live
//! in the config (on this PC, or in this browser for the web version): nothing is sent anywhere.

use crate::model::*;
use anyhow::{bail, Result};
use rand::Rng;
use serde::{Deserialize, Serialize};

pub const MAX_IDEAS: usize = 100;
const MAX_TITLE: usize = 80;
const MAX_DETAIL: usize = 200;
const MAX_LINK: usize = 300;
/// Every idea of yours carries this tag (it says nothing about taste: see `history`).
pub const TAG: &str = "mine";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyIdea {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    pub category: Category,
    /// Typical length in minutes.
    pub minutes: u32,
    pub energy: Energy,
    #[serde(default)]
    pub outdoor: bool,
    pub social: Social,
    pub cost: Cost,
    #[serde(default)]
    pub link: Option<String>,
}

/// What the form sends: everything but the id.
#[derive(Debug, Clone, Deserialize)]
pub struct MyIdeaInput {
    pub title: String,
    #[serde(default)]
    pub detail: String,
    pub category: Category,
    pub minutes: u32,
    pub energy: Energy,
    #[serde(default)]
    pub outdoor: bool,
    pub social: Social,
    pub cost: Cost,
    #[serde(default)]
    pub link: Option<String>,
}

fn clip(s: &str, max: usize) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// Only secure web pages and Steam games: an idea must never open a file or run something on the PC.
fn clean_link(link: Option<&str>) -> Result<Option<String>> {
    let Some(link) = link.map(str::trim).filter(|l| !l.is_empty()) else { return Ok(None) };
    if link.len() > MAX_LINK || link.chars().any(char::is_whitespace) {
        bail!("That link is too long or has spaces in it.");
    }
    // The same rule as opening a link: what can't be opened can't be saved.
    if !crate::open::allowed_link(link) {
        bail!("Links must start with https:// (or be a steam://rungameid/ game link).");
    }
    Ok(Some(link.to_string()))
}

impl MyIdeaInput {
    /// Checks and tidies what was typed; `id` is kept when editing, made up when adding.
    pub fn into_idea(self, id: Option<String>) -> Result<MyIdea> {
        let title = clip(&self.title, MAX_TITLE);
        if title.is_empty() {
            bail!("Give your idea a name.");
        }
        if !(5..=480).contains(&self.minutes) {
            bail!("An idea takes between 5 minutes and 8 hours.");
        }
        Ok(MyIdea {
            id: id.unwrap_or_else(new_id),
            title,
            detail: clip(&self.detail, MAX_DETAIL),
            category: self.category,
            minutes: self.minutes,
            energy: self.energy,
            outdoor: self.outdoor,
            social: self.social,
            cost: self.cost,
            link: clean_link(self.link.as_deref())?,
        })
    }
}

fn new_id() -> String {
    format!("{:010x}", rand::thread_rng().gen::<u64>() & 0xff_ffff_ffff)
}

impl MyIdea {
    pub fn suggestion_id(&self) -> String {
        format!("mine:{}", self.id)
    }

    pub fn to_suggestion(&self) -> Suggestion {
        Suggestion {
            id: self.suggestion_id(),
            category: self.category,
            title: self.title.clone(),
            detail: self.detail.clone(),
            link: self.link.clone(),
            image: None,
            min_minutes: (self.minutes * 2 / 3).max(5),
            max_minutes: self.minutes * 3 / 2,
            energy: self.energy,
            outdoor: self.outdoor,
            social: self.social,
            cost: self.cost,
            // You wrote it down because you want to do it.
            quality: 0.7,
            tags: vec![TAG.to_string()],
        }
    }

    /// Ideas that came from outside (the browser for the web version) are checked again.
    pub fn is_valid(&self) -> bool {
        let id_ok = !self.id.is_empty() && self.id.len() <= 20 && self.id.chars().all(|c| c.is_ascii_alphanumeric());
        id_ok
            && !self.title.trim().is_empty()
            && self.title.chars().count() <= MAX_TITLE
            && self.detail.chars().count() <= MAX_DETAIL
            && (5..=480).contains(&self.minutes)
            && clean_link(self.link.as_deref()).is_ok_and(|l| l == self.link)
    }
}

/// Adds an idea, newest last, refusing past `MAX_IDEAS`.
pub fn add(list: &mut Vec<MyIdea>, input: MyIdeaInput) -> Result<MyIdea> {
    if list.len() >= MAX_IDEAS {
        bail!("You already have {MAX_IDEAS} ideas of your own. Remove one first.");
    }
    let idea = input.into_idea(None)?;
    list.push(idea.clone());
    Ok(idea)
}

/// Removes an idea by its id (with or without the "mine:" prefix). False when it wasn't there.
pub fn remove(list: &mut Vec<MyIdea>, id: &str) -> bool {
    let id = id.strip_prefix("mine:").unwrap_or(id);
    let before = list.len();
    list.retain(|i| i.id != id);
    list.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(title: &str, minutes: u32, link: Option<&str>) -> MyIdeaInput {
        MyIdeaInput {
            title: title.into(),
            detail: "  with   the   kids ".into(),
            category: Category::Social,
            minutes,
            energy: Energy::Medium,
            outdoor: true,
            social: Social::Group,
            cost: Cost::Free,
            link: link.map(String::from),
        }
    }

    #[test]
    fn adds_a_tidy_idea() {
        let mut list = Vec::new();
        let idea = add(&mut list, input("  Feed   the ducks ", 30, Some(" https://example.org/ducks "))).unwrap();
        assert_eq!(idea.title, "Feed the ducks");
        assert_eq!(idea.detail, "with the kids");
        assert_eq!(idea.link.as_deref(), Some("https://example.org/ducks"));
        assert!(idea.is_valid());
        let s = idea.to_suggestion();
        assert!(s.id.starts_with("mine:") && s.has_tag(TAG));
        assert_eq!((s.min_minutes, s.max_minutes), (20, 45));
        assert!(remove(&mut list, &s.id) && list.is_empty());
        assert!(!remove(&mut list, &s.id));
    }

    #[test]
    fn refuses_bad_input() {
        let mut list = Vec::new();
        assert!(add(&mut list, input("   ", 30, None)).is_err());
        assert!(add(&mut list, input("Nap", 2, None)).is_err());
        assert!(add(&mut list, input("Nap", 600, None)).is_err());
        for bad in ["file:///C:/Windows/system32/calc.exe", "javascript:alert(1)", "steam://install/10", "http://plain.example", "https://a b"] {
            assert!(add(&mut list, input("Link", 30, Some(bad))).is_err(), "{bad}");
        }
        assert!(add(&mut list, input("Steam", 30, Some("steam://rungameid/570"))).is_ok());
        let long = "x".repeat(500);
        assert_eq!(add(&mut list, input(&long, 30, None)).unwrap().title.chars().count(), MAX_TITLE);
        while list.len() < MAX_IDEAS {
            add(&mut list, input("More", 30, None)).unwrap();
        }
        assert!(add(&mut list, input("One too many", 30, None)).is_err());
    }

    #[test]
    fn rejects_tampered_ideas() {
        let mut idea = input("Ok", 30, None).into_idea(None).unwrap();
        assert!(idea.is_valid());
        idea.link = Some("file:///etc/passwd".into());
        assert!(!idea.is_valid());
        idea.link = None;
        idea.id = "../../x".into();
        assert!(!idea.is_valid());
    }
}
