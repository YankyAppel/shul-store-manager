import type { StoreDatabase } from '@shul-store/database';
import {
  buildPriceTagTemplate,
  createEslProvider,
  type EslProvider,
  type EslTagDescriptor,
} from '@shul-store/hardware';
import type {
  EslProbeResult,
  EslStatus,
  EslTag,
  PriceTagAssignInput,
  PriceTagLink,
} from '@shul-store/shared';
import { tagMacSchema } from '@shul-store/shared';

/** Drives ink-tag pushes: watches the pending queue, renders each linked
 * product as an AP JSON template and pushes it. Tag display sizes are
 * fetched per hwType from the AP's /tagtypes/<hex>.json and cached. */
export interface EslDriver {
  applySettings(): Promise<void>;
  status(): EslStatus;
  listTags(): Promise<EslTag[]>;
  probe(): Promise<EslProbeResult>;
  flashLed(mac: string): Promise<void>;
  assign(input: PriceTagAssignInput): Promise<PriceTagLink>;
  unbind(productId: string): void;
  pushNow(productId: string): Promise<PriceTagLink>;
  stop(): void;
}

const POLL_MS = 4000;
const FALLBACK_DESCRIPTOR: EslTagDescriptor = { width: 296, height: 128 };

export function createEslDriver(options: {
  database: () => StoreDatabase;
  broadcast(channel: 'esl:status', status: EslStatus): void;
}): EslDriver {
  let provider: EslProvider = createEslProvider({
    mode: 'none',
    baseUrl: null,
  });
  let polling: NodeJS.Timeout | null = null;
  let pushing = false;
  let lastError: string | null = null;
  let lastTagCount: number | null = null;
  let connected = false;
  const descriptors = new Map<number, EslTagDescriptor | null>();

  function db(): StoreDatabase {
    return options.database();
  }

  function status(): EslStatus {
    const settings = db().getDeviceSettings();
    return {
      mode: settings.eslMode,
      connected,
      baseUrl: settings.eslBaseUrl,
      tagCount: lastTagCount,
      pendingPushes: db().countPendingPriceTagPushes(),
      error: lastError,
    };
  }

  function broadcastStatus(): void {
    try {
      options.broadcast('esl:status', status());
    } catch {
      // windows not ready yet
    }
  }

  async function applySettings(): Promise<void> {
    const settings = db().getDeviceSettings();
    provider = createEslProvider({
      mode: settings.eslMode,
      baseUrl: settings.eslBaseUrl,
    });
    descriptors.clear();
    connected = settings.eslMode === 'simulated';
    lastError = null;
    if (settings.eslMode !== 'none' && !polling) {
      polling = setInterval(() => {
        void processPending();
      }, POLL_MS);
      void processPending();
    }
    if (settings.eslMode === 'none' && polling) {
      clearInterval(polling);
      polling = null;
      connected = false;
      lastTagCount = null;
    }
    broadcastStatus();
  }

  async function descriptor(hwType: number | null): Promise<EslTagDescriptor> {
    if (hwType === null) return FALLBACK_DESCRIPTOR;
    if (!descriptors.has(hwType)) {
      descriptors.set(hwType, await provider.tagDescriptor(hwType));
    }
    return descriptors.get(hwType) ?? FALLBACK_DESCRIPTOR;
  }

  function priceText(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  async function pushLink(link: PriceTagLink): Promise<void> {
    const product = db().getProduct(link.productId);
    const { width, height } = await descriptor(link.tagType);
    const ops = buildPriceTagTemplate({
      name: product.name,
      priceText: priceText(product.salePriceCents ?? product.sellingPriceCents),
      unitLabel: product.soldBy === 'weight' ? `/ ${product.unit}` : null,
      width,
      height,
    });
    await provider.pushTemplate(link.tagMac, ops);
  }

  async function processPending(): Promise<void> {
    if (pushing) return;
    pushing = true;
    try {
      db().markSaleBoundaryPriceTags();
      const pending = db().listPendingPriceTagPushes();
      for (const link of pending) {
        try {
          await pushLink(link);
          db().recordPriceTagPush(link.id, true);
          connected = true;
          lastError = null;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Tag push failed';
          db().recordPriceTagPush(link.id, false, message);
          connected = false;
          lastError = message;
        }
      }
      broadcastStatus();
    } finally {
      pushing = false;
    }
  }

  async function tagDimensions(
    hwType: number,
  ): Promise<{ widthPx: number | null; heightPx: number | null }> {
    const descriptor = await provider.tagDescriptor(hwType);
    return descriptor
      ? { widthPx: descriptor.width, heightPx: descriptor.height }
      : { widthPx: null, heightPx: null };
  }

  return {
    applySettings,
    status,
    async listTags(): Promise<EslTag[]> {
      const tags = await provider.listTags();
      lastTagCount = tags.length;
      connected = true;
      const result: EslTag[] = [];
      for (const tag of tags) {
        const { widthPx, heightPx } = await tagDimensions(tag.hwType);
        result.push({
          mac: tag.mac,
          alias: tag.alias,
          hwType: tag.hwType,
          batteryMv: tag.batteryMv,
          rssi: tag.rssi,
          lastSeenAt:
            tag.lastSeen === null
              ? null
              : new Date(tag.lastSeen * 1000).toISOString(),
          pending: tag.pending,
          widthPx,
          heightPx,
        });
      }
      broadcastStatus();
      return result;
    },
    async probe(): Promise<EslProbeResult> {
      const result = await provider.probe();
      connected = result.ok;
      lastTagCount = result.tagCount;
      lastError = result.ok ? null : result.detail;
      broadcastStatus();
      return result;
    },
    async flashLed(mac: string): Promise<void> {
      await provider.flashLed(tagMacSchema.parse(mac));
    },
    async assign(input: PriceTagAssignInput): Promise<PriceTagLink> {
      const link = db().assignPriceTag(input);
      void processPending();
      broadcastStatus();
      return link;
    },
    unbind(productId: string): void {
      db().unbindPriceTag(productId);
      broadcastStatus();
    },
    async pushNow(productId: string): Promise<PriceTagLink> {
      db().markPriceTagPending(productId);
      const link = db().getPriceTagLink(productId);
      if (!link) throw new Error('No ink tag linked to this product');
      void processPending();
      broadcastStatus();
      return link;
    },
    stop(): void {
      if (polling) clearInterval(polling);
      polling = null;
    },
  };
}
