const { version } = require('../../package.json');
const { githubUpdateRepository } = require('./update-config.cjs');

module.exports = {
  appId: 'org.shulstore.kiosk',
  productName: 'SUMA Kiosk',
  artifactName: 'SUMA-Kiosk-POS-Setup-${version}.${ext}',
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
      channel: 'kiosk',
      ...githubUpdateRepository,
    },
  ],
  icon: 'build/icon.ico',
  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
