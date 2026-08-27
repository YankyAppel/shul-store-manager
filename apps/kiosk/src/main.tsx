import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type KioskCartLine,
  type KioskPriceQuote,
  type KioskPublicState,
  type KioskReaderConfig,
  type UpdateCheckResult,
} from '@shul-store/shared';
import './style.css';

const IDLE_RESET_MS = 60000;
const APPROVED_SCREEN_TIMEOUT_MS = 15000;
const PAIRING_CODE_LENGTH = 6;
const ADMIN_PIN_LENGTH = 12;

type Screen =
  | 'attract'
  | 'shopping'
  | 'paying'
  | 'approved'
  | 'declined'
  | 'recovery'
  | 'unreachable';

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function Keypad({
  value,
  onChange,
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
}) {
  const press = (key: string) => {
    if (key === 'clear') return onChange('');
    if (key === 'back') return onChange(value.slice(0, -1));
    if (value.length < maxLength) onChange(`${value}${key}`);
  };
  return (
    <div className="keypad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].map(
        (key) => (
          <button
            type="button"
            className={key === 'clear' || key === 'back' ? 'secondary' : ''}
            key={key}
            onClick={() => press(key)}
          >
            {key === 'clear' ? 'Clear' : key === 'back' ? '⌫' : key}
          </button>
        ),
      )}
    </div>
  );
}

