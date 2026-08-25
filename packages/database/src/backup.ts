import { createHash, randomUUID } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
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
  imagesCopied: number;
  imagesMissing: number;
}

export interface BackupListing extends BackupAttempt {
  available: boolean;
}

export interface RestoreImageResult {
  imagesRestored: number;
  imagesMissing: number;
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
const IMAGE_DIGEST_RE = /^[0-9a-f]{64}$/;

function isImageDigest(value: string): boolean {
  return IMAGE_DIGEST_RE.test(value);
}

function imageVaultPath(directory: string, digest: string): string {
  return path.join(directory, 'images', digest.slice(0, 2), digest);
}

function safeImagePath(directory: string, relativePath: string): string | null {
  const root = path.resolve(directory);
  const candidate = path.resolve(root, relativePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
    ? candidate
    : null;
}

function digestOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

interface ImageRow {
  relative_path: string;
  sha256: string;
}

function snapshotImages(filename: string): ImageRow[] {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    return database
      .prepare('SELECT relative_path, sha256 FROM images')
      .all() as unknown as ImageRow[];
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function ensureVaultImage(
  backupDirectory: string,
  imageDirectory: string | undefined,
  image: ImageRow,
): boolean {
  if (!isImageDigest(image.sha256)) return false;
  const target = imageVaultPath(backupDirectory, image.sha256);
  try {
    if (
      statSync(target).isFile() &&
      digestOf(readFileSync(target)) === image.sha256
    )
      return true;
  } catch {
    // The vault object is absent or corrupt; try to rebuild it from the source.
  }
  if (!imageDirectory) return false;
  const source = safeImagePath(imageDirectory, image.relative_path);
  if (!source) return false;
  let content: Buffer;
  try {
    content = readFileSync(source);
  } catch {
    return false;
  }
  if (digestOf(content) !== image.sha256) return false;
  const targetDirectory = path.dirname(target);
  const temporary = path.join(
    targetDirectory,
    `.${image.sha256}-${randomUUID()}.tmp`,
  );
  try {
    mkdirSync(targetDirectory, { recursive: true });
    writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, target);
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    return false;
  }
}

function copySnapshotImages(
  snapshotFilename: string,
  backupDirectory: string,
  imageDirectory: string | undefined,
): { imagesCopied: number; imagesMissing: number } {
  let imagesCopied = 0;
  let imagesMissing = 0;
  for (const image of snapshotImages(snapshotFilename)) {
    const target = isImageDigest(image.sha256)
      ? imageVaultPath(backupDirectory, image.sha256)
      : null;
    let alreadyPresent = false;
    if (target) {
      try {
        alreadyPresent =
          statSync(target).isFile() &&
          digestOf(readFileSync(target)) === image.sha256;
      } catch {
        alreadyPresent = false;
      }
    }
    if (alreadyPresent) continue;
    if (ensureVaultImage(backupDirectory, imageDirectory, image))
      imagesCopied++;
    else imagesMissing++;
  }
  return { imagesCopied, imagesMissing };
}

function referencedImageDigests(
  database: DatabaseSync | BackupConnection,
): Set<string> {
  const rows = database.prepare('SELECT sha256 FROM images').all() as Array<{
    sha256: string;
  }>;
  return new Set(
    rows.map((row) => row.sha256).filter((digest) => isImageDigest(digest)),
  );
}

function collectRetainedImageDigests(
  backupDirectory: string,
  retainedBackups: ParsedBackupName[],
): Set<string> | null {
  const digests = new Set<string>();
  for (const backup of retainedBackups) {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path.join(backupDirectory, backup.filename), {
        readOnly: true,
      });
      for (const digest of referencedImageDigests(database))
        digests.add(digest);
    } catch {
      return null;
    } finally {
      database?.close();
    }
  }
  return digests;
}

