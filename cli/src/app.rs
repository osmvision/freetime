use crate::{
    cli::SuggestArgs,
    config::{self, Config},
    history::{self, History},
    model::*,
    providers::{self, Online},
    scoring, ui,
};
use anyhow::Result;
use console::style;
use dialoguer::{theme::ColorfulTheme, Confirm, Input, MultiSelect, Select};
use freetime_core::open;
use std::{
    collections::HashSet,
    thread::{self, JoinHandle},
};

pub fn suggest(args: SuggestArgs) -> Result<()> {
    let cfg = Config::load()?;
    let interactive = !args.quick && console::user_attended();
    // Network calls run while the user answers the questions.
    let pending = start_fetch(&cfg, args.offline);
    let mut history = History::load();
    if interactive {
        ask_ratings(&mut history, history::RATE_AFTER_SECS, 3)?;
    }
    let req = build_request(&args, interactive)?;
    let online = finish_fetch(pending);
    let prefs = history.prefs(history::now());

    let mut excluded: HashSet<String> = HashSet::new();
    let mut first_round = true;
    loop {
        let ranked = freetime_core::rank(&cfg, &req, &online, &prefs, &excluded);
        if ranked.is_empty() {
            println!(
                "\n  {}",
                if excluded.is_empty() {
                    "Nothing fits. Try more time, a bigger budget, or allow outdoor ideas."
                } else {
                    "That's every idea that fits. Run freetime again for a fresh mix."
                }
            );
            break;
        }
        let shown = ui::print_results(&req, online.weather.as_ref(), &ranked, args.per_category);
        if first_round {
            ui::print_notes(&online.notes);
            first_round = false;
        }
        if !interactive {
            break;
        }
        match ui::choose(&shown)? {
            ui::Choice::Pick(i) => {
                commit(&mut history, &shown[i].s)?;
                break;
            }
            ui::Choice::Shuffle => excluded.extend(shown.iter().map(|r| r.s.id.clone())),
            ui::Choice::Done => break,
        }
    }
    Ok(())
}

pub fn surprise(offline: bool) -> Result<()> {
    let cfg = Config::load()?;
    let pending = start_fetch(&cfg, offline);
    let mut history = History::load();
    let req = Request::for_now();
    let online = finish_fetch(pending);
    let prefs = history.prefs(history::now());
    let ranked = freetime_core::rank(&cfg, &req, &online, &prefs, &HashSet::new());
    let Some(i) = scoring::weighted_pick(&ranked, 6) else {
        println!("No idea fits right now. Try `freetime` to adjust the details.");
        return Ok(());
    };
    let pick = &ranked[i];
    ui::print_context(&req, online.weather.as_ref());
    ui::print_headline(style("🎲 TRY THIS").magenta().bold(), pick);
    let others: Vec<_> = ranked.iter().enumerate().filter(|(j, _)| *j != i).take(2).collect();
    if !others.is_empty() {
        println!("\n  {}", style("Or maybe:").dim());
        for (_, r) in others {
            println!("    {} {}  {}", r.s.category.icon(), r.s.title, style(r.s.duration_label()).dim());
        }
    }
    if console::user_attended() {
        println!();
        if Confirm::with_theme(&ColorfulTheme::default()).with_prompt("Do it?").default(true).interact()? {
            commit(&mut history, &pick.s)?;
        }
    }
    Ok(())
}

pub fn rate() -> Result<()> {
    let mut history = History::load();
    if !ask_ratings(&mut history, 0, 20)? {
        println!("Nothing to rate. Pick something with `freetime` first!");
    }
    Ok(())
}

pub fn show_history(limit: usize) -> Result<()> {
    let h = History::load();
    if h.entries.is_empty() {
        println!("No picks yet. Run `freetime` and choose something!");
        return Ok(());
    }
    println!();
    for e in h.entries.iter().rev().take(limit) {
        let when = chrono::DateTime::from_timestamp(e.ts, 0)
            .map(|d| d.with_timezone(&chrono::Local).format("%a %d %b %H:%M").to_string())
            .unwrap_or_default();
        let rating = match e.rating {
            Some(1) => "👍",
            Some(-1) => "👎",
            Some(_) => "· ",
            None => "? ",
        };
        println!("  {rating} {}  {} {}", style(when).dim(), e.category.icon(), e.title);
    }
    let taste = h.taste();
    if !taste.is_empty() {
        let parts: Vec<String> = taste.iter().map(|(c, a)| format!("{} {} {:+.2}", c.icon(), c.label(), a)).collect();
        println!("\n  {} {}", style("Your taste so far:").bold(), parts.join("  "));
    }
    Ok(())
}

pub fn paths() {
    println!("config:  {}", config::config_path().display());
    println!("data:    {}", config::data_dir().display());
}

fn start_fetch(cfg: &Config, offline: bool) -> Option<JoinHandle<Online>> {
    if offline {
        return None;
    }
    let cfg = cfg.clone();
    Some(thread::spawn(move || providers::fetch_online(&cfg)))
}

