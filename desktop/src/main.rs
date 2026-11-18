// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .manage(commands::AppState::default())
        .setup(|app| {
            // Steam, YouTube and the weather load in the background while the window opens.
            commands::refresh_in_background(app.handle());
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running freetime");
}
