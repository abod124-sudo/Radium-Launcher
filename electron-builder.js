/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
const config = {
  appId: "com.radium.launcher",
  productName: "Radium Launcher",
  win: {
    target: ["nsis", "portable"],
    icon: "logo.png"
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  },
  files: [
    "electron/**/*",
    "src/**/*",
    "logo.png",
    "package.json"
  ]
};

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
