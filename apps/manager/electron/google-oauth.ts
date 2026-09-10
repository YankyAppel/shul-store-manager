import {
  authorizeGoogle,
  GMAIL_SEND_SCOPE,
  type GoogleGrant,
  type GoogleOAuthClient,
} from '@shul-store/google-auth';
import type { GmailOAuth } from '@shul-store/shared';

export {
  GMAIL_SEND_SCOPE,
  refreshAccessToken,
  type GoogleOAuthClient,
} from '@shul-store/google-auth';

export const GMAIL_SCOPE_MISSING_MESSAGE =
  'Sending email was not allowed. Tick every permission on the Google consent screen and try again.';

export interface GmailGrant {
  email: string;
  oauth: GmailOAuth;
}

type FetchImpl = typeof globalThis.fetch;

/** Turn a Google grant that includes gmail.send into stored Gmail credentials. */
export function gmailGrantFrom(grant: GoogleGrant): GmailGrant | null {
  if (!grant.refreshToken || !grant.scopes.includes(GMAIL_SEND_SCOPE))
    return null;
  return {
    email: grant.email,
    oauth: {
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      expiresAt: grant.expiresAt,
    },
  };
}

/** Connect a Gmail account for sending purchase-order emails. */
export async function connectGmail(
  client: GoogleOAuthClient,
  openExternal: (url: string) => Promise<void>,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<GmailGrant> {
  const grant = await authorizeGoogle(
    client,
    openExternal,
    {
      scopes: [GMAIL_SEND_SCOPE, 'openid', 'email'],
      offline: true,
      requiredScopes: [GMAIL_SEND_SCOPE],
      missingScopeMessage: GMAIL_SCOPE_MISSING_MESSAGE,
      successTitle: 'Connected to SUMA',
      successBody:
        'Your Gmail account is linked. You can close this tab and return to the app.',
    },
    fetchImpl,
  );
  if (!grant.refreshToken)
    throw new Error(
      'Google did not return a refresh token. Remove SUMA under Google Account → Security → Third-party access and try again.',
    );
  const gmail = gmailGrantFrom(grant);
  if (!gmail) throw new Error(GMAIL_SCOPE_MISSING_MESSAGE);
  return gmail;
}
