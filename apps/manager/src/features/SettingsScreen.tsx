import { useEffect, useState, type FormEvent } from 'react';
import type { StoreSettings } from '@shul-store/shared';
export function SettingsScreen() {
  const [settings, setSettings] = useState<StoreSettings>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void window.storeApi.settings.get().then(setSettings);
  }, []);
  if (!settings) return <p>Loading…</p>;
  async function submit(event: FormEvent) {
    event.preventDefault();
    await window.storeApi.settings.update(settings!);
    setSaved(true);
  }
  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)}>
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
      <button className="primary">Save settings</button>
      {saved && <span>Settings saved locally.</span>}
    </form>
  );
}
