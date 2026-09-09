import { describe, expect, it } from 'vitest';
import { connectGmail } from '../electron/google-oauth.js';

const client = { clientId: 'client-id', clientSecret: 'client-secret' };

function fakeFetch(
  handlers: Record<string, (init?: RequestInit) => unknown>,
  calls: { url: string; body: URLSearchParams | null }[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    calls.push({ url, body });
    const handler = Object.entries(handlers).find(([prefix]) =>
      url.startsWith(prefix),
    )?.[1];
    if (!handler) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(handler(init)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** Plays the browser: follows the consent URL's redirect_uri back with a code. */
async function completeInBrowser(
  url: string,
  params: Record<string, string> | ((state: string) => Record<string, string>),
): Promise<void> {
  const consent = new URL(url);
  const redirect = new URL(consent.searchParams.get('redirect_uri') ?? '');
  const state = consent.searchParams.get('state') ?? '';
  const query = typeof params === 'function' ? params(state) : params;
  for (const [key, value] of Object.entries(query))
    redirect.searchParams.set(key, value);
  await fetch(redirect);
}

describe('connectGmail', () => {
  it('runs the PKCE loopback flow and returns the granted account', async () => {
    const calls: { url: string; body: URLSearchParams | null }[] = [];
    let consentUrl = '';
    const fetchImpl = fakeFetch(
      {
        'https://oauth2.googleapis.com/token': () => ({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.send openid email',
        }),
        'https://openidconnect.googleapis.com/v1/userinfo': () => ({
          email: 'shop@gmail.com',
        }),
      },
      calls,
    );
    const grant = await connectGmail(
      client,
      async (url) => {
        consentUrl = url;
        void completeInBrowser(url, (state) => ({ code: 'the-code', state }));
      },
      fetchImpl,
    );

    expect(grant.email).toBe('shop@gmail.com');
    expect(grant.oauth.refreshToken).toBe('refresh');
    expect(grant.oauth.accessToken).toBe('access');
    expect(grant.oauth.expiresAt).toBeGreaterThan(Date.now());

    const consent = new URL(consentUrl);
    expect(consent.origin + consent.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consent.searchParams.get('access_type')).toBe('offline');
    expect(consent.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/gmail.send',
    );
    expect(consent.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/,
    );

    const token = calls.find((call) => call.url.includes('/token'))?.body;
    expect(token?.get('code')).toBe('the-code');
    expect(token?.get('grant_type')).toBe('authorization_code');
    expect(token?.get('code_verifier')).toBeTruthy();
    expect(token?.get('redirect_uri')).toBe(
      consent.searchParams.get('redirect_uri'),
    );
  });

  it('rejects a callback whose state does not match', async () => {
    await expect(
      connectGmail(
        client,
        async (url) => {
          void completeInBrowser(url, { code: 'x', state: 'forged' });
        },
        fakeFetch({}, []),
      ),
    ).rejects.toThrow(/state mismatch/);
  });

  it('reports when the user cancels on the consent screen', async () => {
    await expect(
      connectGmail(
        client,
        async (url) => {
          void completeInBrowser(url, (state) => ({
            error: 'access_denied',
            state,
          }));
        },
        fakeFetch({}, []),
      ),
    ).rejects.toThrow(/cancelled/);
  });

  it('fails when the mail scope was not granted', async () => {
    const fetchImpl = fakeFetch(
      {
        'https://oauth2.googleapis.com/token': () => ({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'openid email',
        }),
      },
      [],
    );
    await expect(
      connectGmail(
        client,
        async (url) => {
          void completeInBrowser(url, (state) => ({ code: 'c', state }));
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/Sending email was not allowed/);
  });

  it('refuses to start without a configured client', async () => {
    await expect(
      connectGmail({ clientId: '', clientSecret: '' }, async () => {}),
    ).rejects.toThrow(/not configured/);
  });
});
