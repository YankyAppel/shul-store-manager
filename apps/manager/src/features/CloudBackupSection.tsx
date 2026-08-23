import { useEffect, useState } from 'react';
import {
  type ConnectionTestResult,
  type RestoreResult,
  type SyncConfigView,
  type SyncNowResult,
  type SyncStatus,
} from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';

export function CloudBackupSection() {
  const [config, setConfig] = useState<SyncConfigView>();
  const [status, setStatus] = useState<SyncStatus>();
  const [canRestore, setCanRestore] = useState(false);

  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(
    null,
  );

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncNowResult | null>(null);

  // Restore form (only relevant on a fresh install)
  const [restoreUrl, setRestoreUrl] = useState('');
  const [restoreKey, setRestoreKey] = useState('');
  const [restoreStoreId, setRestoreStoreId] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(
    null,
  );

  async function refresh() {
    const [cfg, st, available] = await Promise.all([
      window.storeApi.sync.getConfig(),
      window.storeApi.sync.getStatus(),
      window.storeApi.sync.isRestoreAvailable(),
    ]);
    setConfig(cfg);
    setStatus(st);
    setCanRestore(available);
    setUrl((current) => current || cfg.supabaseUrl || '');
  }

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void window.storeApi.sync.getStatus().then(setStatus);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!config || !status) return null;

  async function saveCredentials() {
    setSaving(true);
    setSavedMessage('');
    try {
      const updated = await window.storeApi.sync.saveConfig({
        enabled: config!.enabled,
        supabaseUrl: url.trim(),
        apiKey,
      });
      setConfig(updated);
      setApiKey('');
      setSavedMessage('Credentials saved.');
    } catch (error) {
      setSavedMessage(messageFrom(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(next: boolean) {
    try {
      const newStatus = await window.storeApi.sync.setEnabled(next);
      setStatus(newStatus);
      setConfig({ ...config!, enabled: next });
    } catch (error) {
      setSavedMessage(messageFrom(error));
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await window.storeApi.sync.testConnection({
          enabled: true,
          supabaseUrl: url.trim(),
          apiKey,
        }),
      );
    } catch (error) {
      setTestResult({
        ok: false,
        reachable: false,
        message: messageFrom(error),
      });
    } finally {
      setTesting(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await window.storeApi.sync.syncNow();
      setSyncResult(result);
      setStatus(await window.storeApi.sync.getStatus());
    } catch (error) {
      setSyncResult({
        pushed: 0,
        remaining: 0,
        error: messageFrom(error),
        skipped: false,
      });
    } finally {
      setSyncing(false);
    }
  }

  async function performRestore() {
    setRestoring(true);
    setRestoreResult(null);
    try {
      const result = await window.storeApi.sync.restore({
        supabaseUrl: restoreUrl.trim(),
        apiKey: restoreKey,
        storeId: restoreStoreId.trim(),
      });
      setRestoreResult(result);
      if (result.ok) void refresh();
    } catch (error) {
      setRestoreResult({
        ok: false,
        message: messageFrom(error),
        summary: null,
      });
    } finally {
      setRestoring(false);
    }
  }

  const keyReady = apiKey.trim().length > 0 && url.trim().length > 0;

  return (
    <section
      className="settings-form"
      style={{ borderTop: '1px solid #e0e5e2', marginTop: 16, paddingTop: 16 }}
    >
      <h3 style={{ margin: '0 0 4px 0' }}>Cloud backup (optional)</h3>
      <p style={{ margin: '0 0 12px', color: '#66776d', fontSize: '13px' }}>
        Cloud backup is <strong>optional</strong>. The store works fully offline
        and the local database is always the source of truth. Enable it to keep
        a durable backup in your own Supabase project and to restore onto a
        fresh install. See <code>docs/cloud-sync.md</code> for setup.
      </p>

      <label className="toggle">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />{' '}
        Enable automatic cloud backup
      </label>

      <div className="form-grid">
        <label>
          Supabase project URL
          <input
            value={url}
            placeholder="https://your-project.supabase.co"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          API key{' '}
          {config.configured && config.apiKeyHint && (
            <em>Current: {config.apiKeyHint}</em>
          )}
          <input
            type="password"
            value={apiKey}
            placeholder={
              config.configured
                ? 'Enter a new key to replace it'
                : 'Service role or anon key'
            }
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
      </div>

      {config.configured && !config.apiKeyEncryptionAvailable && (
        <div className="alert" style={{ marginBottom: 12 }}>
          OS keychain encryption is unavailable on this device, so the API key
          is stored without encryption. Consider enabling OS encryption.
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <button
          className="primary"
          disabled={!keyReady || saving}
          onClick={() => void saveCredentials()}
        >
          {saving ? 'Saving…' : 'Save credentials'}
        </button>
        <button
          disabled={!keyReady || testing}
          onClick={() => void testConnection()}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          disabled={!config.enabled || syncing}
          onClick={() => void syncNow()}
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {savedMessage && (
          <span style={{ color: '#1c6448', fontSize: '13px' }}>
            {savedMessage}
          </span>
        )}
      </div>

      {testResult && (
        <div
          className="alert"
          style={{
            marginTop: 12,
            color: testResult.ok ? '#1c6448' : undefined,
          }}
        >
          {testResult.message}
        </div>
      )}

      {syncResult && syncResult.error && (
        <div className="alert" style={{ marginTop: 12 }}>
          Last sync attempt: {syncResult.error}
        </div>
      )}
      {syncResult && !syncResult.error && (
        <div className="alert" style={{ marginTop: 12, color: '#1c6448' }}>
          Pushed {syncResult.pushed} event(s); {syncResult.remaining} pending.
          {syncResult.skipped ? ' (A sync was already running.)' : ''}
        </div>
      )}

      <SyncStatusDisplay status={status} config={config} />

      {canRestore && (
        <RestorePanel
          restoreUrl={restoreUrl}
          restoreKey={restoreKey}
          restoreStoreId={restoreStoreId}
          restoring={restoring}
          restoreResult={restoreResult}
          setRestoreUrl={setRestoreUrl}
          setRestoreKey={setRestoreKey}
          setRestoreStoreId={setRestoreStoreId}
          performRestore={performRestore}
        />
      )}
    </section>
  );
}

function SyncStatusDisplay({
  status,
  config,
}: {
  status: SyncStatus;
  config: SyncConfigView;
}) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        background: '#f6f8f6',
        borderRadius: 6,
        fontSize: '13px',
        color: '#3c4a42',
      }}
    >
      <div>
        <strong>Status:</strong> {status.enabled ? 'Enabled' : 'Disabled'} ·{' '}
        {status.configured ? 'Configured' : 'Not configured'}
      </div>
      {config.storeId && (
        <div>
          <strong>Store ID:</strong> <code>{config.storeId}</code>
        </div>
      )}
      <div>
        <strong>Last successful sync:</strong>{' '}
        {status.lastSyncAt
          ? new Date(status.lastSyncAt).toLocaleString()
          : 'never'}
      </div>
      <div>
        <strong>Pending events:</strong> {status.pendingEventCount}
      </div>
      {status.lastError && (
        <div>
          <strong>Last error:</strong> {status.lastError}
        </div>
      )}
    </div>
  );
}

function RestorePanel(props: {
  restoreUrl: string;
  restoreKey: string;
  restoreStoreId: string;
  restoring: boolean;
  restoreResult: RestoreResult | null;
  setRestoreUrl: (v: string) => void;
  setRestoreKey: (v: string) => void;
  setRestoreStoreId: (v: string) => void;
  performRestore: () => void;
}) {
  const ready =
    props.restoreUrl.trim().length > 0 &&
    props.restoreKey.length > 0 &&
    props.restoreStoreId.trim().length > 0;
  return (
    <div
      style={{
        marginTop: 16,
        padding: 12,
        border: '1px dashed #9db2a3',
        borderRadius: 6,
      }}
    >
      <h4 style={{ margin: '0 0 4px 0' }}>Restore from cloud</h4>
      <p style={{ margin: '0 0 10px', color: '#66776d', fontSize: '13px' }}>
        This fresh installation has no local data yet. You can restore a
        previous backup from your Supabase project. This replaces the empty
        local database and is only available now — once data exists, restore is
        disabled.
      </p>
      <div className="form-grid">
        <label>
          Supabase project URL
          <input
            value={props.restoreUrl}
            placeholder="https://your-project.supabase.co"
            onChange={(e) => props.setRestoreUrl(e.target.value)}
          />
        </label>
        <label>
          API key
          <input
            type="password"
            value={props.restoreKey}
            onChange={(e) => props.setRestoreKey(e.target.value)}
          />
        </label>
        <label>
          Store ID to restore
          <input
            value={props.restoreStoreId}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => props.setRestoreStoreId(e.target.value)}
          />
        </label>
      </div>
      <div
        style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}
      >
        <button
          disabled={!ready || props.restoring}
          onClick={() => void props.performRestore()}
        >
          {props.restoring ? 'Restoring…' : 'Restore from cloud'}
        </button>
      </div>
      {props.restoreResult && (
        <div
          className="alert"
          style={{
            marginTop: 12,
            color: props.restoreResult.ok ? '#1c6448' : undefined,
            whiteSpace: 'pre-wrap',
          }}
        >
          {props.restoreResult.ok && props.restoreResult.summary
            ? formatRestoreSummary(props.restoreResult)
            : props.restoreResult.message}
        </div>
      )}
    </div>
  );
}

function formatRestoreSummary(result: RestoreResult): string {
  const s = result.summary!;
  const lines = [
    result.message,
    `Events replayed: ${s.eventsReplayed}`,
    `Categories: ${s.categories} · Products: ${s.products} · Customers: ${s.customers}`,
    `Sales: ${s.sales} · Account payments: ${s.accountPayments}`,
    `Inventory movements: ${s.inventoryMovements} · Ledger entries: ${s.ledgerEntries}`,
    `Integrity: ${s.integrityChecks.join('; ')}`,
  ];
  return lines.join('\n');
}
