//! Picking together without a server: friend codes.
//!
//! Each person's freetime can show a **friend code**, a short text you paste to a friend over
//! Discord or anywhere. It carries a nickname, the app ids of the Steam games you own, and your
//! taste per kind of idea. Nothing else: no SteamID, no history, no location, no account.
//!
//! A code comes from someone else, so it is parsed as untrusted input: size limits, a strict
//! format, a checksum against paste mistakes, and no trailing bytes.
//!
//! Format: `FT1.` + base64url (no padding) of
//! `[version u8][name len u8][name utf-8][taste: 8 x i8][avatar icon u8][avatar color u8]`
//! `[game count varint][app id deltas varint...][fletcher16 u16 BE]`.
//! Version 1 had no avatar bytes; it is still read (default avatar).

use crate::{
    config,
    model::{Category, Social, Suggestion},
    providers::{steam, steam_import::Library},
    scoring::Ranked,
};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::PathBuf};

pub const PREFIX: &str = "FT1.";
const VERSION: u8 = 2;
/// Avatar icons and colors are indexes into lists the UI owns (`ui/js/avatars.js`); the lists
/// only ever grow, and an index this version doesn't know falls back to the default.
pub const AVATAR_ICONS: u8 = 24;
pub const AVATAR_COLORS: u8 = 8;
/// Longest code accepted (about 10,000 games), so a pasted novel can't eat memory.
const MAX_CODE_LEN: usize = 60_000;
const MAX_GAMES: usize = 10_000;
pub const MAX_NAME_CHARS: usize = 24;
pub const MAX_FRIENDS: usize = 50;
/// Games everyone owns, added to the candidates when nothing else brought them in.
const MAX_TOGETHER_PICKS: usize = 12;

/// A friend added from their code (or your own code, before it's encoded).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Friend {
    pub name: String,
    /// Steam app ids, sorted, no duplicates.
    pub games: Vec<u32>,
    /// Taste per kind of idea, in `Category::ALL` order, -100..=100.
    pub taste: [i8; 8],
    /// Unix time it was added (0 for your own code).
    #[serde(default)]
    pub added: i64,
    #[serde(default)]
    pub avatar: Avatar,
}

/// The look of a profile before accounts exist: an icon and a color, both from fixed lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Avatar {
    pub icon: u8,
    pub color: u8,
}

impl Avatar {
    /// Unknown indexes (from a newer app, or a hand-edited file) become the default.
    pub fn checked(self) -> Avatar {
        Avatar {
            icon: if self.icon < AVATAR_ICONS { self.icon } else { 0 },
            color: if self.color < AVATAR_COLORS { self.color } else { 0 },
        }
    }
}

impl Friend {
    /// Your own code: your nickname, your imported Steam games and your learned taste.
    pub fn mine(name: &str, avatar: Avatar, library: Option<&Library>, taste: &[(Category, f64)]) -> Friend {
        let mut games: Vec<u32> = library.map(|l| l.games.iter().map(|g| g.appid).filter(|id| *id > 0).collect()).unwrap_or_default();
        games.sort_unstable();
        games.dedup();
        games.truncate(MAX_GAMES);
        let mut t = [0i8; 8];
        for (cat, aff) in taste {
            t[index(*cat)] = (aff.clamp(-1.0, 1.0) * 100.0).round() as i8;
        }
        Friend { name: clean_name(name), games, taste: t, added: 0, avatar: avatar.checked() }
    }

    pub fn owns(&self, appid: u32) -> bool {
        self.games.binary_search(&appid).is_ok()
    }

    /// -1..1, how much this friend likes a kind of idea.
    pub fn affinity(&self, c: Category) -> f64 {
        self.taste[index(c)] as f64 / 100.0
    }

    pub fn encode(&self) -> String {
        let name = clean_name(&self.name);
        let mut out = vec![VERSION, name.len() as u8];
        out.extend_from_slice(name.as_bytes());
        out.extend(self.taste.iter().map(|t| *t as u8));
        let avatar = self.avatar.checked();
        out.extend([avatar.icon, avatar.color]);
        let mut games = self.games.clone();
        games.sort_unstable();
        games.dedup();
        games.retain(|g| *g > 0);
        games.truncate(MAX_GAMES);
        put_varint(&mut out, games.len() as u32);
        let mut prev = 0u32;
        for g in games {
            put_varint(&mut out, g - prev);
            prev = g;
        }
        let sum = fletcher16(&out);
        out.extend_from_slice(&sum.to_be_bytes());
        format!("{PREFIX}{}", b64_encode(&out))
    }

