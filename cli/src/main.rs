mod app;
mod cli;
mod setup;
mod ui;

// The core modules, imported at the crate root so `crate::model` & co. work in every module.
use freetime_core::{config, history, model, net, providers, scoring, weather};

use clap::Parser;
use cli::{Cli, Command};

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        None => app::suggest(cli.suggest),
        Some(Command::Suggest(args)) => app::suggest(args),
        Some(Command::Surprise { offline }) => app::surprise(offline),
        Some(Command::Setup) => setup::run(),
        Some(Command::History { limit }) => app::show_history(limit),
        Some(Command::Rate) => app::rate(),
        Some(Command::Paths) => {
            app::paths();
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("{} {e:#}", console::style("error:").red().bold());
        std::process::exit(1);
    }
}
