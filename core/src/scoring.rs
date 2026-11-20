//! Turns "what I can do" + "how I feel" into a ranked list.

use crate::{history::Prefs, model::*, weather::Weather};
use rand::Rng;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct Ranked {
    pub s: Suggestion,
    pub score: f64,
    pub reasons: Vec<String>,
}

pub fn rank<R: Rng>(
    items: &[Suggestion],
    req: &Request,
    weather: Option<&Weather>,
    prefs: &Prefs,
    exclude: &HashSet<String>,
    rng: &mut R,
) -> Vec<Ranked> {
    let mut seen = HashSet::new();
    let mut out: Vec<Ranked> = items
        .iter()
        .filter(|s| !exclude.contains(&s.id) && seen.insert(s.id.clone()))
        .filter_map(|s| {
            // A little randomness so you don't get the exact same list every time.
            let jitter = rng.gen_range(0.88..1.12);
            score(s, req, weather, prefs, jitter).map(|(score, reasons)| Ranked { s: s.clone(), score, reasons })
        })
        .collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score));
    out
}

/// Picks one of the `top` best at random, weighted by score (for "surprise me").
pub fn weighted_pick(ranked: &[Ranked], top: usize) -> Option<usize> {
    let n = ranked.len().min(top);
    if n == 0 {
        return None;
    }
    let total: f64 = ranked[..n].iter().map(|r| r.score.max(0.0)).sum();
    if total <= 0.0 {
        return Some(0);
    }
    let mut x = rand::thread_rng().gen_range(0.0..total);
    for (i, r) in ranked[..n].iter().enumerate() {
        x -= r.score.max(0.0);
        if x <= 0.0 {
            return Some(i);
        }
    }
    Some(n - 1)
}

