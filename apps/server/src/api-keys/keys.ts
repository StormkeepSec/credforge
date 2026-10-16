import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys look like `cf_3k9xq2mt7d1v_…`: `cf_`, a 12-character prefix that finds the key's row
 * (and is shown in the issuer app and the audit log), `_`, and 32 random bytes in base64url. Only
 * the SHA-256 of the whole key is stored: the secret part is 256 random bits, so a fast hash is
 * enough (no password hashing needed).
 */
const KEY_PATTERN = /^cf_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface NewApiKey {
  /** The whole key, shown once. */
  key: string;
  /** `cf_{12 characters}`. */
  prefix: string;
  hash: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): NewApiKey {
  const bytes = randomBytes(12);
  let id = '';
  // 256 isn't a multiple of 36, so take each byte modulo 36 only below 252 (no bias).
  for (let i = 0; id.length < 12; i++) {
    const byte = i < bytes.length ? (bytes[i] as number) : randomBytes(1)[0];
    if (byte === undefined || byte >= 252) continue;
    id += PREFIX_ALPHABET[byte % 36];
  }
  const key = `cf_${id}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: `cf_${id}`, hash: hashApiKey(key) };
}

/** The prefix of a well-formed key, or null. Nothing is looked up for malformed keys. */
export function apiKeyPrefix(key: string): string | null {
  const match = KEY_PATTERN.exec(key);
  return match ? `cf_${match[1]}` : null;
}

/** Compares a presented key with a stored hash in constant time. */
export function apiKeyMatches(key: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKey(key), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/**
 * The key in `Authorization: Bearer cf_…`, or null when the request carries no bearer token.
 * A bearer header that isn't an API key is returned as is (and then refused).
 */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? (match[1] ?? null) : null;
}
