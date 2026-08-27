import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('manager IPC authorization coverage', () => {
  it('declares a requirement for every wrapper-registered channel', () => {
    const source = readFileSync(
      new URL('../../../apps/manager/electron/main.ts', import.meta.url),
      'utf8',
    );
    expect(source.match(/electronIpcMain\.handle\(/g)).toHaveLength(1);
    const registered = [
      ...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g),
    ].map((match) => match[1]!);
    expect(new Set(registered).size).toBe(registered.length);
    const requirements = source.slice(
      source.indexOf('export const channelRequirements'),
      source.indexOf('const ipcMain ='),
    );
    for (const channel of registered)
      expect(requirements).toContain(`'${channel}':`);
  });
});
