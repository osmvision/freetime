use crate::model::{Category, Cost, Energy};
use clap::{Args, Parser, Subcommand};

/// Got free time? Get the best thing to do with it:
/// Steam games, YouTube videos, sports and more.
#[derive(Parser)]
#[command(name = "freetime", version, args_conflicts_with_subcommands = true)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    #[command(flatten)]
    pub suggest: SuggestArgs,
}

#[derive(Subcommand)]
pub enum Command {
    /// Answer a few questions (or pass flags) and get ranked ideas [default]
    Suggest(SuggestArgs),
    /// No questions asked: one great pick for right now
    Surprise {
        /// Skip network calls (weather, Steam, YouTube)
        #[arg(long)]
        offline: bool,
    },
    /// Set your city, interests, and Steam / YouTube connections
    Setup,
    /// Show what you picked and how you rated it
    History {
        #[arg(short, long, default_value_t = 15)]
        limit: usize,
    },
    /// Rate your recent picks so freetime learns your taste
    Rate,
    /// Show where the config and data files live
    Paths,
}

#[derive(Args, Clone)]
pub struct SuggestArgs {
    /// Minutes of free time you have
    #[arg(short, long)]
    pub minutes: Option<u32>,

    /// Your energy level
    #[arg(short, long, value_enum)]
    pub energy: Option<Energy>,

    /// You're with friends
    #[arg(short, long, conflicts_with = "solo")]
    pub friends: bool,

    /// You're on your own
    #[arg(short, long)]
    pub solo: bool,

    /// Don't suggest anything outside
    #[arg(long, conflicts_with = "outdoor")]
    pub indoor: bool,

    /// Happy to go outside
    #[arg(long)]
    pub outdoor: bool,

    /// Max budget (free, cheap, any)
    #[arg(short, long, value_enum)]
    pub budget: Option<Cost>,

    /// Only these categories, comma separated (e.g. game,video,sport)
    #[arg(short, long, value_enum, value_delimiter = ',')]
    pub only: Vec<Category>,

    /// How many ideas to show per category
    #[arg(short = 'n', long, default_value_t = 3)]
    pub per_category: usize,

    /// Don't ask questions: use defaults for anything not passed as a flag
    #[arg(short, long)]
    pub quick: bool,

    /// Skip network calls (weather, Steam, YouTube)
    #[arg(long)]
    pub offline: bool,
}
