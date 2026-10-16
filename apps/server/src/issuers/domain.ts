import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DomainCheckResult, DomainStatus, DomainVerification } from '@credforge/contracts';
import {
  and,
  type Database,
  eq,
  isNotNull,
  isNull,
  issuer,
  lt,
  or,
  type Queryable,
} from '@credforge/db';
import { ApiError, notFound } from '../api/errors';
import { type AuditActor, type AuditRequestInfo, recordAudit, SYSTEM_ACTOR } from '../audit/audit';
import { createSafeFetcher, FetchError } from '../verify/fetch';
import type { IssuerRow } from './service';

/**
 * Issuer domain verification (design plan §6.3). The issuer proves it controls its website's host
 * by publishing `credforge-verify={token}` either as a DNS TXT record at `_credforge.{host}` or as
 * the file `https://{host}/.well-known/credforge-verify.txt`. Public pages then say "Website
 * verified"; otherwise the website is "self-reported". Verified domains are checked again every
 * day, and verification lapses after three failed checks in a row.
 */

export const DOMAIN_FILE_PATH = '/.well-known/credforge-verify.txt';
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
export const LAPSE_AFTER_FAILURES = 3;

/** Looks things up on the internet; tests pass a stand-in. */
export interface DomainChecker {
  /** The TXT records at a name, each joined into one string. Empty when there are none. */
  txt(name: string): Promise<string[]>;
  /** The body of an HTTPS URL (no redirects, small), or an error describing what happened. */
  file(url: string): Promise<string>;
}

export function createDomainChecker(userAgent: string): DomainChecker {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  const fetcher = createSafeFetcher({
    timeoutMs: 5000,
    maxBytes: 4096,
    maxRedirects: 0,
    userAgent,
  });
  return {
    async txt(name) {
      try {
        return (await resolver.resolveTxt(name)).map((parts) => parts.join(''));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
        throw error;
      }
    },
    async file(url) {
      const document = await fetcher(url, 'text/plain');
      return document.body.toString('utf8');
    },
  };
}

/** The website's host that can be verified, or null (no website, an IP address, localhost). */
export function verifiableHost(website: string | null): string | null {
  if (!website) return null;
  let host: string;
  try {
    host = new URL(website).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) !== 0) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  return host;
}

export function verificationValue(token: string): string {
  return `credforge-verify=${token}`;
}

/** What the API and the issuer app show: verified only for the host it was proven for. */
export function domainStatus(row: IssuerRow): DomainStatus | null {
  const host = verifiableHost(row.url);
  if (!host) return null;
  const verified = row.domainVerifiedAt !== null && row.domain === host;
  return {
    host,
    verifiedAt: verified ? (row.domainVerifiedAt?.toISOString() ?? null) : null,
    method: verified ? row.domainVerificationMethod : null,
  };
}

/** The verified host, for public pages; null when the website is self-reported. */
export function verifiedHost(row: Pick<IssuerRow, 'url' | 'domain' | 'domainVerifiedAt'>) {
  const host = verifiableHost(row.url);
  return host && row.domainVerifiedAt && row.domain === host ? host : null;
}

function describe(row: IssuerRow, host: string): DomainVerification {
  const status = domainStatus(row) ?? { host, verifiedAt: null, method: null };
  return {
    ...status,
    value: verificationValue(row.domainToken ?? ''),
    dnsName: `_credforge.${host}`,
    fileUrl: `https://${host}${DOMAIN_FILE_PATH}`,
    lastCheckedAt: row.domainCheckedAt?.toISOString() ?? null,
  };
}

const noWebsite = () =>
  new ApiError(
    422,
    'no_website',
    'Add a website first',
    'Set the issuer’s website (a domain name, not an IP address) before verifying it.',
  );

async function lockIssuer(tx: Queryable, orgId: string, issuerId: string): Promise<IssuerRow> {
  const [row] = await tx
    .select()
    .from(issuer)
    .where(and(eq(issuer.orgId, orgId), eq(issuer.id, issuerId)))
    .for('update');
  if (!row) throw notFound('Issuer');
  return row;
}

/** The record or file to publish; creates the issuer's token the first time. */
export async function startDomainVerification(
  tx: Queryable,
  orgId: string,
  issuerId: string,
): Promise<DomainVerification> {
  const row = await lockIssuer(tx, orgId, issuerId);
  const host = verifiableHost(row.url);
  if (!host) throw noWebsite();
  if (row.domainToken) return describe(row, host);
  const [updated] = await tx
    .update(issuer)
    .set({ domainToken: randomBytes(18).toString('base64url') })
    .where(eq(issuer.id, row.id))
    .returning();
  return describe(updated ?? row, host);
}

