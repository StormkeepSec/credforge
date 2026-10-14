import { randomInt } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MIN_STATUS_LIST_LENGTH, STATUS_LIST_CREDENTIAL_CONTEXT } from './constants';
import { toDateTimeString } from './dates';
import { isRecord } from './document-loader';
import { verifyProof } from './proof';
import type {
  BitstringStatusListCredential,
  BitstringStatusListEntry,
  StatusPurpose,
  Url,
} from './types';
import { assertAbsoluteUrl, compact } from './util';

// A decoded list may come from someone else's server, so decompression is capped. 16 MiB is 128
// times the minimum list size.
const MAX_DECODED_BYTES = 16 * 1024 * 1024;

/**
 * A fixed-length bitstring, as used by W3C Bitstring Status List v1.0. Index 0 is the left-most
 * (most significant) bit of the first byte.
 */
export class Bitstring {
  readonly length: number;
  readonly #bytes: Uint8Array;

  /** Creates an all-zero bitstring of `length` bits, or wraps a copy of existing bytes. */
  constructor(lengthOrBytes: number | Uint8Array = MIN_STATUS_LIST_LENGTH) {
    if (typeof lengthOrBytes === 'number') {
      if (!Number.isInteger(lengthOrBytes) || lengthOrBytes <= 0 || lengthOrBytes % 8 !== 0) {
        throw new RangeError('A bitstring length must be a positive multiple of 8.');
      }
      this.#bytes = new Uint8Array(lengthOrBytes / 8);
    } else {
      this.#bytes = new Uint8Array(lengthOrBytes);
    }
    this.length = this.#bytes.length * 8;
  }

  /** Decodes an `encodedList`: multibase base64url (`u` prefix, no padding) of the GZIP bytes. */
  static decode(encodedList: string): Bitstring {
    if (!encodedList.startsWith('u')) {
      throw new TypeError('"encodedList" must be multibase base64url (starting with "u").');
    }
    const compressed = Buffer.from(encodedList.slice(1), 'base64url');
    return new Bitstring(gunzipSync(compressed, { maxOutputLength: MAX_DECODED_BYTES }));
  }

  get(index: number): boolean {
    this.#assertIndex(index);
    const byte = this.#bytes[index >> 3] ?? 0;
    return (byte & (0x80 >> (index & 7))) !== 0;
  }

  set(index: number, value: boolean): void {
    this.#assertIndex(index);
    const mask = 0x80 >> (index & 7);
    const byte = this.#bytes[index >> 3] ?? 0;
    this.#bytes[index >> 3] = value ? byte | mask : byte & ~mask;
  }

  /** Number of bits that are set. */
  count(): number {
    let total = 0;
    for (let byte of this.#bytes) {
      while (byte) {
        byte &= byte - 1;
        total++;
      }
    }
    return total;
  }

  /** The `encodedList` value: `u` + base64url(GZIP(bytes)). */
  encode(): string {
    const gzip = gzipSync(this.#bytes, { level: 9 });
    // zlib writes the build platform into the header's OS byte (10 on Windows, 3 on Unix). Setting
    // it to 255, "unknown" (RFC 1952), makes the same list encode identically everywhere.
    gzip[9] = 0xff;
    return `u${gzip.toString('base64url')}`;
  }

  /** A copy of the raw bytes, for storage. */
  toBytes(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }

  #assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Index ${index} is outside the bitstring (0–${this.length - 1}).`);
    }
  }
}

export class StatusListFullError extends Error {
  constructor() {
    super('Every index in this status list is allocated.');
    this.name = 'StatusListFullError';
  }
}

/**
 * Picks a random index that is not yet allocated. `allocated` has a bit set for every index in
 * use. Random positions give recipients herd privacy: an index says nothing about when or to whom
 * a credential was issued. The caller marks the index as allocated.
 */
export function allocateRandomIndex(
  allocated: Bitstring,
  random: (max: number) => number = randomInt,
): number {
  for (let attempt = 0; attempt < 64; attempt++) {
    const index = random(allocated.length);
    if (!allocated.get(index)) return index;
  }
  // Nearly full: scan from a random start for the next free index.
  const start = random(allocated.length);
  for (let offset = 0; offset < allocated.length; offset++) {
    const index = (start + offset) % allocated.length;
    if (!allocated.get(index)) return index;
  }
  throw new StatusListFullError();
}

export interface StatusListEntryInput {
  /** URL of the BitstringStatusListCredential, e.g. `{PUBLIC_BASE_URL}/status/{issuerId}/{n}`. */
  statusListCredential: Url;
  index: number;
  statusPurpose?: StatusPurpose;
}

/**
 * Builds a credential's `credentialStatus`. `statusListIndex` is a string, as Bitstring Status
 * List v1.0 requires (the OB 3.0 examples show a number, which the VCDM 2.0 context would read as
 * a different literal).
 */
export function buildStatusListEntry(input: StatusListEntryInput): BitstringStatusListEntry {
  assertAbsoluteUrl(input.statusListCredential, 'statusListCredential');
  if (!Number.isInteger(input.index) || input.index < 0) {
    throw new RangeError('"index" must be a non-negative integer.');
  }
  return {
    id: `${input.statusListCredential}#${input.index}`,
    type: 'BitstringStatusListEntry',
    statusPurpose: input.statusPurpose ?? 'revocation',
    statusListIndex: String(input.index),
    statusListCredential: input.statusListCredential,
  };
}

