import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { StoreDatabase } from '@shul-store/database';
import { processors } from '@shul-store/payments';
import {
  calculateCart,
  cartSnapshotSchema,
  errorMessage,
  kioskChargeRequestSchema,
  kioskPairRequestSchema,
  kioskPriceRequestSchema,
} from '@shul-store/shared';

type PairCode = {
  code: string;
  expires: number;
  attempts: number;
  window: number;
};
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
async function body(req: http.IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const c of req) {
    text += c;
    if (text.length > 100_000) throw new Error('Request too large');
  }
  return JSON.parse(text);
}

export class KioskServer {
  private server: http.Server | null = null;
  private code: PairCode | null = null;
  constructor(private readonly db: StoreDatabase) {}
  newPairingCode(): string {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.code = {
      code,
      expires: Date.now() + 300000,
      attempts: 0,
      window: Date.now(),
    };
    return code;
  }
  async start(port = 3939): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((q, s) => void this.handle(q, s));
    await new Promise<void>((ok, bad) =>
      this.server!.listen(port, '0.0.0.0', ok).once('error', bad),
    );
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((ok) => this.server!.close(() => ok()));
    this.server = null;
  }
  private auth(req: http.IncomingMessage) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return null;
    const kiosk = this.db.findKioskByTokenHash(hash(token));
    if (kiosk) this.db.touchKiosk(kiosk.id);
    return kiosk;
  }
  private price(
    lines: {
      productId?: string | undefined;
      barcode?: string | undefined;
      quantity: number;
    }[],
  ) {
    const resolved = lines.map((l) => ({
      product: l.productId
        ? this.db.getProduct(l.productId)
        : this.db.lookupProductByBarcode(l.barcode!),
      quantity: l.quantity,
    }));
    if (resolved.some((x) => !x.product)) throw new Error('Product not found');
    const calc = calculateCart(
      resolved as {
        product: ReturnType<StoreDatabase['getProduct']>;
        quantity: number;
      }[],
      this.db.getSettings(),
    );
    return {
      lines: calc.lines.map((x, i) => ({
        ...x,
        name: resolved[i]!.product!.name,
        secondaryName: resolved[i]!.product!.secondaryName,
      })),
      subtotalCents: calc.subtotalCents,
      taxCents: calc.taxCents,
      totalCents: calc.totalCents,
    };
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const input = kioskPairRequestSchema.parse(await body(req));
        const c = this.code;
        if (!c || Date.now() > c.expires)
          return json(res, 400, { error: 'Pairing code expired' });
        if (Date.now() - c.window > 60000) {
          c.window = Date.now();
          c.attempts = 0;
        }
        if (++c.attempts > 5)
          return json(res, 429, { error: 'Too many attempts' });
        if (input.code !== c.code)
          return json(res, 400, { error: 'Invalid pairing code' });
        this.code = null;
        const token = randomBytes(32).toString('base64url');
        const id = randomUUID();
        this.db.createKiosk(id, input.name, hash(token), hash(input.adminPin));
        return json(res, 200, { token, kioskId: id });
      }
      const kiosk = this.auth(req);
      if (!kiosk) return json(res, 401, { error: 'Unauthorized' });
      if (req.method === 'GET' && url.pathname === '/api/catalog') {
        const ps = this.db
          .listProducts()
          .map((p) => ({
            id: p.id,
            categoryId: p.categoryId,
            name: p.name,
            secondaryName: p.secondaryName,
            barcodes: p.barcodes.map((b) => b.value),
          }));
        const cs = this.db
          .listCategories()
          .map((c) => ({
            id: c.id,
            name: c.name,
            secondaryName: c.secondaryName,
          }));
        return json(res, 200, {
          storeName: this.db.getSettings().storeName,
          categories: cs,
          products: ps,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/cart/price') {
        const input = kioskPriceRequestSchema.parse(await body(req));
        return json(res, 200, this.price(input.lines));
      }
      if (req.method === 'POST' && url.pathname === '/api/charges') {
        const input = kioskChargeRequestSchema.parse(await body(req));
        const old = this.db.getPaymentTransaction(input.chargeReference);
        if (old) return json(res, 200, this.status(input.chargeReference));
        const priced = this.price(input.lines);
        const settings = this.db.getSettings();
        if (!settings.cardProcessingEnabled || !settings.cardProcessorId)
          throw new Error('Card processing is not enabled');
        const snapshot = {
          lines: input.lines.map((l, i) => {
            const p = this.db.getProduct(l.productId);
            const x = priced.lines[i]!;
            return {
              ...l,
              productName: p.name,
              secondaryName: p.secondaryName,
              unitSellingPriceCents: p.sellingPriceCents,
              unitPurchaseCostCents: p.purchaseCostCents,
              taxable: p.taxable,
              unitPriceCents: x.unitPriceCents,
              subtotalCents: x.subtotalCents,
              taxCents: x.taxCents,
              totalCents: x.totalCents,
            };
          }),
          totals: {
            subtotalCents: priced.subtotalCents,
            taxCents: priced.taxCents,
            totalCents: priced.totalCents,
          },
        };
        cartSnapshotSchema.parse(snapshot);
        this.db.createPaymentTransaction(
          input.chargeReference,
          settings.cardProcessorId,
          priced.totalCents,
          JSON.stringify(snapshot),
          input.idempotencyKey,
        );
        const processor = processors.find(
          (p) => p.id === settings.cardProcessorId,
        );
        if (!processor) throw new Error('Processor not found');
        const config = settings.cardProcessorConfigJson
          ? processor.configSchema.parse(
              JSON.parse(settings.cardProcessorConfigJson),
            )
          : {};
        const result = await processor.createCharge(
          {
            chargeReference: input.chargeReference,
            amountCents: priced.totalCents,
          },
          config,
          this.db.getProcessorStorage(),
        );
        this.db.updatePaymentTransactionStatus(
          input.chargeReference,
          result.status === 'pending' ? 'unknown' : result.status,
          result.processorTransactionId,
          result.cardBrand,
          result.cardLast4,
        );
        if (result.status === 'approved') {
          const sale = this.db.completeSale(
            {
              completionKey: input.idempotencyKey,
              lines: input.lines,
              payment: {
                method: 'integrated_card',
                chargeReference: input.chargeReference,
              },
            },
            snapshot,
          );
          this.db.attributeKioskSale(sale.id, kiosk.id);
        }
        return json(res, 200, {
          ...result,
          chargeReference: input.chargeReference,
          totalCents: priced.totalCents,
        });
      }
      const m = url.pathname.match(/^\/api\/charges\/([0-9a-f-]+)$/);
      if (req.method === 'GET' && m)
        return json(res, 200, await this.status(m[1]!));
      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      const status =
        (e as { name?: string }).name === 'ZodError' || e instanceof SyntaxError
          ? 400
          : 500;
      json(res, status, { error: errorMessage(e) });
    }
  }
  private async status(reference: string) {
    const tx = this.db.getPaymentTransaction(reference);
    if (!tx) return { status: 'error', errorMessage: 'Charge not found' };
    return {
      chargeReference: reference,
      status: String(tx.status),
      totalCents: Number(tx.amount_cents),
      receiptNumber: tx.sale_id
        ? this.db.getSale(String(tx.sale_id)).receiptNumber
        : undefined,
    };
  }
}
