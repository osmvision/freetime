use crate::{model::*, providers::Note, scoring::Ranked, weather::Weather};
use anyhow::Result;
use console::style;
use dialoguer::{theme::ColorfulTheme, Select};

pub fn print_context(req: &Request, weather: Option<&Weather>) {
    println!();
    println!("  {}", style(req.summary()).dim());
    if let Some(w) = weather {
        println!("  {}", style(w.summary()).dim());
    }
}

pub fn print_headline(label: console::StyledObject<&str>, r: &Ranked) {
    println!();
    println!(
        "  {}  {} {}  {}",
        label,
        r.s.category.icon(),
        style(&r.s.title).bold(),
        style(r.s.duration_label()).dim()
    );
    print_lines(r, "      ");
}

/// Prints the best pick, then the top ideas per category. Returns them in display order.
pub fn print_results<'a>(
    req: &Request,
    weather: Option<&Weather>,
    ranked: &'a [Ranked],
    per_category: usize,
) -> Vec<&'a Ranked> {
    print_context(req, weather);
    let mut shown: Vec<&Ranked> = Vec::new();
    let Some(best) = ranked.first() else { return shown };
    print_headline(style("★ BEST PICK").yellow().bold(), best);
    shown.push(best);

    for cat in Category::ALL.into_iter().filter(|c| req.wants(*c)) {
        let list: Vec<&Ranked> = ranked[1..].iter().filter(|r| r.s.category == cat).take(per_category).collect();
        if list.is_empty() {
            continue;
        }
        println!();
        println!("  {}", style(format!("{} {}", cat.icon(), cat.label())).cyan().bold());
        for r in list {
            shown.push(r);
            println!(
                "  {:>3}. {}  {}",
                shown.len(),
                style(&r.s.title).bold(),
                style(r.s.duration_label()).dim()
            );
            print_lines(r, "       ");
        }
    }
    shown
}

fn print_lines(r: &Ranked, indent: &str) {
    println!("{indent}{}", style(&r.s.detail).dim());
    if !r.reasons.is_empty() {
        println!("{indent}{}", style(format!("→ {}", r.reasons.join(" · "))).green());
    }
}

pub fn print_notes(notes: &[Note]) {
    if notes.is_empty() {
        return;
    }
    println!();
    for n in notes {
        let text = if n.tip { format!("Tip: {} Run `freetime setup`.", n.text) } else { n.text.clone() };
        println!("  {}", style(text).yellow().dim());
    }
}

pub enum Choice {
    Pick(usize),
    Shuffle,
    Done,
}

pub fn choose(shown: &[&Ranked]) -> Result<Choice> {
    let mut items: Vec<String> = shown
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{:>2}. {} {}", i + 1, r.s.category.icon(), r.s.title))
        .collect();
    items.push("🔀 Shuffle: show me other ideas".into());
    items.push("👋 Nothing for now".into());
    println!();
    let i = Select::with_theme(&ColorfulTheme::default())
        .with_prompt("What are you going to do?")
        .items(&items)
        .default(0)
        .interact()?;
    Ok(if i < shown.len() {
        Choice::Pick(i)
    } else if i == shown.len() {
        Choice::Shuffle
    } else {
        Choice::Done
    })
}
