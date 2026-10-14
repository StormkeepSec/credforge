import { describe, expect, it } from 'vitest';
import {
  buildCredential,
  emailIdentifier,
  generateSalt,
  hashIdentity,
  nameIdentifier,
  normalizeEmail,
  verifyRecipient,
} from '../src/index';
import { credentialInput, SALT } from './support/fixtures';

describe('hashIdentity', () => {
  it('matches the OB 3.0 spec example (a@example.com salted with "Kosher")', () => {
    expect(hashIdentity('a@example.com', 'Kosher')).toBe(
      'sha256$b5809d8a92f8858436d7e6b87c12ebc0ae1eac4baecc2c0b913aee2c922ef399',
    );
  });

  it('hashes the UTF-8 bytes of value + salt', () => {
    // printf 'jos\xc3\xa9@example.com\xc3\xbc' | sha256sum
    expect(hashIdentity('josé@example.com', 'ü')).toBe(
      'sha256$6ac19880e51079aa1d59ef573be20f24208f6ede6299888a3078df06ad827b8f',
    );
  });

  it('supports md5 for verifying older credentials', () => {
    // printf 'a@example.comKosher' | md5sum
    expect(hashIdentity('a@example.com', 'Kosher', 'md5')).toBe(
      'md5$ddd142639a792e74751ee7e129237efa',
    );
  });
});

describe('emailIdentifier', () => {
  it('normalizes the address and hashes it with the salt', () => {
    expect(emailIdentifier('  Jordan.Rivera@Example.COM ', SALT)).toEqual({
      type: 'IdentityObject',
      identityType: 'emailAddress',
      hashed: true,
      identityHash: hashIdentity('jordan.rivera@example.com', SALT),
      salt: SALT,
    });
  });

  it('generates a fresh 128-bit salt per identifier', () => {
    const a = emailIdentifier('a@example.com');
    const b = emailIdentifier('a@example.com');
    expect(a.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.salt).not.toBe(b.salt);
    expect(a.identityHash).not.toBe(b.identityHash);
    expect(generateSalt()).toHaveLength(22);
  });

  it('rejects an invalid address', () => {
    expect(() => emailIdentifier('not an email')).toThrow(/not valid/);
  });

  it('normalizes Unicode to NFC', () => {
    expect(normalizeEmail('JOSÉ@example.com')).toBe('josé@example.com');
  });
});

describe('nameIdentifier', () => {
  it('is an unhashed name identifier', () => {
    expect(nameIdentifier(' Jordan Rivera ')).toEqual({
      type: 'IdentityObject',
      identityType: 'name',
      hashed: false,
      identityHash: 'Jordan Rivera',
    });
  });
});

describe('verifyRecipient (OB 3.0 §9.3)', () => {
  const credential = buildCredential(credentialInput());

  it('matches the recipient email in any letter case', () => {
    for (const value of ['jordan.rivera@example.com', 'JORDAN.RIVERA@example.com ']) {
      expect(verifyRecipient(credential, { identityType: 'emailAddress', value })).toBe(true);
    }
  });

  it('rejects a different email address', () => {
    expect(
      verifyRecipient(credential, { identityType: 'emailAddress', value: 'jordan@example.com' }),
    ).toBe(false);
  });

  it('matches the plain-text name', () => {
    expect(verifyRecipient(credential, { identityType: 'name', value: 'Jordan Rivera' })).toBe(
      true,
    );
    expect(verifyRecipient(credential, { identityType: 'name', value: 'J. Rivera' })).toBe(false);
  });

  it('only compares identifiers of the same type', () => {
    expect(
      verifyRecipient(credential, { identityType: 'name', value: 'jordan.rivera@example.com' }),
    ).toBe(false);
  });

  it('accepts a subject or identifier list, and other issuers’ md5 or uppercase hashes', () => {
    const identifiers = [
      {
        type: 'IdentityObject',
        identityType: 'emailAddress',
        hashed: true,
        identityHash: hashIdentity('a@example.com', 'Kosher', 'md5').toUpperCase(),
        salt: 'Kosher',
      },
    ];
    const known = { identityType: 'emailAddress', value: 'a@example.com' };
    expect(verifyRecipient(identifiers, known)).toBe(true);
    expect(verifyRecipient({ identifier: identifiers }, known)).toBe(true);
  });

  it('treats a missing salt as unsalted', () => {
    const identifiers = [
      {
        type: 'IdentityObject',
        identityType: 'emailAddress',
        hashed: true,
        identityHash: hashIdentity('a@example.com'),
      },
    ];
    expect(
      verifyRecipient(identifiers, { identityType: 'emailAddress', value: 'a@example.com' }),
    ).toBe(true);
  });

  it('ignores unknown hash algorithms and malformed input', () => {
    const identifiers = [
      { identityType: 'emailAddress', hashed: true, identityHash: 'sha1$abc', salt: '' },
      { identityType: 'emailAddress', hashed: true, identityHash: 'no-separator' },
    ];
    const known = { identityType: 'emailAddress', value: 'a@example.com' };
    expect(verifyRecipient(identifiers, known)).toBe(false);
    expect(verifyRecipient(null, known)).toBe(false);
    expect(verifyRecipient('text', known)).toBe(false);
  });
});
