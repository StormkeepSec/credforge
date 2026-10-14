/// <reference path="../src/digitalbazaar.d.ts" />
import { cryptosuite } from '@digitalbazaar/eddsa-rdfc-2022-cryptosuite';
import { describe, expect, it } from 'vitest';
import {
  buildCredential,
  buildIssuerProfile,
  CREDENTIAL_CONTEXT,
  createDocumentLoader,
  createEd25519Signer,
  generateEd25519KeyPair,
  signCredential,
  verifyProof,
} from '../src/index';
import {
  credentialInput,
  ISSUED_AT,
  issuer,
  readFixture,
  readJsonFixture,
  testIssuer,
} from './support/fixtures';
import { canonicalNQuads, independentVerify } from './support/independent-verifier';

const CITIZENSHIP_CONTEXT = 'https://w3id.org/citizenship/v4rc1';

describe('W3C vc-di-eddsa test vector (eddsa-rdfc-2022, employment authorization)', () => {
  const keyPair = readJsonFixture<Record<string, string>>('w3c-vc-di-eddsa/keyPair.json');
  const unsigned = readJsonFixture('w3c-vc-di-eddsa/employmentAuth.json');
  const expected = readJsonFixture<{ proof: Record<string, string> }>(
    'w3c-vc-di-eddsa/signedDataInt.json',
  );
  const citizenship = readJsonFixture('w3c-vc-di-eddsa/citizenship-v4rc1.json');
  const contexts: Array<[string, unknown]> = [[CITIZENSHIP_CONTEXT, citizenship]];
  const controller = `did:key:${keyPair.publicKeyMultibase}`;

  it('reproduces the published proofValue through the Signer interface', async () => {
    const signer = await createEd25519Signer({
      controller,
      publicKeyMultibase: keyPair.publicKeyMultibase as string,
      secretKeyMultibase: keyPair.privateKeyMultibase as string,
    });
    const signed = await signCredential(unsigned, signer, {
      created: expected.proof.created,
      documentLoader: createDocumentLoader({ contexts }),
    });
    expect(signed.proof).toEqual(expected.proof);
  });

  it('canonicalizes the document exactly as published, on both toolchains', async () => {
    const published = readFixture('w3c-vc-di-eddsa/canonDocDataInt.txt');
    const documentLoader = createDocumentLoader({ contexts });
    expect(await cryptosuite.canonize(unsigned, { documentLoader })).toBe(published);
    expect(await canonicalNQuads(unsigned, { [CITIZENSHIP_CONTEXT]: citizenship })).toBe(published);
  });

  it('canonicalizes the proof configuration exactly as published, on both toolchains', async () => {
    const published = readFixture('w3c-vc-di-eddsa/proofCanonDataInt.txt');
    const { proofValue: _proofValue, ...proof } = expected.proof;
    const config = { '@context': unsigned['@context'], ...proof };
    const documentLoader = createDocumentLoader({ contexts });
    expect(await cryptosuite.canonize(config, { documentLoader })).toBe(published);
    expect(await canonicalNQuads(config, { [CITIZENSHIP_CONTEXT]: citizenship })).toBe(published);
  });

  it('verifies with the independent verifier', async () => {
    const result = await independentVerify(expected, {
      contexts: { [CITIZENSHIP_CONTEXT]: citizenship },
      skipIssuerCheck: true, // the vector's issuer is a different did:key than its signing key
    });
    expect(result).toEqual({ verified: true });
  });
});

