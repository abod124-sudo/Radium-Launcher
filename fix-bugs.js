const fs = require('fs');
const path = require('path');

function replace(file, search, replaceStr) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) return console.log('File not found:', filePath);
  let content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(search)) {
    console.log(`Could not find search string in ${file}`);
    return;
  }
  content = content.replace(search, replaceStr);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed: ${file}`);
}

function replaceAll(file, search, replaceStr) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) return console.log('File not found:', filePath);
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.split(search).join(replaceStr);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed all occurrences in: ${file}`);
}

// ------------------------------------------------------------------
// RUST FIXES
// ------------------------------------------------------------------

// 1. updater.rs exit
replace('src-tauri/src/updater.rs', 'std::process::exit(0);', 'app.exit(0);');

// 2. unwrap crashes
replace('src-tauri/src/lib.rs', 
`let window = app.get_webview_window("main").unwrap();
        window.eval(&format!("window.radium.onDownloadProgress({})", &payload_str)).unwrap();`,
`if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(&format!("window.radium.onDownloadProgress({})", &payload_str));
        }`);

replace('src-tauri/src/config.rs',
`let app_data_dir = app_handle.path().app_data_dir().unwrap();`,
`let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));`);

replace('src-tauri/src/config.rs',
`let app_data_dir = app_handle.path().app_data_dir().unwrap();`,
`let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));`);

replace('src-tauri/src/download.rs',
`let app_data_dir = app.path().app_data_dir().unwrap();`,
`let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));`);

// 3. Command injection in game.rs
replace('src-tauri/src/game.rs',
`let mut start_cmd = format!("start \\"\\" \\"{}\\"", bat_path);
            if !launch_opts.is_empty() {
                start_cmd.push_str(" ");
                start_cmd.push_str(launch_opts);
            }
            cmd.arg(start_cmd);`,
`cmd.arg("start");
            cmd.arg("");
            cmd.arg(bat_path);
            if !launch_opts.is_empty() {
                for opt in launch_opts.split_whitespace() {
                    cmd.arg(opt);
                }
            }`);

// Also fix lib.rs injection validation
replace('src-tauri/src/lib.rs',
`dir.contains('"') || dir.contains(';') || dir.contains('&') || dir.contains('|') || dir.contains('\\r') || dir.contains('\\n')`,
`dir.contains('"') || dir.contains(';') || dir.contains('&') || dir.contains('|') || dir.contains('\\r') || dir.contains('\\n') || dir.contains('$') || dir.contains('%') || dir.contains('>') || dir.contains('<') || dir.contains('^') || dir.contains('\`')`);

replace('src-tauri/src/lib.rs',
`opts.contains('"') || opts.contains(';') || opts.contains('&') || opts.contains('|') || opts.contains('\\r') || opts.contains('\\n')`,
`opts.contains('"') || opts.contains(';') || opts.contains('&') || opts.contains('|') || opts.contains('\\r') || opts.contains('\\n') || opts.contains('$') || opts.contains('%') || opts.contains('>') || opts.contains('<') || opts.contains('^') || opts.contains('\`')`);

// 4. URL Injection in scraper.rs
replace('src-tauri/src/scraper.rs',
`let url = format!("https://www.radie.app/room/{}", name);`,
`let url = format!("https://www.radie.app/room/{}", urlencoding::encode(name));`);

replace('src-tauri/src/scraper.rs',
`let url = format!("https://www.radie.app/user/{}", name);`,
`let url = format!("https://www.radie.app/user/{}", urlencoding::encode(name));`);

replace('src-tauri/src/scraper.rs',
`let url = format!("https://www.radie.app/photo/{}", photo_id);`,
`let url = format!("https://www.radie.app/photo/{}", urlencoding::encode(photo_id));`);

// 5. SSRF in server.rs
replace('src-tauri/src/server.rs',
`pub async fn ping_server(url: String) -> Value {`,
`pub async fn ping_server(url: String) -> Value {
    if !url.starts_with("https://api.radie.app") && !url.starts_with("https://www.radie.app") {
        return serde_json::json!({"error": "Invalid URL"});
    }`);

// 6. Bug report race condition
replace('src-tauri/src/lib.rs',
`let last_time = LAST_SUBMISSION_TIME.load(Ordering::Relaxed);`,
`let last_time = LAST_SUBMISSION_TIME.load(Ordering::SeqCst);`);

replace('src-tauri/src/lib.rs',
`LAST_SUBMISSION_TIME.store(now, Ordering::Relaxed);`,
`LAST_SUBMISSION_TIME.store(now, Ordering::SeqCst);`);

