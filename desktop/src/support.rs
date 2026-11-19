//! "Report a problem" from the desktop app, and the admins' Tickets tab.

use crate::commands::{err, live_session, lock, AppState, Res};
use freetime_core::{
    account::{self, Client, Session},
    support::{NewTicket, Ticket},
};
use tauri::State;

/// The session when signed in, without failing when not (reports work signed out).
fn session_if_signed_in(state: &AppState) -> Option<Session> {
    let signed_in = lock(&state.account).is_some() || account::has_saved_session();
    if signed_in {
        live_session(state).ok()
    } else {
        None
    }
}

/// Sends a problem report; returns its number. The app's version and platform are added here.
#[tauri::command(async)]
pub fn send_support_ticket(state: State<'_, AppState>, ticket: NewTicket) -> Res<i64> {
    let ticket = NewTicket { platform: Some("desktop".into()), app_version: Some(env!("CARGO_PKG_VERSION").into()), ..ticket };
    let session = session_if_signed_in(&state);
    Client::new().map_err(err)?.send_ticket(session.as_ref(), &ticket).map_err(err)
}

/// Whether the signed-in account is an admin. False when signed out or offline.
#[tauri::command(async)]
pub fn support_is_admin(state: State<'_, AppState>) -> bool {
    let Some(session) = session_if_signed_in(&state) else { return false };
    Client::new().ok().and_then(|c| c.is_admin(&session).ok()).unwrap_or(false)
}

#[tauri::command(async)]
pub fn support_tickets(state: State<'_, AppState>, status: Option<String>) -> Res<Vec<Ticket>> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.tickets(&s, status.as_deref()).map_err(err)
}

#[tauri::command(async)]
pub fn update_support_ticket(state: State<'_, AppState>, id: i64, status: String, note: String) -> Res<()> {
    let s = live_session(&state)?;
    Client::new().map_err(err)?.update_ticket(&s, id, &status, &note).map_err(err)
}
