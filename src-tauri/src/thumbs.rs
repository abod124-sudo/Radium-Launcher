//! Downscaled, disk-cached thumbnails for the remote images the UI shows.
//!
//! ## Why this exists
//!
//! Vanilla serves room and profile images from `/images/<name>` as the file the
//! game uploaded, at whatever size it was captured. Measured 2026-09-09, a
//! typical room image is a **2560x1440 PNG, 3.2 MB on the wire and 14 MB once
//! the webview decodes it** — to be drawn in a card about 200 px wide. A page of
//! twelve room cards is therefore ~35 MB of downloads and well over a hundred
//! megabytes of decoded bitmap, which is most of what made opening Rooms feel
//! like it was loading the entire network.
//!
//! It is also paid *every* time. Those responses carry no `Cache-Control`, no
//! `ETag` and no `Last-Modified`, and Cloudflare reports `cf-cache-status:
//! DYNAMIC`, so the webview has nothing to revalidate against and re-downloads
//! all of it on every visit to the tab.
//!
//! Radium's images come from a resizing CDN and arrive small, but they get
//! nothing off disk either.
//!
//! So: fetch once, downscale to the width the UI actually asked for, keep the
//! result on disk, and serve it over a custom URI scheme so an `<img>` can point
//! straight at it. A room card goes from ~3 MB to ~20 KB, and the second visit
//! costs a file read.
//!
//! ## Reachable from the webview
//!
//! The scheme handler takes a URL out of page content, so it is an outbound
//! request the renderer chooses. [`host_allowed`] restricts it to the image
//! hosts the two networks actually use — without that, any injected markup in
//! the webview could aim this at an arbitrary host, including one on loopback.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use crate::server::{http, USER_AGENT};

/// Hosts this may fetch from. Everything else is refused. See the module docs.
///
/// This has to cover every host either network can hand the UI an image URL
/// for, because a host missing from it fails quietly: the request is refused,
/// the `<img>` falls back, and the card shows a placeholder that looks like a
/// broken image rather than a misconfiguration. The sources are:
///
/// * `api.vanillarec.net` — Vanilla's `/images/<name>`, rooms and players both.
/// * `img.radie.app` — Radium's resizing CDN, built by `RADIUM_IMG_BASE`.
/// * `www.radie.app` / `radie.app` — Radium's website. `scraper.rs` reads
///   creator avatars and profile pictures out of its HTML and resolves them
///   against `https://www.radie.app`, so a page-relative `src` arrives on that
///   host rather than on the CDN.
/// * `api.radie.app`, `vanillarec.net`, `cdn.recroomarchive.org` — the
///   remaining hosts either API answers with.
const ALLOWED_HOSTS: &[&str] = &[
    "api.vanillarec.net",
    "vanillarec.net",
    "img.radie.app",
    "api.radie.app",
    "www.radie.app",
    "radie.app",
    "cdn.recroomarchive.org",
];

/// Widest thumbnail anyone may ask for.
///
/// The largest thing the UI renders is a feed photo, at roughly 800 CSS px, and
/// the frontend multiplies its request by the display's pixel ratio — so this
/// has to leave room for a 2x screen. A cap is still wanted, to keep a crafted
/// URL from turning the cache into a store of full-resolution originals.
const MAX_WIDTH: u32 = 2048;

/// JPEG quality for re-encoded thumbnails.
///
/// The encoder defaults to 75, which rings visibly around edges on the large
/// flat gradients that fill a screenshot of a 3-D scene. 82 is where that stops
/// being noticeable at the sizes these are drawn.
const JPEG_QUALITY: u8 = 82;

/// Refetch a cached thumbnail after this long. Room images do change — a
/// creator re-photographs their room — and nothing upstream tells us when.
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Total bytes the thumbnail directory may hold before the oldest are dropped.
const CACHE_BUDGET: u64 = 256 * 1024 * 1024;

/// How often to check the directory against [`CACHE_BUDGET`]. Walking it on
/// every miss would cost more than the pruning saves.
const PRUNE_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Timeout for pulling one original. Generous: these are multi-megabyte PNGs.
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);

