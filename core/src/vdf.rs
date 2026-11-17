//! A small parser for Valve's KeyValues text format (VDF/ACF), enough for
//! the files the Steam import reads: `libraryfolders.vdf`, `appmanifest_*.acf`, `localconfig.vdf`.

use anyhow::{bail, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Obj(Vec<(String, Vdf)>),
}

impl Vdf {
    /// A child by key, ignoring case: Steam writes both "MostRecent" and "mostrecent".
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        self.entries().iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
    }

    /// A child's text value by key, ignoring case.
    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key)?.as_str()
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            Vdf::Obj(_) => None,
        }
    }

    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Obj(entries) => entries,
            Vdf::Str(_) => &[],
        }
    }
}

/// Parses a whole file into an object holding its top-level entries.
pub fn parse(text: &str) -> Result<Vdf> {
    let tokens = tokenize(text)?;
    let mut pos = 0;
    Ok(Vdf::Obj(entries(&tokens, &mut pos, false)?))
}

#[derive(Debug, PartialEq)]
enum Tok {
    Str(String),
    Open,
    Close,
}

fn tokenize(text: &str) -> Result<Vec<Tok>> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() || c == '\u{feff}' {
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '{' {
            out.push(Tok::Open);
            i += 1;
        } else if c == '}' {
            out.push(Tok::Close);
            i += 1;
        } else if c == '"' {
            i += 1;
            let mut s = String::new();
            loop {
                match chars.get(i) {
                    None => bail!("unterminated string"),
                    Some('"') => {
                        i += 1;
                        break;
                    }
                    Some('\\') => {
                        match chars.get(i + 1) {
                            Some('\\') => s.push('\\'),
                            Some('"') => s.push('"'),
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            // An unknown escape keeps its backslash: unescaped Windows paths survive.
                            _ => {
                                s.push('\\');
                                i += 1;
                                continue;
                            }
                        }
                        i += 2;
                    }
                    Some(&ch) => {
                        s.push(ch);
                        i += 1;
                    }
                }
            }
            out.push(Tok::Str(s));
        } else {
            let start = i;
            while i < chars.len() && !chars[i].is_whitespace() && !matches!(chars[i], '"' | '{' | '}') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            // Platform conditions like [$WIN32] decorate a value; they don't change it.
            if !(word.starts_with('[') && word.ends_with(']')) {
                out.push(Tok::Str(word));
            }
        }
    }
    Ok(out)
}

fn entries(tokens: &[Tok], pos: &mut usize, nested: bool) -> Result<Vec<(String, Vdf)>> {
    let mut out = Vec::new();
    loop {
        match tokens.get(*pos) {
            None if nested => bail!("missing closing brace"),
            None => return Ok(out),
            Some(Tok::Close) if nested => {
                *pos += 1;
                return Ok(out);
            }
            Some(Tok::Close) => bail!("unexpected closing brace"),
            Some(Tok::Open) => bail!("unexpected opening brace"),
            Some(Tok::Str(key)) => {
                *pos += 1;
                let value = match tokens.get(*pos) {
                    Some(Tok::Str(v)) => {
                        *pos += 1;
                        Vdf::Str(v.clone())
                    }
                    Some(Tok::Open) => {
                        *pos += 1;
                        Vdf::Obj(entries(tokens, pos, true)?)
                    }
                    _ => bail!("key {key:?} has no value"),
                };
                out.push((key.clone(), value));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_objects_and_escapes() {
        let text = "// comment\n\"root\"\n{\n\t\"name\"\t\t\"Player \\\"One\\\"\"\n\t\"path\"\t\"C:\\\\Games\\\\Steam\"\n\t\"odd\"\t\"D:\\SteamLibrary\"\n\t\"child\" { \"Key\" \"1\" }\n}\n";
        let v = parse(text).unwrap();
        let root = v.get("root").unwrap();
        assert_eq!(root.str("name"), Some("Player \"One\""));
        assert_eq!(root.str("path"), Some("C:\\Games\\Steam"));
        assert_eq!(root.str("odd"), Some("D:\\SteamLibrary"));
        assert_eq!(root.get("CHILD").unwrap().str("key"), Some("1"));
    }

    #[test]
    fn unquoted_tokens_and_conditionals() {
        let v = parse("root { key value [$WIN32] other \"x\" }").unwrap();
        let root = v.get("root").unwrap();
        assert_eq!(root.str("key"), Some("value"));
        assert_eq!(root.str("other"), Some("x"));
    }

    #[test]
    fn rejects_broken_files() {
        assert!(parse("\"a\" { \"b\" \"c\"").is_err());
        assert!(parse("\"a\" }").is_err());
        assert!(parse("\"a\"").is_err());
        assert!(parse("\"a").is_err());
    }
}
