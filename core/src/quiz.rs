//! The daily quiz: 5 questions a day from `data/quiz.toml`, in French and English, the same for
//! everyone (chosen and shuffled from the date). Works offline. Results stay on this PC in
//! `quiz.json`, and a finished quiz counts as a "Learn" pick in the history.

use crate::history::{now, Entry, History};
use crate::model::Category;
use anyhow::{bail, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const DATA: &str = include_str!("../data/quiz.toml");
pub const PER_DAY: usize = 5;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Question {
    pub topic: String,
    pub answer: usize,
    pub fr: String,
    pub fr_choices: Vec<String>,
    pub fr_why: String,
    pub en: String,
    pub en_choices: Vec<String>,
    pub en_why: String,
}

#[derive(Deserialize)]
struct File {
    q: Vec<Question>,
}

pub fn load() -> Vec<Question> {
    toml::from_str::<File>(DATA).expect("built-in quiz is valid (checked by tests)").q
}

/// A small seeded generator (SplitMix64): stable on every platform and version.
struct Seq(u64);

impl Seq {
    fn for_day(day: NaiveDate) -> Seq {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in format!("freetime-quiz-{day}").bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        Seq(h)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Today's questions: 5 different ones, each from a different topic when possible, with their
/// choices shuffled (the same way for everyone).
pub fn daily(bank: &[Question], day: NaiveDate) -> Vec<Question> {
    let mut seq = Seq::for_day(day);
    let mut order: Vec<usize> = (0..bank.len()).collect();
    for i in (1..order.len()).rev() {
        order.swap(i, seq.below(i + 1));
    }
    let mut picked: Vec<usize> = Vec::new();
    // First pass: one question per topic; second pass fills up if there aren't enough topics.
    for &i in &order {
        if picked.len() < PER_DAY && !picked.iter().any(|&p| bank[p].topic == bank[i].topic) {
            picked.push(i);
        }
    }
    for &i in &order {
        if picked.len() < PER_DAY && !picked.contains(&i) {
            picked.push(i);
        }
    }
    picked
        .into_iter()
        .map(|i| {
            let mut q = bank[i].clone();
            let mut perm: Vec<usize> = (0..q.fr_choices.len()).collect();
            for k in (1..perm.len()).rev() {
                perm.swap(k, seq.below(k + 1));
            }
            q.fr_choices = perm.iter().map(|&k| bank[i].fr_choices[k].clone()).collect();
            q.en_choices = perm.iter().map(|&k| bank[i].en_choices[k].clone()).collect();
            q.answer = perm.iter().position(|&k| k == bank[i].answer).unwrap_or(0);
            q
        })
        .collect()
}

// ---------------------------------------------------------------- results

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Score {
    pub score: u8,
    pub total: u8,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct QuizLog {
    /// "2026-11-19" -> score of that day's quiz.
    pub days: BTreeMap<String, Score>,
}

impl QuizLog {
    fn path() -> PathBuf {
        crate::config::data_dir().join("quiz.json")
    }

    pub fn load() -> QuizLog {
        fs::read_to_string(Self::path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn get(&self, day: NaiveDate) -> Option<Score> {
        self.days.get(&day.to_string()).copied()
    }

    /// Days in a row with a finished quiz, ending today (or yesterday, while today's is still open).
    pub fn streak(&self, today: NaiveDate) -> u32 {
        let mut d = if self.get(today).is_some() { today } else { today - chrono::Duration::days(1) };
        let mut n = 0;
        while self.get(d).is_some() {
            n += 1;
            d -= chrono::Duration::days(1);
        }
        n
    }
}

/// The history entry for a finished quiz: a "Learn" pick, not asked "how was it?".
pub fn entry_id(day: NaiveDate) -> String {
    format!("quiz:{day}")
}

/// Scores the day's answers, saves the result and records the pick. A quiz counts once a day:
/// finishing it again returns the first score.
pub fn finish(bank: &[Question], day: NaiveDate, answers: &[usize], log: &mut QuizLog, history: &mut History) -> Result<Score> {
    if let Some(done) = log.get(day) {
        return Ok(done);
    }
    let questions = daily(bank, day);
    if answers.len() != questions.len() {
        bail!("expected {} answers, got {}", questions.len(), answers.len());
    }
    let score = questions.iter().zip(answers).filter(|(q, a)| q.answer == **a).count() as u8;
    let result = Score { score, total: questions.len() as u8 };
    log.days.insert(day.to_string(), result);
    history.entries.push(Entry {
        id: entry_id(day),
        category: Category::Learn,
        title: "Today's quiz".to_string(),
        tags: vec!["quiz".to_string()],
        ts: now(),
        rating: None,
        minutes: Some(3),
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, d).unwrap()
    }

    #[test]
    fn bank_is_valid() {
        let bank = load();
        assert!(bank.len() >= 60, "{} questions", bank.len());
        let mut seen = HashSet::new();
        for q in &bank {
            assert!(seen.insert(&q.fr), "duplicate question: {}", q.fr);
            assert_eq!(q.fr_choices.len(), 4, "{}", q.fr);
            assert_eq!(q.en_choices.len(), 4, "{}", q.en);
            assert!(q.answer < 4, "{}", q.fr);
            assert!(!q.fr_why.is_empty() && !q.en_why.is_empty(), "{}", q.fr);
            let distinct: HashSet<_> = q.fr_choices.iter().collect();
            assert_eq!(distinct.len(), 4, "repeated choice in {}", q.fr);
        }
    }

    #[test]
    fn daily_is_stable_varied_and_keeps_the_right_answer() {
        let bank = load();
        let a = daily(&bank, day(19));
        let b = daily(&bank, day(19));
        assert_eq!(a.len(), PER_DAY);
        assert_eq!(a.iter().map(|q| &q.fr).collect::<Vec<_>>(), b.iter().map(|q| &q.fr).collect::<Vec<_>>());
        assert_eq!(a.iter().map(|q| q.topic.as_str()).collect::<HashSet<_>>().len(), PER_DAY, "one topic each");
        // Shuffling choices never loses the right answer.
        for q in &a {
            let original = bank.iter().find(|o| o.fr == q.fr).unwrap();
            assert_eq!(q.fr_choices[q.answer], original.fr_choices[original.answer]);
            assert_eq!(q.en_choices[q.answer], original.en_choices[original.answer]);
        }
        let other = daily(&bank, day(20));
        assert_ne!(a.iter().map(|q| &q.fr).collect::<Vec<_>>(), other.iter().map(|q| &q.fr).collect::<Vec<_>>());
    }

    #[test]
    fn answers_spread_over_positions() {
        let bank = load();
        let mut counts = [0usize; 4];
        for d in 1..=28 {
            for q in daily(&bank, NaiveDate::from_ymd_opt(2026, 2, d).unwrap()) {
                counts[q.answer] += 1;
            }
        }
        assert!(counts.iter().all(|&c| c >= 15), "right answers should land everywhere: {counts:?}");
    }

    #[test]
    fn finishing_scores_once_and_records_a_learn_pick() {
        let bank = load();
        let mut log = QuizLog::default();
        let mut history = History::default();
        let qs = daily(&bank, day(19));
        let mut answers: Vec<usize> = qs.iter().map(|q| q.answer).collect();
        answers[0] = (answers[0] + 1) % 4; // one wrong
        let s = finish(&bank, day(19), &answers, &mut log, &mut history).unwrap();
        assert_eq!(s, Score { score: 4, total: 5 });
        // Again the same day: same score, no second entry.
        let again = finish(&bank, day(19), &[0; 5], &mut log, &mut history).unwrap();
        assert_eq!(again, s);
        assert_eq!(history.entries.len(), 1);
        assert_eq!(history.entries[0].category, Category::Learn);
        assert!(finish(&bank, day(20), &[0; 3], &mut log, &mut history).is_err(), "wrong number of answers");
        log.days.insert(day(18).to_string(), Score { score: 2, total: 5 });
        assert_eq!(log.streak(day(19)), 2);
        assert_eq!(log.streak(day(20)), 2, "today still open: the streak holds");
        assert_eq!(log.streak(day(22)), 0);
    }
}