/// Largest original this will pull down.
///
/// The body is buffered whole, six fetches can overlap, and each then becomes a
/// bitmap several times its encoded size, so an unbounded read is the one way a
/// single image can cost the launcher hundreds of megabytes. The biggest thing
/// either network actually serves is a 2560x1440 PNG at around 3 MB, so 24 MB
/// is a wide margin over the real traffic.
const MAX_SOURCE_BYTES: u64 = 24 * 1024 * 1024;

/// Largest source dimensions the decoder will accept.
///
/// `image`'s default `Limits` caps allocation at 512 MB but sets no bound on
/// width or height, which is what lets a tiny crafted file ask for an enormous
/// canvas. Nothing either network serves is anywhere near this.
const MAX_SOURCE_DIMENSION: u32 = 8192;

/// How many originals may be in flight at once.
///
/// Roughly what a browser allows per host. Vanilla's image endpoint is slow and
/// wildly variable — measured between 1.7 s and 30 s for a single file — so
/// some overlap is what stops a page of twelve cards filling in one at a time.
/// Each one in flight holds a multi-megabyte buffer, which is why it is capped
/// at all.
static FETCH_SLOTS: Semaphore = Semaphore::const_new(6);

/// How many images may be decoded and re-encoded at once.
///
/// This is the part that makes the *machine* stutter rather than just the
/// launcher. One 2560x1440 room PNG costs a full inflate, a resize and a JPEG
/// encode over about 14 MB of bitmap; twelve cards arriving together started
/// twelve of those at once, which is every core on a typical laptop plus a few
/// hundred megabytes of allocation churn — enough to be felt across the whole
/// desktop.
///
/// Held to a quarter of the machine so the launcher stays a background citizen
/// while it fills a grid. The work is one-off per image: once a thumbnail is on
/// disk, later views are a file read and none of this runs again.
fn decode_slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        Semaphore::new((cores / 4).clamp(1, 4))
    })
}

/// Where thumbnails live. Set once at startup from the Tauri app handle,
/// because the scheme handler is given no access to one.
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Point the cache at a directory. Called from `run()`'s setup hook.
pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = CACHE_DIR.set(dir);
}

fn cache_dir() -> Option<&'static Path> {
    CACHE_DIR.get().map(|p| p.as_path())
}

/// Whether `url` names an image host this is allowed to fetch from.
///
/// Matched against the parsed host rather than by substring: a URL like
/// `https://api.vanillarec.net.evil.test/` contains an allowed name without
/// being one.
fn host_allowed(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    url.host_str()
        .map(|h| ALLOWED_HOSTS.iter().any(|a| h.eq_ignore_ascii_case(a)))
        .unwrap_or(false)
}

/// Cache filename for one (url, width) pair, without an extension.
///
/// FNV-1a over the URL rather than a real digest: this names a cache entry, and
/// all that rides on it is that two different URLs are unlikely to collide. The
/// width stays in the clear so the same image at two sizes is plainly two
/// entries, and a directory listing is legible while debugging.
///
/// The extension is added by whichever format [`downscale`] chose, and a cache
/// lookup asks for both — see [`CACHE_FORMATS`].
fn cache_name(url: &str, width: u32) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in url.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}_{}", hash, width)
}

/// Extensions a cached thumbnail may carry, with the content type to serve it
/// as. Every one is tried on a lookup, because which a given image got depends
/// on whether it was re-encoded, and if so whether it needed an alpha channel.
const CACHE_FORMATS: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

/// Originals at or below this size are cached and served exactly as they
/// arrived, with no decode or re-encode at all.
///
/// Re-encoding a small image is pure loss. A Vanilla profile picture is a
/// 256x256 file of about 7 KB; shrinking it to the 144 px an 80 px avatar wants
/// on a 1.5x display saves perhaps three kilobytes, and spends them putting
/// JPEG artifacts into the one image people look at closely. Above this the
/// source is a multi-megabyte room screenshot, where the re-encode is the whole
/// point.
const PASSTHROUGH_MAX_BYTES: usize = 96 * 1024;

