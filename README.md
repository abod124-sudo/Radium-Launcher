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
- **UI Skins & Custom Themes** — Toggle between 13 built-in themes (Steam 2003 Green, Windows 98 Gray, Windows XP Luna, Windows 7 Aero, Modern Dark, Black & White, etc.), or build your own custom JSON theme! Includes a stunning **Liquid Glass** effect for translucent backgrounds.
- **In-App Client Download** — Downloads the game zip directly inside the launcher with live speed & ETA progress, then auto-extracts it to `%APPDATA%\com.radium.launcher\client`.
- **Play Modes** — Supports both Screen and VR modes, executing the correct `.bat` script from the client folder.
- **Server Status & Bug Reporting** — Checks the game API gateway and CDN on startup. Includes an advanced built-in bug reporter that gathers app logs and system diagnostics.
- **Antivirus Detection** — Automatically detects third-party antivirus software and Windows Defender status to prevent false positive confusion during launch.
- **Auto-Update** — On startup the launcher checks GitHub for a newer version and lets you download & install it in one click. When updating you can choose whether to restore the desktop shortcut after the update.
- **Auto-Save Settings** — All settings save automatically the moment you change them. Toggles apply instantly; text fields save after a short delay. No Save button needed.

---

## Download

Grab the latest build (**v3.0.2**) directly or check the [Releases page](https://github.com/abod124-sudo/Radium-Launcher/releases/latest):

| File | Description |
|------|-------------|
| [RadiumLauncherSetup_3.0.2_x64.exe](https://github.com/abod124-sudo/Radium-Launcher/releases/download/v3.0.2/RadiumLauncherSetup_3.0.2_x64.exe) | NSIS installer for Windows x64 |

---


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
