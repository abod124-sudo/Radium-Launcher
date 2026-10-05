//! Friends' presence on Stella, for the Home friends card.
//!
//! Stella has no REST call for "is my friend online" (every presence path is a
//! 404). The game learns it from the notification hub, a SignalR websocket at
//! `/notify/hub/v1` on the name server's `Notifications` host (moved off
//! `api.stellaonline.org` 2026-10-05), and so does this. Measured against the
//! live server and the game's own traffic (2026-10-01):
//!
//! - The socket opens with just the session's bearer token and the `BestHTTP`
//!   User-Agent: no negotiate step, no request signature. Opening it does not
//!   mark the account online (the game does that separately, on its own login).
//! - Frames are SignalR JSON, each ended by `\x1e`. After the `{"protocol":"json",
//!   "version":1}` handshake the server answers `{}`, then pushes
//!   `{"type":1,"target":"Notification","arguments":["<json>"]}` where the inner
//!   JSON is `{"Id":"PresenceUpdate","Msg":{PlayerId, IsOnline, StatusVisibility,
//!   RoomInstance:{RoomId, Name, IsPrivate, …}|null}}`.
//! - It pushes the presence of every online player, about every 20–40 seconds
//!   each — not only subscribed ones. A player whose visibility isn't public
//!   always arrives as offline with no room: the server hides them itself. The
//!   latest state of each player is kept (for the friends card and for profile
//!   pages, which show what the game would), and forgotten once it is stale.
//! - A private instance still carries its room's name; the game shows it, and
//!   so does this, marked private.
//! - There is no snapshot on connect or on subscribing. But reading the friends
//!   list over REST while a connection is open makes Stella push every
//!   friend's presence to it at once, online or not, each followed by their
//!   account (measured 2026-10-02: every time, and not for other reads). So the
//!   list is read again as soon as the connection is up ([`FRIENDS_SYNC`]),
//!   and friends show as online or offline within a second. Without that push
//!   a friend is "online" once an update says so, and "offline" once one says
//!   so or after a minute or so of silence, since an online player's update
//!   would have come by then.
//!
//! The game also invokes `SubscribeToPlayers` with its friends' ids; this does
//! the same, in case the server ever stops broadcasting to everyone.
//!
//! Messages to the account arrive here too, as `{"Id":"2","Msg":{Id,
//! FromPlayerId, Type, Data, RoomId, SentTime}}`. Invites are passed on to the
//! page as `stella-invite` (type 6, Data `{"InviteId", "Name", "InviteMode"}`,
//! seen 2026-10-04), which shows them as a pop-up: a friend inviting the
//! player, or answering their join request. Once invited, the game can join
//! that friend even in a private room.
//!
//! **It never runs alongside the game.** The hub keeps one session's
//! connections per account: when a connection from another sign-in arrives,
//! the older ones are reset (measured: two connections on one token coexist;
//! a second sign-in's connection drops the first). The game is signed in on
//! its own session, so connecting while it runs would cut the game off from
//! its friend updates, invites and messages — and the two would keep knocking
//! each other off. So while any Rec Room client is running this stays
//! disconnected ("paused"; the game shows the same information), and it lets
//! go within a couple of seconds of the game starting, well before the game
//! reaches its own hub connection.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use crate::{applog, stella_api};

/// Tells the frontend to ask again with [`stella_friends`].
const CHANGED_EVENT: &str = "stella-friends-changed";
const INVITE_EVENT: &str = "stella-invite";
/// Any new message, for the notifications list (see `stella_api::stella_notifications`).
const MESSAGE_EVENT: &str = "stella-message";
/// SignalR's own record separator.
const RS: char = '\u{1e}';

/// An online player's presence is re-sent this often at most, so one not heard
/// from for longer has gone offline (or the update was lost).
const ONLINE_STALE: Duration = Duration::from_secs(150);
/// How long after connecting a friend with no update yet is still "checking"
/// rather than "offline".
const SETTLE: Duration = Duration::from_secs(75);
const PING_EVERY: Duration = Duration::from_secs(15);
/// The friends list is re-read this often while connected.
const FRIENDS_REFRESH: Duration = Duration::from_secs(5 * 60);
/// Past this many remembered players, those not heard from in a while are
/// dropped. Only online players are ever re-sent, so this tracks roughly the
/// number online — a few hundred — and is a backstop, not a working limit.
const PRESENCE_CAP: usize = 5000;
/// How long after connecting the player count is taken as complete. Measured
/// 2026-10-02 over five minutes: a player's updates come every 22 s typically
/// and 45 s at the 99th percentile, and 113 players had been heard by 60 s
/// against 100 at 30 s (the rest of the climb was people joining).
const COUNT_SETTLE: Duration = Duration::from_secs(60);
/// How often the game is looked for, connected or waiting.
const GAME_CHECK: Duration = Duration::from_secs(2);
/// How long after the friends list is re-read a friend's presence is taken as
/// Stella's push of the whole list rather than a sign of them playing (see
/// [`Presence::hidden`]). The push arrives within a fraction of a second.
const FRIENDS_SYNC: Duration = Duration::from_secs(3);

