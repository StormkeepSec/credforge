import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts issuer private keys under the master key (CREDFORGE_MASTER_KEY), design plan §6.2.
 *
 * AES-256-GCM with a random 96-bit IV per value. Every value is bound to its purpose and row with
 * additional authenticated data, so an encrypted key copied into another row fails to decrypt.
 * Stored as `{iv}.{ciphertext}.{tag}` (base64url); the master key version lives in its own
 * column (`kek_version`) so the key can be rotated by re-encrypting every row.
 */
export interface KeyEncryption {
  /** Version recorded with each value this instance encrypts. */
  readonly version: number;
  encrypt(plaintext: string, aad: string): string;
  decrypt(stored: string, aad: string, version: number): string;
}

export class KeyDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyDecryptionError';
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createKeyEncryption(masterKey: Buffer, version = 1): KeyEncryption {
  if (masterKey.length !== 32) throw new TypeError('The master key must be 32 bytes.');
  const key = Buffer.from(masterKey);

  return {
    version,
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [iv, ciphertext, cipher.getAuthTag()]
        .map((part) => part.toString('base64url'))
        .join('.');
    },
    decrypt(stored, aad, storedVersion) {
      if (storedVersion !== version) {
        throw new KeyDecryptionError(
          `Encrypted under master key version ${storedVersion}, but this instance has version ${version}.`,
        );
      }
      const parts = stored.split('.');
      if (parts.length !== 3) throw new KeyDecryptionError('Malformed encrypted value.');
      const [iv, ciphertext, tag] = parts.map((part) => Buffer.from(part, 'base64url')) as [
        Buffer,
        Buffer,
        Buffer,
      ];
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new KeyDecryptionError('Malformed encrypted value.');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw new KeyDecryptionError(
          'Decryption failed: wrong master key, or the value was changed or moved.',
        );
      }
    },
  };
}

/** Additional authenticated data for an issuer's encrypted private key. */
export function signingKeyAad(signingKeyId: string): string {
  return `credforge:signing-key:${signingKeyId}`;
}
