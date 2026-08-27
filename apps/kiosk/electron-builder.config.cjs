const { version } = require('../../package.json');
const { githubUpdateRepository } = require('./update-config.cjs');

module.exports = {
  appId: 'org.shulstore.kiosk',
  productName: 'Shul Store Kiosk',
  asar: true,
  npmRebuild: false,
  directories: {
    output: 'release',
  },
  files: ['dist/**', 'dist-electron/**', 'package.json', 'update-config.cjs'],
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
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
