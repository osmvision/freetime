use crate::engine::arg;
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Local};
use freetime_core::{
    account::{Client, NewInvite, ProfileEdit},
    history::History,
    quiz::QuizLog,
    ranked, streaks,
};
use serde_json::{json, Value};

pub fn invoke(
    cmd: &str,
    args: &Value,
    token: Option<&str>,
    history: &History,
    quizzes: &QuizLog,
    now: DateTime<Local>,
) -> Result<Value> {
    if cmd == "sync_points" && token.is_none() {
        return Ok(Value::Null);
    }
    let token = token.context("Sign in to use this feature")?;
    let client = Client::new()?;
    let session = client.browser_session(token, now.timestamp())?;
    let text = |name| arg::<String>(args, name);
    let value = match cmd {
        "ranked_overview" => {
            let scope = text("scope")?;
            if !matches!(scope.as_str(), "friends" | "global") {
                bail!("unknown leaderboard");
            }
            let today = ranked::sync_points(&client, &session, history, quizzes, now)?;
            json!(ranked::overview(&client, &session, scope, today, now.date_naive())?)
        }
        "sync_points" => {
            ranked::sync_points(&client, &session, history, quizzes, now)?;
            Value::Null
        }
        "player_card" => json!(ranked::card(&client, &session, &text("userId")?)?),
        "together_streaks" => json!(streaks::by_friend(client.together_weeks(&session)?, now.date_naive())),
        "set_global_ranking" => {
            client.set_show_in_global(&session, arg(args, "enabled")?)?;
            Value::Null
        }
        "get_account" => {
            json!({"id":session.user_id,"email":session.email,"profile":client.profile(&session)?})
        }
        "save_profile" => {
            json!(client.update_profile(&session, &arg::<ProfileEdit>(args, "edit")?)?)
        }
        "reset_friend_tag" => json!(client.reset_friend_tag(&session)?),
        "export_my_data" => client.export_my_data(&session)?,
        "delete_my_account" => {
            client.delete_my_account(&session)?;
            Value::Null
        }
        "report_user" => {
            client.report(
                &session,
                &text("userId")?,
                &text("reason")?,
                &text("details")?,
                &arg::<Vec<i64>>(args, "messageIds")?,
            )?;
            Value::Null
        }
        "social_overview" => {
            json!({"me":session.user_id,"friends":client.friends(&session)?,"conversations":client.conversations(&session)?})
        }
        "friend_request" => json!(client.send_friend_request(&session, &text("tag")?)?),
        "accept_friend" => {
            client.accept_friend(&session, &text("userId")?)?;
            Value::Null
        }
        "unfriend" => {
            client.remove_friend(&session, &text("userId")?)?;
            Value::Null
        }
        "block_user" => {
            client.block(&session, &text("userId")?)?;
            Value::Null
        }
        "open_chat" => json!(client.open_direct(&session, &text("friend")?)?),
        "chat_messages" => {
            json!(client.messages(&session, &text("conversation")?, arg(args, "after")?)?)
        }
        "send_message" => {
            json!(client.send_message(&session, &text("conversation")?, &text("body")?)?)
        }
        "mark_read" => {
            client.mark_read(&session, &text("conversation")?, arg(args, "upTo")?)?;
            Value::Null
        }
        "set_free" => json!(client.set_free(&session, arg(args, "minutes")?)?),
        "get_invites" => json!(client.invites(&session)?),
        "send_invites" => {
            let invites: Vec<NewInvite> = arg(args, "invites")?;
            if invites.len() > 20 {
                bail!("Invite at most 20 friends at once");
            }
            for invite in &invites {
                client.send_invite(&session, invite)?;
            }
            json!(invites.len())
        }
        "answer_invite" => {
            client.answer_invite(&session, arg(args, "id")?, arg(args, "accept")?)?;
            Value::Null
        }
        "cancel_invite" => {
            client.cancel_invite(&session, arg(args, "id")?)?;
            Value::Null
        }
        _ => bail!("Unknown web command"),
    };
    Ok(value)
}
