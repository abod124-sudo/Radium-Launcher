# Radium Launcher

An **unofficial** launcher for Rec Room revival servers.

| Server | Site |
| :--- | :--- |
| **Radium** | [radie.app](https://www.radie.app/) |
| **Vanilla** | [vanillarec.net](https://vanillarec.net/) |

## Showcase

### Steam 2003 Green Theme
| Home Tab | Rooms Tab | People Tab |
| :---: | :---: | :---: |
| ![Home Tab (Steam Green)](https://i.imgur.com/6rAgFPd.png) | ![Rooms Tab (Steam Green)](https://i.imgur.com/UX5nNZT.png) | ![People Tab (Steam Green)](https://i.imgur.com/4wjGRxC.png) |

### Windows 7 Aero Theme
| Home Tab | Rooms Tab | People Tab |
| :---: | :---: | :---: |
| ![Home Tab (Windows 7)](https://i.imgur.com/rgGrBw4.png) | ![Rooms Tab (Windows 7)](https://i.imgur.com/scr44Ma.png) | ![People Tab (Windows 7)](https://i.imgur.com/eae8aEU.png) |

---

## Features

- **Switch servers** — Swap between Radium and Vanilla from the sidebar. Each keeps
  its own client install, so both can be installed at once.
- **Browse** — Rooms with search, tag filters and sorting; player profiles with photos
  and rooms; and a live feed of what players are doing right now.
- **Client management** — Downloads and extracts the game client in-app with live speed
  and ETA, resumes interrupted downloads, detects outdated installs, and launches the
  game.
- **16 themes** — Rec Room, Steam 2003 Green, Windows 98 / XP / 7 Aero, Mac OS X Aqua,
  Modern Dark and more — or build your own, including a **Liquid Glass** effect.
- **Diagnostics** — Server status on startup, a built-in bug reporter that bundles logs
  and system info, and third-party antivirus detection.
- **Stays current** — Checks GitHub for launcher updates on startup, and saves every
  setting the moment you change it.

---

## Download

**Update 4.0.0 is coming soon.** The link below goes live the moment it's published —
until then, grab the current build from the [Releases page](https://github.com/abod124-sudo/Radium-Launcher/releases/latest).

| File | Description |
|------|-------------|
| [Radium.Launcher_4.0.0_x64-setup.exe](https://github.com/abod124-sudo/Radium-Launcher/releases/download/v4.0.0/Radium.Launcher_4.0.0_x64-setup.exe) | NSIS installer for Windows x64 |



## File Locations

```
%APPDATA%\com.radium.launcher\
  ├── config.json         - saved settings
  ├── client\             - Radium game files
  └── client-vanilla\     - Vanilla game files
```

Uninstalling one server never touches the other.

---

## Building from source

Requires the [Rust toolchain](https://rustup.rs/) and Node.js.

```bash
npm install
npm run dev     # run the launcher
npm run build   # produce the installer
cd src-tauri && cargo test
```

---

## Note

Parts of this launcher's codebase were written/co-authored with the help of AI coding assistants.
