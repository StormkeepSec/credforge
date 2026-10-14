/// <reference path="../src/digitalbazaar.d.ts" />
import { cryptosuite } from '@digitalbazaar/eddsa-rdfc-2022-cryptosuite';
import { describe, expect, it } from 'vitest';
import {
  assertEd25519PublicKey,
  buildIssuerProfile,
  createDocumentLoader,
  findVerificationMethod,
  generateEd25519KeyPair,
  isEd25519PublicKeyMultibase,
  MULTIKEY_CONTEXT_V1,
  validateProfileSchema,
} from '../src/index';
import { ISSUER_ID, issuer, testKeyPair } from './support/fixtures';
import { canonicalNQuads } from './support/independent-verifier';

describe('buildIssuerProfile', () => {
  it('is an OB Profile and a controller document', async () => {
    const keyPair = await testKeyPair();
    const profile = buildIssuerProfile({ ...issuer, keys: [keyPair] });
    const methodId = `${ISSUER_ID}#${keyPair.publicKeyMultibase}`;

    expect(profile['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2',
      'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
      'https://www.w3.org/ns/cid/v1',
    ]);
    expect(profile.type).toEqual(['Profile']);
    expect(profile.verificationMethod).toEqual([
      {
        id: methodId,
        type: 'Multikey',
        controller: ISSUER_ID,
        publicKeyMultibase: keyPair.publicKeyMultibase,
      },
    ]);
    expect(profile.assertionMethod).toEqual([methodId]);
  });

  it('passes the official Profile JSON Schema', async () => {
    const profile = buildIssuerProfile({ ...issuer, keys: [await testKeyPair()] });
    expect(validateProfileSchema(profile)).toEqual({ valid: true, errors: [] });
  });

  it('is fully defined JSON-LD: safe-mode canonicalization works on both toolchains', async () => {
    const profile = buildIssuerProfile({ ...issuer, keys: [await testKeyPair()] });
    const canonical = await cryptosuite.canonize(profile, {
      documentLoader: createDocumentLoader(),
    });
    expect(canonical).toContain(
      `<${ISSUER_ID}> <https://w3id.org/security#assertionMethod> <${ISSUER_ID}#`,
    );
    expect(canonical).toContain('<https://w3id.org/security#Multikey>');
    expect(canonical).toBe(await canonicalNQuads(profile));
  });

  it('lists retired keys for assertions and revoked keys without them', async () => {
    const active = await testKeyPair('active');
    const retired = await testKeyPair('retired');
    const revoked = await testKeyPair('revoked');
    const profile = buildIssuerProfile({
      ...issuer,
      keys: [active, retired, { ...revoked, revoked: new Date('2027-01-05T10:00:00.250Z') }],
    });
    expect(profile.verificationMethod.map((method) => method.publicKeyMultibase)).toEqual([
      active.publicKeyMultibase,
      retired.publicKeyMultibase,
      revoked.publicKeyMultibase,
    ]);
    expect(profile.verificationMethod[2]?.revoked).toBe('2027-01-05T10:00:00Z');
    expect(profile.assertionMethod).toEqual([
      `${ISSUER_ID}#${active.publicKeyMultibase}`,
      `${ISSUER_ID}#${retired.publicKeyMultibase}`,
    ]);
  });

  it('works with a did:web issuer id (the fallback if HTTP URLs ever fail)', async () => {
    const keyPair = await testKeyPair();
    const id = 'did:web:credforge.app:issuers:7f3e9a52-0c4b-4d8e-9a61-2b5d8c1e0f37';
    const profile = buildIssuerProfile({ ...issuer, id, keys: [keyPair] });
    expect(profile.assertionMethod).toEqual([`${id}#${keyPair.publicKeyMultibase}`]);
  });

  it('rejects bad keys', async () => {
    const keyPair = await testKeyPair();
    expect(() => buildIssuerProfile({ ...issuer, keys: [] })).toThrow(/at least one key/);
    expect(() => buildIssuerProfile({ ...issuer, keys: [keyPair, keyPair] })).toThrow(/twice/);
    expect(() =>
      buildIssuerProfile({ ...issuer, keys: [{ publicKeyMultibase: 'zDnaeTooShort' }] }),
    ).toThrow(/not an Ed25519 Multikey/);
  });
});

describe('keys', () => {
  it('generates z6Mk Ed25519 Multikeys', async () => {
    const keyPair = await generateEd25519KeyPair();
    expect(isEd25519PublicKeyMultibase(keyPair.publicKeyMultibase)).toBe(true);
    expect(keyPair.secretKeyMultibase).toMatch(/^z3u2/); // ed25519-priv multicodec + 32 bytes
    await expect(assertEd25519PublicKey(keyPair.publicKeyMultibase)).resolves.toBeUndefined();
  });

  it('derives the same key from the same seed', async () => {
    expect(await testKeyPair('x')).toEqual(await testKeyPair('x'));
    expect(await testKeyPair('x')).not.toEqual(await testKeyPair('y'));
  });

  it('rejects other key types', async () => {
    // A P-256 Multikey (zDna…) from the W3C test vectors.
    const p256 = 'zDnaegE6RR3atJtHKwTRTWHsJ3kNHqFwv7n9YjTgmU7TyfU76';
    expect(isEd25519PublicKeyMultibase(p256)).toBe(false);
    await expect(assertEd25519PublicKey(p256)).rejects.toThrow(/z6Mk/);
  });
});

describe('findVerificationMethod', () => {
  it('returns the key as a standalone Multikey document', async () => {
    const keyPair = await testKeyPair();
    const profile = buildIssuerProfile({ ...issuer, keys: [keyPair] });
    const id = `${ISSUER_ID}#${keyPair.publicKeyMultibase}`;
    expect(findVerificationMethod(profile, id)).toEqual({
      '@context': MULTIKEY_CONTEXT_V1,
      id,
      type: 'Multikey',
      controller: ISSUER_ID,
      publicKeyMultibase: keyPair.publicKeyMultibase,
    });
    expect(findVerificationMethod(profile, `${ISSUER_ID}#nope`)).toBeUndefined();
  });

  it('resolves relative ids', () => {
    const profile = {
      '@context': ['https://www.w3.org/ns/cid/v1'],
      id: 'https://example.org/issuer',
      verificationMethod: { id: '#key-1', type: 'Multikey', publicKeyMultibase: 'z6Mk' },
    };
    expect(findVerificationMethod(profile, 'https://example.org/issuer#key-1')?.id).toBe(
      'https://example.org/issuer#key-1',
    );
  });
});
