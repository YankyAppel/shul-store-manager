import { useEffect, useState, type FormEvent } from 'react';
import {
  LABEL_TEMPLATE_OPTIONS,
  type DeviceSettings,
  type ProcessorConfigStatus,
  type PrinterInfo,
  type StoreSettings,
  type UpdateCheckResult,
} from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';
import { CloudBackupSection } from './CloudBackupSection';
import { CloudAccountSection } from './CloudAccountSection';
import { LocalBackupSection } from './LocalBackupSection';
import { StaffSection } from './StaffSection';
import { Explain } from '../components/Explain';

export function SettingsScreen() {
  const [settings, setSettings] = useState<StoreSettings>();
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings>();
  const [processorStatus, setProcessorStatus] =
    useState<ProcessorConfigStatus>();
  const [processorKey, setProcessorKey] = useState('');
  const [usaepayApiPin, setUsaepayApiPin] = useState('');
  const [usaepayDeviceKey, setUsaepayDeviceKey] = useState('');
  const [usaepayTimeout, setUsaepayTimeout] = useState('180');
  const [usaepayPromptTip, setUsaepayPromptTip] = useState(false);
  const [usaepayManualKey, setUsaepayManualKey] = useState(false);
  const [usaepayPairingCode, setUsaepayPairingCode] = useState('');
  const [processorMode, setProcessorMode] = useState<'test' | 'live'>('test');
  const [processorMessage, setProcessorMessage] = useState('');
  const [testingProcessor, setTestingProcessor] = useState(false);
  const [readerDeviceName, setReaderDeviceName] = useState('BBPOS');
  const [readerConnection, setReaderConnection] = useState<'usb' | 'ip'>('usb');
  const [readerComPort, setReaderComPort] = useState('COM3');
  const [readerAddress, setReaderAddress] = useState('');
  const [readerPort, setReaderPort] = useState('');
  const [readerSilentMode, setReaderSilentMode] = useState(false);
  const [readerOnly, setReaderOnly] = useState(false);
  const [readerAmountPrompt, setReaderAmountPrompt] = useState(false);
  const [readerTimeout, setReaderTimeout] = useState('120');
  const [checkingReader, setCheckingReader] = useState(false);
  const [saved, setSaved] = useState(false);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printerError, setPrinterError] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(
    null,
  );
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);

  useEffect(() => {
    void Promise.all([
      window.storeApi.settings.get(),
      window.storeApi.settings.getDevice(),
      window.storeApi.settings.getProcessorConfigStatus(),
    ]).then(([store, device, processor]) => {
      setSettings(store);
      setDeviceSettings(device);
      setProcessorStatus(processor);
      if (processor.processorId)
        setSettings((current) =>
          current
            ? { ...current, cardProcessorId: processor.processorId! }
            : current,
        );
      if (processor.mode) setProcessorMode(processor.mode);
    });
    void window.storeApi.app.getVersion().then(setAppVersion);
    void window.storeApi.updates.getState().then(setUpdateResult);
    const unsubscribe = window.storeApi.updates.subscribe(setUpdateResult);
    void window.storeApi.settings
      .listPrinters()
      .then(setPrinters)
      .catch((error) => setPrinterError(messageFrom(error)));
    return unsubscribe;
  }, []);

  if (!settings || !deviceSettings || !processorStatus) return <p>Loading…</p>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    await window.storeApi.settings.update(settings!);
    setDeviceSettings(
      await window.storeApi.settings.updateDevice(deviceSettings!),
    );
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function saveProcessorConfig() {
    const isUsaepay = settings!.cardProcessorId === 'usaepay-payment-engine';
    const timeoutText = isUsaepay ? usaepayTimeout : readerTimeout;
    const timeoutSeconds = Number(timeoutText);
    const minimumTimeout = isUsaepay ? 30 : 1;
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < minimumTimeout ||
      timeoutSeconds > 600
    ) {
      setProcessorMessage(
        isUsaepay
          ? 'Payment timeout must be a whole number between 30 and 600 seconds.'
          : 'Reader timeout must be a whole number between 1 and 600 seconds.',
      );
      return;
    }
    try {
      const next =
        settings!.cardProcessorId === 'cardknox-bbpos'
          ? JSON.stringify({
              apiKey: processorKey,
              deviceName: readerDeviceName,
              connection:
                readerConnection === 'usb'
                  ? { kind: 'usb', comPort: readerComPort }
                  : {
                      kind: 'ip',
                      address: readerAddress,
                      port: Number(readerPort),
                    },
              silentMode: readerSilentMode,
              readerOnly,
              amountConfirmationPrompt: readerAmountPrompt,
              deviceTimeoutSeconds: timeoutSeconds,
              mode: processorMode,
              processorId: 'cardknox-bbpos',
            })
          : settings!.cardProcessorId === 'usaepay-payment-engine'
            ? JSON.stringify({
                processorId: 'usaepay-payment-engine',
                apiKey: processorKey,
                apiPin: usaepayApiPin,
                deviceKey: usaepayDeviceKey,
                mode: processorMode,
                paymentTimeoutSeconds: timeoutSeconds,
                promptTip: usaepayPromptTip,
                manualKey: usaepayManualKey,
                endpointKey: 'v2',
              })
            : JSON.stringify({
                processorId: settings!.cardProcessorId,
                apiKey: processorKey,
                mode: processorMode,
              });
      const status = await window.storeApi.settings.setProcessorConfig(next);
      setProcessorStatus(status);
      setProcessorKey('');
      setUsaepayApiPin('');
      setProcessorMessage(
        status.configured
          ? 'Processor configuration replaced.'
          : 'Processor configuration cleared.',
      );
    } catch (error) {
      setProcessorMessage(messageFrom(error));
    }
  }

  async function pairUsaepay() {
    try {
      const result = await window.storeApi.settings.pairUsaepayDevice({
        apiKey: processorKey,
        apiPin: usaepayApiPin,
        mode: processorMode,
        name: 'Shul Store Terminal',
      });
      setUsaepayDeviceKey(result.deviceKey);
      setUsaepayPairingCode(result.pairingCode);
      setProcessorMessage(
        `Type pairing code ${result.pairingCode} into the USAePay terminal. It expires at ${result.expiresAt}. Then save the terminal settings.`,
      );
    } catch (error) {
      setProcessorMessage(messageFrom(error));
    }
  }

  async function checkReader() {
    setCheckingReader(true);
    try {
      setProcessorMessage(
        (await window.storeApi.settings.checkReader()).message,
      );
    } catch (error) {
      setProcessorMessage(messageFrom(error));
    } finally {
      setCheckingReader(false);
    }
  }

  async function clearProcessorConfig() {
    try {
      setProcessorStatus(
        await window.storeApi.settings.setProcessorConfig(null),
      );
      setProcessorKey('');
      setProcessorMessage('Processor configuration cleared.');
    } catch (error) {
      setProcessorMessage(messageFrom(error));
    }
  }

  async function testProcessor() {
    setTestingProcessor(true);
    try {
      const result = await window.storeApi.settings.testProcessorConnection({
        processorId:
          settings!.cardProcessorId === 'usaepay-payment-engine'
            ? 'usaepay'
            : ((settings!.cardProcessorId || 'other') as
                'sola' | 'cardknox' | 'usaepay' | 'other'),
        apiKey: processorKey,
        mode: processorMode,
      });
      setProcessorMessage(result.message);
    } catch (error) {
      setProcessorMessage(messageFrom(error));
    } finally {
      setTestingProcessor(false);
    }
  }

  async function checkForUpdates() {
    setCheckingForUpdates(true);
    try {
      setUpdateResult(await window.storeApi.updates.check());
    } catch (error) {
      setUpdateResult({
        status: 'error',
        currentVersion: appVersion,
        availableVersion: null,
        message: messageFrom(error),
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setCheckingForUpdates(false);
    }
  }

  return (
    <>
      <form className="settings-form" onSubmit={(e) => void submit(e)}>
        <h3 style={{ margin: '0 0 4px 0' }}>General Store Settings</h3>
        <label>
          Store name
          <input
            required
            value={settings.storeName}
            onChange={(e) =>
              setSettings({ ...settings, storeName: e.target.value })
            }
          />
        </label>
        <label>
          Receipt contact/address lines <em>One per line</em>
          <textarea
            rows={4}
            value={settings.contactLines.join('\n')}
            onChange={(e) =>
              setSettings({
                ...settings,
                contactLines: e.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
        <div className="form-grid">
          <label>
            Currency
            <div className="detected-value">
              Detected: USD{' '}
              <button type="button" onClick={() => undefined}>
                (change)
              </button>
            </div>
            <select value="USD" disabled aria-label="Currency">
              <option>USD</option>
            </select>
          </label>
          <label>
            Tax rate (%)
            <Explain
              id="tax"
              sentence="This is the sales tax added to taxable products."
            >
              Enter the tax rate your shul must charge so receipts and totals
              are correct.
            </Explain>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={(settings.taxRateBps / 100).toFixed(2)}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  taxRateBps: Math.round(Number(e.target.value) * 100),
                })
              }
            />
          </label>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.pricesIncludeTax}
            onChange={(e) =>
              setSettings({ ...settings, pricesIncludeTax: e.target.checked })
            }
          />{' '}
          Displayed prices include tax
        </label>
        <Explain
          id="prices-include-tax"
          sentence="Turn this on when the prices you show already include tax."
        >
          When this is on, the shelf and checkout price already contains the
          tax; when it is off, tax is added at checkout.
        </Explain>
        <label>
          Receipt footer
          <Explain
            id="receipt-footer"
            sentence="This is the message printed at the bottom of every receipt."
          >
            Add a short thank-you, return policy, phone number, or other note
            for customers to see on their receipt.
          </Explain>
          <textarea
            rows={3}
            value={settings.receiptFooter}
            onChange={(e) =>
              setSettings({ ...settings, receiptFooter: e.target.value })
            }
          />
        </label>

        <hr
          style={{
            border: 'none',
            borderTop: '1px solid #e0e5e2',
            margin: '12px 0',
          }}
        />
        <h3 style={{ margin: '0 0 4px 0' }}>Customer Accounts & Receivables</h3>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.customerAccountsEnabled}
            onChange={(e) =>
              setSettings({
                ...settings,
                customerAccountsEnabled: e.target.checked,
              })
            }
          />{' '}
          Enable customer accounts and &ldquo;Put on Account&rdquo; checkout
        </label>

        <div className="form-grid">
          <label>
            Default customer credit limit ($)
            <input
              type="number"
              min="0"
              step="0.01"
              value={(settings.defaultCreditLimitCents / 100).toFixed(2)}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  defaultCreditLimitCents: Math.round(
                    Number(e.target.value) * 100,
                  ),
                })
              }
            />
          </label>
          <label>
            Days before account is considered overdue
            <input
              type="number"
              min="0"
              max="365"
              step="1"
              value={settings.overdueDays}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  overdueDays: Math.max(0, parseInt(e.target.value, 10) || 0),
                })
              }
            />
          </label>
        </div>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.allowCustomerCredit}
            onChange={(e) =>
              setSettings({
                ...settings,
                allowCustomerCredit: e.target.checked,
              })
            }
          />{' '}
          Allow customer credit balances (negative balance / overpayment)
        </label>

        <label>
          Statement footer
          <textarea
            rows={3}
            value={settings.statementFooter}
            onChange={(e) =>
              setSettings({ ...settings, statementFooter: e.target.value })
            }
            placeholder="e.g. Please settle outstanding balances within 30 days. For questions, contact the shames."
          />
        </label>

        <hr
          style={{
            border: 'none',
            borderTop: '1px solid #e0e5e2',
            margin: '12px 0',
          }}
        />
        <h3 style={{ margin: '0 0 4px 0' }}>Printers</h3>
        <p style={{ margin: '0 0 10px', color: '#66766d', fontSize: '13px' }}>
          Leave a printer on System default to show the print dialog. A named
          printer prints silently; if that device is missing or offline, the
          dialog opens instead.
        </p>
        {printerError && (
          <div className="alert" style={{ marginBottom: '12px' }}>
            Could not list printers: {printerError}
          </div>
        )}
        <div className="form-grid">
          <label>
            Receipt / statement printer
            {settings.receiptPrinterName === null &&
              printers.find((printer) => printer.isDefault) && (
                <div className="detected-value">
                  Detected:{' '}
                  {printers.find((printer) => printer.isDefault)?.displayName ||
                    printers.find((printer) => printer.isDefault)?.name}{' '}
                  <button type="button" onClick={() => undefined}>
                    (change)
                  </button>
                </div>
              )}
            <select
              value={settings.receiptPrinterName ?? ''}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  receiptPrinterName: e.target.value || null,
                })
              }
            >
              <option value="">System default (show print dialog)</option>
              {printers.map((printer) => (
                <option key={printer.name} value={printer.name}>
                  {printer.displayName || printer.name}
                  {printer.isDefault ? ' (OS default)' : ''}
                </option>
              ))}
              {settings.receiptPrinterName &&
                !printers.some(
                  (printer) => printer.name === settings.receiptPrinterName,
                ) && (
                  <option value={settings.receiptPrinterName}>
                    {settings.receiptPrinterName} (not found)
                  </option>
                )}
            </select>
          </label>
          <label>
            Receipt paper width
            <select
              value={settings.receiptPaperWidthMm}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  receiptPaperWidthMm: Number(e.target.value) === 58 ? 58 : 80,
                })
              }
            >
              <option value={80}>80 mm</option>
              <option value={58}>58 mm</option>
            </select>
          </label>
          <label>
            Label printer
            <select
              value={settings.labelPrinterName ?? ''}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  labelPrinterName: e.target.value || null,
                })
              }
            >
              <option value="">System default (show print dialog)</option>
              {printers.map((printer) => (
                <option key={printer.name} value={printer.name}>
                  {printer.displayName || printer.name}
                  {printer.isDefault ? ' (OS default)' : ''}
                </option>
              ))}
              {settings.labelPrinterName &&
                !printers.some(
                  (printer) => printer.name === settings.labelPrinterName,
                ) && (
                  <option value={settings.labelPrinterName}>
                    {settings.labelPrinterName} (not found)
                  </option>
                )}
            </select>
          </label>
          <label>
            Default label template
            <select
              value={settings.defaultLabelTemplate}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  defaultLabelTemplate: e.target.value as
                    'thermal_40x30' | 'thermal_57x32' | 'letter_avery_5160',
                })
              }
            >
              {LABEL_TEMPLATE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label>
          Update feed URL <em>Optional override; blank uses GitHub Releases</em>
          <input
            type="url"
            value={deviceSettings.updateFeedUrl ?? ''}
            onChange={(e) =>
              setDeviceSettings({
                ...deviceSettings,
                updateFeedUrl: e.target.value || null,
              })
            }
            placeholder="https://example.org/shul-store-updates"
          />
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={deviceSettings.automaticUpdatesEnabled}
            onChange={(e) =>
              setDeviceSettings({
                ...deviceSettings,
                automaticUpdatesEnabled: e.target.checked,
              })
            }
          />{' '}
          Download updates automatically and install when the app closes
        </label>
        <div className="settings-version-row">
          <span>
            Installed version: <strong>{appVersion || 'Loading…'}</strong>
          </span>
          <button
            type="button"
            onClick={() => void checkForUpdates()}
            disabled={checkingForUpdates}
          >
            {checkingForUpdates ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
        {updateResult && (
          <p
            className={`settings-update-result settings-update-result-${updateResult.status}`}
          >
            {updateResult.status === 'downloaded' && (
              <strong>Update ready: </strong>
            )}
            {updateResult.message}
            {updateResult.checkedAt && (
              <small>
                {' '}
                (last checked{' '}
                {new Date(updateResult.checkedAt).toLocaleString()})
              </small>
            )}
          </p>
        )}

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button className="primary">Save settings</button>
          {saved && (
            <span style={{ color: '#1c6448', fontWeight: 'bold' }}>
              Settings saved locally.
            </span>
          )}
        </div>
      </form>

      <hr
        style={{
          border: 'none',
          borderTop: '1px solid #e0e5e2',
          margin: '24px 0',
        }}
      />
      <div className="settings-form">
        <h3 style={{ margin: '0 0 4px 0' }}>Card processing</h3>
        <Explain
          id="processor-setup"
          sentence="This connects the manager to the card processor you use."
        >
          Card processing is optional. Your processor settings stay on this
          computer and are never shared with the cloud.
        </Explain>
        <p style={{ margin: '0 0 10px', color: '#66766d', fontSize: '13px' }}>
          Test the connection with a small sandbox authorization. It is voided
          immediately and is not a customer charge.
        </p>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.cardProcessingEnabled}
            onChange={(e) => {
              const enabled = e.target.checked;
              const next = { ...settings, cardProcessingEnabled: enabled };
              if (enabled && !next.cardProcessorId)
                next.cardProcessorId = 'simulated';
              setSettings(next);
            }}
          />
          Enable integrated card processing
        </label>

        {settings.cardProcessingEnabled && (
          <>
            <label>
              Processor
              <select
                value={settings.cardProcessorId || ''}
                onChange={(e) => {
                  const next = {
                    ...settings,
                    cardProcessorId: e.target.value || null,
                  };
                  setSettings(next);
                }}
              >
                <option value="">None</option>
                <option value="simulated">Simulated (training)</option>
                <option value="sola">Sola</option>
                <option value="cardknox">Cardknox</option>
                <option value="cardknox-bbpos">
                  Sola / Cardknox BBPOS reader
                </option>
                <option value="usaepay-payment-engine">
                  USAePay terminal (Payment Engine)
                </option>
                <option value="other">Other (request)</option>
              </select>
            </label>
            <label>
              Processor key
              <input
                type="password"
                value={processorKey}
                onChange={(e) => setProcessorKey(e.target.value)}
                placeholder={processorStatus.keyHint || 'Enter key on this PC'}
                autoComplete="off"
              />
            </label>
            {settings.cardProcessorId === 'usaepay-payment-engine' && (
              <>
                <Explain
                  id="usaepay-terminal-setup"
                  sentence="This connects the manager to a USAePay card terminal through Payment Engine."
                >
                  Enter the USAePay source key and API PIN from the merchant
                  account. Pair the standalone terminal here, then type the
                  short pairing code into the terminal. Card data stays on the
                  terminal and is never handled by this app.
                </Explain>
                <label>
                  USAePay API PIN
                  <input
                    type="password"
                    value={usaepayApiPin}
                    onChange={(event) => setUsaepayApiPin(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label>
                  USAePay device key
                  <input
                    value={usaepayDeviceKey}
                    onChange={(event) =>
                      setUsaepayDeviceKey(event.target.value)
                    }
                    placeholder="Pair the terminal to fill this"
                  />
                </label>
                <label>
                  Payment timeout (seconds)
                  <input
                    inputMode="numeric"
                    value={usaepayTimeout}
                    onChange={(event) => setUsaepayTimeout(event.target.value)}
                  />
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={usaepayPromptTip}
                    onChange={(event) =>
                      setUsaepayPromptTip(event.target.checked)
                    }
                  />
                  Ask the terminal for a tip
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={usaepayManualKey}
                    onChange={(event) =>
                      setUsaepayManualKey(event.target.checked)
                    }
                  />
                  Allow manual card entry on the terminal
                </label>
                <button
                  type="button"
                  onClick={() => void pairUsaepay()}
                  disabled={!processorKey.trim() || !usaepayApiPin.trim()}
                >
                  Pair terminal
                </button>
                {usaepayPairingCode && (
                  <p>
                    Pairing code: <strong>{usaepayPairingCode}</strong>
                  </p>
                )}
              </>
            )}
            {settings.cardProcessorId === 'cardknox-bbpos' && (
              <>
                <Explain
                  id="bbpos-reader-setup"
                  sentence="This reader lets this PC take card payments without a countertop terminal."
                >
                  Install BBPOS on this PC from
                  https://cdn.cardknox.com/dl/bbpos.exe. Sola must activate
                  BBPOS on your account, and the reader must be bought
                  key-injected from Sola. PIN debit is not supported, and
                  Augusta does not support tap. The reader must stay connected
                  to this manager or kiosk computer.
                </Explain>
                <label>
                  Reader device name
                  <input
                    value={readerDeviceName}
                    onChange={(event) =>
                      setReaderDeviceName(event.target.value)
                    }
                  />
                </label>
                <label>
                  Reader connection
                  <select
                    value={readerConnection}
                    onChange={(event) =>
                      setReaderConnection(event.target.value as 'usb' | 'ip')
                    }
                  >
                    <option value="usb">USB</option>
                    <option value="ip">Network reader</option>
                  </select>
                </label>
                {readerConnection === 'usb' ? (
                  <label>
                    USB COM port
                    <input
                      value={readerComPort}
                      onChange={(event) => setReaderComPort(event.target.value)}
                      placeholder="COM3"
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      Reader IP address
                      <input
                        value={readerAddress}
                        onChange={(event) =>
                          setReaderAddress(event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Reader IP port
                      <input
                        value={readerPort}
                        onChange={(event) => setReaderPort(event.target.value)}
                      />
                    </label>
                  </>
                )}
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={readerSilentMode}
                    onChange={(event) =>
                      setReaderSilentMode(event.target.checked)
                    }
                  />
                  Hide the BBPOS form
                  <small>
                    When off, the cashier can use the reader or BBPOS’s own
                    card-number form. When on, only the reader is allowed.
                  </small>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={readerOnly}
                    onChange={(event) => setReaderOnly(event.target.checked)}
                  />
                  Reader only — do not allow card-number typing
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={readerAmountPrompt}
                    onChange={(event) =>
                      setReaderAmountPrompt(event.target.checked)
                    }
                  />
                  Ask customer to confirm amount
                </label>
                <label>
                  Reader timeout (seconds)
                  <input
                    inputMode="numeric"
                    value={readerTimeout}
                    onChange={(event) => setReaderTimeout(event.target.value)}
                  />
                </label>
              </>
            )}
            <label>
              Mode
              <select
                value={processorMode}
                onChange={(e) =>
                  setProcessorMode(e.target.value as 'test' | 'live')
                }
              >
                <option value="test">Test</option>
                <option value="live">Live</option>
              </select>
            </label>
            <p style={{ color: '#66766d', fontSize: '13px' }}>
              {processorStatus.configured
                ? processorStatus.encrypted
                  ? 'Configured, encrypted by this PC'
                  : 'Configured, stored unencrypted — OS keychain unavailable'
                : 'Not configured'}
            </p>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {processorStatus.configured && (
                <button
                  type="button"
                  onClick={() => {
                    setProcessorKey('');
                    void clearProcessorConfig();
                  }}
                >
                  Clear configuration
                </button>
              )}
              <button
                type="button"
                onClick={() => void saveProcessorConfig()}
                disabled={
                  !processorKey.trim() ||
                  settings.cardProcessorId === 'other' ||
                  (settings.cardProcessorId === 'usaepay-payment-engine' &&
                    (!usaepayApiPin.trim() || !usaepayDeviceKey.trim()))
                }
              >
                Save processor key
              </button>
              <button
                type="button"
                onClick={() => void testProcessor()}
                disabled={
                  testingProcessor ||
                  !processorKey.trim() ||
                  settings.cardProcessorId === 'other' ||
                  settings.cardProcessorId === 'cardknox-bbpos' ||
                  settings.cardProcessorId === 'usaepay-payment-engine'
                }
              >
                {testingProcessor ? 'Testing…' : 'Test connection'}
              </button>
              {(settings.cardProcessorId === 'cardknox-bbpos' ||
                settings.cardProcessorId === 'usaepay-payment-engine') && (
                <button
                  type="button"
                  onClick={() => void checkReader()}
                  disabled={checkingReader || !processorStatus.configured}
                >
                  {checkingReader
                    ? 'Checking terminal…'
                    : settings.cardProcessorId === 'usaepay-payment-engine'
                      ? 'Check terminal'
                      : 'Check reader'}
                </button>
              )}
              {processorMessage && <span>{processorMessage}</span>}
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button
            className="primary"
            onClick={(e) => {
              e.preventDefault();
              void submit(e);
            }}
          >
            Save settings
          </button>
        </div>
      </div>

      <hr
        style={{
          border: 'none',
          borderTop: '1px solid #e0e5e2',
          margin: '24px 0',
        }}
      />

      <Explain
        id="cloud-sync"
        sentence="Cloud sync keeps a backup of this store available on your other computers."
      >
        Cloud sync is optional. Sales and checkout continue on this computer
        when the internet is unavailable, and changes are sent when it returns.
      </Explain>
      <CloudAccountSection />
      <Explain
        id="backups"
        sentence="Backups are extra copies of your store records in case this computer has a problem."
      >
        Local backups stay on this computer, while cloud sync can keep your
        store available on another signed-in computer.
      </Explain>
      <CloudBackupSection />
      <LocalBackupSection />
      <Explain
        id="staff-permissions"
        sentence="Staff permissions choose which parts of the manager each cashier can use."
      >
        Owners can always do everything. Cashier permissions let you give access
        to only the work each person needs.
      </Explain>
      <StaffSection />
    </>
  );
}
