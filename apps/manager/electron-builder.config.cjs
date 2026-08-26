const { version } = require('../../package.json');

module.exports = {
  appId: 'org.shulstore.manager',
  productName: 'Shul Store Manager',
  asar: true,
  npmRebuild: false,
  directories: {
    output: 'release',
  },
  files: ['dist/**', 'dist-electron/**', 'package.json'],
  extraMetadata: {
    version,
  },
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
