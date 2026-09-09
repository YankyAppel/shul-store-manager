import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import type { StoreDatabase } from '@shul-store/database';
import type { EmailConfig, OutboundEmail } from '@shul-store/shared';
import type { CloudAccountManager } from './cloud-account.js';
import { refreshAccessToken, type GoogleOAuthClient } from './google-oauth.js';

const MAX_ATTEMPTS = 8;
const QUEUE_INTERVAL_MS = 60_000;
const SEND_TIMEOUT_MS = 30_000;
const GMAIL_SEND_URL =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
/** Refresh a little early so the token cannot expire mid-request. */
const TOKEN_SKEW_MS = 60_000;

class GmailApiError extends Error {
  constructor(
    message: string,
    readonly code: 'EOAUTH2' | 'EMESSAGE' | 'ECONNECTION',
    readonly responseCode: number,
  ) {
    super(message);
  }
}

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
    code === 'EOAUTH2' ||
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
    return 'The mail server rejected the username or password. For Gmail, use an App Password (Google Account → Security → 2-Step Verification → App passwords) or Sign in with Google.';
  if (code === 'EOAUTH2' || /invalid_grant/i.test(error.message))
    return 'Google no longer accepts the saved sign-in. Open Settings → Order emails and sign in with Google again.';
  if (code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ETIMEDOUT')
    return `Could not reach the mail server (${error.message}). Check the host, port and SSL setting, or your internet connection.`;
  return error.message;
}

export interface MailOptions {
  googleClient?: GoogleOAuthClient;
  fetchImpl?: typeof globalThis.fetch;
}

function composeMessage(
  config: EmailConfig,
  email: Pick<OutboundEmail, 'to' | 'subject' | 'textBody' | 'htmlBody'>,
): Mail.Options {
  return {
    from: { name: config.fromName, address: config.fromAddress },
    to: email.to,
    ...(config.ccSelf ? { cc: config.fromAddress } : {}),
    replyTo: config.fromAddress,
    subject: email.subject,
    text: email.textBody,
    html: email.htmlBody,
  };
}

/** Access tokens refreshed in this process, keyed by refresh token. */
const accessTokens = new Map<
  string,
  { accessToken: string; expiresAt: number }
>();

async function gmailAccessToken(
  config: EmailConfig,
  options: MailOptions,
): Promise<string> {
  const refreshToken = config.oauth?.refreshToken;
  if (!refreshToken || !options.googleClient)
    throw new GmailApiError(
      'Google sign-in is not configured.',
      'EOAUTH2',
      401,
    );
  const cached = accessTokens.get(refreshToken) ?? config.oauth;
  if (
    cached?.accessToken &&
    cached.expiresAt &&
    cached.expiresAt - TOKEN_SKEW_MS > Date.now()
  )
    return cached.accessToken;
  try {
    const fresh = await refreshAccessToken(
      options.googleClient,
      refreshToken,
      options.fetchImpl,
    );
    accessTokens.set(refreshToken, fresh);
    return fresh.accessToken;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GmailApiError(
      message,
      /invalid_grant|invalid_client|unauthorized|revoked|expired/i.test(message)
        ? 'EOAUTH2'
        : 'ECONNECTION',
      401,
    );
  }
}

/**
 * Send through the Gmail REST API (`gmail.send` scope) rather than SMTP:
 * SMTP XOAUTH2 requires the full mail scope, which is far broader than the
 * app needs.
 */
async function sendViaGmailApi(
  config: EmailConfig,
  email: Pick<OutboundEmail, 'to' | 'subject' | 'textBody' | 'htmlBody'>,
  options: MailOptions,
): Promise<void> {
  const accessToken = await gmailAccessToken(config, options);
  const raw = await new MailComposer(composeMessage(config, email))
    .compile()
    .build();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ raw: raw.toString('base64url') }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GmailApiError(
      error instanceof Error ? error.message : String(error),
      'ECONNECTION',
      0,
    );
  }
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  const message =
    body.error?.message ?? `Gmail rejected the message (${response.status})`;
  if (response.status === 401 || response.status === 403) {
    accessTokens.delete(config.oauth?.refreshToken ?? '');
    throw new GmailApiError(message, 'EOAUTH2', response.status);
  }
  if (response.status >= 500)
    throw new GmailApiError(message, 'ECONNECTION', 0);
  throw new GmailApiError(message, 'EMESSAGE', response.status);
}

function createTransport(config: EmailConfig) {
  const auth = config.username
    ? { user: config.username, pass: config.password }
    : undefined;
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth,
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
}

export async function sendWithConfig(
  config: EmailConfig,
  email: Pick<OutboundEmail, 'to' | 'subject' | 'textBody' | 'htmlBody'>,
  options: MailOptions = {},
): Promise<void> {
  if (config.authType === 'gmail') {
    await sendViaGmailApi(config, email, options);
    return;
  }
  const transport = createTransport(config);
  try {
    await transport.sendMail(composeMessage(config, email));
  } finally {
    transport.close();
  }
}

export async function testConfig(
  config: EmailConfig,
  sendTo: string | null,
  options: MailOptions = {},
): Promise<{ ok: boolean; error: string | null }> {
  try {
    if (config.authType === 'gmail') {
      await gmailAccessToken(config, options);
    } else {
      const transport = createTransport(config);
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
    }
    if (sendTo) {
      await sendWithConfig(
        config,
        {
          to: sendTo,
          subject: 'SUMA POS test email',
          textBody:
            'Your purchase-order email account is set up correctly. Orders you send from SUMA POS will come from this address.',
          htmlBody:
            '<p>Your purchase-order email account is set up correctly.</p><p>Orders you send from SUMA POS will come from this address.</p>',
        },
        options,
      );
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
    private readonly options: MailOptions = {},
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
        await this.send(config, email, this.options);
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
