import { gzipSync } from 'node:zlib';
import { createList, decodeList } from '@digitalbazaar/vc-bitstring-status-list';
import { describe, expect, it } from 'vitest';
import {
  allocateRandomIndex,
  Bitstring,
  buildStatusListCredential,
  buildStatusListEntry,
  checkStatusListEntry,
  issueStatusListCredential,
  MIN_STATUS_LIST_LENGTH,
  StatusListFullError,
  signCredential,
} from '../src/index';
import { ISSUED_AT, ISSUER_ID, STATUS_LIST_ID, testIssuer } from './support/fixtures';
import { independentVerify } from './support/independent-verifier';

// After ISSUED_AT, so lists issued then are current.
const NOW = new Date('2026-12-01T00:00:00Z');

describe('Bitstring', () => {
  it('defaults to the 131,072-entry minimum, all clear', () => {
    const bits = new Bitstring();
    expect(bits.length).toBe(131_072);
    expect(MIN_STATUS_LIST_LENGTH).toBe(131_072);
    expect(bits.count()).toBe(0);
  });

  it('numbers bits from the left-most bit of the first byte', () => {
    const bits = new Bitstring(16);
    bits.set(0, true);
    bits.set(9, true);
    expect([...bits.toBytes()]).toEqual([0b1000_0000, 0b0100_0000]);
    bits.set(0, false);
    expect(bits.get(0)).toBe(false);
    expect(bits.get(9)).toBe(true);
    expect(bits.count()).toBe(1);
  });

  it('round-trips through encodedList (multibase base64url of GZIP)', () => {
    const bits = new Bitstring();
    for (const index of [0, 7, 8, 48_213, 131_071]) bits.set(index, true);
    const encoded = bits.encode();
    expect(encoded).toMatch(/^u[A-Za-z0-9_-]+$/); // no padding
    // GZIP header with the OS byte set to 255, so output doesn't depend on the build platform.
    expect([...Buffer.from(encoded.slice(1), 'base64url').subarray(0, 10)]).toEqual([
      0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff,
    ]);
    const decoded = Bitstring.decode(encoded);
    expect(decoded.length).toBe(131_072);
    expect(decoded.toBytes()).toEqual(bits.toBytes());
  });

  it('interoperates with Digital Bazaar’s status list library in both directions', async () => {
    const ours = new Bitstring();
    ours.set(5, true);
    ours.set(48_213, true);
    const theirs = await decodeList({ encodedList: ours.encode() });
    expect(theirs.length).toBe(131_072);
    expect([theirs.getStatus(5), theirs.getStatus(6), theirs.getStatus(48_213)]).toEqual([
      true,
      false,
      true,
    ]);

    const list = await createList({ length: 131_072 });
    list.setStatus(131_071, true);
    const decoded = Bitstring.decode(await list.encode());
    expect(decoded.get(131_071)).toBe(true);
    expect(decoded.count()).toBe(1);
  });

  it('rejects encodings without the multibase prefix, and decompression bombs', () => {
    const plain = gzipSync(new Uint8Array(16)).toString('base64url');
    expect(() => Bitstring.decode(plain)).toThrow(/starting with "u"/);
    const bomb = `u${gzipSync(new Uint8Array(17 * 1024 * 1024)).toString('base64url')}`;
    expect(() => Bitstring.decode(bomb)).toThrow();
  });

  it('rejects out-of-range indexes and lengths', () => {
    const bits = new Bitstring(8);
    expect(() => bits.get(8)).toThrow(RangeError);
    expect(() => bits.set(-1, true)).toThrow(RangeError);
    expect(() => bits.get(1.5)).toThrow(RangeError);
    expect(() => new Bitstring(12)).toThrow(/multiple of 8/);
  });
});

describe('allocateRandomIndex', () => {
  it('spreads allocations across the whole list without repeats', () => {
    const allocated = new Bitstring();
    const indexes = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const index = allocateRandomIndex(allocated);
      expect(allocated.get(index)).toBe(false);
      allocated.set(index, true);
      indexes.add(index);
    }
    expect(indexes.size).toBe(2_000);
    expect(Math.max(...indexes)).toBeGreaterThan(100_000);
    expect(Math.min(...indexes)).toBeLessThan(30_000);
  });

  it('finds the last free index of a nearly full list', () => {
    const allocated = new Bitstring(64);
    for (let i = 0; i < 64; i++) if (i !== 41) allocated.set(i, true);
    expect(allocateRandomIndex(allocated)).toBe(41);
    allocated.set(41, true);
    expect(() => allocateRandomIndex(allocated)).toThrow(StatusListFullError);
  });

  it('accepts an injected random source', () => {
    expect(allocateRandomIndex(new Bitstring(64), () => 17)).toBe(17);
  });
});

describe('buildStatusListEntry', () => {
  it('uses a string statusListIndex, as Bitstring Status List v1.0 requires', () => {
    expect(buildStatusListEntry({ statusListCredential: STATUS_LIST_ID, index: 48213 })).toEqual({
      id: `${STATUS_LIST_ID}#48213`,
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: '48213',
      statusListCredential: STATUS_LIST_ID,
    });
  });

  it('rejects bad input', () => {
    expect(() =>
      buildStatusListEntry({ statusListCredential: STATUS_LIST_ID, index: -1 }),
    ).toThrow();
    expect(() => buildStatusListEntry({ statusListCredential: 'list', index: 1 })).toThrow();
  });
});