#[derive(Clone)]
struct Presence {
    online: bool,
    room_id: i64,
    room_name: String,
    private: bool,
    /// The player's visibility isn't public, so the server always reports
    /// them offline. They are still re-sent while they play, which is what
    /// lets the player count include them (as a number, never by name). Never
    /// set from the friends-list push, which sends every friend whether they
    /// play or not.
    hidden: bool,
    seen: Instant,
}

#[derive(Default)]
struct Hub {
    /// Bumped to stop the running task (and to tell a new one from an old one).
    generation: u64,
    running: bool,
    friend_ids: Vec<i64>,
    /// Person rows, by account id.
    accounts: HashMap<i64, Value>,
    presence: HashMap<i64, Presence>,
    connected_at: Option<Instant>,
    /// Disconnected because the game is running (see the module docs).
    paused: bool,
    /// Whether the friends list has been read at least once this run.
    loaded: bool,
    error: String,
    /// Connection attempts that have failed in a row, for the log.
    failures: u32,
    /// Friends whose next presence is expected to be Stella's push of the
    /// list, until when (see [`FRIENDS_SYNC`]).
    syncing: HashMap<i64, Instant>,
    /// Invites heard and not yet passed to the page.
    invites: Vec<Value>,
    /// A message has come since the page was last told.
    new_message: bool,
}

static HUB: Mutex<Option<Hub>> = Mutex::new(None);

fn with_hub<T>(f: impl FnOnce(&mut Hub) -> T) -> T {
    let mut guard = HUB.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Hub::default))
}

/// Stop the hub task (logged out, or left Stella). Its state is dropped too, so
/// another account signing in starts clean.
pub fn stop() {
    with_hub(|h| {
        h.generation += 1;
        h.running = false;
        h.friend_ids.clear();
        h.accounts.clear();
        h.presence.clear();
        h.connected_at = None;
        h.paused = false;
        h.loaded = false;
        h.error.clear();
        h.failures = 0;
        h.syncing.clear();
        h.invites.clear();
    });
}

/// Close the connection because Stella isn't in use (hidden in the tray, or
/// another network picked; see `stella_api::IN_USE`), keeping the friends list
/// so the card isn't empty when Stella comes back. What was heard is dropped:
/// it is stale by then, and the friends list push refills it on reconnecting.
pub fn suspend() {
    with_hub(|h| {
        h.generation += 1;
        h.running = false;
        h.presence.clear();
        h.connected_at = None;
        h.paused = false;
        h.error.clear();
        h.syncing.clear();
    });
}

fn game_running() -> bool {
    crate::game::rec_room_running()
}

fn current(gen: u64) -> bool {
    with_hub(|h| h.generation == gen) && !stella_api::signed_out() && stella_api::in_use()
}

/// Read the friends list (accepted friends only, not pending requests) and
/// their account rows. `RelationshipType` 3 is a mutual friend.
async fn load_friends(gen: u64) -> Result<(), String> {
    let rels = stella_api::api_get("/api/relationships/v2/get").await?;
    let ids: Vec<i64> = rels
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|r| r.get("RelationshipType").and_then(Value::as_i64) == Some(3))
                .filter_map(|r| r.get("PlayerID").and_then(Value::as_i64))
                .filter(|&id| id > 0)
                .collect()
        })
        .unwrap_or_default();
    let accounts = stella_api::resolve_accounts(&ids).await;
    with_hub(|h| {
        if h.generation != gen {
            return;
        }
        h.accounts = ids
            .iter()
            .filter_map(|id| accounts.get(id).map(|a| (*id, stella_api::person_row(a))))
            .collect();
        h.friend_ids = ids;
        h.loaded = true;
    });
    Ok(())
}

/// Mark every friend's next presence, for the next [`FRIENDS_SYNC`], as the
/// one Stella pushes when the friends list is read.
fn expect_friends_sync(gen: u64) {
    with_hub(|h| {
        if h.generation != gen {
            return;
        }
        let until = Instant::now() + FRIENDS_SYNC;
        let ids = h.friend_ids.clone();
        h.syncing.clear();
        h.syncing.extend(ids.into_iter().map(|id| (id, until)));
    });
}

