const { version } = require('../../package.json');
const { githubUpdateRepository } = require('./update-config.cjs');

module.exports = {
  appId: 'org.shulstore.manager',
  productName: 'Shul Store Manager',
  asar: true,
  npmRebuild: false,
  directories: {
    output: 'release',
  },
  files: [
    'dist/**',
    'dist-electron/**',
    'package.json',
    'update-config.cjs',
    '!node_modules/@shul-store/payments/src/**',
  ],
  extraMetadata: {
    version,
  },
  publish: [
    {
      provider: 'github',
      releaseType: 'release',
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
