import { useEffect, useState } from 'react';
import type { KioskServerSettings } from '@shul-store/shared';
import {
  formatKioskAddress,
  formatRelativeTime,
  validatePort,
} from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';

const DEFAULT_PORT = '3939';
const PAIRING_WINDOW_MS = 5 * 60 * 1000;

export function KioskScreen() {
  const [settings, setSettings] = useState<KioskServerSettings>();
  const [port, setPort] = useState(DEFAULT_PORT);
  const [pairingCode, setPairingCode] = useState<string>();
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discoveryActive, setDiscoveryActive] = useState(false);

  async function refresh() {
    const next = await window.storeApi.kiosk.getSettings();
    setSettings(next);
    setPort(String(next.port || Number(DEFAULT_PORT)));
  }

  useEffect(() => {
    void refresh().catch((reason) => setError(messageFrom(reason)));
  }, []);

  useEffect(() => {
    if (!pairingExpiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairingExpiresAt]);

  useEffect(
    () => () => {
      void window.storeApi.kiosk.stopDiscovery();
    },
    [],
  );

  async function setServer(enabled: boolean) {
    const validation = validatePort(port);
    if (validation) {
      setError(validation);
      return;
    }
    setError('');
    setBusy(true);
    try {
      await window.storeApi.kiosk.setServer(enabled, Number(port));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      try {
        await refresh();
      } catch (reason) {
        setError(messageFrom(reason));
      }
      setBusy(false);
    }
  }

  async function generatePairingCode() {
    setError('');
    setBusy(true);
    try {
      const code = await window.storeApi.kiosk.pairCode();
      await window.storeApi.kiosk.startDiscovery();
      setDiscoveryActive(true);
      setPairingCode(code);
      setPairingExpiresAt(Date.now() + PAIRING_WINDOW_MS);
      setNow(Date.now());
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      try {
        await refresh();
      } catch (reason) {
        setError(messageFrom(reason));
      }
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!discoveryActive || !pairingExpiresAt) return;
    const timer = window.setTimeout(() => {
      void window.storeApi.kiosk.stopDiscovery();
      setDiscoveryActive(false);
    }, PAIRING_WINDOW_MS + 30000);
    return () => window.clearTimeout(timer);
  }, [discoveryActive, pairingExpiresAt]);

  async function revoke(id: string, name: string) {
    if (
      !window.confirm(
        `Revoke ${name}? This kiosk will stop working immediately and must be paired again.`,
      )
    )
      return;
    setError('');
    setBusy(true);
    try {
      await window.storeApi.kiosk.revoke(id);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      try {
        await refresh();
      } catch (reason) {
        setError(messageFrom(reason));
      }
      setBusy(false);
    }
  }

  const remainingSeconds = pairingExpiresAt
    ? Math.max(0, Math.ceil((pairingExpiresAt - now) / 1000))
    : 0;
  const pairingActive = remainingSeconds > 0;

  return (
    <div className="settings-form kiosk-screen">
      {error && <div className="alert">{error}</div>}
      <section className="card kiosk-section">
        <div className="card-body">
          <h2>Self-checkout server</h2>
          <p>
            Let card-only kiosks connect to this computer over the local
            network.
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings?.enabled ?? false}
              disabled={!settings || busy}
              onChange={(event) => void setServer(event.target.checked)}
            />
            Enable Kiosk server
          </label>
          <label>
            Port
            <input
              type="text"
              inputMode="numeric"
              value={port}
              disabled={busy}
              onChange={(event) => setPort(event.target.value)}
              onBlur={() => {
                const validation = validatePort(port);
                if (validation) setError(validation);
              }}
            />
            {validatePort(port) && (
              <small className="field-error">{validatePort(port)}</small>
            )}
          </label>
          <button
            type="button"
            className="primary"
            disabled={!settings || busy || Boolean(validatePort(port))}
            onClick={() => void setServer(settings?.enabled ?? false)}
          >
            Save server settings
          </button>
          {settings && (
            <p className="kiosk-status">
              Status:{' '}
              <strong>
                {settings.enabled && settings.running
                  ? 'Enabled and listening'
                  : settings.enabled
                    ? 'Enabled but not listening'
                    : 'Disabled'}
              </strong>
            </p>
          )}
          {settings?.enabled && settings.addresses.length > 0 && (
            <div className="kiosk-addresses">
              <strong>Enter one of these addresses on the kiosk:</strong>
              <ul>
                {settings.addresses.map((address) => (
                  <li key={address}>
                    <code>{formatKioskAddress(address, settings.port)}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {settings?.enabled && settings.addresses.length === 0 && (
            <p className="muted">No non-internal IPv4 address was found.</p>
          )}
          <p className="kiosk-warning">
            Warning: this is HTTP on your trusted LAN only. Do not put it on
            shul guest Wi-Fi.
          </p>
        </div>
      </section>

      <section className="card kiosk-section">
        <div className="card-body">
          <h2>Pair a kiosk</h2>
          <p>
            Generate a single-use code and enter it on the kiosk within five
            minutes.
          </p>
          <button
            type="button"
            className="primary"
            disabled={!settings?.enabled || !settings.running || busy}
            onClick={() => void generatePairingCode()}
          >
            Generate pairing code
          </button>
          {!settings?.enabled && (
            <small className="muted">Enable Kiosk server first</small>
          )}
          {settings?.enabled && !settings.running && (
            <small className="muted">
              Wait for the server to start listening
            </small>
          )}
          {pairingCode && (
            <div className="pairing-code" aria-live="polite">
              <strong>{pairingCode}</strong>
              <span>
                {pairingActive
                  ? `Expires in ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`
                  : 'Expired — generate a new code'}
              </span>
              <small>This code can only be used once.</small>
            </div>
          )}
        </div>
      </section>

      <section className="card kiosk-section">
        <div className="card-body">
          <h2>Paired kiosks</h2>
          {settings?.kiosks.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Last seen</th>
                    <th>State</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {settings.kiosks.map((kiosk) => (
                    <tr key={kiosk.id}>
                      <td>{kiosk.name}</td>
                      <td
                        title={kiosk.lastSeenAt ? kiosk.lastSeenAt : undefined}
                      >
                        {kiosk.lastSeenAt
                          ? formatRelativeTime(kiosk.lastSeenAt)
                          : 'Never'}
                      </td>
                      <td>
                        {kiosk.revokedAt ? (
                          <span className="badge badge-inactive">
                            Revoked {new Date(kiosk.revokedAt).toLocaleString()}
                          </span>
                        ) : (
                          <span className="badge badge-active">Active</span>
                        )}
                      </td>
                      <td className="row-actions">
                        {!kiosk.revokedAt && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void revoke(kiosk.id, kiosk.name)}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No kiosks have been paired yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
