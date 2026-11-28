use freetime_core::{
    config::Config,
    history,
    model::{Category, Suggestion},
    net::Net,
    providers::youtube,
};
use std::collections::{HashMap, HashSet};

/// Uses bundled channel definitions and browser preferences, without consulting
/// the desktop's channel configuration or its disk caches.
pub fn videos(net: &dyn Net, cfg: &Config, key: &str) -> Vec<Suggestion> {
    let mut found = youtube::search(
        net,
        if key.is_empty() { None } else { Some(key) },
        &youtube::interests_for(cfg),
    )
    .map(|(items, _)| items)
    .unwrap_or_default();
    let mut channels = youtube::channels_for(
        cfg,
        youtube::parse_channels(include_str!("../../core/data/youtube_channels.toml"))
            .unwrap_or_default(),
    );
    channels.push((
        Category::Video,
        cfg.youtube
            .channels
            .iter()
            .filter(|s| youtube::is_channel_id(s))
            .cloned()
            .collect(),
    ));
    let ids: HashSet<_> = channels
        .iter()
        .flat_map(|(_, ids)| ids.iter().cloned())
        .collect();
    let feeds: HashMap<_, _> = std::thread::scope(|scope| {
        let jobs: Vec<_> = ids
            .iter()
            .take(50)
            .map(|id| {
                scope.spawn(move || {
                    net.get_text(
                        "https://www.youtube.com/feeds/videos.xml",
                        &[("channel_id", id)],
                    )
                    .and_then(|xml| youtube::parse_feed(&xml))
                    .ok()
                    .map(|videos| (id.clone(), videos))
                })
            })
            .collect();
        jobs.into_iter()
            .filter_map(|job| job.join().ok().flatten())
            .collect()
    });
    for video in youtube::video_picks(&channels, &feeds, history::now()) {
        if !found.iter().any(|s| s.id == video.id) {
            found.push(video);
        }
    }
    found
}
