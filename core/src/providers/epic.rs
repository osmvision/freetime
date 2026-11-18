//! Epic Games Store: the games that are free this week, from the store's public promotions list
//! (no key, no account). Each one becomes a pick with its cover, until the offer ends.

use crate::{
    location::Location,
    model::*,
    net::{self, Net},
    providers::Note,
};
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;

const URL: &str = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";

pub fn free_games(net: &dyn Net, location: &Location, now: DateTime<Utc>, notes: &mut Vec<Note>) -> Vec<Suggestion> {
    let cc = location.country_code.clone().unwrap_or_else(|| "US".to_string());
    let query = [("locale", "en-US"), ("country", cc.as_str()), ("allowCountries", cc.as_str())];
    match net::get_json::<Value>(net, URL, &query).map(|v| parse(&v, now)) {
        Ok(items) => items,
        Err(e) => {
            notes.push(Note::problem(format!("Epic Games Store unavailable ({e}).")));
            Vec::new()
        }
    }
}

/// The games free right now: a 100% discount whose dates include `now`.
fn parse(v: &Value, now: DateTime<Utc>) -> Vec<Suggestion> {
    let Some(elements) = v.pointer("/data/Catalog/searchStore/elements").and_then(Value::as_array) else {
        return Vec::new();
    };
    elements.iter().filter_map(|el| game(el, now).ok().flatten()).collect()
}

fn game(el: &Value, now: DateTime<Utc>) -> Result<Option<Suggestion>> {
    let title = el.get("title").and_then(Value::as_str).unwrap_or("").trim();
    if title.is_empty() || title.to_lowercase().contains("mystery") {
        return Ok(None);
    }
    let offers = el.pointer("/promotions/promotionalOffers").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut ends: Option<DateTime<Utc>> = None;
    for group in offers {
        for offer in group.get("promotionalOffers").and_then(Value::as_array).cloned().unwrap_or_default() {
            let date = |k: &str| offer.get(k).and_then(Value::as_str).and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&Utc));
            let free = offer.pointer("/discountSetting/discountPercentage").and_then(Value::as_u64) == Some(0);
            if let (true, Some(start), Some(end)) = (free, date("startDate"), date("endDate")) {
                if start <= now && now < end {
                    ends = Some(end);
                }
            }
        }
    }
    let Some(end) = ends else { return Ok(None) };

    // The store page: catalog mapping, offer mapping or product slug ("name/home" -> "name").
    let slug = [
        el.pointer("/catalogNs/mappings/0/pageSlug"),
        el.pointer("/offerMappings/0/pageSlug"),
        el.get("productSlug"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .map(|s| s.split('/').next().unwrap_or("").to_string())
    .find(|s| !s.is_empty() && s.len() <= 70 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    let Some(slug) = slug else { return Ok(None) };

    let image = el.get("keyImages").and_then(Value::as_array).and_then(|imgs| {
        ["OfferImageWide", "DieselStoreFrontWide", "Thumbnail"].iter().find_map(|kind| {
            imgs.iter()
                .find(|i| i.get("type").and_then(Value::as_str) == Some(kind))
                .and_then(|i| i.get("url").and_then(Value::as_str))
                .filter(|u| u.starts_with("https://"))
                .map(str::to_string)
        })
    });

    Ok(Some(Suggestion {
        id: format!("epic:{slug}"),
        category: Category::Game,
        title: title.to_string(),
        detail: format!("Free on the Epic Games Store until {}", end.format("%d/%m")),
        link: Some(format!("https://store.epicgames.com/p/{slug}")),
        image,
        min_minutes: 30,
        max_minutes: 120,
        energy: Energy::Medium,
        outdoor: false,
        social: Social::Either,
        cost: Cost::Free,
        quality: 0.72,
        tags: vec!["epic".into(), "store".into(), "free-week".into()],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::fake::FakeNet;

    const FEED: &str = r#"{"data":{"Catalog":{"searchStore":{"elements":[
      {"title":"Free Now Game","productSlug":"free-now-game/home","catalogNs":{"mappings":[{"pageSlug":"free-now-game"}]},
       "keyImages":[{"type":"Thumbnail","url":"https://cdn1.epicgames.com/t.jpg"},{"type":"OfferImageWide","url":"https://cdn1.epicgames.com/wide.jpg"}],
       "promotions":{"promotionalOffers":[{"promotionalOffers":[{"startDate":"2026-11-13T16:00:00.000Z","endDate":"2026-11-20T16:00:00.000Z","discountSetting":{"discountType":"PERCENTAGE","discountPercentage":0}}]}],"upcomingPromotionalOffers":[]}},
      {"title":"Next Week Game","productSlug":"next-week","promotions":{"promotionalOffers":[],"upcomingPromotionalOffers":[{"promotionalOffers":[{"startDate":"2026-11-20T16:00:00.000Z","endDate":"2026-11-27T16:00:00.000Z","discountSetting":{"discountPercentage":0}}]}]}},
      {"title":"Half Price Game","productSlug":"half","promotions":{"promotionalOffers":[{"promotionalOffers":[{"startDate":"2026-11-13T16:00:00.000Z","endDate":"2026-11-20T16:00:00.000Z","discountSetting":{"discountPercentage":50}}]}]}},
      {"title":"Mystery Game","productSlug":"mystery","promotions":{"promotionalOffers":[{"promotionalOffers":[{"startDate":"2026-11-13T16:00:00.000Z","endDate":"2026-11-20T16:00:00.000Z","discountSetting":{"discountPercentage":0}}]}]}},
      {"title":"Bad Slug","productSlug":"../../evil?x=1","promotions":{"promotionalOffers":[{"promotionalOffers":[{"startDate":"2026-11-13T16:00:00.000Z","endDate":"2026-11-20T16:00:00.000Z","discountSetting":{"discountPercentage":0}}]}]}},
      {"title":"No Promotions","productSlug":"nothing","promotions":null}
    ]}}}}"#;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-18T19:00:00Z").unwrap().with_timezone(&Utc)
    }

    #[test]
    fn only_games_free_right_now_with_a_safe_store_link() {
        let v: Value = serde_json::from_str(FEED).unwrap();
        let games = parse(&v, now());
        assert_eq!(games.len(), 1, "{games:?}");
        let g = &games[0];
        assert_eq!(g.id, "epic:free-now-game");
        assert_eq!(g.link.as_deref(), Some("https://store.epicgames.com/p/free-now-game"));
        assert_eq!(g.image.as_deref(), Some("https://cdn1.epicgames.com/wide.jpg"));
        assert_eq!(g.detail, "Free on the Epic Games Store until 20/11");
        assert_eq!(g.cost, Cost::Free);
    }

    #[test]
    fn asks_for_the_users_country_and_fails_soft() {
        let net = FakeNet::new().on(URL, FEED);
        let location = Location { country_code: Some("FR".into()), ..Default::default() };
        let mut notes = Vec::new();
        assert_eq!(free_games(&net, &location, now(), &mut notes).len(), 1);
        assert!(net.calls()[0].contains("country=FR"));
        let down = FakeNet::new();
        assert!(free_games(&down, &location, now(), &mut notes).is_empty());
        assert!(notes.iter().any(|n| n.text.starts_with("Epic Games Store unavailable")));
    }
}
