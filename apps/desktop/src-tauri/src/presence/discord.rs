//! [`Ipc`] over Discord's local socket (`discord-ipc-N` in the temporary
//! directory on macOS and Linux, a named pipe on Windows), through the
//! `discord-rich-presence` crate.

use discord_rich_presence::activity::{
    Activity as DiscordActivity, ActivityType, Assets, StatusDisplayType,
    Timestamps as DiscordTimestamps,
};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde_json::Value;

use super::{Activity, Ipc, IpcError};

/// Opcode of a command's reply.
const OP_FRAME: u32 = 1;

pub struct DiscordClient {
    application_id: &'static str,
    client: Option<DiscordIpcClient>,
}

impl DiscordClient {
    pub fn new(application_id: &'static str) -> Self {
        Self {
            application_id,
            client: None,
        }
    }

    fn client(&mut self) -> Result<&mut DiscordIpcClient, IpcError> {
        self.client
            .as_mut()
            .ok_or_else(|| IpcError::Disconnected("not connected".into()))
    }

    /// Reads the reply to the command just sent. Discord answers every
    /// command; an `ERROR` event means it refused this one.
    fn reply(&mut self) -> Result<(), IpcError> {
        let (op, reply) = self.client()?.recv().map_err(disconnected)?;
        if op != OP_FRAME {
            // Discord closes the connection with a reason (e.g. an unknown
            // application ID).
            return Err(IpcError::Disconnected(message(&reply)));
        }
        if reply.get("evt").and_then(Value::as_str) == Some("ERROR") {
            return Err(IpcError::Rejected(message(&reply)));
        }
        Ok(())
    }
}

fn disconnected(error: discord_rich_presence::error::Error) -> IpcError {
    IpcError::Disconnected(error.to_string())
}

/// Discord's explanation in a reply or close frame.
fn message(reply: &Value) -> String {
    reply
        .pointer("/data/message")
        .or_else(|| reply.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("no reason given")
        .chars()
        .take(200)
        .collect()
}

/// The `SET_ACTIVITY` payload: a "Watching" activity with no buttons, party
/// or secrets.
fn payload(activity: &Activity) -> DiscordActivity<'_> {
    let mut payload = DiscordActivity::new()
        .activity_type(ActivityType::Watching)
        .status_display_type(if activity.details_in_status {
            StatusDisplayType::Details
        } else {
            StatusDisplayType::Name
        })
        .details(activity.details.as_str())
        .assets(
            Assets::new()
                .large_image(activity.large_image.as_str())
                .large_text(activity.large_text.as_str()),
        );
    if let Some(state) = &activity.state {
        payload = payload.state(state.as_str());
    }
    if let Some(timestamps) = activity.timestamps {
        let mut discord = DiscordTimestamps::new().start(timestamps.start);
        if let Some(end) = timestamps.end {
            discord = discord.end(end);
        }
        payload = payload.timestamps(discord);
    }
    payload
}

impl Ipc for DiscordClient {
    fn connect(&mut self) -> Result<(), IpcError> {
        self.close();
        let mut client = DiscordIpcClient::new(self.application_id);
        // Finds the socket, then sends the handshake and reads Discord's
        // reply (blocking: this runs on the presence thread).
        client.connect().map_err(disconnected)?;
        self.client = Some(client);
        Ok(())
    }

    fn set_activity(&mut self, activity: &Activity) -> Result<(), IpcError> {
        self.client()?
            .set_activity(payload(activity))
            .map_err(disconnected)?;
        self.reply()
    }

    fn clear_activity(&mut self) -> Result<(), IpcError> {
        self.client()?.clear_activity().map_err(disconnected)?;
        self.reply()
    }

    fn close(&mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = client.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::{Activity, Timestamps};
    use super::*;

    #[test]
    fn the_payload_holds_only_what_is_shown() {
        let activity = Activity {
            details: "Breaking Bad".into(),
            state: Some("S2 E4".into()),
            large_image: "https://images.example/p.jpg".into(),
            large_text: "Breaking Bad".into(),
            timestamps: Some(Timestamps {
                start: 1_000,
                end: Some(5_000),
            }),
            details_in_status: true,
        };
        assert_eq!(
            serde_json::to_value(payload(&activity)).unwrap(),
            json!({
                "type": 3,
                "status_display_type": 2,
                "details": "Breaking Bad",
                "state": "S2 E4",
                "assets": {
                    "large_image": "https://images.example/p.jpg",
                    "large_text": "Breaking Bad",
                },
                "timestamps": { "start": 1_000, "end": 5_000 },
            })
        );

        let hidden = Activity {
            details: "Watching something on Kiro".into(),
            state: Some("Paused".into()),
            large_image: "kiro".into(),
            large_text: "Kiro".into(),
            timestamps: None,
            details_in_status: false,
        };
        assert_eq!(
            serde_json::to_value(payload(&hidden)).unwrap(),
            json!({
                "type": 3,
                "status_display_type": 0,
                "details": "Watching something on Kiro",
                "state": "Paused",
                "assets": { "large_image": "kiro", "large_text": "Kiro" },
            })
        );
    }

    #[test]
    fn discord_s_reasons_are_kept_short() {
        assert_eq!(
            message(&json!({ "evt": "ERROR", "data": { "code": 4000, "message": "Bad" } })),
            "Bad"
        );
        assert_eq!(
            message(&json!({ "code": 4000, "message": "Invalid Client ID" })),
            "Invalid Client ID"
        );
        assert_eq!(message(&json!({})), "no reason given");
        assert_eq!(message(&json!({ "message": "x".repeat(500) })).len(), 200);
    }
}
