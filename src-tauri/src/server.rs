use reqwest::Client;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const USER_AGENT: &str = "Radium-Launcher";

/// Shared GET helper with User-Agent header and 10s timeout.
async fn http_get_json(url: &str) -> Result<Value, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(url)
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
    if !url.starts_with("https://api.radie.app") && !url.starts_with("https://www.radie.app") {
        return serde_json::json!({"error": "Invalid URL"});
    }
    // SSRF protection: only allow trusted Radie domains
    if !url.starts_with("https://api.radie.app") && !url.starts_with("https://www.radie.app") && !url.starts_with("https://launcher.radie.app") {
        return json!({ "online": false, "latency": -1, "error": "Untrusted URL. Only radie.app domains are allowed." });
    }

    let client = match Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return json!({ "online": false, "latency": -1 }),
    };

    // For Radium API domains, hit /health; otherwise hit /
    let ping_url = if url.contains("radie") || url.contains("radium") {
        format!("{}/health", url.trim_end_matches('/'))
    } else {
        format!("{}/", url.trim_end_matches('/'))
    };

    let start = Instant::now();

    match client.get(&ping_url).send().await {
        Ok(resp) => {
            let latency = start.elapsed().as_millis() as i64;
            let status = resp.status().as_u16();
            json!({
                "online": true,
                "latency": latency,
                "status": status,
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
    let client = match Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "success": false, "error": e.to_string() }),
    };

    let url = "https://api.radie.app/api/players/v1/online";

    match client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
    {
        Ok(resp) => match resp.json::<Value>().await {
            Ok(data) => {
                let count = data.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                json!({ "success": true, "count": count })
            }
            Err(e) => json!({ "success": false, "error": e.to_string() }),
        },
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
        Some(v) if v.is_number() => v.as_i64().unwrap().to_string(),
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
        Some(v) if v.is_number() => v.as_i64().unwrap().to_string(),
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
        Some(v) if v.is_number() => v.as_i64().unwrap().to_string(),
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
