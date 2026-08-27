import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import type {
  AuthState,
  Category,
  Product,
  StoredImage,
} from '@shul-store/shared';
import { CheckoutScreen } from './features/CheckoutScreen';
import { LabelPrintModal } from './features/labels/LabelPrintModal';
import { SalesHistory } from './features/SalesHistory';
import { SettingsScreen } from './features/SettingsScreen';
import { KioskScreen } from './features/KioskScreen';
import { CustomersScreen } from './features/customers/CustomersScreen';
import { ReportsScreen } from './features/ReportsScreen';
import { FirstOwnerSetup, LockScreen } from './features/AuthScreens';

type View =
  | 'checkout'
  | 'products'
  | 'categories'
  | 'inventory'
  | 'customers'
  | 'sales'
  | 'settings'
  | 'kiosk'
  | 'reports';

const imageUrl = (id: string | null) =>
  id ? `store-image://local/${id}` : undefined;
const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  );
const messageFrom = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': /, '')
    : 'Something went wrong';

export function App() {
  const [view, setView] = useState<View>('products');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [categoryEditor, setCategoryEditor] = useState<
    Category | null | undefined
  >();
  const [productEditor, setProductEditor] = useState<
    Product | null | undefined
  >();
  const [inventoryProduct, setInventoryProduct] = useState<
    Product | undefined
  >();
  const [labelProductIds, setLabelProductIds] = useState<
    string[] | undefined
  >();
  const [error, setError] = useState('');
  const [authState, setAuthState] = useState<AuthState>();
  const [needsOwner, setNeedsOwner] = useState(false);
  const [approvalPermission, setApprovalPermission] = useState<string | null>(
    null,
  );
  const [approvalPin, setApprovalPin] = useState('');

  // Cross-screen navigation
  const [targetCustomerId, setTargetCustomerId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      window.storeApi.auth.getState(),
      window.storeApi.auth.listAccounts(),
    ]).then(([state, accounts]) => {
      if (!mounted) return;
      setAuthState(state);
      setNeedsOwner(!state.staffModeEnabled && accounts.length === 0);
    });
    const unsubscribe = window.storeApi.auth.subscribe(setAuthState);
    const unsubscribeLocked = window.storeApi.auth.subscribeLocked(() => {
      void window.storeApi.auth.getState().then(setAuthState);
    });
    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeLocked();
    };
  }, []);

  const can = useCallback(
    (permission: string) =>
      !authState?.staffModeEnabled ||
      authState.signedInStaff?.role === 'owner' ||
      authState.permissions.includes(permission as never),
    [authState],
  );

  useEffect(() => {
    if (
      !can(
        view === 'checkout'
          ? 'checkout'
          : view === 'products' || view === 'categories'
            ? 'products.edit'
            : view === 'inventory'
              ? 'inventory.adjust'
              : view === 'customers'
                ? 'customers.manage'
                : view === 'sales'
                  ? 'sales.history'
                  : view === 'reports'
                    ? 'reports.view'
                    : 'owner',
      )
    )
      setView('checkout');
  }, [can, view]);

  const refresh = useCallback(async () => {
    try {
      const [nextCategories, nextProducts] = await Promise.all([
        window.storeApi.categories.list(true),
        window.storeApi.products.list(true),
      ]);
      setCategories(nextCategories);
      setProducts(nextProducts);
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleProducts = useMemo(
    () =>
      products.filter(
        (product) =>
          (showInactive || product.active) &&
          `${product.name} ${product.secondaryName ?? ''} ${product.barcodes.map((b) => b.value).join(' ')}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [products, search, showInactive],
  );

  const visibleCategories = categories.filter(
    (category) => showInactive || category.active,
  );

  if (!authState)
    return (
      <div className="auth-screen">
        <p>Loading…</p>
      </div>
    );
  if (needsOwner)
    return (
      <FirstOwnerSetup
        onComplete={() => {
          setNeedsOwner(false);
          void window.storeApi.auth.getState().then(setAuthState);
        }}
        onSkip={() => setNeedsOwner(false)}
      />
    );
  if (authState.staffModeEnabled && !authState.signedInStaff)
    return (
      <LockScreen
        onSignedIn={() =>
          void window.storeApi.auth.getState().then(setAuthState)
        }
      />
    );

  async function toggleProduct(product: Product) {
    try {
      await window.storeApi.products.setActive(product.id, !product.active);
      await refresh();
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }

  async function toggleCategory(category: Category) {
    try {
      await window.storeApi.categories.setActive(category.id, !category.active);
      await refresh();
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }

  function handleNavigateToCustomer(customerId: string) {
    setTargetCustomerId(customerId);
    setView('customers');
  }

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <strong>Shul Store</strong>
            <small>Manager</small>
          </div>
        </div>
        <nav>
          {can('checkout') && (
            <button
              className={view === 'checkout' ? 'active' : ''}
              onClick={() => setView('checkout')}
            >
              ▣ <span>Checkout</span>
            </button>
          )}
          {can('products.edit') && (
            <button
              className={view === 'products' ? 'active' : ''}
              onClick={() => setView('products')}
            >
              ▦ <span>Products</span>
            </button>
          )}
          {can('products.edit') && (
            <button
              className={view === 'categories' ? 'active' : ''}
              onClick={() => setView('categories')}
            >
              ◫ <span>Categories</span>
            </button>
          )}
          {can('inventory.adjust') && (
            <button
              className={view === 'inventory' ? 'active' : ''}
              onClick={() => setView('inventory')}
            >
              ↕ <span>Inventory</span>
            </button>
          )}
          {can('customers.manage') && (
            <button
              className={view === 'customers' ? 'active' : ''}
              onClick={() => {
                setTargetCustomerId(null);
                setView('customers');
              }}
            >
              ☺ <span>Customers</span>
            </button>
          )}
          {can('sales.history') && (
            <button
              className={view === 'sales' ? 'active' : ''}
              onClick={() => setView('sales')}
            >
              ▤ <span>Sales history</span>
            </button>
          )}
          {can('reports.view') && (
            <button
              className={view === 'reports' ? 'active' : ''}
              onClick={() => setView('reports')}
            >
              ▤ <span>Reports</span>
            </button>
          )}
          {can('owner') && (
            <button
              className={view === 'settings' ? 'active' : ''}
              onClick={() => setView('settings')}
            >
              ⚙ <span>Settings</span>
            </button>
          )}
          {can('owner') && (
            <button
              className={view === 'kiosk' ? 'active' : ''}
              onClick={() => setView('kiosk')}
            >
              ▣ <span>Kiosk</span>
            </button>
          )}
        </nav>
        <div className="offline">
          <i /> Local database
          <br />
          <small>Ready offline</small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <h1>
              {
                {
                  checkout: 'Checkout',
                  products: 'Products',
                  categories: 'Categories',
                  inventory: 'Inventory',
                  customers: 'Customers & Accounts',
                  sales: 'Sales history',
                  reports: 'Daily reports',
                  settings: 'Store settings',
                  kiosk: 'Kiosk',
                }[view]
              }
            </h1>
            <p>
              {view === 'checkout'
                ? 'Fast local sales by barcode or search.'
                : view === 'sales'
                  ? 'Completed local sales and receipt reprinting.'
                  : view === 'customers'
                    ? 'Customer balances, credit limits, account payments, and statements.'
                    : view === 'settings'
                      ? 'Local checkout, tax, customer credit, printers, and receipt configuration.'
                      : view === 'kiosk'
                        ? 'Configure and monitor LAN self-checkout kiosks.'
                        : view === 'reports'
                          ? 'Review sales, cash reconciliation, and daily closes.'
                          : view === 'inventory'
                            ? 'Receive stock and record append-only adjustments.'
                            : `Manage your store ${view}.`}
            </p>
          </div>
          <div className="header-actions">
            {authState.staffModeEnabled && authState.signedInStaff && (
              <>
                <span className="staff-badge">
                  {authState.signedInStaff.name} ·{' '}
                  {authState.signedInStaff.role}
                </span>
                <button
                  type="button"
                  onClick={() => void window.storeApi.auth.signOut()}
                >
                  Lock
                </button>
              </>
            )}
            {(view === 'products' || view === 'categories') && (
              <div className="header-actions">
                {view === 'products' && (
                  <button type="button" onClick={() => setLabelProductIds([])}>
                    Print labels
                  </button>
                )}
                <button
                  className="primary"
                  onClick={() =>
                    view === 'categories'
                      ? setCategoryEditor(null)
                      : setProductEditor(null)
                  }
                >
                  {view === 'categories' ? '+ New category' : '+ New product'}
                </button>
              </div>
            )}
          </div>
        </header>
        {error && (
          <div className="alert">
            <span>{error}</span>
            {error.startsWith('PERMISSION_DENIED:') && (
              <button
                type="button"
                onClick={() => {
                  setApprovalPermission(
                    error.slice('PERMISSION_DENIED:'.length),
                  );
                  setApprovalPin('');
                }}
              >
                Ask the shames to approve
              </button>
            )}
            <button onClick={() => setError('')}>×</button>
          </div>
        )}
        {approvalPermission && (
          <div className="modal-backdrop">
            <div className="modal">
              <div className="modal-title">
                <h2>Owner approval</h2>
                <button onClick={() => setApprovalPermission(null)}>×</button>
              </div>
              <p>
                Ask an owner to enter their PIN to approve this action once.
              </p>
              <label>
                Owner PIN
                <input
                  autoFocus
                  type="password"
                  inputMode="numeric"
                  value={approvalPin}
                  onChange={(event) =>
                    setApprovalPin(
                      event.target.value.replace(/\D/g, '').slice(0, 8),
                    )
                  }
                />
              </label>
              <footer>
                <button onClick={() => setApprovalPermission(null)}>
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={approvalPin.length < 4}
                  onClick={() =>
                    void window.storeApi.auth
                      .elevate(approvalPermission as never, approvalPin)
                      .then(() => {
                        setApprovalPermission(null);
                        setError('Owner approved. Please retry the action.');
                      })
                      .catch((reason) => setError(messageFrom(reason)))
                  }
                >
                  Approve once
                </button>
              </footer>
            </div>
          </div>
        )}
        {(['products', 'categories', 'inventory'] as View[]).includes(view) && (
          <section className="toolbar">
            <label className="search">
              ⌕
              <input
                placeholder="Search by name or barcode…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />{' '}
              Show inactive
            </label>
          </section>
        )}

        {view === 'checkout' && (
          <CheckoutScreen products={products} onInventoryChanged={refresh} />
        )}
        {view === 'customers' && (
          <CustomersScreen
            initialCustomerId={targetCustomerId}
            onClearInitialCustomer={() => setTargetCustomerId(null)}
            onViewSale={() => setView('sales')}
          />
        )}
        {view === 'sales' && (
          <SalesHistory onViewCustomer={handleNavigateToCustomer} />
        )}
        {view === 'settings' && <SettingsScreen />}
        {view === 'kiosk' && <KioskScreen />}
        {view === 'reports' && <ReportsScreen />}
        {view === 'categories' && (
          <div className="category-grid">
            {visibleCategories.map((category) => (
              <article
                className={!category.active ? 'inactive card' : 'card'}
                key={category.id}
              >
                <div className="category-image">
                  {category.imageId ? (
                    <img src={imageUrl(category.imageId)} />
                  ) : (
                    <span>{category.name.slice(0, 1).toUpperCase()}</span>
                  )}
                </div>
                <div className="card-body">
                  <div>
                    <h3>{category.name}</h3>
                    {category.secondaryName && <p>{category.secondaryName}</p>}
                    <small>
                      {
                        products.filter(
                          (p) => p.categoryId === category.id && p.active,
                        ).length
                      }{' '}
                      products
                    </small>
                  </div>
                  <div className="actions">
                    <button onClick={() => setCategoryEditor(category)}>
                      Edit
                    </button>
                    <button onClick={() => void toggleCategory(category)}>
                      {category.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {view === 'products' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Barcodes</th>
                  <th>Price</th>
                  <th>Stock</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((product) => (
                  <tr
                    className={!product.active ? 'inactive' : ''}
                    key={product.id}
                  >
                    <td>
                      <div className="product-cell">
                        {product.imageId ? (
                          <img src={imageUrl(product.imageId)} />
                        ) : (
                          <span className="thumb">{product.name[0]}</span>
                        )}
                        <div>
                          <strong>{product.name}</strong>
                          {product.secondaryName && (
                            <small>{product.secondaryName}</small>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>{product.categoryName}</td>
                    <td>
                      <code>{product.barcodes[0]?.value ?? '—'}</code>
                      {product.barcodes.length > 1 && (
                        <small> +{product.barcodes.length - 1}</small>
                      )}
                    </td>
                    <td>
                      <strong>{money(product.sellingPriceCents)}</strong>
                      <small>Cost {money(product.purchaseCostCents)}</small>
                    </td>
                    <td>
                      <span
                        className={
                          product.stockQuantity <= product.lowStockThreshold
                            ? 'stock low'
                            : 'stock'
                        }
                      >
                        {product.stockQuantity}
                      </span>
                    </td>
                    <td className="row-actions">
                      <button onClick={() => setProductEditor(product)}>
                        Edit
                      </button>
                      <button onClick={() => setLabelProductIds([product.id])}>
                        Print labels
                      </button>
                      <button onClick={() => void toggleProduct(product)}>
                        {product.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {view === 'inventory' && (
          <div className="inventory-grid">
            {visibleProducts.map((product) => (
              <article className="inventory-card" key={product.id}>
                <div>
                  <small>{product.categoryName}</small>
                  <h3>{product.name}</h3>
                </div>
                <div
                  className={
                    product.stockQuantity <= product.lowStockThreshold
                      ? 'big-stock low-text'
                      : 'big-stock'
                  }
                >
                  {product.stockQuantity}
                  <small>in stock</small>
                </div>
                <button onClick={() => setInventoryProduct(product)}>
                  Record movement
                </button>
              </article>
            ))}
          </div>
        )}
        {((view === 'products' && visibleProducts.length === 0) ||
          (view === 'categories' && visibleCategories.length === 0)) && (
          <div className="empty">
            <b>Nothing here yet</b>
            <p>Add an item or change your filters.</p>
          </div>
        )}
      </main>
      {categoryEditor !== undefined && (
        <CategoryModal
          category={categoryEditor}
          onClose={() => setCategoryEditor(undefined)}
          onSaved={async () => {
            setCategoryEditor(undefined);
            await refresh();
          }}
          setError={setError}
        />
      )}
      {productEditor !== undefined && (
        <ProductModal
          product={productEditor}
          categories={categories.filter(
            (c) => c.active || c.id === productEditor?.categoryId,
          )}
          onClose={() => setProductEditor(undefined)}
          onSaved={async () => {
            setProductEditor(undefined);
            await refresh();
          }}
          onPrintLabels={(product) => setLabelProductIds([product.id])}
          setError={setError}
        />
      )}
      {labelProductIds !== undefined && (
        <LabelPrintModal
          products={products}
          categories={categories}
          initialProductIds={
            labelProductIds.length > 0 ? labelProductIds : undefined
          }
          onClose={() => setLabelProductIds(undefined)}
          onProductsChanged={refresh}
          setError={setError}
        />
      )}
      {inventoryProduct && (
        <InventoryModal
          product={inventoryProduct}
          onClose={() => setInventoryProduct(undefined)}
          onSaved={async () => {
            setInventoryProduct(undefined);
            await refresh();
          }}
          setError={setError}
        />
      )}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose(): void;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-title">
          <h2>{title}</h2>
          <button onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ImagePicker({
  imageId,
  onChange,
  onRemove,
}: {
  imageId: string | null;
  onChange(image: StoredImage): void;
  onRemove(): void;
}) {
  return (
    <div className="image-controls">
      <button
        type="button"
        className="image-picker"
        onClick={async () => {
          const image = await window.storeApi.images.choose();
          if (image) onChange(image);
        }}
      >
        {imageId ? <img src={imageUrl(imageId)} /> : <span>＋</span>}
        <div>
          <b>{imageId ? 'Change image' : 'Add image'}</b>
          <small>JPG, PNG, WebP or GIF · max 10 MB</small>
        </div>
      </button>
      {imageId && (
        <button type="button" onClick={onRemove}>
          Remove image
        </button>
      )}
    </div>
  );
}

function useImageLifecycle(initial: string | null) {
  const [imageId, setImageId] = useState<string | null>(initial);
  async function change(image: StoredImage) {
    if (imageId && imageId !== initial)
      await window.storeApi.images.discard(imageId);
    setImageId(image.id);
  }
  async function cancel() {
    if (imageId && imageId !== initial)
      await window.storeApi.images.discard(imageId);
  }
  async function remove() {
    if (imageId && imageId !== initial)
      await window.storeApi.images.discard(imageId);
    setImageId(null);
  }
  async function saved() {
    if (initial && initial !== imageId)
      await window.storeApi.images.discard(initial);
  }
  return { imageId, change, remove, cancel, saved };
}

function CategoryModal({
  category,
  onClose,
  onSaved,
  setError,
}: {
  category: Category | null;
  onClose(): void;
  onSaved(): Promise<void>;
  setError(value: string): void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [secondaryName, setSecondaryName] = useState(
    category?.secondaryName ?? '',
  );
  const images = useImageLifecycle(category?.imageId ?? null);
  const [saving, setSaving] = useState(false);
  async function close() {
    await images.cancel();
    onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const input = {
        name,
        secondaryName: secondaryName || null,
        imageId: images.imageId,
      };
      if (category) await window.storeApi.categories.update(category.id, input);
      else await window.storeApi.categories.create(input);
      await images.saved();
      await onSaved();
    } catch (e) {
      setError(messageFrom(e));
      setSaving(false);
    }
  }
  return (
    <Modal
      title={category ? 'Edit category' : 'New category'}
      onClose={() => void close()}
    >
      <form onSubmit={submit}>
        <ImagePicker
          imageId={images.imageId}
          onChange={(image) => void images.change(image)}
          onRemove={() => void images.remove()}
        />
        <label>
          Name
          <input
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Secondary-language name <em>Optional</em>
          <input
            maxLength={200}
            value={secondaryName}
            onChange={(e) => setSecondaryName(e.target.value)}
          />
        </label>
        <footer>
          <button type="button" onClick={() => void close()}>
            Cancel
          </button>
          <button className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save category'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ProductModal({
  product,
  categories,
  onClose,
  onSaved,
  onPrintLabels,
  setError,
}: {
  product: Product | null;
  categories: Category[];
  onClose(): void;
  onSaved(): Promise<void>;
  onPrintLabels(product: Product): void;
  setError(value: string): void;
}) {
  const [categoryId, setCategoryId] = useState(
    product?.categoryId ?? categories[0]?.id ?? '',
  );
  const [name, setName] = useState(product?.name ?? '');
  const [secondaryName, setSecondaryName] = useState(
    product?.secondaryName ?? '',
  );
  const [cost, setCost] = useState(
    product ? (product.purchaseCostCents / 100).toFixed(2) : '0.00',
  );
  const [price, setPrice] = useState(
    product ? (product.sellingPriceCents / 100).toFixed(2) : '0.00',
  );
  const [threshold, setThreshold] = useState(
    String(product?.lowStockThreshold ?? 0),
  );
  const [taxable, setTaxable] = useState(product?.taxable ?? false);
  const images = useImageLifecycle(product?.imageId ?? null);
  const [barcodes, setBarcodes] = useState(
    product?.barcodes.map((b) => b.value) ?? [],
  );
  const [barcode, setBarcode] = useState('');
  const [saving, setSaving] = useState(false);
  function addBarcode(value = barcode) {
    const clean = value.trim();
    if (clean && !barcodes.includes(clean)) setBarcodes([...barcodes, clean]);
    setBarcode('');
  }
  async function close() {
    await images.cancel();
    onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const input = {
        categoryId,
        name,
        secondaryName: secondaryName || null,
        imageId: images.imageId,
        purchaseCostCents: Math.round(Number(cost) * 100),
        sellingPriceCents: Math.round(Number(price) * 100),
        taxable,
        lowStockThreshold: Number(threshold),
        barcodes,
      };
      if (product) await window.storeApi.products.update(product.id, input);
      else await window.storeApi.products.create(input);
      await images.saved();
      await onSaved();
    } catch (e) {
      setError(messageFrom(e));
      setSaving(false);
    }
  }
  return (
    <Modal
      title={product ? 'Edit product' : 'New product'}
      onClose={() => void close()}
    >
      <form onSubmit={submit}>
        <ImagePicker
          imageId={images.imageId}
          onChange={(image) => void images.change(image)}
          onRemove={() => void images.remove()}
        />
        <div className="form-grid">
          <label>
            Product name
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
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
              required
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="" disabled>
                Choose…
              </option>
              {categories.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Low-stock alert
            <input
              type="number"
              min="0"
              step="1"
              required
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </label>
          <label>
            Purchase cost ($)
            <input
              type="number"
              min="0"
              step="0.01"
              required
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
          <label>
            Selling price ($)
            <input
              type="number"
              min="0"
              step="0.01"
              required
              value={price}
              onChange={(e) => setPrice(e.target.value)}
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
        <div className="barcode-box">
          <label>
            Barcodes <em>Scan or type, then press Enter</em>
            <div className="barcode-entry">
              <input
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addBarcode();
                  }
                }}
              />
              <button type="button" onClick={() => addBarcode()}>
                Add
              </button>
              <button
                type="button"
                onClick={async () =>
                  addBarcode(
                    await window.storeApi.products.generateInternalBarcode(),
                  )
                }
              >
                Generate Code 128
              </button>
            </div>
          </label>
          <div className="chips">
            {barcodes.map((value) => (
              <button
                type="button"
                key={value}
                onClick={() =>
                  setBarcodes(barcodes.filter((item) => item !== value))
                }
              >
                <code>{value}</code> ×
              </button>
            ))}
          </div>
        </div>
        <footer>
          <button type="button" onClick={() => void close()}>
            Cancel
          </button>
          {product && (
            <button type="button" onClick={() => onPrintLabels(product)}>
              Print labels
            </button>
          )}
          <button className="primary" disabled={saving || !categoryId}>
            {saving ? 'Saving…' : 'Save product'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

const reasonLabels: Record<string, string> = {
  stock_received: 'Stock received',
  damaged: 'Damaged',
  customer_return: 'Customer return',
  manual_increase: 'Manual increase',
  manual_decrease: 'Manual reduction',
  stock_count_correction: 'Stock count correction',
  sale: 'Sale',
};

function InventoryModal({
  product,
  onClose,
  onSaved,
  setError,
}: {
  product: Product;
  onClose(): void;
  onSaved(): Promise<void>;
  setError(value: string): void;
}) {
  const [reason, setReason] = useState('stock_received');
  const [quantity, setQuantity] = useState('');
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<
    import('@shul-store/shared').InventoryMovement[]
  >([]);

  useEffect(() => {
    void window.storeApi.inventory
      .list(product.id)
      .then(setHistory)
      .catch((e) => setError(messageFrom(e)));
  }, [product.id, setError]);

  const correction = Number(counted) - product.stockQuantity;
  const isCount = reason === 'stock_count_correction';
  const negative = reason === 'damaged' || reason === 'manual_decrease';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const quantityChange = isCount
      ? correction
      : Math.abs(Number(quantity)) * (negative ? -1 : 1);
    if (quantityChange === 0) return;
    setSaving(true);
    try {
      await window.storeApi.inventory.addMovement({
        productId: product.id,
        quantityChange,
        reason: reason as any,
        notes,
      });
      await onSaved();
    } catch (e) {
      setError(messageFrom(e));
      setSaving(false);
    }
  }

  return (
    <Modal title="Inventory & movement history" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="stock-summary">
          <div>
            <small>Product</small>
            <b>{product.name}</b>
          </div>
          <div>
            <small>Current calculated stock</small>
            <b>{product.stockQuantity}</b>
          </div>
        </div>
        <label>
          Operation
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="stock_received">Receive stock</option>
            <option value="manual_increase">Manual increase</option>
            <option value="customer_return">Customer return</option>
            <option value="manual_decrease">Manual reduction</option>
            <option value="damaged">Damaged inventory</option>
            <option value="stock_count_correction">Physical stock count</option>
          </select>
        </label>
        {isCount ? (
          <>
            <label>
              Actual physical quantity counted
              <input
                autoFocus
                type="number"
                min="0"
                step="1"
                required
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
              />
            </label>
            {counted !== '' && (
              <p className="new-total">
                Calculated adjustment:{' '}
                <b>
                  {correction > 0 ? '+' : ''}
                  {correction}
                </b>
                <br />
                {correction === 0
                  ? 'No correction is required; stock already matches the count.'
                  : `Resulting stock: ${Number(counted)}`}
              </p>
            )}
          </>
        ) : (
          <label>
            Quantity
            <input
              autoFocus
              type="number"
              min="1"
              step="1"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
        )}
        <label>
          Reason details <em>Required for the audit history</em>
          <textarea
            required
            maxLength={1000}
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={saving || (isCount && (counted === '' || correction === 0))}
        >
          {saving ? 'Recording…' : 'Record movement'}
        </button>
        <div className="history">
          <h3>Movement history</h3>
          {history.length === 0 ? (
            <p>No movements yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reason</th>
                  <th>Change</th>
                  <th>Result</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {history.map((movement) => (
                  <tr key={movement.id}>
                    <td>{new Date(movement.occurredAt).toLocaleString()}</td>
                    <td>{reasonLabels[movement.reason]}</td>
                    <td
                      className={movement.quantityChange < 0 ? 'low-text' : ''}
                    >
                      {movement.quantityChange > 0 ? '+' : ''}
                      {movement.quantityChange}
                    </td>
                    <td>{movement.resultingStock}</td>
                    <td>{movement.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </form>
    </Modal>
  );
}
