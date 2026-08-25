import { PlaintextSecretStore, type SecretStore } from '@shul-store/shared';

export type SyncSecretStore = SecretStore;
export { PlaintextSecretStore as PlaintextSyncSecretStore };

/** Produce a masked hint for the renderer, e.g. "••••WXYZ" — never the key. */
export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}
