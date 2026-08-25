export type LocalBackupKind = 'scheduled' | 'premigration' | 'prerestore';

export interface LocalBackupAttempt {
  attemptedAt: string;
  kind: LocalBackupKind;
  filename: string;
  bytes: number;
  ok: boolean;
  message: string;
}

export interface LocalBackup extends LocalBackupAttempt {
  available: boolean;
}
