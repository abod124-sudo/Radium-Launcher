const fs = require('fs');
const path = require('path');

function replaceRegex(file, searchRegex, replaceStr) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) return console.log('File not found:', filePath);
  let content = fs.readFileSync(filePath, 'utf8');
  if (!searchRegex.test(content)) {
    console.log(`Could not find regex in ${file}`);
    return;
  }
  content = content.replace(searchRegex, replaceStr);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed regex in: ${file}`);
}

// 1. updater.rs exit
replaceRegex('src-tauri/src/updater.rs', /std::process::exit\(0\);/g, 'app.exit(0);');

// 2. unwrap crashes
replaceRegex('src-tauri/src/lib.rs', 
/let window = app\.get_webview_window\("main"\)\.unwrap\(\);\s*window\.eval\(&format!\("window\.radium\.onDownloadProgress\(\{\}\)", &payload_str\)\)\.unwrap\(\);/g,
`if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(&format!("window.radium.onDownloadProgress({})", &payload_str));
        }`);

replaceRegex('src-tauri/src/config.rs', /let app_data_dir = app_handle\.path\(\)\.app_data_dir\(\)\.unwrap\(\);/g, `let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));`);

replaceRegex('src-tauri/src/download.rs', /let app_data_dir = app\.path\(\)\.app_data_dir\(\)\.unwrap\(\);/g, `let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));`);

// 3. Command injection in game.rs
replaceRegex('src-tauri/src/game.rs', 
/let mut start_cmd = format!\("start \\"\\" \\"\{\}\\"", bat_path\);\s*if !launch_opts\.is_empty\(\) \{\s*start_cmd\.push_str\(" "\);\s*start_cmd\.push_str\(launch_opts\);\s*\}\s*cmd\.arg\(start_cmd\);/g,
`cmd.arg("start");
            cmd.arg("");
            cmd.arg(bat_path);
            if !launch_opts.is_empty() {
                for opt in launch_opts.split_whitespace() {
                    cmd.arg(opt);
                }
            }`);

// 4. URL Injection in scraper.rs
replaceRegex('src-tauri/src/scraper.rs', /format!\("https:\/\/www\.radie\.app\/room\/\{\}", name\)/g, `format!("https://www.radie.app/room/{}", urlencoding::encode(name))`);
replaceRegex('src-tauri/src/scraper.rs', /format!\("https:\/\/www\.radie\.app\/user\/\{\}", name\)/g, `format!("https://www.radie.app/user/{}", urlencoding::encode(name))`);
replaceRegex('src-tauri/src/scraper.rs', /format!\("https:\/\/www\.radie\.app\/photo\/\{\}", photo_id\)/g, `format!("https://www.radie.app/photo/{}", urlencoding::encode(photo_id))`);

// 6. Bug report race condition
replaceRegex('src-tauri/src/lib.rs', /LAST_SUBMISSION_TIME\.load\(Ordering::Relaxed\)/g, `LAST_SUBMISSION_TIME.load(Ordering::SeqCst)`);
replaceRegex('src-tauri/src/lib.rs', /LAST_SUBMISSION_TIME\.store\(now, Ordering::Relaxed\)/g, `LAST_SUBMISSION_TIME.store(now, Ordering::SeqCst)`);

// 8. close_on_launch implementation
replaceRegex('src-tauri/src/game.rs', 
/if cfg\.minimizeOnLaunch \{\s*if let Some\(window\) = app\.get_webview_window\("main"\) \{\s*let _ = window\.minimize\(\);\s*\}\s*\}/g,
`if cfg.minimizeOnLaunch {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.minimize();
                }
            }
            if cfg.close_on_launch {
                app.exit(0);
            }`);

// 10. Game monitor graceful shutdown
replaceRegex('src-tauri/src/game.rs', 
/tokio::time::sleep\(std::time::Duration::from_secs\(2\)\)\.await;\s*let running = check_game_running\(\);/g,
`tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if app.get_webview_window("main").is_none() { break; }
            let running = check_game_running();`);

// Cargo.toml Version bump
replaceRegex('src-tauri/Cargo.toml', /version = "2\.0\.1"/g, `version = "2.5.0"`);

// FRONTEND
replaceRegex('src/app.js', /\$\('downloadSection'\)\.style\.display = 'none';\s*\$\('launchPanel'\)\.style\.display = 'flex';/g, `const ds = $('downloadSection'); if (ds) ds.style.display = 'none'; const lp = $('launchPanel'); if (lp) lp.style.display = 'flex';`);

replaceRegex('src/app.js', /\$\('downloadSection'\)\.style\.display = 'flex';\s*\$\('launchPanel'\)\.style\.display = 'none';/g, `const ds = $('downloadSection'); if (ds) ds.style.display = 'flex'; const lp = $('launchPanel'); if (lp) lp.style.display = 'none';`);

replaceRegex('src/app.js', /imgEl\.src = imgName \? `https:\/\/img\.radie\.app\/\$\{imgName\}\?width=480` : '\.\/images\.png';\s*imgEl\.onerror = \(\) => \{ imgEl\.src = '\.\/images\.png'; imgEl\.classList\.remove\('image-loading-placeholder'\); \};/g, `imgEl.src = imgName ? \`https://img.radie.app/\${imgName}?width=480\` : './images.png'; imgEl.onload = () => imgEl.classList.remove('image-loading-placeholder'); imgEl.onerror = () => { imgEl.src = './images.png'; imgEl.classList.remove('image-loading-placeholder'); };`);

replaceRegex('src/app.js', /window\.radium\.submitBugReport\(type, description, state\)/g, `window.radium?.submitBugReport(type, description, state)`);

console.log("Regex replacements finished.");