describe('status list credential', () => {
  async function revokedList(...indexes: number[]) {
    const { signer, profile } = await testIssuer();
    const bitstring = new Bitstring();
    for (const index of indexes) bitstring.set(index, true);
    const list = await issueStatusListCredential(
      { id: STATUS_LIST_ID, issuer: ISSUER_ID, bitstring, validFrom: ISSUED_AT },
      { signer, issuerProfile: profile, created: ISSUED_AT },
    );
    return { list, profile, signer };
  }

  it('builds the W3C shape', () => {
    const list = buildStatusListCredential({
      id: STATUS_LIST_ID,
      issuer: ISSUER_ID,
      bitstring: new Bitstring(),
      validFrom: ISSUED_AT,
      ttl: 300_000,
    });
    expect(list).toMatchObject({
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: STATUS_LIST_ID,
      type: ['VerifiableCredential', 'BitstringStatusListCredential'],
      issuer: ISSUER_ID,
      validFrom: ISSUED_AT,
      credentialSubject: {
        id: `${STATUS_LIST_ID}#list`,
        type: 'BitstringStatusList',
        statusPurpose: 'revocation',
        ttl: 300_000,
      },
    });
    expect(() =>
      buildStatusListCredential({
        id: STATUS_LIST_ID,
        issuer: ISSUER_ID,
        bitstring: new Bitstring(8),
      }),
    ).toThrow(/at least 131072/);
  });

  it('is signed, self-checked and independently verifiable', async () => {
    const { list, profile } = await revokedList(48_213);
    expect(list.proof.verificationMethod).toMatch(/#z6Mk/);
    expect(await independentVerify(list, { profile })).toEqual({ verified: true });
  });

  it('reports set and clear bits', async () => {
    const { list, profile } = await revokedList(48_213);
    const options = { controller: profile, expectedIssuer: ISSUER_ID, now: NOW };
    const revoked = buildStatusListEntry({ statusListCredential: STATUS_LIST_ID, index: 48_213 });
    const valid = buildStatusListEntry({ statusListCredential: STATUS_LIST_ID, index: 48_214 });
    expect(await checkStatusListEntry(revoked, list, options)).toEqual({
      ok: true,
      purpose: 'revocation',
      set: true,
    });
    expect(await checkStatusListEntry(valid, list, options)).toEqual({
      ok: true,
      purpose: 'revocation',
      set: false,
    });
    // A numeric index, as in the OB 3.0 examples, is read too.
    expect(
      await checkStatusListEntry({ ...revoked, statusListIndex: 48_213 }, list, options),
    ).toMatchObject({ ok: true, set: true });
  });

  it('refuses a tampered, foreign or mismatched list', async () => {
    const { list, profile, signer } = await revokedList(48_213);
    const entry = buildStatusListEntry({ statusListCredential: STATUS_LIST_ID, index: 48_213 });
    const options = { controller: profile, expectedIssuer: ISSUER_ID, now: NOW };

    const cleared = structuredClone(list);
    cleared.credentialSubject.encodedList = new Bitstring().encode();
    expect(await checkStatusListEntry(entry, cleared, options)).toMatchObject({ ok: false });

    expect(
      await checkStatusListEntry(entry, list, { ...options, expectedIssuer: 'https://other.org' }),
    ).toEqual({ ok: false, errors: ['The status list was not issued by the credential issuer.'] });

    expect(
      await checkStatusListEntry({ ...entry, statusPurpose: 'suspension' }, list, options),
    ).toMatchObject({ ok: false, errors: [expect.stringMatching(/purpose/)] });

    expect(
      await checkStatusListEntry(
        { ...entry, statusListCredential: 'https://credforge.app/status/x/2' },
        list,
        options,
      ),
    ).toMatchObject({ ok: false, errors: [expect.stringMatching(/does not match/)] });

    const short = buildStatusListCredential({
      id: STATUS_LIST_ID,
      issuer: ISSUER_ID,
      bitstring: new Bitstring(),
      validFrom: ISSUED_AT,
    });
    short.credentialSubject.encodedList = new Bitstring(1024).encode();
    const signedShort = await signCredential(short, signer);
    expect(await checkStatusListEntry(entry, signedShort, options)).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/fewer than 131072/)],
    });
  });

  it('refuses an expired list', async () => {
    const { signer, profile } = await testIssuer();
    const list = await issueStatusListCredential(
      {
        id: STATUS_LIST_ID,
        issuer: ISSUER_ID,
        bitstring: new Bitstring(),
        validFrom: ISSUED_AT,
        validUntil: '2026-11-03T00:00:00Z',
      },
      { signer, issuerProfile: profile },
    );
    const entry = buildStatusListEntry({ statusListCredential: STATUS_LIST_ID, index: 1 });
    expect(
      await checkStatusListEntry(entry, list, {
        controller: profile,
        now: new Date('2026-12-01T00:00:00Z'),
      }),
    ).toEqual({ ok: false, errors: ['The status list credential has expired.'] });
  });
});
