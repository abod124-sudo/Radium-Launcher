# Radium Launcher

just a simple custom launcher for playing on the Radium Rec Room server. it's styled to look like old desktop apps from the early 2000s. 

## Features
- **operating system skins**: you can toggle between Steam 2003 Green, Windows 98 Gray, Windows XP Luna, and Windows Vista Aero. they have authentic borders, rounded titlebars, custom close/minimize buttons, and glassy gradients.
- **in-app downloads**: downloads the game zip directly inside the launcher, shows you speed & ETA, and extracts it to `%APPDATA%/radium-launcher/client` automatically.
- **play modes**: support for both SCREEN and VR modes (executes the corresponding bat script inside the client folder).
- **clean status telemetry**: simple online/offline check for the game gateway and CDN server.

## Setup
make sure you have Node.js installed on your Windows machine, then run:

```bash
# install dependencies
npm install

# run locally
npm start

# package into an installer / portable exe
npm run build
```

## Config location
all client data and settings are stored locally in the electron user directory under `%APPDATA%/radium-launcher/`.
