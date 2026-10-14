import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  Bitstring,
  bakePng,
  buildIssuerProfile,
  buildStatusListEntry,
  extractFromPng,
  generateEd25519KeyPair,
  type IssuerProfileDocument,
  issueCredential,
  issueStatusListCredential,
  SelfCheckError,
  type SignedBitstringStatusListCredential,
  validateCredentialSchema,
  verifyCredential,
  verifyRecipient,
} from '../src/index';
import {
  ACHIEVEMENT_ID,
  BASE_URL,
  credentialInput,
  ISSUED_AT,
  ISSUER_ID,
  issuer,
  makePng,
  STATUS_LIST_ID,
  testIssuer,
} from './support/fixtures';
import { independentVerify } from './support/independent-verifier';

const NOW = new Date('2026-12-01T00:00:00Z');

describe('issueCredential', () => {
  it('returns a credential that passes every independent check', async () => {
    const { signer, profile } = await testIssuer();
    const credential = await issueCredential(credentialInput(), {
      signer,
      issuerProfile: profile,
      created: ISSUED_AT,
    });
    expect(validateCredentialSchema(credential).valid).toBe(true);
    expect(await independentVerify(credential, { profile })).toEqual({ verified: true });
  });

  it('fails the self-check when the signing key is not published in the profile', async () => {
    const { signer } = await testIssuer();
    const stale = buildIssuerProfile({ ...issuer, keys: [await generateEd25519KeyPair()] });
    const error = await issueCredential(credentialInput(), {
      signer,
      issuerProfile: stale,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SelfCheckError);
    expect((error as SelfCheckError).problems.join(' ')).toMatch(/not authorized|not have/);
  });

  it('fails before signing when the schema rejects the credential', async () => {
    const { signer, profile } = await testIssuer();
    const sign = vi.fn(signer.sign);
    const input = credentialInput({
      achievement: { ...credentialInput().achievement, achievementType: 'Trophy' },
    });
    await expect(
      issueCredential(input, { signer: { ...signer, sign }, issuerProfile: profile }),
    ).rejects.toThrow(SelfCheckError);
    expect(sign).not.toHaveBeenCalled();
  });

  it('fails the self-check when a signer returns a bad signature', async () => {
    const { signer, profile } = await testIssuer();
    const broken = { ...signer, sign: async () => new Uint8Array(64) };
    await expect(
      issueCredential(credentialInput(), { signer: broken, issuerProfile: profile }),
    ).rejects.toThrow(/self-check/);
  });

  it('issues many varied credentials that all verify on both paths and pass the schema', async () => {
    const { signer, profile } = await testIssuer();
    const names = ['Ana Lúcia', 'Zoë O’Brien', '李小龙', 'Jordan Rivera', 'Émile Zola'];
    for (let i = 0; i < 25; i++) {
      const name = names[i % names.length] as string;
      const credential = await issueCredential(
        credentialInput({
          id: `${BASE_URL}/credentials/${randomUUID()}`,
          recipient: {
            email: `person${i}@example.org`,
            name: i % 3 === 0 ? undefined : name,
          },
          validFrom: new Date(Date.UTC(2026, i % 12, 1 + i)),
          validUntil: i % 2 ? new Date(Date.UTC(2030, 0, 1)) : undefined,
          evidence: i % 4 === 0 ? [{ narrative: `Evidence #${i} with "quotes" & <tags>` }] : [],
          credentialStatus: buildStatusListEntry({
            statusListCredential: STATUS_LIST_ID,
            index: i * 5_000,
          }),
          achievement: {
            id: `${ACHIEVEMENT_ID}-${i}`,
            name: `Achievement ${i} — ${name}`,
            description: `Multi-line\ndescription ${i}`,
            criteria: { narrative: `- step one\n- step **two** for ${i}` },
            tag: i % 2 ? ['a', `tag-${i}`] : undefined,
          },
        }),
        { signer, issuerProfile: profile },
      );
      expect(validateCredentialSchema(credential)).toEqual({ valid: true, errors: [] });
      expect(await independentVerify(credential, { profile })).toEqual({ verified: true });
      expect(
        verifyRecipient(credential, {
          identityType: 'emailAddress',
          value: `PERSON${i}@example.org`,
        }),
      ).toBe(true);
    }
  });
});

describe('verifyCredential', () => {
  async function setup(revoked: number[] = []) {
    const { signer, profile } = await testIssuer();
    const bitstring = new Bitstring();
    for (const index of revoked) bitstring.set(index, true);
    const statusList = await issueStatusListCredential(
      { id: STATUS_LIST_ID, issuer: ISSUER_ID, bitstring, validFrom: ISSUED_AT },
      { signer, issuerProfile: profile },
    );
    const credential = await issueCredential(credentialInput(), { signer, issuerProfile: profile });
    return { credential, profile, statusList, signer };
  }

  function options(
    profile: IssuerProfileDocument,
    statusList?: SignedBitstringStatusListCredential,
  ) {
    return {
      now: NOW,
      resolveController: (id: string) => (id === profile.id ? profile : undefined),
      loadStatusListCredential: statusList
        ? (url: string) => (url === statusList.id ? statusList : undefined)
        : undefined,
    };
  }

  it('passes every check for a current, unrevoked credential', async () => {
    const { credential, profile, statusList } = await setup();
    const result = await verifyCredential(credential, options(profile, statusList));
    expect(result).toEqual({
      verified: true,
      checks: {
        format: { outcome: 'passed', message: 'Format and schema are valid' },
        proof: {
          outcome: 'passed',
          message: 'Signature checked with a key published by the issuer',
        },
        status: {
          outcome: 'passed',
          message: 'Not revoked (status list checked at 2026-12-01T00:00:00Z)',
        },
        validity: { outcome: 'passed', message: `Valid since ${ISSUED_AT}` },
      },
    });
  });

  it('verifies a credential extracted from a baked PNG', async () => {
    const { credential, profile, statusList } = await setup();
    const extracted = JSON.parse(extractFromPng(bakePng(makePng(), credential)) as string);
    expect((await verifyCredential(extracted, options(profile, statusList))).verified).toBe(true);
  });

  it('reports a revoked credential', async () => {
    const { credential, profile, statusList } = await setup([48_213]);
    const result = await verifyCredential(credential, options(profile, statusList));
    expect(result.verified).toBe(false);
    expect(result.checks.status).toEqual({
      outcome: 'failed',
      message: 'The issuer has revoked this credential',
    });
    expect(result.checks.proof.outcome).toBe('passed');
  });

  it('skips the status check when no loader is given', async () => {
    const { credential, profile } = await setup([48_213]);
    const result = await verifyCredential(credential, options(profile));
    expect(result.verified).toBe(true);
    expect(result.checks.status.outcome).toBe('skipped');
  });

  it('fails the status check when the list cannot be loaded', async () => {
    const { credential, profile } = await setup();
    const result = await verifyCredential(credential, {
      ...options(profile),
      loadStatusListCredential: () => {
        throw new Error('network down');
      },
    });
    expect(result.verified).toBe(false);
    expect(result.checks.status.message).toMatch(/Could not load the status list/);
  });

  it('fails the status check when the status list’s issuer profile is unavailable', async () => {
    const { credential, profile, statusList } = await setup();
    const result = await verifyCredential(credential, {
      ...options(profile, statusList),
      resolveController: (id: string) => (id === profile.id ? profile : undefined),
    });
    expect(result.verified).toBe(true);

    const withoutProfile = await verifyCredential(credential, {
      ...options(profile, statusList),
      // The credential's profile resolves; a second lookup (for the status list) does not.
      resolveController: (() => {
        let calls = 0;
        return () => (calls++ === 0 ? profile : undefined);
      })(),
    });
    expect(withoutProfile.checks.proof.outcome).toBe('passed');
    expect(withoutProfile.checks.status).toEqual({
      outcome: 'failed',
      message: 'Could not load the issuer profile for the status list',
    });
  });

  it('reports expiry and not-yet-valid separately from the signature', async () => {
    const { signer, profile } = await testIssuer();
    const expiring = await issueCredential(
      credentialInput({ validUntil: '2026-11-30T00:00:00Z' }),
      { signer, issuerProfile: profile },
    );
    const expired = await verifyCredential(expiring, options(profile));
    expect(expired.checks.validity).toEqual({
      outcome: 'failed',
      message: 'Expired on 2026-11-30T00:00:00Z',
    });
    expect(expired.checks.proof.outcome).toBe('passed');

    const future = await issueCredential(credentialInput({ validFrom: '2027-01-01T00:00:00Z' }), {
      signer,
      issuerProfile: profile,
    });
    const early = await verifyCredential(future, options(profile));
    expect(early.checks.validity.message).toBe('Not valid until 2027-01-01T00:00:00Z');
    expect(early.checks.proof.outcome).toBe('passed');
  });

  it('fails the proof check when the issuer profile is unavailable', async () => {
    const { credential } = await setup();
    const result = await verifyCredential(credential, {
      now: NOW,
      resolveController: () => undefined,
    });
    expect(result.checks.proof).toEqual({
      outcome: 'failed',
      message: `Could not load the issuer profile at ${ISSUER_ID}`,
    });
  });

  it('fails format and proof for a tampered credential', async () => {
    const { credential, profile } = await setup();
    const tampered = { ...credential, validFrom: 'not a date' };
    const result = await verifyCredential(tampered, options(profile));
    expect(result.verified).toBe(false);
    expect(result.checks.format.outcome).toBe('failed');
    expect(result.checks.proof.outcome).toBe('failed');
  });

  it('fails cleanly for things that are not credentials', async () => {
    for (const input of [null, 'text', 42, {}, { proof: {} }]) {
      const result = await verifyCredential(input, {
        now: NOW,
        resolveController: () => undefined,
      });
      expect(result.verified).toBe(false);
      expect(result.checks.proof.outcome).toBe('failed');
    }
  });
});
