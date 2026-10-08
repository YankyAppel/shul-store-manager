import type { EslProbeResult } from '@shul-store/shared';
import type { EslMode } from '@shul-store/shared';

export interface RawEslTag {
  mac: string;
  alias: string;
  hwType: number;
  batteryMv: number | null;
  rssi: number | null;
  /** Unix seconds of the tag's last check-in. */
  lastSeen: number | null;
  pending: number;
}

export interface EslTagDescriptor {
  width: number;
  height: number;
}

export interface EslProvider {
  readonly mode: EslMode;
  probe(): Promise<EslProbeResult>;
  listTags(): Promise<RawEslTag[]>;
  /** Display descriptor for a tag's hwType, or null when unknown. */
  tagDescriptor(hwType: number): Promise<EslTagDescriptor | null>;
  /** Render ops JSON array understood by the AP's json-template content
   * mode (POST /jsonupload). */
  pushTemplate(mac: string, ops: Record<string, unknown>[]): Promise<void>;
  /** Ask the AP to regenerate + resend the tag's current content. */
  refresh(mac: string): Promise<void>;
  /** Blink the tag's LED so staff can identify the physical tag. */
  flashLed(mac: string): Promise<void>;
}

export interface EslProviderOptions {
  mode: EslMode;
  /** e.g. 'http://192.168.1.50' — the AP runs plain HTTP on port 80. */
  baseUrl: string | null;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike | undefined;
}

export type FetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  },
) => Promise<FetchResponse>;

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init) as Promise<FetchResponse>;

/** Price-tag layout for the AP's JSON template mode: product name in a
 * wrapping textbox up top, a divider, then the price in the largest digit
 * font that fits, plus a "/ lb"-style unit suffix for weighted items.
 * bahnschrift70 only contains digits and '.', so it suits prices. */
export function buildPriceTagTemplate(input: {
  name: string;
  /** Ready-to-render price, e.g. '$4.99'. */
  priceText: string;
  /** e.g. '/ lb' for sold-by-weight products. */
  unitLabel?: string | null;
  width: number;
  height: number;
}): Record<string, unknown>[] {
  const { name, priceText, unitLabel, width, height } = input;
  const ops: Record<string, unknown>[] = [];
  const nameHeight = Math.max(24, Math.round(height * 0.38));
  ops.push({
    textbox: [6, 4, width - 12, nameHeight, name, 'bahnschrift20', 1],
  });
  ops.push({ line: [0, nameHeight + 6, width, nameHeight + 6, 1] });
  const priceFontSize = height >= 130 ? 70 : height >= 95 ? 50 : 30;
  const priceFont =
    priceFontSize === 70
      ? 'fonts/bahnschrift70'
      : priceFontSize === 50
        ? 'fonts/calibrib50'
        : 'bahnschrift30';
  const priceY = Math.max(nameHeight + 10, height - priceFontSize - 6);
  ops.push({ text: [6, priceY, priceText, priceFont, 1] });
  if (unitLabel) {
    ops.push({
      text: [width - 6, height - 26, unitLabel, 'bahnschrift20', 1, 2],
    });
  }
  return ops;
}

class NullEslProvider implements EslProvider {
  readonly mode = 'none' as const;
  async probe(): Promise<EslProbeResult> {
    return { ok: false, detail: 'Ink tags disabled', tagCount: null };
  }
  async listTags(): Promise<RawEslTag[]> {
    return [];
  }
  async tagDescriptor(): Promise<EslTagDescriptor | null> {
    return null;
  }
  async pushTemplate(): Promise<void> {
    throw new Error('Ink tags are disabled');
  }
  async refresh(): Promise<void> {}
  async flashLed(): Promise<void> {
    throw new Error('Ink tags are disabled');
  }
}

