import type { VerifyCheck, VerifyResult, verifyInput } from '@credforge/contracts';
import { credential, eq, type Queryable } from '@credforge/db';
import {
  type CredentialVerification,
  extractFromPng,
  extractFromSvg,
  verifyCredential,
  verifyRecipient,
} from '@credforge/ob3';
import type { z } from 'zod';
import { ApiError, isUuid } from '../api/errors';
import type { DocumentFetcher } from './fetch';
import { createLocalResolvers } from './local';

export type ParsedVerifyInput = z.output<typeof verifyInput>;

export interface VerifyServices {
  db: Queryable;
  publicBaseUrl: string;
  /** Fetches other issuers' documents; this instance's own are read from the database. */
  fetcher: DocumentFetcher;
}

type Source = VerifyResult['source'];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JSON_ACCEPT = 'application/ld+json, application/vc+ld+json;q=0.9, application/json;q=0.8';
const CREDENTIAL_ACCEPT = `${JSON_ACCEPT}, image/png;q=0.5, image/svg+xml;q=0.5, text/html;q=0.1`;

const notACredential = (detail: string) =>
  new ApiError(422, 'not_a_credential', 'Nothing to check', detail);

/** The credential from text that should be JSON: a baked image or a pasted document. */
function parseCredentialText(text: string, where: string): unknown {
  const trimmed = text.trim();
  if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(trimmed)) {
    throw notACredential(
      `${where} holds a JWT-signed credential. credforge checks Data Integrity proofs (eddsa-rdfc-2022) only.`,
    );
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // reported below
  }
  throw notACredential(`${where} isn’t a JSON credential.`);
}

/** The credential baked into a PNG (iTXt chunk) or SVG (`<openbadges:credential>`). */
export function credentialFromImage(bytes: Buffer): { credential: unknown; source: Source } {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let text: string | undefined;
    try {
      text = extractFromPng(bytes);
    } catch {
      throw notACredential('The PNG file is damaged.');
    }
    if (!text) throw notACredential('No Open Badges credential is baked into this PNG.');
    return { credential: parseCredentialText(text, 'The PNG'), source: 'png' };
  }
  const svg = bytes.toString('utf8');
  if (/<svg[\s>]/i.test(svg)) {
    let text: string | undefined;
    try {
      text = extractFromSvg(svg);
    } catch {
      throw notACredential('The SVG file can’t be read.');
    }
    if (!text) throw notACredential('No Open Badges credential is baked into this SVG.');
    return { credential: parseCredentialText(text, 'The SVG'), source: 'svg' };
  }
  throw notACredential('Upload a baked badge image: a PNG or SVG file.');
}

/** `data:image/png;base64,…` or plain base64. */
function decodeImage(value: string): Buffer {
  const comma = value.startsWith('data:') ? value.indexOf(',') : -1;
  const bytes = Buffer.from(comma === -1 ? value : value.slice(comma + 1), 'base64');
  if (bytes.length === 0) throw notACredential('The image is empty.');
  return bytes;
}

const LOCAL_CREDENTIAL =
  /^\/credentials\/([0-9a-f-]{36})(?:\/(badge\.png|badge\.svg|credential\.json))?\/?$/i;

/**
 * One of this instance's credentials by its URL (or a download's), unless its page is hidden. A
 * credential whose recipient's data was erased has no document left to check (design plan §12.1).
 */
async function localCredential(
  services: VerifyServices,
  url: URL,
): Promise<{ credential: unknown; source: Source } | null | undefined> {
  if (url.origin !== new URL(services.publicBaseUrl).origin) return undefined;
  const match = LOCAL_CREDENTIAL.exec(url.pathname);
  if (!match?.[1] || !isUuid(match[1])) return null;
  const [row] = await services.db
    .select({ document: credential.document, visibility: credential.visibility })
    .from(credential)
    .where(eq(credential.id, match[1].toLowerCase()));
  if (!row || row.visibility === 'hidden') return null;
  if (!row.document) {
    throw new ApiError(
      410,
      'credential_erased',
      'Badge removed',
      'The issuer revoked this badge and removed its details. A copy of it (its JSON or a badge image) checks as revoked.',
    );
  }
  return {
    credential: row.document,
    source: match[2] === 'badge.png' ? 'png' : match[2] === 'badge.svg' ? 'svg' : 'url',
  };
}

async function credentialFromUrl(
  services: VerifyServices,
  address: string,
): Promise<{ credential: unknown; source: Source }> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw notACredential('Enter the credential’s full address, starting with https://.');
  }
  const local = await localCredential(services, url);
  if (local === null) throw notACredential('There is no public credential at that address.');
  if (local) return local;

  const fetched = await services.fetcher(url.toString(), CREDENTIAL_ACCEPT).catch((error) => {
    throw notACredential(`Couldn’t load ${url.host}: ${(error as Error).message}`);
  });
  const type = fetched.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'image/png' || type === 'image/svg+xml') return credentialFromImage(fetched.body);
  const text = fetched.body.toString('utf8');
  if (type === 'text/html') {
    // A credential page that names its JSON (as credforge's pages do).
    const link =
      /<link[^>]+rel=["']alternate["'][^>]+type=["']application\/(?:ld\+)?json["'][^>]*>/i.exec(
        text,
      )?.[0];
    const href = link ? /href=["']([^"']+)["']/i.exec(link)?.[1] : undefined;
    if (!href) throw notACredential('That address is a web page without a credential.');
    const json = await services
      .fetcher(new URL(href, fetched.url).toString(), JSON_ACCEPT)
      .catch((error) => {
        throw notACredential(`Couldn’t load the credential: ${(error as Error).message}`);
      });
    return {
      credential: parseCredentialText(json.body.toString('utf8'), 'That address'),
      source: 'url',
    };
  }
  return { credential: parseCredentialText(text, 'That address'), source: 'url' };
}

