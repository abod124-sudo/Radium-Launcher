# Radium Launcher

An unofficial custom launcher for playing on the Radium public Rec Room server. Styled to look like classic desktop apps from the early 2000s.
---

## Features

- **Retro UI Skins** — Toggle between four authentic themes: Steam 2003 Green, Windows 98 Gray, Windows XP Luna, and Windows Vista Aero — each with accurate borders, titlebars, and button styles.
- **In-App Client Download** — Downloads the game zip directly inside the launcher with live speed & ETA progress, then auto-extracts it to `%APPDATA%\radium-launcher\client`.
- **Play Modes** — Supports both Screen and VR modes, executing the correct `.bat` script from the client folder.
- **Server Status** — Checks the game API gateway and CDN on startup and every 60 seconds, with an instant refresh button.
- **Auto-Update** — On startup the launcher checks GitHub for a newer version. If one is found, a popup shows the release notes and lets you download & install it in one click.
- **Settings** — Configure the API server URL, play mode, theme, minimize-on-launch, and auto-update toggle. All saved locally.

---

## Download

Grab the latest build from the [Releases page](https://github.com/abod124-sudo/Radium-Launcher/releases/latest):

| File | Description |
|------|-------------|
| `Radium.Launcher.Setup.x.x.x.exe` | NSIS installer (recommended) |
| `Radium.Launcher.x.x.x.exe` | Portable single executable |

---

## Development Setup

Requires **Node.js** on Windows.

```bash
# Install dependencies
npm install

# Run in dev mode (opens the app)
npm run dev

# Package into installer + portable exe
npm run build
```

---

## File Locations

All client data and settings are stored locally under:

```
%APPDATA%\radium-launcher\
  ├── config.json       ← saved settings
  └── client\           ← downloaded game files
```

---

## Changelog

### v1.2.2
- Integrated Microsoft Trusted Signing configuration to fix Windows Smart App Control blocks
- Overhauled and added new Retro themes (Windows 95 Teal, Mac OS Classic, XP Royale Noir)
- Added new Modern layout themes (Modern Glass Light, Modern Neon Dark, Modern Forest Green)
- Added "Open Folder" button on the Home and Settings tabs to open the local client directory
- Simplified the Logs tab (renamed from Server Status, removed the server status grid, expanded log terminal view)

### v1.2.1
- Removed Play Mode telemetry card
- Fixed 5 bugs in `main.js`

### v1.2.0
- Redesigned home tab — removed hero banner, cleaner download/launch panels
- Added auto-update system with styled popup and one-click install
- Fixed 9 bugs (crash on close, VR launch saving wrong path, poll interval leak, and more)

### v1.1.0
- Fixed game launch failing when username contains spaces
- Fixed server status stuck on `—` at startup
- Added 60-second server status auto-refresh
- Fixed Reinstall/Uninstall button appearance

### v1.0.0
- Initial release

---
## Note

Parts of this launcher's codebase were written/co-authored with the help of AI coding assistants.