    /// Parses a pasted code. Spaces and line breaks (chat apps wrap long text) are ignored.
    pub fn decode(text: &str) -> Result<Friend> {
        ensure!(text.len() <= MAX_CODE_LEN, "that code is too long to be a freetime friend code");
        let text: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        let Some(body) = text.strip_prefix(PREFIX) else {
            bail!("that doesn't look like a freetime friend code (they start with {PREFIX})");
        };
        let bytes = b64_decode(body).context("the code has characters that don't belong in it")?;
        ensure!(bytes.len() >= 1 + 1 + 8 + 1 + 2, "the code is cut short: copy it again in full");
        let (payload, sum) = bytes.split_at(bytes.len() - 2);
        ensure!(fletcher16(payload).to_be_bytes() == sum, "the code is damaged or cut short: copy it again in full");

        let mut r = Reader { buf: payload, pos: 0 };
        let version = r.byte()?;
        ensure!(version == 1 || version == VERSION, "this code comes from a newer freetime: update the app");
        let name_len = r.byte()? as usize;
        ensure!(name_len <= MAX_NAME_CHARS * 4, "the name in the code is too long");
        let name = std::str::from_utf8(r.take(name_len)?).context("the name in the code isn't valid text")?;
        let mut taste = [0i8; 8];
        for t in &mut taste {
            *t = (r.byte()? as i8).clamp(-100, 100);
        }
        let avatar = if version >= 2 { Avatar { icon: r.byte()?, color: r.byte()? }.checked() } else { Avatar::default() };
        let count = r.varint()? as usize;
        ensure!(count <= MAX_GAMES, "the code lists too many games");
        let mut games = Vec::with_capacity(count);
        let mut prev = 0u64;
        for _ in 0..count {
            // Strictly increasing ids: every step is at least 1 (the first step is the first id).
            let delta = r.varint()? as u64;
            ensure!(delta > 0, "the game list in the code is malformed");
            prev += delta;
            ensure!(prev > 0 && prev <= u32::MAX as u64, "the game list in the code is malformed");
            games.push(prev as u32);
        }
        ensure!(r.pos == payload.len(), "the code has extra data at the end");
        Ok(Friend { name: clean_name(name), games, taste, added: 0, avatar })
    }
}

fn index(c: Category) -> usize {
    Category::ALL.iter().position(|x| *x == c).unwrap_or(0)
}

/// Printable, trimmed, at most 24 characters; "Friend" when nothing is left.
pub fn clean_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = cleaned.chars().take(MAX_NAME_CHARS).collect();
    if cut.is_empty() {
        "Friend".to_string()
    } else {
        cut
    }
}

// ---------------------------------------------------------------- the friends list on this PC

fn friends_path() -> PathBuf {
    config::data_dir().join("friends.json")
}

