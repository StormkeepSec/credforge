import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { asArray, isRecord } from './document-loader';
import type { IdentityObject } from './types';

export type IdentityHashAlgorithm = 'sha256' | 'md5';

/**
 * Normalizes an email address before hashing: trims it, applies Unicode NFC and lowercases the
 * whole address. Lowercasing the local part is not strictly correct per RFC 5321, but every real
 * mail provider treats it case-insensitively and it matches what recipients type.
 */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

/** A random salt: 16 bytes, base64url-encoded (22 characters). */
export function generateSalt(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Computes an OB 3.0 `IdentityHash`: `<algorithm>$<hex digest>` over the UTF-8 bytes of the value
 * followed by the salt (spec B.8). The spec's example: `a@example.com` salted with `Kosher` gives
 * `sha256$b5809d8a…`.
 */
export function hashIdentity(
  value: string,
  salt = '',
  algorithm: IdentityHashAlgorithm = 'sha256',
): string {
  const digest = createHash(algorithm).update(`${value}${salt}`, 'utf8').digest('hex');
  return `${algorithm}$${digest}`;
}

/** A hashed `emailAddress` identifier. The address is normalized first (see `normalizeEmail`). */
export function emailIdentifier(email: string, salt = generateSalt()): IdentityObject {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) {
    throw new TypeError('The recipient email address is not valid.');
  }
  return {
    type: 'IdentityObject',
    identityType: 'emailAddress',
    hashed: true,
    identityHash: hashIdentity(normalized, salt),
    salt,
  };
}

/** A plain-text `name` identifier, so verifiers and wallets can show who the badge is for. */
export function nameIdentifier(name: string): IdentityObject {
  const trimmed = name.trim();
  if (!trimmed) throw new TypeError('The recipient name must not be empty.');
  return { type: 'IdentityObject', identityType: 'name', hashed: false, identityHash: trimmed };
}

export interface KnownIdentifier {
  /** An `IdentifierTypeEnum` value such as `emailAddress`, or an `ext:` extension type. */
  identityType: string;
  /** The plain-text value the verifier already knows. */
  value: string;
}

/**
 * Checks whether a credential was issued to the known identifier, following OB 3.0 §9.3: compare
 * it with every `credentialSubject.identifier` of the same type, hashing it with that
 * identifier's salt when the identifier is hashed. Email addresses are also tried in normalized
 * form. Accepts a credential, a credential subject or a list of identity objects.
 */
export function verifyRecipient(source: unknown, known: KnownIdentifier): boolean {
  const candidates = [known.value];
  if (known.identityType === 'emailAddress') candidates.push(normalizeEmail(known.value));

  for (const identifier of identifiersOf(source)) {
    if (identifier.identityType !== known.identityType) continue;
    if (typeof identifier.identityHash !== 'string') continue;

    if (identifier.hashed === true) {
      const separator = identifier.identityHash.indexOf('$');
      if (separator === -1) continue;
      const algorithm = identifier.identityHash.slice(0, separator).toLowerCase();
      if (algorithm !== 'sha256' && algorithm !== 'md5') continue;
      const expected = `${algorithm}${identifier.identityHash.slice(separator).toLowerCase()}`;
      const salt = typeof identifier.salt === 'string' ? identifier.salt : '';
      if (candidates.some((value) => safeEqual(hashIdentity(value, salt, algorithm), expected))) {
        return true;
      }
    } else if (candidates.includes(identifier.identityHash)) {
      return true;
    }
  }
  return false;
}

function identifiersOf(source: unknown): Array<Record<string, unknown>> {
  let identifiers: unknown = source;
  if (isRecord(source)) {
    const subject = asArray(source.credentialSubject)[0] ?? source;
    identifiers = isRecord(subject) ? subject.identifier : undefined;
  }
  return asArray(identifiers).filter(isRecord);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
