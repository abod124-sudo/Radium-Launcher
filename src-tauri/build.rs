use std::path::PathBuf;

fn main() {
    // Stella sign-in loads the Steamworks SDK (stella_api.rs), whose
    // steam_api64.dll must sit next to the launcher executable at runtime. The
    // bundler ships it to the install directory via `bundle.resources`; for a
    // dev/`cargo` build, copy it beside the built exe so sign-in works there too
    // (and survives `cargo clean`, unlike a one-off manual copy).
    #[cfg(target_os = "windows")]
    {
        if let Ok(out_dir) = std::env::var("OUT_DIR") {
            // OUT_DIR is target/<profile>/build/<pkg>-<hash>/out; the exe lives
            // at target/<profile>/, three levels up.
            let exe_dir = PathBuf::from(&out_dir)
                .ancestors()
                .nth(3)
                .map(|p| p.to_path_buf());
            let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("steam_api64.dll");
            if let (Some(dir), true) = (exe_dir, src.exists()) {
                let dst = dir.join("steam_api64.dll");
                let _ = std::fs::copy(&src, &dst);
            }
            println!("cargo:rerun-if-changed=steam_api64.dll");
        }
    }

    tauri_build::build()
}