async function credentialFromInput(
  services: VerifyServices,
  input: ParsedVerifyInput,
): Promise<{ credential: unknown; source: Source }> {
  if (input.url) return credentialFromUrl(services, input.url);
  if (input.image) return credentialFromImage(decodeImage(input.image));
  const pasted = input.credential;
  if (typeof pasted === 'string') {
    return { credential: parseCredentialText(pasted, 'The text'), source: 'json' };
  }
  if (pasted) return { credential: pasted, source: 'json' };
  throw notACredential('Give a URL, the credential’s JSON, or a badge image.');
}

/**
 * Resolvers for the checks: this instance's issuer profiles and status lists come from its
 * database (as they are served), anyone else's are fetched over HTTPS by the safe fetcher.
 */
function resolvers(services: VerifyServices) {
  const local = createLocalResolvers(services.db, services.publicBaseUrl);
  const isLocal = (url: string) => url.startsWith(`${services.publicBaseUrl}/`);
  const fetchJson = async (url: string) =>
    JSON.parse((await services.fetcher(url, JSON_ACCEPT)).body.toString('utf8')) as unknown;
  return {
    resolveController: (id: string) => (isLocal(id) ? local.resolveController(id) : fetchJson(id)),
    loadStatusListCredential: (url: string) =>
      isLocal(url) ? local.loadStatusListCredential(url) : fetchJson(url),
  };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function summary(publicBaseUrl: string, value: unknown): VerifyResult['credential'] {
  const doc = record(value);
  if (Object.keys(doc).length === 0) return null;
  const subject = record(
    Array.isArray(doc.credentialSubject) ? doc.credentialSubject[0] : doc.credentialSubject,
  );
  const achievementDoc = record(subject.achievement);
  const issuerDoc = typeof doc.issuer === 'string' ? { id: doc.issuer } : record(doc.issuer);
  const identifiers = Array.isArray(subject.identifier) ? subject.identifier.map(record) : [];
  const issuerId = text(issuerDoc.id);
  return {
    id: text(doc.id),
    name: text(doc.name),
    achievement: {
      id: text(achievementDoc.id),
      name: text(achievementDoc.name),
      description: text(achievementDoc.description),
    },
    issuer: { id: issuerId, name: text(issuerDoc.name), url: text(issuerDoc.url) },
    recipientName: text(
      identifiers.find((item) => item.identityType === 'name' && item.hashed === false)
        ?.identityHash,
    ),
    validFrom: text(doc.validFrom) ?? text(doc.issuanceDate),
    validUntil: text(doc.validUntil) ?? text(doc.expirationDate),
    issuedHere: issuerId?.startsWith(`${publicBaseUrl}/issuers/`) ?? false,
  };
}

/**
 * One of this instance's credentials that was revoked moments ago, before the worker re-signed
 * its status list: say so, as its page does, instead of reporting the list's old bit.
 */
async function revokedHere(
  services: VerifyServices,
  value: unknown,
  result: CredentialVerification,
): Promise<CredentialVerification> {
  if (result.checks.status.outcome !== 'passed') return result;
  const id = text(record(value).id);
  const prefix = `${services.publicBaseUrl}/credentials/`;
  const credentialId = id?.startsWith(prefix) ? id.slice(prefix.length) : '';
  if (!isUuid(credentialId)) return result;
  const [row] = await services.db
    .select({ status: credential.status })
    .from(credential)
    .where(eq(credential.id, credentialId.toLowerCase()));
  if (row?.status !== 'revoked') return result;
  return {
    verified: false,
    checks: {
      ...result.checks,
      status: {
        outcome: 'failed',
        message:
          'The issuer has revoked this credential. Its signed status list is being updated and will show it within a minute.',
      },
    },
  };
}

/** "Was it issued to this address?", against the salted hash; the address is never kept. */
function recipientCheck(value: unknown, email: string): VerifyCheck {
  const subject = record(record(value).credentialSubject);
  const identifiers = Array.isArray(subject.identifier) ? subject.identifier.map(record) : [];
  if (!identifiers.some((item) => item.identityType === 'emailAddress')) {
    return { outcome: 'skipped', message: 'The credential doesn’t name an email address' };
  }
  return verifyRecipient(value, { identityType: 'emailAddress', value: email })
    ? {
        outcome: 'passed',
        message: 'Issued to this email address (matched against the salted hash in the credential)',
      }
    : { outcome: 'failed', message: 'Not issued to this email address' };
}

/**
 * Verifies a credential from a URL, pasted JSON or a baked image (design plan §8.5), reporting
 * each check separately: format and schema, the signature with a key the issuer publishes,
 * status (read from the status list at `checkedAt`), the validity dates, and optionally whether it
 * was issued to an email address. Nothing about the request is stored.
 */
export async function verifyAny(
  services: VerifyServices,
  input: ParsedVerifyInput,
  now = new Date(),
): Promise<VerifyResult> {
  const { credential: value, source } = await credentialFromInput(services, input);
  const result = await revokedHere(
    services,
    value,
    await verifyCredential(value, { ...resolvers(services), now }),
  );
  const email = input.email?.trim();
  return {
    verified: result.verified,
    checkedAt: now.toISOString(),
    source,
    credential: summary(services.publicBaseUrl, value),
    checks: {
      ...result.checks,
      ...(email && { recipient: recipientCheck(value, email) }),
    },
  };
}