/// `None` means "doesn't fit at all" (over budget, outside when staying in, way too long...).
pub fn score(
    s: &Suggestion,
    req: &Request,
    weather: Option<&Weather>,
    prefs: &Prefs,
    jitter: f64,
) -> Option<(f64, Vec<String>)> {
    if !req.wants(s.category)
        || s.cost > req.budget
        || (s.outdoor && !req.can_go_out)
        || prefs.disliked.contains(&s.id)
        || prefs.resting.contains(&s.id)
        || req.minutes * 2 < s.min_minutes
    {
        return None;
    }
    let mut reasons = Vec::new();

    let mut time = if req.minutes < s.min_minutes {
        (req.minutes as f64 / s.min_minutes as f64).powi(2)
    } else if req.minutes > s.max_minutes * 3 {
        0.75
    } else if req.minutes > s.max_minutes {
        0.9
    } else {
        1.0
    };
    // You said ideas this long felt too long for the time you had.
    if prefs.too_long.is_some_and(|share| s.min_minutes as f64 >= share * req.minutes as f64) {
        time *= 0.5;
    }

    // Doing something calmer than your energy is fine; something harder when you're tired isn't.
    let diff = s.energy.level() - req.energy.level();
    let energy = match diff {
        0 => 1.0,
        -1 => 0.7,
        -2 => 0.4,
        1 => 0.45,
        _ => 0.1,
    };
    if diff == 0 {
        match (s.category, req.energy) {
            (Category::Sport, Energy::High) => reasons.push("burns off that energy".to_string()),
            (_, Energy::High) => reasons.push("matches your high energy".to_string()),
            (_, Energy::Low) => reasons.push("zero effort needed".to_string()),
            _ => {}
        }
    }

    let social = match (req.with_friends, s.social) {
        (_, Social::Either) | (false, Social::Solo) | (true, Social::Group) => 1.0,
        (false, Social::Group) => 0.15,
        (true, Social::Solo) => 0.5,
    };
    if req.with_friends && s.social == Social::Group {
        reasons.push("made for a group".to_string());
    }

    let night_thing = s.has_tag("night");
    let mut outside = 1.0;
    if let Some(w) = weather {
        if s.outdoor {
            outside = w.outdoor_factor(night_thing);
            if outside >= 0.95 {
                reasons.push(format!("good weather for it ({:.0}°C, {})", w.temp_c, w.sky()));
            }
        }
        if night_thing {
            outside *= if w.is_day { 0.3 } else { 1.2 };
        }
    } else if s.outdoor {
        outside = 0.85; // unknown weather: slightly cautious
    }

    let quality = 0.4 + 0.6 * s.quality.clamp(0.0, 1.0);

    let cat_aff = prefs.category_affinity(s.category);
    let tag_aff = prefs.tag_affinity(&s.tags);
    let taste = (1.0 + 0.3 * cat_aff + 0.3 * tag_aff).max(0.3);

    let recent = prefs.recent.contains(&s.id);
    let liked = prefs.liked.contains(&s.id);
    let freshness = match (recent, liked) {
        (true, _) => 0.4,
        (false, true) => 1.1,
        (false, false) => 1.0,
    };
    if liked {
        reasons.insert(0, "you loved this last time".to_string());
    } else if cat_aff > 0.25 || tag_aff > 0.25 {
        reasons.push("close to things you liked".to_string());
    }
    reasons.truncate(2);

    Some((time * energy * social * outside * quality * taste * freshness * jitter, reasons))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> Request {
        Request {
            minutes: 60,
            energy: Energy::High,
            with_friends: false,
            can_go_out: true,
            budget: Cost::Cheap,
            categories: Category::ALL.to_vec(),
        }
    }

    fn item(id: &str, energy: Energy, outdoor: bool) -> Suggestion {
        Suggestion {
            id: id.into(),
            category: Category::Sport,
            title: id.into(),
            detail: String::new(),
            link: None,
            image: None,
            min_minutes: 20,
            max_minutes: 60,
            energy,
            outdoor,
            social: Social::Solo,
            cost: Cost::Free,
            quality: 0.6,
            tags: vec![],
        }
    }

    fn weather(code: u32, temp: f64) -> Weather {
        Weather { place: "Test".into(), temp_c: temp, precip_mm: 0.0, code, wind_kmh: 5.0, is_day: true }
    }

    fn s(item: &Suggestion, req: &Request, w: Option<&Weather>) -> Option<f64> {
        score(item, req, w, &Prefs::default(), 1.0).map(|x| x.0)
    }

    #[test]
    fn hard_filters() {
        let mut r = req();
        let mut paid = item("paid", Energy::High, false);
        paid.cost = Cost::Paid;
        assert!(s(&paid, &r, None).is_none());

        r.can_go_out = false;
        assert!(s(&item("run", Energy::High, true), &r, None).is_none());

        let mut long = item("hike", Energy::High, false);
        long.min_minutes = 180;
        assert!(s(&long, &req(), None).is_none());
    }

    #[test]
    fn matches_energy() {
        let mut r = req();
        let hiit = item("hiit", Energy::High, false);
        let nap = item("nap", Energy::Low, false);
        assert!(s(&hiit, &r, None) > s(&nap, &r, None));
        r.energy = Energy::Low;
        assert!(s(&nap, &r, None) > s(&hiit, &r, None));
    }

    #[test]
    fn rain_pushes_indoor_ideas_up() {
        let r = req();
        let run = item("run", Energy::High, true);
        let gym = item("gym", Energy::High, false);
        let sunny = weather(0, 18.0);
        let rainy = weather(63, 12.0);
        assert!(s(&run, &r, Some(&sunny)) >= s(&gym, &r, Some(&sunny)));
        assert!(s(&run, &r, Some(&rainy)).unwrap() < 0.5 * s(&gym, &r, Some(&rainy)).unwrap());
    }

    #[test]
    fn not_now_answers_are_heard() {
        use crate::history::{History, NotNow};
        let r = req(); // 60 minutes
        let now = 1_000_000;
        let mut short = item("short", Energy::High, false);
        short.min_minutes = 15;
        let mut long = item("long", Energy::High, false);
        long.min_minutes = 55; // 55 of 60 minutes: past the 90% said to be too long below
        let base = |p: &Prefs, i: &Suggestion| score(i, &r, None, p, 1.0).map(|x| x.0);
        let before = History::default().prefs(now);
        let long_before = base(&before, &long).unwrap();

        // "Too long" for a 45-minute idea with 50 minutes free: long ideas drop, short ones don't.
        let mut h = History::default();
        let mut too_long = item("walk", Energy::High, false);
        too_long.min_minutes = 45;
        h.not_now(&too_long, NotNow::TooLong, 50, now);
        let p = h.prefs(now);
        assert!(base(&p, &long).unwrap() < 0.6 * long_before);
        assert_eq!(base(&p, &short), base(&before, &short));

        // "Another time" rests an idea for 3 days, "already done" for two weeks.
        h.not_now(&short, NotNow::AnotherTime, 60, now);
        assert!(base(&h.prefs(now), &short).is_none());
        assert!(base(&h.prefs(now + 4 * 86_400), &short).is_some());
        h.not_now(&short, NotNow::AlreadyDone, 60, now);
        assert_eq!(h.dismissals.iter().filter(|d| d.id == "short").count(), 1, "the new answer replaces the old one");
        assert!(base(&h.prefs(now + 4 * 86_400), &short).is_none());
        assert!(base(&h.prefs(now + 15 * 86_400), &short).is_some());
        // Old "too long" answers stop counting.
        assert_eq!(h.prefs(now + 61 * 86_400).too_long, None);
    }

    #[test]
    fn weighted_pick_stays_in_top() {
        let ranked: Vec<Ranked> = (0..10)
            .map(|i| Ranked { s: item(&i.to_string(), Energy::Low, false), score: 1.0, reasons: vec![] })
            .collect();
        for _ in 0..50 {
            assert!(weighted_pick(&ranked, 3).unwrap() < 3);
        }
        assert_eq!(weighted_pick(&[], 3), None);
    }
}
