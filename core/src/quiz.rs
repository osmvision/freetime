//! The daily quiz: 5 questions a day from `data/quiz.toml`, in French and English, the same for
//! everyone (chosen and shuffled from the date). Works offline. Results stay on this PC in
//! `quiz.json`, and a finished quiz counts as a "Learn" pick in the history.

use crate::history::{now, Entry, History};
use crate::model::Category;
use crate::net::{self, Net};
use anyhow::{bail, Result};
use rand::seq::SliceRandom;
use rand::Rng;
use serde_json::Value;
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

// ---------------------------------------------------------------- bonus quiz (Open Trivia DB)

/// Open Trivia Database: free, no key, questions under CC BY-SA 4.0 (credited in the app).
/// English only. Only called when the user opens the bonus quiz.
pub const TRIVIA_URL: &str = "https://opentdb.com/api.php";

#[derive(Debug, Clone, Serialize)]
pub struct Trivia {
    pub question: String,
    pub choices: Vec<String>,
    pub answer: usize,
    pub category: String,
    pub difficulty: String,
}

/// Decodes RFC 3986 percent-encoding (the API's `encode=url3986`, which avoids HTML entities).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 5 multiple-choice questions, with the right answer at a random place.
pub fn fetch_trivia(net: &dyn Net, rng: &mut impl Rng) -> Result<Vec<Trivia>> {
    let v: Value = net::get_json(net, TRIVIA_URL, &[("amount", "5"), ("type", "multiple"), ("encode", "url3986")])?;
    match v["response_code"].as_u64() {
        Some(0) => {}
        Some(5) => bail!("Too many bonus quizzes at once: wait a few seconds and try again"),
        _ => bail!("No bonus questions available right now"),
    }
    let text = |x: &Value| x.as_str().map(percent_decode).unwrap_or_default();
    let mut out = Vec::new();
    for r in v["results"].as_array().into_iter().flatten() {
        let right = text(&r["correct_answer"]);
        let mut choices: Vec<String> = r["incorrect_answers"].as_array().into_iter().flatten().map(text).collect();
        if right.is_empty() || choices.len() != 3 {
            continue;
        }
        choices.push(right.clone());
        choices.shuffle(rng);
        let answer = choices.iter().position(|c| *c == right).unwrap_or(0);
        out.push(Trivia { question: text(&r["question"]), choices, answer, category: text(&r["category"]), difficulty: text(&r["difficulty"]) });
    }
    if out.is_empty() {
        bail!("No bonus questions available right now");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn bonus_trivia_is_decoded_and_shuffled() {
        use crate::net::fake::FakeNet;
        let body = r#"{"response_code":0,"results":[{"type":"multiple","difficulty":"easy","category":"Science%3A%20Computers","question":"What%20does%20%22CPU%22%20stand%20for%3F","correct_answer":"Central%20Processing%20Unit","incorrect_answers":["Central%20Process%20Unit","Computer%20Personal%20Unit","Central%20Processor%20Unit"]}]}"#;
        let net = FakeNet::new().on(TRIVIA_URL, body);
        let mut rng = rand::rngs::mock::StepRng::new(3, 7);
        let qs = fetch_trivia(&net, &mut rng).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].question, "What does \"CPU\" stand for?");
        assert_eq!(qs[0].category, "Science: Computers");
        assert_eq!(qs[0].choices[qs[0].answer], "Central Processing Unit");
        assert!(net.calls()[0].contains("encode=url3986"));
        let limited = FakeNet::new().on(TRIVIA_URL, r#"{"response_code":5,"results":[]}"#);
        assert!(fetch_trivia(&limited, &mut rng).unwrap_err().to_string().contains("wait a few seconds"));
        assert!(fetch_trivia(&FakeNet::new(), &mut rng).is_err(), "offline");
        assert_eq!(percent_decode("caf%C3%A9%20%25"), "café %");
        assert_eq!(percent_decode("100%é%"), "100%é%", "a stray % is kept as is");
    }

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
