import { useEffect, useMemo, useRef, useState } from 'react';
import {
  benefitEligibility,
  calculateCart,
  calculateCashChange,
  describePrintResult,
  encodeWeighBarcode,
  parseUsdToCents,
  type Category,
  type Customer,
  type Product,
  type Sale,
  type StoreSettings,
  type PaymentTransactionPayload,
  type StoredImage,
} from '@shul-store/shared';
import { CustomerEditorModal } from './customers/CustomerEditorModal';
import { formatMoney, formatQuantity } from '../utils/formatters';

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
  /** Whole-line price override from a scale-printed '02' barcode that embeds
   * the extended price rather than the weight. */
  priceOverrideCents?: number | undefined;
};

export function CheckoutScreen({
  products,
  categories,
  onInventoryChanged,
  onRequestApproval,
}: {
  products: Product[];
  categories: Category[];
  onInventoryChanged(): Promise<void>;
  onRequestApproval(permission: string, action: () => Promise<void>): void;
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
    | 'cash'
    | 'external_terminal'
    | 'account'
    | 'integrated_card'
    | 'snap_ebt'
    | 'wic'
    | null
  >(null);
  const [weighTarget, setWeighTarget] = useState<{
    product: Product;
    barcodeUsed: string | null;
  } | null>(null);
  const [scaleReading, setScaleReading] = useState<
    import('@shul-store/shared').ScaleReading | null
  >(null);
  const [scaleStatus, setScaleStatus] = useState<
    import('@shul-store/shared').ScaleStatus | null
  >(null);
  const [manualWeight, setManualWeight] = useState('');
  const [remainderMethod, setRemainderMethod] = useState<
    'cash' | 'external_terminal'
  >('cash');

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
  const [unknownBarcode, setUnknownBarcode] = useState<string | null>(null);
  const [unknownQuantity, setUnknownQuantity] = useState(1);

  const [sale, setSale] = useState<Sale>();
  const [printError, setPrintError] = useState('');
  const [quickKeys, setQuickKeys] = useState<
    import('@shul-store/shared').QuickKey[]
  >([]);
  const [suspended, setSuspended] = useState<
    import('@shul-store/shared').SuspendedSale[]
  >([]);
  const [showSuspended, setShowSuspended] = useState(false);
  const [showQuickKeys, setShowQuickKeys] = useState(false);
  const [parkLabel, setParkLabel] = useState('');
  const [deviceSettings, setDeviceSettings] = useState<
    import('@shul-store/shared').DeviceSettings | undefined
  >();

  const refreshQuickKeys = () =>
    window.storeApi.quickKeys
      .list()
      .then(setQuickKeys)
      .catch(() => {});
  const refreshSuspended = () =>
    window.storeApi.suspendedSales
      .list()
      .then(setSuspended)
      .catch(() => {});

  useEffect(() => {
    void window.storeApi.settings.getDevice().then(setDeviceSettings);
    refreshQuickKeys();
    refreshSuspended();
  }, []);
  const completionKey = useRef(crypto.randomUUID());
  const searchReqIdRef = useRef(0);
  const isCompletingRef = useRef(false);
  const isChargingRef = useRef(false);

  useEffect(() => {
    void window.storeApi.settings.get().then(setSettings);
    void window.storeApi.scale.getStatus().then(setScaleStatus);
    const unsubReading = window.storeApi.scale.subscribe(setScaleReading);
    const unsubStatus = window.storeApi.scale.subscribeStatus(setScaleStatus);
    return () => {
      unsubReading();
      unsubStatus();
    };
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

    const found = await window.storeApi.checkout.lookupBarcode(clean);
    if (!found) {
      setError('');
      setUnknownBarcode(clean);
      setUnknownQuantity(1);
      return;
    }
    const { product, weigh } = found;
    if (weigh) {
      if (weigh.mode === 'weight' && weigh.milliQty !== null) {
        // Scale-printed label: weight embedded in milli-units of the unit.
        add(product, clean, weigh.milliQty / 1000);
      } else if (weigh.mode === 'price' && weigh.priceCents !== null) {
        // Price-embedded label: line total is fixed by the label.
        add(product, clean, 1, weigh.priceCents);
      } else {
        add(product, clean);
      }
    } else {
      add(product, clean);
    }
    setQuery('');
  }

  function add(
    product: Product,
    barcodeUsed: string | null = null,
    amount = 1,
    priceOverrideCents?: number,
  ) {
    if (!product.active) {
      setError('Inactive products cannot be sold.');
      return;
    }
    if (product.soldBy === 'weight' && priceOverrideCents === undefined) {
      setWeighTarget({ product, barcodeUsed });
      setManualWeight('');
      return;
    }
    setCart((lines) => {
      const current = lines.find(
        (line) =>
          line.product.id === product.id &&
          line.barcodeUsed === barcodeUsed &&
          line.priceOverrideCents === priceOverrideCents,
      );
      if (current)
        return lines.map((line) =>
          line === current
            ? { ...line, quantity: line.quantity + amount }
            : line,
        );
      return [
        ...lines,
        { product, quantity: amount, barcodeUsed, priceOverrideCents },
      ];
    });
  }

  async function parkCurrentSale() {
    if (!cart.length) return;
    try {
      await window.storeApi.suspendedSales.park({
        label: parkLabel.trim() || null,
        customerId: selectedCustomer?.id ?? null,
        lines: cart.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          barcodeUsed: line.barcodeUsed,
          priceOverrideCents: line.priceOverrideCents ?? null,
        })),
      });
      setCart([]);
      setSelectedCustomer(null);
      setParkLabel('');
      setError('');
      await refreshSuspended();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Park failed');
    }
  }

  async function resumeParked(id: string) {
    try {
      const parked = await window.storeApi.suspendedSales.resume(id);
      const lines: CartLine[] = [];
      for (const line of parked.lines) {
        const product = products.find((p) => p.id === line.productId);
        if (!product) continue;
        lines.push({
          product,
          quantity: line.quantity,
          barcodeUsed: line.barcodeUsed,
          priceOverrideCents: line.priceOverrideCents ?? undefined,
        });
      }
      setCart(lines);
      setShowSuspended(false);
      await refreshSuspended();
      if (parked.customerId) {
        const customer = await window.storeApi.customers.get(parked.customerId);
        setSelectedCustomer(customer);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Resume failed');
    }
  }

  async function discardParked(id: string) {
    await window.storeApi.suspendedSales.discard(id).catch(() => {});
    await refreshSuspended();
  }

  function lineUnitCents(line: CartLine): number {
    if (line.priceOverrideCents !== undefined && line.quantity === 1)
      return line.priceOverrideCents;
    return line.product.salePriceCents ?? line.product.sellingPriceCents;
  }

  function lineTotalCents(line: CartLine): number {
    return Math.round(lineUnitCents(line) * line.quantity);
  }

  function addWeighted(quantity: number) {
    if (!weighTarget || !(quantity > 0) || quantity > 10000) return;
    const { product, barcodeUsed } = weighTarget;
    setCart((lines) => [...lines, { product, quantity, barcodeUsed }]);
    setWeighTarget(null);
    setManualWeight('');
  }

  async function printWeighLabel() {
    if (!weighTarget) return;
    const weight =
      Number(manualWeight) > 0 ? Number(manualWeight) : scaleReading?.weight;
    if (!weight || weight <= 0) return;
    const { product } = weighTarget;
    try {
      const plu =
        product.plu ?? (await window.storeApi.products.ensurePlu(product.id));
      const unitPrice = product.salePriceCents ?? product.sellingPriceCents;
      const milliQty = Math.round(weight * 1000);
      const mode = deviceSettings?.weighBarcodeMode ?? 'price';
      const barcode =
        mode === 'weight'
          ? encodeWeighBarcode(plu, { milliQty })
          : encodeWeighBarcode(plu, {
              priceCents: Math.round(unitPrice * weight),
            });
      await window.storeApi.labels.print({
        items: [
          {
            productId: product.id,
            name: `${product.name} — ${weight.toFixed(3)} ${product.unit ?? 'lb'}`,
            sellingPriceCents: Math.round(unitPrice * weight),
            barcode,
            quantity: 1,
          },
        ],
        template: 'thermal_40x30',
      });
      setError('');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not print label',
      );
    }
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

  const insufficient = cart.some((line) =>
    line.product.soldBy === 'weight'
      ? line.quantity * 1000 > line.product.stockQuantity
      : line.quantity > line.product.stockQuantity,
  );

  const cashReceivedCents = safeCash(cash);
  const totals = useMemo(
    () =>
      settings
        ? calculateCart(
            cart.map((line) => ({
              product:
                line.priceOverrideCents !== undefined
                  ? { ...line.product, salePriceCents: line.priceOverrideCents }
                  : line.product,
              quantity: line.quantity,
            })),
            settings,
          )
        : null,
    [cart, settings],
  );

  const benefit =
    (payment === 'snap_ebt' || payment === 'wic') && settings
      ? benefitEligibility(cart, settings, payment)
      : null;
  const benefitEligibleCents = benefit?.eligibleSubtotalCents ?? 0;
  const benefitWaivedTaxCents = benefit?.waivedTaxCents ?? 0;
  const benefitCoversCents = Math.min(
    benefitEligibleCents,
    (totals?.totalCents ?? 0) - benefitWaivedTaxCents,
  );
  const remainderCents =
    (totals?.totalCents ?? 0) - benefitCoversCents - benefitWaivedTaxCents;

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
      } else if (payment === 'snap_ebt' || payment === 'wic') {
        if (benefitEligibleCents <= 0) {
          setError(
            payment === 'snap_ebt'
              ? 'No SNAP-eligible items in this sale.'
              : 'No WIC-eligible items in this sale.',
          );
          return;
        }
        let remainder:
          import('@shul-store/shared').RemainderPayment | undefined;
        if (remainderCents > 0) {
          if (remainderMethod === 'cash') {
            remainder = {
              method: 'cash' as const,
              cashReceivedCents: cashReceivedCents ?? -1,
            };
          } else {
            remainder = {
              method: 'external_terminal' as const,
              approved: true,
              terminalReference: null,
            };
          }
        }
        paymentInput = {
          method: payment,
          approved: true,
          terminalReference: reference.trim() || null,
          remainder,
        };
      } else {
        return;
      }

      const input = {
        completionKey: completionKey.current,
        lines: cart.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          barcodeUsed: line.barcodeUsed,
          priceOverrideCents: line.priceOverrideCents ?? null,
        })),
        payment: paymentInput,
      };

      // Cash tenders kick the drawer as soon as the tender is taken (the
      // cashier needs it open to give change); a failure never blocks a sale.
      const cashTaken =
        payment === 'cash' ||
        ((payment === 'snap_ebt' || payment === 'wic') &&
          remainderCents > 0 &&
          remainderMethod === 'cash');
      if (cashTaken) {
        void window.storeApi.drawer
          .open()
          .then((result) => {
            if (!result.success) setError(result.error ?? 'Drawer failed');
          })
          .catch(() => undefined);
      }

      const completed = await window.storeApi.checkout.complete(input);
      setSale(completed);
      await onInventoryChanged();
      return;
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
          priceOverrideCents: c.priceOverrideCents ?? null,
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
                  <b>{line.product.name}</b>{' '}
                  {line.product.salePriceCents !== null &&
                    line.product.salePriceCents !== undefined && (
                      <span
                        style={{
                          background: '#b45309',
                          color: '#fff',
                          borderRadius: 4,
                          padding: '0 5px',
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {line.product.saleLabel ?? 'SALE'}
                      </span>
                    )}
                  <small>
                    {line.priceOverrideCents !== undefined
                      ? `${money(line.priceOverrideCents)} weigh label`
                      : line.product.soldBy === 'weight'
                        ? `${money(lineUnitCents(line))}/${line.product.unit ?? 'lb'}`
                        : `${money(lineUnitCents(line))} each`}{' '}
                    ·{' '}
                    {line.product.soldBy === 'weight'
                      ? `${(line.product.stockQuantity / 1000).toFixed(3)} ${line.product.unit ?? 'lb'} available`
                      : `${line.product.stockQuantity} available`}
                  </small>
                </div>
                {line.product.soldBy === 'weight' ? (
                  <div className="stepper">
                    <b>
                      {line.quantity.toFixed(3)} {line.product.unit ?? 'lb'}
                    </b>
                    <button
                      onClick={() =>
                        setWeighTarget({
                          product: line.product,
                          barcodeUsed: line.barcodeUsed,
                        })
                      }
                    >
                      Reweigh
                    </button>
                  </div>
                ) : (
                  <div className="stepper">
                    <button onClick={() => quantity(index, -1)}>−</button>
                    <b>{line.quantity}</b>
                    <button onClick={() => quantity(index, 1)}>+</button>
                  </div>
                )}
                <strong>{money(lineTotalCents(line))}</strong>
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
        {!payment && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginBottom: 10,
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={() => setShowQuickKeys((v) => !v)}
              title="Favorite products"
            >
              {showQuickKeys ? 'Hide keys' : `Keys (${quickKeys.length})`}
            </button>
            <button
              disabled={!cart.length}
              onClick={() => void parkCurrentSale()}
              title="Park this sale to resume later"
            >
              Park
            </button>
            <button
              disabled={!suspended.length}
              onClick={() => setShowSuspended(true)}
              title="Resume a parked sale"
            >
              Resume ({suspended.length})
            </button>
          </div>
        )}
        {!payment && showQuickKeys && (
          <div
            className="panel"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 8,
              marginBottom: 10,
              maxHeight: 220,
              overflowY: 'auto',
            }}
          >
            {quickKeys.length === 0 && (
              <div className="empty">
                Pin products to quick keys from the product edit screen.
              </div>
            )}
            {quickKeys.map((key) => {
              const product = products.find((p) => p.id === key.productId);
              if (!product || !product.active) return null;
              return (
                <button
                  key={key.productId}
                  onClick={() => add(product)}
                  style={{ padding: '10px 6px' }}
                >
                  <b>{product.name}</b>
                  <br />
                  <small>
                    {money(
                      lineUnitCents({
                        product,
                        quantity: 1,
                        barcodeUsed: null,
                      }),
                    )}
                  </small>
                </button>
              );
            })}
          </div>
        )}
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
                style={{ background: '#0a1710', color: 'white' }}
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

            {settings?.snapAccepted && (
              <button
                disabled={!cart.length || insufficient}
                onClick={() => setPayment('snap_ebt')}
              >
                SNAP / EBT
              </button>
            )}
            {settings?.wicAccepted && (
              <button
                disabled={!cart.length || insufficient}
                onClick={() => setPayment('wic')}
              >
                WIC
              </button>
            )}
          </div>
        ) : payment === 'snap_ebt' || payment === 'wic' ? (
          <div className="pay-box">
            <h4>
              {payment === 'snap_ebt' ? 'SNAP / EBT payment' : 'WIC payment'}
            </h4>
            <p style={{ fontSize: '13px' }}>
              Eligible subtotal: <b>{money(benefitCoversCents)}</b>
              {benefitWaivedTaxCents > 0 && (
                <> (tax waived: {money(benefitWaivedTaxCents)})</>
              )}
              <br />
              {remainderCents > 0 ? (
                <>
                  Remaining balance: <b>{money(remainderCents)}</b> — pay by
                  another tender
                </>
              ) : (
                'Benefit covers the full sale.'
              )}
            </p>
            {payment === 'wic' && (
              <p style={{ fontSize: '12px', color: '#5f6d65' }}>
                Run the WIC amount on the state WIC terminal, then record it
                here.
              </p>
            )}
            <label>
              Terminal / transaction reference (optional)
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Auth / trace #"
              />
            </label>
            {remainderCents > 0 && (
              <>
                <label>
                  Remainder paid by
                  <select
                    value={remainderMethod}
                    onChange={(e) =>
                      setRemainderMethod(
                        e.target.value === 'cash'
                          ? 'cash'
                          : 'external_terminal',
                      )
                    }
                  >
                    <option value="cash">Cash</option>
                    <option value="external_terminal">
                      External card terminal
                    </option>
                  </select>
                </label>
                {remainderMethod === 'cash' && (
                  <label>
                    Cash received for remainder ($)
                    <input
                      type="number"
                      min={remainderCents / 100}
                      step="0.01"
                      value={cash}
                      onChange={(e) => setCash(e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
            {benefitEligibleCents <= 0 && (
              <div className="alert">
                No {payment === 'snap_ebt' ? 'SNAP' : 'WIC'}-eligible items in
                this sale.
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="primary"
                disabled={
                  completing ||
                  benefitEligibleCents <= 0 ||
                  (remainderCents > 0 &&
                    remainderMethod === 'cash' &&
                    (cashReceivedCents === null ||
                      cashReceivedCents < remainderCents))
                }
                onClick={() => void complete()}
              >
                {completing ? 'Completing…' : 'Complete sale'}
              </button>
              <button onClick={() => setPayment(null)}>Back</button>
            </div>
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
                    background: '#f1f1ec',
                    border: '1px solid rgba(5,11,8,0.10)',
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
                        color: '#1f5e3f',
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
                            projectedBalanceCents > 0 ? '#87352a' : '#1f5e3f',
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
      {unknownBarcode && (
        <InlineProductModal
          barcode={unknownBarcode}
          categories={categories.filter((category) => category.active)}
          quantity={unknownQuantity}
          onClose={() => setUnknownBarcode(null)}
          onRequestApproval={onRequestApproval}
          onSaved={(product, amount) => {
            add(product, unknownBarcode, amount);
            setUnknownBarcode(null);
            setQuery('');
            void onInventoryChanged();
          }}
          setError={setError}
        />
      )}
      {showSuspended && (
        <div className="modal-backdrop" onClick={() => setShowSuspended(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Parked sales</h3>
            {suspended.length === 0 && (
              <div className="empty">No parked sales.</div>
            )}
            {suspended.map((parked) => (
              <div
                key={parked.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 0',
                  borderBottom: '1px solid #eee',
                }}
              >
                <div style={{ flex: 1 }}>
                  <b>
                    {parked.label ?? `Parked ${parked.createdAt.slice(11, 16)}`}
                  </b>
                  <br />
                  <small>
                    {parked.lines.length} line
                    {parked.lines.length === 1 ? '' : 's'} ·{' '}
                    {new Date(parked.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                </div>
                <button
                  className="primary"
                  onClick={() => void resumeParked(parked.id)}
                >
                  Resume
                </button>
                <button onClick={() => void discardParked(parked.id)}>
                  Discard
                </button>
              </div>
            ))}
            <button onClick={() => setShowSuspended(false)}>Close</button>
          </div>
        </div>
      )}
      {weighTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">
              Weigh — {weighTarget.product.name}
            </div>
            <p style={{ fontSize: '13px', margin: '0 0 12px' }}>
              {money(weighTarget.product.sellingPriceCents)}/
              {weighTarget.product.unit ?? 'lb'} · place the item on the scale
            </p>
            {scaleStatus?.connected && scaleReading ? (
              <p style={{ fontSize: '28px', fontWeight: 'bold', margin: '0' }}>
                {scaleReading.weight.toFixed(3)} {scaleReading.unit}
                {!scaleReading.stable && (
                  <small
                    style={{
                      fontSize: '12px',
                      fontWeight: 'normal',
                      color: '#a33d2a',
                    }}
                  >
                    {' '}
                    settling…
                  </small>
                )}
              </p>
            ) : (
              <p style={{ fontSize: '13px', color: '#5f6d65' }}>
                {scaleStatus?.error
                  ? `Scale: ${scaleStatus.error}`
                  : 'No scale connected — enter the weight manually.'}
              </p>
            )}
            <label>
              Weight ({weighTarget.product.unit ?? 'lb'})
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={
                  manualWeight ||
                  (scaleReading?.stable
                    ? scaleReading.weight.toFixed(3)
                    : manualWeight)
                }
                onChange={(e) => setManualWeight(e.target.value)}
                autoFocus
              />
            </label>
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button
                className="primary"
                disabled={
                  !(
                    Number(manualWeight) > 0 ||
                    (scaleReading?.stable && scaleReading.weight > 0)
                  )
                }
                onClick={() =>
                  addWeighted(
                    Number(manualWeight) > 0
                      ? Number(manualWeight)
                      : scaleReading!.weight,
                  )
                }
              >
                Add to sale
              </button>
              <button
                disabled={
                  !(
                    Number(manualWeight) > 0 ||
                    (scaleReading?.stable && scaleReading.weight > 0)
                  )
                }
                title="Print a barcode label for this weighed item"
                onClick={() => void printWeighLabel()}
              >
                Print label
              </button>
              <button onClick={() => setWeighTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineProductModal({
  barcode,
  categories,
  quantity,
  onClose,
  onSaved,
  onRequestApproval,
  setError,
}: {
  barcode: string;
  categories: Category[];
  quantity: number;
  onClose(): void;
  onSaved(product: Product, quantity: number): void;
  onRequestApproval(permission: string, action: () => Promise<void>): void;
  setError(value: string): void;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [name, setName] = useState('');
  const [suggestedName, setSuggestedName] = useState(false);
  const [secondaryName, setSecondaryName] = useState('');
  const [price, setPrice] = useState('0.00');
  const [cost, setCost] = useState('0.00');
  const [threshold, setThreshold] = useState('0');
  const [taxable, setTaxable] = useState(false);
  const [amount, setAmount] = useState(String(quantity));
  const [saving, setSaving] = useState(false);
  const [shareName, setShareName] = useState(false);
  const nameRef = useRef('');
  const [catalogImage, setCatalogImage] = useState<StoredImage | null>(null);
  const [pickedImage, setPickedImage] = useState<StoredImage | null>(null);

  useEffect(() => {
    if (barcode.startsWith('SSM-')) return;
    let active = true;
    void window.storeApi.cloudAccount
      .lookupBarcodeSuggestion(barcode)
      .then((suggestion) => {
        if (!active || !suggestion) return;
        if (!nameRef.current.trim()) {
          setName(suggestion.name);
          setSuggestedName(true);
        }
        if (suggestion.image_url)
          void window.storeApi.images
            .fetchRemote(suggestion.image_url)
            .then((image) => {
              if (active && image) setCatalogImage(image);
            })
            .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [barcode]);

  const image = pickedImage ?? catalogImage;

  async function chooseImage() {
    const next = await window.storeApi.images.choose();
    if (!next) return;
    if (pickedImage) void window.storeApi.images.discard(pickedImage.id);
    setPickedImage(next);
  }

  function removeImage() {
    if (pickedImage) {
      void window.storeApi.images.discard(pickedImage.id);
      setPickedImage(null);
    } else if (catalogImage) {
      void window.storeApi.images.discard(catalogImage.id);
      setCatalogImage(null);
    }
  }

  /** Discard every fetched/picked image except the one saved onto the product. */
  function discardUnusedImages(usedId: string | null) {
    for (const candidate of [catalogImage, pickedImage])
      if (candidate && candidate.id !== usedId)
        void window.storeApi.images.discard(candidate.id);
  }

  function close() {
    discardUnusedImages(null);
    onClose();
  }

  async function save() {
    if (!categoryId || !name.trim() || saving) return;
    setSaving(true);
    try {
      const purchaseCostCents = parseUsdToCents(cost);
      const sellingPriceCents = parseUsdToCents(price);
      const parsedAmount = Number(amount);
      if (!Number.isInteger(parsedAmount) || parsedAmount < 1)
        throw new Error('Enter a whole-number quantity of at least 1.');
      const input = {
        categoryId,
        name,
        secondaryName: secondaryName || null,
        imageId: image?.id ?? null,
        purchaseCostCents,
        sellingPriceCents,
        taxable,
        lowStockThreshold: Number(threshold),
        soldBy: 'each' as const,
        unit: null,
        snapEligible: false,
        wicEligible: false,
        barcodes: [barcode],
        vendors: [],
      };
      const product = await window.storeApi.products.createDuringSale(
        input,
        parsedAmount,
      );
      if (shareName && !barcode.startsWith('SSM-'))
        void window.storeApi.cloudAccount
          .shareBarcodeSuggestion(barcode, name.trim())
          .catch(() => undefined);
      discardUnusedImages(image?.id ?? null);
      onSaved(product, parsedAmount);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : 'Could not add product.';
      if (message.includes('PERMISSION_DENIED:')) {
        onRequestApproval('create_product_during_sale', save);
      } else setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">
          <h2>Not in the system — Add product</h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </div>
        <p>
          Barcode <code>{barcode}</code> was scanned. Add the product without
          leaving checkout.
        </p>
        <div className="image-controls">
          <button
            type="button"
            className="image-picker"
            onClick={() => void chooseImage()}
          >
            {image ? <img src={image.url} /> : <span>＋</span>}
            <div>
              <b>{image ? 'Change image' : 'Add image'}</b>
              <small>
                {pickedImage
                  ? 'Custom image'
                  : image
                    ? 'Catalog image — will be saved with the product'
                    : 'JPG, PNG, WebP or GIF · max 10 MB'}
              </small>
            </div>
          </button>
          {image && (
            <button type="button" onClick={removeImage}>
              Remove image
            </button>
          )}
        </div>
        <label>
          Product name
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => {
              nameRef.current = e.target.value;
              setName(e.target.value);
            }}
          />
        </label>
        {suggestedName && (
          <p className="muted">
            Suggested by another shul — please check this name before saving.
          </p>
        )}
        <label>
          Secondary-language name <em>Optional</em>
          <input
            value={secondaryName}
            onChange={(e) => setSecondaryName(e.target.value)}
          />
        </label>
        <label>
          Category
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="" disabled>
              Choose…
            </option>
            {categories.map((category) => (
              <option value={category.id} key={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label>
            Selling price ($)
            <input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
          <label>
            Purchase cost ($)
            <input
              type="number"
              min="0"
              step="0.01"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
          <label>
            Quantity
            <input
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label>
            Low-stock alert
            <input
              type="number"
              min="0"
              step="1"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </label>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={taxable}
            onChange={(e) => setTaxable(e.target.checked)}
          />{' '}
          This product is taxable
        </label>
        {!barcode.startsWith('SSM-') && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={shareName}
              onChange={(e) => setShareName(e.target.checked)}
            />{' '}
            Share this name with other shuls
          </label>
        )}
        <footer>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={saving || !categoryId || !name.trim()}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save and add to sale'}
          </button>
        </footer>
      </div>
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
              background: '#f1f1ec',
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
              {item.productName} ×{' '}
              {formatQuantity(item.quantity, item.soldBy, item.unit)}
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
          {sale.benefitPayment ? (
            <div>
              <p
                style={{
                  fontWeight: 'bold',
                  color: '#1f5e3f',
                  margin: '4px 0',
                }}
              >
                <span>
                  {sale.benefitPayment.method === 'snap_ebt'
                    ? 'SNAP / EBT'
                    : 'WIC'}
                </span>
                <span>{money(sale.benefitPayment.amountCents)}</span>
              </p>
              {sale.benefitPayment.terminalReference && (
                <p style={{ margin: '4px 0', fontSize: '13px' }}>
                  <span>Reference</span>
                  <span>{sale.benefitPayment.terminalReference}</span>
                </p>
              )}
              {sale.payment.method === 'cash' && (
                <p style={{ margin: '4px 0', fontSize: '13px' }}>
                  <span>Remainder (cash)</span>
                  <span>
                    {money(sale.payment.cashReceivedCents ?? 0)} · Change{' '}
                    {money(sale.payment.changeDueCents ?? 0)}
                  </span>
                </p>
              )}
              {sale.payment.method === 'external_terminal' &&
                sale.payment.terminalReference !==
                  sale.benefitPayment.terminalReference && (
                  <p style={{ margin: '4px 0', fontSize: '13px' }}>
                    <span>Remainder (card)</span>
                    <span>Approved</span>
                  </p>
                )}
            </div>
          ) : sale.payment.method === 'cash' ? (
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
                  color: '#1f5e3f',
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
