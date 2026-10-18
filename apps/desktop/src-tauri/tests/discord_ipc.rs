//! Discord Rich Presence against a stand-in for Discord's IPC socket: the
//! real client (`discord-rich-presence`) over a Unix socket, checking every
//! frame Kiro sends. Its own test binary, because the client finds the
//! socket through `XDG_RUNTIME_DIR`, which this sets.
#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use kiro_lib::presence::discord::DiscordClient;
use kiro_lib::presence::{Activity, Ipc, IpcError, Timestamps};
use serde_json::{Value, json};

const APPLICATION_ID: &str = "1234567890123456789";

/// How the stand-in answers one connection.
#[derive(Clone, Copy)]
enum Behaviour {
    /// Like Discord: READY, then a reply to each command (refusing an
    /// activity whose details are "refuse me").
    Normal,
    /// Hangs up straight after the handshake, like Discord quitting.
    HangUp,
}

fn read_frame(stream: &mut UnixStream) -> Option<(u32, Value)> {
    let mut header = [0u8; 8];
    stream.read_exact(&mut header).ok()?;
    let op = u32::from_le_bytes(header[..4].try_into().unwrap());
    let len = u32::from_le_bytes(header[4..].try_into().unwrap());
    let mut body = vec![0u8; len as usize];
    stream.read_exact(&mut body).ok()?;
    Some((op, serde_json::from_slice(&body).unwrap()))
}

fn write_frame(stream: &mut UnixStream, op: u32, body: &Value) {
    let body = body.to_string();
    let mut frame = op.to_le_bytes().to_vec();
    frame.extend((body.len() as u32).to_le_bytes());
    frame.extend(body.as_bytes());
    let _ = stream.write_all(&frame);
}

/// Serves connections one at a time, each with the next behaviour, sending
/// every frame received to `frames`.
fn serve(listener: UnixListener, behaviours: Receiver<Behaviour>, frames: Sender<(u32, Value)>) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { return };
        let Ok(behaviour) = behaviours.recv() else {
            return;
        };
        while let Some((op, body)) = read_frame(&mut stream) {
            frames.send((op, body.clone())).unwrap();
            match (op, behaviour) {
                (0, Behaviour::Normal) => write_frame(
                    &mut stream,
                    1,
                    &json!({ "cmd": "DISPATCH", "evt": "READY", "data": { "v": 1 } }),
                ),
                (0, Behaviour::HangUp) => {
                    write_frame(
                        &mut stream,
                        1,
                        &json!({ "cmd": "DISPATCH", "evt": "READY" }),
                    );
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    break;
                }
                (1, _) => {
                    let refused =
                        body.pointer("/args/activity/details") == Some(&json!("refuse me"));
                    let reply = if refused {
                        json!({
                            "cmd": "SET_ACTIVITY", "evt": "ERROR", "nonce": body["nonce"],
                            "data": { "code": 4000, "message": "child \"activity\" fails" },
                        })
                    } else {
                        json!({
                            "cmd": "SET_ACTIVITY", "evt": null, "nonce": body["nonce"],
                            "data": body["args"]["activity"],
                        })
                    };
                    write_frame(&mut stream, 1, &reply);
                }
                (2, _) => break,
                _ => {}
            }
        }
    }
}

fn next(frames: &Receiver<(u32, Value)>) -> (u32, Value) {
    frames
        .recv_timeout(Duration::from_secs(5))
        .expect("a frame from Kiro")
}

#[test]
fn talks_to_discord_s_ipc_socket() {
    let dir = std::env::temp_dir().join(format!("kiro-discord-ipc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // SAFETY: this binary's only test sets it before starting any thread.
    unsafe { std::env::set_var("XDG_RUNTIME_DIR", &dir) };
    let socket: PathBuf = dir.join("discord-ipc-0");

    let mut client = DiscordClient::new(APPLICATION_ID);
    let activity = Activity {
        details: "Breaking Bad".into(),
        state: Some("S2 E4".into()),
        large_image: "https://images.example/bb.jpg".into(),
        large_text: "Breaking Bad".into(),
        timestamps: Some(Timestamps {
            start: 1_760_000_000_000,
            end: Some(1_760_002_820_000),
        }),
        details_in_status: true,
    };

    // Discord isn't running.
    assert!(matches!(client.connect(), Err(IpcError::Disconnected(_))));
    assert!(matches!(
        client.set_activity(&activity),
        Err(IpcError::Disconnected(_))
    ));

    let listener = UnixListener::bind(&socket).unwrap();
    let (behaviour, behaviours) = mpsc::channel();
    let (frames_tx, frames) = mpsc::channel();
    std::thread::spawn(move || serve(listener, behaviours, frames_tx));

    // Handshake with the application ID.
    behaviour.send(Behaviour::Normal).unwrap();
    client.connect().unwrap();
    assert_eq!(
        next(&frames),
        (0, json!({ "v": 1, "client_id": APPLICATION_ID }))
    );

    // The activity, and nothing else.
    client.set_activity(&activity).unwrap();
    let (op, frame) = next(&frames);
    assert_eq!(op, 1);
    assert_eq!(frame["cmd"], "SET_ACTIVITY");
    assert_eq!(frame["args"]["pid"], std::process::id());
    assert_eq!(
        frame["args"]["activity"],
        json!({
            "type": 3,
            "status_display_type": 2,
            "details": "Breaking Bad",
            "state": "S2 E4",
            "assets": {
                "large_image": "https://images.example/bb.jpg",
                "large_text": "Breaking Bad",
            },
            "timestamps": { "start": 1_760_000_000_000_i64, "end": 1_760_002_820_000_i64 },
        })
    );

    // Discord refusing an activity isn't a lost connection.
    let refused = Activity {
        details: "refuse me".into(),
        ..activity.clone()
    };
    assert_eq!(
        client.set_activity(&refused),
        Err(IpcError::Rejected("child \"activity\" fails".into()))
    );
    next(&frames);

    // Clearing sends no activity at all.
    client.clear_activity().unwrap();
    let (op, frame) = next(&frames);
    assert_eq!(op, 1);
    assert_eq!(frame["args"]["activity"], Value::Null);

    // Closing says goodbye.
    client.close();
    assert_eq!(next(&frames).0, 2);
    assert!(matches!(
        client.clear_activity(),
        Err(IpcError::Disconnected(_))
    ));

    // Discord quits while connected: the next update fails as a lost
    // connection, so the worker connects again later.
    behaviour.send(Behaviour::HangUp).unwrap();
    client.connect().unwrap();
    next(&frames);
    let mut lost = false;
    for _ in 0..3 {
        if matches!(
            client.set_activity(&activity),
            Err(IpcError::Disconnected(_))
        ) {
            lost = true;
            break;
        }
    }
    assert!(lost, "a hung-up socket is reported as disconnected");

    let _ = std::fs::remove_dir_all(&dir);
}
