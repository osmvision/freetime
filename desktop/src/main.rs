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
        ])
        .run(tauri::generate_context!())
        .expect("error while running freetime");
}
