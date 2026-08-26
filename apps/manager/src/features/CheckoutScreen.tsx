import { useEffect, useMemo, useRef, useState } from 'react';
import {
  calculateCart,
  calculateCashChange,
  describePrintResult,
  parseUsdToCents,
  type Customer,
  type Product,
  type Sale,
  type StoreSettings,
  type PaymentTransactionPayload,
} from '@shul-store/shared';
import { CustomerEditorModal } from './customers/CustomerEditorModal';
import { formatMoney } from '../utils/formatters';

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

  const [pendingTxs, setPendingTxs] = useState<PaymentTransactionPayload[]>([]);
  useEffect(() => {
    window.storeApi.payments
      .reconcileTransactions()
      .then(() =>
        window.storeApi.payments.getPendingTransactions().then(setPendingTxs),
      )
      .catch(() => {});
  }, []);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [payment, setPayment] = useState<
    'cash' | 'external_terminal' | 'account' | 'integrated_card' | null
  >(null);

  const [chargeReference, setChargeReference] = useState<string | null>(null);
  const [chargeStatus, setChargeStatus] = useState<
    'idle' | 'initiating' | 'pending' | 'declined' | 'error'
  >('idle');
  const [chargeError, setChargeError] = useState<string | null>(null);
  const [cash, setCash] = useState('');
  const [approved, setApproved] = useState(false);
  const [reference, setReference] = useState('');

  // Account checkout states
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(
    null,
  );
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerMatches, setCustomerMatches] = useState<Customer[]>([]);
  const [accountConfirmed, setAccountConfirmed] = useState(false);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [completing, setCompleting] = useState(false);

  const [sale, setSale] = useState<Sale>();
  const [printError, setPrintError] = useState('');
  const completionKey = useRef(crypto.randomUUID());
  const searchReqIdRef = useRef(0);
  const isCompletingRef = useRef(false);
  const isChargingRef = useRef(false);

  useEffect(() => {
    void window.storeApi.settings.get().then(setSettings);
  }, []);

  async function scan(value: string) {
    const clean = value.trim();
    if (!clean) return;
    setError('');

    // If currently on account checkout screen and looking for customer, check if it matches a customer barcode/account
    if (payment === 'account' && !selectedCustomer) {
      const customer = await window.storeApi.customers.lookupBarcode(clean);
      if (customer) {
        setSelectedCustomer(customer);
        setCustomerQuery('');
        return;
      }
    }

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

  // Customer search with race-condition protection
  useEffect(() => {
    const currentReqId = ++searchReqIdRef.current;
    if (payment === 'account' && customerQuery.trim().length >= 1) {
      void window.storeApi.customers
        .search(customerQuery, false)
        .then((matches) => {
          if (searchReqIdRef.current === currentReqId) {
            setCustomerMatches(matches);
          }
        });
    } else {
      setCustomerMatches([]);
    }
  }, [payment, customerQuery]);

  // Check account limits & warnings
  const saleTotalCents = totals?.totalCents ?? 0;
  const isZeroTotal = totals !== null && totals.totalCents === 0;

  const projectedBalanceCents = selectedCustomer
    ? selectedCustomer.currentBalanceCents + saleTotalCents
    : 0;

  const isOverCreditLimit = selectedCustomer
    ? projectedBalanceCents > selectedCustomer.effectiveCreditLimitCents
    : false;

  const accountBlockedReason = isZeroTotal
    ? 'Account tender cannot be used for a $0.00 sale. Please use cash or external terminal checkout.'
    : selectedCustomer
      ? !selectedCustomer.active
        ? 'Customer account is inactive and cannot place new charges.'
        : selectedCustomer.blocked
          ? 'Customer is blocked from placing new charges on account.'
          : !settings?.customerAccountsEnabled
            ? 'Customer accounts are currently disabled in store settings.'
            : isOverCreditLimit
              ? `Purchase exceeds customer credit limit (${formatMoney(selectedCustomer.effectiveCreditLimitCents)}). Projected balance: ${formatMoney(projectedBalanceCents)}.`
              : null
      : null;

  async function complete() {
    if (!totals || isCompletingRef.current) return;
    isCompletingRef.current = true;
    setCompleting(true);
    setError('');
    try {
      let paymentInput: import('@shul-store/shared').CompleteSaleInput['payment'];

      if (payment === 'cash') {
        paymentInput = {
          method: 'cash',
          cashReceivedCents: cashReceivedCents ?? -1,
        };
      } else if (payment === 'external_terminal') {
        paymentInput = {
          method: 'external_terminal',
          approved: true,
          terminalReference: reference.trim() || null,
        };
      } else if (payment === 'account') {
        if (!selectedCustomer) {
          setError('Please select a customer.');
          return;
        }
        if (isZeroTotal) {
          setError(
            'Account tender cannot be used for a $0.00 sale. Please use cash or external terminal checkout.',
          );
          return;
        }
        paymentInput = {
          method: 'account',
          customerId: selectedCustomer.id,
          confirmed: true,
        };
      } else if (payment === 'integrated_card') {
        if (!chargeReference) return;
        paymentInput = { method: 'integrated_card', chargeReference };
      } else {
        return;
      }

      const input = {
        completionKey: completionKey.current,
        lines: cart.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          barcodeUsed: line.barcodeUsed,
        })),
        payment: paymentInput,
      };

      const completed = await window.storeApi.checkout.complete(input);
      setSale(completed);
      await onInventoryChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sale failed');
    } finally {
      isCompletingRef.current = false;
      setCompleting(false);
    }
  }

  async function initiateCharge() {
    if (isChargingRef.current) return;
    isChargingRef.current = true;
    if (!totals) {
      isChargingRef.current = false;
      return;
    }
    setChargeStatus('initiating');
    setChargeError(null);
    const ref = crypto.randomUUID();
    setChargeReference(ref);

    try {
      const input = {
        chargeReference: ref,
        lines: cart.map((c) => ({
          productId: c.product.id,
          quantity: c.quantity,
          barcodeUsed: c.barcodeUsed,
        })),
        idempotencyKey: completionKey.current,
      };

      const result = await window.storeApi.payments.initiateCharge(input);

      if (result.status === 'approved') {
        if (result.sale) {
          setSale(result.sale);
          await onInventoryChanged();
        } else {
          setChargeStatus('error');
          setChargeError(
            result.attentionReason ??
              'The card was approved but the sale needs manager attention.',
          );
        }
      } else if (result.status === 'declined') {
        setChargeStatus('declined');
        setChargeError(result.declineReason || 'Card declined');
      } else if (result.status === 'error') {
        setChargeStatus('error');
        setChargeError(
          result.errorMessage || 'An error occurred during payment',
        );
      } else if (result.status === 'unknown') {
        setChargeStatus('pending');
      }
    } catch (e: unknown) {
      setChargeStatus('error');
      setChargeError(e instanceof Error ? e.message : 'Payment failed');
    } finally {
      isChargingRef.current = false;
    }
  }

  async function checkChargeStatus() {
    if (!chargeReference || chargeStatus !== 'pending') return;
    setChargeError(null);
    try {
      const result =
        await window.storeApi.payments.getChargeStatus(chargeReference);
      if (result.status === 'approved') {
        if (result.sale) {
          setSale(result.sale);
          await onInventoryChanged();
        } else {
          setChargeStatus('error');
          setChargeError(
            result.attentionReason ??
              'The card was approved but the sale needs manager attention.',
          );
        }
      } else if (result.status === 'declined') {
        setChargeStatus('declined');
        setChargeError(result.declineReason || 'Card declined');
      } else if (result.status === 'error') {
        setChargeStatus('error');
        setChargeError(
          result.errorMessage || 'An error occurred during payment',
        );
      }
    } catch (e: unknown) {
      setChargeStatus('error');
      setChargeError(e instanceof Error ? e.message : 'Payment status failed');
    }
  }

  async function print() {
    if (!sale) return;
    const result = await window.storeApi.sales.print(sale.id);
    if (result.success && !result.fallbackReason) {
      setPrintError('');
      return;
    }
    setPrintError(describePrintResult(result, 'Receipt'));
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
          setSelectedCustomer(null);
          setCustomerQuery('');
          setAccountConfirmed(false);
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
      {pendingTxs.length > 0 && (
        <div className="banner warning" style={{ gridColumn: '1 / -1' }}>
          <strong>Pending Transactions</strong>
          <p>
            There {pendingTxs.length === 1 ? 'is' : 'are'} {pendingTxs.length}{' '}
            unresolved payment{' '}
            {pendingTxs.length === 1 ? 'transaction' : 'transactions'}. They
            will be resolved automatically in the background.
          </p>
        </div>
      )}
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
          <div style={{ display: 'grid', gap: '8px' }}>
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

            {settings?.cardProcessingEnabled && settings?.cardProcessorId && (
              <button
                disabled={!cart.length || insufficient || isZeroTotal}
                title={
                  isZeroTotal
                    ? 'Integrated card tender is not available for $0.00 sales'
                    : ''
                }
                onClick={() => setPayment('integrated_card')}
                style={{ background: '#0d2d20', color: 'white' }}
              >
                Pay now
              </button>
            )}

            <button
              disabled={!cart.length || insufficient || isZeroTotal}
              title={
                isZeroTotal
                  ? 'Account tender is not available for $0.00 sales'
                  : ''
              }
              onClick={() => setPayment('account')}
            >
              Put on account
            </button>
          </div>
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
                completing ||
                cashReceivedCents === null ||
                cashReceivedCents < (totals?.totalCents ?? 0)
              }
              onClick={() => void complete()}
            >
              {completing ? 'Processing…' : 'Complete cash sale'}
            </button>
            <button disabled={completing} onClick={() => setPayment(null)}>
              Back
            </button>
          </div>
        ) : payment === 'integrated_card' ? (
          <div className="pay-box">
            <h4>Integrated Card</h4>
            <p>
              Amount to charge: <b>{money(totals?.totalCents ?? 0)}</b>
            </p>
            {chargeStatus === 'idle' && (
              <>
                <button
                  className="primary"
                  onClick={() => void initiateCharge()}
                >
                  Charge Card
                </button>
                <button onClick={() => setPayment(null)}>Back</button>
              </>
            )}
            {chargeStatus === 'initiating' && (
              <p>Processing charge... Please wait.</p>
            )}
            {chargeStatus === 'pending' && (
              <div
                className="alert"
                style={{ background: '#fff3cd', color: '#856404' }}
              >
                The payment status is uncertain. Please check the status before
                trying again.
                <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                  <button
                    className="primary"
                    onClick={() => void checkChargeStatus()}
                  >
                    Check status
                  </button>
                </div>
              </div>
            )}
            {(chargeStatus === 'declined' || chargeStatus === 'error') && (
              <div
                className="alert"
                style={{
                  background:
                    chargeStatus === 'declined' ? '#fff3cd' : '#fdeded',
                  color: chargeStatus === 'declined' ? '#856404' : '#842029',
                }}
              >
                {chargeError}
                <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => {
                      setChargeStatus('idle');
                      setChargeError(null);
                      setPayment(null);
                    }}
                  >
                    Choose another payment method
                  </button>
                  <button
                    className="primary"
                    onClick={() => void initiateCharge()}
                  >
                    Retry charge
                  </button>
                </div>
              </div>
            )}
            {chargeError && chargeStatus === 'pending' && (
              <div
                className="alert"
                style={{
                  background: '#fdeded',
                  marginTop: '12px',
                  color: '#842029',
                }}
              >
                Error checking status: {chargeError}
              </div>
            )}
          </div>
        ) : payment === 'external_terminal' ? (
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
              disabled={completing || !approved}
              onClick={() => void complete()}
            >
              {completing ? 'Processing…' : 'Complete approved sale'}
            </button>
            <button disabled={completing} onClick={() => setPayment(null)}>
              Back
            </button>
          </div>
        ) : (
          <div className="pay-box">
            <h4>Put on account</h4>

            {isZeroTotal ? (
              <div className="alert" style={{ margin: '8px 0' }}>
                Account tender cannot be used for a $0.00 sale. Please use cash
                or external terminal checkout.
              </div>
            ) : !selectedCustomer ? (
              <div>
                <label>
                  Select customer
                  <input
                    placeholder="Search by name, account #, or scan barcode…"
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                  />
                </label>

                {customerMatches.length > 0 && (
                  <div
                    className="search-results"
                    style={{
                      gridTemplateColumns: '1fr',
                      maxHeight: '180px',
                      overflowY: 'auto',
                    }}
                  >
                    {customerMatches.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setSelectedCustomer(c)}
                        style={{ padding: '8px', textAlign: 'left' }}
                      >
                        <strong>{c.name}</strong>
                        <span style={{ fontSize: '12px' }}>
                          Acct #{c.accountNumber} ·{' '}
                          {c.currentBalanceCents > 0
                            ? `Owed: ${formatMoney(c.currentBalanceCents)}`
                            : c.currentBalanceCents < 0
                              ? `Credit: ${formatMoney(Math.abs(c.currentBalanceCents))}`
                              : '$0.00'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  style={{ marginTop: '10px' }}
                  onClick={() => setCreatingCustomer(true)}
                >
                  + New customer
                </button>
              </div>
            ) : (
              <div style={{ marginTop: '10px' }}>
                <div
                  style={{
                    background: '#f8f9fa',
                    border: '1px solid #e0e5e2',
                    borderRadius: '8px',
                    padding: '12px',
                    marginBottom: '10px',
                  }}
                >
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between' }}
                  >
                    <strong>{selectedCustomer.name}</strong>
                    <button
                      type="button"
                      style={{
                        border: 0,
                        background: 'transparent',
                        padding: 0,
                        color: '#277052',
                        fontSize: '12px',
                      }}
                      onClick={() => {
                        setSelectedCustomer(null);
                        setAccountConfirmed(false);
                      }}
                    >
                      Change
                    </button>
                  </div>
                  <div
                    style={{
                      fontSize: '12px',
                      color: '#666',
                      marginTop: '2px',
                    }}
                  >
                    Account #{selectedCustomer.accountNumber}
                  </div>
                  <hr
                    style={{
                      border: 'none',
                      borderTop: '1px solid #eee',
                      margin: '8px 0',
                    }}
                  />
                  <div style={{ fontSize: '13px', lineHeight: '1.5' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>Current balance:</span>
                      <b>
                        {selectedCustomer.currentBalanceCents > 0
                          ? `Owed: ${formatMoney(selectedCustomer.currentBalanceCents)}`
                          : selectedCustomer.currentBalanceCents < 0
                            ? `Credit: ${formatMoney(Math.abs(selectedCustomer.currentBalanceCents))}`
                            : '$0.00'}
                      </b>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>Credit limit:</span>
                      <span>
                        {formatMoney(
                          selectedCustomer.effectiveCreditLimitCents,
                        )}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>Available credit:</span>
                      <b>
                        {formatMoney(selectedCustomer.availableCreditCents)}
                      </b>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        borderTop: '1px dotted #ccc',
                        paddingTop: '6px',
                        marginTop: '6px',
                        fontWeight: 'bold',
                      }}
                    >
                      <span>Projected balance:</span>
                      <span
                        style={{
                          color:
                            projectedBalanceCents > 0 ? '#87352a' : '#1e684a',
                        }}
                      >
                        {projectedBalanceCents > 0
                          ? `Owed: ${formatMoney(projectedBalanceCents)}`
                          : projectedBalanceCents < 0
                            ? `Credit: ${formatMoney(Math.abs(projectedBalanceCents))}`
                            : '$0.00'}
                      </span>
                    </div>
                  </div>
                </div>

                {accountBlockedReason ? (
                  <div className="alert" style={{ margin: '8px 0' }}>
                    {accountBlockedReason}
                  </div>
                ) : (
                  <label className="toggle" style={{ margin: '10px 0' }}>
                    <input
                      type="checkbox"
                      checked={accountConfirmed}
                      onChange={(e) => setAccountConfirmed(e.target.checked)}
                    />{' '}
                    Charge {formatMoney(saleTotalCents)} to{' '}
                    {selectedCustomer.name}&apos;s account
                  </label>
                )}

                <button
                  className="primary"
                  disabled={
                    completing ||
                    !accountConfirmed ||
                    Boolean(accountBlockedReason)
                  }
                  onClick={() => void complete()}
                >
                  {completing ? 'Processing…' : 'Complete account sale'}
                </button>
              </div>
            )}

            <button
              style={{ marginTop: '8px' }}
              disabled={completing}
              onClick={() => setPayment(null)}
            >
              Back
            </button>
          </div>
        )}
      </section>

      {creatingCustomer && (
        <CustomerEditorModal
          customer={null}
          onClose={() => setCreatingCustomer(false)}
          onSaved={async (saved) => {
            setCreatingCustomer(false);
            setSelectedCustomer(saved);
          }}
          setError={setError}
        />
      )}
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
  const isAccount = sale.payment.method === 'account';

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

        {isAccount && (
          <div
            style={{
              background: '#f8f9fa',
              padding: '8px 12px',
              borderRadius: '6px',
              marginBottom: '12px',
            }}
          >
            <div>
              <strong>Customer:</strong> {sale.payment.customerName}
            </div>
            <div>
              <strong>Account #:</strong> {sale.payment.accountNumber}
            </div>
          </div>
        )}

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

        <div
          style={{
            borderTop: '1px dashed #ccc',
            paddingTop: '10px',
            marginTop: '10px',
          }}
        >
          {sale.payment.method === 'cash' ? (
            <p>
              <span>Cash</span>
              <b>
                {money(sale.payment.cashReceivedCents ?? 0)} · Change{' '}
                {money(sale.payment.changeDueCents ?? 0)}
              </b>
            </p>
          ) : sale.payment.method === 'external_terminal' ? (
            <p>
              <span>External terminal</span>
              <b>
                {sale.payment.terminalReference
                  ? `Ref ${sale.payment.terminalReference}`
                  : 'Approved'}
              </b>
            </p>
          ) : (
            <div>
              <p
                style={{
                  fontWeight: 'bold',
                  color: '#1e684a',
                  margin: '4px 0',
                }}
              >
                <span>Payment tender</span>
                <span>Charged to Account</span>
              </p>
              <p style={{ margin: '4px 0', fontSize: '13px' }}>
                <span>Previous balance</span>
                <span>{money(sale.payment.previousBalanceCents ?? 0)}</span>
              </p>
              <p style={{ margin: '4px 0', fontSize: '13px' }}>
                <span>This purchase</span>
                <span>+{money(sale.totalCents)}</span>
              </p>
              <p style={{ margin: '4px 0', fontWeight: 'bold' }}>
                <span>New balance</span>
                <span>
                  {money(
                    sale.payment.newBalanceCents ??
                      (sale.payment.previousBalanceCents ?? 0) +
                        sale.totalCents,
                  )}
                </span>
              </p>
            </div>
          )}
        </div>
      </div>
      <button className="primary" onClick={onPrint}>
        {printError ? 'Retry printing' : 'Print receipt'}
      </button>{' '}
      <button onClick={onNew}>New sale</button>
    </div>
  );
}