/** OpenEPaperLink ESP32 access point. No auth, plain HTTP on port 80. */
export class OpenEpaperLinkProvider implements EslProvider {
  readonly mode = 'openepaperlink' as const;
  private base: string;
  private fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = defaultFetch) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  private async postForm(
    path: string,
    params: Record<string, string>,
  ): Promise<void> {
    const res = await this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok)
      throw new Error(
        `AP ${path} failed (${res.status}): ${body.slice(0, 120)}`,
      );
  }

  async probe(): Promise<EslProbeResult> {
    try {
      const res = await this.fetchImpl(this.url('/get_db?pos=0'));
      if (!res.ok)
        return { ok: false, detail: `HTTP ${res.status}`, tagCount: null };
      const data = (await res.json()) as { tags?: unknown[] };
      const tagCount = Array.isArray(data.tags) ? data.tags.length : null;
      return { ok: true, detail: null, tagCount };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'AP unreachable',
        tagCount: null,
      };
    }
  }

  async listTags(): Promise<RawEslTag[]> {
    const tags: RawEslTag[] = [];
    let pos = 0;
    for (let page = 0; page < 50; page += 1) {
      const res = await this.fetchImpl(this.url(`/get_db?pos=${pos}`));
      if (!res.ok) throw new Error(`AP get_db failed (${res.status})`);
      const data = (await res.json()) as {
        tags?: Record<string, unknown>[];
        continu?: number;
      };
      for (const raw of data.tags ?? []) {
        tags.push({
          mac: String(raw.mac ?? ''),
          alias: String(raw.alias ?? ''),
          hwType: Number(raw.hwType ?? 0),
          batteryMv:
            typeof raw.batteryMv === 'number' && raw.batteryMv > 0
              ? raw.batteryMv
              : null,
          rssi:
            typeof raw.RSSI === 'number' && raw.RSSI !== 100 ? raw.RSSI : null,
          lastSeen:
            typeof raw.lastseen === 'number' && raw.lastseen > 0
              ? raw.lastseen
              : null,
          pending: typeof raw.pending === 'number' ? raw.pending : 0,
        });
      }
      if (!data.continu || data.continu <= pos) break;
      pos = data.continu;
    }
    return tags;
  }

  async tagDescriptor(hwType: number): Promise<EslTagDescriptor | null> {
    const hex = hwType.toString(16).padStart(2, '0').toUpperCase();
    const res = await this.fetchImpl(this.url(`/tagtypes/${hex}.json`));
    if (!res.ok) return null;
    const data = (await res.json()) as { width?: number; height?: number };
    if (
      typeof data.width !== 'number' ||
      typeof data.height !== 'number' ||
      data.width <= 0 ||
      data.height <= 0
    )
      return null;
    return { width: data.width, height: data.height };
  }

  async pushTemplate(
    mac: string,
    ops: Record<string, unknown>[],
  ): Promise<void> {
    await this.postForm('/jsonupload', {
      mac,
      json: JSON.stringify(ops),
    });
  }

  async refresh(mac: string): Promise<void> {
    await this.postForm('/tag_cmd', { mac, cmd: 'refresh' });
  }

  async flashLed(mac: string): Promise<void> {
    await this.postForm('/tag_cmd', { mac, cmd: 'ledflash' });
  }
}

export class SimulatedEslProvider implements EslProvider {
  readonly mode = 'simulated' as const;
  private tags: RawEslTag[] = [
    {
      mac: 'A1B2C3D4E5F6',
      alias: 'Aisle 1 shelf',
      hwType: 0x1b,
      batteryMv: 2980,
      rssi: -58,
      lastSeen: Math.floor(Date.now() / 1000),
      pending: 0,
    },
    {
      mac: 'B2C3D4E5F6A1',
      alias: '',
      hwType: 0x33,
      batteryMv: 3050,
      rssi: -71,
      lastSeen: Math.floor(Date.now() / 1000) - 120,
      pending: 0,
    },
    {
      mac: 'C3D4E5F6A1B2',
      alias: 'Checkout endcap',
      hwType: 0x0d,
      batteryMv: 2810,
      rssi: -63,
      lastSeen: Math.floor(Date.now() / 1000) - 30,
      pending: 0,
    },
  ];
  /** Recorded pushes, for status/testing. */
  pushes: { mac: string; ops: Record<string, unknown>[] }[] = [];

  async probe(): Promise<EslProbeResult> {
    return { ok: true, detail: 'Simulated access point', tagCount: 3 };
  }
  async listTags(): Promise<RawEslTag[]> {
    return this.tags.map((tag) => ({ ...tag }));
  }
  async tagDescriptor(hwType: number): Promise<EslTagDescriptor | null> {
    const sizes: Record<number, EslTagDescriptor> = {
      0x1b: { width: 296, height: 128 }, // 2.9"
      0x33: { width: 400, height: 300 }, // 4.2"
      0x0d: { width: 250, height: 122 }, // 2.13"
    };
    return sizes[hwType] ?? { width: 296, height: 128 };
  }
  async pushTemplate(
    mac: string,
    ops: Record<string, unknown>[],
  ): Promise<void> {
    if (!this.tags.some((tag) => tag.mac === mac))
      throw new Error(`Simulated tag ${mac} not found`);
    this.pushes.push({ mac, ops });
  }
  async refresh(): Promise<void> {}
  async flashLed(mac: string): Promise<void> {
    if (!this.tags.some((tag) => tag.mac === mac))
      throw new Error(`Simulated tag ${mac} not found`);
  }
}

export function createEslProvider(options: EslProviderOptions): EslProvider {
  switch (options.mode) {
    case 'simulated':
      return new SimulatedEslProvider();
    case 'openepaperlink':
      return options.baseUrl
        ? new OpenEpaperLinkProvider(options.baseUrl, options.fetchImpl)
        : new NullEslProvider();
    default:
      return new NullEslProvider();
  }
}
