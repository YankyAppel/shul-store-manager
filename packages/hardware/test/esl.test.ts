import { describe, expect, it } from 'vitest';
import {
  buildPriceTagTemplate,
  createEslProvider,
  SimulatedEslProvider,
} from '../src/index.js';
import type { FetchLike, FetchResponse } from '../src/esl.js';

function fakeFetch(
  handler: (
    url: string,
    init?: { method?: string; body?: unknown },
  ) => {
    status: number;
    body: string;
  },
): FetchLike {
  return async (url: string, init?: { method?: string; body?: unknown }) => {
    const { status, body } = handler(url, init);
    const response: FetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
    };
    return response;
  };
}

describe('buildPriceTagTemplate', () => {
  it('renders name, divider and price', () => {
    const ops = buildPriceTagTemplate({
      name: 'Gefilte Fish',
      priceText: '$4.99',
      width: 296,
      height: 128,
    });
    const kinds = ops.map((op) => Object.keys(op)[0]);
    expect(kinds).toContain('textbox');
    expect(kinds).toContain('line');
    expect(kinds).toContain('text');
    const priceOp = ops.find((op) => 'text' in op && op.text[2] === '$4.99') as
      { text: unknown[] } | undefined;
    expect(priceOp).toBeTruthy();
  });

  it('uses the digit font for tall tags and adds a unit label', () => {
    const ops = buildPriceTagTemplate({
      name: 'Salmon',
      priceText: '$9.99',
      unitLabel: '/ lb',
      width: 400,
      height: 300,
    });
    const fonts = ops.flatMap((op) =>
      'text' in op ? [String((op.text as unknown[])[3])] : [],
    );
    expect(fonts.some((font) => font.includes('bahnschrift70'))).toBe(true);
    const unit = ops.find(
      (op) => 'text' in op && (op.text as unknown[])[2] === '/ lb',
    );
    expect(unit).toBeTruthy();
  });
});

describe('SimulatedEslProvider', () => {
  it('probes and lists tags without hardware', async () => {
    const provider = new SimulatedEslProvider();
    const probe = await provider.probe();
    expect(probe.ok).toBe(true);
    expect(probe.tagCount).toBe(3);
    const tags = await provider.listTags();
    expect(tags).toHaveLength(3);
    const descriptor = await provider.tagDescriptor(tags[0].hwType);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.width).toBeGreaterThan(0);
    await provider.pushTemplate('A1B2C3D4E5F6', []);
    expect(provider.pushes).toHaveLength(1);
  });
});

describe('OpenEpaperLinkProvider', () => {
  it('walks get_db pagination and maps tag fields', async () => {
    const pages: Record<string, object> = {
      'pos=0': {
        tags: [
          {
            mac: 'A1B2C3D4E5F60102',
            alias: 'Aisle 1',
            hwType: 0x1b,
            batteryMv: 2900,
            RSSI: -55,
            lastseen: 1_700_000_000,
            pending: 0,
          },
        ],
        continu: 1,
      },
      'pos=1': {
        tags: [
          {
            mac: 'B2C3D4E5F6A10203',
            alias: '',
            hwType: 0x0d,
            batteryMv: 0,
            RSSI: -80,
            lastseen: 0,
            pending: 1,
          },
        ],
        continu: 0,
      },
    };
    const provider = createEslProvider({
      mode: 'openepaperlink',
      baseUrl: 'http://10.0.0.5',
      fetchImpl: fakeFetch((url) => {
        const pos = new URL(url).search.replace('?', '');
        const page = pages[pos];
        if (!page) return { status: 500, body: `missing ${pos}` };
        return { status: 200, body: JSON.stringify(page) };
      }),
    });
    const tags = await provider.listTags();
    expect(tags).toHaveLength(2);
    expect(tags[0]).toMatchObject({
      mac: 'A1B2C3D4E5F60102',
      alias: 'Aisle 1',
      hwType: 0x1b,
      batteryMv: 2900,
      rssi: -55,
      pending: 0,
      lastSeen: 1_700_000_000,
    });
    expect(tags[1].batteryMv).toBeNull();
    expect(tags[1].lastSeen).toBeNull();
    expect(tags[1].pending).toBe(1);
  });

  it('posts the template as a form-encoded jsonupload', async () => {
    const calls: { url: string; body: string }[] = [];
    const provider = createEslProvider({
      mode: 'openepaperlink',
      baseUrl: 'http://10.0.0.5/',
      fetchImpl: fakeFetch((url, init) => {
        calls.push({ url, body: String(init?.body) });
        return { status: 200, body: '{"ok":true}' };
      }),
    });
    await provider.pushTemplate('A1B2C3D4E5F6', [
      { text: [0, 0, '$1.00', 'bahnschrift30', 1] },
    ]);
    expect(calls[0].url).toBe('http://10.0.0.5/jsonupload');
    const form = new URLSearchParams(calls[0].body);
    expect(form.get('mac')).toBe('A1B2C3D4E5F6');
    expect(form.get('json')).toContain('$1.00');
  });

  it('throws when the AP returns an error', async () => {
    const provider = createEslProvider({
      mode: 'openepaperlink',
      baseUrl: 'http://10.0.0.5',
      fetchImpl: fakeFetch(() => ({ status: 500, body: 'boom' })),
    });
    const probe = await provider.probe();
    expect(probe.ok).toBe(false);
  });
});