// 7. Config migration only runs once
replace('src-tauri/src/config.rs',
`fn migrate_legacy_data(app_handle: &tauri::AppHandle) {`,
`static MIGRATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn migrate_legacy_data(app_handle: &tauri::AppHandle) {
    if MIGRATED.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }`);

// 8. close_on_launch implementation
replace('src-tauri/src/game.rs',
`            if cfg.minimizeOnLaunch {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }`,
`            if cfg.minimizeOnLaunch {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }
            if cfg.close_on_launch {
                app.exit(0);
            }`);

// 10. Game monitor graceful shutdown
replace('src-tauri/src/game.rs',
`        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let running = check_game_running();`,
`        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if app.get_webview_window("main").is_none() { break; }
            let running = check_game_running();`);

// ------------------------------------------------------------------
// FRONTEND FIXES (app.js)
// ------------------------------------------------------------------

// Null checks
replace('src/app.js',
`$('updateModal').style.display = 'flex';`,
`const m = $('updateModal'); if (m) m.style.display = 'flex';`);

replace('src/app.js',
`$('updateModal').style.display = 'none';`,
`const m = $('updateModal'); if (m) m.style.display = 'none';`);

replace('src/app.js',
`$('logoFallback').style.display = 'flex';`,
`const lf = $('logoFallback'); if (lf) lf.style.display = 'flex';`);

replace('src/app.js',
`  $('downloadSection').style.display = 'none';
  $('launchPanel').style.display = 'flex';`,
`  const ds = $('downloadSection'); if (ds) ds.style.display = 'none';
  const lp = $('launchPanel'); if (lp) lp.style.display = 'flex';`);

replace('src/app.js',
`  $('downloadSection').style.display = 'flex';
  $('launchPanel').style.display = 'none';`,
`  const ds = $('downloadSection'); if (ds) ds.style.display = 'flex';
  const lp = $('launchPanel'); if (lp) lp.style.display = 'none';`);

replace('src/app.js',
`  $('downloadSection').style.display = 'flex';
  $('launchPanel').style.display = 'none';`, // Second occurrence
`  const ds = $('downloadSection'); if (ds) ds.style.display = 'flex';
  const lp = $('launchPanel'); if (lp) lp.style.display = 'none';`);

// Room photos field name
replace('src/app.js',
`loadRoomPhotos(room.RoomId);`,
`loadRoomPhotos(room.RoomId || room.roomId);`);

// roomsDetailImage onload
replace('src/app.js',
`      imgEl.src = imgName ? \`https://img.radie.app/\${imgName}?width=480\` : './images.png';
      imgEl.onerror = () => { imgEl.src = './images.png'; imgEl.classList.remove('image-loading-placeholder'); };`,
`      imgEl.src = imgName ? \`https://img.radie.app/\${imgName}?width=480\` : './images.png';
      imgEl.onload = () => imgEl.classList.remove('image-loading-placeholder');
      imgEl.onerror = () => { imgEl.src = './images.png'; imgEl.classList.remove('image-loading-placeholder'); };`);

// submitBugReport optional chaining
replace('src/app.js',
`window.radium.submitBugReport(type, description, state)`,
`window.radium?.submitBugReport(type, description, state)`);

// Hardcoded install dir
replace('src/app.js',
`addLog(\`Install dir: %APPDATA%\\\\com.radium.launcher\\\\client\`, 'info');`,
`addLog(\`Install dir: \${config?.installDir || '%APPDATA%\\\\com.radium.launcher\\\\client'}\`, 'info');`);

// Log buffer growth
replace('src/app.js',
`  fullLogBuffer.push({ timestamp: new Date().toLocaleTimeString(), msg, type });`,
`  fullLogBuffer.push({ timestamp: new Date().toLocaleTimeString(), msg, type });
  if (fullLogBuffer.length > 10000) fullLogBuffer.shift();`);

// Apply theme reset
replace('src/app.js',
`  document.body.className = '';`,
`  document.body.className = document.body.className.split(' ').filter(c => c === 'animations-enabled').join(' ');`);

// ------------------------------------------------------------------
// INDEX.HTML FIXES
// ------------------------------------------------------------------
replaceAll('src/index.html', `src=""`, `src="data:,"`);

// ------------------------------------------------------------------
// VERSION BUMP
// ------------------------------------------------------------------
replace('package.json', `"version": "2.0.0"`, `"version": "2.5.0"`);
replace('src-tauri/tauri.conf.json', `"version": "2.0.1"`, `"version": "2.5.0"`);
replace('src-tauri/Cargo.toml', `version = "2.0.1"`, `version = "2.5.0"`);
replace('src-tauri/installer.nsi', `!define VERSION "2.0.1"`, `!define VERSION "2.5.0"`);

console.log("All replacements finished.");
