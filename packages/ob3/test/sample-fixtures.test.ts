import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSampleFixtures, DEFAULT_SAMPLE_BASE_URL } from '../scripts/sample-fixtures';
import {
  Bitstring,
  extractFromPng,
  extractFromSvg,
  validateCredentialSchema,
  validateProfileSchema,
  verifyCredential,
  verifyProof,
} from '../src/index';
import { independentVerify } from './support/independent-verifier';

const files = await buildSampleFixtures();
const text = (path: string) => {
  const content = files.get(path);
  return typeof content === 'string' ? content : Buffer.from(content ?? []).toString('utf8');
};
const json = (path: string) => JSON.parse(text(path)) as Record<string, unknown>;

/** Resolves sample URLs to the `public/` files, the way a validator would fetch them. */
function fromPublic(url: string): unknown {
  const path = `public${url.slice(DEFAULT_SAMPLE_BASE_URL.length)}`;
  return files.has(path) ? json(path) : undefined;
}

const profile = json('public/issuers/5a1e0c7d-3b2f-4e8a-9c6d-0f1e2d3c4b5a');
const now = new Date('2026-12-01T00:00:00Z');
const verify = (credential: unknown) =>
  verifyCredential(credential, {
    now,
    resolveController: fromPublic,
    loadStatusListCredential: fromPublic,
  });

describe('sample fixtures for the 1EdTech validator', () => {
  it.each(['credential.json', 'credential-revoked.json', 'credential-no-status.json'])(
    '%s passes the schema and the independent verifier',
    async (path) => {
      expect(validateCredentialSchema(json(path))).toEqual({ valid: true, errors: [] });
      expect(await independentVerify(json(path), { profile })).toEqual({ verified: true });
    },
  );

  it('publishes an issuer profile that passes the Profile schema', () => {
    expect(validateProfileSchema(profile)).toEqual({ valid: true, errors: [] });
  });

  it('verifies end to end through the hosted documents', async () => {
    expect((await verify(json('credential.json'))).verified).toBe(true);
    expect((await verify(json('credential-no-status.json'))).checks.status.outcome).toBe('skipped');
    const revoked = await verify(json('credential-revoked.json'));
    expect(revoked.verified).toBe(false);
    expect(revoked.checks.status.message).toBe('The issuer has revoked this credential');
  });

  it('bakes the credentials into the badge images', () => {
    expect(JSON.parse(extractFromPng(files.get('badge.png') as Uint8Array) as string)).toEqual(
      json('credential.json'),
    );
    expect(
      JSON.parse(extractFromPng(files.get('badge-no-status.png') as Uint8Array) as string),
    ).toEqual(json('credential-no-status.json'));
    expect(JSON.parse(extractFromSvg(text('badge.svg')) as string)).toEqual(
      json('credential.json'),
    );
  });

  it('matches the committed files in fixtures/sample (run `pnpm fixtures` after changes)', async () => {
    for (const [path, content] of files) {
      const committed = readFileSync(new URL(`../fixtures/sample/${path}`, import.meta.url));
      if (path.startsWith('public/status/')) {
        // GZIP output can differ between zlib builds (it matches on Windows and Linux x64), so
        // compare the decoded list and check the committed proof instead of the bytes.
        const ours = json(path) as { credentialSubject: { encodedList: string }; proof: object };
        const theirs = JSON.parse(committed.toString('utf8')) as typeof ours;
        expect(Bitstring.decode(theirs.credentialSubject.encodedList).toBytes()).toEqual(
          Bitstring.decode(ours.credentialSubject.encodedList).toBytes(),
        );
        expect((await verifyProof(theirs, { controller: profile })).verified).toBe(true);
        continue;
      }
      expect(committed.equals(Buffer.from(content)), path).toBe(true);
    }
  });
});
