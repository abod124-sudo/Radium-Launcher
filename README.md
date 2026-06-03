# Radium Launcher

A retro-skeuomorphic, early 2000s styled desktop launcher for the **Radium Rec Room Custom Server**. Built with Electron, HTML5, and custom CSS variables, the launcher allows players to manage, update, and launch the game client in both Screen and VR play modes, with support for multiple classic operating system skins.

---

## 🎨 Key Features

* **Authentic Retro Skins**: Switch between four signature operating system styles:
  * **Steam 2003 Green**: Olive-green panels with matrix-green text, outlines, and mechanical click offsets.
  * **Windows 98 Gray**: Windows classic light gray bevel layout, white inset cards, and solid active navy blue titlebars.
  * **Windows XP Blue (Luna)**: Thicker titlebar with Luna blue gradient, signature red Close button, blue Minimize button, rounded window corners, and soft pill-shaped controls.
  * **Windows Vista Aero**: Charcoal-black glossy titlebar with diagonal reflection shine overlays, glassy glowing red Close button, and split-metallic silver button textures.
* **In-App Client Downloader**: Streamlined installer that fetches the game client `.zip` directly, displays real-time MB/s speed, ETA, and progress blocks, and extracts files locally to `%APPDATA%/radium-launcher/client`.
* **Play Mode Selection**: Quick toggle between **SCREEN** (executes `RecRoom_ScreenMode.bat`) and **VR** (executes `RecRoom_VR.bat`) play scripts.
* **Unified Status Telemetry**: Live connection checks against the API Gateway (`https://ns.radie.app`) and CDN (`https://cdn.recroomarchive.org`) with zero latency noise or player count bloat.
* **Clean & Robust Architecture**: Built with modern Electron sandboxing, preload context bridges, native PowerShell archive extraction, and `tasklist` process validation.

---

## 🛠️ Technology Stack

* **Core**: Electron (v36.3.x)
* **Frontend**: HTML5, Vanilla JavaScript, and Custom CSS (no Tailwind/modern UI frameworks, preserving vintage pixel-alignment aesthetics)
* **Storage**: `electron-store` (for settings and active theme config)

---

## 🚀 Installation & Local Development

### Prerequisites
* [Node.js](https://nodejs.org/) (v16+ recommended)
* Windows OS (required for Rec Room client execution and PowerShell archive commands)

### Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/radium-launcher.git
   cd radium-launcher
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the launcher in developer mode:
   ```bash
   npm start
   ```
4. Build portable Windows `.exe` and NSIS installer packages:
   ```bash
   npm run build
   ```

---

## 📂 Project Structure

```
radium-electron/
├── electron/
│   ├── main.js        # Main process (downloading, execution, IPC management)
│   └── preload.js     # Preload context bridge
├── src/
│   ├── index.html     # HTML layouts for tabs (Home, Status, Settings)
│   ├── style.css      # Skeuomorphic styling sheet (Win2000, XP, Vista variables)
│   └── app.js         # Frontend renderer logic & event binding
├── package.json       # Electron builder and startup configurations
└── README.md          # Project documentation
```

---

## 📜 License

This project is community-driven and is not affiliated with, authorized, or endorsed by Rec Room Inc.
