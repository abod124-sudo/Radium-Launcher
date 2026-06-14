# Radium Launcher

An **unofficial** custom launcher for playing on the Radium public Rec Room server.

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

- **Rooms Tab** — Browse, search, and sort custom rooms, with infinite scrolling/pagination to explore in-game content.
- **People Tab** — Search and view detailed player profiles, bios, and statistics.
- **Photo Comments** — View photos along with user comments left on them.
- **UI Skins** — Toggle between 13 themes: Steam 2003 Green, Windows 98 Gray, Windows 95 Gray, Windows XP Luna, Windows XP Royale Noir, Windows Vista Aero, Windows 7 Aero, Mac OS Classic, Modern Dark, Modern Light, Modern Forest Green, Black & White, and Black & White (Inverted) — each with custom styles and borders.
- **In-App Client Download** — Downloads the game zip directly inside the launcher with live speed & ETA progress, then auto-extracts it to `%APPDATA%\com.radium.launcher\client`.
- **Play Modes** — Supports both Screen and VR modes, executing the correct `.bat` script from the client folder.
- **Server Status** — Checks the game API gateway and CDN on startup and every 60 seconds, with an instant refresh button.
- **Auto-Update** — On startup the launcher checks GitHub for a newer version. If one is found, a popup shows the release notes and lets you download & install it in one click.
- **Settings** — Configure the API server URL, play mode, theme, minimize-on-launch, and auto-update toggle. All saved locally.

---

## Download

Grab the latest build (**v3.0.0**) directly or check the [Releases page](https://github.com/abod124-sudo/Radium-Launcher/releases/latest):

| File | Description |
|------|-------------|
| [Radium.Launcher_3.0.0_x64-setup.exe](https://github.com/abod124-sudo/Radium-Launcher/releases/download/v3.0.0/Radium.Launcher_3.0.0_x64-setup.exe) | NSIS installer (recommended) |



## File Locations

All client data and settings are stored locally under:

```
%APPDATA%\com.radium.launcher\
  ├── config.json       - saved settings
  └── client\           - downloaded game files
```

---


## Note

Parts of this launcher's codebase were written/co-authored with the help of AI coding assistants.
