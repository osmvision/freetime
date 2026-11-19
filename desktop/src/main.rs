// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assistant;
mod book;
mod commands;
mod duels;
mod feed;
mod quiz;
mod ranked;
mod share;
mod support;
mod updates;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(commands::AppState::default())
        .setup(|app| {
            // Steam, YouTube and the weather load in the background while the window opens.
            commands::refresh_in_background(app.handle());
            // New-message notifications: only does anything while signed in and enabled.
            commands::watch_messages(app.handle().clone());
            // Instant messages and invites (Realtime): only while signed in.
            commands::watch_live(app.handle().clone());
            // A new version (signed): checked a while after start, installed only when asked.
            updates::watch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::online_status,
            commands::refresh,
            commands::suggest,
            commands::surprise,
            commands::pick,
            commands::open_link,
            commands::rate,
            commands::get_history,
            commands::get_settings,
            commands::save_settings,
            commands::search_cities,
            commands::steam_scan,
            commands::steam_import,
            commands::steam_forget,
            commands::set_city,
            commands::open_data_dir,
            commands::my_friend_code,
            commands::get_friends,
            commands::add_friend,
            commands::remove_friend,
            commands::finish_welcome,
            commands::account_status,
            commands::sign_in,
            commands::sign_out,
            commands::get_account,
            commands::save_profile,
            commands::reset_friend_tag,
            commands::live_status,
            commands::get_recap,
            book::get_book,
            book::get_today,
            quiz::get_quiz,
            quiz::finish_quiz,
            quiz::bonus_quiz,
            ranked::sync_points,
            ranked::ranked_overview,
            ranked::player_card,
            ranked::set_global_ranking,
            duels::meet_people,
            duels::request_friend,
            duels::my_duels,
            duels::create_duel,
            duels::duel_questions,
            duels::play_duel,
            duels::drop_duel,
            duels::game_action,
            duels::my_matches,
            duels::leave_match,
            feed::friend_feed,
            feed::share_post,
            feed::delete_post,
            feed::toggle_reaction,
            feed::get_social_prefs,
            feed::set_social_prefs,
            feed::together_streaks,
            share::period_recap,
            share::save_card,
            commands::get_share_library,
            commands::set_share_library,
            commands::set_free,
            commands::get_invites,
            commands::send_invites,
            commands::answer_invite,
            commands::cancel_invite,
            commands::set_notify_messages,
            commands::get_notify_messages,
            commands::export_my_data,
            commands::delete_my_account,
            commands::report_user,
            commands::social_overview,
            commands::friend_request,
            commands::accept_friend,
            commands::unfriend,
            commands::block_user,
            commands::open_chat,
            commands::chat_messages,
            commands::send_message,
            commands::mark_read,
            assistant::assistant_status,
            assistant::assistant_models,
            assistant::assistant_send,
            assistant::assistant_stop,
            support::send_support_ticket,
            support::support_is_admin,
            support::support_tickets,
            support::update_support_ticket,
            updates::update_status,
            updates::set_auto_update,
            updates::check_update,
            updates::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running freetime");
}
