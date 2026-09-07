import nodemailer from 'nodemailer';
import type { StoreDatabase } from '@shul-store/database';
import type { EmailConfig, OutboundEmail } from '@shul-store/shared';
import type { CloudAccountManager } from './cloud-account.js';

const MAX_ATTEMPTS = 8;
const QUEUE_INTERVAL_MS = 60_000;
const SEND_TIMEOUT_MS = 30_000;

/** SMTP failures that will not fix themselves by retrying later. */
function isPermanentError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const responseCode =
    typeof error === 'object' && error !== null && 'responseCode' in error
      ? Number((error as { responseCode?: unknown }).responseCode)
      : 0;
  return (
    code === 'EAUTH' ||
    code === 'EENVELOPE' ||
    code === 'EMESSAGE' ||
    (responseCode >= 500 && responseCode < 600)
  );
}

export function describeMailError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code =
    'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'EAUTH')
    return 'The mail server rejected the username or password. For Gmail, use an App Password (Google Account → Security → 2-Step Verification → App passwords).';
  if (code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ETIMEDOUT')
    return `Could not reach the mail server (${error.message}). Check the host, port and SSL setting, or your internet connection.`;
  return error.message;
}

function createTransport(config: EmailConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: config.username
      ? { user: config.username, pass: config.password }
      : undefined,
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
}

export async function sendWithConfig(
  config: EmailConfig,
  email: Pick<OutboundEmail, 'to' | 'subject' | 'textBody' | 'htmlBody'>,
): Promise<void> {
  const transport = createTransport(config);
  try {
    await transport.sendMail({
      from: { name: config.fromName, address: config.fromAddress },
      to: email.to,
      ...(config.ccSelf ? { cc: config.fromAddress } : {}),
      replyTo: config.fromAddress,
      subject: email.subject,
      text: email.textBody,
      html: email.htmlBody,
    });
  } finally {
    transport.close();
  }
}

export async function testConfig(
  config: EmailConfig,
  sendTo: string | null,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const transport = createTransport(config);
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
    if (sendTo) {
      await sendWithConfig(config, {
        to: sendTo,
        subject: 'SUMA POS test email',
        textBody:
          'Your purchase-order email account is set up correctly. Orders you send from SUMA POS will come from this address.',
        htmlBody:
          '<p>Your purchase-order email account is set up correctly.</p><p>Orders you send from SUMA POS will come from this address.</p>',
      });
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: describeMailError(error) };
  }
}

/**
 * Drains the outbound email queue in the background. Sending needs the
 * network, so failures are retried on the next cycle; permanent SMTP errors
 * (bad password, rejected recipient) mark the email failed for the UI to
 * surface. Purchase orders are published to the cloud before their email goes
 * out so the vendor-portal link in the message resolves.
 */
export type MailSender = typeof sendWithConfig;

export class MailWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly database: StoreDatabase,
    private readonly cloudAccount: () => Pick<
      CloudAccountManager,
      'isAccountSyncConfigured' | 'publishPurchaseOrder'
    > | null,
    private readonly onChange: () => void,
    private readonly send: MailSender = sendWithConfig,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.kick(), QUEUE_INTERVAL_MS);
    void this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process pending emails now (no-op if a run is already in progress). */
  kick(): Promise<void> {
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    const store = this.database.purchaseOrders;
    const pending = store.pendingEmails();
    if (pending.length === 0) return;
    const config = store.getEmailConfig();
    let changed = false;
    for (const email of pending) {
      if (!config) {
        store.markEmailFailed(
          email.id,
          'No email account configured. Add one under Settings → Email.',
          true,
        );
        changed = true;
        continue;
      }
      try {
        await this.ensurePublished(email.purchaseOrderId);
        await this.send(config, email);
        store.markEmailSent(email.id);
      } catch (error) {
        const permanent = isPermanentError(error);
        store.markEmailFailed(
          email.id,
          describeMailError(error),
          permanent || email.attempts + 1 >= MAX_ATTEMPTS,
        );
      }
      changed = true;
    }
    if (changed) this.onChange();
  }

  private async ensurePublished(purchaseOrderId: string | null): Promise<void> {
    if (!purchaseOrderId) return;
    const order = this.database.purchaseOrders.find(purchaseOrderId);
    if (!order || order.publishedAt) return;
    const cloud = this.cloudAccount();
    if (!cloud?.isAccountSyncConfigured()) return;
    await cloud.publishPurchaseOrder(order);
    this.database.purchaseOrders.markPublished(order.id);
  }
}