function garbageCollectImageVault(
  backupDirectory: string,
  connection: BackupConnection,
  retainedBackups: ParsedBackupName[],
): void {
  let keep: Set<string>;
  try {
    keep = referencedImageDigests(connection);
  } catch {
    return;
  }
  const backupDigests = collectRetainedImageDigests(
    backupDirectory,
    retainedBackups,
  );
  if (!backupDigests) return;
  for (const digest of backupDigests) keep.add(digest);
  const vault = path.join(backupDirectory, 'images');
  let prefixes;
  try {
    prefixes = readdirSync(vault, { withFileTypes: true });
  } catch {
    return;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
    let objects;
    try {
      objects = readdirSync(path.join(vault, prefix.name), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const object of objects) {
      if (
        !object.isFile() ||
        !IMAGE_DIGEST_RE.test(object.name) ||
        !object.name.startsWith(prefix.name)
      )
        continue;
      if (!keep.has(object.name)) {
        try {
          unlinkSync(path.join(vault, prefix.name, object.name));
        } catch {
          // A concurrent cleanup does not invalidate the backup.
        }
      }
    }
  }
}

export function restoreImagesFromVault(
  snapshotFilename: string,
  backupDirectory: string,
  imageDirectory: string,
): RestoreImageResult {
  let imagesRestored = 0;
  let imagesMissing = 0;
  for (const image of snapshotImages(snapshotFilename)) {
    if (!isImageDigest(image.sha256)) {
      imagesMissing++;
      continue;
    }
    const destination = safeImagePath(imageDirectory, image.relative_path);
    if (!destination) {
      imagesMissing++;
      continue;
    }
    try {
      if (
        statSync(destination).isFile() &&
        digestOf(readFileSync(destination)) === image.sha256
      )
        continue;
    } catch {
      // Restore the missing or corrupt destination from the vault.
    }
    const source = imageVaultPath(backupDirectory, image.sha256);
    let content: Buffer;
    try {
      content = readFileSync(source);
    } catch {
      imagesMissing++;
      continue;
    }
    if (digestOf(content) !== image.sha256) {
      imagesMissing++;
      continue;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(temporary, content, { flag: 'wx' });
      renameSync(temporary, destination);
      imagesRestored++;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created.
      }
      imagesMissing++;
    }
  }
  return { imagesRestored, imagesMissing };
}

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
  imageDirectory?: string,
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
        imagesCopied: 0,
        imagesMissing: 0,
      };
    }
    const imageResult = copySnapshotImages(
      target.path,
      directory,
      imageDirectory,
    );
    let parsed: ParsedBackupName[] = [];
    try {
      parsed = readdirSync(directory)
        .map(parseBackupName)
        .filter((value): value is ParsedBackupName => value !== null);
    } catch {
      // A verified database snapshot remains a successful backup even if
      // rotation cannot inspect the directory.
    }
    const deletions = selectBackupsToDelete(parsed);
    for (const backup of deletions) {
      if (backup.filename === target.filename) continue;
      try {
        unlinkSync(path.join(directory, backup.filename));
      } catch {
        // A concurrent cleanup or external deletion does not invalidate the
        // verified backup itself.
      }
    }
    if (parsed.length > 0) {
      let retained: ParsedBackupName[] = [];
      try {
        retained = readdirSync(directory)
          .map(parseBackupName)
          .filter((value): value is ParsedBackupName => value !== null);
      } catch {
        // Skip image cleanup when the retained set cannot be determined.
      }
      if (retained.length > 0)
        garbageCollectImageVault(directory, connection, retained);
    }
    return {
      attemptedAt,
      kind,
      filename: target.filename,
      bytes: verification.bytes,
      ok: true,
      message: 'Backup verified successfully.',
      ...imageResult,
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
      imagesCopied: 0,
      imagesMissing: 0,
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
       (attempted_at, kind, filename, bytes, ok, message, images_copied, images_missing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      attempt.attemptedAt,
      attempt.kind,
      attempt.filename,
      attempt.bytes,
      attempt.ok ? 1 : 0,
      attempt.message,
      attempt.imagesCopied,
      attempt.imagesMissing,
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
    images_copied: number;
    images_missing: number;
  }> = [];
  try {
    rows = connection
      .prepare(
        `SELECT attempted_at, kind, filename, bytes, ok, message,
                images_copied, images_missing
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
      imagesCopied: Number(row.images_copied),
      imagesMissing: Number(row.images_missing),
      available,
    };
  });
}
