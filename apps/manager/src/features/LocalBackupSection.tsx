import { useEffect, useState } from 'react';
import type { LocalBackup, LocalBackupAttempt } from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const kindLabel = (kind: LocalBackup['kind']): string =>
  kind === 'premigration'
    ? 'Pre-migration'
    : kind === 'prerestore'
      ? 'Pre-restore'
      : 'Scheduled';

export function LocalBackupSection() {
  const [backups, setBackups] = useState<LocalBackup[]>([]);
  const [result, setResult] = useState<LocalBackupAttempt | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [restoreMessage, setRestoreMessage] = useState('');

  async function refresh() {
    try {
      setBackups(await window.storeApi.backups.list());
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
        kind: 'scheduled',
        filename: '',
        bytes: 0,
        ok: false,
        message: messageFrom(error),
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

  const lastFailure = backups.find((backup) => !backup.ok);
  const selected = backups.find(
    (backup) =>
      backup.filename === restoreFile && backup.available && backup.ok,
  );

  return (
    <section
      className="settings-form"
      style={{ borderTop: '1px solid #e0e5e2', marginTop: 16, paddingTop: 16 }}
    >
      <h3 style={{ margin: '0 0 4px 0' }}>Local backups</h3>
      <p style={{ margin: '0 0 12px', color: '#66776d', fontSize: '13px' }}>
        Verified SQLite backups are kept on this computer automatically. Product
        images under <code>userData/images</code> are not included.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
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
          className={result.ok ? 'success' : 'alert'}
          style={{ marginBottom: 12 }}
        >
          {result.ok
            ? `Backup complete: ${result.filename} (${formatBytes(result.bytes)}).`
            : `Backup failed: ${result.message}`}
        </div>
      )}
      {lastFailure && (
        <div className="alert" style={{ marginBottom: 12 }}>
          Last backup failure (
          {new Date(lastFailure.attemptedAt).toLocaleString()}):{' '}
          {lastFailure.message}
        </div>
      )}
      {backups.length === 0 ? (
        <p style={{ color: '#66776d' }}>No backup attempts yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {backups.map((backup) => (
            <div
              key={`${backup.attemptedAt}-${backup.filename}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                borderBottom: '1px solid #edf0ee',
                padding: '6px 0',
              }}
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
                    style={{ marginLeft: 8 }}
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
            </div>
          ))}
        </div>
      )}
      {selected && (
        <div className="alert" style={{ marginTop: 12 }}>
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
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
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
