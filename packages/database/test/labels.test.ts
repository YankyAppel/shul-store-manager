import { describe, expect, it } from 'vitest';
import {
  expandLabelCopies,
  labelsHtml,
  SHEET_LABELS_PER_PAGE,
  storeSettingsSchema,
} from '@shul-store/shared';

const hostile = {
  name: 'Dan & Sons <script>alert("xss")</script>',
  secondaryName: `Yiddish "name" & 'quote'`,
  storeName: 'Shul <b>Store</b> & Co',
};

describe('label HTML', () => {
  it('escapes hostile product and store names', () => {
    const html = labelsHtml({
      storeName: hostile.storeName,
      template: 'thermal_40x30',
      items: [
        {
          name: hostile.name,
          secondaryName: hostile.secondaryName,
          sellingPriceCents: 599,
          barcode: 'SSM-SAFE-01',
          quantity: 1,
        },
      ],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Store</b>');
    expect(html).toContain(
      'Dan &amp; Sons &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(html).toContain('Yiddish &quot;name&quot; &amp; &#39;quote&#39;');
    expect(html).toContain('Shul &lt;b&gt;Store&lt;/b&gt; &amp; Co');
  });

  it('formats prices from integer cents', () => {
    const html = labelsHtml({
      storeName: 'Store',
      template: 'thermal_57x32',
      items: [
        {
          name: 'Grape Juice',
          sellingPriceCents: 599,
          barcode: '012345678905',
          quantity: 1,
        },
        {
          name: 'Challah',
          sellingPriceCents: 1250,
          barcode: '998877665544',
          quantity: 1,
        },
      ],
    });
    expect(html).toContain('$5.99');
    expect(html).toContain('$12.50');
    expect(html).toContain('data-template="thermal_57x32"');
    expect(html).toContain('@page { size: 57mm 32mm; margin: 0; }');
  });

  it('expands quantities and mixed batches', () => {
    const items = [
      {
        name: 'A',
        sellingPriceCents: 100,
        barcode: 'AAA111',
        quantity: 3,
      },
      {
        name: 'B',
        sellingPriceCents: 200,
        barcode: 'BBB222',
        quantity: 1,
      },
    ];
    expect(expandLabelCopies(items)).toHaveLength(4);
    const html = labelsHtml({
      storeName: 'Store',
      template: 'thermal_40x30',
      items,
    });
    expect(html).toContain('data-label-count="4"');
    expect(html.match(/class="label"/g)?.length).toBe(4);
    expect(html.match(/data-barcode="AAA111"/g)?.length).toBe(3);
    expect(html.match(/data-barcode="BBB222"/g)?.length).toBe(1);
    expect(html).toContain('@page { size: 40mm 30mm; margin: 0; }');
  });

  it('places 30 labels on a letter sheet and page-breaks the 31st', () => {
    const html = labelsHtml({
      storeName: 'Store',
      template: 'letter_avery_5160',
      items: [
        {
          name: 'Item',
          sellingPriceCents: 100,
          barcode: 'SHEET01',
          quantity: 31,
        },
      ],
    });
    expect(SHEET_LABELS_PER_PAGE).toBe(30);
    expect(html).toContain('data-page-count="2"');
    expect(html).toContain('@page { size: 8.5in 11in; margin: 0; }');
    const firstPage = html.match(/data-page="1" data-cell-count="(\d+)"/);
    const secondPage = html.match(/data-page="2" data-cell-count="(\d+)"/);
    expect(firstPage?.[1]).toBe('30');
    expect(secondPage?.[1]).toBe('1');
    expect(html.match(/class="sheet"/g)?.length).toBe(2);
    expect(html.match(/class="label"/g)?.length).toBe(31);
    expect(html).toContain('left:0.1875in;top:0.5in');
    expect(html).toContain('width: 2.625in');
    expect(html).toContain('height: 1in');
  });

  it('applies receipt paper width to receipt CSS without changing line content', () => {
    const base = {
      storeName: 'Store',
      contactLines: [] as string[],
      currency: 'USD' as const,
      taxRateBps: 0,
      pricesIncludeTax: false,
      receiptFooter: '',
    };
    const narrow = storeSettingsSchema.parse({
      ...base,
      receiptPaperWidthMm: 58,
    });
    const wide = storeSettingsSchema.parse({
      ...base,
      receiptPaperWidthMm: 80,
    });
    expect(narrow.receiptPaperWidthMm).toBe(58);
    expect(wide.receiptPaperWidthMm).toBe(80);
  });
});
