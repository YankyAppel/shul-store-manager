import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Narrowest Gmail scope that allows `users.messages.send`. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** Scopes that identify the Google account (ID token + verified email). */
export const IDENTITY_SCOPES = ['openid', 'email', 'profile'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const FLOW_TIMEOUT_MS = 5 * 60_000;

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface GoogleGrant {
  email: string;
  /** OpenID Connect token; present when `openid` was requested. */
  idToken: string | null;
  accessToken: string;
  /** Present when `offline` access was requested and Google issued one. */
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

export interface GoogleAuthorizeOptions {
  scopes: string[];
  /** Request a refresh token (forces the consent screen). */
  offline?: boolean;
  /** Value echoed in the ID token's `nonce` claim (send the hashed nonce). */
  nonce?: string;
  /** Pre-fills the account chooser. */
  loginHint?: string;
  /** Scopes the user must tick; the flow fails with `missingScopeMessage`. */
  requiredScopes?: string[];
  missingScopeMessage?: string;
  successTitle?: string;
  successBody?: string;
}

export interface GoogleNonce {
  /** Give to the party validating the ID token (e.g. Supabase). */
  raw: string;
  /** Send to Google so the ID token carries sha256(raw). */
  hashed: string;
}

type FetchImpl = typeof globalThis.fetch;

function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createNonce(): GoogleNonce {
  const raw = base64url(randomBytes(32));
  return { raw, hashed: createHash('sha256').update(raw).digest('hex') };
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f5;color:#1f2a24;display:grid;place-items:center;height:100vh;margin:0}
main{background:#fff;border:1px solid #e0e5e2;border-radius:12px;padding:32px 40px;max-width:420px;text-align:center}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function exchange(
  fetchImpl: FetchImpl,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const value = (await response.json()) as TokenResponse;
  if (!response.ok || value.error) {
    throw new Error(
      value.error_description ??
        value.error ??
        `Google token request failed (${response.status})`,
    );
  }
  return value;
}

/** Exchange the stored refresh token for a fresh access token. */
export async function refreshAccessToken(
  client: GoogleOAuthClient,
  refreshToken: string,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<{ accessToken: string; expiresAt: number }> {
  const token = await exchange(fetchImpl, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
}

/**
 * Authorization-code flow with PKCE against a loopback redirect, as Google
 * requires for desktop apps: open the consent page in the system browser,
 * catch the redirect on 127.0.0.1, exchange the code for tokens and look up
 * which Google account was granted.
 */
export async function authorizeGoogle(
  client: GoogleOAuthClient,
  openExternal: (url: string) => Promise<void>,
  options: GoogleAuthorizeOptions,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<GoogleGrant> {
  if (!client.clientId) throw new Error('Google sign-in is not configured.');
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Google sign-in timed out. Please try again.'));
    }, FLOW_TIMEOUT_MS);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri);
      if (url.pathname !== '/oauth/callback') {
        response.writeHead(404).end();
        return;
      }
      clearTimeout(timer);
      const error = url.searchParams.get('error');
      const received = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state) {
        response
          .writeHead(400, { 'content-type': 'text/html' })
          .end(page('Sign-in failed', 'The request did not match.'));
        reject(new Error('Google sign-in was tampered with (state mismatch).'));
      } else if (error || !received) {
        response
          .writeHead(400, { 'content-type': 'text/html' })
          .end(page('Sign-in cancelled', 'You can close this tab.'));
        reject(
          new Error(
            error === 'access_denied'
              ? 'Google sign-in was cancelled.'
              : `Google sign-in failed (${error ?? 'no code'}).`,
          ),
        );
      } else {
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            page(
              options.successTitle ?? 'Signed in to SUMA',
              options.successBody ??
                'You can close this tab and return to the app.',
            ),
          );
        resolve(received);
      }
    });
  });

  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: options.scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...(options.offline
      ? { access_type: 'offline', prompt: 'consent' }
      : { prompt: 'select_account' }),
    ...(options.nonce ? { nonce: options.nonce } : {}),
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  }).toString();

  try {
    await openExternal(authUrl.toString());
    const grantedCode = await code;
    const token = await exchange(fetchImpl, {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: grantedCode,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const scopes = token.scope?.split(' ') ?? [];
    if (options.requiredScopes?.some((scope) => !scopes.includes(scope)))
      throw new Error(
        options.missingScopeMessage ??
          'A required permission was not granted. Tick every permission on the Google consent screen and try again.',
      );
    const userinfo = await fetchImpl(USERINFO_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    const profile = (await userinfo.json()) as { email?: string };
    if (!userinfo.ok || !profile.email)
      throw new Error(
        'Could not read the email address of the signed-in Google account.',
      );
    return {
      email: profile.email,
      idToken: token.id_token ?? null,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes,
    };
  } finally {
    server.close();
  }
}
