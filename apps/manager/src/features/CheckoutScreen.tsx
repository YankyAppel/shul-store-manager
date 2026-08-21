import { useEffect, useMemo, useRef, useState } from 'react';
import {
  calculateCart,
  calculateCashChange,
  parseUsdToCents,
  type Product,
  type Sale,
  type StoreSettings,
} from '@shul-store/shared';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
function safeCash(value: string): number | null {
  try {
    return parseUsdToCents(value);
  } catch {
    return null;
  }
}
type CartLine = {
  product: Product;
  quantity: number;
  barcodeUsed: string | null;
};

export function CheckoutScreen({
  products,
  onInventoryChanged,
}: {
  products: Product[];
  onInventoryChanged(): Promise<void>;
}) {
  const [settings, setSettings] = useState<StoreSettings>();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [payment, setPayment] = useState<'cash' | 'external_terminal' | null>(
    null,
  );
  const [cash, setCash] = useState('');
  const [approved, setApproved] = useState(false);
  const [reference, setReference] = useState('');
  const [sale, setSale] = useState<Sale>();
  const [printError, setPrintError] = useState('');
  const completionKey = useRef(crypto.randomUUID());
  useEffect(() => {
    void window.storeApi.settings.get().then(setSettings);
  }, []);
  async function scan(value: string) {
    const clean = value.trim();
    if (!clean) return;
    setError('');
    const product = await window.storeApi.checkout.lookupBarcode(clean);
    if (!product) {
      setError(`Unknown or inactive barcode: ${clean}`);
      return;
    }
    add(product, clean);
    setQuery('');
  }
  function add(product: Product, barcodeUsed: string | null = null) {
    if (!product.active) {
      setError('Inactive products cannot be sold.');
      return;
    }
    setCart((lines) => {
      const current = lines.find(
        (line) =>
          line.product.id === product.id && line.barcodeUsed === barcodeUsed,
      );
      if (current)
        return lines.map((line) =>
          line === current ? { ...line, quantity: line.quantity + 1 } : line,
        );
      return [...lines, { product, quantity: 1, barcodeUsed }];
    });
  }
  function quantity(index: number, change: number) {
    setCart((lines) =>
      lines.flatMap((line, position) =>
        position !== index
          ? [line]
          : line.quantity + change < 1
            ? []
            : [{ ...line, quantity: line.quantity + change }],
      ),
    );
  }
  useScannerCapture(scan);
  const insufficient = cart.some(
    (line) => line.quantity > line.product.stockQuantity,
  );
  const cashReceivedCents = safeCash(cash);
  const totals = useMemo(
    () => (settings ? calculateCart(cart, settings) : null),
    [cart, settings],
  );
  async function complete() {
    if (!totals) return;
    setError('');
    try {
      const input = {
        completionKey: completionKey.current,
        lines: cart.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          barcodeUsed: line.barcodeUsed,
        })),
        payment:
          payment === 'cash'
            ? {
                method: 'cash' as const,
                cashReceivedCents: cashReceivedCents ?? -1,
              }
            : {
                method: 'external_terminal' as const,
                approved: true as const,
                terminalReference: reference.trim() || null,
              },
      };
      const completed = await window.storeApi.checkout.complete(input);
      setSale(completed);
      await onInventoryChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sale failed');
    }
  }
  async function print() {
    if (!sale) return;
    const result = await window.storeApi.sales.print(sale.id);
    setPrintError(result.success ? '' : (result.error ?? 'Print failed'));
  }
  if (sale)
    return (
      <Receipt
        sale={sale}
        printError={printError}
        onPrint={() => void print()}
        onNew={() => {
          setSale(undefined);
          setCart([]);
          setPayment(null);
          setCash('');
          setApproved(false);
          setReference('');
          completionKey.current = crypto.randomUUID();
        }}
      />
    );
  const matches =
    query.length > 1
      ? products
          .filter(
            (product) =>
              product.active &&
              product.name.toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, 8)
      : [];
  return (
    <div className="checkout-layout">
      <section className="checkout-products">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void scan(query);
          }}
        >
          <input
            className="scan-input"
            autoFocus
            placeholder="Scan barcode or search products…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        {error && <div className="alert">{error}</div>}
        <div className="search-results">
          {matches.map((product) => (
            <button key={product.id} onClick={() => add(product)}>
              <b>{product.name}</b>
              <span>
                {money(product.sellingPriceCents)} · {product.stockQuantity} in
                stock
              </span>
            </button>
          ))}
        </div>
        <div className="cart">
          <h3>Current sale</h3>
          {cart.length === 0 ? (
            <div className="empty">Scan a barcode or search to begin.</div>
          ) : (
            cart.map((line, index) => (
              <div
                className="cart-line"
                key={`${line.product.id}-${line.barcodeUsed}`}
              >
                <div>
                  <b>{line.product.name}</b>
                  <small>
                    {money(line.product.sellingPriceCents)} each ·{' '}
                    {line.product.stockQuantity} available
                  </small>
                </div>
                <div className="stepper">
                  <button onClick={() => quantity(index, -1)}>−</button>
                  <b>{line.quantity}</b>
                  <button onClick={() => quantity(index, 1)}>+</button>
                </div>
                <strong>
                  {money(line.product.sellingPriceCents * line.quantity)}
                </strong>
                <button
                  onClick={() => setCart(cart.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </section>
      <section className="checkout-total">
        <h3>Totals</h3>
        {insufficient && (
          <div className="alert">
            Insufficient stock. Reduce highlighted quantities before payment.
          </div>
        )}
        <p>
          <span>Subtotal</span>
          <b>{money(totals?.subtotalCents ?? 0)}</b>
        </p>
        <p>
          <span>Tax</span>
          <b>{money(totals?.taxCents ?? 0)}</b>
        </p>
        <p className="grand">
          <span>Total</span>
          <b>{money(totals?.totalCents ?? 0)}</b>
        </p>
        {!payment ? (
          <>
            <button
              className="primary"
              disabled={!cart.length || insufficient}
              onClick={() => setPayment('cash')}
            >
              Cash
            </button>
            <button
              disabled={!cart.length || insufficient}
              onClick={() => setPayment('external_terminal')}
            >
              External card terminal
            </button>
          </>
        ) : payment === 'cash' ? (
          <div className="pay-box">
            <h4>Cash payment</h4>
            <label>
              Amount due<b>{money(totals?.totalCents ?? 0)}</b>
            </label>
            <label>
              Cash received ($)
              <input
                type="number"
                min={(totals?.totalCents ?? 0) / 100}
                step="0.01"
                value={cash}
                onChange={(e) => setCash(e.target.value)}
              />
            </label>
            <p>
              Change{' '}
              <b>
                {money(
                  cashReceivedCents !== null &&
                    cashReceivedCents >= (totals?.totalCents ?? 0)
                    ? calculateCashChange(
                        totals?.totalCents ?? 0,
                        cashReceivedCents,
                      )
                    : 0,
                )}
              </b>
            </p>
            <button
              className="primary"
              disabled={
                cashReceivedCents === null ||
                cashReceivedCents < (totals?.totalCents ?? 0)
              }
              onClick={() => void complete()}
            >
              Complete cash sale
            </button>
            <button onClick={() => setPayment(null)}>Back</button>
          </div>
        ) : (
          <div className="pay-box">
            <h4>External terminal</h4>
            <p>
              Process exactly <b>{money(totals?.totalCents ?? 0)}</b> on the
              separate terminal. Do not enter card details here.
            </p>
            <label>
              Terminal reference <em>Optional</em>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
              />{' '}
              I confirm the terminal approved this payment
            </label>
            <button
              className="primary"
              disabled={!approved}
              onClick={() => void complete()}
            >
              Complete approved sale
            </button>
            <button onClick={() => setPayment(null)}>Back</button>
          </div>
        )}
      </section>
    </div>
  );
}

function useScannerCapture(onScan: (value: string) => Promise<void>) {
  const buffer = useRef('');
  const last = useRef(0);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const now = Date.now();
      if (now - last.current > 80) buffer.current = '';
      last.current = now;
      if (event.key === 'Enter') {
        if (buffer.current.length >= 3) {
          event.preventDefault();
          void onScan(buffer.current);
        }
        buffer.current = '';
      } else if (event.key.length === 1) buffer.current += event.key;
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onScan]);
}

function Receipt({
  sale,
  printError,
  onPrint,
  onNew,
}: {
  sale: Sale;
  printError: string;
  onPrint(): void;
  onNew(): void;
}) {
  return (
    <div className="receipt-screen">
      <div className="success">
        ✓ Sale #{sale.receiptNumber} completed successfully
      </div>
      {printError && (
        <div className="alert">
          The sale remains completed. Printing failed: {printError}
        </div>
      )}
      <div className="receipt">
        <h2>Receipt #{sale.receiptNumber}</h2>
        <p>{new Date(sale.completedAt ?? sale.createdAt).toLocaleString()}</p>
        {sale.items.map((item) => (
          <p key={item.id}>
            <span>
              {item.productName} × {item.quantity}
            </span>
            <b>{money(item.lineTotalCents)}</b>
          </p>
        ))}
        <hr />
        <p>
          <span>Subtotal</span>
          <b>{money(sale.subtotalCents)}</b>
        </p>
        <p>
          <span>Tax</span>
          <b>{money(sale.taxCents)}</b>
        </p>
        <p>
          <span>Total</span>
          <b>{money(sale.totalCents)}</b>
        </p>
        <p>
          {sale.payment.method === 'cash'
            ? `Cash ${money(sale.payment.cashReceivedCents ?? 0)} · Change ${money(sale.payment.changeDueCents ?? 0)}`
            : `External terminal${sale.payment.terminalReference ? ` · ${sale.payment.terminalReference}` : ''}`}
        </p>
      </div>
      <button className="primary" onClick={onPrint}>
        {printError ? 'Retry printing' : 'Print receipt'}
      </button>{' '}
      <button onClick={onNew}>New sale</button>
    </div>
  );
}
