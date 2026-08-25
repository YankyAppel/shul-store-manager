import { useEffect, useState } from 'react';
import type {
  LocalBackup,
  LocalBackupAttempt,
  LocalRestoreResult,
} from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const kindLabel = (kind: LocalBackup['kind']): string =>
  kind === 'premigration'
    ? 'Pre-migration'
    : kind === 'manual'
      ? 'Manual'
      : kind === 'prerestore'
        ? 'Pre-restore'
        : 'Scheduled';

export function LocalBackupSection() {
  const [backups, setBackups] = useState<LocalBackup[]>([]);
  const [result, setResult] = useState<LocalBackupAttempt | null>(null);
  const [restoreResult, setRestoreResult] = useState<LocalRestoreResult | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [restoreMessage, setRestoreMessage] = useState('');

  async function refresh() {
    try {
      const [nextBackups, nextRestoreResult] = await Promise.all([
        window.storeApi.backups.list(),
        window.storeApi.backups.getLastRestoreResult(),
      ]);
      setBackups(nextBackups);
      setRestoreResult(nextRestoreResult);
    } catch (error) {
      setRestoreMessage(messageFrom(error));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function backupNow() {
    setLoading(true);
    setResult(null);
    try {
      const next = await window.storeApi.backups.create();
      setResult(next);
      await refresh();
    } catch (error) {
      setResult({
        attemptedAt: new Date().toISOString(),
        kind: 'manual',
        filename: '',
        bytes: 0,
        ok: false,
        message: messageFrom(error),
        imagesCopied: 0,
        imagesMissing: 0,
      });
    } finally {
      setLoading(false);
    }
  }

  async function restore() {
    if (!restoreFile) return;
    setRestoreMessage('');
    try {
      await window.storeApi.backups.restore(restoreFile, confirmation);
    } catch (error) {
      setRestoreMessage(messageFrom(error));
    }
  }

  const latestFailure = backups
    .filter((backup) => !backup.ok)
    .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))[0];
  const latestSuccess = backups
    .filter((backup) => backup.ok)
    .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))[0];
  const lastFailure =
    latestFailure &&
    (!latestSuccess || latestFailure.attemptedAt > latestSuccess.attemptedAt)
      ? latestFailure
      : null;
  const selected = backups.find(
    (backup) =>
      backup.filename === restoreFile && backup.available && backup.ok,
  );

  return (
    <section className="settings-form local-backup-section">
      <h3 className="local-backup-heading">Local backups</h3>
      <p className="local-backup-description">
        Verified SQLite backups are kept on this computer automatically. Product
        images are copied to a shared, deduplicated vault and checked during
        restore.
      </p>
      <div className="local-backup-actions">
        <button
          className="primary"
          onClick={() => void backupNow()}
          disabled={loading}
        >
          {loading ? 'Backing up…' : 'Back up now'}
        </button>
        <button onClick={() => void window.storeApi.backups.revealFolder()}>
          Reveal backup folder
        </button>
      </div>
      {result && (
        <div
          className={`${result.ok ? 'success' : 'alert'} local-backup-result`}
        >
          {result.ok
            ? `Backup complete: ${result.filename} (${formatBytes(result.bytes)}); ${result.imagesCopied} image(s) copied, ${result.imagesMissing} missing.`
            : `Backup failed: ${result.message}`}
        </div>
      )}
      {restoreResult && (
        <div
          className={`local-backup-result ${
            restoreResult.imagesMissing > 0 ? 'alert' : 'success'
          }`}
        >
          Last restore ({new Date(restoreResult.completedAt).toLocaleString()}):{' '}
          {restoreResult.imagesRestored} image(s) restored,{' '}
          {restoreResult.imagesMissing} missing. {restoreResult.message}
        </div>
      )}
      {lastFailure && (
        <div className="alert local-backup-result">
          Last backup failure (
          {new Date(lastFailure.attemptedAt).toLocaleString()}):{' '}
          {lastFailure.message}
        </div>
      )}
      {backups.length === 0 ? (
        <p className="local-backup-empty">No backup attempts yet.</p>
      ) : (
        <div className="local-backup-list">
          {backups.map((backup) => (
            <div
              key={`${backup.attemptedAt}-${backup.filename}`}
              className="local-backup-row"
            >
              <span>
                {new Date(backup.attemptedAt).toLocaleString()} ·{' '}
                {kindLabel(backup.kind)}
              </span>
              <span>
                {backup.ok && backup.available
                  ? formatBytes(backup.bytes)
                  : backup.ok
                    ? 'Missing'
                    : 'Failed'}
                {backup.ok && backup.available && (
                  <button
                    className="local-backup-restore-button"
                    onClick={() => {
                      setRestoreFile(backup.filename);
                      setConfirmation('');
                      setRestoreMessage('');
                    }}
                  >
                    Restore
                  </button>
                )}
              </span>
              {backup.ok && (
                <span
                  className={
                    backup.imagesMissing > 0
                      ? 'local-backup-image-warning'
                      : 'local-backup-image-summary'
                  }
                >
                  {backup.imagesCopied} image(s) copied ·{' '}
                  {backup.imagesMissing > 0
                    ? `${backup.imagesMissing} missing`
                    : 'complete'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {selected && (
        <div className="alert local-backup-restore">
          <strong>Restore {selected.filename}?</strong>
          <p>
            This replaces the live database. A verified pre-restore copy will be
            kept first. Type <code>RESTORE {selected.filename}</code> to
            continue.
          </p>
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={`RESTORE ${selected.filename}`}
          />
          <div className="local-backup-confirm-actions">
            <button
              className="primary"
              disabled={confirmation !== `RESTORE ${selected.filename}`}
              onClick={() => void restore()}
            >
              Restore and relaunch
            </button>
            <button onClick={() => setRestoreFile(null)}>Cancel</button>
          </div>
          {restoreMessage && <p>{restoreMessage}</p>}
        </div>
      )}
    </section>
  );
}
