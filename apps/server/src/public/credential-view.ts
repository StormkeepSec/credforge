import { achievementTypeLabel } from '@credforge/contracts';
import { achievementUrl } from '../achievements/service';
import { type CredentialRow, credentialState, credentialUrl } from '../credentials/service';
import { type FileRow, imageSet } from '../files/service';
import { issuerUrl } from '../issuers/service';
import type { CredentialView } from './pages/credential';

export type Json = Record<string, unknown>;
export const asRecord = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
export const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A credential that still has its signed document (its recipient wasn't erased). */
export type LiveCredentialRow = CredentialRow & { document: Record<string, unknown> };

/**
 * What a credential's page shows, read from the signed document: the credential as it was
 * issued. My badges (design plan §8.8) reads it the same way.
 */
export function credentialView(
  publicBaseUrl: string,
  row: LiveCredentialRow,
  image: FileRow | undefined,
): CredentialView {
  const doc = row.document;
  const subject = asRecord(doc.credentialSubject);
  const a = asRecord(subject.achievement);
  const criteria = asRecord(a.criteria);
  const issuerDoc = asRecord(doc.issuer);
  const recipientName = asArray(subject.identifier)
    .map(asRecord)
    .find(
      (identifier) => identifier.identityType === 'name' && identifier.hashed === false,
    )?.identityHash;
  const id = row.id;
  const base = credentialUrl(publicBaseUrl, id);
  const images = image ? imageSet(publicBaseUrl, image) : null;
  const name = asString(a.name) ?? 'Badge';
  return {
    achievement: {
      url: asString(a.id) ?? achievementUrl(publicBaseUrl, row.achievementId),
      name,
      description: asString(a.description) ?? '',
      typeLabel: achievementTypeLabel(asString(a.achievementType) ?? 'Badge'),
      criteriaNarrative: asString(criteria.narrative) ?? null,
      criteriaUrl: asString(criteria.id) ?? null,
      tags: asArray(a.tag).filter((tag): tag is string => typeof tag === 'string'),
      alignments: asArray(a.alignment)
        .map(asRecord)
        .filter((alignment) => asString(alignment.targetName) && asString(alignment.targetUrl))
        .map((alignment) => ({
          targetName: alignment.targetName as string,
          targetUrl: alignment.targetUrl as string,
          ...(asString(alignment.targetFramework) && {
            targetFramework: alignment.targetFramework as string,
          }),
          ...(asString(alignment.targetCode) && { targetCode: alignment.targetCode as string }),
        })),
    },
    image: images ? { url: images.url512, alt: `${name} badge` } : null,
    ogImage: images?.ogUrl ? { url: images.ogUrl, width: 1200, height: 630 } : null,
    recipientName: typeof recipientName === 'string' ? recipientName : null,
    issuer: {
      name: asString(issuerDoc.name) ?? 'Issuer',
      pageUrl: asString(issuerDoc.id) ?? issuerUrl(publicBaseUrl, row.issuerId),
      website: asString(issuerDoc.url) ?? null,
      logoUrl: asString(asRecord(issuerDoc.image).id) ?? null,
    },
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    state: credentialState(row),
    revokedAt: row.revokedAt,
    revocation:
      row.status === 'revoked'
        ? { kind: row.revocationKind ?? 'revoked', publicReason: row.revocationPublicReason }
        : null,
    evidence: asArray(doc.evidence)
      .map(asRecord)
      .map((item) => ({
        ...(asString(item.id) && { url: item.id as string }),
        ...(asString(item.name) && { name: item.name as string }),
        ...(asString(item.narrative) && { narrative: item.narrative as string }),
      })),
    downloads: {
      png: `${base}/badge.png`,
      svg: image?.mimeType === 'image/svg+xml' ? `${base}/badge.svg` : null,
      json: `${base}/credential.json`,
      certificate: `${base}/certificate`,
    },
  };
}

/** LinkedIn's "add a license or certification" link (design plan §5.3). */
export function linkedInUrl(view: CredentialView, url: string, id: string): string {
  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: view.achievement.name,
    organizationName: view.issuer.name,
    issueYear: String(view.validFrom.getUTCFullYear()),
    issueMonth: String(view.validFrom.getUTCMonth() + 1),
    certUrl: url,
    certId: id,
  });
  if (view.validUntil) {
    params.set('expirationYear', String(view.validUntil.getUTCFullYear()));
    params.set('expirationMonth', String(view.validUntil.getUTCMonth() + 1));
  }
  return `https://www.linkedin.com/profile/add?${params}`;
}
