import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import {
  buildIssuerProfile,
  buildStatusListEntry,
  type CredentialInput,
  createEd25519Signer,
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  type IssuerInput,
} from '../../src/index';

export const BASE_URL = 'https://credforge.app';
export const ISSUER_ID = `${BASE_URL}/issuers/7f3e9a52-0c4b-4d8e-9a61-2b5d8c1e0f37`;
export const CREDENTIAL_ID = `${BASE_URL}/credentials/0b6f3c1e-5d0a-4b8e-9c55-1c2f7e3d9a10`;
export const ACHIEVEMENT_ID = `${BASE_URL}/achievements/2a91c4d0-6e8f-4b1a-9d3c-5f7e8a9b0c1d`;
export const STATUS_LIST_ID = `${BASE_URL}/status/7f3e9a52-0c4b-4d8e-9a61-2b5d8c1e0f37/1`;
export const ISSUED_AT = '2026-11-02T15:04:05Z';
export const SALT = 'Xk9qT2m4LwP8vR1sY6nZ3a';

/** Deterministic test-only keys (never used outside tests and sample fixtures). */
export function testKeyPair(label = 'issuer'): Promise<Ed25519KeyPair> {
  const seed = createHash('sha256').update(`credforge ob3 test key: ${label}`).digest();
  return generateEd25519KeyPair(seed);
}

export const issuer: IssuerInput = {
  id: ISSUER_ID,
  name: 'Example Cyber Academy',
  url: 'https://example.org',
  email: 'badges@example.org',
  description: 'Hands-on security training for small teams.',
  image: `${ISSUER_ID}/images/c41a9e0d.png`,
};

export function credentialInput(overrides: Partial<CredentialInput> = {}): CredentialInput {
  return {
    id: CREDENTIAL_ID,
    issuer,
    achievement: {
      id: ACHIEVEMENT_ID,
      name: 'Intro to Network Defense',
      description: 'Recognizes foundational skills in defending small networks.',
      criteria: {
        narrative: 'Completed all six labs and scored 80% or higher on the final assessment.',
      },
      image: `${ACHIEVEMENT_ID}/images/9f2c7b11.png`,
      tag: ['networking', 'security'],
    },
    recipient: { email: 'Jordan.Rivera@Example.com', salt: SALT, name: 'Jordan Rivera' },
    validFrom: ISSUED_AT,
    credentialStatus: buildStatusListEntry({ statusListCredential: STATUS_LIST_ID, index: 48213 }),
    ...overrides,
  };
}

/** The test issuer: key pair, signer and published profile. */
export async function testIssuer(label = 'issuer', input: IssuerInput = issuer) {
  const keyPair = await testKeyPair(label);
  const signer = await createEd25519Signer({ controller: input.id, ...keyPair });
  const profile = buildIssuerProfile({ ...input, keys: [keyPair] });
  return { keyPair, signer, profile };
}

export function readFixture(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');
}

export function readJsonFixture<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFixture(path)) as T;
}

/** A tiny valid RGBA PNG (`size`×`size`, one colour), built without an image library. */
export function makePng(size = 2): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const row = Buffer.concat([Buffer.of(0), Buffer.alloc(size * 4, 0x37)]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// Reference CRC-32 (independent of node:zlib's, which the code under test uses).
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
