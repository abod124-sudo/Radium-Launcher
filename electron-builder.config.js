/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
const config = {
  appId: "com.radium.launcher",
  productName: "Radium Launcher",
  win: {
    target: ["nsis", "portable", "zip"],
    icon: "icon.ico"
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  },
  files: [
    "electron/**/*",
    "src/**/*",
    "logo.png",
    "icon.ico",
    "package.json"
  ]
};

const fs = require('fs');
const path = require('path');

// Load environment variables from .env if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/(^["']|["']$)/g, '');
      process.env[key] = val;
    }
  }
}

// Azure Trusted Signing configuration
// Only enable if endpoint, account name, and profile name are provided in the environment
if (process.env.AZURE_SIGNING_ENDPOINT && process.env.AZURE_SIGNING_ACCOUNT && process.env.AZURE_SIGNING_PROFILE) {
  config.win.azureSignOptions = {
    endpoint: process.env.AZURE_SIGNING_ENDPOINT,
    codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT,
    certificateProfileName: process.env.AZURE_SIGNING_PROFILE
  };
  console.log('[Build] Azure Trusted Signing configuration applied.');
} else {
  console.log('[Build] Azure Trusted Signing configuration skipped (missing env variables).');
}

module.exports = config;
