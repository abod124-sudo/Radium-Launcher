use reqwest::Client;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const USER_AGENT: &str = "Radium-Launcher";

/// Process-wide reqwest client (connection pool reuse). Timeouts are applied
/// per-request via `.timeout()` since callers want different limits.
fn http() -> &'static Client {
    static HTTP: OnceLock<Client> = OnceLock::new();
    HTTP.get_or_init(|| Client::builder().build().unwrap_or_else(|_| Client::new()))
}

/// Shared GET helper with User-Agent header and 10s timeout.
async fn http_get_json(url: &str) -> Result<Value, String> {
    let response = http()
        .get(url)
        .timeout(Duration::from_secs(10))
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP error: {}", status));
    }

    response.json::<Value>().await.map_err(|e| e.to_string())
}

/// Ping a server and return its online status, latency, and HTTP status code.
#[tauri::command]
pub async fn ping_server(url: String) -> Value {
    let parsed = match reqwest::Url::parse(&url) {
        Ok(u) => u,
        Err(_) => return json!({"error": "Invalid URL format"}),
    };
    let host = parsed.host_str().unwrap_or("");
    let is_cdn = host == "cdn.recroomarchive.org";
    if host != "api.radie.app"
        && host != "www.radie.app"
        && host != "launcher.radie.app"
        && !is_cdn
    {
        return json!({ "online": false, "latency": -1, "error": "Untrusted URL." });
    }

    // The radie.app API exposes a `/health` endpoint; the recroomarchive CDN does
    // not, so ping its root instead and treat any HTTP response as reachable.
    let ping_url = if is_cdn {
        url.trim_end_matches('/').to_string()
    } else {
        format!("{}/health", url.trim_end_matches('/'))
    };

    let start = Instant::now();

    match http().get(&ping_url).timeout(Duration::from_secs(5)).send().await {
        Ok(resp) => {
            let latency = start.elapsed().as_millis() as i64;
            let status = resp.status();
            // For the API a successful /health response means online; for the CDN
            // any response at all means the host is reachable.
            let online = if is_cdn { true } else { status.is_success() };
            json!({
                "online": online,
                "latency": latency,
                "status": status.as_u16(),
            })
        }
        Err(_) => {
            json!({
                "online": false,
                "latency": -1,
            })
        }
    }
}

/// Get the current online player count from the Radium API.
#[tauri::command]
pub async fn get_player_count() -> Value {
    let url = "https://api.radie.app/api/players/v1/online";

    match http()
        .get(url)
        .timeout(Duration::from_secs(60))
        .header("User-Agent", USER_AGENT)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                return json!({ "success": false, "error": format!("HTTP error: {}", status) });
            }
            match resp.json::<Value>().await {
                Ok(data) => {
                    let count = data.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                    json!({ "success": true, "count": count })
                }
                Err(e) => json!({ "success": false, "error": e.to_string() }),
            }
        }
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

/// Fetch a paginated list of rooms with optional search query and tag filter.
#[tauri::command]
pub async fn fetch_rooms(args: Value) -> Value {
    let skip = args.get("skip").and_then(|v| v.as_i64()).unwrap_or(0);
    let take = args.get("take").and_then(|v| v.as_i64()).unwrap_or(20);
    let sort_by = args.get("sortBy").and_then(|v| v.as_i64()).unwrap_or(0);
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tag = args
        .get("tag")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut url = match reqwest::Url::parse("https://launcher.radie.app/api/rooms/v1/") {
        Ok(u) => u,
        Err(e) => return json!({ "success": false, "error": e.to_string() }),
    };

    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair("skip", &skip.to_string());
        query_pairs.append_pair("take", &take.to_string());
        query_pairs.append_pair("sortBy", &sort_by.to_string());
        if !query.is_empty() {
            query_pairs.append_pair("query", &query);
        }
        if !tag.is_empty() {
            query_pairs.append_pair("tag", &tag);
        }
    }

    match http_get_json(url.as_str()).await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Fetch a paginated list of people with optional search query.
