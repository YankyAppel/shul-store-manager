import { randomUUID } from 'node:crypto';
import {
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export type BackupKind = 'scheduled' | 'manual' | 'premigration' | 'prerestore';

export interface ParsedBackupName {
  filename: string;
  kind: BackupKind;
  timestamp: string;
  schemaVersion: number | null;
}

export interface BackupAttempt {
  attemptedAt: string;
  kind: BackupKind;
  filename: string;
  bytes: number;
  ok: boolean;
  message: string;
}

export interface BackupListing extends BackupAttempt {
  available: boolean;
}

export interface BackupConnection {
  prepare(sql: string): {
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
    run(...parameters: unknown[]): unknown;
  };
  exec(sql: string): void;
}

const TIMESTAMP = '(\\d{8}-\\d{6})';
const BACKUP_RE = new RegExp(
  `^shul-store-(${TIMESTAMP.slice(1, -1)})\\.sqlite$`,
);
const PREMIGRATION_RE = new RegExp(
  `^shul-store-premigration-(${TIMESTAMP.slice(1, -1)})-v(\\d+)\\.sqlite$`,
);
const MANUAL_RE = new RegExp(
  `^shul-store-manual-(${TIMESTAMP.slice(1, -1)})\\.sqlite$`,
);
const PRERESTORE_RE = new RegExp(
  `^shul-store-prerestore-(${TIMESTAMP.slice(1, -1)})\\.sqlite$`,
);

function formatTimestamp(value: Date): string {
  const parts = [
    value.getUTCFullYear().toString().padStart(4, '0'),
    (value.getUTCMonth() + 1).toString().padStart(2, '0'),
    value.getUTCDate().toString().padStart(2, '0'),
  ];
  const time = [
    value.getUTCHours().toString().padStart(2, '0'),
    value.getUTCMinutes().toString().padStart(2, '0'),
    value.getUTCSeconds().toString().padStart(2, '0'),
  ];
  return `${parts.join('')}-${time.join('')}`;
}

export function formatBackupName(
  kind: BackupKind,
  at: Date,
  schemaVersion?: number,
): string {
  const timestamp = formatTimestamp(at);
  if (kind === 'premigration') {
    if (!Number.isInteger(schemaVersion) || schemaVersion! < 0)
      throw new Error(
        'A schema version is required for pre-migration backups.',
      );
    return `shul-store-premigration-${timestamp}-v${schemaVersion}.sqlite`;
  }
  if (kind === 'manual') return `shul-store-manual-${timestamp}.sqlite`;
  if (kind === 'prerestore') return `shul-store-prerestore-${timestamp}.sqlite`;
  return `shul-store-${timestamp}.sqlite`;
}

export function parseBackupName(filename: string): ParsedBackupName | null {
  let match = BACKUP_RE.exec(filename);
  if (match)
    return {
      filename,
      kind: 'scheduled',
      timestamp: match[1]!,
      schemaVersion: null,
    };
  match = PREMIGRATION_RE.exec(filename);
  if (match)
    return {
      filename,
      kind: 'premigration',
      timestamp: match[1]!,
      schemaVersion: Number(match[2]),
    };
  match = MANUAL_RE.exec(filename);
  if (match)
    return {
      filename,
      kind: 'manual',
      timestamp: match[1]!,
      schemaVersion: null,
    };
  match = PRERESTORE_RE.exec(filename);
  if (match)
    return {
      filename,
      kind: 'prerestore',
      timestamp: match[1]!,
      schemaVersion: null,
    };
  return null;
}

export function selectBackupsToDelete(
  backups: ParsedBackupName[],
): ParsedBackupName[] {
  const deleteOldest = (kind: BackupKind, keep: number): ParsedBackupName[] => {
    const matching = backups
      .filter((backup) => backup.kind === kind)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return matching
      .slice(keep)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  };
  return [
    ...deleteOldest('scheduled', 10),
    ...deleteOldest('manual', 5),
    ...deleteOldest('premigration', 3),
    ...deleteOldest('prerestore', 3),
  ];
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function uniqueTarget(
  directory: string,
  kind: BackupKind,
  at: Date,
  schemaVersion: number,
): { filename: string; path: string } {
  const candidate = new Date(at);
  for (;;) {
    const filename = formatBackupName(
      kind,
      candidate,
      kind === 'premigration' ? schemaVersion : undefined,
    );
    const target = path.join(directory, filename);
    try {
      statSync(target);
      candidate.setUTCSeconds(candidate.getUTCSeconds() + 1);
    } catch {
      return { filename, path: target };
    }
  }
}

export function verifyBackup(
  filename: string,
  expectedSchemaVersion: number,
): { ok: true; bytes: number } | { ok: false; message: string } {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    const integrity = database
      .prepare('PRAGMA integrity_check')
      .get() as Record<string, unknown>;
    if (Object.values(integrity)[0] !== 'ok')
      return {
        ok: false,
        message: 'Backup integrity_check did not return ok.',
      };
    const version = Number(
      Object.values(
        database.prepare('PRAGMA user_version').get() as Record<
          string,
          unknown
        >,
      )[0],
    );
    if (version !== expectedSchemaVersion)
      return {
        ok: false,
        message: `Backup schema version ${version} does not match expected ${expectedSchemaVersion}.`,
      };
    for (const table of ['store_settings', 'products', 'sales'])
      database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return { ok: true, bytes: statSync(filename).size };
  } catch (error) {
    return {
      ok: false,
      message: `Backup verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    database?.close();
  }
}

export function createBackup(
  connection: BackupConnection,
  directory: string,
  kind: BackupKind,
  schemaVersion: number,
  at = new Date(),
): BackupAttempt {
  const attemptedAt = new Date().toISOString();
  let target: { filename: string; path: string } | undefined;
  let temporary = '';
  try {
    mkdirSync(directory, { recursive: true });
    target = uniqueTarget(directory, kind, at, schemaVersion);
    temporary = path.join(
      directory,
      `.shul-store-backup-${randomUUID()}.sqlite`,
    );
    connection.exec(`VACUUM INTO ${sqlString(temporary)}`);
    renameSync(temporary, target.path);
    const verification = verifyBackup(target.path, schemaVersion);
    if (!verification.ok) {
      unlinkSync(target.path);
      return {
        attemptedAt,
        kind,
        filename: target.filename,
        bytes: 0,
        ok: false,
        message: verification.message,
      };
    }
    const parsed = readdirSync(directory)
      .map(parseBackupName)
      .filter((value): value is ParsedBackupName => value !== null);
    for (const backup of selectBackupsToDelete(parsed)) {
      if (backup.filename === target.filename) continue;
      try {
        unlinkSync(path.join(directory, backup.filename));
      } catch {
        // A concurrent cleanup or external deletion does not invalidate the
        // verified backup itself.
      }
    }
    return {
      attemptedAt,
      kind,
      filename: target.filename,
      bytes: verification.bytes,
      ok: true,
      message: 'Backup verified successfully.',
    };
  } catch (error) {
    if (temporary)
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created.
      }
    return {
      attemptedAt,
      kind,
      filename:
        target?.filename ??
        formatBackupName(
          kind,
          at,
          kind === 'premigration' ? schemaVersion : undefined,
        ),
      bytes: 0,
      ok: false,
      message: `Backup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function recordBackupAttempt(
  connection: BackupConnection,
  attempt: BackupAttempt,
): void {
  connection
    .prepare(
      `INSERT INTO backup_attempts
       (attempted_at, kind, filename, bytes, ok, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      attempt.attemptedAt,
      attempt.kind,
      attempt.filename,
      attempt.bytes,
      attempt.ok ? 1 : 0,
      attempt.message,
    );
}

export function listBackups(
  connection: BackupConnection,
  directory: string,
): BackupListing[] {
  let rows: Array<{
    attempted_at: string;
    kind: BackupKind;
    filename: string;
    bytes: number;
    ok: number;
    message: string;
  }> = [];
  try {
    rows = connection
      .prepare(
        `SELECT attempted_at, kind, filename, bytes, ok, message
         FROM backup_attempts ORDER BY attempted_at DESC`,
      )
      .all() as typeof rows;
  } catch {
    return [];
  }
  return rows.map((row) => {
    let available = false;
    let bytes = Number(row.bytes);
    try {
      const info = statSync(path.join(directory, row.filename));
      available = info.isFile();
      if (available) bytes = info.size;
    } catch {
      // The history row remains visible, but unavailable backups are not restorable.
    }
    return {
      attemptedAt: row.attempted_at,
      kind: row.kind,
      filename: row.filename,
      bytes,
      ok: Boolean(row.ok),
      message: row.message,
      available,
    };
  });
}
