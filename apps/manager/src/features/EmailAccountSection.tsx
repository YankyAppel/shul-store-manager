import { useEffect, useState } from 'react';
import {
  EMAIL_PRESETS,
  type EmailConfig,
  type EmailConfigStatus,
} from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';

type PresetId = (typeof EMAIL_PRESETS)[number]['id'];

function presetFor(host: string | null): PresetId {
  return (
    EMAIL_PRESETS.find((preset) => preset.host && preset.host === host)?.id ??
    'custom'
  );
}

/**
 * The seller's own mailbox (Gmail app password, Microsoft 365, …) used to
 * send purchase orders. The password is kept in the OS keychain-encrypted
 * secret store and never returned to the renderer.
 */
export function EmailAccountSection() {
  const [status, setStatus] = useState<EmailConfigStatus | null>(null);
  const [preset, setPreset] = useState<PresetId>('gmail');
  const [host, setHost] = useState('smtp.gmail.com');
  const [port, setPort] = useState('465');
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [ccSelf, setCcSelf] = useState(true);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | 'google' | null>(
    null,
  );
  const gmailLinked = status?.configured && status.authType === 'gmail';
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const value = await window.storeApi.email.status();
      setStatus(value);
      if (value.configured) {
        setPreset(presetFor(value.host));
        setHost(value.host ?? '');
        setPort(String(value.port ?? 587));
        setSecure(value.secure ?? false);
        setUsername(value.username ?? '');
        setFromName(value.fromName ?? '');
        setFromAddress(value.fromAddress ?? '');
        setCcSelf(value.ccSelf);
      }
    } catch (e) {
      setError(messageFrom(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  function choosePreset(id: PresetId) {
    setPreset(id);
    const found = EMAIL_PRESETS.find((candidate) => candidate.id === id);
    if (!found || id === 'custom') return;
    setHost(found.host);
    setPort(String(found.port));
    setSecure(found.secure);
  }

  function buildConfig(): EmailConfig | null {
    const portNumber = Number(port);
    if (!host.trim() || !Number.isInteger(portNumber) || portNumber < 1) {
      setError('Enter the mail server host and port.');
      return null;
    }
    if (!fromAddress.trim()) {
      setError('Enter the email address orders should be sent from.');
      return null;
    }
    if (!password && !status?.configured) {
      setError('Enter the password or app password for this mailbox.');
      return null;
    }
    return {
      host: host.trim(),
      port: portNumber,
      secure,
      username: username.trim() || fromAddress.trim(),
      password,
      authType: 'password',
      oauth: null,
      fromName: fromName.trim() || 'Store',
      fromAddress: fromAddress.trim(),
      ccSelf,
    };
  }

  /** Keeps the saved Gmail grant; only name / copy-me can change here. */
  function gmailConfig(): EmailConfig | null {
    if (!gmailLinked || !status) return null;
    return {
      host: status.host ?? 'smtp.gmail.com',
      port: status.port ?? 465,
      secure: status.secure ?? true,
      username: status.username ?? status.fromAddress ?? '',
      password: '',
      authType: 'gmail',
      oauth: null,
      fromName: fromName.trim() || 'Store',
      fromAddress: status.fromAddress ?? '',
      ccSelf,
    };
  }

  async function connectGoogle() {
    setBusy('google');
    setError('');
    setNotice('Finish signing in with Google in your browser…');
    try {
      setStatus(
        await window.storeApi.email.connectGmail({
          fromName: fromName.trim(),
          ccSelf,
        }),
      );
      setPassword('');
      setNotice('Gmail account linked. Queued orders will be sent now.');
    } catch (e) {
      setNotice('');
      setError(messageFrom(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const config = gmailConfig() ?? buildConfig();
    if (!config) return;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      setStatus(await window.storeApi.email.save(config));
      setPassword('');
      setNotice('Email account saved. Queued orders will be sent now.');
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    const config = gmailConfig() ?? buildConfig();
    if (!config) return;
    setBusy('test');
    setError('');
    setNotice('');
    try {
      const result = await window.storeApi.email.test(
        config,
        testTo.trim() || null,
      );
      if (result.ok)
        setNotice(
          testTo.trim()
            ? `Connected and sent a test email to ${testTo.trim()}.`
            : 'Connected to the mail server successfully.',
        );
      else setError(result.error ?? 'Connection failed.');
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    if (!window.confirm('Remove the saved email account?')) return;
    setBusy('clear');
    setError('');
    try {
      setStatus(await window.storeApi.email.clear());
      setPassword('');
      setNotice('Email account removed.');
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="settings-form"
      style={{
        borderTop: '1px solid rgba(5,11,8,0.10)',
        marginTop: 16,
        paddingTop: 16,
      }}
    >
      <h3 style={{ margin: '0 0 4px 0' }}>Order emails</h3>
      <p style={{ margin: '0 0 12px', color: '#5f6d65', fontSize: '13px' }}>
        Purchase orders are emailed to vendors from <strong>your own</strong>{' '}
        mailbox, so replies come straight back to you.{' '}
        {status?.gmailAvailable
          ? 'Gmail and Google Workspace users can simply sign in with Google; other providers need the mailbox password or an App Password.'
          : 'For Gmail or Google Workspace, create an App Password (Google Account → Security → 2-Step Verification → App passwords) and use it here instead of your normal password.'}
      </p>
      {status?.gmailAvailable && !gmailLinked && (
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginBottom: 12,
          }}
        >
          <button
            className="primary"
            disabled={busy !== null}
            onClick={() => void connectGoogle()}
          >
            {busy === 'google' ? 'Waiting for Google…' : 'Sign in with Google'}
          </button>
          <span className="muted">or set up any mailbox below</span>
        </div>
      )}
      {status?.configured && (
        <p className="hint">
          Sending as <b>{status.fromName}</b> &lt;{status.fromAddress}&gt;{' '}
          {gmailLinked ? 'via Google sign-in' : `via ${status.host}`}
          {status.pendingCount > 0 &&
            ` · ${status.pendingCount} email(s) waiting to send`}
          {status.failedCount > 0 &&
            ` · ${status.failedCount} failed (see the vendor's order list)`}
          {!status.encrypted &&
            ' · password stored without OS encryption on this device'}
        </p>
      )}
      <div className="form-grid">
        {!gmailLinked && (
          <label>
            Email provider
            <select
              value={preset}
              onChange={(e) => choosePreset(e.target.value as PresetId)}
            >
              {EMAIL_PRESETS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {!gmailLinked && (
          <label>
            Send from address
            <input
              type="email"
              value={fromAddress}
              placeholder="orders@yourstore.com"
              onChange={(e) => setFromAddress(e.target.value)}
            />
          </label>
        )}
        <label>
          Sender name
          <input
            value={fromName}
            placeholder="Your store name"
            maxLength={100}
            onChange={(e) => setFromName(e.target.value)}
          />
        </label>
        {!gmailLinked && (
          <label>
            Username <em>Usually the email address</em>
            <input
              value={username}
              placeholder={fromAddress || 'you@example.com'}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
        )}
        {!gmailLinked && (
          <label>
            Password / app password
            <input
              type="password"
              value={password}
              placeholder={
                status?.configured ? 'Saved — enter to replace' : 'App password'
              }
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {!gmailLinked && preset === 'custom' && (
          <>
            <label>
              SMTP host
              <input
                value={host}
                placeholder="smtp.example.com"
                onChange={(e) => setHost(e.target.value)}
              />
            </label>
            <label>
              Port
              <input
                type="number"
                min="1"
                max="65535"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={secure}
                onChange={(e) => setSecure(e.target.checked)}
              />{' '}
              Use SSL (port 465). Off = STARTTLS (port 587)
            </label>
          </>
        )}
        <label className="toggle">
          <input
            type="checkbox"
            checked={ccSelf}
            onChange={(e) => setCcSelf(e.target.checked)}
          />{' '}
          Send me a copy of every order
        </label>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginTop: 12,
        }}
      >
        <button
          className="primary"
          disabled={busy !== null}
          onClick={() => void save()}
        >
          {busy === 'save' ? 'Saving…' : 'Save email account'}
        </button>
        {gmailLinked && (
          <button disabled={busy !== null} onClick={() => void connectGoogle()}>
            {busy === 'google'
              ? 'Waiting for Google…'
              : 'Switch Google account'}
          </button>
        )}
        <input
          type="email"
          value={testTo}
          placeholder="Send test to… (optional)"
          style={{ width: 220 }}
          onChange={(e) => setTestTo(e.target.value)}
        />
        <button disabled={busy !== null} onClick={() => void test()}>
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        {status?.configured && (
          <button disabled={busy !== null} onClick={() => void clear()}>
            Remove
          </button>
        )}
      </div>
      {notice && (
        <div className="success" style={{ marginTop: 12 }}>
          {notice}
        </div>
      )}
      {error && (
        <div className="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </section>
  );
}
