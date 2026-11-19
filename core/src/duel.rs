//! Quiz duels: two friends answer the same 5 questions, each when they like, and compare scores.
//! The server picks the questions (by id) and scores the answers against its own copy of the
//! answer key (supabase/migrations/*_quiz_duels.sql). This side shows the questions from the bank
//! shipped in the app, with the choices shuffled the same way on every device for a given duel,
//! and turns the chosen answers back into the bank's order before sending them.

use crate::quiz::{shuffled, Question, Seq};
use anyhow::{bail, Result};

pub const QUESTIONS: usize = 5;

fn seq(duel_id: &str) -> Seq {
    Seq::for_text(&format!("freetime-duel-{duel_id}"))
}

fn find<'a>(bank: &'a [Question], id: &str) -> Result<&'a Question> {
    match bank.iter().find(|q| q.id == id) {
        Some(q) => Ok(q),
        None => bail!("This duel uses questions from a newer freetime: update the app to play it"),
    }
}

/// The duel's questions as shown, with their choices shuffled (`answer` is in the shown order).
pub fn questions(bank: &[Question], duel_id: &str, ids: &[String]) -> Result<Vec<Question>> {
    if ids.len() != QUESTIONS {
        bail!("a duel has {QUESTIONS} questions");
    }
    let mut s = seq(duel_id);
    ids.iter().map(|id| Ok(shuffled(find(bank, id)?, &mut s).0)).collect()
}

/// Turns the answers picked on screen (shown order) into the bank's order, which the server scores.
pub fn bank_answers(bank: &[Question], duel_id: &str, ids: &[String], shown: &[usize]) -> Result<Vec<usize>> {
    if ids.len() != QUESTIONS || shown.len() != QUESTIONS {
        bail!("a duel takes {QUESTIONS} answers");
    }
    let mut s = seq(duel_id);
    ids.iter()
        .zip(shown)
        .map(|(id, &k)| {
            let (_, perm) = shuffled(find(bank, id)?, &mut s);
            match perm.get(k) {
                Some(&original) => Ok(original),
                None => bail!("an answer is out of range"),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::load;
    use std::collections::HashMap;

    fn ids(bank: &[Question], picks: [usize; 5]) -> Vec<String> {
        picks.iter().map(|&i| bank[i].id.clone()).collect()
    }

    #[test]
    fn right_answers_on_screen_are_right_answers_for_the_server() {
        let bank = load();
        let ids = ids(&bank, [0, 20, 40, 60, 80]);
        let shown = questions(&bank, "duel-1", &ids).unwrap();
        let picked: Vec<usize> = shown.iter().map(|q| q.answer).collect();
        let sent = bank_answers(&bank, "duel-1", &ids, &picked).unwrap();
        let key: Vec<usize> = ids.iter().map(|id| bank.iter().find(|q| &q.id == id).unwrap().answer).collect();
        assert_eq!(sent, key);
        // Each shown question keeps its text, and its right choice is the same text.
        for (q, id) in shown.iter().zip(&ids) {
            let original = bank.iter().find(|b| &b.id == id).unwrap();
            assert_eq!(q.en, original.en);
            assert_eq!(q.en_choices[q.answer], original.en_choices[original.answer]);
            assert_eq!(q.fr_choices[q.answer], original.fr_choices[original.answer]);
        }
    }

    #[test]
    fn same_order_for_both_players_and_different_between_duels() {
        let bank = load();
        let ids = ids(&bank, [1, 2, 3, 4, 5]);
        let a = questions(&bank, "duel-a", &ids).unwrap();
        let again = questions(&bank, "duel-a", &ids).unwrap();
        assert_eq!(a.iter().map(|q| &q.en_choices).collect::<Vec<_>>(), again.iter().map(|q| &q.en_choices).collect::<Vec<_>>());
        let differs = (0..40).any(|n| {
            let b = questions(&bank, &format!("duel-{n}"), &ids).unwrap();
            a.iter().zip(&b).any(|(x, y)| x.en_choices != y.en_choices)
        });
        assert!(differs);
    }

    #[test]
    fn unknown_questions_and_bad_answers_are_refused() {
        let bank = load();
        let mut ids = ids(&bank, [1, 2, 3, 4, 5]);
        assert!(bank_answers(&bank, "d", &ids, &[0, 1, 2, 3]).is_err());
        assert!(bank_answers(&bank, "d", &ids, &[0, 1, 2, 3, 4]).is_err());
        ids[0] = "q9999".to_string();
        assert!(questions(&bank, "d", &ids).unwrap_err().to_string().contains("newer freetime"));
    }

    /// The server's answer key (in the migrations) must match the questions shipped in the app,
    /// or duels would be scored wrong.
    #[test]
    fn the_server_answer_key_matches_the_bank() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../supabase/migrations");
        let mut keys: HashMap<String, (String, usize)> = HashMap::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            if !text.contains("insert into public.quiz_keys") {
                continue;
            }
            // Rows look like: ('q001', 'space', 1)
            for line in text.lines().map(str::trim).filter(|l| l.starts_with("('q")) {
                let inner = line.trim_end_matches([',', ';']).trim_start_matches('(').trim_end_matches(')');
                let parts: Vec<&str> = inner.split(',').map(|p| p.trim().trim_matches('\'')).collect();
                assert_eq!(parts.len(), 3, "{line}");
                keys.insert(parts[0].to_string(), (parts[1].to_string(), parts[2].parse().unwrap()));
            }
        }
        let bank = load();
        for q in &bank {
            let (topic, answer) = keys.get(&q.id).unwrap_or_else(|| panic!("{} is missing from the server key: add it in a new migration", q.id));
            assert_eq!((topic.as_str(), *answer), (q.topic.as_str(), q.answer), "{} differs on the server", q.id);
        }
        assert_eq!(keys.len(), bank.len(), "the server key has questions the app doesn't");
    }
}
