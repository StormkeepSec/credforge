import { asc, eq, issuer, organization, signingKey } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { isUuid } from '../api/errors';
import { imageSet, loadFiles } from '../files/service';
import { verifiedHost } from '../issuers/domain';
import { issuerProfileDocument, issuerUrl } from '../issuers/service';
import type { Services } from '../services';
import type { PublicAssets } from './assets';
import { renderDocument } from './document';
import { negotiate } from './negotiate';
import { IssuerPage } from './pages/issuer';

/** JSON first: verifiers that send no Accept header (or `*\/*`) get the profile document. */
const ISSUER_OFFERS = ['application/json', 'application/ld+json', 'text/html'] as const;

/**
 * `/issuers/:id`, the issuer's permanent id (design plan §5.2, §6.1). Browsers get the issuer
 * page; `Accept: application/ld+json` or `application/json` gets the OB Profile, which is also
 * the controller document for the issuer's signing keys.
 */
export const publicIssuerRoutes: FastifyPluginAsync<{
  services: Pick<Services, 'db' | 'config'>;
  assets: PublicAssets;
}> = async (app, { services: { db, config }, assets }) => {
  app.get('/issuers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.callNotFound();
    const issuerId = id.toLowerCase();

    const [row] = await db
      .select({ issuer, orgStatus: organization.status })
      .from(issuer)
      .innerJoin(organization, eq(issuer.orgId, organization.id))
      .where(eq(issuer.id, issuerId));
    if (!row) return reply.callNotFound();
    const keys = await db
      .select()
      .from(signingKey)
      .where(eq(signingKey.issuerId, issuerId))
      .orderBy(asc(signingKey.createdAt));
    if (keys.length === 0) return reply.callNotFound();

    reply.header('vary', 'Accept');
    const type = negotiate(request.headers.accept, ISSUER_OFFERS);
    if (type === null) {
      return reply.code(406).send({
        statusCode: 406,
        error: 'Not Acceptable',
        message: `Available as ${ISSUER_OFFERS.join(', ')}`,
      });
    }

    const logo = row.issuer.imageFileId
      ? (await loadFiles(db, [row.issuer.imageFileId])).get(row.issuer.imageFileId)
      : undefined;
    const url = issuerUrl(config.publicBaseUrl, issuerId);
    reply.header('cache-control', 'public, max-age=300');
    if (type === 'text/html') {
      return reply.type('text/html; charset=utf-8').send(
        renderDocument(
          <IssuerPage
            url={url}
            stylesheet={assets.stylesheet}
            issuer={{
              name: row.issuer.name,
              description: row.issuer.description,
              website: row.issuer.url,
              email: row.issuer.email,
              logoUrl: logo ? imageSet(config.publicBaseUrl, logo).url512 : null,
              verifiedHost: verifiedHost(row.issuer),
            }}
            reportEmail={config.abuseEmail}
            orgStatus={row.orgStatus}
            keyCount={keys.filter((key) => key.status !== 'revoked').length}
          />,
        ),
      );
    }
    // A public document: any site may read it (no credentials are involved).
    reply.header('access-control-allow-origin', '*');
    reply.header('cross-origin-resource-policy', 'cross-origin');
    return reply
      .type(`${type}; charset=utf-8`)
      .send(JSON.stringify(issuerProfileDocument(config.publicBaseUrl, row.issuer, keys, logo)));
  });
};