/// The format some bytes actually are, as (extension, content type).
///
/// Sniffed rather than read from the response header, because Vanilla's image
/// endpoint answers `Content-Type: image/png` for files that are plainly JPEG
/// (checked 2026-09-10 against three profile pictures, two of which began
/// `FF D8`). Serving those on the header's word would label a JPEG as a PNG.
fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    // Spelled as byte arrays rather than string escapes so the magic
    // numbers stay readable as numbers.
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF];

    if bytes.starts_with(PNG) {
        Some(("png", "image/png"))
    } else if bytes.starts_with(JPEG) {
        Some(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}

/// A cached thumbnail for `base`, if one is on disk and still fresh.
async fn cached(dir: &Path, base: &str) -> Option<(Vec<u8>, &'static str)> {
    for (ext, mime) in CACHE_FORMATS {
        let path = dir.join(format!("{}.{}", base, ext));
        if is_fresh(&path) {
            if let Ok(bytes) = tokio::fs::read(&path).await {
                return Some((bytes, mime));
            }
        }
    }
    None
}

/// Per-entry locks, so twelve cards naming the same image download it once.
static IN_FLIGHT: OnceLock<std::sync::Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
    OnceLock::new();

fn in_flight_map() -> &'static std::sync::Mutex<HashMap<String, Arc<AsyncMutex<()>>>> {
    IN_FLIGHT.get_or_init(Default::default)
}

/// A lock for one cache entry, paired with a guard that removes it again.
///
/// Handing back the bare `Arc` left the key in the map forever. Every distinct
/// (url, width) pair added one — and browsing Rooms, People and the feed mints
/// a new pair per image per size — so the map grew for the life of the process.
/// `CREATOR_CACHE` in `vanilla.rs` is bounded for exactly this reason; this one
/// was not.
fn in_flight_lock(name: &str) -> (Arc<AsyncMutex<()>>, InFlightEntry) {
    let mut map = in_flight_map().lock().unwrap_or_else(|e| e.into_inner());
    let lock = map.entry(name.to_string()).or_default().clone();
    (lock, InFlightEntry(name.to_string()))
}

/// Drops the map entry once the last waiter on it is gone.
struct InFlightEntry(String);

impl Drop for InFlightEntry {
    fn drop(&mut self) {
        let mut map = in_flight_map().lock().unwrap_or_else(|e| e.into_inner());
        // Two strong references means the map's own plus this holder's, so
        // nobody else is waiting and the entry can go. A higher count means
        // another request is queued on this exact image and still needs it.
        if map.get(&self.0).map(Arc::strong_count).unwrap_or(0) <= 2 {
            map.remove(&self.0);
        }
    }
}

fn is_fresh(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| SystemTime::now().duration_since(t).unwrap_or_default() < CACHE_TTL)
        .unwrap_or(false)
}

/// The image at `url`, no wider than `width`, with the content type to serve it
/// as.
///
/// Serves the cached file when there is a fresh one, and otherwise downloads,
/// decodes, resizes and stores it.
pub async fn thumbnail(url: &str, width: u32) -> Result<(Vec<u8>, &'static str), String> {
    let width = width.clamp(16, MAX_WIDTH);

    let parsed = reqwest::Url::parse(url).map_err(|_| "Not a URL.".to_string())?;
    if !host_allowed(&parsed) {
        return Err("Image host not allowed.".to_string());
    }

    let base = cache_name(url, width);
    let dir = cache_dir();

    if let Some(d) = dir {
        if let Some(hit) = cached(d, &base).await {
            return Ok(hit);
        }
    }

    // One downloader per entry; everyone else waits here and then re-reads the
    // file the winner wrote. `_entry` removes the map slot when the last waiter
    // on this image is done — see `InFlightEntry`.
    let (gate, _entry) = in_flight_lock(&base);
    let _held = gate.lock().await;

    if let Some(d) = dir {
        if let Some(hit) = cached(d, &base).await {
            return Ok(hit);
        }
    }

    let original = {
        let _slot = FETCH_SLOTS.acquire().await.map_err(|e| e.to_string())?;

        let response = http()
            .get(parsed.as_str())
            .timeout(FETCH_TIMEOUT)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!("HTTP error: {}", response.status()));
        }

        // Refuse an oversized body before reading it. The whole response is
        // buffered in memory, six of them can be in flight at once, and each
        // then becomes a decoded bitmap several times its size — so an image
        // host serving something enormous, by malice or by mistake, is the
        // launcher's memory problem. The declared length is only a hint, so
        // the stream below is capped too.
        if let Some(len) = response.content_length() {
            if len > MAX_SOURCE_BYTES {
                return Err(format!("Image too large: {} bytes.", len));
            }
        }

        read_capped(response, MAX_SOURCE_BYTES).await?
        // The slot is released here, before the CPU work below: waiting on a
        // core is no reason to hold a network slot a neighbouring card wants.
    };

    // Small enough to be worth keeping exactly as it is. Serving the original
    // preserves its format, its alpha and its sharpness, and skips the decode
    // entirely — see [`PASSTHROUGH_MAX_BYTES`].
    if original.len() <= PASSTHROUGH_MAX_BYTES {
        if let Some((ext, mime)) = sniff_image(&original) {
            let bytes = original.to_vec();
            if let Some(d) = dir {
                store(d.join(format!("{}.{}", base, ext)), bytes.clone());
            }
            return Ok((bytes, mime));
        }
        // Unrecognised bytes fall through to the decoder, which is the thing
        // that can say whether they are an image at all.
    }

    // Decoding a 2560x1440 PNG is the expensive part, and on an async worker it
    // would stall every other request sharing that thread. Separate from the
    // fetch limit above because the two bound different resources — see
    // [`decode_slots`].
    let (encoded, ext) = {
        let _slot = decode_slots().acquire().await.map_err(|e| e.to_string())?;
        tokio::task::spawn_blocking(move || downscale(&original, width))
            .await
            .map_err(|e| e.to_string())??
    };

    if let Some(d) = dir {
        store(d.join(format!("{}.{}", base, ext)), encoded.clone());
    }

    let mime = CACHE_FORMATS
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, mime)| *mime)
        .unwrap_or("application/octet-stream");
    Ok((encoded, mime))
}