/// The invite in a message notification (`inner`), if it is one, as the page
/// gets it: `{ fromPlayerId, inviteId, roomId, roomName }`. The room's name
/// comes as the game shows it ("^RecCenter", "@name's Dorm"), unmarked here
/// as in the friends list.
fn invite_of(inner: &Value) -> Option<Value> {
    let msg = &inner["Msg"];
    if msg.get("Type").and_then(Value::as_i64) != Some(stella_api::INVITE_MESSAGE) {
        return None;
    }
    let from = msg.get("FromPlayerId").and_then(Value::as_i64).filter(|&id| id > 0)?;
    let data = msg
        .get("Data")
        .and_then(Value::as_str)
        .and_then(|d| serde_json::from_str::<Value>(d).ok())
        .unwrap_or(Value::Null);
    Some(json!({
        "fromPlayerId": from,
        "inviteId": data.get("InviteId").and_then(Value::as_i64).unwrap_or(0),
        "roomId": msg.get("RoomId").and_then(Value::as_i64).unwrap_or(0),
        "roomName": data.get("Name").and_then(Value::as_str).unwrap_or("").trim_start_matches(['^', '@']),
    }))
}

/// Note a message notification (`inner`) for the page, and keep it if it is
/// an invite.
fn note_message(inner: &Value, gen: u64) {
    let invite = invite_of(inner);
    with_hub(|h| {
        if h.generation == gen {
            h.new_message = true;
            h.invites.extend(invite);
        }
    });
}