/** Checks DNS and the file at once; either one is enough. */
export async function lookForProof(
  checker: DomainChecker,
  host: string,
  value: string,
): Promise<DomainCheckResult['findings']> {
  const dnsName = `_credforge.${host}`;
  const fileUrl = `https://${host}${DOMAIN_FILE_PATH}`;
  const [dns, file] = await Promise.allSettled([checker.txt(dnsName), checker.file(fileUrl)]);

  const dnsFinding =
    dns.status === 'rejected'
      ? { method: 'dns' as const, found: false, detail: `Couldn’t look up ${dnsName}.` }
      : dns.value.some((record) => record.trim() === value)
        ? { method: 'dns' as const, found: true, detail: `Found the TXT record at ${dnsName}.` }
        : {
            method: 'dns' as const,
            found: false,
            detail:
              dns.value.length === 0
                ? `No TXT record at ${dnsName} yet. New records can take a while to appear.`
                : `${dnsName} has TXT records, but none is ${value}.`,
          };

  let fileFinding: DomainCheckResult['findings'][number];
  if (file.status === 'fulfilled') {
    const found = file.value.split(/\r?\n/).some((line) => line.trim() === value);
    fileFinding = {
      method: 'file',
      found,
      detail: found
        ? `Found ${value} at ${fileUrl}.`
        : `${fileUrl} was found, but it doesn’t contain ${value}.`,
    };
  } else {
    const reason = file.reason instanceof FetchError ? ` (${file.reason.message})` : '';
    fileFinding = {
      method: 'file',
      found: false,
      detail: `Couldn’t read ${fileUrl}${reason}. It must be served over HTTPS without redirects.`,
    };
  }
  return [dnsFinding, fileFinding];
}

/** Checks now and records the result (design plan §6.3). */
export async function checkDomain(
  db: Database,
  checker: DomainChecker,
  target: { orgId: string; issuerId: string },
  actor: AuditActor,
  request: AuditRequestInfo,
): Promise<DomainCheckResult> {
  const before = await startDomainVerification(db, target.orgId, target.issuerId);
  const findings = await lookForProof(checker, before.host, before.value);
  const proof = findings.find((finding) => finding.found);

  const domain = await db.transaction(async (tx) => {
    const row = await lockIssuer(tx, target.orgId, target.issuerId);
    const host = verifiableHost(row.url);
    // The website changed while checking: the proof was for another host.
    if (host !== before.host) throw noWebsite();
    const now = new Date();
    const wasVerified = verifiedHost(row) === host;
    const [updated] = await tx
      .update(issuer)
      .set(
        proof
          ? {
              domain: host,
              domainVerifiedAt: wasVerified ? row.domainVerifiedAt : now,
              domainVerificationMethod: proof.method,
              domainCheckedAt: now,
              domainCheckFailures: 0,
            }
          : { domainCheckedAt: now },
      )
      .where(eq(issuer.id, row.id))
      .returning();
    if (proof && !wasVerified) {
      await recordAudit(tx, {
        orgId: target.orgId,
        actor,
        action: 'issuer.domain_verified',
        target: { type: 'issuer', id: row.id },
        data: { domain: host, method: proof.method },
        request,
      });
    }
    return describe(updated ?? row, host);
  });
  return { verified: domain.verifiedAt !== null, findings, domain };
}

/**
 * Clears the proof when the website moves to another host (called when the issuer is updated).
 * The token stays, so the same record can prove the new host.
 */
export function domainChanges(before: IssuerRow, newUrl: string | null) {
  const host = verifiableHost(newUrl);
  if (before.domain === null || before.domain === host) return {};
  return {
    domain: null,
    domainVerifiedAt: null,
    domainVerificationMethod: null,
    domainCheckFailures: 0,
  };
}

/**
 * The worker's daily re-check of verified domains: a few at a time, each at most once a day.
 * Verification lapses after `LAPSE_AFTER_FAILURES` failed checks in a row.
 */
export async function recheckVerifiedDomains(
  db: Database,
  checker: DomainChecker,
  options: { now?: Date; limit?: number } = {},
): Promise<{ checked: number; lapsed: number }> {
  const now = options.now ?? new Date();
  const due = await db
    .select()
    .from(issuer)
    .where(
      and(
        isNotNull(issuer.domainVerifiedAt),
        or(
          isNull(issuer.domainCheckedAt),
          lt(issuer.domainCheckedAt, new Date(now.getTime() - RECHECK_AFTER_MS)),
        ),
      ),
    )
    .limit(options.limit ?? 10);

  let lapsed = 0;
  for (const row of due) {
    const host = verifiedHost(row);
    if (!host || !row.domainToken) {
      await db
        .update(issuer)
        .set({ domainVerifiedAt: null, domainVerificationMethod: null, domainCheckedAt: now })
        .where(eq(issuer.id, row.id));
      continue;
    }
    let found = false;
    try {
      found = (await lookForProof(checker, host, verificationValue(row.domainToken))).some(
        (finding) => finding.found,
      );
    } catch {
      found = false;
    }
    await db.transaction(async (tx) => {
      const failures = found ? 0 : row.domainCheckFailures + 1;
      const lapses = failures >= LAPSE_AFTER_FAILURES;
      await tx
        .update(issuer)
        .set({
          domainCheckedAt: now,
          domainCheckFailures: lapses ? 0 : failures,
          ...(lapses && { domainVerifiedAt: null, domainVerificationMethod: null }),
        })
        .where(eq(issuer.id, row.id));
      if (lapses) {
        lapsed++;
        await recordAudit(tx, {
          orgId: row.orgId,
          actor: SYSTEM_ACTOR,
          action: 'issuer.domain_verification_lapsed',
          target: { type: 'issuer', id: row.id },
          data: { domain: host, failedChecks: LAPSE_AFTER_FAILURES },
        });
      }
    });
  }
  return { checked: due.length, lapsed };
}