/// Read a response body, refusing to buffer more than `max` bytes.
///
/// `Response::bytes()` reads to the end however long that is; a server can
/// under-declare `Content-Length` or omit it entirely, so the cap has to apply
/// to bytes as they arrive rather than to the header.
async fn read_capped(response: reqwest::Response, max: u64) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;

    let mut out: Vec<u8> = Vec::with_capacity(
        response.content_length().unwrap_or(0).min(max) as usize,
    );
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if out.len() as u64 + chunk.len() as u64 > max {
            return Err("Image too large.".to_string());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Decode, shrink to `width`, and re-encode. Returns the bytes and the file
/// extension the chosen format wants.
///
/// JPEG for photographs — these are screenshots of 3-D scenes, the case PNG is
/// worst at and most of why the originals run to megabytes. PNG only where the
/// image actually needs an alpha channel; see [`has_transparency`].
fn downscale(bytes: &[u8], width: u32) -> Result<(Vec<u8>, &'static str), String> {
    // Decoded through a reader with explicit limits rather than
    // `load_from_memory`, whose defaults bound allocation but not dimensions —
    // so a small file declaring an enormous canvas got as far as trying to
    // allocate for it. Refusing by dimension rejects that on the header.
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_DIMENSION);
    limits.max_image_height = Some(MAX_SOURCE_DIMENSION);

    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    reader.limits(limits);
    let img = reader.decode().map_err(|e| e.to_string())?;

    // An image already at or below the target is re-encoded but not resized —
    // Radium's CDN already serves the size we asked it for, and enlarging it
    // would spend bytes to add nothing.
    let img = if img.width() > width {
        // Lanczos3: these are 4-6x reductions, where a cheaper filter is
        // visibly soft. The resize is a small share of the cost next to
        // inflating the source PNG, so the sharper one is worth its time.
        img.resize(width, u32::MAX, FilterType::Lanczos3)
    } else {
        img
    };

    let mut out = Cursor::new(Vec::new());
    if has_transparency(&img) {
        // JPEG has no alpha channel, and flattening one turns a cut-out avatar
        // into a black square. Images that need this are small, so PNG costs
        // little here.
        img.write_to(&mut out, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        return Ok((out.into_inner(), "png"));
    }

    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode_image(&img.to_rgb8())
        .map_err(|e| e.to_string())?;
    Ok((out.into_inner(), "jpg"))
}

/// Whether an image carries alpha it actually uses.
///
/// The colour type alone is not enough: plenty of sources are RGBA with every
/// pixel opaque, and encoding those as PNG would give up the whole point of
/// re-encoding. Checked after the resize, so this scans a thumbnail rather than
/// the full-size original.
fn has_transparency(img: &DynamicImage) -> bool {
    img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < u8::MAX)
}

