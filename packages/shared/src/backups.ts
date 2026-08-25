export type LocalBackupKind =
  'scheduled' | 'manual' | 'premigration' | 'prerestore';

export interface LocalBackupAttempt {
  attemptedAt: string;
  kind: LocalBackupKind;
  filename: string;
  bytes: number;
  ok: boolean;
  message: string;
  imagesCopied: number;
  imagesMissing: number;
}

export interface LocalBackup extends LocalBackupAttempt {
  available: boolean;
}

export interface LocalRestoreResult {
  completedAt: string;
  filename: string;
  imagesRestored: number;
  imagesMissing: number;
  message: string;
}
