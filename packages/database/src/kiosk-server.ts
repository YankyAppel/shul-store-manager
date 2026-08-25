import http from 'node:http';
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  calculateCart,
  kioskChargeRequestSchema,
  kioskPairRequestSchema,
  kioskPriceRequestSchema,
} from '@shul-store/shared';
import {
  PaymentError,
  PaymentService,
  type PaymentFailureCode,
} from './payment-service.js';
import type { StoreDatabase } from './store-database.js';

/**
 * LAN kiosk API.
 *
 * This is the network edge only: authentication, request parsing and HTTP status mapping.
 * Every financial decision (validation, snapshot freezing, reservation, authorization,
 * finalization, reconciliation) is delegated to the shared {@link PaymentService} so the
 * kiosk and the desktop manager cannot diverge.
 */

type PairCode = {
  code: string;
  expires: number;
  attempts: number;
  window: number;
};

const PAIR_IP_WINDOW_MS = 300000;
const MAX_PAIR_ATTEMPTS_PER_IP = 10;

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 100_000) throw new Error('Request too large');
  }
  return JSON.parse(text);
}

/** HTTP mapping for deterministic payment failures. */
export function paymentFailureStatus(code: PaymentFailureCode): number {
  switch (code) {
    case 'invalid-request':
      return 400;
    case 'kiosk-unknown':
      return 403;
    case 'charge-not-found':
      return 404;
    case 'card-processing-disabled':
    case 'processor-not-found':
    case 'processor-config-invalid':
      return 422;
    default:
      return 409;
  }
}

export class KioskServer {
  private server: http.Server | null = null;
  private code: PairCode | null = null;
  private readonly pairAttemptsByAddress = new Map<string, number[]>();
  private readonly payments: PaymentService;

  constructor(private readonly db: StoreDatabase) {
    this.payments = db.payments;
  }

  newPairingCode(): string {
    const code = String(randomInt(100000, 1000000));
    this.code = {
      code,
      expires: Date.now() + 300000,
      attempts: 0,
      window: Date.now(),
    };
    return code;
  }

  private allowPairAttempt(address: string, timestamp = Date.now()): boolean {
    for (const [key, attempts] of this.pairAttemptsByAddress) {
      const active = attempts.filter(
        (attempt) => timestamp - attempt < PAIR_IP_WINDOW_MS,
      );
      if (active.length === 0) this.pairAttemptsByAddress.delete(key);
      else this.pairAttemptsByAddress.set(key, active);
    }

    const attempts = this.pairAttemptsByAddress.get(address) ?? [];
    if (attempts.length >= MAX_PAIR_ATTEMPTS_PER_IP) return false;
    attempts.push(timestamp);
    this.pairAttemptsByAddress.set(address, attempts);
    return true;
  }

  async start(port = 3939, host = '0.0.0.0'): Promise<number> {
    if (this.server) return this.port();
    this.server = http.createServer((q, s) => void this.handle(q, s));
    await new Promise<void>((ok, bad) =>
      this.server!.listen(port, host, ok).once('error', bad),
    );
    return this.port();
  }

