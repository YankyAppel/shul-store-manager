import { useEffect, useState } from 'react';
import type {
  AccountPayment,
  Customer,
  CustomerLedgerEntry,
  StoreSettings,
} from '@shul-store/shared';
import { CustomerEditorModal } from './CustomerEditorModal';
import { CustomerLedgerTable } from './CustomerLedgerTable';
import { AccountPaymentModal } from './AccountPaymentModal';
import { AccountPaymentReceiptModal } from './AccountPaymentReceiptModal';
import { CustomerStatementModal } from './CustomerStatementModal';
import { formatMoney, messageFrom } from '../../utils/formatters';

export function CustomerDetailsView({
  customerId,
  settings,
  onBack,
  onViewSale,
  setError,
}: {
  customerId: string;
  settings: StoreSettings;
  onBack(): void;
  onViewSale?: ((saleId: string) => void) | undefined;
  setError(value: string): void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [ledger, setLedger] = useState<CustomerLedgerEntry[]>([]);
  const [editing, setEditing] = useState(false);
  const [paymentModal, setPaymentModal] = useState(false);
  const [completedPayment, setCompletedPayment] =
    useState<AccountPayment | null>(null);
  const [statementModal, setStatementModal] = useState(false);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [c, l] = await Promise.all([
        window.storeApi.customers.get(customerId),
        window.storeApi.customers.getLedger(customerId),
      ]);
      setCustomer(c);
      setLedger(l);
    } catch (e) {
      setError(messageFrom(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [customerId]);

  async function toggleActive() {
    if (!customer) return;
    try {
      await window.storeApi.customers.setActive(customer.id, !customer.active);
      await refresh();
    } catch (e) {
      setError(messageFrom(e));
    }
  }

  async function toggleBlocked() {
    if (!customer) return;
    try {
      await window.storeApi.customers.setBlocked(
        customer.id,
        !customer.blocked,
      );
      await refresh();
    } catch (e) {
      setError(messageFrom(e));
    }
  }

  async function handleViewPaymentReceipt(paymentId: string) {
    try {
      const payment = await window.storeApi.accountPayments.get(paymentId);
      setCompletedPayment(payment);
    } catch (e) {
      setError(messageFrom(e));
    }
  }

  if (loading && !customer) return <p>Loading customer details…</p>;
  if (!customer) return <p>Customer not found.</p>;

  return (
    <div className="customer-details-view">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <button type="button" onClick={onBack}>
          ← Back to customers
        </button>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" onClick={() => setEditing(true)}>
            Edit details
          </button>
          <button type="button" onClick={() => void toggleActive()}>
            {customer.active ? 'Deactivate' : 'Reactivate'}
          </button>
          <button type="button" onClick={() => void toggleBlocked()}>
            {customer.blocked ? 'Unblock' : 'Block account'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setPaymentModal(true)}
          >
            Record payment
          </button>
          <button type="button" onClick={() => setStatementModal(true)}>
            Statement
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 340px',
          gap: '20px',
          marginBottom: '24px',
        }}
      >
        <div className="card" style={{ padding: '20px' }}>
          <div
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
              marginBottom: '10px',
            }}
          >
            <h2 style={{ margin: 0, fontFamily: 'Georgia, serif' }}>
              {customer.name}
            </h2>
            {customer.secondaryName && (
              <span style={{ color: '#666', fontSize: '16px' }}>
                ({customer.secondaryName})
              </span>
            )}
            <span
              className={`badge ${customer.active ? 'badge-active' : 'badge-inactive'}`}
            >
              {customer.active ? 'Active' : 'Inactive'}
            </span>
            {customer.blocked && (
              <span className="badge badge-blocked">Blocked</span>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '12px',
              marginTop: '16px',
              fontSize: '14px',
            }}
          >
            <div>
              <span style={{ color: '#777' }}>Account Number:</span>
              <div style={{ fontWeight: 'bold' }}>{customer.accountNumber}</div>
            </div>
            <div>
              <span style={{ color: '#777' }}>Account Barcode:</span>
              <div>
                <code>{customer.accountBarcode ?? '—'}</code>
              </div>
            </div>
            <div>
              <span style={{ color: '#777' }}>Phone:</span>
              <div>{customer.phone ?? '—'}</div>
            </div>
            <div>
              <span style={{ color: '#777' }}>Email:</span>
              <div>{customer.email ?? '—'}</div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <span style={{ color: '#777' }}>Address:</span>
              <div>{customer.address ?? '—'}</div>
            </div>
            {customer.notes && (
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={{ color: '#777' }}>Notes:</span>
                <div>{customer.notes}</div>
              </div>
            )}
          </div>
        </div>

        <div
          className="card"
          style={{
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <small
              style={{
                color: '#777',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Account Balance
            </small>
            <div
              style={{
                fontSize: '28px',
                fontWeight: 'bold',
                fontFamily: 'Georgia, serif',
                marginTop: '4px',
                color:
                  customer.currentBalanceCents > 0
                    ? '#87352a'
                    : customer.currentBalanceCents < 0
                      ? '#1e684a'
                      : '#333',
              }}
            >
              {customer.currentBalanceCents > 0
                ? `Amount owed: ${formatMoney(customer.currentBalanceCents)}`
                : customer.currentBalanceCents < 0
                  ? `Customer credit: ${formatMoney(Math.abs(customer.currentBalanceCents))}`
                  : 'Settled ($0.00)'}
            </div>
          </div>

          <div
            style={{
              borderTop: '1px solid #eee',
              paddingTop: '12px',
              marginTop: '14px',
              fontSize: '13px',
              lineHeight: '1.6',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Credit limit:</span>
              <b>{formatMoney(customer.effectiveCreditLimitCents)}</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Available credit:</span>
              <b
                style={{
                  color:
                    customer.availableCreditCents < 0 ? '#87352a' : '#1e684a',
                }}
              >
                {formatMoney(customer.availableCreditCents)}
              </b>
            </div>
            {customer.creditLimitCents !== null && (
              <small
                style={{ color: '#777', display: 'block', marginTop: '4px' }}
              >
                (Custom override limit)
              </small>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: '12px' }}>
        <h3 style={{ margin: '0 0 10px 0' }}>Ledger history</h3>
        <CustomerLedgerTable
          entries={ledger}
          onViewSale={onViewSale}
          onViewPayment={(pid) => void handleViewPaymentReceipt(pid)}
        />
      </div>

      {editing && (
        <CustomerEditorModal
          customer={customer}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refresh();
          }}
          setError={setError}
        />
      )}

      {paymentModal && (
        <AccountPaymentModal
          customer={customer}
          settings={settings}
          onClose={() => setPaymentModal(false)}
          onPaymentCompleted={async (payment) => {
            setPaymentModal(false);
            setCompletedPayment(payment);
            await refresh();
          }}
          setError={setError}
        />
      )}

      {completedPayment && (
        <AccountPaymentReceiptModal
          payment={completedPayment}
          onClose={() => setCompletedPayment(null)}
        />
      )}

      {statementModal && (
        <CustomerStatementModal
          customer={customer}
          onClose={() => setStatementModal(false)}
          setError={setError}
        />
      )}
    </div>
  );
}
