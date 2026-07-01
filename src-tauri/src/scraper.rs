use regex::Regex;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Helper: unescape common HTML entities
// ---------------------------------------------------------------------------
pub(crate) fn unescape_html(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&#x2F;", "/")
        .replace("&nbsp;", " ")
}

// ---------------------------------------------------------------------------
// Helper: resolve a possibly-relative URL against a base
// ---------------------------------------------------------------------------
fn resolve_url(url: &str, base: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    let base = base.trim_end_matches('/');
    if url.starts_with('/') {
        format!("{}{}", base, url)
    } else {
        format!("{}/{}", base, url)
    }
}

// ---------------------------------------------------------------------------
// Helper: perform an HTTP GET and return the body as text
// ---------------------------------------------------------------------------
async fn http_get_text(url: &str) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .header("User-Agent", "RadiumLauncher/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    response.text().await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Helper: extract the first capture group from a regex match
// ---------------------------------------------------------------------------
fn first_capture(pattern: &str, text: &str) -> Option<String> {
    Regex::new(pattern)
        .ok()
        .and_then(|re| re.captures(text))
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
}

// ---------------------------------------------------------------------------
// 1. fetch_room_web_details
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn fetch_room_web_details(name: String) -> Value {
    let safe_name = name.replace('/', "%2F").replace('?', "%3F").replace('#', "%23").replace('&', "%26").replace('=', "%3D");
    let url = format!("https://www.radie.app/room/{}", safe_name);

    let html = match http_get_text(&url).await {
        Ok(h) => h,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let base = "https://www.radie.app";

    // Stat pattern shared by cheers / favorites / visits
    let stat_pattern = |label: &str| -> String {
        format!(
            r#"<p class="font-bold text-\[14px\]!"[^>]*>([\d,]+)</p>\s*<p class="text-\[10px\]">{}</p>"#,
            label
        )
    };

    let cheers = first_capture(&stat_pattern("CHEERS"), &html)
        .map(|v| unescape_html(&v))
        .unwrap_or_default();

    let favorites = first_capture(&stat_pattern("FAVORITES"), &html)
        .map(|v| unescape_html(&v))
        .unwrap_or_default();

    let visits = first_capture(&stat_pattern("VISITS"), &html)
        .map(|v| unescape_html(&v))
        .unwrap_or_default();

    let description_pattern =
        r#"</a>\s*<p>([\s\S]*?)</p>\s*<div class="flex border-\[#ccc\] border-t"#;
    let description = first_capture(description_pattern, &html)
        .map(|v| unescape_html(v.trim()))
        .unwrap_or_default();

    let avatar_pattern = r#"href="/user/[^"]+"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)""#;
    let creator_avatar = first_capture(avatar_pattern, &html)
        .map(|v| resolve_url(&unescape_html(&v), base))
        .unwrap_or_default();

    json!({
        "success": true,
        "cheers": cheers,
        "favorites": favorites,
        "visits": visits,
        "description": description,
        "creatorAvatar": creator_avatar,
    })
}

// ---------------------------------------------------------------------------
// 2. fetch_user_web_details
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn fetch_user_web_details(name: String) -> Value {
    let safe_name = name.replace('/', "%2F").replace('?', "%3F").replace('#', "%23").replace('&', "%26").replace('=', "%3D");
    let url = format!("https://www.radie.app/user/{}", safe_name);

    let html = match http_get_text(&url).await {
        Ok(h) => h,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let base = "https://www.radie.app";

    let stat_pattern = |label: &str| -> String {
        format!(
            r#"<p class="font-bold text-\[14px\]!"[^>]*>([\d,]+)</p>\s*<p class="text-\[10px\]">{}</p>"#,
            label
        )
    };

    let friends = first_capture(&stat_pattern("FRIENDS"), &html)
        .map(|v| unescape_html(&v))
        .unwrap_or_default();

    let subscribers = first_capture(&stat_pattern("SUBSCRIBERS"), &html)
        .map(|v| unescape_html(&v))
        .unwrap_or_default();

    let visits = first_capture(&stat_pattern("VISITS"), &html)
        .map(|v| unescape_html(&v))
        .unwrap_or_default();

    // Status – extract user status from the profile card element
    let status_raw = first_capture(
        r#"<p[^>]*class="[^"]*text-\[#ccc\][^"]*text-\[10px\][^"]*"[^>]*>([\s\S]*?)</p>"#,
        &html,
    )
    .unwrap_or_default();

    let status_inner = if status_raw.contains("<a") {
        first_capture(r#">([^<]+)</a>"#, &status_raw).unwrap_or(status_raw)
    } else {
        status_raw
    };

    let status_clean = status_inner
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_uppercase();

    let status = if status_clean == "^" {
        "ONLINE".to_string()
    } else {
        status_clean
    };

    let bio_pattern = r#"<p class="whitespace-pre-wrap text-\[12px\]">([\s\S]*?)</p>"#;
    let bio = first_capture(bio_pattern, &html)
        .map(|v| unescape_html(v.trim()))
        .unwrap_or_default();

    let banner_pattern = r#"background-image:\s*url\(['"]?([^'"\)]+)['"]?\)"#;
    let banner = first_capture(banner_pattern, &html)
        .map(|v| resolve_url(&unescape_html(&v), base))
        .unwrap_or_default();

    // Try scraping avatar from og:image meta tag first, then fallback to img tags containing w-18.75 class
    let avatar = if let Some(og_img) = first_capture(r#"<meta[^>]*property="og:image"[^>]*content="([^"]+)""#, &html) {
        resolve_url(&unescape_html(&og_img), base)
    } else if let Some(og_img_alt) = first_capture(r#"<meta[^>]*content="([^"]+)"[^>]*property="og:image""#, &html) {
        resolve_url(&unescape_html(&og_img_alt), base)
    } else if let Some(img_src) = first_capture(r#"<img[^>]*class="[^"]*w-18\.75[^"]*"[^>]*src="([^"]+)""#, &html) {
        resolve_url(&unescape_html(&img_src), base)
    } else if let Some(img_src_alt) = first_capture(r#"<img[^>]*src="([^"]+)"[^>]*class="[^"]*w-18\.75"#, &html) {
        resolve_url(&unescape_html(&img_src_alt), base)
    } else {
        first_capture(r#"w-18\.75[\s\S]*?<img[^>]*src="([^"]+)""#, &html)
            .map(|v| resolve_url(&unescape_html(&v), base))
            .unwrap_or_default()
    };


    json!({
        "success": true,
        "friends": friends,
        "subscribers": subscribers,
        "visits": visits,
        "status": status,
        "bio": bio,
        "banner": banner,
        "avatar": avatar,
    })
}

// ---------------------------------------------------------------------------
// 3. fetch_photo_web_details
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn fetch_photo_web_details(photo_id: String) -> Value {
    let safe_photo_id = photo_id.replace('/', "%2F").replace('?', "%3F").replace('#', "%23").replace('&', "%26").replace('=', "%3D");
    let url = format!("https://www.radie.app/photo/{}", safe_photo_id);

    let html = match http_get_text(&url).await {
        Ok(h) => h,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let creator_pattern = r#"href="/user/([^"\s?]+)""#;
    let creator_username = first_capture(creator_pattern, &html).unwrap_or_default();

    let room_pattern = r#"href="/room/([^"\s?]+)""#;
    let room_name = first_capture(room_pattern, &html).unwrap_or_default();

    json!({
        "success": true,
        "creatorUsername": creator_username,
        "roomName": room_name,
    })
}

// ---------------------------------------------------------------------------
// 4. fetch_photo_comments
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn fetch_photo_comments(photo_id: String) -> Value {
    let urls = vec![
        format!(
            "https://launcher.radie.app/api/photos/v1/{}/comments?skip=0&take=20",
            photo_id
        ),
        format!(
            "https://launcher.radie.app/api/comments/v1?photoId={}&skip=0&take=20",
            photo_id
        ),
        format!(
            "https://api.radie.app/api/photos/v1/{}/comments?skip=0&take=20",
            photo_id
        ),
    ];

    for url in &urls {
        let body = match http_get_text(url).await {
            Ok(b) => b,
            Err(_) => continue,
        };

        let parsed: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // If the response is directly an array, use it.
        if parsed.is_array() {
            return json!({ "success": true, "comments": parsed });
        }

        // Check for a "Results" field
        if let Some(results) = parsed.get("Results") {
            if results.is_array() {
                return json!({ "success": true, "comments": results });
            }
        }

        // Check for a "comments" field
        if let Some(comments) = parsed.get("comments") {
            if comments.is_array() {
                return json!({ "success": true, "comments": comments });
            }
        }
    }

    json!({
        "success": false,
        "error": "All comment API endpoints failed or returned unexpected data",
        "comments": [],
    })
}