function PairingScreen({
  state,
  onPaired,
}: {
  state: KioskPublicState;
  onPaired: (next: KioskPublicState) => void;
}) {
  const [host, setHost] = useState(state.host);
  const [port, setPort] = useState(String(state.port || 3939));
  const [code, setCode] = useState('');
  const [name, setName] = useState(state.kioskName || 'Kiosk');
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [cloudMode, setCloudMode] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const managers = state.discoveredManagers;
  useEffect(() => {
    void window.kioskApi.startDiscovery().catch(() => undefined);
    return () => {
      void window.kioskApi.stopDiscovery();
    };
  }, []);
  function selectManager(hostname: string, managerPort: number) {
    setHost(hostname);
    setPort(String(managerPort));
    setAdvanced(true);
  }
  async function pair() {
    setBusy(true);
    setMessage('');
    setSuccessMessage('');
    try {
      const next = await window.kioskApi.pair({
        host: host.trim(),
        port: Number(port),
        code,
        name: name.trim(),
        adminPin: pin,
      });
      onPaired(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Pairing failed.');
    } finally {
      setBusy(false);
    }
  }
  async function cloudSignIn(signUp: boolean) {
    setBusy(true);
    setMessage('');
    try {
      const next = await (
        signUp ? window.kioskApi.cloudSignUp : window.kioskApi.cloudSignIn
      )({
        email: email.trim(),
        password,
        adminPin: pin,
      });
      onPaired(next);
    } catch (error) {
      const text =
        error instanceof Error ? error.message : 'Cloud setup failed.';
      if (signUp && text.startsWith('Account created')) setSuccessMessage(text);
      else setMessage(text);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="setup-screen">
      <h1>Set up this self-checkout</h1>
      <div className="mode-switch">
        <button
          type="button"
          className={cloudMode ? 'primary' : 'secondary'}
          onClick={() => setCloudMode(true)}
        >
          Sign in with the store's cloud account
        </button>
        <button
          type="button"
          className={!cloudMode ? 'primary' : 'secondary'}
          onClick={() => setCloudMode(false)}
        >
          Pair over the local network
        </button>
      </div>
      {cloudMode ? (
        <>
          <p>Use the same POS cloud account as the shul's manager.</p>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            Admin PIN for this kiosk
            <output className="pin-display">
              {pin ? '•'.repeat(pin.length) : 'Enter 4–12 digits'}
            </output>
          </label>
          <Keypad value={pin} onChange={setPin} maxLength={ADMIN_PIN_LENGTH} />
          {message && <p className="error-message">{message}</p>}
          {successMessage && (
            <p className="success-message">{successMessage}</p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="primary wide-button"
              disabled={busy || !email.trim() || !password || pin.length < 4}
              onClick={() => void cloudSignIn(false)}
            >
              {busy ? 'Signing in…' : 'Sign in and set up kiosk'}
            </button>
            <button
              type="button"
              className="secondary wide-button"
              disabled={busy || !email.trim() || !password || pin.length < 4}
              onClick={() => void cloudSignIn(true)}
            >
              Create cloud account
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Choose your store, then enter the six-digit pairing code shown by
            the shames.
          </p>
          {managers.length > 0 ? (
            <div className="manager-list">
              {managers.map((manager) => (
                <button
                  type="button"
                  className="secondary wide-button"
                  key={`${manager.host}:${manager.port}`}
                  onClick={() => selectManager(manager.host, manager.port)}
                >
                  {manager.storeName}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">
              No manager found yet. If this continues, open Advanced below.
            </p>
          )}
          <button
            type="button"
            className="secondary wide-button"
            onClick={() => setAdvanced((value) => !value)}
          >
            {advanced ? 'Hide Advanced' : 'Advanced'}
          </button>
          {advanced && (
            <>
              <label>
                Manager host
                <input
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                />
              </label>
              <label>
                Port
                <input
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </label>
            </>
          )}
          <label>
            Kiosk name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Six-digit pairing code
            <output className="pin-display">
              {code || '—'.repeat(PAIRING_CODE_LENGTH)}
            </output>
          </label>
          <Keypad
            value={code}
            onChange={setCode}
            maxLength={PAIRING_CODE_LENGTH}
          />
          <label>
            Admin PIN for this kiosk
            <output className="pin-display">
              {pin ? '•'.repeat(pin.length) : 'Enter 4–12 digits'}
            </output>
          </label>
          <Keypad value={pin} onChange={setPin} maxLength={ADMIN_PIN_LENGTH} />
          {message && <p className="error-message">{message}</p>}
          <button
            type="button"
            className="primary wide-button"
            disabled={
              busy ||
              code.length !== 6 ||
              pin.length < 4 ||
              !host.trim() ||
              !Number(port)
            }
            onClick={() => void pair()}
          >
            {busy ? 'Pairing…' : 'Pair this kiosk'}
          </button>
          <p className="setup-exit-hint">
            To exit kiosk mode: tap the store name 5 times or press the Shames
            button, then enter the admin PIN.
          </p>
        </>
      )}
      <KioskReaderSetup status={state.readerStatus} />
    </main>
  );
}

function KioskReaderSetup({
  status,
}: {
  status: KioskPublicState['readerStatus'];
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [deviceName, setDeviceName] = useState('BBPOS');
  const [connection, setConnection] = useState<'usb' | 'ip'>('usb');
  const [comPort, setComPort] = useState('COM3');
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('');
  const [silentMode, setSilentMode] = useState(true);
  const [readerOnly, setReaderOnly] = useState(true);
  const [amountConfirmationPrompt, setAmountConfirmationPrompt] =
    useState(false);
  const [timeout, setTimeoutValue] = useState('120');
  const [mode, setMode] = useState<'test' | 'live'>('live');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMessage('');
    const config: KioskReaderConfig = {
      apiKey,
      deviceName,
      connection:
        connection === 'usb'
          ? { kind: 'usb', comPort }
          : { kind: 'ip', address, port: Number(port) },
      silentMode,
      readerOnly,
      amountConfirmationPrompt,
      deviceTimeoutSeconds: Number(timeout),
      mode,
    };
    try {
      await window.kioskApi.saveReaderConfig(config);
      setApiKey('');
      setMessage('Reader settings saved on this kiosk.');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Reader setup failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    try {
      setMessage((await window.kioskApi.checkReader()).message);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Reader check failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="reader-setup">
      <button
        type="button"
        className="secondary"
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide card reader setup' : 'Card reader setup'}
      </button>
      {open && (
        <>
          <KioskExplain
            id="bbpos-reader-setup"
            sentence="This reader lets this kiosk take card payments without a countertop terminal."
          >
            Install BBPOS on the Windows computer from
            https://cdn.cardknox.com/dl/bbpos.exe. Sola must activate BBPOS and
            key-inject the reader. PIN debit is not supported, and Augusta has
            no tap. The reader must stay connected to this kiosk computer.
          </KioskExplain>
          <p>
            {status.configured
              ? `Configured (${status.keyHint ?? 'key saved'}).`
              : 'Not configured.'}
          </p>
          <label>
            Sola / Cardknox key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label>
            Reader device name
            <input
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </label>
          <label>
            Connection
            <select
              value={connection}
              onChange={(event) =>
                setConnection(event.target.value as 'usb' | 'ip')
              }
            >
              <option value="usb">USB</option>
              <option value="ip">Network reader</option>
            </select>
          </label>
          {connection === 'usb' ? (
            <label>
              USB COM port
              <input
                value={comPort}
                onChange={(event) => setComPort(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label>
                Reader IP address
                <input
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
              </label>
              <label>
                Reader IP port
                <input
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </label>
            </>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={silentMode}
              onChange={(event) => setSilentMode(event.target.checked)}
            />
            Hide the BBPOS form
            <small>
              When on, customers can use only the reader. When off, BBPOS may
              show its own card-number form.
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
              checked={amountConfirmationPrompt}
              onChange={(event) =>
                setAmountConfirmationPrompt(event.target.checked)
              }
            />
            Ask customer to confirm amount
          </label>
          <label>
            Reader timeout (seconds)
            <input
              inputMode="numeric"
              value={timeout}
              onChange={(event) => setTimeoutValue(event.target.value)}
            />
          </label>
          <label>
            Reader mode
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as 'test' | 'live')
              }
            >
              <option value="live">Live</option>
              <option value="test">Test</option>
            </select>
          </label>
          {message && <p className="error-message">{message}</p>}
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy || !apiKey.trim()}
              onClick={() => void save()}
            >
              Save reader settings
            </button>
            <button
              type="button"
              disabled={busy || !status.configured}
              onClick={() => void check()}
            >
              Check reader
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function KioskExplain({
  id,
  sentence,
  children,
}: {
  id: string;
  sentence: string;
  children: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void window.kioskApi
      .getExplanationDismissed(id)
      .then(setDismissed)
      .catch(() => undefined);
  }, [id]);
  if (dismissed) return null;
  return (
    <div className="explain">
      <p>{sentence}</p>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide explanation' : 'What is this?'}
      </button>
      {open && <p className="explain-detail">{children}</p>}
      <button
        type="button"
        className="explain-dismiss"
        onClick={() => {
          setDismissed(true);
          void window.kioskApi.dismissExplanation(id);
        }}
      >
        Don&apos;t show this again
      </button>
    </div>
  );
}

function AdminOverlay({
  onClose,
  readerStatus,
}: {
  onClose: () => void;
  readerStatus: KioskPublicState['readerStatus'];
}) {
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(
    null,
  );
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);

  useEffect(() => {
    if (!unlocked) return;
    void window.kioskApi.updates.getState().then(setUpdateResult);
    return window.kioskApi.updates.subscribe(setUpdateResult);
  }, [unlocked]);

  async function verify() {
    setBusy(true);
    const result = await window.kioskApi.verifyAdminPin(pin);
    setBusy(false);
    if (result.ok) setUnlocked(true);
    else setMessage(result.message);
  }

  async function checkForUpdates() {
    setCheckingForUpdates(true);
    try {
      setUpdateResult(await window.kioskApi.updates.check());
    } catch (error) {
      setUpdateResult({
        status: 'error',
        currentVersion: updateResult?.currentVersion ?? '',
        availableVersion: null,
        message:
          error instanceof Error ? error.message : 'Update check failed.',
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setCheckingForUpdates(false);
    }
  }

  return (
    <div className="admin-overlay">
      <section className="admin-dialog">
        <h2>Shames controls</h2>
        {!unlocked ? (
          <>
            <p>Enter the kiosk admin PIN.</p>
            <output className="pin-display">
              {pin ? '•'.repeat(pin.length) : '—'}
            </output>
            <Keypad
              value={pin}
              onChange={setPin}
              maxLength={ADMIN_PIN_LENGTH}
            />
            {message && <p className="error-message">{message}</p>}
            <button
              type="button"
              className="primary wide-button"
              disabled={busy || pin.length < 4}
              onClick={() => void verify()}
            >
              {busy ? 'Checking…' : 'Unlock'}
            </button>
          </>
        ) : (
          <>
            <KioskReaderSetup status={readerStatus} />
            <section className="kiosk-updates">
              <KioskExplain
                id="kiosk-automatic-updates"
                sentence="The kiosk checks for updates in the background and installs them when it closes."
              >
                Updates are downloaded quietly so customers do not see an
                installer. The kiosk restarts with the new version after it is
                closed.
              </KioskExplain>
              <div className="settings-version-row">
                <span>
                  Installed version:{' '}
                  <strong>{updateResult?.currentVersion || 'Loading…'}</strong>
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
            </section>
            <div className="admin-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void window.kioskApi.exitKiosk()}
              >
                Exit to desktop
              </button>
              <button
                type="button"
                onClick={() => void window.kioskApi.restart()}
              >
                Restart kiosk
              </button>
            </div>
          </>
        )}
        <button
          type="button"
          className="secondary wide-button"
          onClick={onClose}
        >
          Cancel
        </button>
      </section>
    </div>
  );
}

function App() {
  const [state, setState] = useState<KioskPublicState>();
  const [screen, setScreen] = useState<Screen>('unreachable');
  const [cart, setCart] = useState<KioskCartLine[]>([]);
  const [quote, setQuote] = useState<KioskPriceQuote>();
  const [message, setMessage] = useState('');
  const [categoryId, setCategoryId] = useState<string>();
  const [adminOpen, setAdminOpen] = useState(false);
  const [rePairing, setRePairing] = useState(false);
  const scannerBuffer = useRef('');
  const scannerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const storeNameTaps = useRef<number[]>([]);

  useEffect(() => {
    let active = true;
    void window.kioskApi.getState().then((next) => {
      if (active) setState(next);
    });
    const unsubscribe = window.kioskApi.subscribe((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    if (state.connection === 'revoked') setScreen('unreachable');
    else if (state.inFlightCharge) setScreen('recovery');
    else if (state.connection === 'unpaired') setScreen('unreachable');
    else if (!state.catalog && state.connection === 'manager-unreachable')
      setScreen('unreachable');
    else if (screen === 'unreachable') setScreen('attract');
  }, [state, screen]);

  useEffect(() => {
    if (screen !== 'shopping' || cart.length === 0) return;
    const timer = setTimeout(() => {
      setCart([]);
      setQuote(undefined);
      setMessage('');
      setScreen('attract');
    }, IDLE_RESET_MS);
    return () => clearTimeout(timer);
  }, [cart, screen]);

  useEffect(() => {
    if (screen !== 'approved') return;
    const timer = setTimeout(() => {
      setCart([]);
      setQuote(undefined);
      setMessage('');
      setScreen('attract');
    }, APPROVED_SCREEN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [screen]);

  useEffect(() => {
    if (screen !== 'shopping') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        const barcode = scannerBuffer.current;
        scannerBuffer.current = '';
        if (barcode) void addBarcode(barcode);
        return;
      }
      if (event.key.length === 1) {
        scannerBuffer.current += event.key;
        if (scannerTimer.current) clearTimeout(scannerTimer.current);
        scannerTimer.current = setTimeout(() => {
          scannerBuffer.current = '';
        }, 250);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [screen, cart]);

  useEffect(() => {
    if (screen !== 'shopping' || cart.length === 0) {
      setQuote(undefined);
      return;
    }
    void window.kioskApi.priceCart(cart).then((result) => {
      if (result.ok) {
        setQuote(result.quote);
        setMessage('');
      } else setMessage(result.message);
    });
  }, [cart, screen]);

  const products = state?.catalog?.products ?? [];
  const categories = state?.catalog?.categories ?? [];
  const visibleProducts = useMemo(
    () =>
      products.filter(
        (product) => !categoryId || product.categoryId === categoryId,
      ),
    [categoryId, products],
  );
  const productFor = (line: KioskCartLine) =>
    products.find((product) => product.id === line.productId);

  function startShopping() {
    setMessage('');
    setScreen('shopping');
  }

  async function addBarcode(barcode: string) {
    const result = await window.kioskApi.priceCart([{ barcode, quantity: 1 }]);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    const productId = result.quote.lines[0]?.productId;
    if (!productId) return;
    setCart((current) => {
      const existing = current.find((line) => line.productId === productId);
      if (existing)
        return current.map((line) =>
          line.productId === productId
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        );
      return [...current, { productId, quantity: 1 }];
    });
    setMessage('');
  }

  function changeQuantity(productId: string, amount: number) {
    setCart((current) =>
      current
        .map((line) =>
          line.productId === productId
            ? { ...line, quantity: line.quantity + amount }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
  }

  async function pay() {
    if (!cart.length) return;
    setScreen('paying');
    setMessage('');
    const result = await window.kioskApi.charge(cart);
    if (!result.ok) {
      setMessage(result.message);
      setScreen(
        result.code === 'manager-unreachable' ||
          result.code === 'in-flight-charge'
          ? 'recovery'
          : 'unreachable',
      );
      return;
    }
    if (result.outcome.status === 'approved') {
      setCart([]);
      setScreen('approved');
    } else if (result.outcome.status === 'declined') {
      setScreen('declined');
    } else {
      setMessage(
        result.outcome.status === 'needs-attention' ||
          result.outcome.status === 'voided'
          ? 'The manager must resolve this payment. Please see the shames.'
          : '',
      );
      setScreen('recovery');
    }
  }

  function tapStoreName() {
    const now = Date.now();
    storeNameTaps.current = [
      ...storeNameTaps.current.filter((tap) => now - tap < 3000),
      now,
    ];
    if (storeNameTaps.current.length >= 5) {
      storeNameTaps.current = [];
      setAdminOpen(true);
    }
  }

  if (!state) return <main className="center-screen">Starting kiosk…</main>;
  if (state.connection === 'revoked' && !rePairing)
    return (
      <main className="center-screen">
        <h1>This kiosk was turned off by the shames</h1>
        <p>It must be paired again before it can be used.</p>
        <button
          type="button"
          className="primary"
          onClick={() => setRePairing(true)}
        >
          Pair again
        </button>
      </main>
    );
  if (state.connection === 'unpaired' || rePairing)
    return (
      <PairingScreen
        state={state}
        onPaired={(next) => {
          setState(next);
          setRePairing(false);
          setScreen('attract');
        }}
      />
    );
  if (screen === 'unreachable' && !state.catalog)
    return (
      <main className="center-screen">
        <h1>Manager unreachable</h1>
        <p>Ask the shames to check the manager computer and network.</p>
        <button
          type="button"
          onClick={() => void window.kioskApi.refreshCatalog()}
        >
          Try again
        </button>
      </main>
    );
  if (screen === 'recovery' || state.inFlightCharge)
    return (
      <main className="center-screen recovery-screen">
        <h1>
          {state.inFlightCharge
            ? 'Checking the card charge'
            : 'Please see the shames'}
        </h1>
        <p>
          {message ||
            'The manager is checking whether the card was approved. Please do not try the payment again.'}
        </p>
        <p className="warning-message">
          If this stays unresolved, please see the shames.
        </p>
        {state.connection === 'manager-unreachable' && (
          <button
            type="button"
            onClick={() => void window.kioskApi.refreshCatalog()}
          >
            Retry connection
          </button>
        )}
        {!state.inFlightCharge && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              setMessage('');
              setCart([]);
              setScreen('attract');
            }}
          >
            Start a new purchase
          </button>
        )}
      </main>
    );
  if (screen === 'paying')
    return (
      <main className="center-screen">
        <h1>Processing payment…</h1>
        <p>Please wait. Do not remove your card until the terminal says so.</p>
      </main>
    );
  if (screen === 'approved')
    return (
      <main className="center-screen success-screen">
        <h1>Payment approved</h1>
        <p>Thank you. Your purchase is complete.</p>
        <button
          type="button"
          className="primary"
          onClick={() => setScreen('attract')}
        >
          Done
        </button>
      </main>
    );
  if (screen === 'declined')
    return (
      <main className="center-screen">
        <h1>Payment was declined</h1>
        <p>Please try another card or ask the shames for help.</p>
        <button
          type="button"
          className="primary"
          onClick={() => setScreen('shopping')}
        >
          Back to cart
        </button>
      </main>
    );
  if (screen === 'attract')
    return (
      <main className="attract-screen">
        {adminOpen && (
          <AdminOverlay
            readerStatus={state.readerStatus}
            onClose={() => setAdminOpen(false)}
          />
        )}
        <button type="button" className="store-name" onClick={tapStoreName}>
          {state.storeName || 'Self-checkout'}
        </button>
        <button
          type="button"
          className="shames-button"
          onClick={() => setAdminOpen(true)}
        >
          Shames
        </button>
        {state.tokenPersistenceWarning && (
          <p className="warning-message">
            This kiosk must be paired again if it restarts.
          </p>
        )}
        <h1>Touch to begin</h1>
        <p>Scan an item or choose one on the next screen.</p>
        <button
          type="button"
          className="primary start-button"
          onClick={startShopping}
        >
          Start shopping
        </button>
      </main>
    );
  return (
    <main className="shopping-screen">
      {adminOpen && (
        <AdminOverlay
          readerStatus={state.readerStatus}
          onClose={() => setAdminOpen(false)}
        />
      )}
      <header className="kiosk-header">
        <button type="button" className="store-name" onClick={tapStoreName}>
          {state.storeName || 'Self-checkout'}
        </button>
        <span
          className={
            state.connection === 'online' ? 'online-dot' : 'offline-dot'
          }
        >
          {state.connection === 'online' ? 'Connected' : 'Manager offline'}
        </span>
        <button
          type="button"
          className="shames-button"
          onClick={() => setAdminOpen(true)}
        >
          Shames
        </button>
      </header>
      <div className="shopping-layout">
        <section className="catalog-panel">
          <div className="category-tabs">
            <button
              type="button"
              className={!categoryId ? 'active' : ''}
              onClick={() => setCategoryId(undefined)}
            >
              All
            </button>
            {categories.map((category) => (
              <button
                type="button"
                className={category.id === categoryId ? 'active' : ''}
                key={category.id}
                onClick={() => setCategoryId(category.id)}
              >
                {category.name}
              </button>
            ))}
          </div>
          <div className="product-grid">
            {visibleProducts.map((product) => (
              <button
                type="button"
                className="product-tile"
                key={product.id}
                onClick={() =>
                  setCart((current) => {
                    const existing = current.find(
                      (line) => line.productId === product.id,
                    );
                    if (existing)
                      return current.map((line) =>
                        line.productId === product.id
                          ? { ...line, quantity: line.quantity + 1 }
                          : line,
                      );
                    return [...current, { productId: product.id, quantity: 1 }];
                  })
                }
              >
                <strong>{product.name}</strong>
                {product.secondaryName && (
                  <small>{product.secondaryName}</small>
                )}
                <b>{money(product.priceCents)}</b>
              </button>
            ))}
          </div>
        </section>
        <aside className="cart-panel">
          <h2>Your cart</h2>
          {cart.length === 0 ? (
            <p>Scan an item or touch a product to begin.</p>
          ) : (
            <ul className="cart-list">
              {cart.map((line) => {
                const product = productFor(line);
                const productId = line.productId ?? '';
                return (
                  <li key={productId}>
                    <div>
                      <strong>{product?.name ?? 'Item'}</strong>
                      <span>{money(product?.priceCents ?? 0)} each</span>
                    </div>
                    <div className="quantity-controls">
                      <button
                        type="button"
                        onClick={() => changeQuantity(productId, -1)}
                      >
                        −
                      </button>
                      <b>{line.quantity}</b>
                      <button
                        type="button"
                        onClick={() => changeQuantity(productId, 1)}
                      >
                        +
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="cart-total">
            <span>Total</span>
            <strong>{quote ? money(quote.totalCents) : '—'}</strong>
          </div>
          {message && <p className="error-message">{message}</p>}
          <button
            type="button"
            className="primary pay-button"
            disabled={!quote || !cart.length}
            onClick={() => void pay()}
          >
            Pay with card
          </button>
          <button
            type="button"
            className="secondary wide-button"
            onClick={() => setScreen('attract')}
          >
            Cancel
          </button>
        </aside>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
