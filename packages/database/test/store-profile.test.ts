import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsPayload } from '@shul-store/shared';
import {
  migrations,
  StoreDatabase,
  type ValidatedRestoreEvent,
} from '../src/index.js';

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

let store: StoreDatabase;

beforeEach(() => {
  store = new StoreDatabase(':memory:');
});

afterEach(() => store.close());

/** Build a v30 (pre-store-profile) database at `filename`. */
function createV30Database(filename: string): void {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const migration of migrations.filter((item) => item.version <= 30)) {
      migration.before?.(db);
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
  } finally {
    db.close();
  }
}

function addProduct(filename: string): void {
  const db = new DatabaseSync(filename);
  try {
    const stamp = '2026-01-01T00:00:00.000Z';
    const categoryId = randomUUID();
    db.prepare(
      `INSERT INTO categories (id, name, active, created_at, updated_at)
       VALUES (?, 'Shelf', 1, ?, ?)`,
    ).run(categoryId, stamp, stamp);
    db.prepare(
      `INSERT INTO products
       (id, category_id, name, purchase_cost_cents, selling_price_cents,
        taxable, low_stock_threshold, active, created_at, updated_at)
       VALUES (?, ?, 'Challah', 100, 250, 0, 0, 1, ?, ?)`,
    ).run(randomUUID(), categoryId, stamp, stamp);
  } finally {
    db.close();
  }
}

function settingsEvent(
  patch: Record<string, unknown>,
  omit: string[] = [],
): ValidatedRestoreEvent {
  const payload: Record<string, unknown> = { ...store.getSettings(), ...patch };
  for (const key of omit) delete payload[key];
  return {
    sequence: 1,
    eventId: randomUUID(),
    entityType: 'settings',
    entityId: 'settings',
    operation: 'upsert',
    createdAt: '2026-01-01T00:00:00.000Z',
    payload: payload as SettingsPayload,
  };
}

describe('store profile settings', () => {
  it('migrates a fresh database with the profile still incomplete', () => {
    const settings = store.getSettings();
    expect(settings.profileCompleted).toBe(false);
    expect(settings.logoDataUrl).toBeNull();
  });

  it('marks databases that already have products as profile-complete', () => {
    const filename = path.join(tmpdir(), `shul-v30-${randomUUID()}.sqlite`);
    createV30Database(filename);
    addProduct(filename);
    const upgraded = new StoreDatabase(filename);
    try {
      expect(upgraded.getSettings().profileCompleted).toBe(true);
    } finally {
      upgraded.close();
      rmSync(filename, { force: true });
    }
  });

  it('leaves empty pre-upgrade databases incomplete', () => {
    const filename = path.join(tmpdir(), `shul-v30-${randomUUID()}.sqlite`);
    createV30Database(filename);
    const upgraded = new StoreDatabase(filename);
    try {
      expect(upgraded.getSettings().profileCompleted).toBe(false);
    } finally {
      upgraded.close();
      rmSync(filename, { force: true });
    }
  });

  it('round-trips the logo and flag through updateSettings', () => {
    const updated = store.updateSettings({
      ...store.getSettings(),
      logoDataUrl: LOGO,
      profileCompleted: true,
    });
    expect(updated.logoDataUrl).toBe(LOGO);
    expect(updated.profileCompleted).toBe(true);
    expect(store.getSettings().logoDataUrl).toBe(LOGO);
  });

  it('rejects a logo that is not an image data URL', () => {
    expect(() =>
      store.updateSettings({
        ...store.getSettings(),
        logoDataUrl: 'https://example.com/logo.png',
      }),
    ).toThrow();
  });

  it('includes the new fields in the settings sync payload', () => {
    store.updateSettings({
      ...store.getSettings(),
      logoDataUrl: LOGO,
      profileCompleted: true,
    });
    const event = store
      .exportOutboxSnapshot()
      .find((item) => item.entityType === 'settings');
    expect(event).toBeDefined();
    const payload = event!.payload as SettingsPayload;
    expect(payload.logoDataUrl).toBe(LOGO);
    expect(payload.profileCompleted).toBe(true);
  });

  it('treats a legacy payload without the fields as profile-complete', () => {
    store.replayValidatedEvents([
      settingsEvent({ storeName: 'Old Synced Store' }, [
        'logoDataUrl',
        'profileCompleted',
      ]),
    ]);
    const settings = store.getSettings();
    expect(settings.storeName).toBe('Old Synced Store');
    expect(settings.profileCompleted).toBe(true);
    expect(settings.logoDataUrl).toBeNull();
  });

  it('applies explicit values from a newer payload', () => {
    store.replayValidatedEvents([
      settingsEvent({ logoDataUrl: LOGO, profileCompleted: false }),
    ]);
    const settings = store.getSettings();
    expect(settings.logoDataUrl).toBe(LOGO);
    expect(settings.profileCompleted).toBe(false);
  });

  it('clears a synced logo when the payload says so', () => {
    store.updateSettings({ ...store.getSettings(), logoDataUrl: LOGO });
    store.replayValidatedEvents([
      settingsEvent({ logoDataUrl: null, profileCompleted: true }),
    ]);
    expect(store.getSettings().logoDataUrl).toBeNull();
  });
});

describe('outbound email attachments', () => {
  it('stores attachments with the queued email', () => {
    const email = store.purchaseOrders.enqueueEmail({
      purchaseOrderId: null,
      to: 'vendor@example.com',
      subject: 'PO',
      textBody: 'text',
      htmlBody: '<p>html</p>',
      attachments: [
        {
          filename: 'store-logo.png',
          contentType: 'image/png',
          contentBase64: 'aGVsbG8=',
          cid: 'store-logo@suma',
        },
      ],
    });
    expect(email.attachments).toEqual([
      {
        filename: 'store-logo.png',
        contentType: 'image/png',
        contentBase64: 'aGVsbG8=',
        cid: 'store-logo@suma',
      },
    ]);
    expect(store.purchaseOrders.getEmail(email.id).attachments[0]!.cid).toBe(
      'store-logo@suma',
    );
  });

  it('defaults to no attachments', () => {
    const email = store.purchaseOrders.enqueueEmail({
      purchaseOrderId: null,
      to: 'vendor@example.com',
      subject: 'PO',
      textBody: 'text',
      htmlBody: '<p>html</p>',
    });
    expect(email.attachments).toEqual([]);
  });
});
