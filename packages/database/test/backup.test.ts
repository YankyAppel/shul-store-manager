import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBackup,
  formatBackupName,
  migrations,
  parseBackupName,
  selectBackupsToDelete,
  StoreDatabase,
} from '../src/index.js';

const temporaryDirectory = () =>
  path.join(tmpdir(), `shul-backup-${randomUUID()}`);

function makeOldDatabase(filename: string): void {
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA foreign_keys = ON');
  for (const migration of migrations.filter((item) => item.version <= 16)) {
    database.exec(migration.sql);
    database.exec(`PRAGMA user_version = ${migration.version}`);
  }
  database
    .prepare(
      `INSERT INTO sales
       (id, receipt_number, completion_key, status, subtotal_cents, tax_cents,
        total_cents, created_at, completed_at)
       VALUES (?, 1, ?, 'completed', 500, 0, 500, ?, ?)`,
    )
    .run(
      randomUUID(),
      randomUUID(),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
  database.close();
}

describe('local SQLite backups', () => {
  it('creates a verified backup containing the same sales rows', () => {
    const root = temporaryDirectory();
    const filename = path.join(root, 'live.sqlite');
    const backups = path.join(root, 'backups');
    mkdirSync(root, { recursive: true });
    const source = new StoreDatabase(filename);
    source.connection
      .prepare(
        `INSERT INTO sales
         (id, receipt_number, completion_key, status, subtotal_cents, tax_cents,
          total_cents, created_at, completed_at)
         VALUES (?, 1, ?, 'completed', 500, 0, 500, ?, ?)`,
      )
      .run(
        randomUUID(),
        randomUUID(),
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    const sourceCount = Number(
      (
        source.connection
          .prepare('SELECT COUNT(*) AS count FROM sales')
          .get() as { count: number }
      ).count,
    );
    const result = createBackup(
      source.connection,
      backups,
      'scheduled',
      source.schemaVersion(),
    );
    expect(result.ok).toBe(true);
    const copied = new DatabaseSync(path.join(backups, result.filename), {
      readOnly: true,
    });
    expect(copied.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    expect(
      copied.prepare('SELECT COUNT(*) AS count FROM sales').get(),
    ).toMatchObject({
      count: sourceCount,
    });
    copied.close();
    source.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports verification failure without rotating existing backups', () => {
    const root = temporaryDirectory();
    const backups = path.join(root, 'backups');
    mkdirSync(backups, { recursive: true });
    const oldName = formatBackupName(
      'scheduled',
      new Date('2026-01-01T00:00:00Z'),
    );
    writeFileSync(path.join(backups, oldName), 'keep me');
    const fakeConnection = {
      exec(sql: string) {
        const quoted = /'((?:''|[^'])+)'/.exec(sql)?.[1];
        if (!quoted) throw new Error('missing output path');
        writeFileSync(quoted.replaceAll("''", "'"), 'not sqlite');
      },
      prepare: () => {
        throw new Error('not used');
      },
    };
    const result = createBackup(
      fakeConnection,
      backups,
      'scheduled',
      17,
      new Date('2026-01-02T00:00:00Z'),
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(path.join(backups, oldName), 'utf8')).toBe('keep me');
    expect(readdirSync(backups)).toEqual([oldName]);
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the newest scheduled and pre-migration backups and ignores foreign files', () => {
    const names = [
      ...Array.from({ length: 12 }, (_, index) =>
        parseBackupName(
          formatBackupName(
            'scheduled',
            new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
          ),
        )!,
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        parseBackupName(
          formatBackupName(
            'premigration',
            new Date(`2026-02-${String(index + 1).padStart(2, '0')}T00:00:00Z`),
            index + 1,
          ),
        )!,
      ),
    ];
    const deletions = selectBackupsToDelete(names);
    expect(deletions.filter((item) => item.kind === 'scheduled')).toHaveLength(
      2,
    );
    expect(
      deletions.filter((item) => item.kind === 'premigration'),
    ).toHaveLength(2);
    expect(parseBackupName('foreign.sqlite')).toBeNull();
  });

  it('round-trips scheduled and pre-migration filenames', () => {
    const date = new Date('2026-03-04T05:06:07Z');
    expect(parseBackupName(formatBackupName('scheduled', date))).toMatchObject({
      kind: 'scheduled',
      timestamp: '20260304-050607',
    });
    expect(
      parseBackupName(formatBackupName('premigration', date, 16)),
    ).toMatchObject({
      kind: 'premigration',
      timestamp: '20260304-050607',
      schemaVersion: 16,
    });
  });

  it('takes a pre-migration backup before upgrading a populated database', () => {
    const root = temporaryDirectory();
    const filename = path.join(root, 'live.sqlite');
    const backups = path.join(root, 'backups');
    mkdirSync(root, { recursive: true });
    makeOldDatabase(filename);
    const upgraded = new StoreDatabase(filename, { backupDirectory: backups });
    expect(upgraded.schemaVersion()).toBe(17);
    expect(
      upgraded
        .listBackups()
        .some((backup) => backup.kind === 'premigration' && backup.available),
    ).toBe(true);
    upgraded.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('marks a history row unavailable when its backup file is missing', () => {
    const root = temporaryDirectory();
    const filename = path.join(root, 'live.sqlite');
    const backups = path.join(root, 'backups');
    mkdirSync(root, { recursive: true });
    const database = new StoreDatabase(filename, { backupDirectory: backups });
    const attempt = database.createBackup('scheduled');
    expect(attempt.ok).toBe(true);
    rmSync(path.join(backups, attempt.filename));
    expect(database.listBackups()).toEqual([
      expect.objectContaining({
        filename: attempt.filename,
        ok: true,
        available: false,
      }),
    ]);
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('aborts a populated upgrade when the pre-migration backup cannot be created', () => {
    const root = temporaryDirectory();
    const filename = path.join(root, 'live.sqlite');
    const invalidDirectory = path.join(root, 'not-a-directory');
    mkdirSync(root, { recursive: true });
    makeOldDatabase(filename);
    writeFileSync(invalidDirectory, 'not a directory');
    expect(
      () => new StoreDatabase(filename, { backupDirectory: invalidDirectory }),
    ).toThrow(/Pre-migration backup failed/);
    const raw = new DatabaseSync(filename, { readOnly: true });
    expect(
      Number(
        Object.values(
          raw.prepare('PRAGMA user_version').get() as Record<string, unknown>,
        )[0],
      ),
    ).toBe(16);
    raw.close();
    rmSync(root, { recursive: true, force: true });
  });
});