  /** The bound port; 0 when the server is not running. */
  port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((ok) => server.close(() => ok()));
  }

  private auth(req: http.IncomingMessage) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return null;
    const kiosk = this.db.findKioskByTokenHash(hash(token));
    if (kiosk) this.db.touchKiosk(kiosk.id);
    return kiosk;
  }

  /** Read-only quote for the kiosk cart screen. Resolves barcode-or-id lines. */
  quote(
    lines: {
      productId?: string | undefined;
      barcode?: string | undefined;
      barcodeUsed?: string | null | undefined;
      quantity: number;
    }[],
  ) {
    const resolved = lines.map((line) => {
      let product;
      try {
        product = line.productId
          ? this.db.getProduct(line.productId)
          : this.db.lookupProductByBarcode(line.barcode!);
      } catch {
        product = null;
      }
      if (!product)
        throw new PaymentError('product-not-found', 'Product not found');
      return {
        product,
        quantity: line.quantity,
        barcode: line.barcode ?? line.barcodeUsed ?? undefined,
      };
    });
    const demand = new Map<string, number>();
    for (const entry of resolved) {
      const product = entry.product!;
      if (!product.active)
        throw new PaymentError(
          'product-inactive',
          `${product.name} is inactive and cannot be sold.`,
        );
      if (
        entry.barcode &&
        !product.barcodes.some(
          (barcode) =>
            barcode.value.toLowerCase() === entry.barcode!.toLowerCase(),
        )
      )
        throw new PaymentError(
          'barcode-mismatch',
          'Barcode does not belong to the selected product',
        );
      demand.set(product.id, (demand.get(product.id) ?? 0) + entry.quantity);
    }
    for (const [productId, quantity] of demand) {
      const product = this.db.getProduct(productId);
      const available =
        product.stockQuantity - this.db.heldQuantityFor(productId, null);
      if (quantity > available)
        throw new PaymentError(
          'insufficient-stock',
          `Insufficient stock for ${product.name}. Available: ${available}.`,
        );
    }
    const calc = calculateCart(
      resolved as {
        product: ReturnType<StoreDatabase['getProduct']>;
        quantity: number;
      }[],
      this.db.getSettings(),
    );
    return {
      lines: calc.lines.map((line, index) => ({
        ...line,
        name: resolved[index]!.product!.name,
        secondaryName: resolved[index]!.product!.secondaryName,
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
        const address = req.socket.remoteAddress ?? 'unknown';
        if (!this.allowPairAttempt(address))
          return json(res, 429, { error: 'Too many attempts' });
        const input = kioskPairRequestSchema.parse(await readBody(req));
        const pending = this.code;
        if (!pending || Date.now() > pending.expires)
          return json(res, 400, { error: 'Pairing code expired' });
        if (Date.now() - pending.window > 60000) {
          pending.window = Date.now();
          pending.attempts = 0;
        }
        if (++pending.attempts > 5)
          return json(res, 429, { error: 'Too many attempts' });
        const inputCode = Buffer.from(input.code);
        const pendingCode = Buffer.from(pending.code);
        if (
          inputCode.length !== pendingCode.length ||
          !timingSafeEqual(inputCode, pendingCode)
        )
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
        return json(res, 200, {
          storeName: this.db.getSettings().storeName,
          categories: this.db.listCategories().map((category) => ({
            id: category.id,
            name: category.name,
            secondaryName: category.secondaryName,
          })),
          products: this.db.listProducts().map((product) => ({
            id: product.id,
            categoryId: product.categoryId,
            name: product.name,
            secondaryName: product.secondaryName,
            barcodes: product.barcodes.map((barcode) => barcode.value),
          })),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/cart/price') {
        const input = kioskPriceRequestSchema.parse(await readBody(req));
        return json(res, 200, this.quote(input.lines));
      }

      if (req.method === 'POST' && url.pathname === '/api/charges') {
        const input = kioskChargeRequestSchema.parse(await readBody(req));
        const outcome = await this.payments.charge(
          {
            chargeReference: input.chargeReference,
            idempotencyKey: input.idempotencyKey,
            lines: input.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              barcodeUsed: line.barcodeUsed,
            })),
          },
          { channel: 'kiosk', kioskId: kiosk.id },
        );
        return json(res, 200, {
          status: outcome.status,
          chargeReference: outcome.chargeReference,
          totalCents: outcome.totalCents,
          ...(outcome.processorTransactionId
            ? { processorTransactionId: outcome.processorTransactionId }
            : {}),
          ...(outcome.cardBrand ? { cardBrand: outcome.cardBrand } : {}),
          ...(outcome.cardLast4 ? { cardLast4: outcome.cardLast4 } : {}),
          ...(outcome.declineReason
            ? { declineReason: outcome.declineReason }
            : {}),
          ...(outcome.errorMessage
            ? { errorMessage: outcome.errorMessage }
            : {}),
          ...(outcome.receiptNumber !== undefined
            ? { receiptNumber: outcome.receiptNumber }
            : {}),
        });
      }

      const match = url.pathname.match(/^\/api\/charges\/([0-9a-f-]+)$/);
      if (req.method === 'GET' && match)
        return json(res, 200, await this.status(match[1]!, kiosk.id));

      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof PaymentError) {
        const status = paymentFailureStatus(error.code);
        const cartUnavailable = [
          'insufficient-stock',
          'product-inactive',
          'barcode-mismatch',
          'product-not-found',
        ].includes(error.code);
        if (status >= 500) console.error('Kiosk LAN API error', error);
        return json(
          res,
          status,
          cartUnavailable
            ? { error: 'cart-unavailable' }
            : { error: error.message },
        );
      }
      const status =
        (error as { name?: string }).name === 'ZodError' ||
        error instanceof SyntaxError
          ? 400
          : 500;
      if (status === 500) {
        console.error('Kiosk LAN API error', error);
        json(res, status, { error: 'Unable to process request' });
      } else json(res, status, { error: 'invalid-request' });
    }
  }

  private async status(reference: string, kioskId?: string) {
    const initial = this.db.getPaymentTransaction(reference);
    if (initial && kioskId && String(initial.kiosk_id) !== kioskId)
      return { status: 'error', errorMessage: 'Charge not found' };
    if (initial && ['initiated', 'unknown'].includes(String(initial.status)))
      await this.payments.reconcile(reference);
    const tx = this.db.getPaymentTransaction(reference);
    if (!tx) return { status: 'error', errorMessage: 'Charge not found' };
    return {
      chargeReference: reference,
      status: String(tx.status),
      totalCents: Number(tx.amount_cents),
      ...(tx.attention_reason
        ? { attentionReason: String(tx.attention_reason) }
        : {}),
      receiptNumber: tx.sale_id
        ? this.db.getSale(String(tx.sale_id)).receiptNumber
        : undefined,
    };
  }
}
