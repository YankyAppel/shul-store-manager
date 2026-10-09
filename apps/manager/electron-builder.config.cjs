const { version } = require('../../package.json');
const { githubUpdateRepository } = require('./update-config.cjs');

// The release pipeline builds each arch separately: SUMA_UPDATE_CHANNEL gives
// each build its own updater manifest (latest.yml / latest-arm64.yml) and
// ARTIFACT_SUFFIX keeps the artifact names distinct (…-Setup-<v>-arm64.exe).
const artifactSuffix = process.env.ARTIFACT_SUFFIX || '';

module.exports = {
  appId: 'org.shulstore.manager',
  productName: 'SUMA Manager',
  artifactName: `SUMA-Manager-POS-Setup-\${version}${artifactSuffix}.\${ext}`,
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
    '!node_modules/@shul-store/payments/src/**',
  ],
  extraMetadata: {
    version,
  },
  publish: [
    {
      provider: 'github',
      releaseType: 'release',
      channel: process.env.SUMA_UPDATE_CHANNEL || 'latest',
      ...githubUpdateRepository,
    },
  ],
  icon: 'build/icon.ico',
  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
