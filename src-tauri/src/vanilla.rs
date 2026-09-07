//! Vanilla (`vanillarec.net`) network support.
//!
//! Everything in here talks to `https://api.vanillarec.net` and then reshapes
//! the response into the envelope the frontend already consumes for Radium
//! (`{ Results: [...], TotalResults: n }` with PascalCase room fields and
//! camelCase people fields). Keeping the translation on this side means
//! `loadRooms()` / `loadPeople()` and the detail views stay network-agnostic.
//!
//! Three things Vanilla's API does *not* have, and how they're handled:
//!
//! * **No `skip`.** Every list endpoint takes `count` only, so pagination is
//!   emulated by over-fetching `skip + take + 1` and slicing. The extra row is
//!   what tells us whether a "next page" exists.
//! * **No creator name on room rows.** Rooms carry only `creatorPlayerId`, so a
//!   page of rooms costs one extra batched `players?ids=` lookup — the same
//!   thing vanillarec.net's own site does.
//! * **No browse-all-players.** `players/search` needs a query of at least two
//!   characters, so the unfiltered People list is seeded from the creators of
//!   the currently popular rooms.

use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::server::{http, USER_AGENT};

/// Image and player-count host. Both are served directly to any client.
const API_BASE: &str = "https://api.vanillarec.net";

/// Vanilla's website, which fronts the same API at `/api.php?path=...`.
const SITE_BASE: &str = "https://vanillarec.net";

/// Sent with proxied requests; the proxy only answers when it is present.
const SITE_REFERER: &str = "https://vanillarec.net/";

/// Vanilla rejects a search of fewer than this many characters with a 400
/// (`{"error":"query_too_short"}`), so we short-circuit instead.
const MIN_QUERY_LEN: usize = 2;

/// Ceiling on a single over-fetch, so deep paging can't ask for a huge page.
const MAX_FETCH_COUNT: i64 = 500;

/// `rooms/popular` and `rooms/search` both cap their response at 100 rows no
/// matter what `count` asks for, so this is the real size of the set a sort can
/// order.
const ROOM_FETCH_CAP: i64 = 100;

/// `players?ids=` returns at most 20 rows per request, which bounds the People
/// page size when the list is being enumerated by id.
const PLAYERS_BATCH_CAP: i64 = 20;

/// How many popular rooms to sample when deriving the tag vocabulary. Their
/// details are fetched concurrently, so this is one round trip, not N.
const TAG_SAMPLE_ROOMS: usize = 40;

/// How long a derived tag vocabulary stays fresh. Tags change when creators
/// retag rooms, which is far slower than a launcher session.
const TAG_CACHE_TTL: Duration = Duration::from_secs(30 * 60);

/// GET a `/api/website/...` path as JSON through Vanilla's own site proxy.
///
/// The `api.vanillarec.net` host sits behind a Cloudflare bot rule that answers
/// 403 to every non-browser client whatever headers it sends, so the direct
/// route is closed to the launcher. Their website reaches the same public data
/// through `vanillarec.net/api.php?path=...`, which accepts this launcher's own
/// User-Agent as long as a Referer naming their site is present.
///
/// The two endpoints the launcher uses directly — `/ws/getplrcount` and
/// `/images/...` — are not behind that rule and are fetched from the API host.
async fn api_get_json(path: &str) -> Result<Value, String> {
    let url = format!("{}/api.php?path={}", SITE_BASE, urlencoding(path));

    let response = http()
        .get(&url)
        .timeout(Duration::from_secs(15))
        .header("User-Agent", USER_AGENT)
        .header("Referer", SITE_REFERER)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP error: {}", status));
    }

    let body = response.text().await.map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&body).map_err(|_| {
        format!(
            "Unexpected response from Vanilla: {}",
            body.chars().take(120).collect::<String>()
        )
    })?;

    // The proxy reports its own refusals as a 200 carrying an error object, so
    // a successful status alone isn't enough to treat this as a result.
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        return Err(format!("Vanilla API: {}", err));
    }
    Ok(value)
}

