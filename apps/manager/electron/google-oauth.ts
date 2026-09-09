import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GmailOAuth } from '@shul-store/shared';

/** Narrowest Gmail scope that allows `users.messages.send`. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SCOPES = [GMAIL_SEND_SCOPE, 'openid', 'email'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const FLOW_TIMEOUT_MS = 5 * 60_000;

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface GmailGrant {
  email: string;
  oauth: GmailOAuth;
}

type FetchImpl = typeof globalThis.fetch;

function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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
export async function connectGmail(
  client: GoogleOAuthClient,
  openExternal: (url: string) => Promise<void>,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<GmailGrant> {
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
              'Connected to SUMA POS',
              'Your Gmail account is linked. You can close this tab and return to the app.',
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
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
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
    if (!token.refresh_token)
      throw new Error(
        'Google did not return a refresh token. Remove SUMA POS under Google Account → Security → Third-party access and try again.',
      );
    if (!token.scope?.split(' ').includes(GMAIL_SEND_SCOPE))
      throw new Error(
        'Sending email was not allowed. Tick every permission on the Google consent screen and try again.',
      );
    const userinfo = await fetchImpl(USERINFO_URL, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    const profile = (await userinfo.json()) as { email?: string };
    if (!userinfo.ok || !profile.email)
      throw new Error(
        'Could not read the Gmail address of the signed-in account.',
      );
    return {
      email: profile.email,
      oauth: {
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      },
    };
  } finally {
    server.close();
  }
}
