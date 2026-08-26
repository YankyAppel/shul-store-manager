import { useEffect, useState, type FormEvent } from 'react';
import {
  LABEL_TEMPLATE_OPTIONS,
  type PrinterInfo,
  type StoreSettings,
  type UpdateCheckResult,
} from '@shul-store/shared';
import { messageFrom } from '../utils/formatters';
import { CloudBackupSection } from './CloudBackupSection';
import { LocalBackupSection } from './LocalBackupSection';

export function SettingsScreen() {
  const [settings, setSettings] = useState<StoreSettings>();
  const [saved, setSaved] = useState(false);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printerError, setPrinterError] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(
    null,
  );
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);

  useEffect(() => {
    void window.storeApi.settings.get().then(setSettings);
    void window.storeApi.app.getVersion().then(setAppVersion);
    void window.storeApi.updates.getState().then(setUpdateResult);
    const unsubscribe = window.storeApi.updates.subscribe(setUpdateResult);
    void window.storeApi.settings
      .listPrinters()
      .then(setPrinters)
      .catch((error) => setPrinterError(messageFrom(error)));
    return unsubscribe;
  }, []);

  if (!settings) return <p>Loading…</p>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    await window.storeApi.settings.update(settings!);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
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
            <select value="USD" disabled>
              <option>USD</option>
            </select>
          </label>
          <label>
            Tax rate (%)
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
        <label>
          Receipt footer
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
            value={settings.updateFeedUrl ?? ''}
            onChange={(e) =>
              setSettings({
                ...settings,
                updateFeedUrl: e.target.value || null,
              })
            }
            placeholder="https://example.org/shul-store-updates"
          />
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.automaticUpdatesEnabled}
            onChange={(e) =>
              setSettings({
                ...settings,
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
        <p style={{ margin: '0 0 10px', color: '#66766d', fontSize: '13px' }}>
          Enable integrated credit card processing. Real processors (Sola, First
          Choice, Donary) will be added later; currently, the Simulated
          processor is available for testing/training.
        </p>

        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.cardProcessingEnabled}
            onChange={(e) => {
              const enabled = e.target.checked;
              const next = { ...settings, cardProcessingEnabled: enabled };
              if (enabled && !next.cardProcessorId) {
                next.cardProcessorId = 'simulated';
              }
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
                <option value="simulated">
                  Simulated card processor (testing)
                </option>
              </select>
            </label>

            {settings.cardProcessorId === 'simulated' && (
              <label>
                Processor Configuration (JSON)
                <textarea
                  value={settings.cardProcessorConfigJson || ''}
                  onChange={(e) => {
                    const next = {
                      ...settings,
                      cardProcessorConfigJson: e.target.value || null,
                    };
                    setSettings(next);
                  }}
                  placeholder="{}"
                />
              </label>
            )}
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

      <CloudBackupSection />
      <LocalBackupSection />
    </>
  );
}