/// Write via a temporary file and rename, so a half-written thumbnail is never
/// visible to a concurrent reader or left behind by a crash mid-write.
///
/// Store-and-prune are both filesystem work called from an async path, so they
/// go to the blocking pool together and nothing waits on either — the bytes are
/// already in hand to return, and a cache write that loses a race costs one
/// refetch.
fn store(path: PathBuf, bytes: Vec<u8>) {
    tokio::task::spawn_blocking(move || {
        write_atomic(&path, &bytes);
        maybe_prune();
    });
}

fn write_atomic(path: &Path, bytes: &[u8]) {
    // Distinct per format, so a PNG and a JPEG under the same cache base can
    // never collide on one temp name.
    let tmp = path.with_extension(format!(
        "{}.part",
        path.extension().and_then(|e| e.to_str()).unwrap_or("bin")
    ));
    if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Drop the oldest thumbnails once the directory outgrows [`CACHE_BUDGET`].
///
/// Rate-limited, and deliberately crude: this is a cache, so evicting a little
/// too much costs one refetch.
fn maybe_prune() {
    static LAST: OnceLock<std::sync::Mutex<Option<SystemTime>>> = OnceLock::new();
    {
        let cell = LAST.get_or_init(Default::default);
        let mut last = cell.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = *last {
            if SystemTime::now().duration_since(t).unwrap_or_default() < PRUNE_INTERVAL {
                return;
            }
        }
        *last = Some(SystemTime::now());
    }

    let Some(dir) = cache_dir() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                meta.len(),
                e.path(),
            ))
        })
        .collect();

    let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
    if total <= CACHE_BUDGET {
        return;
    }

    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, len, path) in files {
        if total <= CACHE_BUDGET {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_networks_own_image_hosts_are_reachable() {
        let allowed = |u: &str| host_allowed(&reqwest::Url::parse(u).unwrap());

        assert!(allowed("https://api.vanillarec.net/images/vnlaroom_13"));
        assert!(allowed("https://img.radie.app/Room_1?width=480"));
        // scraper.rs resolves avatars it reads out of Radium's HTML against
        // `https://www.radie.app`, and those go through this proxy too. Leaving
        // the website off the list breaks every scraped avatar on Radium, and
        // does it silently.
        assert!(allowed("https://www.radie.app/_astro/avatar.png"));
        assert!(allowed("https://radie.app/_astro/avatar.png"));

        // A host that merely contains an allowed name is a different host.
        assert!(!allowed("https://api.vanillarec.net.evil.test/x.png"));
        assert!(!allowed("https://evil.test/api.vanillarec.net/x.png"));
        // And nothing off the public network at all.
        assert!(!allowed("http://127.0.0.1:8080/admin"));
        assert!(!allowed("http://localhost/x.png"));
        assert!(!allowed("file:///C:/Windows/win.ini"));
    }

    /// The whole point, measured against a real room image.
    ///
    /// Ignored by default like the other live checks in this crate — run it
    /// with `cargo test --lib -- --ignored --nocapture` when the image
    /// pipeline is in question.
    #[tokio::test]
    #[ignore = "hits api.vanillarec.net"]
    async fn a_room_card_thumbnail_is_a_fraction_of_the_original() {
        let url = "https://api.vanillarec.net/images/vnlaroom_13";

        let original = http()
            .get(url)
            .timeout(FETCH_TIMEOUT)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .expect("the image host should answer")
            .bytes()
            .await
            .expect("the body should arrive");

        let (thumb, ext) = downscale(&original, 480).expect("a room PNG should decode");
        assert_eq!(ext, "jpg", "an opaque screenshot should not come back as PNG");
        let shrunk = image::load_from_memory(&thumb).expect("the output should be a valid image");

        assert_eq!(shrunk.width(), 480, "the card asked for 480px");
        assert!(
            thumb.len() * 10 < original.len(),
            "{} bytes from {} is not worth the round trip",
            thumb.len(),
            original.len()
        );
        println!(
            "original {} bytes -> thumbnail {} bytes ({}x{}), {:.1}x smaller",
            original.len(),
            thumb.len(),
            shrunk.width(),
            shrunk.height(),
            original.len() as f64 / thumb.len() as f64
        );
    }

    /// Encode a tiny image to PNG, as a stand-in source for `downscale`.
    fn png_source(pixels: &[[u8; 4]]) -> Vec<u8> {
        let mut img = image::RgbaImage::new(pixels.len() as u32, 1);
        for (x, px) in pixels.iter().enumerate() {
            img.put_pixel(x as u32, 0, image::Rgba(*px));
        }
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut out, ImageFormat::Png)
            .expect("a 1-row PNG should encode");
        out.into_inner()
    }

    #[test]
    fn an_image_that_uses_alpha_keeps_it() {
        let src = png_source(&[[255, 0, 0, 255], [0, 0, 0, 0]]);

        let (bytes, ext) = downscale(&src, 480).expect("the source should decode");
        assert_eq!(
            ext, "png",
            "a cut-out avatar re-encoded as JPEG becomes a black square"
        );

        let out = image::load_from_memory(&bytes).expect("the output should decode");
        assert!(out.color().has_alpha());
        assert_eq!(
            out.to_rgba8().get_pixel(1, 0).0[3],
            0,
            "the transparent pixel did not survive the round trip"
        );
    }

    #[test]
    fn an_opaque_image_with_an_alpha_channel_still_becomes_a_jpeg() {
        // Plenty of sources are RGBA with every pixel opaque. Treating the
        // colour type alone as "needs alpha" would store every one of those as
        // PNG, which gives up the whole reason for re-encoding.
        let src = png_source(&[[255, 0, 0, 255], [0, 255, 0, 255]]);

        let (_, ext) = downscale(&src, 480).expect("the source should decode");
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn a_format_is_read_from_the_bytes_not_the_header() {
        // Vanilla's image endpoint answers `Content-Type: image/png` for files
        // that are plainly JPEG — checked 2026-09-10 against three profile
        // pictures, two of which began FF D8 FF. Trusting the header would
        // label those PNG.
        assert_eq!(
            sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]),
            Some(("jpg", "image/jpeg"))
        );
        assert_eq!(
            sniff_image(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]),
            Some(("png", "image/png"))
        );
        assert_eq!(sniff_image(b"GIF89a..."), Some(("gif", "image/gif")));
        assert_eq!(
            sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some(("webp", "image/webp"))
        );

        // Anything unrecognised has to fall through to the decoder rather than
        // be passed to the webview as an image on a guess.
        assert_eq!(sniff_image(b"<html>"), None);
        assert_eq!(sniff_image(b""), None);
        assert_eq!(sniff_image(b"RIFF1234WAVE"), None);
    }

    #[test]
    fn every_sniffable_format_can_be_found_in_the_cache() {
        // A passed-through original is stored under the extension sniff_image
        // gave it, and a lookup only checks the extensions in CACHE_FORMATS. A
        // format missing from that list would be written once and then never
        // found again, refetched on every single view.
        for probe in [
            &[0xFF, 0xD8, 0xFF, 0xE0][..],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..],
            b"GIF89a...",
            b"RIFF\x00\x00\x00\x00WEBPVP8 ",
        ] {
            let (ext, mime) = sniff_image(probe).expect("the probe should be recognised");
            assert!(
                CACHE_FORMATS.contains(&(ext, mime)),
                "{ext:?} is sniffed but not listed in CACHE_FORMATS"
            );
        }
    }

    #[test]
    fn the_same_image_at_two_widths_is_two_entries() {
        let url = "https://api.vanillarec.net/images/vnlaroom_13";
        assert_ne!(cache_name(url, 480), cache_name(url, 96));
        assert_eq!(cache_name(url, 480), cache_name(url, 480));
        assert_ne!(
            cache_name(url, 480),
            cache_name("https://api.vanillarec.net/images/vnlaroom_8", 480)
        );
        // A cache-buster query is part of the identity, not noise to strip.
        assert_ne!(
            cache_name(url, 480),
            cache_name(&format!("{}?1785023462696", url), 480)
        );
        // And the name has to be usable as a filename on Windows.
        assert!(cache_name(url, 480)
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.'));
    }
}