pub fn load_friends() -> Vec<Friend> {
    fs::read_to_string(friends_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_friends(friends: &[Friend]) -> Result<()> {
    fs::create_dir_all(config::data_dir())?;
    fs::write(friends_path(), serde_json::to_string_pretty(friends)?)?;
    Ok(())
}

/// Adds a friend, or updates the one with the same name (a fresh code replaces the old one).
pub fn upsert(friends: &mut Vec<Friend>, friend: Friend) -> Result<()> {
    if let Some(old) = friends.iter_mut().find(|f| f.name.eq_ignore_ascii_case(&friend.name)) {
        *old = friend;
        return Ok(());
    }
    ensure!(friends.len() < MAX_FRIENDS, "you can keep up to {MAX_FRIENDS} friends: remove one first");
    friends.push(friend);
    Ok(())
}

// ---------------------------------------------------------------- ranking together

/// The friends you're with right now, and the Steam games all of you own.
pub struct Party {
    friends: Vec<Friend>,
    /// (app id, name) of games you own that every friend here owns too.
    common: Vec<(u32, String)>,
    common_ids: HashSet<u32>,
    /// Whether your own Steam games are known (imported), so "only you own it" means something.
    library_known: bool,
}

impl Party {
    pub fn new(mut friends: Vec<Friend>, mine: Option<&Library>) -> Party {
        // `owns` binary-searches: never trust a hand-edited friends.json to be sorted.
        for f in &mut friends {
            f.games.sort_unstable();
            f.games.dedup();
        }
        let mut common: Vec<(u32, String, u32)> = Vec::new();
        if let Some(lib) = mine {
            if !friends.is_empty() {
                for g in &lib.games {
                    if friends.iter().all(|f| f.owns(g.appid)) {
                        common.push((g.appid, g.name.clone(), g.playtime));
                    }
                }
            }
        }
        // Games you've actually played first.
        common.sort_by(|a, b| b.2.cmp(&a.2));
        let common: Vec<(u32, String)> = common.into_iter().map(|(id, name, _)| (id, name)).collect();
        let common_ids = common.iter().map(|(id, _)| *id).collect();
        Party { friends, common, common_ids, library_known: mine.is_some() }
    }

    pub fn is_empty(&self) -> bool {
        self.friends.is_empty()
    }

    pub fn common_games(&self) -> usize {
        self.common.len()
    }

    fn names(&self) -> String {
        match self.friends.as_slice() {
            [] => String::new(),
            [a] => a.name.clone(),
            [a, b] => format!("{} and {}", a.name, b.name),
            [a, rest @ ..] => format!("{} and {} others", a.name, rest.len()),
        }
    }

    fn owners_reason(&self) -> String {
        match self.friends.len() {
            1 => format!("{} owns it too", self.friends[0].name),
            2 => format!("{} own it too", self.names()),
            _ => "everyone owns it".to_string(),
        }
    }

    /// Before scoring: a game everyone owns counts as something to play together, and the
    /// best of those join the candidates even if the solo picks didn't bring them in.
    pub fn prepare(&self, items: &mut Vec<Suggestion>) {
        for s in items.iter_mut() {
            if self.common_ids.contains(&steam_appid(&s.id).unwrap_or(0)) {
                s.social = Social::Either;
                s.tags.push("together".into());
            }
        }
        let present: HashSet<String> = items.iter().map(|s| s.id.clone()).collect();
        let detail = format!("You and {} all own it", self.names());
        for (appid, name) in self.common.iter().filter(|(id, _)| !present.contains(&format!("steam:{id}"))).take(MAX_TOGETHER_PICKS) {
            items.push(steam::together_pick(*appid, name, detail.clone()));
        }
    }

    /// After scoring: games you can't all play drop, games you all own rise, and the friends'
    /// taste weighs in next to yours.
    pub fn adjust(&self, ranked: &mut Vec<Ranked>) {
        if self.friends.is_empty() {
            return;
        }
        let owners = self.owners_reason();
        for r in ranked.iter_mut() {
            if let Some(appid) = steam_appid(&r.s.id) {
                if self.common_ids.contains(&appid) {
                    r.score *= 1.35;
                    r.reasons.insert(0, owners.clone());
                } else if self.library_known {
                    // Store games and games only you own: they'd have to buy it first.
                    r.score *= 0.55;
                }
            }
            let friends_taste = self.friends.iter().map(|f| f.affinity(r.s.category)).sum::<f64>() / self.friends.len() as f64;
            r.score *= (1.0 + 0.3 * friends_taste).max(0.3);
            if friends_taste > 0.25 && r.reasons.len() < 2 {
                r.reasons.push(format!("{} like{} this kind of thing", self.names(), if self.friends.len() == 1 { "s" } else { "" }));
            }
            r.reasons.truncate(2);
        }
        ranked.sort_by(|a, b| b.score.total_cmp(&a.score));
    }
}

fn steam_appid(id: &str) -> Option<u32> {
    id.strip_prefix("steam:")?.parse().ok()
}

// ---------------------------------------------------------------- encoding helpers

fn put_varint(out: &mut Vec<u8>, mut v: u32) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8> {
        let b = *self.buf.get(self.pos).context("the code is cut short: copy it again in full")?;
        self.pos += 1;
        Ok(b)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        ensure!(self.pos + n <= self.buf.len(), "the code is cut short: copy it again in full");
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn varint(&mut self) -> Result<u32> {
        let mut v: u64 = 0;
        for shift in (0..35).step_by(7) {
            let b = self.byte()?;
            v |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                ensure!(v <= u32::MAX as u64, "the game list in the code is malformed");
                return Ok(v as u32);
            }
        }
        bail!("the game list in the code is malformed")
    }
}

fn fletcher16(data: &[u8]) -> u16 {
    let (mut a, mut b) = (0u16, 0u16);
    for &x in data {
        a = (a + x as u16) % 255;
        b = (b + a) % 255;
    }
    (b << 8) | a
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding (also used for the sign-in PKCE challenge).
pub(crate) fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 4 / 3 + 3);
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

fn b64_decode(text: &str) -> Result<Vec<u8>> {
    let vals: Vec<u8> = text
        .bytes()
        .map(|c| B64.iter().position(|x| *x == c).map(|p| p as u8))
        .collect::<Option<_>>()
        .context("invalid character")?;
    ensure!(vals.len() % 4 != 1, "invalid length");
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for chunk in vals.chunks(4) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, v)| n | (*v as u32) << (18 - 6 * i));
        for i in 0..chunk.len() - 1 {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cost, Energy, Request};
    use crate::providers::steam_import::LibraryGame;

    fn friend(name: &str, games: &[u32]) -> Friend {
        Friend { name: name.into(), games: games.to_vec(), taste: [0; 8], added: 0, avatar: Avatar::default() }
    }

    fn library(games: &[(u32, &str)]) -> Library {
        Library {
            steam_id64: "76561198000000000".into(),
            games: games
                .iter()
                .map(|(id, name)| LibraryGame { appid: *id, name: name.to_string(), installed: true, playtime: 120, playtime_2weeks: 0, last_played: 0 })
                .collect(),
            imported_at: 0,
            from_web_api: false,
            playtime_known: false,
        }
    }

    #[test]
    fn codes_round_trip() {
        let mut f = friend("Julian", &[570, 1145360, 730, 440]);
        f.taste = [80, -20, 55, 0, 0, -100, 100, 3];
        let code = f.encode();
        assert!(code.starts_with(PREFIX));
        let back = Friend::decode(&code).unwrap();
        assert_eq!(back.name, "Julian");
        assert_eq!(back.games, vec![440, 570, 730, 1145360]);
        assert_eq!(back.taste, f.taste);
    }

    #[test]
    fn avatars_travel_and_unknown_ones_fall_back() {
        let mut f = friend("Julian", &[570]);
        f.avatar = Avatar { icon: 7, color: 3 };
        assert_eq!(Friend::decode(&f.encode()).unwrap().avatar, Avatar { icon: 7, color: 3 });
        f.avatar = Avatar { icon: 200, color: 99 };
        assert_eq!(Friend::decode(&f.encode()).unwrap().avatar, Avatar::default());
    }

    #[test]
    fn version_1_codes_still_work() {
        // Version 1: no avatar bytes.
        let mut out = vec![1u8, 3];
        out.extend_from_slice(b"Sam");
        out.extend([10u8; 8]);
        put_varint(&mut out, 2);
        put_varint(&mut out, 440);
        put_varint(&mut out, 130);
        let sum = fletcher16(&out);
        out.extend_from_slice(&sum.to_be_bytes());
        let f = Friend::decode(&format!("{PREFIX}{}", b64_encode(&out))).unwrap();
        assert_eq!((f.name.as_str(), f.games.as_slice(), f.avatar), ("Sam", &[440u32, 570][..], Avatar::default()));
    }

    #[test]
    fn codes_survive_chat_line_wrapping() {
        let code = friend("Sam", &[10, 20, 30]).encode();
        let wrapped = format!("  {}\n{} \r\n", &code[..7], &code[7..]);
        assert_eq!(Friend::decode(&wrapped).unwrap().games, vec![10, 20, 30]);
    }

    #[test]
    fn a_big_library_stays_pasteable() {
        let games: Vec<u32> = (0..400).map(|i| 200_000 + i * 2_311).collect();
        let code = friend("Big", &games).encode();
        assert!(code.len() < 1_400, "{} chars", code.len());
        assert_eq!(Friend::decode(&code).unwrap().games.len(), 400);
    }

    #[test]
    fn bad_codes_are_refused() {
        let code = friend("Julian", &[570, 730]).encode();
        assert!(Friend::decode("hello").is_err());
        assert!(Friend::decode("FT1.").is_err());
        assert!(Friend::decode(&code[..code.len() - 3]).is_err(), "cut short");
        assert!(Friend::decode(&format!("{code}AA")).is_err(), "trailing data");
        let mut flipped = code.clone().into_bytes();
        let i = PREFIX.len() + 6;
        flipped[i] = if flipped[i] == b'A' { b'B' } else { b'A' };
        assert!(Friend::decode(std::str::from_utf8(&flipped).unwrap()).is_err(), "checksum");
        assert!(Friend::decode("FT1.<script>").is_err());
        assert!(Friend::decode(&"A".repeat(MAX_CODE_LEN + 1)).is_err());
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("  Ju\u{0007}lian \n  the   great  "), "Julian the great");
        assert_eq!(clean_name(""), "Friend");
        assert_eq!(clean_name(&"x".repeat(80)).chars().count(), MAX_NAME_CHARS);
        let f = Friend::decode(&friend("\u{202e}evil\nname", &[]).encode()).unwrap();
        assert!(!f.name.chars().any(char::is_control));
    }

    #[test]
    fn my_code_carries_only_game_ids_and_taste() {
        let lib = library(&[(570, "Dota 2"), (730, "Counter-Strike 2")]);
        let me = Friend::mine("Me", Avatar::default(), Some(&lib), &[(Category::Sport, 0.5), (Category::Food, -2.0)]);
        assert_eq!(me.games, vec![570, 730]);
        assert_eq!(me.taste[index(Category::Sport)], 50);
        assert_eq!(me.taste[index(Category::Food)], -100);
        let code = me.encode();
        assert!(!code.contains("7656119"), "no SteamID in the code");
    }

    #[test]
    fn upsert_replaces_by_name_and_caps_the_list() {
        let mut list = vec![friend("Julian", &[1])];
        upsert(&mut list, friend("julian", &[2])).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].games, vec![2]);
        for i in 0..MAX_FRIENDS - 1 {
            upsert(&mut list, friend(&format!("f{i}"), &[])).unwrap();
        }
        assert!(upsert(&mut list, friend("one too many", &[])).is_err());
    }

    #[test]
    fn games_everyone_owns_rise_and_join_the_candidates() {
        let lib = library(&[(570, "Dota 2"), (730, "Counter-Strike 2"), (99, "Solo Game")]);
        let party = Party::new(vec![friend("Julian", &[570, 730]), friend("Sam", &[730, 570, 5])], Some(&lib));
        assert_eq!(party.common_games(), 2);

        let mut items = vec![steam::together_pick(99, "Solo Game", String::new())];
        items[0].social = Social::Solo;
        party.prepare(&mut items);
        assert!(items.iter().any(|s| s.id == "steam:570") && items.iter().any(|s| s.id == "steam:730"));

        let req = Request {
            minutes: 90,
            energy: Energy::Medium,
            with_friends: true,
            can_go_out: false,
            budget: Cost::Free,
            categories: Category::ALL.to_vec(),
        };
        let mut ranked = crate::scoring::rank(&items, &req, None, &Default::default(), &HashSet::new(), &mut rand::thread_rng());
        party.adjust(&mut ranked);
        assert_ne!(ranked[0].s.id, "steam:99", "a game only you own shouldn't lead");
        let top = ranked.iter().find(|r| r.s.id == "steam:730").unwrap();
        assert_eq!(top.reasons[0], "Julian and Sam own it too");
    }

    #[test]
    fn friends_taste_counts() {
        let mut likes_sport = friend("Julian", &[]);
        likes_sport.taste[index(Category::Sport)] = 100;
        let party = Party::new(vec![likes_sport], None);
        let mut ranked = vec![
            Ranked { s: crate::catalog::load().into_iter().find(|s| s.category == Category::Sport).unwrap(), score: 1.0, reasons: vec![] },
            Ranked { s: crate::catalog::load().into_iter().find(|s| s.category == Category::Food).unwrap(), score: 1.1, reasons: vec![] },
        ];
        party.adjust(&mut ranked);
        assert_eq!(ranked[0].s.category, Category::Sport);
        assert!(ranked[0].reasons.iter().any(|r| r == "Julian likes this kind of thing"));
    }
}
