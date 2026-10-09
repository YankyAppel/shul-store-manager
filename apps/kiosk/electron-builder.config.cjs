const { version } = require('../../package.json');
const { githubUpdateRepository } = require('./update-config.cjs');

// The release pipeline builds each arch separately: SUMA_UPDATE_CHANNEL gives
// each build its own updater manifest (kiosk.yml / kiosk-arm64.yml) and
// ARTIFACT_SUFFIX keeps the artifact names distinct (…-Setup-<v>-arm64.exe).
const artifactSuffix = process.env.ARTIFACT_SUFFIX || '';
// BUILD_ARCH narrows the build to one arch — config `arch` overrides the CLI
// arch flags, so a real per-arch installer needs it set here. Unset builds the
// combined universal installer (local dev default).
const buildArch = process.env.BUILD_ARCH
  ? [process.env.BUILD_ARCH]
  : ['x64', 'arm64'];

// .appx packaging needs the Windows SDK tooling — electron-builder provides it
// on Windows and macOS, not Linux (CI builds on Windows).
const canBuildAppx =
  process.platform === 'win32' || process.platform === 'darwin';

module.exports = {
  appId: 'org.shulstore.kiosk',
  productName: 'SUMA Kiosk',
  artifactName: `SUMA-Kiosk-POS-Setup-\${version}${artifactSuffix}.\${ext}`,
  asar: true,
  npmRebuild: false,
  directories: {
    output: 'release',
  },
  files: [
    'dist/**',
    'dist-electron/**',
    'package.json',
    'build/icon.png',
    'update-config.cjs',
    'google-oauth.cjs',
  ],
  extraMetadata: {
    version,
  },
  publish: [
    {
      provider: 'github',
      releaseType: 'release',
      channel: process.env.SUMA_UPDATE_CHANNEL || 'kiosk',
      ...githubUpdateRepository,
    },
  ],
  icon: 'build/icon.ico',
  // Newer NSIS bundle (3.12) — the legacy 3.0.4.1 stub's upgrade path can hang
  // after extraction when prior install metadata is corrupted.
  toolsets: { nsis: '1.2.1' },
  win: {
    icon: 'build/icon.ico',
    // Never sign the .appx — the Microsoft Store re-signs it on ingest; signing
    // it with a local cert only risks a publisher mismatch.
    signExts: ['!.appx'],
    target: [
      { target: 'nsis', arch: buildArch },
      // Install-free zip — escape hatch when the NSIS stub can't complete.
      { target: 'zip', arch: buildArch },
      // Microsoft Store package (.appx = MSIX format; the Store re-signs it on
      // ingest, so no certificate is needed here). Updates for MSIX installs
      // flow through the Store, not electron-updater.
      ...(canBuildAppx ? [{ target: 'appx', arch: buildArch }] : []),
    ],
  },
  appx: {
    // Identity assigned by Partner Center → SUMA Self-Checkout → Product
    // identity (product 9PHNVNWJBRQ6).
    identityName: 'SUMASystems.SUMASelf-Checkout',
    publisher: 'CN=FDAA55E3-82C4-4B29-9A04-E2B143A8EB83',
    publisherDisplayName: 'SUMA Systems',
    displayName: 'SUMA Self-Checkout',
    backgroundColor: '#1f5e3f',
    languages: ['en-US'],
    capabilities: [
      'internetClient',
      'internetClientServer',
      // LAN access: pairing to the SUMA Manager on the local network.
      'privateNetworkClientServer',
      // USB serial scale for weighted items.
      'serialcommunication',
    ],
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
