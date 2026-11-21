//! Guess the activity: five photos of built-in ideas a day, the same for everyone, each with four
//! titles to choose from. The photos ship with the UI (desktop/ui/img/ideas, credited), so the UI
//! says which ideas have one. A finished round is recorded like a puzzle of the day (puzzles.rs).

use crate::model::Suggestion;
use crate::quiz::Seq;
use chrono::NaiveDate;
use serde::Serialize;

pub const ROUNDS: usize = 5;
pub const CHOICES: usize = 4;

#[derive(Debug, Clone, Serialize)]
pub struct Round {
    /// The idea in the photo (its photo is `img/ideas/<id without "idea:">.jpg`).
    pub idea: Suggestion,
    /// Four titles, the right one among them.
    pub choices: Vec<String>,
    /// Where the right title is in `choices`.
    pub answer: usize,
}

fn shuffle<T>(list: &mut [T], seq: &mut Seq) {
    for i in (1..list.len()).rev() {
        list.swap(i, seq.below(i + 1));
    }
}

/// Today's five photos, from different kinds of ideas when possible, with three wrong titles each
/// taken from other kinds (so the photo can't fit two answers). Empty when too few photos exist.
pub fn daily(catalog: &[Suggestion], with_photo: &[String], day: NaiveDate) -> Vec<Round> {
    let mut pool: Vec<&Suggestion> = catalog
        .iter()
        .filter(|s| s.id.strip_prefix("idea:").is_some_and(|id| with_photo.iter().any(|p| p == id)))
        .collect();
    pool.sort_by(|a, b| a.id.cmp(&b.id));
    pool.dedup_by(|a, b| a.id == b.id);
    if pool.len() < ROUNDS + CHOICES {
        return Vec::new();
    }
    let mut seq = Seq::for_text(&format!("freetime-guess-{day}"));
    let mut order: Vec<usize> = (0..pool.len()).collect();
    shuffle(&mut order, &mut seq);
    let mut picked: Vec<usize> = Vec::new();
    for &i in &order {
        if picked.len() < ROUNDS && !picked.iter().any(|&p| pool[p].category == pool[i].category) {
            picked.push(i);
        }
    }
    for &i in &order {
        if picked.len() < ROUNDS && !picked.contains(&i) {
            picked.push(i);
        }
    }
    picked
        .into_iter()
        .map(|i| {
            let idea = pool[i];
            let mut others: Vec<usize> = (0..pool.len()).filter(|&k| k != i && pool[k].title != idea.title).collect();
            shuffle(&mut others, &mut seq);
            // Other kinds first; the same kind only if there aren't enough.
            others.sort_by_key(|&k| pool[k].category == idea.category);
            let mut choices: Vec<String> = vec![idea.title.clone()];
            for k in others {
                if choices.len() == CHOICES {
                    break;
                }
                if !choices.contains(&pool[k].title) {
                    choices.push(pool[k].title.clone());
                }
            }
            shuffle(&mut choices, &mut seq);
            let answer = choices.iter().position(|c| *c == idea.title).unwrap_or(0);
            Round { idea: idea.clone(), choices, answer }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;

    fn photos(catalog: &[Suggestion]) -> Vec<String> {
        catalog.iter().filter_map(|s| s.id.strip_prefix("idea:")).map(String::from).collect()
    }

    #[test]
    fn a_day_has_five_photos_with_four_titles_the_same_for_everyone() {
        let cat = catalog::load();
        let with = photos(&cat);
        let day = NaiveDate::from_ymd_opt(2026, 11, 21).unwrap();
        let rounds = daily(&cat, &with, day);
        assert_eq!(rounds.len(), ROUNDS);
        for r in &rounds {
            assert_eq!(r.choices.len(), CHOICES);
            assert_eq!(r.choices[r.answer], r.idea.title);
            let mut unique = r.choices.clone();
            unique.sort();
            unique.dedup();
            assert_eq!(unique.len(), CHOICES, "{:?}", r.choices);
            // The wrong titles come from other kinds of ideas.
            for (k, title) in r.choices.iter().enumerate().filter(|(k, _)| *k != r.answer) {
                let other = cat.iter().find(|s| &s.title == title).unwrap();
                assert_ne!(other.category, r.idea.category, "choice {k} of {}", r.idea.id);
            }
        }
        let ids: Vec<_> = rounds.iter().map(|r| r.idea.id.clone()).collect();
        let again: Vec<_> = daily(&cat, &with, day).iter().map(|r| r.idea.id.clone()).collect();
        assert_eq!(ids, again);
        let tomorrow: Vec<_> = daily(&cat, &with, day.succ_opt().unwrap()).iter().map(|r| r.idea.id.clone()).collect();
        assert_ne!(ids, tomorrow);
    }

    #[test]
    fn only_ideas_with_a_photo_and_enough_of_them() {
        let cat = catalog::load();
        let day = NaiveDate::from_ymd_opt(2026, 11, 21).unwrap();
        assert!(daily(&cat, &["run-5k".to_string()], day).is_empty());
        let some: Vec<String> = photos(&cat).into_iter().take(12).collect();
        for r in daily(&cat, &some, day) {
            assert!(some.iter().any(|p| r.idea.id == format!("idea:{p}")));
        }
    }
}
