import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createKeyEncryption,
  KeyDecryptionError,
  signingKeyAad,
} from '../src/crypto/key-encryption';

const secret = 'z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq';

describe('master key encryption', () => {
  const keys = createKeyEncryption(randomBytes(32));

  it('round-trips with the same associated data', () => {
    const stored = keys.encrypt(secret, signingKeyAad('key-1'));
    expect(stored).not.toContain(secret);
    expect(keys.decrypt(stored, signingKeyAad('key-1'), 1)).toBe(secret);
  });

  it('uses a fresh IV every time', () => {
    expect(keys.encrypt(secret, 'aad')).not.toBe(keys.encrypt(secret, 'aad'));
  });

  it('refuses a value moved to another row', () => {
    const stored = keys.encrypt(secret, signingKeyAad('key-1'));
    expect(() => keys.decrypt(stored, signingKeyAad('key-2'), 1)).toThrow(KeyDecryptionError);
  });

  it('refuses a wrong master key', () => {
    const stored = keys.encrypt(secret, 'aad');
    expect(() => createKeyEncryption(randomBytes(32)).decrypt(stored, 'aad', 1)).toThrow(
      KeyDecryptionError,
    );
  });

  it('refuses tampered ciphertext', () => {
    const [iv, ciphertext, tag] = keys.encrypt(secret, 'aad').split('.');
    const flipped = Buffer.from(ciphertext ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => keys.decrypt(`${iv}.${flipped.toString('base64url')}.${tag}`, 'aad', 1)).toThrow(
      KeyDecryptionError,
    );
    expect(() => keys.decrypt('garbage', 'aad', 1)).toThrow(KeyDecryptionError);
  });

  it('refuses a value from another master key version', () => {
    const stored = keys.encrypt(secret, 'aad');
    expect(() => keys.decrypt(stored, 'aad', 2)).toThrow(/version 2/);
  });

  it('needs a 32-byte key', () => {
    expect(() => createKeyEncryption(randomBytes(16))).toThrow(TypeError);
  });
});
