import { useEffect, useMemo, useState } from 'react';
import type {
  AccountPayment,
  Customer,
  StoreSettings,
} from '@shul-store/shared';
import { CustomerDetailsView } from './CustomerDetailsView';
import { CustomerEditorModal } from './CustomerEditorModal';
import { AccountPaymentModal } from './AccountPaymentModal';
import { AccountPaymentReceiptModal } from './AccountPaymentReceiptModal';
import { formatMoney, messageFrom } from '../../utils/formatters';

export function CustomersScreen({
  initialCustomerId,
  onClearInitialCustomer,
  onViewSale,
}: {
  initialCustomerId?: string | null | undefined;
  onClearInitialCustomer?: (() => void) | undefined;
  onViewSale?: ((saleId: string) => void) | undefined;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [settings, setSettings] = useState<StoreSettings>();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    initialCustomerId ?? null,
  );
  const [creating, setCreating] = useState(false);
  const [paymentCustomer, setPaymentCustomer] = useState<Customer | null>(null);
  const [completedPayment, setCompletedPayment] =
    useState<AccountPayment | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialCustomerId) {
      setSelectedCustomerId(initialCustomerId);
    }
  }, [initialCustomerId]);

  const refresh = async () => {
    try {
      const [list, s] = await Promise.all([
        window.storeApi.customers.list(true),
        window.storeApi.settings.get(),
      ]);
      setCustomers(list);
      setSettings(s);
    } catch (e) {
      setError(messageFrom(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const visibleCustomers = useMemo(() => {
    const q = search.toLowerCase().trim();
    return customers.filter((c) => {
      if (!showInactive && !c.active) return false;
      if (!q) return true;
      const haystack =
        `${c.name} ${c.secondaryName ?? ''} ${c.accountNumber} ${c.accountBarcode ?? ''} ${c.phone ?? ''} ${c.email ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [customers, search, showInactive]);

  if (selectedCustomerId && settings) {
    return (
      <CustomerDetailsView
        customerId={selectedCustomerId}
        settings={settings}
        onBack={() => {
          setSelectedCustomerId(null);
          onClearInitialCustomer?.();
          void refresh();
        }}
        onViewSale={onViewSale}
        setError={setError}
      />
    );
  }

  return (
    <div className="customers-screen">
      {error && (
        <div className="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}

      <section className="toolbar">
        <label className="search">
          ⌕
          <input
            placeholder="Search customers by name, account #, barcode, phone, email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <label className="check">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />{' '}
            Show inactive
          </label>
          <button
            type="button"
            className="primary"
            onClick={() => setCreating(true)}
          >
            + New customer
          </button>
        </div>
      </section>

      {visibleCustomers.length === 0 ? (
        <div className="empty">
          <b>No customers found</b>
          <p>
            {customers.length === 0
              ? 'Create a customer to get started.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Account #</th>
                <th>Contact</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
                <th style={{ textAlign: 'right' }}>Credit Limit</th>
                <th style={{ textAlign: 'right' }}>Available Credit</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleCustomers.map((customer) => {
                const owesMoney = customer.currentBalanceCents > 0;
                const hasCredit = customer.currentBalanceCents < 0;

                return (
                  <tr
                    key={customer.id}
                    className={!customer.active ? 'inactive' : ''}
                  >
                    <td>
                      <div>
                        <strong>{customer.name}</strong>
                        {customer.secondaryName && (
                          <small>{customer.secondaryName}</small>
                        )}
                      </div>
                    </td>
                    <td>
                      <code>{customer.accountNumber}</code>
                      {customer.accountBarcode && (
                        <small>Barcode: {customer.accountBarcode}</small>
                      )}
                    </td>
                    <td>
                      <div>{customer.phone || customer.email || '—'}</div>
                      {customer.phone && customer.email && (
                        <small>{customer.email}</small>
                      )}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontWeight: 'bold',
                        color: owesMoney
                          ? '#87352a'
                          : hasCredit
                            ? '#1e684a'
                            : 'inherit',
                      }}
                    >
                      {owesMoney
                        ? `Owed: ${formatMoney(customer.currentBalanceCents)}`
                        : hasCredit
                          ? `Credit: ${formatMoney(Math.abs(customer.currentBalanceCents))}`
                          : '$0.00'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatMoney(customer.effectiveCreditLimitCents)}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontWeight: 'bold',
                        color:
                          customer.availableCreditCents < 0
                            ? '#87352a'
                            : '#1e684a',
                      }}
                    >
                      {formatMoney(customer.availableCreditCents)}
                    </td>
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          gap: '4px',
                          flexWrap: 'wrap',
                        }}
                      >
                        <span
                          className={`badge ${customer.active ? 'badge-active' : 'badge-inactive'}`}
                        >
                          {customer.active ? 'Active' : 'Inactive'}
                        </span>
                        {customer.blocked && (
                          <span className="badge badge-blocked">Blocked</span>
                        )}
                      </div>
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        onClick={() => setSelectedCustomerId(customer.id)}
                      >
                        Details
                      </button>
                      <button
                        type="button"
                        onClick={() => setPaymentCustomer(customer)}
                      >
                        Pay
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CustomerEditorModal
          customer={null}
          onClose={() => setCreating(false)}
          onSaved={async (saved) => {
            setCreating(false);
            await refresh();
            setSelectedCustomerId(saved.id);
          }}
          setError={setError}
        />
      )}

      {paymentCustomer && settings && (
        <AccountPaymentModal
          customer={paymentCustomer}
          settings={settings}
          onClose={() => setPaymentCustomer(null)}
          onPaymentCompleted={async (payment) => {
            setPaymentCustomer(null);
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
    </div>
  );
}
