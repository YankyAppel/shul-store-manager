/**
 * Secret store abstraction for the Supabase API key.
 *
 * The main process encrypts the key with Electron `safeStorage` when the
 * platform supports it, and falls back to storing it as plaintext otherwise.
 * `@shul-store/sync` never depends on Electron directly; the main process
 * supplies the concrete implementation and tests use the plaintext fallback.
 */
export interface SyncSecretStore {
  /** Whether OS-level encryption is available on this machine. */
  readonly available: boolean;
  /** Encrypt (or pass through) a plaintext secret for at-rest storage. */
  encrypt(plaintext: string): string;
  /** Decrypt (or pass through) a previously stored secret back to plaintext. */
  decrypt(stored: string): string;
}

/**
 * Fallback secret store used when OS keychain encryption is unavailable and in
 * tests. It stores the key verbatim (base64-wrapped only to mark it as a
 * non-empty opaque blob) and reports `available: false` so the UI can warn the
 * user that the key is not encrypted at rest.
 */
export class PlaintextSyncSecretStore implements SyncSecretStore {
  readonly available = false;

  encrypt(plaintext: string): string {
    return Buffer.from(plaintext, 'utf8').toString('base64');
  }

  decrypt(stored: string): string {
    return Buffer.from(stored, 'base64').toString('utf8');
  }
}

/** Produce a masked hint for the renderer, e.g. "••••WXYZ" — never the key. */
export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}