/// Absolute URL for an image, from the relative `imageUrl` the API returns.
///
/// Used verbatim rather than rebuilt from `imageName`: some values already
/// carry a `?cachebuster` query (e.g. `/images/2_webso?1785023462696`), and
/// Vanilla's image endpoint has no `?width=` resizing to append anyway.
fn image_url(rel: Option<&str>) -> Option<String> {
    let rel = rel?.trim();
    if rel.is_empty() {
        return None;
    }
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return Some(rel.to_string());
    }
    Some(format!("{}{}", API_BASE, rel))
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn num_field(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// One page of results, plus what we honestly know about the size of the set.
struct Page {
    rows: Vec<Value>,
    total: i64,
    /// False when `total` is a running estimate rather than a real count.
    ///
    /// Vanilla never reports the size of a result set. When we have provably
    /// fetched all of it, `total` is exact and the UI can say "Page 2 of 5".
    /// When rows might still be waiting behind the API's row cap, any total we
    /// invent would be a lie that grows as the user pages, so the UI drops the
    /// "of N" instead of printing a number that keeps moving.
    total_known: bool,
}

/// Slice `results` to one page.
///
/// `fetched_everything` says whether `results` is the complete set — the caller
/// knows this because it asked for more rows than came back.
fn paginate(results: Vec<Value>, skip: i64, take: i64, fetched_everything: bool) -> Page {
    let skip = skip.max(0) as usize;
    let take = take.max(1) as usize;
    let total_fetched = results.len();

    let rows: Vec<Value> = results.into_iter().skip(skip).take(take).collect();
    let shown = skip + rows.len();

    if fetched_everything {
        return Page { rows, total: total_fetched as i64, total_known: true };
    }

    // More rows may exist beyond what the API handed over. Report one page
    // further than we've shown so Next stays enabled, and flag it as a guess.
    let has_more = total_fetched > shown;
    Page {
        rows,
        total: if has_more { shown as i64 + 1 } else { shown as i64 },
        total_known: !has_more,
    }
}

/// How many rows to ask Vanilla for to be able to serve page `skip..skip+take`.
/// The `+ 1` is the probe row that reveals whether a next page exists.
fn fetch_count(skip: i64, take: i64) -> i64 {
    (skip.max(0) + take.max(1) + 1).min(MAX_FETCH_COUNT)
}

fn results_of(data: &Value) -> Vec<Value> {
    data.get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default()
}

// ─── Player count / reachability ──────────────────────────────────────────

/// Current online player count.
///
/// `/ws/getplrcount` answers with a bare integer (served as `application/json`,
/// but it is a scalar, not an object), so it is read as text and parsed.
pub async fn get_player_count() -> Value {
    let url = format!("{}/ws/getplrcount", API_BASE);

    let resp = match http()
        .get(&url)
        .timeout(Duration::from_secs(15))
        .header("User-Agent", USER_AGENT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return json!({ "success": false, "error": e.to_string() }),
    };

    let status = resp.status();
    if !status.is_success() {
        return json!({ "success": false, "error": format!("HTTP error: {}", status) });
    }

    match resp.text().await {
        Ok(body) => match body.trim().parse::<i64>() {
            Ok(count) => json!({ "success": true, "count": count }),
            Err(_) => json!({
                "success": false,
                "error": format!("Unexpected player-count response: {}", body.trim())
            }),
        },
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

/// The URL used to test whether Vanilla is up.
///
/// Vanilla has no `/health`; the player-count endpoint is the cheapest thing
/// that proves the API is actually serving rather than just resolving.
pub fn ping_url() -> String {
    format!("{}/ws/getplrcount", API_BASE)
}

// ─── Normalizers ──────────────────────────────────────────────────────────

/// Reshape a Vanilla room into the PascalCase shape the room grid and detail
/// view read. `creators` resolves `creatorPlayerId` when known.
fn normalize_room(room: &Value, creators: Option<&CreatorMap>) -> Value {
    let creator_id = num_field(room, "creatorPlayerId");

    // A room detail response embeds the full creator object; list rows don't,
    // hence the batched lookup that fills `creators`.
    let embedded_creator = room.get("creator");
    let looked_up = creators.and_then(|m| m.get(&creator_id));

    let creator_username = embedded_creator
        .and_then(|c| str_field(c, "username"))
        .map(|s| s.to_string())
        .or_else(|| {
            looked_up
                .map(|c| c.username.clone())
                .filter(|u| !u.is_empty())
        })
        .unwrap_or_else(|| "Unknown".to_string());

    let creator_avatar = embedded_creator
        .and_then(|c| image_url(str_field(c, "profileImageUrl")))
        .or_else(|| looked_up.map(|c| c.avatar.clone()).filter(|a| !a.is_empty()))
        .unwrap_or_default();

    json!({
        "RoomId": room.get("roomId").cloned().unwrap_or(Value::Null),
        "Name": str_field(room, "name").unwrap_or(""),
        "Description": str_field(room, "description").unwrap_or(""),
        "ImageName": str_field(room, "imageName").unwrap_or(""),
        "ThumbUrl": image_url(str_field(room, "imageUrl")).unwrap_or_default(),
        "CreatorUsername": creator_username,
        "CreatorPlayerId": creator_id,
        "CreatorAvatarUrl": creator_avatar,
        "CheerCount": num_field(room, "cheerCount"),
        "FavoriteCount": num_field(room, "favoriteCount"),
        "VisitCount": num_field(room, "visitCount"),
        "ActivePlayerCount": num_field(room, "activePlayerCount"),
        "CreatedAt": room.get("createdAt").cloned().unwrap_or(Value::Null),
        "Accessibility": str_field(room, "accessibility").unwrap_or(""),
    })
}

/// Reshape a Vanilla player into the camelCase shape the people table reads.
///
/// `isOnline` is deliberately `null`: Vanilla exposes no presence, and
/// reporting everyone as offline would be a lie the UI would render as a dot.
fn normalize_person(p: &Value) -> Value {
    json!({
        "id": p.get("id").cloned().unwrap_or(Value::Null),
        "userName": str_field(p, "username").unwrap_or(""),
        "displayName": str_field(p, "displayName").unwrap_or(""),
        "bio": str_field(p, "bio").unwrap_or(""),
        "profileImage": str_field(p, "profileImageName").unwrap_or(""),
        "AvatarUrl": image_url(str_field(p, "profileImageUrl")).unwrap_or_default(),
        "isOnline": Value::Null,
        "followerCount": num_field(p, "followerCount"),
        // Staff flags. vanillarec.net drives its own badges off a hardcoded
        // list in badgeConfig.js, but these booleans are the server's own
        // answer and can't drift out of date, so the launcher uses them.
        "isDeveloper": p.get("isDeveloper").cloned().unwrap_or(Value::Bool(false)),
        "isModerator": p.get("isModerator").cloned().unwrap_or(Value::Bool(false)),
        "isCommunityTeam": p.get("isCommunityTeam").cloned().unwrap_or(Value::Bool(false)),
        "createdAt": p.get("createdAt").cloned().unwrap_or(Value::Null),
    })
}

/// Reshape a Vanilla image/photo into the shape the feed cards read.
fn normalize_photo(p: &Value) -> Value {
    json!({
        "Id": p.get("photoId").cloned().unwrap_or(Value::Null),
        "ImageName": str_field(p, "imageName").unwrap_or(""),
        "ThumbUrl": image_url(str_field(p, "imageUrl")).unwrap_or_default(),
        "RoomId": p.get("roomId").cloned().unwrap_or(Value::Null),
        "RoomName": str_field(p, "roomName").unwrap_or(""),
        "CreatorPlayerId": num_field(p, "creatorPlayerId"),
        "CreatorDisplayName": str_field(p, "creatorDisplayName").unwrap_or(""),
        // The photo feed embeds its uploader, so the card can attribute the
        // shot without the extra per-photo lookup Radium needs.
        "CreatorUsername": p
            .get("sender")
            .and_then(|s| str_field(s, "username"))
            .unwrap_or_else(|| str_field(p, "creatorDisplayName").unwrap_or("")),
        // "recnetupload" is the marker the game stamps on an untitled photo,
        // not something a player wrote — vanillarec.net doesn't render it and
        // neither should we.
        "Description": match str_field(p, "description") {
            Some("recnetupload") | None => "",
            Some(d) => d,
        },
        "CheerCount": num_field(p, "cheerCount"),
        // Null, not zero: Vanilla has no comment count at all, and the card
        // hides the stat when it is absent rather than claiming "0 Comments"
        // on every photo. `num_field` would flatten the difference to 0.
        "CommentCount": p.get("commentCount").cloned().unwrap_or(Value::Null),
        // Everyone in the shot, for the "In this photo:" line.
        "TaggedPlayers": p
            .get("taggedPlayers")
            .and_then(|t| t.as_array())
            .map(|players| {
                players
                    .iter()
                    .map(|tp| {
                        json!({
                            "id": tp.get("id").cloned().unwrap_or(Value::Null),
                            "userName": str_field(tp, "username").unwrap_or(""),
                            "displayName": str_field(tp, "displayName")
                                .or_else(|| str_field(tp, "username"))
                                .unwrap_or(""),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        "CreatedAt": p
            .get("takenAt")
            .cloned()
            .or_else(|| p.get("createdAt").cloned())
            .unwrap_or(Value::Null),
    })
}

// ─── Batched creator lookup ───────────────────────────────────────────────

/// A player as far as a room or photo card needs them.
#[derive(Clone, Default)]
struct CreatorInfo {
    username: String,
    avatar: String,
}

type CreatorMap = std::collections::HashMap<i64, CreatorInfo>;

/// Resolve player ids to usernames and avatars.
///
/// Room and photo rows carry only a `creatorPlayerId`, so a page's worth of
/// them is looked up in one go — the same batching vanillarec.net's own site
/// does. `players?ids=` caps at [`PLAYERS_BATCH_CAP`] rows, so larger sets are
/// split into chunks issued concurrently.
///
/// Failures are swallowed: an unresolved creator degrades one card to
/// "Unknown", which beats failing the whole page over it.
async fn resolve_creators(ids: &BTreeSet<i64>) -> CreatorMap {
    let mut map = CreatorMap::new();
    if ids.is_empty() {
        return map;
    }

    let chunks: Vec<String> = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .chunks(PLAYERS_BATCH_CAP as usize)
        .map(|c| c.join(","))
        .collect();

    let responses = futures_util::future::join_all(chunks.into_iter().map(|joined| async move {
        api_get_json(&format!("/api/website/players?ids={}", joined)).await
    }))
    .await;

    for data in responses.into_iter().flatten() {
        for p in results_of(&data) {
            let Some(id) = p.get("id").and_then(|v| v.as_i64()) else {
                continue;
            };
            map.insert(
                id,
                CreatorInfo {
                    username: str_field(&p, "username").unwrap_or_default().to_string(),
                    avatar: image_url(str_field(&p, "profileImageUrl")).unwrap_or_default(),
                },
            );
        }
    }
    map
}

/// Fill in `CreatorUsername` / `CreatorAvatarUrl` on a page of normalized
/// photos, so the feed cards can attribute a shot without a lookup each.
async fn attach_photo_creators(photos: &mut [Value]) {
    let ids: BTreeSet<i64> = photos
        .iter()
        .map(|p| p["CreatorPlayerId"].as_i64().unwrap_or(0))
        .filter(|id| *id != 0)
        .collect();
    if ids.is_empty() {
        return;
    }

    let creators = resolve_creators(&ids).await;
    for photo in photos.iter_mut() {
        let id = photo["CreatorPlayerId"].as_i64().unwrap_or(0);
        if let Some(info) = creators.get(&id) {
            if !info.username.is_empty() {
                photo["CreatorUsername"] = json!(info.username);
            }
            photo["CreatorAvatarUrl"] = json!(info.avatar);
        }
    }
}

// ─── Rooms ────────────────────────────────────────────────────────────────

/// Order a room list in place to match one of the launcher's sort buttons.
///
/// Vanilla's API has no `sortBy`, but every field the buttons sort on is present
/// on each list row, so the ordering is applied here over the whole fetched set
/// (see `ROOM_FETCH_CAP`) rather than page by page — sorting only the visible
/// page would reorder within a page while leaving the pages themselves wrong.
///
/// Sort 0 ("Hot") is the API's own popularity order, so it is left untouched.
fn sort_rooms(rooms: &mut Vec<Value>, sort_by: i64) {
    let key = match sort_by {
        1 => "createdAt",
        2 => "visitCount",
        3 => "cheerCount",
        4 => "favoriteCount",
        _ => return,
    };

    if key == "createdAt" {
        // Timestamps are RFC 3339 from one source, so lexical order is
        // chronological order; newest first.
        rooms.sort_by(|a, b| {
            str_field(b, key)
                .unwrap_or("")
                .cmp(str_field(a, key).unwrap_or(""))
        });
    } else {
        rooms.sort_by(|a, b| num_field(b, key).cmp(&num_field(a, key)));
    }
}

pub async fn fetch_rooms(skip: i64, take: i64, query: &str, tag: &str, sort_by: i64) -> Value {
    let query = query.trim();
    let tag = tag.trim();

    // Vanilla's search matches names, descriptions AND tags in one `q`, and a
    // multi-word `q` matches nothing, so the two can't be combined. A typed
    // search wins; the frontend clears the tag selection to match.
    let term = if !query.is_empty() { query } else { tag };

    // A one-character query would 400; show an empty page instead of an error.
    if !term.is_empty() && term.chars().count() < MIN_QUERY_LEN {
        return json!({
            "success": true,
            "data": { "Results": [], "TotalResults": 0 }
        });
    }

    // Sorting has to see the whole result set to be correct, so when a sort is
    // active fetch up to the API's ceiling instead of just this page's window.
    let count = if sort_by == 0 {
        fetch_count(skip, take)
    } else {
        ROOM_FETCH_CAP
    };

    let path = if term.is_empty() {
        format!("/api/website/rooms/popular?count={}", count)
    } else {
        format!(
            "/api/website/rooms/search?q={}&count={}",
            urlencoding(term),
            count
        )
    };

    let data = match api_get_json(&path).await {
        Ok(d) => d,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let mut rows = results_of(&data);
    sort_rooms(&mut rows, sort_by);
    // Fewer rows than we asked for means the API gave us the entire result set,
    // so the page count that follows is a real one rather than a guess.
    let complete = (rows.len() as i64) < count;
    let page = paginate(rows, skip, take, complete);

    let ids: BTreeSet<i64> = page
        .rows
        .iter()
        .map(|r| num_field(r, "creatorPlayerId"))
        .filter(|id| *id != 0)
        .collect();
    let creators = resolve_creators(&ids).await;

    let rooms: Vec<Value> = page.rows.iter().map(|r| normalize_room(r, Some(&creators))).collect();

    json!({
        "success": true,
        "data": {
            "Results": rooms,
            "TotalResults": page.total,
            "TotalKnown": page.total_known
        }
    })
}

// ─── Room tags (the Filters rail) ─────────────────────────────────────────

/// Cached tag vocabulary: when it was derived, and the filter payload.
static TAG_CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();

/// The filter list the Rooms rail renders, in Radium's `fetch_filters` shape.
///
/// Vanilla publishes no tag or filter endpoint, but every room *detail* carries
/// a `tags` array and `rooms/search` matches tags as well as names. So the
/// vocabulary is derived: sample the popular rooms, fetch their details
/// concurrently, and rank the tags by how many of those rooms carry them.
/// Cached for [`TAG_CACHE_TTL`] so the rail costs one burst per session.
pub async fn fetch_filters() -> Value {
    if let Some(cached) = TAG_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|g| match &*g {
            Some((at, v)) if at.elapsed() < TAG_CACHE_TTL => Some(v.clone()),
            _ => None,
        })
    {
        return cached;
    }

    let value = match derive_tags().await {
        Ok(tags) => json!({
            "success": true,
            // Vanilla has no notion of a pinned tag, so everything lands in
            // PopularFilters and the rail renders it after "All Rooms".
            "data": { "PinnedFilters": [], "PopularFilters": tags }
        }),
        // An empty set is a valid answer; the rail just shows "All Rooms".
        Err(_) => json!({
            "success": true,
            "data": { "PinnedFilters": [], "PopularFilters": [] }
        }),
    };

    if let Ok(mut guard) = TAG_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some((Instant::now(), value.clone()));
    }
    value
}

async fn derive_tags() -> Result<Vec<String>, String> {
    let popular = api_get_json(&format!(
        "/api/website/rooms/popular?count={}",
        TAG_SAMPLE_ROOMS
    ))
    .await?;

    let ids: Vec<i64> = results_of(&popular)
        .iter()
        .filter_map(|r| r.get("roomId").and_then(|v| v.as_i64()))
        .take(TAG_SAMPLE_ROOMS)
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    // One round trip rather than N sequential ones.
    let details = futures_util::future::join_all(
        ids.into_iter()
            .map(|id| async move { api_get_json(&format!("/api/website/rooms/{}", id)).await }),
    )
    .await;

    let mut tally: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for room in details.into_iter().flatten() {
        if let Some(tags) = room.get("tags").and_then(|t| t.as_array()) {
            for entry in tags {
                if let Some(tag) = str_field(entry, "tag") {
                    let tag = tag.trim();
                    // A one-character tag can't be searched (see MIN_QUERY_LEN),
                    // so offering it as a filter would produce an empty page.
                    if tag.chars().count() >= MIN_QUERY_LEN {
                        *tally.entry(tag.to_string()).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    let mut ranked: Vec<(String, usize)> = tally.into_iter().collect();
    // Count first, then alphabetically so the rail doesn't reshuffle between
    // refreshes when several tags are tied.
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    Ok(ranked
        .into_iter()
        // Drop the long tail of tags only one room uses — they'd fill the rail
        // with dead ends.
        .filter(|(_, n)| *n > 1)
        .map(|(tag, _)| tag)
        .take(14)
        .collect())
}

/// Room detail by numeric id.
pub async fn fetch_room_details(room_id: &str) -> Value {
    let path = format!("/api/website/rooms/{}", room_id);
    match api_get_json(&path).await {
        Ok(d) => json!({ "success": true, "data": normalize_room(&d, None) }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Room stats by *name*, matching the scraper-backed Radium command the room
/// detail view calls. Resolves the name through search, preferring an exact
/// case-insensitive match.
pub async fn room_web_details(name: &str) -> Value {
    let name = name.trim();
    if name.chars().count() < MIN_QUERY_LEN {
        return json!({ "success": false, "error": "Room name too short to look up." });
    }

    let path = format!("/api/website/rooms/search?q={}&count=20", urlencoding(name));
    let data = match api_get_json(&path).await {
        Ok(d) => d,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let results = results_of(&data);
    let room = results
        .iter()
        .find(|r| str_field(r, "name").map(|n| n.eq_ignore_ascii_case(name)).unwrap_or(false))
        .or_else(|| results.first());

    let Some(room) = room else {
        return json!({ "success": false, "error": "Room not found." });
    };

    // Re-fetch by id so the embedded creator (and their avatar) comes back.
    let detailed = match room.get("roomId").and_then(|v| v.as_i64()) {
        Some(id) => api_get_json(&format!("/api/website/rooms/{}", id))
            .await
            .unwrap_or_else(|_| room.clone()),
        None => room.clone(),
    };

    let creator_avatar = detailed
        .get("creator")
        .and_then(|c| image_url(str_field(c, "profileImageUrl")))
        .unwrap_or_default();

    json!({
        "success": true,
        "cheers": num_field(&detailed, "cheerCount").to_string(),
        "favorites": num_field(&detailed, "favoriteCount").to_string(),
        "visits": num_field(&detailed, "visitCount").to_string(),
        "description": str_field(&detailed, "description").unwrap_or(""),
        "creatorAvatar": creator_avatar,
    })
}

// ─── People ───────────────────────────────────────────────────────────────

pub async fn fetch_people(skip: i64, take: i64, query: &str) -> Value {
    let query = query.trim();

    if !query.is_empty() && query.chars().count() < MIN_QUERY_LEN {
        return json!({
            "success": true,
            "data": { "Results": [], "TotalResults": 0 }
        });
    }

    // Searching returns one fixed page of matches; browsing walks the whole
    // roster and so pages differently. See `browse_players`.
    if query.is_empty() {
        return browse_players(skip, take).await;
    }

    let path = format!("/api/website/players/search?q={}", urlencoding(query));
    let rows = match api_get_json(&path).await {
        Ok(d) => results_of(&d),
        Err(e) => return json!({ "success": false, "error": e }),
    };

    // A search returns one fixed batch, so its size is the true total.
    let page = paginate(rows, skip, take, true);
    let people: Vec<Value> = page.rows.iter().map(normalize_person).collect();

    json!({
        "success": true,
        "data": {
            "Results": people,
            "TotalResults": page.total,
            "TotalKnown": page.total_known
        }
    })
}

/// Page through every registered Vanilla player.
///
/// There is no browse-all endpoint, but player ids are dense sequential
/// integers starting at 1 and `players?ids=` takes an explicit list, so a page
/// is just the id window `skip+1 ..= skip+take`. Ids are handed out at signup,
/// so this reads as "members in join order" — the earliest accounts first.
///
/// Only the window's own ids are requested (never 1..=skip+take), both because
/// the endpoint caps at [`PLAYERS_BATCH_CAP`] rows and because a fixed-size
/// request keeps deep pages exactly as cheap as the first.
async fn browse_players(skip: i64, take: i64) -> Value {
    let skip = skip.max(0);
    let take = take.clamp(1, PLAYERS_BATCH_CAP);

    let ids: Vec<String> = (skip + 1..=skip + take).map(|i| i.to_string()).collect();
    let path = format!("/api/website/players?ids={}", ids.join(","));

    let rows = match api_get_json(&path).await {
        Ok(d) => results_of(&d),
        Err(e) => return json!({ "success": false, "error": e }),
    };

    // Ids come back in whatever order the API chooses; sort so paging forward
    // reads continuously rather than reshuffling each page.
    let mut rows = rows;
    rows.sort_by_key(|p| p.get("id").and_then(|v| v.as_i64()).unwrap_or(i64::MAX));

    // Deleted accounts leave gaps, so a short page does not mean the end of the
    // roster — only an entirely empty one does. Report one page further than
    // we've shown until that happens, which is what keeps Next enabled. The
    // roster's real size is unknowable from here, so it is never claimed: the
    // UI shows "Page N" rather than an "of N" that would grow as you page.
    let exhausted = rows.is_empty();
    let total = if exhausted { skip } else { skip + take + 1 };

    let people: Vec<Value> = rows.iter().map(normalize_person).collect();
    json!({
        "success": true,
        "data": {
            "Results": people,
            "TotalResults": total,
            "TotalKnown": exhausted
        }
    })
}

/// Player stats by *username*, matching the scraper-backed Radium command.
pub async fn user_web_details(username: &str) -> Value {
    let username = username.trim();
    if username.chars().count() < MIN_QUERY_LEN {
        return json!({ "success": false, "error": "Username too short to look up." });
    }

    let path = format!("/api/website/players/search?q={}", urlencoding(username));
    let data = match api_get_json(&path).await {
        Ok(d) => d,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let results = results_of(&data);
    let person = results
        .iter()
        .find(|p| {
            str_field(p, "username")
                .map(|n| n.eq_ignore_ascii_case(username))
                .unwrap_or(false)
        })
        .or_else(|| results.first());

    let Some(person) = person else {
        return json!({ "success": false, "error": "Player not found." });
    };

    json!({
        "success": true,
        // Vanilla's player record carries exactly one social number,
        // `followerCount`. There is no friend count and no profile visit
        // count anywhere in its API — their own site doesn't show them either.
        // Empty (rather than a dash) tells the UI the stat doesn't exist on
        // this network, so it hides the tile instead of displaying a blank one.
        "friends": "",
        "subscribers": num_field(person, "followerCount").to_string(),
        "visits": "",
        "bio": str_field(person, "bio").unwrap_or(""),
        "banner": "",
        "avatar": image_url(str_field(person, "profileImageUrl")).unwrap_or_default(),
        "id": person.get("id").cloned().unwrap_or(Value::Null),
    })
}

pub async fn fetch_user_photos(user_id: &str, skip: i64, take: i64) -> Value {
    let path = format!("/api/website/players/{}/photos", user_id);
    match api_get_json(&path).await {
        Ok(d) => {
            // This endpoint takes no count and returns the whole set in one go.
            let page = paginate(results_of(&d), skip, take, true);
            let mut photos: Vec<Value> = page.rows.iter().map(normalize_photo).collect();
            attach_photo_creators(&mut photos).await;
            json!({ "success": true, "data": {
                "Results": photos, "TotalResults": page.total, "TotalKnown": page.total_known } })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}

pub async fn fetch_user_rooms(user_id: &str, skip: i64, take: i64) -> Value {
    let path = format!("/api/website/players/{}/rooms", user_id);
    match api_get_json(&path).await {
        Ok(d) => {
            let page = paginate(results_of(&d), skip, take, true);
            let ids: BTreeSet<i64> = page
                .rows
                .iter()
                .map(|r| num_field(r, "creatorPlayerId"))
                .filter(|id| *id != 0)
                .collect();
            let creators = resolve_creators(&ids).await;
            let rooms: Vec<Value> = page.rows.iter().map(|r| normalize_room(r, Some(&creators))).collect();
            json!({ "success": true, "data": {
                "Results": rooms, "TotalResults": page.total, "TotalKnown": page.total_known } })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Recent photo feed. Also backs the room-photos view, which filters this feed
/// by room id the same way it does for Radium.
pub async fn fetch_recent_photos(skip: i64, take: i64) -> Value {
    let count = fetch_count(skip, take);
    let path = format!("/api/website/images/recent?count={}", count);
    match api_get_json(&path).await {
        Ok(d) => {
            let rows = results_of(&d);
            let complete = (rows.len() as i64) < count;
            let page = paginate(rows, skip, take, complete);
            let mut photos: Vec<Value> = page.rows.iter().map(normalize_photo).collect();
            attach_photo_creators(&mut photos).await;
            json!({ "success": true, "data": {
                "Results": photos, "TotalResults": page.total, "TotalKnown": page.total_known } })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Percent-encode a query-string value.
///
/// Hand-rolled rather than pulling in a crate: these are search terms typed by
/// the user, and the unreserved set from RFC 3986 is all we need to keep.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_url_keeps_existing_cachebuster() {
        // Avatar URLs come back with a query already attached; rebuilding from
        // `imageName` would drop it and serve a stale image.
        assert_eq!(
            image_url(Some("/images/2_webso?1785023462696")).unwrap(),
            "https://api.vanillarec.net/images/2_webso?1785023462696"
        );
        assert_eq!(image_url(Some("")), None);
        assert_eq!(image_url(None), None);
    }

    #[test]
    fn pagination_reports_more_when_probe_row_arrives() {
        let rows: Vec<Value> = (0..13).map(|i| json!({ "n": i })).collect();
        // Page 1 of 12, with a 13th row proving there's more.
        let page = paginate(rows, 0, 12, false);
        assert_eq!(page.rows.len(), 12);
        assert_eq!(page.total, 13, "total must exceed the page so Next stays enabled");
        assert!(!page.total_known, "an estimate must not be presented as a count");
    }

    #[test]
    fn pagination_reports_exact_total_on_last_page() {
        let rows: Vec<Value> = (0..17).map(|i| json!({ "n": i })).collect();
        let page = paginate(rows, 12, 12, false);
        assert_eq!(page.rows.len(), 5);
        assert_eq!(page.total, 17, "no probe row left, so the total is now exact");
        assert!(page.total_known);
    }

    #[test]
    fn pagination_past_the_end_is_empty_not_a_panic() {
        let rows: Vec<Value> = (0..3).map(|i| json!({ "n": i })).collect();
        let page = paginate(rows, 96, 12, false);
        assert!(page.rows.is_empty());
        assert_eq!(page.total, 96);
    }

    #[test]
    fn a_complete_fetch_reports_a_real_page_count() {
        // The whole set in hand: the total is the set's size on every page, so
        // "Page 1 of 3" and "Page 2 of 3" agree instead of the total creeping up.
        let rows: Vec<Value> = (0..30).map(|i| json!({ "n": i })).collect();

        let first = paginate(rows.clone(), 0, 12, true);
        assert_eq!(first.total, 30);
        assert!(first.total_known);

        let second = paginate(rows, 12, 12, true);
        assert_eq!(second.total, 30, "the total must not move between pages");
        assert!(second.total_known);
    }

    #[test]
    fn fetch_count_covers_the_page_plus_a_probe() {
        assert_eq!(fetch_count(0, 12), 13);
        assert_eq!(fetch_count(24, 12), 37);
        assert_eq!(fetch_count(10_000, 12), MAX_FETCH_COUNT);
    }

    #[test]
    fn room_without_creator_lookup_degrades_to_unknown() {
        let room = json!({ "roomId": 5, "name": "RecCenter", "creatorPlayerId": 42 });
        let out = normalize_room(&room, None);
        assert_eq!(out["CreatorUsername"], "Unknown");
        assert_eq!(out["Name"], "RecCenter");
    }

    #[test]
    fn room_prefers_embedded_creator_over_lookup() {
        let mut map = CreatorMap::new();
        map.insert(
            42,
            CreatorInfo { username: "FromLookup".into(), avatar: String::new() },
        );
        let room = json!({
            "roomId": 5,
            "creatorPlayerId": 42,
            "creator": { "username": "Embedded", "profileImageUrl": "/images/42" }
        });
        let out = normalize_room(&room, Some(&map));
        assert_eq!(out["CreatorUsername"], "Embedded");
        assert_eq!(out["CreatorAvatarUrl"], "https://api.vanillarec.net/images/42");
    }

    #[test]
    fn person_online_state_is_unknown_not_offline() {
        // Vanilla has no presence API. Reporting `false` would render everyone
        // with an "offline" dot, which asserts something we don't know.
        let out = normalize_person(&json!({ "id": 2, "username": "Nilla" }));
        assert!(out["isOnline"].is_null());
        assert_eq!(out["userName"], "Nilla");
    }

    fn room(name: &str, cheers: i64, visits: i64, favs: i64, created: &str) -> Value {
        json!({
            "name": name, "cheerCount": cheers, "visitCount": visits,
            "favoriteCount": favs, "createdAt": created
        })
    }

    fn names(rooms: &[Value]) -> Vec<&str> {
        rooms.iter().map(|r| r["name"].as_str().unwrap()).collect()
    }

    #[test]
    fn sort_hot_is_left_in_the_api_order() {
        // Vanilla's own popularity ranking is what "Hot" means; re-ordering it
        // would replace their ranking with a worse one.
        let mut rooms = vec![
            room("A", 1, 1, 1, "2020-01-01T00:00:00Z"),
            room("B", 9, 9, 9, "2026-01-01T00:00:00Z"),
        ];
        sort_rooms(&mut rooms, 0);
        assert_eq!(names(&rooms), ["A", "B"]);
    }

    #[test]
    fn sort_orders_by_each_counter_descending() {
        let base = || {
            vec![
                room("low", 1, 300, 20, "2021-05-01T00:00:00Z"),
                room("high", 500, 2, 5, "2020-01-01T00:00:00Z"),
                room("mid", 50, 40, 900, "2026-09-01T00:00:00Z"),
            ]
        };

        let mut r = base();
        sort_rooms(&mut r, 1); // Newest
        assert_eq!(names(&r), ["mid", "low", "high"]);

        let mut r = base();
        sort_rooms(&mut r, 2); // Most Visited
        assert_eq!(names(&r), ["low", "mid", "high"]);

        let mut r = base();
        sort_rooms(&mut r, 3); // Most Cheered
        assert_eq!(names(&r), ["high", "mid", "low"]);

        let mut r = base();
        sort_rooms(&mut r, 4); // Most Favorited
        assert_eq!(names(&r), ["mid", "low", "high"]);
    }

    #[test]
    fn sort_tolerates_missing_fields() {
        // A row without the sort key must not panic or jump the queue.
        let mut rooms = vec![json!({ "name": "bare" }), room("full", 10, 10, 10, "2026-01-01T00:00:00Z")];
        sort_rooms(&mut rooms, 3);
        assert_eq!(names(&rooms), ["full", "bare"]);
    }

    #[test]
    fn photo_drops_the_upload_placeholder_caption() {
        // Almost every photo carries description "recnetupload" — the game's
        // marker for an untitled shot, not a caption anyone wrote. Rendering it
        // would put the same meaningless word under most of the feed.
        let out = normalize_photo(&json!({ "photoId": "a", "description": "recnetupload" }));
        assert_eq!(out["Description"], "");

        let real = normalize_photo(&json!({ "photoId": "b", "description": "my cool room" }));
        assert_eq!(real["Description"], "my cool room");

        let missing = normalize_photo(&json!({ "photoId": "c" }));
        assert_eq!(missing["Description"], "");
    }

    #[test]
    fn photo_carries_everyone_in_the_shot() {
        let out = normalize_photo(&json!({
            "photoId": "a",
            "sender": { "id": 2, "username": "Nilla", "displayName": "Nilla" },
            "taggedPlayers": [
                { "id": 2, "username": "Nilla", "displayName": "Nilla" },
                { "id": 63088, "username": "spidr", "displayName": "spidr" }
            ]
        }));
        let tagged = out["TaggedPlayers"].as_array().unwrap();
        assert_eq!(tagged.len(), 2);
        assert_eq!(tagged[1]["userName"], "spidr");
        assert_eq!(out["CreatorUsername"], "Nilla");
    }

    #[test]
    fn photo_comment_count_is_absent_not_zero() {
        // The card shows the Comments stat only when the network reports one.
        // Flattening "no such field" to 0 would put "0 Comments" under every
        // Vanilla photo, which reads as "nobody commented" rather than "this
        // network has no comments".
        let out = normalize_photo(&json!({ "photoId": "a" }));
        assert!(out["CommentCount"].is_null());

        let with = normalize_photo(&json!({ "photoId": "b", "commentCount": 4 }));
        assert_eq!(with["CommentCount"], 4);
    }

    #[test]
    fn photo_with_no_tags_yields_an_empty_list_not_null() {
        // The card iterates this directly, so it must always be an array.
        let out = normalize_photo(&json!({ "photoId": "a" }));
        assert!(out["TaggedPlayers"].as_array().unwrap().is_empty());
    }

    #[test]
    fn urlencoding_escapes_query_metacharacters() {
        assert_eq!(urlencoding("rec room"), "rec%20room");
        assert_eq!(urlencoding("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencoding("Nilla-1_2.3~"), "Nilla-1_2.3~");
    }
}
