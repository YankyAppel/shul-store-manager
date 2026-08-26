const { spawnSync } = require('node:child_process');

const forwardedArgs = process.argv.slice(2);
const publishIndex = forwardedArgs.indexOf('always');

if (
  publishIndex !== -1 &&
  !forwardedArgs.some(
    (arg) => arg === '--publish' || arg.startsWith('--publish='),
  )
) {
  forwardedArgs.splice(publishIndex, 1, '--publish', 'always');
}

const result = spawnSync(
  process.execPath,
  [
    require.resolve('electron-builder/cli.js'),
    '--config',
    'electron-builder.config.cjs',
    '--win',
    '--x64',
    ...forwardedArgs,
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(result.error);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
