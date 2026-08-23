import { useEffect, useMemo, useState } from 'react';
import {
  describePrintResult,
  LABEL_TEMPLATE_OPTIONS,
  selectPreferredBarcode,
  type Category,
  type LabelTemplateId,
  type Product,
  type StoreSettings,
} from '@shul-store/shared';
import { messageFrom } from '../../utils/formatters';

export function LabelPrintModal({
  products,
  categories,
  initialProductIds,
  onClose,
  onProductsChanged,
  setError,
}: {
  products: Product[];
  categories: Category[];
  initialProductIds?: string[] | undefined;
  onClose(): void;
  onProductsChanged(): Promise<void>;
  setError(value: string): void;
}) {
  const [settings, setSettings] = useState<StoreSettings>();
  const [selectedIds, setSelectedIds] = useState<string[]>(
    () => initialProductIds ?? [],
  );
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [barcodes, setBarcodes] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState<LabelTemplateId>('thermal_40x30');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [printMessage, setPrintMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  useEffect(() => {
    void window.storeApi.settings.get().then((value) => {
      setSettings(value);
      setTemplate(value.defaultLabelTemplate);
    });
  }, []);

  const catalog = useMemo(
    () =>
      products.filter(
        (product) =>
          product.active &&
          (!categoryFilter || product.categoryId === categoryFilter),
      ),
    [products, categoryFilter],
  );

  const selectedProducts = useMemo(
    () => products.filter((product) => selectedIds.includes(product.id)),
    [products, selectedIds],
  );

  useEffect(() => {
    setBarcodes((current) => {
      const next = { ...current };
      for (const product of selectedProducts) {
        if (
          next[product.id] &&
          product.barcodes.some((barcode) => barcode.value === next[product.id])
        ) {
          continue;
        }
        const preferred = selectPreferredBarcode(product.barcodes);
        if (preferred) next[product.id] = preferred.value;
      }
      return next;
    });
    setQuantities((current) => {
      const next = { ...current };
      for (const product of selectedProducts) {
        if (!next[product.id]) next[product.id] = 1;
      }
      return next;
    });
  }, [selectedProducts]);

  const requestItems = selectedProducts.flatMap((product) => {
    const barcode = barcodes[product.id];
    const quantity = quantities[product.id] ?? 1;
    if (!barcode) return [];
    return [{ productId: product.id, barcode, quantity }];
  });

  useEffect(() => {
    if (requestItems.length === 0) {
      setPreviewHtml('');
      setPreviewError('');
      return;
    }
    let cancelled = false;
    void window.storeApi.labels
      .render({ items: requestItems, template })
      .then((html) => {
        if (!cancelled) {
          setPreviewHtml(html);
          setPreviewError('');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPreviewHtml('');
          setPreviewError(messageFrom(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [template, JSON.stringify(requestItems)]);

  function toggleProduct(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  function selectAllInCategory() {
    if (!categoryFilter) {
      setSelectedIds(catalog.map((product) => product.id));
      return;
    }
    const ids = catalog
      .filter((product) => product.categoryId === categoryFilter)
      .map((product) => product.id);
    setSelectedIds((current) => [...new Set([...current, ...ids])]);
  }

  async function generateBarcode(product: Product) {
    setGeneratingId(product.id);
    try {
      const value = await window.storeApi.products.generateInternalBarcode();
      await window.storeApi.products.update(product.id, {
        categoryId: product.categoryId,
        name: product.name,
        secondaryName: product.secondaryName,
        imageId: product.imageId,
        purchaseCostCents: product.purchaseCostCents,
        sellingPriceCents: product.sellingPriceCents,
        taxable: product.taxable,
        lowStockThreshold: product.lowStockThreshold,
        barcodes: [...product.barcodes.map((barcode) => barcode.value), value],
      });
      setBarcodes((current) => ({ ...current, [product.id]: value }));
      await onProductsChanged();
    } catch (error) {
      setError(messageFrom(error));
    } finally {
      setGeneratingId(null);
    }
  }

  async function print() {
    if (requestItems.length === 0) return;
    setBusy(true);
    setPrintMessage('');
    try {
      const result = await window.storeApi.labels.print({
        items: requestItems,
        template,
      });
      setPrintMessage(describePrintResult(result, 'Labels'));
    } catch (error) {
      setPrintMessage(messageFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="modal label-print-modal">
        <div className="modal-title">
          <h2>Print product labels</h2>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="label-print-layout">
          <section>
            <label>
              Label template
              <select
                value={template}
                onChange={(event) =>
                  setTemplate(event.target.value as LabelTemplateId)
                }
              >
                {LABEL_TEMPLATE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                    {settings?.defaultLabelTemplate === option.id
                      ? ' (default)'
                      : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="label-select-row">
              <label>
                Category
                <select
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                >
                  <option value="">All categories</option>
                  {categories
                    .filter((category) => category.active)
                    .map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                </select>
              </label>
              <button type="button" onClick={selectAllInCategory}>
                {categoryFilter
                  ? 'Add all products in category'
                  : 'Select all visible'}
              </button>
              <button type="button" onClick={() => setSelectedIds([])}>
                Clear
              </button>
            </div>
            <div className="label-product-list">
              {catalog.map((product) => (
                <label key={product.id} className="label-product-row">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(product.id)}
                    onChange={() => toggleProduct(product.id)}
                  />
                  <span>
                    <strong>{product.name}</strong>
                    <small>
                      {product.categoryName} · {product.barcodes.length} barcode
                      {product.barcodes.length === 1 ? '' : 's'}
                    </small>
                  </span>
                </label>
              ))}
              {catalog.length === 0 && <p>No products match this filter.</p>}
            </div>
          </section>
          <section>
            <h3>Quantities & barcodes</h3>
            {selectedProducts.length === 0 ? (
              <p>Select one or more products to print.</p>
            ) : (
              selectedProducts.map((product) => (
                <div key={product.id} className="label-config-row">
                  <div>
                    <strong>{product.name}</strong>
                    {product.secondaryName && (
                      <small>{product.secondaryName}</small>
                    )}
                  </div>
                  {product.barcodes.length === 0 ? (
                    <button
                      type="button"
                      disabled={generatingId === product.id}
                      onClick={() => void generateBarcode(product)}
                    >
                      {generatingId === product.id
                        ? 'Generating…'
                        : 'Generate internal barcode'}
                    </button>
                  ) : (
                    <>
                      <label>
                        Barcode
                        <select
                          value={barcodes[product.id] ?? ''}
                          onChange={(event) =>
                            setBarcodes((current) => ({
                              ...current,
                              [product.id]: event.target.value,
                            }))
                          }
                        >
                          {product.barcodes.map((barcode) => (
                            <option key={barcode.id} value={barcode.value}>
                              {barcode.value}
                              {barcode.kind === 'CODE128_INTERNAL'
                                ? ' (internal)'
                                : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Qty
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={quantities[product.id] ?? 1}
                          onChange={(event) =>
                            setQuantities((current) => ({
                              ...current,
                              [product.id]: Math.max(
                                1,
                                Number(event.target.value) || 1,
                              ),
                            }))
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
              ))
            )}
            {printMessage && (
              <div
                className={
                  printMessage.toLowerCase().includes('failed')
                    ? 'alert'
                    : 'success'
                }
              >
                {printMessage}
              </div>
            )}
            {previewError && <div className="alert">{previewError}</div>}
            <div className="label-preview-scroll">
              {previewHtml ? (
                <iframe
                  title="Label print preview"
                  sandbox=""
                  srcDoc={previewHtml}
                  className="label-preview-frame"
                />
              ) : (
                <p className="label-preview-empty">
                  Preview appears here once every selected product has a
                  barcode.
                </p>
              )}
            </div>
          </section>
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || requestItems.length === 0}
            onClick={() => void print()}
          >
            {busy ? 'Printing…' : 'Print labels'}
          </button>
        </footer>
      </div>
    </div>
  );
}