describe('signCredential / verifyProof', () => {
  it('signs a credential that both verifiers accept', async () => {
    const { signer, profile } = await testIssuer();
    const signed = await signCredential(buildCredential(credentialInput()), signer, {
      created: ISSUED_AT,
    });

    expect(signed.proof).toMatchObject({
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      created: ISSUED_AT,
      verificationMethod: signer.verificationMethod,
      proofPurpose: 'assertionMethod',
    });
    expect(signed.proof.verificationMethod).toMatch(/^https:\/\/credforge\.app\/issuers\/.+#z6Mk/);
    expect(signed.proof.proofValue).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);

    expect(await verifyProof(signed, { controller: profile })).toEqual({
      verified: true,
      errors: [],
    });
    expect(await independentVerify(signed, { profile })).toEqual({ verified: true });
  });

  it('is deterministic (golden signed credential)', async () => {
    const { signer, profile } = await testIssuer();
    const signed = await signCredential(buildCredential(credentialInput()), signer, {
      created: ISSUED_AT,
    });
    await expect(`${JSON.stringify(signed, null, 2)}\n`).toMatchFileSnapshot(
      './fixtures/golden/credential.signed.json',
    );
    await expect(`${JSON.stringify(profile, null, 2)}\n`).toMatchFileSnapshot(
      './fixtures/golden/issuer-profile.json',
    );
  });

  it('produces the same canonical N-Quads as the independent toolchain', async () => {
    const credential = buildCredential(credentialInput());
    const documentLoader = createDocumentLoader();
    const canonical = await cryptosuite.canonize(credential, { documentLoader });
    expect(canonical).toBe(await canonicalNQuads(credential));
    await expect(canonical).toMatchFileSnapshot('./fixtures/golden/credential.canonical.nq');
  });

  it('keeps the golden credential verifiable', async () => {
    const signed = readJsonFixture('golden/credential.signed.json');
    const profile = readJsonFixture('golden/issuer-profile.json');
    expect((await verifyProof(signed, { controller: profile })).verified).toBe(true);
    expect(await independentVerify(signed, { profile })).toEqual({ verified: true });
  });

  it('rejects a tampered credential', async () => {
    const { signer, profile } = await testIssuer();
    const signed = await signCredential(buildCredential(credentialInput()), signer);
    const tampered = structuredClone(signed);
    tampered.credentialSubject.achievement.name = 'Advanced Network Defense';

    const result = await verifyProof(tampered, { controller: profile });
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toMatch(/signature/i);
    expect((await independentVerify(tampered, { profile })).verified).toBe(false);
  });

  it('rejects a key the issuer does not publish', async () => {
    const { signer } = await testIssuer();
    const signed = await signCredential(buildCredential(credentialInput()), signer);
    const other = await generateEd25519KeyPair();
    const profile = buildIssuerProfile({ ...issuer, keys: [other] });

    const result = await verifyProof(signed, { controller: profile });
    expect(result.verified).toBe(false);
    expect((await independentVerify(signed, { profile })).verified).toBe(false);
  });

  it('rejects a revoked key (listed, but not in assertionMethod)', async () => {
    const { keyPair, signer } = await testIssuer();
    const signed = await signCredential(buildCredential(credentialInput()), signer);
    const profile = buildIssuerProfile({
      ...issuer,
      keys: [{ ...keyPair, revoked: '2026-12-01T00:00:00Z' }],
    });

    const result = await verifyProof(signed, { controller: profile });
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toMatch(/not authorized/);
    expect((await independentVerify(signed, { profile })).verified).toBe(false);
  });

  it('rejects a credential whose issuer is not the key controller', async () => {
    const { signer, profile } = await testIssuer();
    const credential = buildCredential(
      credentialInput({ issuer: { ...issuer, id: 'https://credforge.app/issuers/someone-else' } }),
    );
    const signed = await signCredential(credential, signer);

    const result = await verifyProof(signed, { controller: profile });
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toMatch(/issuer must match/);
    expect((await independentVerify(signed, { profile })).verified).toBe(false);
  });

  it('refuses to sign a document with an undefined JSON-LD term (safe mode)', async () => {
    const { signer } = await testIssuer();
    const credential = { ...buildCredential(credentialInput()), favouriteColour: 'teal' };
    await expect(signCredential(credential, signer)).rejects.toThrow(/safe mode/i);
  });

  it('refuses to sign without the extensions context, which defines the schema type', async () => {
    const { signer } = await testIssuer();
    const credential = {
      ...buildCredential(credentialInput()),
      '@context': CREDENTIAL_CONTEXT.slice(0, 2),
    };
    await expect(signCredential(credential, signer)).rejects.toThrow(/safe mode/i);
  });

  it('refuses to sign twice', async () => {
    const { signer } = await testIssuer();
    const signed = await signCredential(buildCredential(credentialInput()), signer);
    await expect(signCredential(signed, signer)).rejects.toThrow(/already has a proof/);
  });

  it('rejects a secret key that does not belong to the public key', async () => {
    const one = await generateEd25519KeyPair();
    const two = await generateEd25519KeyPair();
    await expect(
      createEd25519Signer({
        controller: issuer.id,
        publicKeyMultibase: one.publicKeyMultibase,
        secretKeyMultibase: two.secretKeyMultibase,
      }),
    ).rejects.toThrow(/does not match/);
  });
});
