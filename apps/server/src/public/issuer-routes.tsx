import { asc, eq, issuer, organization, signingKey } from '@credforge/db';
import type { FastifyPluginAsync } from 'fastify';
import { isUuid } from '../api/errors';
import { imageSet } from '../files/service';
import { verifiedHost } from '../issuers/domain';
import { issuerProfileDocument, issuerUrl } from '../issuers/service';
import { type IssuerText, issuerText } from '../moderation/content';
import { reportFormToken } from '../moderation/reports';
import { publicImage, publicText } from '../moderation/service';
import type { Services } from '../services';
import type { PublicAssets } from './assets';
import { renderDocument } from './document';
import { negotiate } from './negotiate';
import { IssuerPage } from './pages/issuer';
import { reportPath } from './report-routes';

/** JSON first: verifiers that send no Accept header (or `*\/*`) get the profile document. */
const ISSUER_OFFERS = ['application/json', 'application/ld+json', 'text/html'] as const;

/**
 * `/issuers/:id`, the issuer's permanent id (design plan §5.2, §6.1). Browsers get the issuer
 * page; `Accept: application/ld+json` or `application/json` gets the OB Profile, which is also
 * the controller document for the issuer's signing keys.
 *
 * Both show only cleared text and logos (design plan §6.5): the version cleared last while an edit
 * waits for review, or a placeholder name. The keys are always served, so badges keep verifying.
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

    const shown = await publicText<IssuerText>(
      db,
      { type: 'issuer', id: issuerId, itemId: row.issuer.textItemId },
      issuerText(row.issuer),
    );
    const text: IssuerText = shown.text ?? {
      name: 'Issuer waiting for review',
      description: null,
      website: null,
      email: null,
    };
    const shownRow = {
      ...row.issuer,
      name: text.name,
      description: text.description,
      url: text.website,
      email: text.email,
    };
    const logo = await publicImage(db, {
      type: 'issuer',
      id: issuerId,
      fileId: row.issuer.imageFileId,
    });
    const url = issuerUrl(config.publicBaseUrl, issuerId);
    reply.header('cache-control', 'public, max-age=300');
    if (type === 'text/html') {
      return reply.type('text/html; charset=utf-8').send(
        renderDocument(
          <IssuerPage
            url={url}
            stylesheet={assets.stylesheet}
            issuer={{
              name: text.name,
              description: text.description,
              website: text.website,
              email: text.email,
              logoUrl: logo ? imageSet(config.publicBaseUrl, logo).url512 : null,
              verifiedHost: verifiedHost(shownRow),
            }}
            review={shown.current ? null : shown.text ? 'update' : 'new'}
            report={{
              action: reportPath('issuer', issuerId),
              token: reportFormToken(config.authSecret, { type: 'issuer', id: issuerId }),
              abuseEmail: config.abuseEmail,
              siteName: new URL(config.publicBaseUrl).host,
            }}
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
      .send(JSON.stringify(issuerProfileDocument(config.publicBaseUrl, shownRow, keys, logo)));
  });
};
