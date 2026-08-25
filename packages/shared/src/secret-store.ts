/** Shared abstraction for secrets encrypted by the host application. */
export interface SecretStore {
  /** Whether OS-level encryption is available on this machine. */
  readonly available: boolean;
  /** Encrypt a plaintext secret for at-rest storage. */
  encrypt(plaintext: string): string;
  /** Decrypt a previously stored secret back to plaintext. */
  decrypt(stored: string): string;
}

/** Fallback used when OS keychain encryption is unavailable and in tests. */
export class PlaintextSecretStore implements SecretStore {
  readonly available = false;

  encrypt(plaintext: string): string {
    const bytes = new TextEncoder().encode(plaintext);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  decrypt(stored: string): string {
    const binary = atob(stored);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  }
}