/// Apply one hub frame. Returns true when a friend's shown state changed.
fn apply_frame(frame: &str, gen: u64) -> bool {
    let Ok(outer) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    if outer.get("target").and_then(Value::as_str) != Some("Notification") {
        return false;
    }
    let Some(inner) = outer
        .get("arguments")
        .and_then(|a| a.get(0))
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
    else {
        return false;
    };
    match inner.get("Id").and_then(Value::as_str) {
        Some("PresenceUpdate") => {}
        Some("2") => {
            note_message(&inner, gen);
            return false;
        }
        _ => return false,
    }
    let msg = &inner["Msg"];
    let Some(player) = msg.get("PlayerId").and_then(Value::as_i64) else {
        return false;
    };
    let room = msg.get("RoomInstance").filter(|r| r.is_object());
    let mut next = Presence {
        online: msg.get("IsOnline").and_then(Value::as_bool).unwrap_or(false),
        room_id: room.and_then(|r| r.get("RoomId")).and_then(Value::as_i64).unwrap_or(0),
        // Rooms are named with a leading '^' ("^RecCenter") and dorms with a
        // leading '@' ("@name's Dorm"). A private instance still carries its
        // room's name, as the game shows it.
        room_name: room
            .and_then(|r| r.get("Name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_start_matches(['^', '@'])
            .to_string(),
        private: room.and_then(|r| r.get("IsPrivate")).and_then(Value::as_bool).unwrap_or(false),
        hidden: msg.get("StatusVisibility").and_then(Value::as_i64).unwrap_or(0) != 0,
        seen: Instant::now(),
    };
    with_hub(|h| {
        if h.generation != gen {
            return false;
        }
        if h.presence.len() >= PRESENCE_CAP {
            h.presence.retain(|_, p| p.seen.elapsed() < ONLINE_STALE);
        }
        // Stella's push of the friends list says nothing about a hidden
        // friend playing: it sends everyone.
        if h.syncing.remove(&player).is_some_and(|until| Instant::now() < until) {
            next.hidden = false;
        }
        let friend = h.friend_ids.contains(&player);
        let changed = match h.presence.get(&player) {
            Some(p) => {
                p.online != next.online
                    || p.room_id != next.room_id
                    || p.private != next.private
                    || p.seen.elapsed() > ONLINE_STALE
            }
            None => true,
        };
        h.presence.insert(player, next);
        // Only a friend's change redraws anything (the friends card); a profile
        // asks for its player when it opens.
        friend && changed
    })
}

/// A player's status as shown: "online" (heard from recently), "offline",
/// "checking" (the connection is too new for silence to mean offline), or
/// "unknown" (never heard from, and the connection is down after an error —
/// without this they said "Checking…" for as long as it stayed down), with
/// their latest presence when online.
fn status_of(h: &Hub, id: i64) -> (&'static str, Option<&Presence>) {
    if h.paused {
        return ("paused", None);
    }
    let p = h.presence.get(&id);
    let live = p.filter(|p| p.online && p.seen.elapsed() < ONLINE_STALE);
    let settled = h.connected_at.is_some_and(|t| t.elapsed() >= SETTLE);
    let status = if live.is_some() {
        "online"
    } else if p.is_some() || settled {
        "offline"
    } else if h.connected_at.is_none() && !h.error.is_empty() {
        "unknown"
    } else {
        "checking"
    };
    (status, live)
}

/// Start the hub task unless it is already running, or Stella isn't in use.
pub(crate) fn ensure_running(app: AppHandle) {
    if !stella_api::in_use() {
        return;
    }
    let start = with_hub(|h| {
        if h.running {
            None
        } else {
            h.running = true;
            h.generation += 1;
            Some(h.generation)
        }
    });
    if let Some(gen) = start {
        tauri::async_runtime::spawn(run(app, gen));
    }
}

/// One connection, until it drops or the task is stopped.
async fn run_connection(app: &AppHandle, gen: u64) -> Result<(), String> {
    let (token, _) = stella_api::ensure_session().await?;
    load_friends(gen).await?;
    let _ = app.emit(CHANGED_EVENT, ());

    let url = stella_api::hub_url().await;
    let mut req = url.as_str().into_client_request().map_err(|e| format!("Bad address {url}: {e}"))?;
    let headers = req.headers_mut();
    headers.insert("User-Agent", stella_api::USER_AGENT.parse().map_err(|_| "bad header")?);
    headers.insert(
        "Authorization",
        format!("Bearer {token}").parse().map_err(|_| "bad header")?,
    );
    let (ws, _) = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(req))
        .await
        .map_err(|_| format!("Timed out connecting to Stella's friends service at {url}."))?
        .map_err(|e| {
            use tokio_tungstenite::tungstenite::Error;
            let why = match &e {
                // The server's answer, which says what went wrong: a 404 for
                // a moved hub, a 401 for a token it turned down, a block page.
                Error::Http(r) => {
                    if r.status().as_u16() == 401 {
                        stella_api::forget_session_if(&token);
                    }
                    let body = r.body().as_deref().map(|b| applog::snippet(b, 300)).unwrap_or_default();
                    let status = r.status();
                    format!(
                        "HTTP {} {}{}",
                        status.as_u16(),
                        status.canonical_reason().unwrap_or(""),
                        if body.is_empty() { String::new() } else { format!(": {body}") }
                    )
                }
                other => other.to_string(),
            };
            format!("Couldn't connect to Stella's friends service at {url} ({why})")
        })?;
    let failed = with_hub(|h| std::mem::take(&mut h.failures));
    if failed > 0 {
        applog::backend("ok", "server", format!("Connected to Stella's friends service at {url} after {failed} failed tries."));
    } else {
        applog::backend_once(&format!("hub-connected-{url}"), Duration::from_secs(60 * 60), "info", "server", format!("Connected to Stella's friends service at {url}."));
    }
    let (mut tx, mut rx) = ws.split();
    tx.send(Message::Text(format!("{{\"protocol\":\"json\",\"version\":1}}{RS}")))
        .await
        .map_err(|e| e.to_string())?;

    let mut subscribed = false;
    let mut last_ping = Instant::now();
    let mut last_friends = Instant::now();
    let mut last_game_check = Instant::now();
    loop {
        if !current(gen) {
            let _ = tx.send(Message::Close(None)).await;
            return Ok(());
        }
        // The game started: let go before it connects (see the module docs).
        if last_game_check.elapsed() >= GAME_CHECK {
            last_game_check = Instant::now();
            if tokio::task::spawn_blocking(game_running).await.unwrap_or(false) {
                let _ = tx.send(Message::Close(None)).await;
                return Ok(());
            }
        }
        if last_ping.elapsed() >= PING_EVERY {
            tx.send(Message::Text(format!("{{\"type\":6}}{RS}")))
                .await
                .map_err(|e| e.to_string())?;
            last_ping = Instant::now();
        }
        if last_friends.elapsed() >= FRIENDS_REFRESH {
            subscribed = false;
        }
        // Once connected, and again every FRIENDS_REFRESH: read the friends
        // list, which also has Stella push every friend's presence to this
        // connection (see the module docs), then subscribe to them.
        if !subscribed && with_hub(|h| h.connected_at.is_some()) {
            subscribed = true;
            last_friends = Instant::now();
            expect_friends_sync(gen);
            if load_friends(gen).await.is_ok() {
                let _ = app.emit(CHANGED_EVENT, ());
            }
            let ids = with_hub(|h| h.friend_ids.clone());
            let sub = json!({
                "type": 1, "invocationId": "1", "nonblocking": false,
                "target": "SubscribeToPlayers", "arguments": [{ "PlayerIds": ids }]
            });
            tx.send(Message::Text(format!("{sub}{RS}"))).await.map_err(|e| e.to_string())?;
        }

        let msg = match tokio::time::timeout(Duration::from_secs(1), rx.next()).await {
            Err(_) => continue, // nothing this second; loop to ping / check
            Ok(None) => return Err("Stella closed the friends connection.".into()),
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(Some(Ok(m))) => m,
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            Message::Close(_) => return Err("Stella closed the friends connection.".into()),
            _ => continue,
        };
        let mut changed = false;
        for frame in text.split(RS).filter(|f| !f.trim().is_empty()) {
            // The handshake's answer: now connected, and able to subscribe.
            if frame.trim() == "{}" {
                with_hub(|h| {
                    if h.generation == gen {
                        h.connected_at = Some(Instant::now());
                        h.error.clear();
                    }
                });
                changed = true;
                continue;
            }
            // SignalR "close", sent by the server before it hangs up.
            if frame.contains("\"type\":7") {
                return Err("Stella closed the friends connection.".into());
            }
            changed |= apply_frame(frame, gen);
        }
        if changed {
            let _ = app.emit(CHANGED_EVENT, ());
        }
        let (invites, new_message) = with_hub(|h| (std::mem::take(&mut h.invites), std::mem::take(&mut h.new_message)));
        if new_message {
            let _ = app.emit(MESSAGE_EVENT, ());
        }
        for invite in invites {
            let _ = app.emit(INVITE_EVENT, invite);
        }
    }
}

/// Note a lost or failed connection in the log. The same failure repeating on
/// every retry is logged once every few minutes, with how many tries it has
/// been; signing out or leaving Stella isn't a failure.
fn log_connection_error(gen: u64, e: &str, was_connected: bool, lasted: Duration, retry_in: Duration) {
    if e == stella_api::SIGNED_OUT_ERROR || e == stella_api::NOT_IN_USE || !current(gen) {
        return;
    }
    let failures = with_hub(|h| {
        h.failures += 1;
        h.failures
    });
    let msg = if was_connected {
        format!("Stella's friends connection dropped after {}s: {e}. Reconnecting in {}s.", lasted.as_secs(), retry_in.as_secs())
    } else {
        format!("Stella's friends connection failed (try {failures}): {e}. Trying again in {}s.", retry_in.as_secs())
    };
    applog::backend_once(&format!("hub-{e}"), Duration::from_secs(5 * 60), if was_connected { "warn" } else { "error" }, "server", msg);
}

/// Keep a connection up until stopped, reconnecting with a growing pause.
async fn run(app: AppHandle, gen: u64) {
    let mut backoff = Duration::from_secs(5);
    while current(gen) {
        // Wait the game out rather than fight it for the hub.
        if tokio::task::spawn_blocking(game_running).await.unwrap_or(false) {
            let newly = with_hub(|h| {
                let newly = h.generation == gen && !h.paused;
                if newly {
                    h.paused = true;
                    h.connected_at = None;
                }
                newly
            });
            if newly {
                let _ = app.emit(CHANGED_EVENT, ());
            }
            tokio::time::sleep(GAME_CHECK).await;
            continue;
        }
        let resumed = with_hub(|h| {
            let was = h.generation == gen && h.paused;
            if was {
                h.paused = false;
                // What was heard before the game ran is stale now.
                h.presence.clear();
            }
            was
        });
        if resumed {
            backoff = Duration::from_secs(5);
            let _ = app.emit(CHANGED_EVENT, ());
        }
        let started = Instant::now();
        let result = run_connection(&app, gen).await;
        let was_connected = with_hub(|h| {
            let was = h.connected_at.is_some();
            if h.generation == gen {
                h.connected_at = None;
                if let Err(e) = &result {
                    h.error = e.clone();
                }
            }
            was
        });
        if let Err(e) = &result {
            log_connection_error(gen, e, was_connected, started.elapsed(), backoff);
        }
        let _ = app.emit(CHANGED_EVENT, ());
        if !current(gen) {
            break;
        }
        // A connection that lasted a while wasn't the problem: retry soon.
        if started.elapsed() > Duration::from_secs(120) {
            backoff = Duration::from_secs(5);
        }
        let until = Instant::now() + backoff;
        while Instant::now() < until && current(gen) {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        backoff = (backoff * 2).min(Duration::from_secs(120));
    }
    with_hub(|h| {
        if h.generation == gen {
            h.running = false;
        }
    });
}

/// The friends card's contents, starting the hub connection if it isn't up.
///
/// Each friend is `{ id, userName, displayName, AvatarUrl, status, roomId,
/// roomName, private }`, `status` being "online", "offline", "checking",
/// "unknown" (see [`status_of`]), or "paused" while the game is running.
/// Online friends come first.
#[tauri::command]
pub async fn stella_friends(app: AppHandle) -> Value {
    if stella_api::signed_out() {
        return json!({ "success": false, "error": stella_api::SIGNED_OUT_ERROR });
    }
    ensure_running(app);

    with_hub(|h| {
        let mut friends: Vec<Value> = h
            .friend_ids
            .iter()
            .filter_map(|id| h.accounts.get(id).map(|a| (id, a)))
            .map(|(id, account)| {
                let (status, live) = status_of(h, *id);
                let mut row = account.clone();
                row["status"] = json!(status);
                row["roomId"] = json!(live.map_or(0, |p| p.room_id));
                row["roomName"] = json!(live.map_or("", |p| p.room_name.as_str()));
                row["private"] = json!(live.is_some_and(|p| p.private));
                row
            })
            .collect();
        let rank = |s: &str| match s {
            "online" => 0,
            "checking" | "paused" | "unknown" => 1,
            _ => 2,
        };
        friends.sort_by(|a, b| {
            rank(a["status"].as_str().unwrap_or("")).cmp(&rank(b["status"].as_str().unwrap_or(""))).then_with(|| {
                let name = |v: &Value| v["displayName"].as_str().unwrap_or("").to_lowercase();
                name(a).cmp(&name(b))
            })
        });
        json!({
            "success": true,
            "loaded": h.loaded,
            "connected": h.connected_at.is_some(),
            "paused": h.paused,
            "error": h.error,
            "friends": friends,
        })
    })
}

/// One player's status for their profile page: `{ status, roomId, roomName,
/// private }`, `status` as in [`stella_friends`], "paused" while the game is
/// running, or "unknown" while the hub can't be reached. Starts the hub if it
/// isn't up.
#[tauri::command]
pub async fn stella_presence(app: AppHandle, player_id: i64) -> Value {
    if stella_api::signed_out() {
        return json!({ "status": "unknown" });
    }
    ensure_running(app);
    with_hub(|h| {
        if !h.paused && h.connected_at.is_none() && !h.error.is_empty() {
            return json!({ "status": "unknown" });
        }
        let (status, live) = status_of(h, player_id);
        json!({
            "status": status,
            "roomId": live.map_or(0, |p| p.room_id),
            "roomName": live.map_or("", |p| p.room_name.as_str()),
            "private": live.is_some_and(|p| p.private),
        })
    })
}

/// Players in each room right now, by room id, from the hub's presence — every
/// online player whose room the server shares (public visibility), across all
/// rooms at once. `None` while the hub isn't connected (or is paused for the
/// game), since an empty map would rank every room as empty.
pub fn room_counts(app: AppHandle) -> Option<HashMap<i64, usize>> {
    if stella_api::signed_out() {
        return None;
    }
    ensure_running(app);
    with_hub(|h| {
        if h.paused || h.connected_at.is_none() {
            return None;
        }
        let mut counts = HashMap::new();
        for p in h.presence.values() {
            if p.online && p.room_id != 0 && p.seen.elapsed() < ONLINE_STALE {
                *counts.entry(p.room_id).or_insert(0) += 1;
            }
        }
        Some(counts)
    })
}

/// Who the hub can say is online, for People's list before anything is typed.
pub enum Online {
    /// Players heard online recently, and whether it has listened long
    /// enough ([`COUNT_SETTLE`]) for that to be everyone.
    Players { players: Vec<OnlinePlayer>, settled: bool },
    /// Connecting, with nothing heard yet.
    Connecting,
    /// Disconnected while the game runs (see the module docs).
    Paused,
    /// Down after an error; it keeps retrying.
    Down,
    /// Closed because Stella isn't in use (see `stella_api::in_use`).
    Idle,
}

pub struct OnlinePlayer {
    pub id: i64,
    pub room_name: String,
    pub private: bool,
    pub friend: bool,
}

/// Players online now, starting the hub if it isn't up. Only players whose
/// status is public: a hidden one is always reported offline, and is never
/// listed by name (they count only as a number; see [`player_count`]).
pub fn online_players(app: AppHandle) -> Online {
    if stella_api::signed_out() {
        return Online::Down;
    }
    if !stella_api::in_use() {
        return Online::Idle;
    }
    ensure_running(app);
    with_hub(|h| {
        if h.paused {
            return Online::Paused;
        }
        let Some(since) = h.connected_at else {
            return if h.error.is_empty() { Online::Connecting } else { Online::Down };
        };
        let players = h
            .presence
            .iter()
            .filter(|(_, p)| p.online && p.seen.elapsed() < ONLINE_STALE)
            .map(|(&id, p)| OnlinePlayer {
                id,
                room_name: p.room_name.clone(),
                private: p.private,
                friend: h.friend_ids.contains(&id),
            })
            .collect();
        Online::Players { players, settled: since.elapsed() >= COUNT_SETTLE }
    })
}

/// A player's presence for a search result, as their profile would show it:
/// `Some((online, room name, private))`, or `None` while it can't be told.
/// Reads what the hub has without starting it.
pub fn presence_for(id: i64) -> Option<(bool, String, bool)> {
    with_hub(|h| match status_of(h, id) {
        ("online", live) => Some((true, live.map(|p| p.room_name.clone()).unwrap_or_default(), live.is_some_and(|p| p.private))),
        ("offline", _) => Some((false, String::new(), false)),
        _ => None,
    })
}

/// Whether the hub is connected and listening now.
pub fn listening() -> bool {
    with_hub(|h| h.running && !h.paused && h.connected_at.is_some())
}

/// Players in private copies of each room right now, by room id.
///
/// Stella's per-room instance list (`/match/room/{id}/instances`) holds only
/// public copies — checked 2026-10-02: none of eight private instances the hub
/// reported appeared in their room's list, every public one did — so these
/// add to that count without overlapping it. Only players whose status is
/// public can be placed (a hidden player's room isn't shared). Reads what the
/// hub already has without starting it; `None` while it isn't connected.
pub fn private_counts() -> Option<HashMap<i64, usize>> {
    with_hub(|h| {
        if h.paused || h.connected_at.is_none() {
            return None;
        }
        let mut counts = HashMap::new();
        for p in h.presence.values() {
            if p.online && p.private && p.room_id != 0 && p.seen.elapsed() < ONLINE_STALE {
                *counts.entry(p.room_id).or_insert(0) += 1;
            }
        }
        Some(counts)
    })
}

/// Of these listed players, how many the hub has heard from recently — that
/// is, how many are really in the game (see `stella_api::count_real`). `None`
/// until the hub has listened for [`ONLINE_STALE`] (some real players weren't
/// heard for up to ~2 minutes in testing, and dropping them would be worse
/// than keeping a ghost), and while it is paused for the game.
pub fn heard_among(ids: &[i64]) -> Option<usize> {
    with_hub(|h| {
        let listened = !h.paused && h.connected_at.is_some_and(|t| t.elapsed() >= ONLINE_STALE);
        if !listened {
            return None;
        }
        Some(
            ids.iter()
                .filter(|id| {
                    h.presence
                        .get(id)
                        .is_some_and(|p| p.seen.elapsed() < ONLINE_STALE && (p.online || p.hidden))
                })
                .count(),
        )
    })
}

/// Players heard from recently, less the public ones who said they left.
fn count_online(h: &Hub) -> usize {
    h.presence
        .values()
        .filter(|p| p.seen.elapsed() < ONLINE_STALE && (p.online || p.hidden))
        .count()
}

/// Stella's players online, for Home's "Players Online" card.
///
/// Stella publishes no count, but the hub re-sends every online player's
/// presence every 20–40 seconds, so the players heard from within
/// [`ONLINE_STALE`] are the ones playing. A public player whose last word was
/// "offline" has logged off and isn't counted; a hidden one is always marked
/// offline, so being re-sent at all is what counts them.
///
/// `{ success, count }` once the connection has been up long enough for
/// everyone online to have been heard from; otherwise `{ success: false }`
/// with `counting` (just connected), `paused` (the game is running; see the
/// module docs) or `error`.
pub fn player_count(app: AppHandle) -> Value {
    if stella_api::signed_out() {
        return json!({ "success": false, "signedOut": true, "error": stella_api::SIGNED_OUT_ERROR });
    }
    // Not counting while Stella isn't in use: the page leaves the card as it
    // was, and asks again when it is back on screen.
    if !stella_api::in_use() {
        return json!({ "success": false, "idle": true });
    }
    ensure_running(app);
    with_hub(|h| {
        if h.paused {
            return json!({ "success": false, "paused": true });
        }
        let Some(since) = h.connected_at else {
            return if h.error.is_empty() {
                json!({ "success": false, "counting": true })
            } else {
                json!({ "success": false, "error": h.error })
            };
        };
        // Not everyone has been heard from yet: say how many so far, as a
        // floor, so the card has a number from the first seconds.
        if since.elapsed() < COUNT_SETTLE {
            return json!({ "success": false, "counting": true, "soFar": count_online(h) });
        }
        json!({ "success": true, "count": count_online(h) })
    })
}

/// Stop the hub connection (the frontend calls this on leaving Stella).
#[tauri::command]
pub fn stella_friends_stop() {
    stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_online_and_hidden_players_not_leavers() {
        let p = |online, hidden| Presence {
            online,
            room_id: 0,
            room_name: String::new(),
            private: false,
            hidden,
            seen: Instant::now(),
        };
        let mut h = Hub::default();
        h.presence.insert(1, p(true, false)); // public, playing
        h.presence.insert(2, p(false, true)); // hidden, still re-sent
        h.presence.insert(3, p(false, false)); // public, logged off
        assert_eq!(count_online(&h), 2);
    }

    /// Never heard from: "checking" while connecting, "unknown" once the
    /// connection has failed, rather than "checking" for as long as it's down.
    #[test]
    fn a_friend_never_heard_from_is_unknown_while_disconnected() {
        let mut h = Hub::default();
        assert_eq!(status_of(&h, 7).0, "checking");
        h.error = "Couldn't connect to Stella's friends service".into();
        assert_eq!(status_of(&h, 7).0, "unknown");
        h.connected_at = Some(Instant::now());
        h.error.clear();
        assert_eq!(status_of(&h, 7).0, "checking");
        h.connected_at = Instant::now().checked_sub(SETTLE + Duration::from_secs(1));
        assert_eq!(status_of(&h, 7).0, "offline");
    }

    #[test]
    fn reads_who_sent_an_invite() {
        // As captured 2026-10-04: an invite, and a friend notice (type 40).
        let invite = json!({ "Id": "2", "Msg": {
            "Id": 7, "FromPlayerId": 4034, "Type": 6, "RoomId": 6389,
            "Data": "{\"InviteId\":70172316,\"Name\":\"@Fangame300's Dorm\",\"InviteMode\":22}"
        }});
        assert_eq!(
            invite_of(&invite),
            Some(json!({ "fromPlayerId": 4034, "inviteId": 70172316, "roomId": 6389, "roomName": "Fangame300's Dorm" }))
        );
        let notice = json!({ "Id": "2", "Msg": { "Id": 7, "FromPlayerId": 71838, "Type": 40, "Data": "0" } });
        assert_eq!(invite_of(&notice), None);
    }

    fn frame(msg: Value) -> String {
        let inner = json!({ "Id": "PresenceUpdate", "Msg": msg }).to_string();
        json!({ "type": 1, "target": "Notification", "arguments": [inner] }).to_string()
    }

    #[test]
    fn keeps_only_friends_and_reads_the_room() {
        stop();
        let gen = with_hub(|h| {
            h.friend_ids = vec![18024];
            h.generation
        });
        // A stranger is remembered (for their profile) but redraws nothing.
        let stranger = frame(json!({ "PlayerId": 5, "IsOnline": true, "RoomInstance": null }));
        assert!(!apply_frame(&stranger, gen));
        let friend = frame(json!({
            "PlayerId": 18024, "IsOnline": true, "StatusVisibility": 0,
            "RoomInstance": { "RoomId": 9, "Name": "^RecCenter", "IsPrivate": false }
        }));
        assert!(apply_frame(&friend, gen));
        let dorm = frame(json!({
            "PlayerId": 18024, "IsOnline": true,
            "RoomInstance": { "RoomId": 158978, "Name": "@funanter5565's Dorm", "IsPrivate": true }
        }));
        assert!(apply_frame(&dorm, gen));
        with_hub(|h| {
            let p = &h.presence[&18024];
            assert_eq!(p.room_name, "funanter5565's Dorm");
            assert!(p.private);
        });
        assert!(apply_frame(&friend, gen));
        // The same state again isn't a change.
        assert!(!apply_frame(&friend, gen));
        with_hub(|h| {
            assert!(h.presence[&5].online);
            let p = &h.presence[&18024];
            assert!(p.online);
            assert_eq!(p.room_id, 9);
            assert_eq!(p.room_name, "RecCenter");
        });
        // Ghosts: a listed player the hub hasn't heard from doesn't count, but
        // only once it has listened long enough (and never while just started).
        with_hub(|h| h.connected_at = Some(Instant::now()));
        assert_eq!(heard_among(&[18024, 5, 999]), None);
        with_hub(|h| h.connected_at = Instant::now().checked_sub(ONLINE_STALE + Duration::from_secs(1)));
        assert_eq!(heard_among(&[18024, 5, 999]), Some(2));
        with_hub(|h| h.paused = true);
        assert_eq!(heard_among(&[18024, 5, 999]), None);
        stop();

        // The push that reading the friends list sets off: it settles a
        // hidden friend as offline, but doesn't count them as playing. Their
        // next presence, a real re-send, does.
        let gen = with_hub(|h| {
            h.friend_ids = vec![519];
            h.generation
        });
        expect_friends_sync(gen);
        let hidden = frame(json!({ "PlayerId": 519, "IsOnline": false, "StatusVisibility": 2, "RoomInstance": null }));
        assert!(apply_frame(&hidden, gen));
        with_hub(|h| {
            assert_eq!(status_of(h, 519).0, "offline");
            assert_eq!(count_online(h), 0);
        });
        apply_frame(&hidden, gen);
        with_hub(|h| assert_eq!(count_online(h), 1));

        // Stella no longer in use: the connection goes and what was heard
        // with it, but the friends list stays for when Stella comes back.
        with_hub(|h| h.connected_at = Some(Instant::now()));
        suspend();
        with_hub(|h| {
            assert_eq!(h.friend_ids, vec![519]);
            assert!(h.presence.is_empty());
            assert!(h.connected_at.is_none() && !h.running && h.generation != gen);
        });
        stop();
    }
}