fn finish_fetch(pending: Option<JoinHandle<Online>>) -> Online {
    match pending {
        None => Online::default(),
        Some(h) => {
            if !h.is_finished() {
                eprintln!("  {}", style("Checking Steam, YouTube and the weather…").dim());
            }
            h.join().unwrap_or_default()
        }
    }
}

fn commit(history: &mut History, s: &Suggestion) -> Result<()> {
    history.record_pick(s);
    history.save()?;
    println!("\n  {} {}", style("Enjoy:").green().bold(), style(&s.title).bold());
    if let Some(link) = &s.link {
        if Confirm::with_theme(&ColorfulTheme::default())
            .with_prompt(format!("Open {link}?"))
            .default(true)
            .interact()?
        {
            open::open_link(link)?;
        }
    }
    println!("  {}", style("Next time, freetime will ask how it went so it learns your taste.").dim());
    Ok(())
}

/// Returns true if anything was asked.
fn ask_ratings(history: &mut History, min_age_secs: i64, limit: usize) -> Result<bool> {
    let now = history::now();
    let pending = history.unrated(now, min_age_secs, limit);
    if pending.is_empty() {
        return Ok(false);
    }
    let theme = ColorfulTheme::default();
    for i in pending {
        let e = &history.entries[i];
        let prompt = format!("How was {} “{}” ({})?", e.category.icon(), e.title, history::ago(now - e.ts));
        let choice = Select::with_theme(&theme)
            .with_prompt(prompt)
            .items(&["👍 Loved it", "👎 Not for me", "🤷 Didn't do it / skip"])
            .default(0)
            .interact()?;
        history.entries[i].rating = Some(match choice {
            0 => 1,
            1 => -1,
            _ => 0,
        });
    }
    history.save()?;
    Ok(true)
}

fn build_request(args: &SuggestArgs, interactive: bool) -> Result<Request> {
    let d = Request::for_now();
    let theme = ColorfulTheme::default();

    let minutes = match args.minutes {
        Some(m) => m.max(5),
        None if interactive => ask_minutes(&theme)?,
        None => d.minutes,
    };

    let energy = match args.energy {
        Some(e) => e,
        None if interactive => {
            let i = Select::with_theme(&theme)
                .with_prompt("Energy level?")
                .items(&["😴 Low: something chill", "🙂 Medium", "⚡ High: let's move"])
                .default(d.energy as usize)
                .interact()?;
            [Energy::Low, Energy::Medium, Energy::High][i]
        }
        None => d.energy,
    };

    let with_friends = if args.friends {
        true
    } else if args.solo || !interactive {
        false
    } else {
        Select::with_theme(&theme)
            .with_prompt("Who's in?")
            .items(&["🧍 Just me", "👥 Me and friends"])
            .default(0)
            .interact()?
            == 1
    };

    let can_go_out = if args.indoor {
        false
    } else if args.outdoor {
        true
    } else if interactive {
        Confirm::with_theme(&theme)
            .with_prompt("Up for going outside?")
            .default(d.can_go_out)
            .interact()?
    } else {
        d.can_go_out
    };

    let budget = match args.budget {
        Some(b) => b,
        None if interactive => {
            let i = Select::with_theme(&theme)
                .with_prompt("Budget?")
                .items(&["💸 Free only", "🪙 Cheap is fine (~15)", "💳 Money's no object"])
                .default(1)
                .interact()?;
            [Cost::Free, Cost::Cheap, Cost::Paid][i]
        }
        None => d.budget,
    };

    let categories = if !args.only.is_empty() {
        args.only.clone()
    } else if interactive {
        let labels: Vec<String> = Category::ALL.iter().map(|c| format!("{} {}", c.icon(), c.label())).collect();
        let picked = MultiSelect::with_theme(&theme)
            .with_prompt("In the mood for? (space toggles, enter confirms)")
            .items(&labels)
            .defaults(&[true; Category::ALL.len()])
            .interact()?;
        if picked.is_empty() {
            Category::ALL.to_vec()
        } else {
            picked.into_iter().map(|i| Category::ALL[i]).collect()
        }
    } else {
        Category::ALL.to_vec()
    };

    Ok(Request { minutes, energy, with_friends, can_go_out, budget, categories })
}

fn ask_minutes(theme: &ColorfulTheme) -> Result<u32> {
    let presets = [(15, "15 min"), (30, "30 min"), (60, "1 hour"), (120, "2 hours"), (240, "An afternoon (4h)")];
    let mut labels: Vec<&str> = presets.iter().map(|p| p.1).collect();
    labels.push("Custom…");
    let i = Select::with_theme(theme)
        .with_prompt("How much free time do you have?")
        .items(&labels)
        .default(2)
        .interact()?;
    if i < presets.len() {
        return Ok(presets[i].0);
    }
    let m: u32 = Input::with_theme(theme).with_prompt("Minutes").default(45).interact_text()?;
    Ok(m.max(5))
}
