import { achievementTypeLabel } from '@credforge/contracts';
import { achievement, and, credential, eq, issuer, organization, statusList } from '@credforge/db';
import { bakePng, bakeSvg, type CredentialVerification } from '@credforge/ob3';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { achievementDocument, achievementUrl, snapshotOf } from '../achievements/service';
import { isUuid } from '../api/errors';
import type { RateLimiter } from '../api/rate-limit';
import { isSameOrigin } from '../api/v1';
import { recordAudit } from '../audit/audit';
import {
  type CredentialRow,
  credentialState,
  credentialUrl,
  hashClaimToken,
  isValidClaimToken,
} from '../credentials/service';
import { type FileRow, imageSet, loadFiles } from '../files/service';
import { verifiedHost } from '../issuers/domain';
import { issuerUrl } from '../issuers/service';
import type { Services } from '../services';
import { verifyLocalCredential } from '../verify/local';
import type { PublicAssets } from './assets';
import { renderDocument } from './document';
import { UPLOAD_CSP } from './image-routes';
import { negotiate } from './negotiate';
import { AchievementPage } from './pages/achievement';
import { CertificatePage } from './pages/certificate';
import { CredentialPage, type CredentialView } from './pages/credential';
import { ErasedCredentialPage } from './pages/erased';
import { TooManyRequestsPage } from './pages/too-many';

/** JSON first for verifiers that send no Accept header (or `*\/*`); browsers ask for HTML. */
const DOCUMENT_OFFERS = [
  'application/json',
  'application/ld+json',
  'application/vc+ld+json',
  'application/vc',
  'text/html',
] as const;

const STATUS_OFFERS = [
  'application/json',
  'application/ld+json',
  'application/vc+ld+json',
  'application/vc',
] as const;

const CLAIM_COOKIE = 'cf_claim';

function readCookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/** A file name from a title: `intro-to-network-defense`. */
function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'badge'
  );
}

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A credential that still has its signed document (its recipient wasn't erased). */
type LiveCredentialRow = CredentialRow & { document: Record<string, unknown> };

/** What the page shows, from the signed document: the credential as it was issued. */
function credentialView(
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

/**
 * Between a revocation and the worker re-signing the status list (a few seconds), the published
 * list still has the old bit. The page says what the issuer did rather than what the list says.
 */
export function withRevocation(
  row: CredentialRow,
  verification: CredentialVerification,
): CredentialVerification {
  if (row.status !== 'revoked' || verification.checks.status.outcome === 'failed') {
    return verification;
  }
  return {
    verified: false,
    checks: {
      ...verification.checks,
      status: {
        outcome: 'failed',
        message:
          'The issuer has revoked this credential. Its signed status list is being updated and will show it within a minute.',
      },
    },
  };
}

/**
 * The recipient acting through their claim link: their name, IP address and browser go into the
 * event's sealed recipient details (design plan §12.1), not its plain columns.
 */
function recipientActing(row: CredentialRow, request: FastifyRequest) {
  return row.auditKey
    ? {
        recipient: {
          key: row.auditKey,
          actorLabel: row.recipientName,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      }
    : {};
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

/**
 * The public side of credentials, achievements and status lists (design plan §5.2, §8.4, §9).
 *
 * - `/credentials/:id`: the page (HTML) or the signed credential (JSON), by `Accept`. A claim
 *   link (`?t=`) is exchanged for an HttpOnly cookie scoped to this credential and the browser is
 *   sent to the clean URL, so the token doesn't stay in the address bar or get copied into a
 *   shared link. That cookie unlocks Add to LinkedIn and hiding the page.
 * - Downloads, baked on request: `badge.png`, `badge.svg` (SVG artwork only), `credential.json`,
 *   and the printable `certificate`.
 * - `/achievements/:id`: the achievement (HTML or OB `Achievement` JSON). Drafts aren't public.
 * - `/status/:issuerId/:listNumber`: the signed BitstringStatusListCredential. Validators fetch
 *   it for every check (the 1EdTech validator about 10 times), so it is short-cached with an
 *   ETag, open to every origin, and must never be rate limited.
 */
export const publicCredentialRoutes: FastifyPluginAsync<{
  services: Pick<Services, 'db' | 'config' | 'storage'>;
  assets: PublicAssets;
  /** Claim links opened per client IP (tokens can't be guessed, but each costs a lookup). */
  claimLimiter: RateLimiter;
}> = async (app, { services: { db, config, storage }, assets, claimLimiter }) => {
  const base = config.publicBaseUrl;
  const secureCookies = base.startsWith('https://');

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4096 },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  async function loadCredential(id: string) {
    if (!isUuid(id)) return undefined;
    const [row] = await db.select().from(credential).where(eq(credential.id, id.toLowerCase()));
    return row;
  }

  function isOwner(request: FastifyRequest, row: CredentialRow): boolean {
    return isValidClaimToken(row, readCookie(request, CLAIM_COOKIE));
  }

  function sendHtml(reply: FastifyReply, html: string) {
    return reply.type('text/html; charset=utf-8').send(html);
  }

  async function imageOf(row: CredentialRow): Promise<FileRow | undefined> {
    return row.imageFileId
      ? (await loadFiles(db, [row.imageFileId])).get(row.imageFileId)
      : undefined;
  }

  /**
   * 410 Gone for a credential whose recipient's data was erased (design plan §12.1): a page
   * naming only the issuer and the achievement, or a problem document for verifiers.
   */
  async function sendGone(request: FastifyRequest, reply: FastifyReply, row: CredentialRow) {
    reply
      .code(410)
      .header('x-robots-tag', 'noindex')
      .header('cache-control', 'public, max-age=300')
      .header('vary', 'Accept');
    if (negotiate(request.headers.accept, DOCUMENT_OFFERS) !== 'text/html') {
      reply.header('access-control-allow-origin', '*');
      return reply.type('application/problem+json; charset=utf-8').send(
        JSON.stringify({
          type: 'about:blank',
          title: 'Credential erased',
          status: 410,
          detail:
            'The issuer revoked this credential and removed its details. Copies of it check as revoked.',
          code: 'credential_erased',
        }),
      );
    }
    const [names] = await db
      .select({ issuerName: issuer.name, achievementName: achievement.name })
      .from(issuer)
      .innerJoin(achievement, eq(achievement.id, row.achievementId))
      .where(eq(issuer.id, row.issuerId));
    return sendHtml(
      reply,
      renderDocument(
        <ErasedCredentialPage
          url={credentialUrl(base, row.id)}
          stylesheet={assets.stylesheet}
          issuer={{
            name: names?.issuerName ?? 'The issuer',
            pageUrl: issuerUrl(base, row.issuerId),
          }}
          achievementName={names?.achievementName ?? null}
        />,
      ),
    );
  }

  app.get('/credentials/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = await loadCredential(id);
    if (!found) return reply.callNotFound();
    if (!found.document) return sendGone(request, reply, found);
    const row: LiveCredentialRow = { ...found, document: found.document };
    const url = credentialUrl(base, row.id);
    const query = request.query as { t?: string; link?: string };

    // A claim link: trade the token for a cookie, then show the clean URL.
    if (typeof query.t === 'string') {
      const limit = claimLimiter.take(`claim:${request.ip}`);
      if (!limit.allowed) {
        reply.code(429).header('retry-after', String(limit.retryAfter));
        return sendHtml(
          reply,
          renderDocument(
            <TooManyRequestsPage
              url={url}
              stylesheet={assets.stylesheet}
              retryAfter={limit.retryAfter}
            />,
          ),
        );
      }
      if (!isValidClaimToken(row, query.t)) {
        return reply.redirect(`${url}?link=expired`, 303);
      }
      const maxAge = Math.max(
        0,
        Math.floor(((row.claimTokenExpiresAt?.getTime() ?? 0) - Date.now()) / 1000),
      );
      reply.header(
        'set-cookie',
        `${CLAIM_COOKIE}=${encodeURIComponent(query.t)}; Path=/credentials/${row.id}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`,
      );
      if (!row.acceptedAt) {
        await db.transaction(async (tx) => {
          const [first] = await tx
            .update(credential)
            .set({ acceptedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(credential.id, row.id),
                eq(credential.claimTokenHash, hashClaimToken(query.t as string)),
              ),
            )
            .returning({ id: credential.id });
          if (first) {
            await recordAudit(tx, {
              orgId: row.orgId,
              actor: { type: 'recipient' },
              action: 'credential.claimed',
              target: { type: 'credential', id: row.id },
              ...recipientActing(row, request),
            });
          }
        });
      }
      reply.header('cache-control', 'no-store');
      return reply.redirect(url, 303);
    }

    const owner = isOwner(request, row);
    reply.header('vary', 'Accept, Cookie');
    reply.header('x-robots-tag', 'noindex');
    const type = negotiate(request.headers.accept, DOCUMENT_OFFERS);
    if (type === null) {
      return reply.code(406).send({
        statusCode: 406,
        error: 'Not Acceptable',
        message: `Available as ${DOCUMENT_OFFERS.join(', ')}`,
      });
    }
    // A hidden page answers like a missing one, except to its recipient.
    if (row.visibility === 'hidden' && !owner) return reply.callNotFound();
    reply.header(
      'cache-control',
      row.visibility === 'hidden' || owner ? 'private, no-store' : 'public, max-age=60',
    );

    if (type !== 'text/html') {
      reply.header('access-control-allow-origin', '*');
      reply.header('cross-origin-resource-policy', 'cross-origin');
      return reply.type(`${type}; charset=utf-8`).send(JSON.stringify(row.document));
    }

    const view = credentialView(base, row, await imageOf(row));
    // Cached per list version: a re-signed list (after a revocation) is checked afresh.
    const [list] = row.statusListId
      ? await db
          .select({ version: statusList.version })
          .from(statusList)
          .where(eq(statusList.id, row.statusListId))
      : [];
    const [issuerRow] = await db
      .select({
        url: issuer.url,
        domain: issuer.domain,
        domainVerifiedAt: issuer.domainVerifiedAt,
        orgStatus: organization.status,
      })
      .from(issuer)
      .innerJoin(organization, eq(issuer.orgId, organization.id))
      .where(eq(issuer.id, row.issuerId));
    const verification = withRevocation(
      row,
      await verifyLocalCredential(db, base, `${row.id}:${list?.version ?? 0}`, row.document),
    );
    return sendHtml(
      reply,
      renderDocument(
        <CredentialPage
          url={url}
          stylesheet={assets.stylesheet}
          credential={view}
          verification={verification}
          owner={
            owner
              ? {
                  visibility: row.visibility,
                  linkedInUrl: linkedInUrl(view, url, row.id),
                  visibilityAction: `/credentials/${row.id}/visibility`,
                }
              : null
          }
          notice={query.link === 'expired' && !owner ? 'link_expired' : null}
          issuerVerifiedHost={issuerRow ? verifiedHost(issuerRow) : null}
          reportEmail={config.abuseEmail}
          orgStatus={issuerRow?.orgStatus ?? 'active'}
        />,
      ),
    );
  });

  /** The recipient hides or shows their page (a plain form post from the page itself). */
  app.post('/credentials/:id/visibility', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await loadCredential(id);
    if (!row) return reply.callNotFound();
    if (!row.document) return sendGone(request, reply, row);
    const url = credentialUrl(base, row.id);
    if (!isSameOrigin(request, base) || !isOwner(request, row)) {
      return reply
        .code(403)
        .type('text/plain')
        .send('Open your badge from the link in your email first.');
    }
    const wanted = (request.body as { visibility?: string } | undefined)?.visibility;
    if (wanted !== 'hidden' && wanted !== 'public') return reply.redirect(url, 303);
    if (wanted !== row.visibility) {
      await db.transaction(async (tx) => {
        await tx
          .update(credential)
          .set({ visibility: wanted, updatedAt: new Date() })
          .where(eq(credential.id, row.id));
        await recordAudit(tx, {
          orgId: row.orgId,
          actor: { type: 'recipient' },
          action: wanted === 'hidden' ? 'credential.hidden' : 'credential.shown',
          target: { type: 'credential', id: row.id },
          ...recipientActing(row, request),
        });
      });
    }
    return reply.redirect(url, 303);
  });

  /**
   * Loads a credential for a download; null (after a 404, or a 410 once its recipient's data was
   * erased) when it doesn't exist or is hidden.
   */
  async function downloadable(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<LiveCredentialRow | null> {
    const { id } = request.params as { id: string };
    const found = await loadCredential(id);
    if (!found) {
      await reply.callNotFound();
      return null;
    }
    if (!found.document) {
      await sendGone(request, reply, found);
      return null;
    }
    const row: LiveCredentialRow = { ...found, document: found.document };
    const owner = isOwner(request, row);
    if (row.visibility === 'hidden' && !owner) {
      await reply.callNotFound();
      return null;
    }
    reply.header('vary', 'Cookie');
    reply.header('x-robots-tag', 'noindex');
    reply.header(
      'cache-control',
      row.visibility === 'hidden' || owner ? 'private, no-store' : 'public, max-age=300',
    );
    return row;
  }

  const fileName = (row: LiveCredentialRow, extension: string) =>
    `${slug(asString(asRecord(asRecord(row.document.credentialSubject).achievement).name) ?? 'badge')}.${extension}`;

  app.get('/credentials/:id/credential.json', async (request, reply) => {
    const row = await downloadable(request, reply);
    if (!row) return reply;
    reply.header('access-control-allow-origin', '*');
    reply.header('content-disposition', `attachment; filename="${fileName(row, 'json')}"`);
    return reply
      .type('application/json; charset=utf-8')
      .send(`${JSON.stringify(row.document, null, 2)}\n`);
  });

  /** The badge image with the signed credential baked in (an `iTXt` chunk; no re-encoding). */
  app.get('/credentials/:id/badge.png', async (request, reply) => {
    const row = await downloadable(request, reply);
    if (!row) return reply;
    const image = await imageOf(row);
    const key = image?.mimeType === 'image/svg+xml' ? image.variants['512']?.key : image?.key;
    const bytes = key ? await storage.get(key) : null;
    if (!bytes) return reply.callNotFound();
    reply.header('content-disposition', `attachment; filename="${fileName(row, 'png')}"`);
    reply.header('content-security-policy', UPLOAD_CSP);
    return reply
      .type('image/png')
      .send(Buffer.from(bakePng(bytes, row.document, { replace: true })));
  });

  app.get('/credentials/:id/badge.svg', async (request, reply) => {
    const row = await downloadable(request, reply);
    if (!row) return reply;
    const image = await imageOf(row);
    if (image?.mimeType !== 'image/svg+xml') return reply.callNotFound();
    const bytes = await storage.get(image.key);
    if (!bytes) return reply.callNotFound();
    reply.header('content-disposition', `attachment; filename="${fileName(row, 'svg')}"`);
    reply.header('content-security-policy', UPLOAD_CSP);
    return reply
      .type('image/svg+xml')
      .send(bakeSvg(bytes.toString('utf8'), row.document, { replace: true }));
  });

  app.get('/credentials/:id/certificate', async (request, reply) => {
    const row = await downloadable(request, reply);
    if (!row) return reply;
    const url = credentialUrl(base, row.id);
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    return sendHtml(
      reply,
      renderDocument(
        <CertificatePage
          url={`${url}/certificate`}
          credentialUrl={url}
          stylesheet={assets.stylesheet}
          credential={credentialView(base, row, await imageOf(row))}
          qrSvg={qrSvg}
        />,
      ),
    );
  });

  app.get('/achievements/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.callNotFound();
    const [row] = await db
      .select({ achievement, issuer, orgStatus: organization.status })
      .from(achievement)
      .innerJoin(issuer, eq(achievement.issuerId, issuer.id))
      .innerJoin(organization, eq(achievement.orgId, organization.id))
      .where(eq(achievement.id, id.toLowerCase()));
    if (!row || row.achievement.status === 'draft') return reply.callNotFound();

    reply.header('vary', 'Accept');
    const type = negotiate(request.headers.accept, DOCUMENT_OFFERS);
    if (type === null) {
      return reply.code(406).send({
        statusCode: 406,
        error: 'Not Acceptable',
        message: `Available as ${DOCUMENT_OFFERS.join(', ')}`,
      });
    }
    reply.header('cache-control', 'public, max-age=300');
    const image = row.achievement.imageFileId
      ? (await loadFiles(db, [row.achievement.imageFileId])).get(row.achievement.imageFileId)
      : undefined;
    const url = achievementUrl(base, row.achievement.id);
    const pageUrl = issuerUrl(base, row.issuer.id);

    if (type !== 'text/html') {
      reply.header('access-control-allow-origin', '*');
      reply.header('cross-origin-resource-policy', 'cross-origin');
      return reply.type(`${type}; charset=utf-8`).send(
        JSON.stringify(
          achievementDocument(base, row.achievement, image, {
            id: pageUrl,
            name: row.issuer.name,
          }),
        ),
      );
    }
    const snapshot = snapshotOf(row.achievement);
    const images = image ? imageSet(base, image) : null;
    return sendHtml(
      reply,
      renderDocument(
        <AchievementPage
          url={url}
          stylesheet={assets.stylesheet}
          achievement={{
            name: snapshot.name,
            description: snapshot.description,
            typeLabel: achievementTypeLabel(snapshot.achievementType),
            criteriaNarrative: snapshot.criteriaNarrative,
            criteriaUrl: snapshot.criteriaUrl,
            tags: snapshot.tags,
            alignments: snapshot.alignments.map((alignment) => ({
              targetName: alignment.targetName,
              targetUrl: alignment.targetUrl,
              ...(alignment.targetFramework && { targetFramework: alignment.targetFramework }),
              ...(alignment.targetCode && { targetCode: alignment.targetCode }),
            })),
            archived: row.achievement.status === 'archived',
          }}
          image={images ? { url: images.url512, alt: `${snapshot.name} badge` } : null}
          ogImage={images?.ogUrl ? { url: images.ogUrl, width: 1200, height: 630 } : null}
          issuer={{ name: row.issuer.name, pageUrl }}
          reportEmail={config.abuseEmail}
          orgStatus={row.orgStatus}
        />,
      ),
    );
  });

  app.get('/status/:issuerId/:listNumber', async (request, reply) => {
    const { issuerId, listNumber } = request.params as { issuerId: string; listNumber: string };
    if (!isUuid(issuerId) || !/^[1-9][0-9]{0,8}$/.test(listNumber)) return reply.callNotFound();
    const [row] = await db
      .select({ id: statusList.id, version: statusList.version, document: statusList.document })
      .from(statusList)
      .where(
        and(
          eq(statusList.issuerId, issuerId.toLowerCase()),
          eq(statusList.listNumber, Number(listNumber)),
        ),
      );
    if (!row) return reply.callNotFound();

    const etag = `"${row.id.slice(0, 8)}-${row.version}"`;
    reply
      .header('cache-control', 'public, max-age=60')
      .header('etag', etag)
      .header('vary', 'Accept')
      .header('access-control-allow-origin', '*')
      .header('cross-origin-resource-policy', 'cross-origin');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    const type = negotiate(request.headers.accept, STATUS_OFFERS) ?? 'application/json';
    return reply.type(`${type}; charset=utf-8`).send(JSON.stringify(row.document));
  });
};