export interface StatusListCredentialInput {
  /** The status list URL; must equal the entries' `statusListCredential`. */
  id: Url;
  /** The issuer id (the same issuer that signs the credentials in the list). */
  issuer: Url;
  bitstring: Bitstring;
  statusPurpose?: StatusPurpose;
  /** Defaults to now. */
  validFrom?: Date | string;
  validUntil?: Date | string;
  /** Suggested cache time in milliseconds. */
  ttl?: number;
}

/** Builds an unsigned BitstringStatusListCredential (W3C Bitstring Status List v1.0 §2.2). */
export function buildStatusListCredential(
  input: StatusListCredentialInput,
): BitstringStatusListCredential {
  assertAbsoluteUrl(input.id, 'id');
  assertAbsoluteUrl(input.issuer, 'issuer');
  if (input.bitstring.length < MIN_STATUS_LIST_LENGTH) {
    throw new RangeError(`A status list needs at least ${MIN_STATUS_LIST_LENGTH} entries.`);
  }
  return compact({
    '@context': [...STATUS_LIST_CREDENTIAL_CONTEXT],
    id: input.id,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer: input.issuer,
    validFrom: toDateTimeString(input.validFrom ?? new Date(), 'validFrom'),
    validUntil:
      input.validUntil === undefined ? undefined : toDateTimeString(input.validUntil, 'validUntil'),
    credentialSubject: compact({
      id: `${input.id}#list`,
      type: 'BitstringStatusList' as const,
      statusPurpose: input.statusPurpose ?? 'revocation',
      encodedList: input.bitstring.encode(),
      ttl: input.ttl,
    }),
  });
}

export interface StatusCheckOptions {
  /** Controller document (issuer profile) for the status list credential's proof. */
  controller: unknown;
  /** The issuer of the credential being checked; the status list must have the same issuer. */
  expectedIssuer?: string;
  now?: Date;
}

export type StatusCheckResult =
  | { ok: true; purpose: StatusPurpose; set: boolean }
  | { ok: false; errors: string[] };

/**
 * Looks up a credential's status, following the validation algorithm in Bitstring Status List
 * v1.0 §3.2: verify the status list credential, check it is current and has the same purpose,
 * decode the list (at least 131,072 entries) and read the bit. `set: true` means revoked (or
 * suspended, for a suspension list).
 */
export async function checkStatusListEntry(
  entry: unknown,
  statusListCredential: unknown,
  options: StatusCheckOptions,
): Promise<StatusCheckResult> {
  const fail = (...errors: string[]): StatusCheckResult => ({ ok: false, errors });
  if (!isRecord(entry) || entry.type !== 'BitstringStatusListEntry') {
    return fail('credentialStatus is not a BitstringStatusListEntry.');
  }
  const purpose = entry.statusPurpose;
  if (purpose !== 'revocation' && purpose !== 'suspension') {
    return fail(`Unsupported statusPurpose "${String(purpose)}".`);
  }
  if (entry.statusSize !== undefined && entry.statusSize !== 1) {
    return fail('Only single-bit status entries (statusSize 1) are supported.');
  }
  const index = parseIndex(entry.statusListIndex);
  if (index === undefined) return fail('statusListIndex must be a non-negative integer string.');

  if (!isRecord(statusListCredential)) return fail('The status list credential is not an object.');
  if (statusListCredential.id !== entry.statusListCredential) {
    return fail('The status list credential id does not match statusListCredential.');
  }
  const types = Array.isArray(statusListCredential.type) ? statusListCredential.type : [];
  if (!types.includes('BitstringStatusListCredential')) {
    return fail('The status list is not a BitstringStatusListCredential.');
  }
  const issuer = isRecord(statusListCredential.issuer)
    ? statusListCredential.issuer.id
    : statusListCredential.issuer;
  if (options.expectedIssuer !== undefined && issuer !== options.expectedIssuer) {
    return fail('The status list was not issued by the credential issuer.');
  }

  const proof = await verifyProof(statusListCredential, { controller: options.controller });
  if (!proof.verified) return fail(...proof.errors.map((error) => `Status list proof: ${error}`));

  const now = options.now ?? new Date();
  const { validFrom, validUntil } = statusListCredential;
  if (typeof validFrom === 'string' && new Date(validFrom) > now) {
    return fail('The status list credential is not valid yet.');
  }
  if (typeof validUntil === 'string' && new Date(validUntil) < now) {
    return fail('The status list credential has expired.');
  }

  const subject = statusListCredential.credentialSubject;
  if (!isRecord(subject) || subject.type !== 'BitstringStatusList') {
    return fail('The status list credentialSubject is not a BitstringStatusList.');
  }
  if (subject.statusPurpose !== purpose) {
    return fail(`The status list purpose is "${String(subject.statusPurpose)}", not "${purpose}".`);
  }
  if (typeof subject.encodedList !== 'string') return fail('The status list has no encodedList.');

  let bitstring: Bitstring;
  try {
    bitstring = Bitstring.decode(subject.encodedList);
  } catch (error) {
    return fail(`The status list could not be decoded: ${(error as Error).message}`);
  }
  if (bitstring.length < MIN_STATUS_LIST_LENGTH) {
    return fail(`The status list has fewer than ${MIN_STATUS_LIST_LENGTH} entries.`);
  }
  if (index >= bitstring.length) return fail('statusListIndex is outside the status list.');
  return { ok: true, purpose, set: bitstring.get(index) };
}

function parseIndex(value: unknown): number | undefined {
  // Accept the number form some issuers use (as the OB 3.0 examples do), as well as the string.
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return undefined;
  const index = Number(text);
  return Number.isSafeInteger(index) ? index : undefined;
}