#[tauri::command]
pub async fn fetch_people(args: Value) -> Value {
    let skip = args.get("skip").and_then(|v| v.as_i64()).unwrap_or(0);
    let take = args.get("take").and_then(|v| v.as_i64()).unwrap_or(15);
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut url = match reqwest::Url::parse("https://launcher.radie.app/api/user/v1") {
        Ok(u) => u,
        Err(e) => return json!({ "success": false, "error": e.to_string() }),
    };

    {
        let mut query_pairs = url.query_pairs_mut();
        query_pairs.append_pair("skip", &skip.to_string());
        query_pairs.append_pair("take", &take.to_string());
        if !query.is_empty() {
            query_pairs.append_pair("query", &query);
        }
    }

    match http_get_json(url.as_str()).await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Fetch available room filters (tags / categories).
#[tauri::command]
pub async fn fetch_filters() -> Value {
    let url = "https://api.radie.app/api/rooms/v1/filters";

    match http_get_json(url).await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Fetch photos for a specific user.
#[tauri::command]
pub async fn fetch_user_photos(args: Value) -> Value {
    let user_id = match args.get("userId") {
        // v.to_string() renders any JSON number verbatim — as_i64().unwrap()
        // would panic on a non-integer (e.g. float) userId.
        Some(v) if v.is_number() => v.to_string(),
        Some(v) if v.is_string() => v.as_str().unwrap().to_string(),
        _ => return json!({ "success": false, "error": "userId is required" }),
    };
    let skip = args.get("skip").and_then(|v| v.as_i64()).unwrap_or(0);
    let take = args.get("take").and_then(|v| v.as_i64()).unwrap_or(40);

    let url = format!(
        "https://launcher.radie.app/api/user/v1/{}/photos?skip={}&take={}",
        user_id, skip, take
    );

    match http_get_json(&url).await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Fetch rooms for a specific user.
#[tauri::command]
pub async fn fetch_user_rooms(args: Value) -> Value {
    let user_id = match args.get("userId") {
        // v.to_string() renders any JSON number verbatim — as_i64().unwrap()
        // would panic on a non-integer (e.g. float) userId.
        Some(v) if v.is_number() => v.to_string(),
        Some(v) if v.is_string() => v.as_str().unwrap().to_string(),
        _ => return json!({ "success": false, "error": "userId is required" }),
    };
    let skip = args.get("skip").and_then(|v| v.as_i64()).unwrap_or(0);
    let take = args.get("take").and_then(|v| v.as_i64()).unwrap_or(20);

    let url = format!(
        "https://launcher.radie.app/api/user/v1/{}/rooms?skip={}&take={}",
        user_id, skip, take
    );

    match http_get_json(&url).await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Fetch the feed for a specific user.
#[tauri::command]
pub async fn fetch_user_feed(args: Value) -> Value {
    let user_id = match args.get("userId") {
        // v.to_string() renders any JSON number verbatim — as_i64().unwrap()
        // would panic on a non-integer (e.g. float) userId.
        Some(v) if v.is_number() => v.to_string(),
        Some(v) if v.is_string() => v.as_str().unwrap().to_string(),
        _ => return json!({ "success": false, "error": "userId is required" }),
    };
    let skip = args.get("skip").and_then(|v| v.as_i64()).unwrap_or(0);
    let take = args.get("take").and_then(|v| v.as_i64()).unwrap_or(40);

    let url = format!(
        "https://launcher.radie.app/api/user/v1/{}/feed?skip={}&take={}",
        user_id, skip, take
    );

    match http_get_json(&url).await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Fetch the recent photo feed.
#[tauri::command]
pub async fn fetch_recent_photos(args: Value) -> Value {
    let skip = args.get("skip").and_then(|v| v.as_i64()).unwrap_or(0);
    let take = args.get("take").and_then(|v| v.as_i64()).unwrap_or(100);

    let url = format!(
        "https://launcher.radie.app/api/photos/v1/feed?skip={}&take={}",
        skip, take
    );

    match http_get_json(&url).await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}
