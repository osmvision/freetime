use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "clap", derive(clap::ValueEnum))]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Game,
    Video,
    Sport,
    Learn,
    Create,
    Chill,
    Social,
    Food,
}

impl Category {
    pub const ALL: [Category; 8] = [
        Category::Game,
        Category::Video,
        Category::Sport,
        Category::Learn,
        Category::Create,
        Category::Chill,
        Category::Social,
        Category::Food,
    ];

    /// The id used in files and by the UI ("game", "chill"...).
    pub fn id(self) -> &'static str {
        match self {
            Category::Game => "game",
            Category::Video => "video",
            Category::Sport => "sport",
            Category::Learn => "learn",
            Category::Create => "create",
            Category::Chill => "chill",
            Category::Social => "social",
            Category::Food => "food",
        }
    }

    /// Parses an id, ignoring case; "relax" also means chill.
    pub fn from_id(id: &str) -> Option<Category> {
        let id = id.trim().to_ascii_lowercase();
        if id == "relax" {
            return Some(Category::Chill);
        }
        Category::ALL.into_iter().find(|c| c.id() == id)
    }

    pub fn label(self) -> &'static str {
        match self {
            Category::Game => "Games",
            Category::Video => "Videos",
            Category::Sport => "Sport",
            Category::Learn => "Learn something",
            Category::Create => "Create",
            Category::Chill => "Chill",
            Category::Social => "Social",
            Category::Food => "Food",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Category::Game => "🎮",
            Category::Video => "📺",
            Category::Sport => "🏃",
            Category::Learn => "🧠",
            Category::Create => "🎨",
            Category::Chill => "😌",
            Category::Social => "👥",
            Category::Food => "🍳",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "clap", derive(clap::ValueEnum))]
#[serde(rename_all = "lowercase")]
pub enum Energy {
    Low,
    Medium,
    High,
}

impl Energy {
    pub fn level(self) -> i32 {
        self as i32
    }

    pub fn label(self) -> &'static str {
        match self {
            Energy::Low => "low",
            Energy::Medium => "medium",
            Energy::High => "high",
        }
    }
}

/// Who the activity is made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Social {
    Solo,
    Group,
    Either,
}

/// What something costs, also used as the user's max budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "clap", derive(clap::ValueEnum))]
#[serde(rename_all = "lowercase")]
pub enum Cost {
    Free,
    Cheap,
    #[cfg_attr(feature = "clap", value(alias = "any"))]
    #[serde(alias = "any")]
    Paid,
}

impl Cost {
    pub fn budget_label(self) -> &'static str {
        match self {
            Cost::Free => "free only",
            Cost::Cheap => "cheap",
            Cost::Paid => "any",
        }
    }
}

/// What the user told us about their free time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub minutes: u32,
    pub energy: Energy,
    pub with_friends: bool,
    pub can_go_out: bool,
    pub budget: Cost,
    pub categories: Vec<Category>,
}

impl Request {
    /// Sensible defaults for the current time of day.
    pub fn for_now() -> Request {
        use chrono::Timelike;
        let hour = chrono::Local::now().hour();
        Request {
            minutes: 60,
            energy: if (6..=21).contains(&hour) { Energy::Medium } else { Energy::Low },
            with_friends: false,
            can_go_out: (7..=21).contains(&hour),
            budget: Cost::Cheap,
            categories: Category::ALL.to_vec(),
        }
    }

    pub fn wants(&self, c: Category) -> bool {
        self.categories.contains(&c)
    }

    pub fn summary(&self) -> String {
        format!(
            "{} · {} energy · {} · {} · budget: {}",
            fmt_minutes(self.minutes),
            self.energy.label(),
            if self.with_friends { "with friends" } else { "solo" },
            if self.can_go_out { "can go out" } else { "staying in" },
            self.budget.budget_label()
        )
    }
}

/// One thing the user could do, from any source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suggestion {
    /// Stable key used by the history, e.g. `steam:570`, `yt:dQw4w9WgXcQ`, `idea:run-5k`.
    pub id: String,
    pub category: Category,
    pub title: String,
    pub detail: String,
    pub link: Option<String>,
    /// Thumbnail URL (game cover, video thumbnail), when the source has one.
    #[serde(default)]
    pub image: Option<String>,
    pub min_minutes: u32,
    pub max_minutes: u32,
    pub energy: Energy,
    pub outdoor: bool,
    pub social: Social,
    pub cost: Cost,
    /// Source-specific quality signal in 0..=1 (reviews, views, curation).
    pub quality: f64,
    pub tags: Vec<String>,
}

impl Suggestion {
    pub fn duration_label(&self) -> String {
        if self.max_minutes >= 600 {
            "any length".into()
        } else if self.min_minutes == self.max_minutes {
            format!("~{}", fmt_minutes(self.min_minutes))
        } else {
            format!("{}–{}", fmt_minutes(self.min_minutes), fmt_minutes(self.max_minutes))
        }
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

pub fn fmt_minutes(m: u32) -> String {
    if m < 60 {
        format!("{m} min")
    } else if m % 60 == 0 {
        format!("{}h", m / 60)
    } else {
        format!("{}h{:02}", m / 60, m % 60)
    }
}
